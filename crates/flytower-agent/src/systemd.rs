//! systemd over D-Bus, the way systemctl itself talks to it, without running systemctl.
//!
//! [`Systemd`] is what the handlers use: a unit's properties, clearing a failed state, and
//! start, stop and restart jobs. [`Bus`] does it on the system bus; tests use a fake.
//! [`UnitChanges`] follows systemd's `PropertiesChanged` signals for `service.wait` and
//! `service.events`, in place of reading the journal.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};

use futures_lite::StreamExt;
use zbus::message::Type;
use zbus::{Connection, MatchRule, MessageStream, OwnedObjectPath, OwnedVariant, Proxy, Variant};

use crate::events::Follow;
use crate::time::{self, Zone};

const SYSTEMD: &str = "org.freedesktop.systemd1";
const MANAGER_PATH: &str = "/org/freedesktop/systemd1";
const MANAGER: &str = "org.freedesktop.systemd1.Manager";
const UNIT: &str = "org.freedesktop.systemd1.Unit";
const SERVICE: &str = "org.freedesktop.systemd1.Service";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
/// Every unit's object lives under here, named by [`unit_of_path`]'s escaping.
const UNITS: &str = "/org/freedesktop/systemd1/unit";

/// What the handlers ask of systemd.
pub trait Systemd: Send + Sync {
    /// The named properties of `unit`, written as `systemctl show` writes them. A unit systemd
    /// can't find still answers, with a `LoadState` of `not-found`.
    ///
    /// # Errors
    /// systemd's error, or why the bus couldn't be reached.
    fn show(&self, unit: &str, properties: &[&str]) -> Result<BTreeMap<String, String>, String>;

    /// `systemctl reset-failed`.
    ///
    /// # Errors
    /// systemd's error.
    fn reset_failed(&self, unit: &str) -> Result<(), String>;

    /// `systemctl start`, `stop` or `restart`: queues the job and waits for it to finish.
    ///
    /// # Errors
    /// systemd's error, or the job's result if it isn't `done`.
    fn job(&self, verb: &str, unit: &str) -> Result<(), String>;
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicked holder can't leave a connection in a state that matters.
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The interface a property belongs to: the few the agent reads.
fn interface_of(property: &str) -> &'static str {
    match property {
        "Id" | "LoadState" | "ActiveState" | "SubState" | "ActiveEnterTimestamp" => UNIT,
        _ => SERVICE,
    }
}

/// A property as `systemctl show` writes it: numbers in decimal, timestamps in local time.
fn format(property: &str, value: &Variant<'_>, zone: &Zone) -> String {
    match value {
        Variant::Str(s) => s.to_string(),
        Variant::U64(t) if property.ends_with("Timestamp") => time::systemd(*t, zone),
        Variant::U64(n) => n.to_string(),
        Variant::U32(n) => n.to_string(),
        Variant::I32(n) => n.to_string(),
        Variant::I64(n) => n.to_string(),
        Variant::Bool(b) => if *b { "yes" } else { "no" }.into(),
        _ => String::new(),
    }
}

/// What systemd said when it refused a call, as systemctl would show it; `None` when the
/// error is the bus's own, not systemd's answer.
fn refusal(e: &zbus::Error) -> Option<String> {
    use zbus::DBusError;
    match e {
        zbus::Error::MethodError(name, detail, _) => Some(
            detail
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| name.to_string()),
        ),
        // Errors with standard names come back as these.
        zbus::Error::FDO(e) => Some(
            e.description()
                .filter(|d| !d.is_empty())
                .map_or_else(|| e.to_string(), str::to_string),
        ),
        _ => None,
    }
}

fn message(e: &zbus::Error) -> String {
    refusal(e).unwrap_or_else(|| format!("talking to systemd: {e}"))
}

/// The system bus, connected on first use and again after it drops.
pub struct Bus {
    conn: Mutex<Option<Connection>>,
    zone: Zone,
}

impl Bus {
    /// A bus that writes timestamps in the box's time zone.
    #[must_use]
    pub fn new() -> Self {
        Self::with_zone(Zone::local())
    }

    #[must_use]
    pub const fn with_zone(zone: Zone) -> Self {
        Self {
            conn: Mutex::new(None),
            zone,
        }
    }

