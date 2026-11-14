//! The hostname router (`flytower-router`, in Go): one port for every server (#76). The panel
//! talks to the router itself over its own socket; the agent only installs, starts and stops
//! it and opens its port, because those need root.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::Context;
use super::files::{mkdir, read, remove, write};
use super::server::{run, ufw_rules_tagged};
use crate::envelope::{AgentError, ErrorCode};
use crate::fetch::sha256_file;

pub const UNIT: &str = "flytower-router.service";
/// Tags the router's firewall rule, so disable removes exactly that rule.
pub const UFW_COMMENT: &str = "flytower router";

struct Files {
    /// The unit as the current release ships it.
    shipped: PathBuf,
    unit: PathBuf,
    drop_in_dir: PathBuf,
    drop_in: PathBuf,
    binary: PathBuf,
    /// The hash of the binary the router was last started from.
    started_hash: PathBuf,
}

fn files(ctx: &Context) -> Files {
    let current = Path::new(&ctx.paths.prefix).join("current");
    let systemd = Path::new(&ctx.paths.systemd);
    let drop_in_dir = systemd.join(format!("{UNIT}.d"));
    Files {
        shipped: current.join("systemd").join(UNIT),
        unit: systemd.join(UNIT),
        drop_in: drop_in_dir.join("flytower.conf"),
        drop_in_dir,
        binary: current.join("bin/flytower-router"),
        started_hash: Path::new(&ctx.paths.state).join("router.sha256"),
    }
}

/// The drop-in that sets the port and lets the panel's user use the control socket.
#[must_use]
pub fn drop_in(prefix: &str, panel_user: &str, port: i64) -> String {
    format!(
        "# Written by flytower-agent (router.enable). Turn the router off in the panel instead of editing this.\n\
         [Service]\n\
         ExecStart=\n\
         ExecStart={prefix}/current/bin/flytower-router serve --allow-user {panel_user} --listen :{port}\n"
    )
}

/// Writes `text` to `path` unless it's already there. True if it wrote.
fn put(path: &Path, text: &str) -> Result<bool, AgentError> {
    if read(path).as_deref() == Some(text) {
        return Ok(false);
    }
    write(path, text, 0o644)?;
    Ok(true)
}

fn delete_rules(ctx: &Context) -> Result<(), AgentError> {
    let status = ctx.exec.run("ufw", &["status", "numbered"]);
    for n in ufw_rules_tagged(&status.stdout, UFW_COMMENT) {
        run(ctx, "ufw", &["--force", "delete", &n.to_string()])?;
    }
    Ok(())
}

fn record_hash(f: &Files) {
    if let Ok(hash) = sha256_file(&f.binary) {
        let _ = write(&f.started_hash, &format!("{hash}\n"), 0o600);
    }
}

/// `router.enable`: installs the current release's unit with a drop-in for the port, starts
/// the router (restarting it only if its settings changed, since a restart drops players), and
/// opens the port.
///
/// # Errors
/// `failed` if this release has no router or a step fails.
pub fn enable(port: i64, ctx: &Context) -> Result<Value, AgentError> {
    let f = files(ctx);
    let Some(unit) = read(&f.shipped) else {
        return Err(AgentError::new(
            ErrorCode::Failed,
            "this release doesn't include the hostname router",
        ));
    };
    let mut changed = put(&f.unit, &unit)?;
    mkdir(&f.drop_in_dir, 0o755)?;
    changed |= put(
        &f.drop_in,
        &drop_in(&ctx.paths.prefix, &ctx.panel_group, port),
    )?;
    if changed {
        run(ctx, "systemctl", &["daemon-reload"])?;
    }
    run(ctx, "systemctl", &["enable", UNIT])?;
    let active = ctx
        .exec
        .run("systemctl", &["is-active", "--quiet", UNIT])
        .code
        == 0;
    if changed || !active {
        run(ctx, "systemctl", &["restart", UNIT])?;
        record_hash(&f);
    }
    delete_rules(ctx)?;
    run(
        ctx,
        "ufw",
        &["allow", &format!("{port}/tcp"), "comment", UFW_COMMENT],
    )?;
    Ok(json!({}))
}

/// `router.disable`: stops the router, removes its unit and closes its port. The routes it
/// kept stay in its state folder.
///
/// # Errors
/// `failed` if a step fails.
pub fn disable(ctx: &Context) -> Result<Value, AgentError> {
    let f = files(ctx);
    if f.unit.exists() {
        run(ctx, "systemctl", &["disable", "--now", UNIT])?;
    }
    remove(&f.drop_in)?;
    if f.drop_in_dir.exists() {
        let _ = std::fs::remove_dir(&f.drop_in_dir);
    }
    remove(&f.unit)?;
    remove(&f.started_hash)?;
    run(ctx, "systemctl", &["daemon-reload"])?;
    delete_rules(ctx)?;
    Ok(json!({}))
}

