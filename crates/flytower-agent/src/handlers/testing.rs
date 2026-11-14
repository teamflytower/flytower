//! Test helpers shared by the handler tests: a temporary box, and fakes for commands and
//! downloads.
#![allow(
    clippy::must_use_candidate,
    clippy::missing_panics_doc,
    reason = "test helpers may panic, and a test can ignore what they return"
)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::Context;
use crate::exec::{Exec, ExecResult};
use crate::units::Paths;

/// An exec that answers from a table keyed by "file arg arg …" (or the longest key the
/// command starts with) and records every call. Unlisted commands succeed with no output.
#[derive(Clone, Default)]
pub struct Fake {
    answers: Arc<BTreeMap<String, ExecResult>>,
    ran: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    pub fn new(answers: Vec<(&str, ExecResult)>) -> Self {
        let answers = answers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        Self {
            answers: Arc::new(answers),
            ran: Arc::default(),
        }
    }

    pub fn ran(&self) -> Vec<String> {
        self.ran.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.ran.lock().unwrap().clear();
    }

    pub fn context(&self, paths: &Paths) -> Context {
        Context {
            version: "0.0.0-test".into(),
            exec: Arc::new(self.clone()),
            now: super::system_clock(),
            fetch: Arc::new(crate::fetch::Curl {
                exec: Arc::new(self.clone()),
            }),
            arch: std::env::consts::ARCH.into(),
            events: None,
            paths: paths.clone(),
            panel_group: "flytower".into(),
            releases_url: super::update::RELEASES.into(),
            release_key: crate::release::RELEASE_KEY.into(),
            updating: Arc::default(),
        }
    }
}

impl Exec for Fake {
    fn run(&self, file: &str, args: &[&str]) -> ExecResult {
        let cmd = std::iter::once(file)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        self.ran.lock().unwrap().push(cmd.clone());
        self.answers
            .get(&cmd)
            .or_else(|| {
                self.answers
                    .iter()
                    .find(|(k, _)| cmd.starts_with(k.as_str()))
                    .map(|(_, v)| v)
            })
            .cloned()
            .unwrap_or_default()
    }
}

/// A successful command with this output.
pub fn out(stdout: &str) -> ExecResult {
    ExecResult {
        stdout: stdout.to_string(),
        ..Default::default()
    }
}

/// A temporary folder holding every path, removed when dropped.
pub struct TempRoot {
    dir: PathBuf,
    pub paths: Paths,
}

impl TempRoot {
    pub fn new(label: &str) -> Self {
        static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("flytower-{label}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            paths: Paths::under(&dir),
            dir,
        }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
