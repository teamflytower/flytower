//! Test helpers shared by the handler tests: a temporary box, and fakes for commands,
//! downloads and systemd.
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
            systemd: Arc::new(FakeSystemd::default()),
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

/// systemd with a fixed set of units, each with the properties the test gives it. It records
/// every call as "show unit Prop Prop", "reset-failed unit" or "start unit", and fails a call
/// that starts with a prefix given to [`fail`](Self::fail).
#[derive(Default)]
pub struct FakeSystemd {
    units: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
    failures: Mutex<Vec<(String, String)>>,
    ran: Mutex<Vec<String>>,
}

impl FakeSystemd {
    pub fn with(units: &[(&str, &[(&str, &str)])]) -> Arc<Self> {
        let me = Self::default();
        for (unit, props) in units {
            me.set(unit, props);
        }
        Arc::new(me)
    }

    /// Adds or changes a unit's properties.
    pub fn set(&self, unit: &str, props: &[(&str, &str)]) {
        let mut entry = BTreeMap::from([
            ("Id".to_string(), unit.to_string()),
            ("LoadState".to_string(), "loaded".to_string()),
        ]);
        for (k, v) in props {
            entry.insert((*k).to_string(), (*v).to_string());
        }
        self.units
            .lock()
            .unwrap()
            .entry(unit.to_string())
            .or_default()
            .extend(entry);
    }

    pub fn fail(&self, prefix: &str, message: &str) {
        self.failures
            .lock()
            .unwrap()
            .push((prefix.to_string(), message.to_string()));
    }

    pub fn ran(&self) -> Vec<String> {
        self.ran.lock().unwrap().clone()
    }

    fn call(&self, call: String) -> Result<(), String> {
        let failure = self
            .failures
            .lock()
            .unwrap()
            .iter()
            .find(|(prefix, _)| call.starts_with(prefix.as_str()))
            .map(|(_, m)| m.clone());
        self.ran.lock().unwrap().push(call);
        failure.map_or(Ok(()), Err)
    }
}

impl crate::systemd::Systemd for FakeSystemd {
    fn show(&self, unit: &str, properties: &[&str]) -> Result<BTreeMap<String, String>, String> {
        self.call(format!("show {unit} {}", properties.join(" ")))?;
        let known = self.units.lock().unwrap().get(unit).cloned();
        let known = known.as_ref();
        Ok(properties
            .iter()
            .map(|p| {
                let v = match (known, *p) {
                    (Some(u), p) => u.get(p).cloned().unwrap_or_default(),
                    (None, "LoadState") => "not-found".into(),
                    (None, "ActiveState") => "inactive".into(),
                    (None, "Id") => unit.into(),
                    (None, _) => String::new(),
                };
                ((*p).to_string(), v)
            })
            .collect())
    }

    fn reset_failed(&self, unit: &str) -> Result<(), String> {
        self.call(format!("reset-failed {unit}"))
    }

    fn job(&self, verb: &str, unit: &str) -> Result<(), String> {
        self.call(format!("{verb} {unit}"))
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