/// At start-up, after an update: if the router is installed, brings its unit up to date with
/// the current release and restarts it only if its binary changed. Returns what it did.
///
/// # Errors
/// `failed` if a step fails.
pub fn refresh(ctx: &Context) -> Result<Option<&'static str>, AgentError> {
    let f = files(ctx);
    if !f.unit.exists() {
        return Ok(None);
    }
    let Some(unit) = read(&f.shipped) else {
        return Ok(None); // a release without the router; leave the old one running
    };
    let unit_changed = put(&f.unit, &unit)?;
    if unit_changed {
        run(ctx, "systemctl", &["daemon-reload"])?;
    }
    let hash = sha256_file(&f.binary).ok();
    let started = read(&f.started_hash).map(|h| h.trim().to_string());
    if unit_changed || (hash.is_some() && hash != started) {
        run(ctx, "systemctl", &["try-restart", UNIT])?;
        record_hash(&f);
        return Ok(Some("restarted the hostname router on its new version"));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::testing::{Fake, TempRoot, out};

    fn release(root: &TempRoot, unit: &str, binary: &str) {
        let current = Path::new(&root.paths.prefix).join("current");
        std::fs::create_dir_all(current.join("systemd")).unwrap();
        std::fs::create_dir_all(current.join("bin")).unwrap();
        std::fs::write(current.join("systemd").join(UNIT), unit).unwrap();
        std::fs::write(current.join("bin/flytower-router"), binary).unwrap();
        std::fs::create_dir_all(&root.paths.systemd).unwrap();
        std::fs::create_dir_all(&root.paths.state).unwrap();
    }

    const STATUS: &str = "Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] 22/tcp                     ALLOW IN    Anywhere\n[ 2] 25565/tcp                  ALLOW IN    Anywhere                   # flytower router\n[ 3] 25566/tcp                  ALLOW IN    Anywhere                   # flytower server survival\n";

    #[test]
    fn enable_installs_starts_and_opens_the_port() {
        let root = TempRoot::new("router-enable");
        release(&root, "[Unit]\n", "v1");
        let fake = Fake::new(vec![
            (
                "systemctl is-active",
                crate::exec::ExecResult {
                    code: 3,
                    ..Default::default()
                },
            ),
            ("ufw status numbered", out(STATUS)),
        ]);
        let ctx = fake.context(&root.paths);
        enable(25570, &ctx).unwrap();
        let f = files(&ctx);
        assert_eq!(std::fs::read_to_string(&f.unit).unwrap(), "[Unit]\n");
        let d = std::fs::read_to_string(&f.drop_in).unwrap();
        assert!(d.contains("--allow-user flytower --listen :25570\n"), "{d}");
        assert!(d.contains(&format!(
            "ExecStart={}/current/bin/flytower-router",
            root.paths.prefix
        )));
        let ran = fake.ran();
        for cmd in [
            "systemctl daemon-reload",
            "systemctl enable flytower-router.service",
            "systemctl restart flytower-router.service",
            "ufw --force delete 2",
            "ufw allow 25570/tcp comment flytower router",
        ] {
            assert!(ran.contains(&cmd.to_string()), "{cmd} not in {ran:?}");
        }
        assert!(
            !ran.contains(&"ufw --force delete 3".to_string()),
            "touched a server's rule"
        );
        assert!(f.started_hash.exists());
    }

    #[test]
    fn enable_again_does_not_restart_a_running_router() {
        let root = TempRoot::new("router-again");
        release(&root, "[Unit]\n", "v1");
        let fake = Fake::new(vec![]); // is-active succeeds
        let ctx = fake.context(&root.paths);
        enable(25565, &ctx).unwrap();
        fake.clear();
        enable(25565, &ctx).unwrap();
        let ran = fake.ran();
        assert!(
            !ran.iter().any(|c| c.starts_with("systemctl restart")),
            "{ran:?}"
        );
        assert!(
            !ran.contains(&"systemctl daemon-reload".to_string()),
            "{ran:?}"
        );
    }

    #[test]
    fn enable_needs_a_release_with_the_router() {
        let root = TempRoot::new("router-missing");
        let ctx = Fake::new(vec![]).context(&root.paths);
        let err = enable(25565, &ctx).unwrap_err();
        assert_eq!(err.code, ErrorCode::Failed);
    }

    #[test]
    fn disable_removes_everything_but_the_routes() {
        let root = TempRoot::new("router-disable");
        release(&root, "[Unit]\n", "v1");
        let fake = Fake::new(vec![("ufw status numbered", out(STATUS))]);
        let ctx = fake.context(&root.paths);
        enable(25565, &ctx).unwrap();
        fake.clear();
        disable(&ctx).unwrap();
        let f = files(&ctx);
        assert!(!f.unit.exists() && !f.drop_in_dir.exists() && !f.started_hash.exists());
        let ran = fake.ran();
        assert!(ran.contains(&"systemctl disable --now flytower-router.service".to_string()));
        assert!(ran.contains(&"ufw --force delete 2".to_string()));
        // Disabling when it was never on is fine.
        disable(&ctx).unwrap();
    }

    #[test]
    fn refresh_restarts_only_for_a_new_binary() {
        let root = TempRoot::new("router-refresh");
        release(&root, "[Unit]\n", "v1");
        let fake = Fake::new(vec![]);
        let ctx = fake.context(&root.paths);
        assert_eq!(refresh(&ctx).unwrap(), None, "not installed");
        enable(25565, &ctx).unwrap();
        fake.clear();
        assert_eq!(refresh(&ctx).unwrap(), None, "same release");
        assert!(fake.ran().is_empty());

        release(&root, "[Unit]\n", "v2");
        assert!(refresh(&ctx).unwrap().is_some());
        assert!(
            fake.ran()
                .contains(&"systemctl try-restart flytower-router.service".to_string())
        );
        fake.clear();
        assert_eq!(refresh(&ctx).unwrap(), None, "already on v2");

        release(&root, "[Unit]\nDescription=new\n", "v2");
        assert!(refresh(&ctx).unwrap().is_some(), "unit changed");
        assert!(fake.ran().contains(&"systemctl daemon-reload".to_string()));
    }
}