    async fn connection(&self) -> zbus::Result<Connection> {
        let current = lock(&self.conn).clone();
        if let Some(conn) = current {
            return Ok(conn);
        }
        let conn = Connection::system().await?;
        // systemd only sends JobRemoved to clients that ask for its signals.
        subscribe(&conn).await?;
        *lock(&self.conn) = Some(conn.clone());
        Ok(conn)
    }

    /// Runs `f` on the bus. If the bus itself failed (it was restarted, say), it connects
    /// again and tries once more; systemd refusing something is the answer.
    fn with<T>(&self, f: &impl AsyncFn(&Connection) -> zbus::Result<T>) -> Result<T, String> {
        zbus::block_on(async {
            let mut retried = false;
            loop {
                let conn = self.connection().await.map_err(|e| message(&e))?;
                match f(&conn).await {
                    Err(e) if refusal(&e).is_none() => {
                        *lock(&self.conn) = None;
                        if retried {
                            return Err(message(&e));
                        }
                        retried = true;
                    }
                    r => return r.map_err(|e| message(&e)),
                }
            }
        })
    }
}

impl Default for Bus {
    fn default() -> Self {
        Self::new()
    }
}

async fn manager(conn: &Connection) -> zbus::Result<Proxy<'static>> {
    Proxy::new(conn, SYSTEMD, MANAGER_PATH, MANAGER).await
}

async fn subscribe(conn: &Connection) -> zbus::Result<()> {
    manager(conn)
        .await?
        .call::<_, _, ()>("Subscribe", &())
        .await
}

impl Systemd for Bus {
    fn show(&self, unit: &str, properties: &[&str]) -> Result<BTreeMap<String, String>, String> {
        self.with(&async |conn| {
            // LoadUnit, unlike GetUnit, answers for a unit that isn't loaded, as systemctl does.
            let path: OwnedObjectPath = manager(conn).await?.call("LoadUnit", &(unit,)).await?;
            let props = Proxy::new(conn, SYSTEMD, path, PROPERTIES).await?;
            let mut out = BTreeMap::new();
            for p in properties {
                let value: OwnedVariant = props.call("Get", &(interface_of(p), *p)).await?;
                out.insert((*p).to_string(), format(p, &value, &self.zone));
            }
            Ok(out)
        })
    }

    fn reset_failed(&self, unit: &str) -> Result<(), String> {
        self.with(&async |conn| {
            manager(conn)
                .await?
                .call::<_, _, ()>("ResetFailedUnit", &(unit,))
                .await
        })
    }

    fn job(&self, verb: &str, unit: &str) -> Result<(), String> {
        let method = match verb {
            "start" => "StartUnit",
            "stop" => "StopUnit",
            "restart" => "RestartUnit",
            _ => return Err(format!("no such job: {verb}")),
        };
        let result = self.with(&async |conn| {
            let manager = manager(conn).await?;
            // Listen before queueing, or a quick job could finish unheard.
            let mut removed = manager.receive_signal("JobRemoved").await?;
            let job: OwnedObjectPath = manager.call(method, &(unit, "replace")).await?;
            while let Some(signal) = removed.next().await {
                let (_, path, _, result): (u32, OwnedObjectPath, String, String) =
                    signal.body().deserialize()?;
                if path == job {
                    return Ok(result);
                }
            }
            Err(zbus::Error::Failure("systemd went away".into()))
        })?;
        if result == "done" {
            Ok(())
        } else {
            Err(format!(
                "Job for {unit} failed ({result}). See \"systemctl status {unit}\" and \"journalctl -xeu {unit}\" for details."
            ))
        }
    }
}

/// The unit an object path under [`UNITS`] stands for. systemd escapes every byte that isn't
/// a letter or digit as `_xx`, in hex: `flytower_2dmc_40survival_2eservice`.
#[must_use]
pub fn unit_of_path(path: &str) -> Option<String> {
    let name = path.strip_prefix(UNITS)?.strip_prefix('/')?;
    let b = name.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'_' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else if b[i].is_ascii_alphanumeric() {
            out.push(b[i]);
            i += 1;
        } else {
            return None;
        }
    }
    String::from_utf8(out).ok()
}

/// A flag a future can wait on, set from any thread.
#[derive(Default)]
struct Flag {
    state: Mutex<(bool, Option<Waker>)>,
}

