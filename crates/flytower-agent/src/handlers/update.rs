//! Updating Flytower: fetch a signed release,
//! check it, unpack it beside the others, and hand over to its updater, which switches
//! `current` and rolls back if the new version isn't healthy.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{Value, json};

use super::Context;
use super::files::{mkdir, remove};
use crate::entry_points::{has_updater, set_agent_exec_start, updater_command};
use crate::envelope::{AgentError, ErrorCode};
use crate::fetch::download_verified;
use crate::release::{sum_for, verify_sums};
use crate::time::{iso, parse_iso};
use crate::updater::write_record;
use crate::verbs::{UpdateRecord, UpdateState};
use crate::versions::compare;

pub const RELEASES: &str = "https://github.com/teamflytower/flytower/releases/download";

/// Holds the one-at-a-time lock until dropped.
pub(crate) struct Exclusive(Arc<AtomicBool>);

impl Drop for Exclusive {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Takes the lock an update, a rollback and a clean-up of old releases share: requests are
/// handled side by side, and two of these at once would delete each other's downloads or swap
/// releases under each other.
pub(crate) fn exclusively(ctx: &Context) -> Result<Exclusive, AgentError> {
    if ctx.updating.swap(true, Ordering::SeqCst) {
        return Err(AgentError::new(
            ErrorCode::Conflict,
            "an update is already running",
        ));
    }
    Ok(Exclusive(Arc::clone(&ctx.updating)))
}

fn failed(message: impl Into<String>) -> AgentError {
    AgentError::new(ErrorCode::Failed, message)
}

fn prefix(ctx: &Context) -> &Path {
    Path::new(&ctx.paths.prefix)
}

/// Release archives name the CPU as Go does.
fn release_arch(arch: &str) -> &'static str {
    if arch == "aarch64" { "arm64" } else { "amd64" }
}

/// Installed releases: folders under `releases` with a `VERSION` file, sorted.
fn installed(ctx: &Context) -> Vec<String> {
    let dir = prefix(ctx).join("releases");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.path().join("VERSION").exists())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// The version `current` points at, or the agent's own if it can't be read.
