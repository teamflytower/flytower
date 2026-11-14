//! Disk use, measured as root so nothing is out of reach, and three fixed ways to free some.
//! Every place measured is built from the agent's
//! own paths and a fixed list; the panel only names servers.

use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use flytower_du::{Measured, Options, measure_all};
use serde_json::{Value, json};

use super::Context;
use super::files::remove;
use super::update::{busy, exclusively, read_record};
use crate::envelope::{AgentError, ErrorCode};
use crate::updater::db_backups;

/// The groups a server's space is split into, in the order the result lists them.
pub const GROUPS: [&str; 7] = [
    "world", "logs", "content", "map", "backups", "exports", "other",
];

/// Which group a top-level entry of a server folder counts towards.
#[must_use]
pub fn group_of(entry: &str, level_name: Option<&str>) -> &'static str {
    let level = level_name.and_then(|l| l.split('/').next()).map(str::trim);
    if level.is_some_and(|l| !l.is_empty() && entry == l) || entry.starts_with("world") {
        "world"
    } else if entry == "logs" || entry == "crash-reports" {
        "logs"
    } else if entry == "mods" || entry == "plugins" || entry == "config" {
        "content"
    } else {
        "other"
    }
}

/// Every folder the agent measures or cleans, from its paths.
struct Places {
    servers: PathBuf,
    runtimes: PathBuf,
    config: PathBuf,
    prefix: PathBuf,
    data: PathBuf,
    backups: PathBuf,
    exports: PathBuf,
    maps: PathBuf,
    imports: PathBuf,
    archive: PathBuf,
    var_log: PathBuf,
    journal: PathBuf,
    apt: PathBuf,
    tmp: PathBuf,
    var_tmp: PathBuf,
    /// The agent's own folder, holding the updater's database copies.
    state: PathBuf,
}

impl Places {
    fn of(ctx: &Context) -> Self {
        let p = &ctx.paths;
        let data = PathBuf::from(&p.panel_data);
        let root = PathBuf::from(&p.system);
        Self {
            servers: p.servers.clone().into(),
            runtimes: p.runtimes.clone().into(),
            config: p.config.clone().into(),
            prefix: p.prefix.clone().into(),
            backups: data.join("backups"),
            exports: data.join("exports"),
            maps: data.join("maps"),
            imports: data.join("imports"),
            archive: p.archive.clone().into(),
            state: p.state.clone().into(),
            data,
            var_log: root.join("var/log"),
            journal: root.join("var/log/journal"),
            apt: root.join("var/cache/apt"),
            tmp: root.join("tmp"),
            var_tmp: root.join("var/tmp"),
        }
    }

    /// What `apt-get clean` removes.
    fn apt_cache(&self) -> Vec<PathBuf> {
        vec![
            self.apt.join("archives"),
            self.apt.join("pkgcache.bin"),
            self.apt.join("srcpkgcache.bin"),
        ]
    }
}

fn walk(paths: &[PathBuf]) -> Vec<Measured> {
    if paths.is_empty() {
        return Vec::new();
    }
    measure_all(
        paths,
        Options {
            one_file_system: true,
            ..Options::default()
        },
    )
}

fn sum(ms: &[Measured]) -> u64 {
    ms.iter().map(|m| m.bytes).sum()
}

/// A folder's entries, sorted, and 1 if it couldn't be read (a missing folder is just empty).
fn names(dir: &Path) -> (Vec<String>, u64) {
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            names.sort();
            (names, 0)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => (Vec::new(), 0),
        Err(_) => (Vec::new(), 1),
    }
}

/// A server's `level-name`, if it has one.
fn level_name(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("server.properties")).ok()?;
    text.lines()
        .find_map(|line| {
            let rest = line.trim_start().strip_prefix("level-name")?.trim_start();
            let value = rest.strip_prefix(['=', ':'])?.trim();
            Some(value.to_string())
        })
        .filter(|v| !v.is_empty())
}

/// The device a path is on, or `None` if it isn't there (or is a symlink).
fn device_of(path: &Path) -> Option<u64> {
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|m| !m.file_type().is_symlink())
        .map(|m| m.dev())
}

