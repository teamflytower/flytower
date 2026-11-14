//! What each subscription sends (protocol 2). Each stream runs on a thread of its own and
//! returns once it has nothing more to say or its sink has stopped.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::Context;
use crate::envelope::{AgentError, End, EndReason, ErrorCode};
use crate::events::{Change, SETTLE};
use crate::stream::Stream;

/// `testing.ticks`: counts from 1 to `count`, waiting `interval` between events. Test builds
/// use it to check subscriptions end to end.
#[must_use]
pub fn ticks(count: u64, interval: Duration) -> Stream {
    Box::new(move |sink| {
        for n in 1..=count {
            if !sink.send(json!({ "n": n })) {
                return End::new(EndReason::Cancelled);
            }
            if !interval.is_zero() && n < count && sink.wait(interval) {
                return End::new(EndReason::Cancelled);
            }
        }
        End::new(EndReason::Finished)
    })
}

/// What a `service.events` stream is waiting for.
#[derive(Default)]
struct Wake {
    pending: BTreeSet<String>,
    stopped: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A server's state as `service.status` gives it, or `unknown` if systemd doesn't know it.
fn status_of(server: &str, ctx: &Context) -> Value {
    super::service::status(server, ctx)
        .unwrap_or_else(|_| json!({ "active": "unknown", "since": null }))
}

/// `service.events`: answers with every server's state, then sends `{server, status}` each
/// time one changes. systemd says when a unit changed; a burst (exited, failed, restart
/// scheduled) is collected for [`SETTLE`] and each server asked about once, and only real
/// changes are sent. If systemd stops being followed, every server is asked about again.
///
/// # Errors
/// `failed` if this agent can't follow systemd.
pub fn service_events(
    servers: Vec<String>,
    ctx: &Arc<Context>,
) -> Result<(Value, Stream), AgentError> {
    let Some(events) = ctx.events.clone() else {
        return Err(AgentError::new(
            ErrorCode::Failed,
            "this agent can't follow systemd",
        ));
    };
    let mut last: BTreeMap<String, Value> = servers
        .iter()
        .map(|s| (s.clone(), status_of(s, ctx)))
        .collect();
    let result = json!({ "states": last });
    let ctx = Arc::clone(ctx);
    let stream: Stream = Box::new(move |sink| {
        let wake = Arc::new((Mutex::new(Wake::default()), Condvar::new()));
        let listener = {
            let wake = Arc::clone(&wake);
            let wanted: BTreeSet<String> = servers.iter().cloned().collect();
            events.listen(Arc::new(move |change| {
                let mut w = lock(&wake.0);
                match change {
                    Change::Server(s) if wanted.contains(s) => {
                        w.pending.insert(s.to_string());
                    }
                    Change::Server(_) => return,
                    Change::Lost => w.pending.extend(wanted.iter().cloned()),
                }
                drop(w);
                wake.1.notify_all();
            }))
        };
        {
            let wake = Arc::clone(&wake);
            sink.on_stop(move || {
                lock(&wake.0).stopped = true;
                wake.1.notify_all();
            });
        }
        'run: loop {
            let mut w = lock(&wake.0);
            while !w.stopped && w.pending.is_empty() {
                w = wake
                    .1
                    .wait(w)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            let settled = Instant::now() + SETTLE;
            while !w.stopped {
                let left = settled.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                w = wake
                    .1
                    .wait_timeout(w, left)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
            }
            if w.stopped {
                break;
            }
            let changed = std::mem::take(&mut w.pending);
            drop(w);
            for server in changed {
                let status = status_of(&server, &ctx);
                if last.get(&server) == Some(&status) {
                    continue;
                }
                if !sink.send(json!({ "server": server, "status": status })) {
                    break 'run;
                }
                last.insert(server, status);
            }
        }
        events.unlisten(listener);
        End::new(EndReason::Cancelled)
    });
    Ok((result, stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{Follow, UnitEvents};
    use crate::handlers::testing::{Fake, FakeSystemd, TempRoot};
    use crate::stream::Outbox;
    use std::sync::mpsc;
    use std::thread;

    /// systemd's signals, which the test feeds unit names into.
    struct Changes {
        lines: Mutex<Option<mpsc::Receiver<String>>>,
    }

    impl Follow for Changes {
        fn run(&self, started: &mut dyn FnMut(), on_unit: &mut dyn FnMut(&str)) {
            let Some(lines) = lock(&self.lines).take() else {
                return;
            };
            started();
            while let Ok(unit) = lines.recv() {
                on_unit(&unit);
            }
        }
        fn stop(&self) {}
    }

    #[test]
    fn sends_each_real_change_once() {
        let root = TempRoot::new("service-events");
        let systemd = FakeSystemd::with(&[
            ("flytower-mc@lobby.service", &[("ActiveState", "active")]),
            (
                "flytower-mc@survival.service",
                &[("ActiveState", "inactive")],
            ),
        ]);
        let (feed, lines) = mpsc::channel();
        let events = UnitEvents::new(
            Arc::new(Changes {
                lines: Mutex::new(Some(lines)),
            }),
            Duration::from_mins(1),
        );
        events.start();
        while !events.following() {
            thread::yield_now();
        }
        let mut ctx = Fake::default().context(&root.paths);
        ctx.systemd = Arc::clone(&systemd) as Arc<dyn crate::systemd::Systemd>;
        ctx.events = Some(Arc::clone(&events));
        let ctx = Arc::new(ctx);

        let (result, stream) =
            service_events(vec!["survival".into(), "ghost".into()], &ctx).unwrap();
        assert_eq!(result["states"]["survival"]["active"], "inactive");
        assert_eq!(result["states"]["ghost"]["active"], "unknown");

        let out = Outbox::new();
        let sink = out.open("e", "service.events");
        let handle = thread::spawn(move || stream(&sink));
        thread::sleep(Duration::from_millis(50));

        // A server not asked about, and a change that isn't one, send nothing.
        feed.send("flytower-mc@lobby.service".to_string()).unwrap();
        feed.send("flytower-mc@survival.service".to_string())
            .unwrap();
        // A burst for one that did change: one event.
        systemd.set("flytower-mc@survival.service", &[("ActiveState", "active")]);
        for _ in 0..3 {
            feed.send("flytower-mc@survival.service".to_string())
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got: Vec<Value> = Vec::new();
        while got.is_empty() {
            assert!(Instant::now() < deadline, "no event");
            got.extend(
                out.ready_now()
                    .lines()
                    .map(|l| serde_json::from_str::<Value>(l).unwrap()),
            );
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(SETTLE * 2);
        got.extend(
            out.ready_now()
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap()),
        );
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0]["event"]["server"], "survival");
        assert_eq!(got[0]["event"]["status"]["active"], "active");

        out.cancel("e");
        assert_eq!(handle.join().unwrap().reason, EndReason::Cancelled);
        events.stop();
    }

    #[test]
    fn says_so_when_not_following() {
        let root = TempRoot::new("service-events-none");
        let ctx = Arc::new(Fake::default().context(&root.paths));
        let err = service_events(vec![], &ctx).err().unwrap();
        assert_eq!(err.code, ErrorCode::Failed);
    }
}