fn current_version(ctx: &Context) -> String {
    std::fs::read_link(prefix(ctx).join("current"))
        .ok()
        .and_then(|target| {
            let target = target.to_string_lossy().into_owned();
            target
                .split('/')
                .rfind(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| ctx.version.clone())
}

pub(crate) fn read_record(ctx: &Context) -> Option<UpdateRecord> {
    crate::updater::read_record(Path::new(&ctx.paths.state))
}

/// `update.status`.
#[must_use]
pub fn status(ctx: &Context) -> Value {
    json!({
        "current": current_version(ctx),
        "releases": installed(ctx),
        "last": read_record(ctx),
    })
}

/// Refuses while an update is running. A record left running for over 10 minutes is from
/// an updater that died.
pub(crate) fn busy(ctx: &Context) -> Result<(), AgentError> {
    let Some(r) = read_record(ctx) else {
        return Ok(());
    };
    let recent = parse_iso(&r.at)
        .and_then(|at| (ctx.now)().duration_since(at).ok())
        .is_none_or(|age| age < Duration::from_mins(10));
    if r.state == UpdateState::Running && recent {
        return Err(AgentError::new(
            ErrorCode::Conflict,
            "an update is already running",
        ));
    }
    Ok(())
}

fn not_running(ctx: &Context, version: &str) -> Result<(), AgentError> {
    if current_version(ctx) == version {
        return Err(AgentError::new(
            ErrorCode::Conflict,
            format!("{version} is already running"),
        ));
    }
    Ok(())
}

/// Hands over to the release's updater, in its own unit so it survives the agent's restart.
/// The agent unit is pointed at that release's entry point first, because an updater from
/// before the wrappers existed doesn't know to do it. The update is recorded as running
/// before the updater starts, so nothing else can start in between.
fn start_updater(ctx: &Context, version: &str, manual: bool) -> Result<(), AgentError> {
    let release = prefix(ctx).join("releases").join(version);
    let state = Path::new(&ctx.paths.state);
    let record = UpdateRecord {
        state: UpdateState::Running,
        from: current_version(ctx),
        to: version.into(),
        reason: None,
        at: iso((ctx.now)()),
        manual,
    };
    write_record(state, &record).map_err(|e| failed(format!("can't record the update: {e}")))?;
    set_agent_exec_start(Path::new(&ctx.paths.systemd), prefix(ctx), &release)?;
    let millis = (ctx.now)()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut args = vec![
        format!("--unit=flytower-update-{safe}-{millis}"),
        "--collect".into(),
        "--quiet".into(),
    ];
    // Always the agent's own folders, so an older updater uses them too rather than its
    // defaults.
    let p = &ctx.paths;
    for (key, value) in [
        ("FLYTOWER_PREFIX", &p.prefix),
        ("FLYTOWER_PANEL_DATA", &p.panel_data),
        ("FLYTOWER_CONFIG_DIR", &p.config),
        ("FLYTOWER_SYSTEMD_DIR", &p.systemd),
        ("FLYTOWER_AGENT_STATE_DIR", &p.state),
    ] {
        if !value.is_empty() {
            args.push(format!("--setenv={key}={value}"));
        }
    }
    args.extend(
        updater_command(&release)
            .iter()
            .map(|p| p.to_string_lossy().into_owned()),
    );
    args.push(version.into());
    if manual {
        args.push("--manual".into());
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let r = ctx.exec.run("systemd-run", &args);
    if r.code != 0 {
        let why = format!("couldn't start the updater: {}", r.stderr.trim());
        let _ = write_record(
            state,
            &UpdateRecord {
                state: UpdateState::Failed,
                reason: Some(why.clone()),
                ..record
            },
        );
        return Err(failed(why));
    }
    Ok(())
}

/// Downloads, checks and unpacks `version` into `work`, then moves it into `releases`.
fn fetch_release(ctx: &Context, version: &str, work: &Path) -> Result<(), AgentError> {
    // Every release is tagged v<version>. (The native- tags of 1.2 to 1.4 are retired.)
    let base = format!("{}/v{version}", ctx.releases_url.trim_end_matches('/'));
    let name = format!(
        "flytower-{version}-linux-{}.tar.gz",
        release_arch(&ctx.arch)
    );
    let get = |file: &str| {
        ctx.fetch
            .text(&format!("{base}/{file}"))
            .map_err(|e| failed(format!("{file} wasn't found for {version} ({e})")))
    };
    let sums = get("SHA256SUMS")?;
    let sig = get("SHA256SUMS.sig")?;
    if !verify_sums(sums.as_bytes(), &sig, &ctx.release_key) {
        return Err(failed(format!(
            "{version}'s signature doesn't match Flytower's key; not installing it"
        )));
    }
    let sha = sum_for(&sums, &name)
        .ok_or_else(|| failed(format!("{version} has no build for this machine ({name})")))?;
    let archive = work.join(&name);
    download_verified(ctx.fetch.as_ref(), &format!("{base}/{name}"), &archive, sha)?;

    let unpack = work.join("unpack");
    mkdir(&unpack, 0o755)?;
    let (a, u) = (archive.to_string_lossy(), unpack.to_string_lossy());
    let tar = ctx
        .exec
        .run("tar", &["-xzf", &a, "-C", &u, "--no-same-owner"]);
    if tar.code != 0 {
        return Err(failed(format!("unpacking failed: {}", tar.stderr.trim())));
    }
    let root = unpack.join(format!("flytower-{version}"));
    if !root.join("VERSION").exists() || !has_updater(&root) {
        return Err(failed(format!(
            "{name} isn't a Flytower release this agent can install"
        )));
    }
    let dest = prefix(ctx).join("releases").join(version);
    remove(&dest)?;
    std::fs::rename(&root, &dest)
        .map_err(|e| failed(format!("can't move {version} into place: {e}")))
}

/// `update.install`: the version is already checked against the protocol's pattern.
///
/// # Errors
/// `conflict` if an update is running, `version` is, or it's older than the running one;
/// `failed` if any check fails.
pub fn install(version: &str, ctx: &Context) -> Result<Value, AgentError> {
    let _lock = exclusively(ctx)?;
    busy(ctx)?;
    not_running(ctx, version)?;
    // Going back is a rollback, to a release still installed. Fetching an older one would let
    // anyone who can ask bring back a release with problems fixed since.
    let current = current_version(ctx);
    if compare(version, &current).is_lt() {
        return Err(AgentError::new(
            ErrorCode::Conflict,
            format!(
                "{version} is older than {current}, which is running; only installed releases can be gone back to"
            ),
        ));
    }
    let work: PathBuf = prefix(ctx)
        .join("releases")
        .join(format!(".download-{version}"));
    remove(&work)?;
    mkdir(&work, 0o755)?;
    let result = fetch_release(ctx, version, &work);
    let _ = remove(&work);
    result?;
    start_updater(ctx, version, false)?;
    Ok(json!({ "started": true }))
}

/// `update.rollback`: switches to a release that is already installed.
///
/// # Errors
/// `not_found` if it isn't installed, `conflict` if it's running or an update is.
pub fn rollback(version: &str, ctx: &Context) -> Result<Value, AgentError> {
    let _lock = exclusively(ctx)?;
    busy(ctx)?;
    if !installed(ctx).iter().any(|v| v == version) {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            format!("{version} isn't installed"),
        ));
    }
    not_running(ctx, version)?;
    start_updater(ctx, version, true)?;
    Ok(json!({ "started": true }))
}

/// Points the agent's own unit at the running release's entry point when the agent starts,
/// so installs from before the wrappers move over. Takes effect from the next restart.
///
/// # Errors
/// If the unit can't be written or systemd can't reload.
pub fn refresh_agent_unit(ctx: &Context) -> Result<bool, AgentError> {
    let Ok(release) = std::fs::canonicalize(prefix(ctx).join("current")) else {
        return Ok(false);
    };
    if !set_agent_exec_start(Path::new(&ctx.paths.systemd), prefix(ctx), &release)? {
        return Ok(false);
    }
    let r = ctx.exec.run("systemctl", &["daemon-reload"]);
    if r.code != 0 {
        let why = r.stderr.trim();
        return Err(failed(format!(
            "systemctl daemon-reload: {}",
            if why.is_empty() { "failed" } else { why }
        )));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::entry_points::tests::{machine, new_exec, old_exec};
    use crate::entry_points::{AGENT_UNIT, has_wrappers};
    use crate::exec::{Exec, ExecResult, RealExec};
    use crate::fetch::{Fetch, sha256_file};
    use crate::handlers::testing::{Fake, TempRoot};
    use crate::release::tests::{sign, test_key};

    /// Serves files by URL suffix, and records what was asked for.
    #[derive(Default)]
    struct Web {
        text: BTreeMap<String, String>,
        files: BTreeMap<String, PathBuf>,
        seen: Mutex<Vec<String>>,
    }

    impl Fetch for Web {
        fn text(&self, url: &str) -> Result<String, String> {
            self.seen.lock().unwrap().push(url.into());
            let hit = self.text.iter().find(|(k, _)| url.ends_with(k.as_str()));
            hit.map(|(_, v)| v.clone()).ok_or_else(|| "404".into())
        }
        fn save(&self, url: &str, dest: &Path) -> Result<(), String> {
            self.seen.lock().unwrap().push(url.into());
            let hit = self.files.iter().find(|(k, _)| url.ends_with(k.as_str()));
            let (_, src) = hit.ok_or("404")?;
            std::fs::copy(src, dest)
                .map(drop)
                .map_err(|e| e.to_string())
        }
    }

    /// `tar` really runs; everything else goes to the fake.
    struct TarOnly(Fake);

    impl Exec for TarOnly {
        fn run(&self, file: &str, args: &[&str]) -> ExecResult {
            if file == "tar" {
                RealExec::default().run(file, args)
            } else {
                self.0.run(file, args)
            }
        }
    }

    /// A machine with 0.4.0 installed and running, and a fake that records commands.
    fn layout() -> (TempRoot, Fake, Context) {
        let root = TempRoot::new("update");
        let p = &root.paths;
        for d in [&p.config, &p.systemd, &p.state, &p.panel_data] {
            std::fs::create_dir_all(d).unwrap();
        }
        let releases = Path::new(&p.prefix).join("releases");
        std::fs::create_dir_all(releases.join("0.4.0")).unwrap();
        std::fs::write(releases.join("0.4.0/VERSION"), "0.4.0").unwrap();
        std::os::unix::fs::symlink(releases.join("0.4.0"), Path::new(&p.prefix).join("current"))
            .unwrap();
        let fake = Fake::new(vec![]);
        let mut ctx = fake.context(p);
        ctx.exec = Arc::new(TarOnly(fake.clone()));
        ctx.releases_url = "https://releases.test".into();
        ctx.arch = "x86_64".into();
        (root, fake, ctx)
    }

    /// A signed 0.5.0 release, as a tarball built with the real tar.
    fn release(root: &TempRoot, ctx: &mut Context, bad_sig: bool) -> Arc<Web> {
        let build = Path::new(&root.paths.state).join("build");
        let src = build.join("flytower-0.5.0");
        std::fs::create_dir_all(src.join("agent")).unwrap();
        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::write(src.join("VERSION"), "0.5.0").unwrap();
        std::fs::write(src.join("agent/updater.js"), "").unwrap();
        std::fs::write(src.join("bin/bun"), "").unwrap();
        let name = "flytower-0.5.0-linux-amd64.tar.gz";
        let tgz = build.join(name);
        let ok = Command::new("tar")
            .arg("-czf")
            .arg(&tgz)
            .arg("-C")
            .arg(&build)
            .arg("flytower-0.5.0")
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let sums = format!("{}  {name}\n", sha256_file(&tgz).unwrap());
        let (key, pem) = test_key();
        let signed = if bad_sig {
            format!("{sums}x")
        } else {
            sums.clone()
        };
        let web = Arc::new(Web {
            text: [
                ("/SHA256SUMS".to_string(), sums),
                ("/SHA256SUMS.sig".to_string(), sign(&key, signed.as_bytes())),
            ]
            .into(),
            files: [(format!("/{name}"), tgz)].into(),
            seen: Mutex::default(),
        });
        ctx.fetch = Arc::clone(&web) as Arc<dyn Fetch>;
        ctx.release_key = pem;
        web
    }

    fn systemd_run(fake: &Fake) -> String {
        fake.ran()
            .into_iter()
            .find(|c| c.starts_with("systemd-run "))
            .expect("systemd-run ran")
    }

    #[test]
    fn checks_the_signature_and_hash_unpacks_and_starts_the_updater() {
        let (root, fake, mut ctx) = layout();
        let web = release(&root, &mut ctx, false);
        assert_eq!(install("0.5.0", &ctx).unwrap(), json!({ "started": true }));
        let seen = web.seen.lock().unwrap().clone();
        assert_eq!(seen[0], "https://releases.test/v0.5.0/SHA256SUMS");
        let dest = Path::new(&root.paths.prefix).join("releases/0.5.0");
        assert_eq!(
            std::fs::read_to_string(dest.join("VERSION")).unwrap(),
            "0.5.0"
        );
        let run = systemd_run(&fake);
        assert!(run.contains("--unit=flytower-update-0-5-0-"), "{run}");
        assert!(run.ends_with(&format!(
            " {} 0.5.0",
            dest.join("agent/updater.js").display()
        )));
        // Nothing left over beside the releases.
        let mut names: Vec<_> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["0.4.0", "0.5.0"]);
        // Recorded as running before the updater started, so nothing else can start.
        let s = status(&ctx);
        assert_eq!(s["releases"], json!(["0.4.0", "0.5.0"]));
        assert_eq!(s["last"]["state"], "running");
        assert_eq!(
            (s["last"]["from"].as_str(), s["last"]["to"].as_str()),
            (Some("0.4.0"), Some("0.5.0"))
        );
        assert_eq!(busy(&ctx).unwrap_err().code, ErrorCode::Conflict);
        // And the updater is told the agent's folders.
        assert!(
            run.contains(&format!(
                "--setenv=FLYTOWER_AGENT_STATE_DIR={}",
                ctx.paths.state
            )),
            "{run}"
        );
    }

    #[test]
    fn refuses_a_release_older_than_the_one_running() {
        let (_root, _fake, ctx) = layout();
        for version in ["0.3.9", "0.4.0-beta.1", "0.4.0-native.1"] {
            let err = install(version, &ctx).unwrap_err();
            assert_eq!(err.code, ErrorCode::Conflict, "{version}");
            assert!(err.message.contains("older than 0.4.0"), "{}", err.message);
        }
    }

    #[test]
    fn one_update_at_a_time() {
        let (_root, _fake, ctx) = layout();
        let held = exclusively(&ctx).unwrap();
        assert_eq!(
            install("0.5.0", &ctx).unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(
            super::super::disk::prune_flytower(&ctx).unwrap_err().code,
            ErrorCode::Conflict
        );
        drop(held);
        assert!(exclusively(&ctx).is_ok());
    }

    #[test]
    fn downloads_from_the_v_tag() {
        let (root, _fake, mut ctx) = layout();
        let web = release(&root, &mut ctx, false);
        assert!(install("1.2.1", &ctx).is_err());
        let seen = web.seen.lock().unwrap().clone();
        assert_eq!(seen[0], "https://releases.test/v1.2.1/SHA256SUMS");
    }

    #[test]
    fn refuses_a_bad_signature_before_downloading_the_archive() {
        let (root, fake, mut ctx) = layout();
        let web = release(&root, &mut ctx, true);
        let err = install("0.5.0", &ctx).unwrap_err();
        assert_eq!(err.code, ErrorCode::Failed);
        assert!(err.message.contains("signature"), "{}", err.message);
        let seen = web.seen.lock().unwrap().clone();
        assert!(!seen.iter().any(|u| u.ends_with(".tar.gz")));
        assert!(
            !Path::new(&root.paths.prefix)
                .join("releases/0.5.0")
                .exists()
        );
        assert!(fake.ran().is_empty());
        // The built-in key doesn't match the test one either.
        let (root, _, mut ctx) = layout();
        release(&root, &mut ctx, false);
        ctx.release_key = crate::release::RELEASE_KEY.into();
        assert!(
            install("0.5.0", &ctx)
                .unwrap_err()
                .message
                .contains("signature")
        );
    }

    #[test]
    fn refuses_the_version_already_running_and_while_an_update_runs() {
        let (root, _fake, ctx) = layout();
        assert_eq!(
            install("0.4.0", &ctx).unwrap_err().code,
            ErrorCode::Conflict
        );
        let record = |at: &str| {
            json!({ "state": "running", "from": "0.4.0", "to": "0.5.0", "reason": null, "at": at, "manual": false })
                .to_string()
        };
        let file = Path::new(&root.paths.state).join("update.json");
        std::fs::write(&file, record(&crate::time::iso((ctx.now)()))).unwrap();
        assert_eq!(
            install("0.5.0", &ctx).unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(status(&ctx)["last"]["state"], "running");
        // An hour-old "running" record is from an updater that died.
        std::fs::write(&file, record("2020-01-01T00:00:00.000Z")).unwrap();
        assert_ne!(
            install("0.5.0", &ctx).unwrap_err().code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn rollback_needs_an_installed_release_that_isnt_running() {
        let root = TempRoot::new("update");
        let prefix = machine(&root);
        let fake = Fake::new(vec![]);
        let ctx = fake.context(&root.paths);
        assert_eq!(
            rollback("0.3.0", &ctx).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            rollback("0.4.0", &ctx).unwrap_err().code,
            ErrorCode::Conflict
        );
        // Roll "back" to 0.5.0, which has the wrapper.
        assert_eq!(rollback("0.5.0", &ctx).unwrap(), json!({ "started": true }));
        let run = systemd_run(&fake);
        let wrapper = prefix.join("releases/0.5.0/bin/flytower-updater");
        assert!(
            run.ends_with(&format!(" {} 0.5.0 --manual", wrapper.display())),
            "{run}"
        );
        let unit = std::fs::read_to_string(Path::new(&root.paths.systemd).join(AGENT_UNIT));
        assert!(unit.unwrap().contains(&new_exec(&prefix)));
    }

    #[test]
    fn is_pointed_at_an_older_release_before_its_updater_runs() {
        let root = TempRoot::new("update");
        let prefix = machine(&root);
        let current = prefix.join("current");
        std::fs::remove_file(&current).unwrap();
        std::os::unix::fs::symlink(prefix.join("releases/0.5.0"), &current).unwrap();
        let unit_file = Path::new(&root.paths.systemd).join(AGENT_UNIT);
        std::fs::write(
            &unit_file,
            crate::entry_points::tests::unit(&new_exec(&prefix)),
        )
        .unwrap();
        let fake = Fake::new(vec![]);
        let ctx = fake.context(&root.paths);
        rollback("0.4.0", &ctx).unwrap();
        assert!(
            std::fs::read_to_string(&unit_file)
                .unwrap()
                .contains(&old_exec(&prefix))
        );
        let old = prefix.join("releases/0.4.0");
        assert!(!has_wrappers(&old));
        assert!(systemd_run(&fake).contains(&old.join("agent/updater.js").display().to_string()));
    }

    #[test]
    fn moves_the_agent_unit_to_the_wrapper_when_its_release_has_one() {
        let root = TempRoot::new("update");
        let prefix = machine(&root);
        let fake = Fake::new(vec![]);
        let ctx = fake.context(&root.paths);
        assert!(!refresh_agent_unit(&ctx).unwrap()); // 0.4.0 has no wrapper
        assert!(fake.ran().is_empty());
        let current = prefix.join("current");
        std::fs::remove_file(&current).unwrap();
        std::os::unix::fs::symlink(prefix.join("releases/0.5.0"), &current).unwrap();
        assert!(refresh_agent_unit(&ctx).unwrap());
        assert_eq!(fake.ran(), ["systemctl daemon-reload"]);
        let unit = std::fs::read_to_string(Path::new(&root.paths.systemd).join(AGENT_UNIT));
        assert!(unit.unwrap().contains(&new_exec(&prefix)));
    }
}