/// A path with `.`, doubled and trailing slashes removed, for comparing.
fn normal(path: &Path) -> PathBuf {
    path.components().collect()
}

/// The release `current` points at.
fn current_release(prefix: &Path) -> Option<String> {
    let target = std::fs::read_link(prefix.join("current")).ok()?;
    let target = target.to_string_lossy().into_owned();
    target
        .split('/')
        .rfind(|s| !s.is_empty())
        .map(str::to_string)
}

/// A database copy the updater keeps, and the release it's for.
fn db_copy_version(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("flytower.db")?;
    let rest = rest
        .strip_prefix("-wal")
        .or_else(|| rest.strip_prefix("-shm"))
        .unwrap_or(rest);
    rest.strip_prefix(".before-").filter(|v| !v.is_empty())
}

/// What `disk.prune-flytower` would remove: releases other than the running one and those in
/// the last update record (the one to go back to), leftover downloads, and database copies
/// kept for releases that are going. With no record, the newest other release is kept.
fn prune_plan(ctx: &Context) -> (Vec<PathBuf>, Vec<String>) {
    let p = Places::of(ctx);
    let Some(current) = current_release(&p.prefix) else {
        return (Vec::new(), Vec::new());
    };
    let dir = p.prefix.join("releases");
    let (entries, _) = names(&dir);
    let installed: Vec<&String> = entries
        .iter()
        .filter(|n| !n.starts_with('.') && dir.join(n).join("VERSION").exists())
        .collect();
    let mut keep: HashSet<String> = HashSet::from([current.clone()]);
    if let Some(record) = read_record(ctx) {
        for v in [record.from, record.to] {
            if installed.iter().any(|i| **i == v) {
                keep.insert(v);
            }
        }
    } else {
        let modified = |n: &str| {
            std::fs::metadata(dir.join(n))
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        };
        if let Some(newest) = installed
            .iter()
            .filter(|n| ***n != current)
            .max_by_key(|n| modified(n))
        {
            keep.insert((*newest).clone());
        }
    }
    let mut paths = Vec::new();
    let mut removed = Vec::new();
    for n in entries {
        if !keep.contains(&n) {
            paths.push(dir.join(&n));
            removed.push(n);
        }
    }
    // Database copies: the agent's own, and any an older updater left beside the database.
    for folder in [db_backups(&p.state), p.data.clone()] {
        for n in names(&folder).0 {
            if db_copy_version(&n).is_some_and(|v| !keep.contains(v)) {
                paths.push(folder.join(&n));
                removed.push(n);
            }
        }
    }
    (paths, removed)
}

