//! The agent's own folders: outside the panel's data
//! folder so the panel's user can't swap anything in them. The state folder is root only,
//! and the archive of deleted servers is root's, readable by the panel's group. Releases
//! before these kept both inside the panel's folder; what they left there is moved across once.

use std::fs;
use std::path::{Path, PathBuf};

use crate::envelope::{AgentError, ErrorCode};
use crate::handlers::Context;
use crate::safe_fs::{chmod_no_follow, own_dir, read_small, write_atomic};

/// Files the state folder holds that are worth keeping across the move.
const STATE_FILES: [&str; 2] = ["ssh.json", "update.json"];

fn failed(message: String) -> AgentError {
    AgentError::new(ErrorCode::Failed, message)
}

fn run(ctx: &Context, file: &str, args: &[&str]) -> Result<(), AgentError> {
    let r = ctx.exec.run(file, args);
    if r.code == 0 {
        return Ok(());
    }
    let why = r.stderr.trim();
    Err(failed(format!(
        "{file} {}: {}",
        args.join(" "),
        if why.is_empty() { "failed" } else { why }
    )))
}

/// Archive names `server.delete` makes; the panel lists the same pattern
/// (`^[a-z][a-z0-9-]{1,30}-[\dTZ-]+\.tar\.gz$`).
#[must_use]
pub fn is_archive_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tar.gz") else {
        return false;
    };
    // Backtracking as the regex does: some '-' splits a valid name from a valid stamp.
    stem.char_indices()
        .filter(|&(_, c)| c == '-')
        .any(|(i, _)| {
            let (server, stamp) = (&stem[..i], &stem[i + 1..]);
            let mut chars = server.chars();
            chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && (2..=31).contains(&server.len())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                && !stamp.is_empty()
                && stamp
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == 'T' || c == 'Z' || c == '-')
        })
}

/// The archive folder, made if need be: the agent's, readable by the panel's group.
///
/// # Errors
/// If it isn't the agent's, or its group can't be set.
pub fn archive_dir(ctx: &Context) -> Result<PathBuf, AgentError> {
    let dir = PathBuf::from(&ctx.paths.archive);
    own_dir(&dir, 0o750).map_err(|e| failed(format!("can't use {}: {e}", dir.display())))?;
    // Safe by path: own_dir has just checked nobody else can change this folder.
    run(
        ctx,
        "chgrp",
        &["--no-dereference", &ctx.panel_group, &ctx.paths.archive],
    )?;
    Ok(dir)
}

fn is_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn same(a: &Path, b: &Path) -> bool {
    a.components().eq(b.components())
}

