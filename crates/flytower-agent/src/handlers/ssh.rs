//! SSH in the firewall: closed for good once the
//! panel works, opened briefly in an emergency. The timer that closes it lives here, in the
//! agent, and survives restarts through a small state file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};

use super::Context;
use super::files::{io_error, remove};
use crate::envelope::{AgentError, ErrorCode};
use crate::exec::Exec;
use crate::safe_fs::{own_dir, read_small, write_atomic};
use crate::time::{iso, parse_iso};

pub const SSH_COMMENT: &str = "flytower emergency ssh";

fn state_file(state_dir: &str) -> PathBuf {
    Path::new(state_dir).join("ssh.json")
}

fn run(exec: &dyn Exec, file: &str, args: &[&str]) -> Result<String, AgentError> {
    let r = exec.run(file, args);
    if r.code != 0 {
        let stderr = r.stderr.trim();
        let why = if stderr.is_empty() { "failed" } else { stderr };
        let first = args.first().copied().unwrap_or("");
        return Err(AgentError::new(
            ErrorCode::Failed,
            format!("{file} {first}: {why}"),
        ));
    }
    Ok(r.stdout)
}

/// The ports sshd listens on, from its effective config; 22 if that can't be read.
pub fn ssh_ports(exec: &dyn Exec) -> Vec<u16> {
    let mut ports = Vec::new();
    for line in exec.run("sshd", &["-T"]).stdout.lines() {
        let port = line.strip_prefix("port ").and_then(|p| {
            p.bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| p.parse::<u16>().ok())
                .flatten()
        });
        if let Some(port) = port.filter(|p| !ports.contains(p)) {
            ports.push(port);
        }
    }
    if ports.is_empty() { vec![22] } else { ports }
}

/// Numbers of the ufw rules that let SSH in, highest first so deleting doesn't renumber.
#[must_use]
pub fn ssh_rule_numbers(status_numbered: &str, ports: &[u16]) -> Vec<u32> {
    let mut targets = vec!["OpenSSH".to_string()];
    for p in ports {
        targets.push(format!("{p}/tcp"));
        targets.push(p.to_string());
    }
    let mut numbers: Vec<u32> = status_numbered
        .lines()
        .filter_map(|line| {
            let (number, rest) = line.strip_prefix('[')?.split_once(']')?;
            let number = number.trim().parse().ok()?;
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            let rest = rest.trim_start();
            let end = rest.find(char::is_whitespace)?;
            let (to, rest) = rest.split_at(end);
            let rest = rest.strip_prefix(" (v6)").unwrap_or(rest);
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            let action = rest.split_whitespace().next()?;
            let action_ok = ["ALLOW", "LIMIT"].iter().any(|a| {
                action.strip_prefix(a).is_some_and(|after| {
                    !after.starts_with(|c: char| c.is_alphanumeric() || c == '_')
                })
            });
            (action_ok && targets.iter().any(|t| t == to)).then_some(number)
        })
        .collect();
    numbers.sort_unstable_by(|a, b| b.cmp(a));
    numbers
}

/// Armed timers, by state folder: a generation number that a newer arm or a close bumps.
static TIMERS: LazyLock<(Mutex<HashMap<String, u64>>, Condvar)> =
    LazyLock::new(|| (Mutex::new(HashMap::new()), Condvar::new()));
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn disarm(state_dir: &str) {
    let (timers, changed) = &*TIMERS;
    timers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(state_dir);
    changed.notify_all();
}

/// True while an emergency opening is waiting to close. For tests.
#[must_use]
pub fn armed(state_dir: &str) -> bool {
    TIMERS
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains_key(state_dir)
}

fn close_now(exec: &dyn Exec, state_dir: &str) -> Result<(), AgentError> {
    let ports = ssh_ports(exec);
    let out = exec.run("ufw", &["status", "numbered"]).stdout;
    for n in ssh_rule_numbers(&out, &ports) {
        run(exec, "ufw", &["--force", "delete", &n.to_string()])?;
    }
    remove(&state_file(state_dir))?;
    disarm(state_dir);
    Ok(())
}