/// Where a measured path's bytes go.
enum Label {
    Server(String, &'static str),
    Shared(&'static str),
    System(&'static str),
}

/// Adds the shared folders and the rest of the machine to `paths`, and returns how many
/// folders couldn't be listed.
fn system_places(p: &Places, paths: &mut Vec<PathBuf>, labels: &mut Vec<Label>) -> u64 {
    paths.push(p.imports.clone());
    labels.push(Label::Shared("imports"));
    paths.push(p.archive.clone());
    labels.push(Label::Shared("archive"));
    // Only what's on the servers' disk: a tmpfs /tmp or a separate /var/log isn't it.
    let disk = device_of(&p.servers)
        .or_else(|| device_of(&p.data))
        .or_else(|| device_of(Path::new("/")));
    // Everything measured elsewhere, so Flytower's own folders don't count it twice.
    let elsewhere: HashSet<PathBuf> = [
        &p.servers,
        &p.runtimes,
        &p.backups,
        &p.exports,
        &p.maps,
        &p.imports,
        &p.archive,
    ]
    .iter()
    .map(|x| normal(x))
    .collect();
    let mut part = |path: PathBuf, name: &'static str| {
        if device_of(&path).is_some_and(|d| Some(d) == disk) {
            paths.push(path);
            labels.push(Label::System(name));
        }
    };
    let mut skipped = 0;
    part(p.runtimes.clone(), "java");
    for parent in [&p.prefix, &p.data] {
        let (entries, unreadable) = names(parent);
        skipped += unreadable;
        for n in entries {
            let child = parent.join(n);
            if !elsewhere.contains(&normal(&child)) {
                part(child, "flytower");
            }
        }
    }
    if !elsewhere.contains(&normal(&p.config)) {
        part(p.config.clone(), "flytower");
    }
    // The agent's own folder (database copies, mostly), unless it's inside one walked above.
    let state = normal(&p.state);
    if !state.starts_with(normal(&p.data)) && !state.starts_with(normal(&p.prefix)) {
        part(p.state.clone(), "flytower");
    }
    part(p.var_log.clone(), "logs");
    for t in [&p.apt, &p.tmp, &p.var_tmp] {
        part(t.clone(), "temp");
    }
    skipped
}

/// `disk.usage`.
#[must_use]
pub fn usage(servers: &[String], system: bool, ctx: &Context) -> Value {
    let p = Places::of(ctx);
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut labels: Vec<Label> = Vec::new();
    let mut groups: BTreeMap<String, (BTreeMap<&'static str, u64>, u64)> = BTreeMap::new();

    for server in servers {
        let dir = p.servers.join(server);
        let (entries, unreadable) = names(&dir);
        let level = level_name(&dir);
        groups.insert(
            server.clone(),
            (GROUPS.iter().map(|g| (*g, 0)).collect(), unreadable),
        );
        for n in entries {
            let group = group_of(&n, level.as_deref());
            paths.push(dir.join(&n));
            labels.push(Label::Server(server.clone(), group));
        }
        for (group, base) in [
            ("backups", p.backups.clone()),
            ("exports", p.exports.clone()),
            ("map", p.maps.join("servers")),
        ] {
            paths.push(base.join(server));
            labels.push(Label::Server(server.clone(), group));
        }
    }

    let skipped = if system {
        system_places(&p, &mut paths, &mut labels)
    } else {
        0
    };

    let measured = walk(&paths);
    let mut shared: BTreeMap<&str, u64> = BTreeMap::new();
    let mut shared_unreadable = 0;
    let mut parts: BTreeMap<&str, u64> = BTreeMap::new();
    let mut parts_unreadable = skipped;
    for (label, m) in labels.iter().zip(&measured) {
        match label {
            Label::Server(server, group) => {
                if let Some((g, unreadable)) = groups.get_mut(server) {
                    *g.entry(group).or_default() += m.bytes;
                    *unreadable += m.unreadable;
                }
            }
            Label::Shared(name) => {
                *shared.entry(name).or_default() += m.bytes;
                shared_unreadable += m.unreadable;
            }
            Label::System(name) => {
                *parts.entry(name).or_default() += m.bytes;
                parts_unreadable += m.unreadable;
            }
        }
    }

    let servers: serde_json::Map<String, Value> = groups
        .into_iter()
        .map(|(server, (g, unreadable))| {
            let g: serde_json::Map<String, Value> = GROUPS
                .iter()
                .map(|k| ((*k).to_string(), json!(g[k])))
                .collect();
            (server, json!({ "groups": g, "unreadable": unreadable }))
        })
        .collect();
    if !system {
        return json!({ "servers": servers, "shared": null, "system": null });
    }

    // What each clean-up would free, in walks of their own (these overlap the parts above).
    let (old, _) = prune_plan(ctx);
    let get = |m: &BTreeMap<&str, u64>, k: &str| m.get(k).copied().unwrap_or(0);
    json!({
        "servers": servers,
        "shared": {
            "imports": get(&shared, "imports"),
            "archive": get(&shared, "archive"),
            "unreadable": shared_unreadable,
        },
        "system": {
            "java": get(&parts, "java"),
            "flytower": get(&parts, "flytower"),
            "logs": get(&parts, "logs"),
            "temp": get(&parts, "temp"),
            "unreadable": parts_unreadable,
            "journal": sum(&walk(std::slice::from_ref(&p.journal))),
            "aptCache": sum(&walk(&p.apt_cache())),
            "oldReleases": sum(&walk(&old)),
        },
    })
}

/// Runs a clean-up command and says how much less `measured` takes afterwards.
fn freed_by(
    ctx: &Context,
    measured: &[PathBuf],
    file: &str,
    args: &[&str],
    missing: &str,
    failed: &str,
) -> Result<Value, AgentError> {
    let before = sum(&walk(measured));
    let r = ctx.exec.run(file, args);
    if r.code == 127 {
        return Err(AgentError::new(ErrorCode::NotFound, missing));
    }
    if r.code != 0 {
        let why = if r.stderr.trim().is_empty() {
            r.code.to_string()
        } else {
            r.stderr.trim().to_string()
        };
        return Err(AgentError::new(
            ErrorCode::Failed,
            format!("{failed}: {why}"),
        ));
    }
    let after = sum(&walk(measured));
    Ok(json!({ "freedBytes": before.saturating_sub(after) }))
}

/// `disk.vacuum-journal`.
///
/// # Errors
/// When journalctl isn't there or fails.
pub fn vacuum_journal(max_mb: i64, ctx: &Context) -> Result<Value, AgentError> {
    let p = Places::of(ctx);
    let arg = format!("--vacuum-size={max_mb}M");
    freed_by(
        ctx,
        &[p.journal],
        "journalctl",
        &[&arg],
        "journalctl isn't on this machine",
        "couldn't shrink the journal",
    )
}

/// `disk.clean-apt`.
///
/// # Errors
/// When apt isn't there or fails.
pub fn clean_apt(ctx: &Context) -> Result<Value, AgentError> {
    freed_by(
        ctx,
        &Places::of(ctx).apt_cache(),
        "apt-get",
        &["clean"],
        "apt isn't on this machine",
        "apt-get clean failed",
    )
}

/// `disk.prune-flytower`.
///
/// # Errors
/// While an update runs, or when something can't be removed.
pub fn prune_flytower(ctx: &Context) -> Result<Value, AgentError> {
    let _lock = exclusively(ctx)?;
    busy(ctx)?;
    let (paths, removed) = prune_plan(ctx);
    let freed = sum(&walk(&paths));
    for path in &paths {
        remove(path)?;
    }
    Ok(json!({ "freedBytes": freed, "removed": removed }))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::exec::ExecResult;
    use crate::handlers::testing::{Fake, TempRoot};

    const KB: usize = 1024;

    fn file(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![1u8; bytes]).unwrap();
    }

    /// A made-up box with something in every place measured.
    fn machine(label: &str) -> TempRoot {
        let root = TempRoot::new(label);
        let p = &root.paths;
        let srv = Path::new(&p.servers).join("survival");
        file(&srv.join("server.properties"), 0);
        fs::write(
            srv.join("server.properties"),
            "# made by Flytower\nlevel-name=realm\n",
        )
        .unwrap();
        file(&srv.join("realm/level.dat"), 64 * KB);
        file(&srv.join("logs/latest.log"), 8 * KB);
        file(&srv.join("mods/lithium.jar"), 32 * KB);
        file(&srv.join("server.jar"), 16 * KB);
        symlink("/etc", srv.join("escape")).unwrap();
        let data = Path::new(&p.panel_data);
        file(&data.join("backups/survival/one.zip"), 128 * KB);
        fs::hard_link(
            srv.join("realm/level.dat"),
            data.join("backups/survival/level.dat"),
        )
        .unwrap();
        file(&data.join("imports/upload.zip"), 8 * KB);
        for f in [
            "flytower.db",
            "flytower.db.before-1.1.0",
            "flytower.db.before-1.0.0",
        ] {
            file(&data.join(f), 40 * KB);
        }
        // The data folder's copies were left by an updater from before they moved to the
        // agent's own folder.
        let backups = db_backups(Path::new(&p.state));
        file(&backups.join("flytower.db.before-1.1.0"), 40 * KB);
        file(&backups.join("flytower.db-wal.before-1.0.0"), 8 * KB);
        file(&Path::new(&p.runtimes).join("temurin-21/bin/java"), 96 * KB);
        let prefix = Path::new(&p.prefix);
        for v in ["1.0.0", "1.1.0", "1.2.0"] {
            file(&prefix.join("releases").join(v).join("VERSION"), 16);
            file(&prefix.join("releases").join(v).join("bin/bun"), 48 * KB);
        }
        file(&prefix.join("releases/.download-1.3.0/part"), 8 * KB);
        symlink(prefix.join("releases/1.2.0"), prefix.join("current")).unwrap();
        file(&Path::new(&p.config).join("agent.env"), KB);
        let sys = Path::new(&p.system);
        file(&sys.join("var/log/journal/system.journal"), 72 * KB);
        file(&sys.join("var/log/syslog"), 8 * KB);
        file(&sys.join("var/cache/apt/archives/a.deb"), 24 * KB);
        file(&sys.join("var/cache/apt/pkgcache.bin"), 8 * KB);
        file(&sys.join("tmp/scratch"), 8 * KB);
        root
    }

    fn record(root: &TempRoot, state: &str, from: &str, to: &str) {
        let dir = Path::new(&root.paths.state);
        fs::create_dir_all(dir).unwrap();
        let at = crate::time::iso(SystemTime::now());
        fs::write(
            dir.join("update.json"),
            json!({ "state": state, "from": from, "to": to, "reason": null, "at": at, "manual": false })
                .to_string(),
        )
        .unwrap();
    }

    fn size(paths: &[PathBuf]) -> u64 {
        sum(&walk(paths))
    }

    #[test]
    fn groups_match_the_shared_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../protocol/fixtures/disk-groups.jsonl");
        let text = fs::read_to_string(path).unwrap();
        let mut count = 0;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let f: Value = serde_json::from_str(line).unwrap();
            let got = group_of(f["entry"].as_str().unwrap(), f["levelName"].as_str());
            assert_eq!(got, f["group"].as_str().unwrap(), "{line}");
            count += 1;
        }
        assert!(count > 0);
    }