impl Flag {
    fn set(&self) {
        let waker = {
            let mut s = lock(&self.state);
            s.0 = true;
            s.1.take()
        };
        if let Some(w) = waker {
            w.wake();
        }
    }

    const fn wait(&self) -> FlagWait<'_> {
        FlagWait(self)
    }
}

struct FlagWait<'a>(&'a Flag);

impl Future for FlagWait<'_> {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut s = lock(&self.0.state);
        if s.0 {
            Poll::Ready(())
        } else {
            s.1 = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

/// Follows systemd's `PropertiesChanged` signals for units, on a connection of its own, and
/// hands over the name of each unit that changed. Once stopped, it stays stopped.
#[derive(Default)]
pub struct UnitChanges {
    stop: Arc<Flag>,
}

impl UnitChanges {
    #[expect(
        clippy::future_not_send,
        reason = "it runs under block_on on the following thread and never moves"
    )]
    async fn follow(
        &self,
        started: &mut dyn FnMut(),
        on_unit: &mut dyn FnMut(&str),
    ) -> zbus::Result<()> {
        let conn = Connection::system().await?;
        subscribe(&conn).await?;
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(SYSTEMD)
            .interface(PROPERTIES)
            .member("PropertiesChanged")
            .path_namespace(UNITS)
            .build()?;
        let mut changes =
            MessageStream::for_match_rule(rule, &conn, std::num::NonZeroUsize::new(4096)).await?;
        started();
        loop {
            let next = async { Some(changes.next().await) };
            let stop = async {
                self.stop.wait().await;
                None
            };
            match futures_lite::future::or(next, stop).await {
                Some(Some(Ok(signal))) => {
                    if let Some(unit) = signal
                        .header()
                        .path()
                        .and_then(|p| unit_of_path(p.as_str()))
                    {
                        on_unit(&unit);
                    }
                }
                // A message that wouldn't decode is skipped; the end of the stream ends this.
                Some(Some(Err(_))) => {}
                Some(None) | None => return Ok(()),
            }
        }
    }
}

impl Follow for UnitChanges {
    fn run(&self, started: &mut dyn FnMut(), on_unit: &mut dyn FnMut(&str)) {
        let _ = zbus::block_on(self.follow(started, on_unit));
    }

    fn stop(&self) {
        self.stop.set();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_unit_names_from_paths() {
        assert_eq!(
            unit_of_path("/org/freedesktop/systemd1/unit/flytower_2dmc_40survival_2eservice")
                .as_deref(),
            Some("flytower-mc@survival.service")
        );
        assert_eq!(
            unit_of_path("/org/freedesktop/systemd1/unit/ssh_2eservice").as_deref(),
            Some("ssh.service")
        );
        assert_eq!(unit_of_path("/org/freedesktop/systemd1/unit/bad_2"), None);
        assert_eq!(unit_of_path("/org/freedesktop/systemd1/unit/a_zz"), None);
        assert_eq!(unit_of_path("/org/freedesktop/systemd1/job/12"), None);
    }

    #[test]
    fn writes_properties_as_systemctl_does() {
        let utc = Zone::utc();
        assert_eq!(
            format("ActiveState", &Variant::from("active"), &utc),
            "active"
        );
        assert_eq!(format("NRestarts", &Variant::U32(2), &utc), "2");
        assert_eq!(format("ExecMainStatus", &Variant::I32(-1), &utc), "-1");
        assert_eq!(
            format("MemoryCurrent", &Variant::U64(u64::MAX), &utc),
            "18446744073709551615"
        );
        assert_eq!(format("ActiveEnterTimestamp", &Variant::U64(0), &utc), "");
        assert_eq!(
            format(
                "ActiveEnterTimestamp",
                &Variant::U64(1_794_322_800_000_000),
                &utc
            ),
            "Tue 2026-11-10 15:00:00 UTC"
        );
        assert_eq!(interface_of("LoadState"), UNIT);
        assert_eq!(interface_of("CPUUsageNSec"), SERVICE);
    }

    #[test]
    fn a_flag_wakes_its_waiter() {
        let flag = Arc::new(Flag::default());
        let setter = Arc::clone(&flag);
        let t = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            setter.set();
        });
        zbus::block_on(flag.wait());
        t.join().unwrap();
        // Set stays set: a stop before a run starts still stops it.
        zbus::block_on(flag.wait());
    }
}
