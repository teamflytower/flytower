//! Runs programs, never through a shell. Handlers take an [`Exec`] so tests can fake it.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// How a program ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait Exec: Send + Sync {
    fn run(&self, file: &str, args: &[&str]) -> ExecResult;

    /// Like [`Exec::run`], but for programs that may rightly take longer than the usual limit
    /// (downloads). The program is killed after `timeout`. Fakes needn't care.
    fn run_for(&self, file: &str, args: &[&str], timeout: Duration) -> ExecResult {
        let _ = timeout;
        self.run(file, args)
    }
}

/// The real thing. A program still running after two minutes is killed.
pub struct RealExec {
    pub timeout: Duration,
}

impl Default for RealExec {
    fn default() -> Self {
        Self {
            timeout: Duration::from_mins(2),
        }
    }
}

fn read_all(mut from: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = from.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

impl Exec for RealExec {
    fn run(&self, file: &str, args: &[&str]) -> ExecResult {
        self.run_for(file, args, self.timeout)
    }

    fn run_for(&self, file: &str, args: &[&str], timeout: Duration) -> ExecResult {
        let child = Command::new(file)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            // The program doesn't exist.
            Err(e) => {
                return ExecResult {
                    code: 127,
                    stdout: String::new(),
                    stderr: e.to_string(),
                };
            }
        };
        let stdout = child.stdout.take().map(read_all);
        let stderr = child.stderr.take().map(read_all);
        let pid = rustix::process::Pid::from_raw(i32::try_from(child.id()).unwrap_or(0));
        let (done, waited) = mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(child.wait());
        });
        let status = if let Ok(status) = waited.recv_timeout(timeout) {
            status.ok()
        } else {
            if let Some(pid) = pid {
                let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
            }
            waited.recv().ok().and_then(Result::ok)
        };
        let text = |h: Option<thread::JoinHandle<String>>| {
            h.and_then(|h| h.join().ok()).unwrap_or_default()
        };
        ExecResult {
            // A signal leaves no exit code; report it as a failure.
            code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout: text(stdout),
            stderr: text(stderr),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_programs() {
        let r = RealExec::default().run("sh", &["-c", "echo out; echo err >&2; exit 3"]);
        assert_eq!(
            r,
            ExecResult {
                code: 3,
                stdout: "out\n".into(),
                stderr: "err\n".into()
            }
        );
    }

    #[test]
    fn missing_programs_are_127() {
        assert_eq!(
            RealExec::default().run("/nonexistent/flytower", &[]).code,
            127
        );
    }

    #[test]
    fn kills_slow_programs() {
        let exec = RealExec {
            timeout: Duration::from_millis(100),
        };
        assert_eq!(exec.run("sleep", &["30"]).code, -1);
    }

    #[test]
    fn a_longer_limit_can_be_given_per_call() {
        let exec = RealExec {
            timeout: Duration::from_millis(50),
        };
        let r = exec.run_for(
            "sh",
            &["-c", "sleep 0.3; echo done"],
            Duration::from_secs(10),
        );
        assert_eq!((r.code, r.stdout.as_str()), (0, "done\n"));
    }
}