    #[test]
    fn splits_a_server_by_group_without_following_symlinks() {
        let root = machine("disk-server");
        let ctx = Fake::default().context(&root.paths);
        let srv = Path::new(&root.paths.servers).join("survival");
        let r = usage(&["survival".into()], false, &ctx);
        let g = &r["servers"]["survival"]["groups"];
        assert_eq!(g["world"], json!(size(&[srv.join("realm")])));
        assert_eq!(g["logs"], json!(size(&[srv.join("logs")])));
        assert_eq!(g["content"], json!(size(&[srv.join("mods")])));
        assert_eq!(
            g["other"],
            json!(size(&[
                srv.join("server.jar"),
                srv.join("server.properties")
            ]))
        );
        let backups = Path::new(&root.paths.panel_data).join("backups/survival");
        assert_eq!(
            g["backups"],
            json!(size(&[backups]) - size(&[srv.join("realm/level.dat")]))
        );
        assert_eq!(g["exports"], json!(0));
        assert_eq!(r["shared"], Value::Null);
        assert_eq!(r["system"], Value::Null);
        assert!(crate::verbs::check_result("disk.usage", &r).is_ok());
    }

    #[test]
    fn measures_the_rest_of_the_machine_in_parts() {
        let root = machine("disk-system");
        record(&root, "succeeded", "1.1.0", "1.2.0");
        let ctx = Fake::default().context(&root.paths);
        let p = &root.paths;
        let sys = Path::new(&p.system);
        let data = Path::new(&p.panel_data);
        let prefix = Path::new(&p.prefix);
        let r = usage(&[], true, &ctx);
        assert!(crate::verbs::check_result("disk.usage", &r).is_ok());
        let s = &r["system"];
        assert_eq!(r["shared"]["imports"], json!(size(&[data.join("imports")])));
        assert_eq!(s["java"], json!(size(&[p.runtimes.clone().into()])));
        assert_eq!(s["logs"], json!(size(&[sys.join("var/log")])));
        assert_eq!(
            s["temp"],
            json!(size(&[sys.join("var/cache/apt"), sys.join("tmp")]))
        );
        assert_eq!(s["journal"], json!(size(&[sys.join("var/log/journal")])));
        assert_eq!(
            s["aptCache"],
            json!(size(&[
                sys.join("var/cache/apt/archives"),
                sys.join("var/cache/apt/pkgcache.bin")
            ]))
        );
        assert_eq!(
            s["oldReleases"],
            json!(size(&[
                prefix.join("releases/1.0.0"),
                prefix.join("releases/.download-1.3.0"),
                db_backups(Path::new(&p.state)).join("flytower.db-wal.before-1.0.0"),
                data.join("flytower.db.before-1.0.0"),
            ]))
        );
        // The prefix (runtimes sit beside it here), the config, the agent's own folder, and
        // the data folder without the servers' backups, imports and archive.
        let flytower = size(&[prefix.join("releases")])
            + size(&[
                data.join("flytower.db"),
                data.join("flytower.db.before-1.1.0"),
                data.join("flytower.db.before-1.0.0"),
            ])
            + size(&[p.config.clone().into()])
            + size(&[p.state.clone().into()]);
        assert_eq!(s["flytower"], json!(flytower));
    }

