//! Stable entry points (see `docs/decisions/0001-rust-and-go.md`, rule 5). systemd starts the agent as
//! `current/bin/flytower-agent`, and the agent starts a release's updater as
//! `releases/<version>/bin/flytower-updater`, so what is behind those paths can change between
//! releases. Releases from before these paths only have `bin/bun agent/agent.js`, and the agent still
//! starts those that way, so it can go back to one.

use std::path::{Path, PathBuf};

use crate::envelope::AgentError;
use crate::handlers::files::{read, write};

pub const AGENT_UNIT: &str = "flytower-agent.service";

/// True if a release folder has the wrapper scripts.
#[must_use]
pub fn has_wrappers(release: &Path) -> bool {
    release.join("bin/flytower-agent").exists()
}

/// The agent unit's `ExecStart` line for `release`. It always goes through `current`, so it
/// stays right after the symlink moves.
#[must_use]
pub fn agent_exec_start(prefix: &Path, release: &Path) -> String {
    let current = prefix.join("current");
    if has_wrappers(release) {
        format!("ExecStart={}", current.join("bin/flytower-agent").display())
    } else {
        format!(
            "ExecStart={} {}",
            current.join("bin/bun").display(),
            current.join("agent/agent.js").display()
        )
    }
}

/// How to run `release`'s updater: `bin/flytower-updater`, or Bun and the bundled script
/// in releases from before it.
#[must_use]
pub fn updater_command(release: &Path) -> Vec<PathBuf> {
    if has_wrappers(release) {
        vec![release.join("bin/flytower-updater")]
    } else {
        vec![release.join("bin/bun"), release.join("agent/updater.js")]
    }
}

/// True if `release` has an updater this agent knows how to start.
#[must_use]
pub fn has_updater(release: &Path) -> bool {
    release.join("bin/flytower-updater").exists() || release.join("agent/updater.js").exists()
}

/// Points the agent unit at `release`'s entry point. True if the file changed; the caller runs
/// `systemctl daemon-reload`. Leaves a missing unit, or one without `ExecStart`, alone.
///
/// # Errors
/// If the unit can't be written.
pub fn set_agent_exec_start(
    systemd: &Path,
    prefix: &Path,
    release: &Path,
) -> Result<bool, AgentError> {
    let file = systemd.join(AGENT_UNIT);
    let Some(unit) = read(&file) else {
        return Ok(false);
    };
    let line = agent_exec_start(prefix, release);
    // Only the first ExecStart line.
    let mut replaced = false;
    let next: String = unit
        .split_inclusive('\n')
        .map(|l| {
            if !replaced && l.starts_with("ExecStart=") {
                replaced = true;
                let end = &l[l.trim_end_matches(['\n', '\r']).len()..];
                format!("{line}{end}")
            } else {
                l.to_string()
            }
        })
        .collect();
    if !replaced || next == unit {
        return Ok(false);
    }
    // The unit exists, so its mode stays as it is.
    write(&file, &next, 0o644)?;
    Ok(true)
}

#[cfg(test)]
#[allow(
    clippy::must_use_candidate,
    clippy::missing_panics_doc,
    reason = "test helpers, shared with other modules' tests, may panic and needn't be used"
)]
pub mod tests {
    use super::*;
    use crate::handlers::testing::TempRoot;

    pub fn unit(exec: &str) -> String {
        format!("[Service]\n{exec}\nEnvironment=FLYTOWER_VERSION=0.4.0\nRestart=always\n")
    }

    pub fn old_exec(prefix: &Path) -> String {
        let p = prefix.display();
        format!("ExecStart={p}/current/bin/bun {p}/current/agent/agent.js")
    }

    pub fn new_exec(prefix: &Path) -> String {
        format!("ExecStart={}/current/bin/flytower-agent", prefix.display())
    }

    /// A machine running 0.4.0 (from before the wrappers) with 0.5.0 (with them) installed.
    pub fn machine(root: &TempRoot) -> PathBuf {
        let p = &root.paths;
        let prefix = PathBuf::from(&p.prefix);
        for d in [&p.config, &p.systemd, &p.state, &p.panel_data] {
            std::fs::create_dir_all(d).unwrap();
        }
        for v in ["0.4.0", "0.5.0"] {
            let dir = prefix.join("releases").join(v);
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            std::fs::create_dir_all(dir.join("agent")).unwrap();
            std::fs::write(dir.join("VERSION"), v).unwrap();
            std::fs::write(dir.join("bin/bun"), "").unwrap();
            std::fs::write(dir.join("agent/updater.js"), "").unwrap();
        }
        for w in ["flytower-agent", "flytower-updater"] {
            std::fs::write(prefix.join("releases/0.5.0/bin").join(w), "#!/bin/sh\n").unwrap();
        }
        std::os::unix::fs::symlink(prefix.join("releases/0.4.0"), prefix.join("current")).unwrap();
        std::fs::write(
            Path::new(&p.systemd).join(AGENT_UNIT),
            unit(&old_exec(&prefix)),
        )
        .unwrap();
        prefix
    }

    #[test]
    fn use_the_wrapper_when_a_release_has_one_and_bun_before_that() {
        let root = TempRoot::new("entry");
        let prefix = machine(&root);
        let (new, old) = (prefix.join("releases/0.5.0"), prefix.join("releases/0.4.0"));
        assert_eq!(agent_exec_start(&prefix, &new), new_exec(&prefix));
        assert_eq!(agent_exec_start(&prefix, &old), old_exec(&prefix));
        assert_eq!(updater_command(&new), [new.join("bin/flytower-updater")]);
        assert_eq!(
            updater_command(&old),
            [old.join("bin/bun"), old.join("agent/updater.js")]
        );
        assert!(has_updater(&new) && has_updater(&old));
        assert!(!has_updater(&prefix));
    }

    #[test]
    fn rewrite_only_the_exec_start_line_and_only_when_it_changes() {
        let root = TempRoot::new("entry");
        let prefix = machine(&root);
        let systemd = Path::new(&root.paths.systemd);
        let release = prefix.join("releases/0.5.0");
        assert!(set_agent_exec_start(systemd, &prefix, &release).unwrap());
        let text = std::fs::read_to_string(systemd.join(AGENT_UNIT)).unwrap();
        assert_eq!(text, unit(&new_exec(&prefix)));
        assert!(!set_agent_exec_start(systemd, &prefix, &release).unwrap());
    }

    #[test]
    fn leave_a_missing_unit_or_one_without_exec_start_alone() {
        let root = TempRoot::new("entry");
        let prefix = machine(&root);
        let systemd = Path::new(&root.paths.systemd);
        let release = prefix.join("releases/0.5.0");
        assert!(!set_agent_exec_start(&systemd.join("nowhere"), &prefix, &release).unwrap());
        std::fs::write(systemd.join(AGENT_UNIT), "[Service]\n").unwrap();
        assert!(!set_agent_exec_start(systemd, &prefix, &release).unwrap());
    }
}