/// Makes the agent's folders and moves in what older releases left in the panel's folder:
/// the SSH timer and the last update record (copied as text, never followed through a link)
/// and the archives of deleted servers (regular files only).
///
/// # Errors
/// If a folder isn't the agent's, or a step fails.
pub fn prepare(ctx: &Context) -> Result<(), AgentError> {
    let state = PathBuf::from(&ctx.paths.state);
    own_dir(&state, 0o700).map_err(|e| failed(format!("can't use {}: {e}", state.display())))?;
    let data = Path::new(&ctx.paths.panel_data);

    let old_state = data.join("agent");
    if !same(&old_state, &state) && is_dir(&old_state) {
        for file in STATE_FILES {
            let target = state.join(file);
            if let Some(text) = read_small(&old_state.join(file))
                && fs::symlink_metadata(&target).is_err()
                && serde_json::from_str::<serde_json::Value>(&text).is_ok()
            {
                write_atomic(&target, &text, 0o600)
                    .map_err(|e| failed(format!("can't write {}: {e}", target.display())))?;
            }
            let _ = fs::remove_file(old_state.join(file));
        }
        let _ = fs::remove_dir(&old_state);
    }

    let old_archive = data.join("archive");
    let archive = Path::new(&ctx.paths.archive);
    if !same(&old_archive, archive) && is_dir(&old_archive) {
        let dir = archive_dir(ctx)?;
        let entries = fs::read_dir(&old_archive)
            .map_err(|e| failed(format!("can't read {}: {e}", old_archive.display())))?;
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let from = entry.path();
            let regular = fs::symlink_metadata(&from).is_ok_and(|m| m.file_type().is_file());
            let to = dir.join(&name);
            if !regular || !is_archive_name(&name) || fs::symlink_metadata(&to).is_ok() {
                continue;
            }
            if fs::rename(&from, &to).is_err() {
                continue; // On another disk, say: left where it was.
            }
            // Now in a folder only root can change, so it can be fixed up by path.
            chmod_no_follow(&to, 0o640)
                .map_err(|e| failed(format!("can't set {}: {e}", to.display())))?;
            let owner = format!("0:{}", ctx.panel_group);
            run(
                ctx,
                "chown",
                &["--no-dereference", &owner, to.to_str().unwrap_or_default()],
            )?;
        }
        let _ = fs::remove_dir(&old_archive);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{MetadataExt, symlink};

    use super::*;
    use crate::handlers::testing::{Fake, TempRoot};

    fn machine(label: &str) -> (TempRoot, PathBuf) {
        let root = TempRoot::new(label);
        let data = PathBuf::from(&root.paths.panel_data);
        fs::create_dir_all(data.join("agent")).unwrap();
        fs::create_dir_all(data.join("archive")).unwrap();
        (root, data)
    }

    #[test]
    fn knows_archive_names() {
        assert!(is_archive_name("survival-2026-11-01T10-00-00-000Z.tar.gz"));
        assert!(is_archive_name("my-world-2026-11-01T10-00-00-000Z.tar.gz"));
        assert!(!is_archive_name("notes.txt"));
        assert!(!is_archive_name("Survival-2026.tar.gz"));
        assert!(!is_archive_name("ab-.tar.gz"));
    }

    #[test]
    fn moves_the_old_state_into_a_root_only_folder() {
        let (root, data) = machine("folders-state");
        fs::write(
            data.join("agent/ssh.json"),
            r#"{"closesAt":"2030-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();
        fs::write(data.join("agent/update.json"), "not json").unwrap();
        let fake = Fake::new(vec![]);
        prepare(&fake.context(&root.paths)).unwrap();
        let state = Path::new(&root.paths.state);
        assert_eq!(fs::metadata(state).unwrap().mode() & 0o777, 0o700);
        assert!(
            fs::read_to_string(state.join("ssh.json"))
                .unwrap()
                .contains("2030")
        );
        assert!(!state.join("update.json").exists());
        assert!(!data.join("agent").exists());
    }

    #[test]
    fn moves_archives_but_not_links_or_other_files() {
        let (root, data) = machine("folders-archive");
        let name = "survival-2026-11-01T10-00-00-000Z.tar.gz";
        fs::write(data.join("archive").join(name), "tarball").unwrap();
        let secret = data.join("secret");
        fs::write(&secret, "root only").unwrap();
        symlink(
            &secret,
            data.join("archive/other-2026-11-01T10-00-00-000Z.tar.gz"),
        )
        .unwrap();
        fs::write(data.join("archive/notes.txt"), "hi").unwrap();
        let fake = Fake::new(vec![]);
        prepare(&fake.context(&root.paths)).unwrap();
        let archive = Path::new(&root.paths.archive);
        assert_eq!(fs::read_to_string(archive.join(name)).unwrap(), "tarball");
        assert_eq!(
            fs::metadata(archive.join(name)).unwrap().mode() & 0o777,
            0o640
        );
        assert_eq!(fs::metadata(archive).unwrap().mode() & 0o777, 0o750);
        assert!(
            fs::symlink_metadata(archive.join("other-2026-11-01T10-00-00-000Z.tar.gz")).is_err()
        );
        assert!(data.join("archive/notes.txt").exists());
        let ran = fake.ran();
        let dir = archive.display();
        assert!(ran.contains(&format!("chgrp --no-dereference flytower {dir}")));
        assert!(ran.contains(&format!("chown --no-dereference 0:flytower {dir}/{name}")));
    }
}