    #[test]
    fn vacuums_the_journal_and_says_what_it_freed() {
        let root = machine("disk-journal");
        let journal = Path::new(&root.paths.system).join("var/log/journal/system.journal");
        let before = size(std::slice::from_ref(&journal));
        // The fake can't shrink anything, so empty the journal first and check the command.
        let fake = Fake::default();
        let ctx = fake.context(&root.paths);
        fs::write(&journal, "").unwrap();
        assert_eq!(
            vacuum_journal(200, &ctx).unwrap(),
            json!({ "freedBytes": 0 })
        );
        assert_eq!(fake.ran(), vec!["journalctl --vacuum-size=200M"]);
        assert!(before > 0);

        let broken = Fake::new(vec![(
            "journalctl",
            ExecResult {
                code: 1,
                stdout: String::new(),
                stderr: "no journal".into(),
            },
        )]);
        let err = vacuum_journal(200, &broken.context(&root.paths)).unwrap_err();
        assert!(err.message.contains("no journal"), "{}", err.message);
    }

    #[test]
    fn cleans_apt_or_says_there_is_none() {
        let root = machine("disk-apt");
        let fake = Fake::default();
        assert_eq!(
            clean_apt(&fake.context(&root.paths)).unwrap(),
            json!({ "freedBytes": 0 })
        );
        assert_eq!(fake.ran(), vec!["apt-get clean"]);
        let none = Fake::new(vec![(
            "apt-get",
            ExecResult {
                code: 127,
                ..Default::default()
            },
        )]);
        let err = clean_apt(&none.context(&root.paths)).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn prunes_all_but_the_running_release_and_the_one_to_go_back_to() {
        let root = machine("disk-prune");
        record(&root, "succeeded", "1.1.0", "1.2.0");
        let prefix = Path::new(&root.paths.prefix);
        let data = Path::new(&root.paths.panel_data);
        let backups = db_backups(Path::new(&root.paths.state));
        let expected = size(&[
            prefix.join("releases/1.0.0"),
            prefix.join("releases/.download-1.3.0"),
            backups.join("flytower.db-wal.before-1.0.0"),
            data.join("flytower.db.before-1.0.0"),
        ]);
        let r = prune_flytower(&Fake::default().context(&root.paths)).unwrap();
        assert_eq!(
            r,
            json!({
                "freedBytes": expected,
                "removed": [
                    ".download-1.3.0",
                    "1.0.0",
                    "flytower.db-wal.before-1.0.0",
                    "flytower.db.before-1.0.0",
                ],
            })
        );
        assert!(backups.join("flytower.db.before-1.1.0").exists());
        assert!(!prefix.join("releases/1.0.0").exists());
        assert!(prefix.join("releases/1.1.0").exists());
        assert!(prefix.join("releases/1.2.0").exists());
        assert!(data.join("flytower.db.before-1.1.0").exists());
        assert!(data.join("flytower.db").exists());
    }

    #[test]
    fn refuses_to_prune_during_an_update() {
        let root = machine("disk-busy");
        record(&root, "running", "1.1.0", "1.2.0");
        let err = prune_flytower(&Fake::default().context(&root.paths)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(
            Path::new(&root.paths.prefix)
                .join("releases/1.0.0")
                .exists()
        );
    }

    #[test]
    fn prunes_nothing_when_the_running_release_is_unknown() {
        let root = machine("disk-unknown");
        let mut paths = root.paths.clone();
        paths.prefix = format!("{}-elsewhere", paths.prefix);
        let r = prune_flytower(&Fake::default().context(&paths)).unwrap();
        assert_eq!(r, json!({ "freedBytes": 0, "removed": [] }));
    }
}