/// Closes SSH after `delay` on a thread of its own, unless re-armed or closed first.
fn arm(ctx: &Context, delay: Duration) {
    let state_dir = ctx.paths.state.clone();
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let (timers, changed) = &*TIMERS;
    timers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(state_dir.clone(), generation);
    changed.notify_all();
    let exec = Arc::clone(&ctx.exec);
    thread::spawn(move || {
        let deadline = Instant::now() + delay;
        let (timers, changed) = &*TIMERS;
        let mut t = timers.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if t.get(&state_dir) != Some(&generation) {
                return;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            t = changed
                .wait_timeout(t, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        drop(t);
        match close_now(exec.as_ref(), &state_dir) {
            Ok(()) => println!("emergency SSH window ended; SSH closed"),
            Err(e) => eprintln!("closing SSH at the end of the window failed: {}", e.message),
        }
    });
}

fn closes_at(state_dir: &str) -> Option<String> {
    let state: Value = serde_json::from_str(&read_small(&state_file(state_dir))?).ok()?;
    state.get("closesAt")?.as_str().map(str::to_string)
}

struct Current {
    open: bool,
    ports: Vec<u16>,
    firewall: bool,
}

fn current(ctx: &Context) -> (Current, Value) {
    let ports = ssh_ports(ctx.exec.as_ref());
    let out = ctx.exec.run("ufw", &["status", "numbered"]).stdout;
    let c = Current {
        open: !ssh_rule_numbers(&out, &ports).is_empty(),
        firewall: out.lines().any(|l| l.starts_with("Status: active")),
        ports,
    };
    let json = json!({
        "open": c.open,
        "ports": c.ports,
        "closesAt": closes_at(&ctx.paths.state),
        "firewall": c.firewall,
    });
    (c, json)
}

/// `ssh.status`.
#[must_use]
pub fn status(ctx: &Context) -> Value {
    current(ctx).1
}

/// `ssh.set`. `minutes` opens it for that long; the agent closes it again itself.
///
/// # Errors
/// `failed` if ufw is off or a ufw command fails.
pub fn set(open: bool, minutes: Option<i64>, ctx: &Context) -> Result<Value, AgentError> {
    let (before, _) = current(ctx);
    if !before.firewall {
        return Err(AgentError::new(
            ErrorCode::Failed,
            "the firewall (ufw) is off, so SSH is reachable whatever this says; turn ufw on first",
        ));
    }
    let exec = ctx.exec.as_ref();
    if !open {
        close_now(exec, &ctx.paths.state)?;
        return Ok(status(ctx));
    }
    if !before.open {
        for port in &before.ports {
            run(
                exec,
                "ufw",
                &["allow", &format!("{port}/tcp"), "comment", SSH_COMMENT],
            )?;
        }
    }
    if let Some(minutes) = minutes {
        let delay = Duration::from_secs(u64::try_from(minutes).unwrap_or(0) * 60);
        let at = (ctx.now)() + delay;
        let file = state_file(&ctx.paths.state);
        let state = json!({ "closesAt": iso(at) }).to_string();
        own_dir(Path::new(&ctx.paths.state), 0o700)
            .and_then(|()| write_atomic(&file, &state, 0o600))
            .map_err(|e| io_error("can't write", &file, &e))?;
        arm(ctx, delay);
    } else {
        // Open for good: no timer.
        remove(&state_file(&ctx.paths.state))?;
        disarm(&ctx.paths.state);
    }
    Ok(status(ctx))
}

/// At boot: close a window that ended while the agent was down, or re-arm one still open.
///
/// # Errors
/// If closing fails.
pub fn restore(ctx: &Context) -> Result<(), AgentError> {
    let Some(text) = closes_at(&ctx.paths.state) else {
        // No state file, or one that isn't JSON: nothing to restore.
        return Ok(());
    };
    let now: SystemTime = (ctx.now)();
    match parse_iso(&text)
        .and_then(|at| at.duration_since(now).ok())
        .filter(|d| !d.is_zero())
    {
        Some(left) => arm(ctx, left),
        None => close_now(ctx.exec.as_ref(), &ctx.paths.state)?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::exec::ExecResult;
    use crate::handlers::testing::TempRoot;

    /// A stateful fake ufw: rules come and go as the agent adds and deletes them.
    #[derive(Clone)]
    struct Ufw {
        active: bool,
        rules: Arc<Mutex<Vec<String>>>,
        sshd: String,
        ran: Arc<Mutex<Vec<String>>>,
    }

    impl Ufw {
        fn new(rules: &[&str]) -> Self {
            Self {
                active: true,
                rules: Arc::new(Mutex::new(rules.iter().map(|r| (*r).to_string()).collect())),
                sshd: "port 22\nlistenaddress 0.0.0.0\n".into(),
                ran: Arc::default(),
            }
        }
        fn rules(&self) -> Vec<String> {
            self.rules.lock().unwrap().clone()
        }
    }

    impl Exec for Ufw {
        #[expect(
            clippy::significant_drop_tightening,
            reason = "the fake firewall holds its rules for the whole command, like ufw's lock"
        )]
        fn run(&self, file: &str, args: &[&str]) -> ExecResult {
            let cmd = std::iter::once(file)
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ");
            self.ran.lock().unwrap().push(cmd.clone());
            let mut rules = self.rules.lock().unwrap();
            let stdout = match (cmd.as_str(), args) {
                ("sshd -T", _) => self.sshd.clone(),
                ("ufw status numbered", _) if !self.active => "Status: inactive\n".into(),
                ("ufw status numbered", _) => {
                    let body: Vec<String> = rules
                        .iter()
                        .enumerate()
                        .map(|(i, r)| format!("[{:>2}] {r:<26} ALLOW IN    Anywhere", i + 1))
                        .collect();
                    format!(
                        "Status: active\n\n     To  Action  From\n{}",
                        body.join("\n")
                    )
                }
                (_, ["--force", "delete", n]) => {
                    rules.remove(n.parse::<usize>().unwrap() - 1);
                    String::new()
                }
                (_, ["allow", rule, ..]) => {
                    rules.push((*rule).to_string());
                    rules.push(format!("{rule} (v6)"));
                    String::new()
                }
                _ => String::new(),
            };
            ExecResult {
                stdout,
                ..Default::default()
            }
        }
    }

    const START_MS: u64 = 1_794_225_600_000; // 2026-11-09T12:00:00.000Z

    struct Setup {
        _root: TempRoot,
        ufw: Ufw,
        clock: Arc<std::sync::atomic::AtomicU64>,
        ctx: Context,
    }

    fn setup(ufw: Ufw) -> Setup {
        let root = TempRoot::new("ssh");
        let clock = Arc::new(std::sync::atomic::AtomicU64::new(START_MS));
        let c = Arc::clone(&clock);
        let ctx = Context {
            version: "test".into(),
            exec: Arc::new(ufw.clone()),
            now: Arc::new(move || {
                std::time::UNIX_EPOCH + Duration::from_millis(c.load(Ordering::SeqCst))
            }),
            fetch: Arc::new(crate::fetch::Curl {
                exec: Arc::new(ufw.clone()),
            }),
            arch: std::env::consts::ARCH.into(),
            events: None,
            paths: root.paths.clone(),
            panel_group: "flytower".into(),
            releases_url: String::new(),
            release_key: String::new(),
            updating: Arc::default(),
        };
        Setup {
            _root: root,
            ufw,
            clock,
            ctx,
        }
    }

    #[test]
    fn finds_ssh_rules_for_any_port_v4_and_v6_highest_first() {
        let out = "Status: active\n\
                   [ 1] OpenSSH                    ALLOW IN    Anywhere\n\
                   [ 2] 2222/tcp                   LIMIT IN    Anywhere\n\
                   [ 3] 25565/tcp                  ALLOW IN    Anywhere  # flytower server survival\n\
                   [ 4] OpenSSH (v6)               ALLOW IN    Anywhere (v6)\n\
                   [ 5] 22/tcp                     DENY IN     Anywhere\n";
        assert_eq!(ssh_rule_numbers(out, &[22, 2222]), [4, 2, 1]);
    }

    #[test]
    fn reads_sshd_ports() {
        let mut ufw = Ufw::new(&[]);
        ufw.sshd = "port 2222\nport 22\nport 2222\nportx 9\n".into();
        assert_eq!(ssh_ports(&ufw), [2222, 22]);
        ufw.sshd = String::new();
        assert_eq!(ssh_ports(&ufw), [22]);
    }

    #[test]
    fn closes_every_ssh_rule_and_leaves_the_rest() {
        let s = setup(Ufw::new(&["OpenSSH", "80/tcp", "443/tcp", "OpenSSH (v6)"]));
        let r = set(false, None, &s.ctx).unwrap();
        assert_eq!(
            r,
            json!({ "open": false, "ports": [22], "closesAt": null, "firewall": true })
        );
        assert_eq!(s.ufw.rules(), ["80/tcp", "443/tcp"]);
        assert!(crate::verbs::check_result("ssh.set", &r).is_ok());
    }

    #[test]
    fn opens_for_a_while_then_closes_by_itself() {
        let s = setup(Ufw::new(&["80/tcp"]));
        let r = set(true, Some(60), &s.ctx).unwrap();
        assert_eq!(
            (r["open"].as_bool(), r["closesAt"].as_str()),
            (Some(true), Some("2026-11-09T13:00:00.000Z"))
        );
        assert!(s.ufw.rules().contains(&"22/tcp".to_string()));
        assert!(
            s.ufw
                .ran
                .lock()
                .unwrap()
                .contains(&"ufw allow 22/tcp comment flytower emergency ssh".to_string())
        );
        assert!(armed(&s.ctx.paths.state));
        let state = std::fs::read_to_string(state_file(&s.ctx.paths.state)).unwrap();
        assert_eq!(state, r#"{"closesAt":"2026-11-09T13:00:00.000Z"}"#);
        set(false, None, &s.ctx).unwrap();
        assert!(!armed(&s.ctx.paths.state));
        assert_eq!(s.ufw.rules(), ["80/tcp"]);
    }

    #[test]
    fn the_timer_closes_ssh() {
        let s = setup(Ufw::new(&["80/tcp"]));
        set(true, Some(30), &s.ctx).unwrap();
        // Re-arm with a tiny delay, as a restart near the end of the window would.
        arm(&s.ctx, Duration::from_millis(20));
        let deadline = Instant::now() + Duration::from_secs(5);
        while armed(&s.ctx.paths.state) {
            assert!(Instant::now() < deadline, "never closed");
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(s.ufw.rules(), ["80/tcp"]);
        assert!(!state_file(&s.ctx.paths.state).exists());
    }

    #[test]
    fn at_boot_closes_an_ended_window_and_rearms_an_open_one() {
        let s = setup(Ufw::new(&["80/tcp"]));
        set(true, Some(30), &s.ctx).unwrap();
        s.clock.fetch_add(10 * 60_000, Ordering::SeqCst);
        restore(&s.ctx).unwrap();
        assert!(armed(&s.ctx.paths.state));
        assert!(s.ufw.rules().contains(&"22/tcp".to_string()));
        s.clock.fetch_add(21 * 60_000, Ordering::SeqCst);
        restore(&s.ctx).unwrap();
        assert_eq!(s.ufw.rules(), ["80/tcp"]);
        assert!(!armed(&s.ctx.paths.state));
    }

    #[test]
    fn refuses_when_ufw_is_off() {
        let mut ufw = Ufw::new(&[]);
        ufw.active = false;
        let err = set(false, None, &setup(ufw).ctx).unwrap_err();
        assert!(err.message.contains("ufw"));
    }

    #[test]
    fn opening_for_good_clears_any_timer() {
        let s = setup(Ufw::new(&[]));
        set(true, Some(5), &s.ctx).unwrap();
        let r = set(true, None, &s.ctx).unwrap();
        assert_eq!(
            (r["open"].as_bool(), r["closesAt"].is_null()),
            (Some(true), true)
        );
        assert!(!armed(&s.ctx.paths.state));
        assert_eq!(
            s.ufw
                .rules()
                .iter()
                .filter(|r| r.starts_with("22/tcp"))
                .count(),
            2
        );
        assert!(crate::verbs::check_result("ssh.status", &status(&s.ctx)).is_ok());
    }
}
