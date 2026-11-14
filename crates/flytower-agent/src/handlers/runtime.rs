//! Installing Java: Eclipse Temurin from the
//! Adoptium API (not apt), checked against the SHA-256 it publishes, unpacked into a staging
//! folder and renamed into place, so a half-finished install is never visible.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};

use super::Context;
use super::files::{mkdir, read, remove, write};
use crate::envelope::{AgentError, ErrorCode};
use crate::fetch::download_verified;

const ADOPTIUM: &str = "https://api.adoptium.net/v3/assets/latest";
const MARKER: &str = ".flytower-runtime.json";

fn adoptium_arch(arch: &str) -> Result<&'static str, AgentError> {
    match arch {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("aarch64"),
        other => Err(AgentError::new(
            ErrorCode::Failed,
            format!("unsupported CPU architecture {other}"),
        )),
    }
}

struct Asset {
    link: String,
    checksum: String,
    version: String,
}

fn latest_asset(ctx: &Context, major: i64) -> Result<Asset, AgentError> {
    let arch = adoptium_arch(&ctx.arch)?;
    // Prefer the smaller JRE; some releases only publish a JDK.
    for image in ["jre", "jdk"] {
        let url = format!(
            "{ADOPTIUM}/{major}/hotspot?architecture={arch}&image_type={image}&os=linux&vendor=eclipse"
        );
        let body = ctx
            .fetch
            .text(&url)
            .map_err(|e| AgentError::new(ErrorCode::Failed, format!("GET {url} failed: {e}")))?;
        let assets: Value = serde_json::from_str(&body).map_err(|_| {
            AgentError::new(ErrorCode::Failed, format!("GET {url} didn't return JSON"))
        })?;
        let found = assets.as_array().into_iter().flatten().find_map(|a| {
            let package = a.get("binary")?.get("package")?;
            let link = package.get("link")?.as_str()?;
            if !link.ends_with(".tar.gz") {
                return None;
            }
            Some(Asset {
                link: link.to_string(),
                checksum: package
                    .get("checksum")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                version: a.get("version")?.get("semver")?.as_str()?.to_string(),
            })
        });
        if let Some(asset) = found {
            return Ok(asset);
        }
    }
    Err(AgentError::new(
        ErrorCode::NotFound,
        format!("no Temurin {major} build for {arch}"),
    ))
}

fn unpack(ctx: &Context, asset: &Asset, archive: &Path, staging: &Path) -> Result<(), AgentError> {
    remove(staging)?;
    mkdir(staging, 0o755)?;
    download_verified(ctx.fetch.as_ref(), &asset.link, archive, &asset.checksum)?;
    let (archive, staging_s) = (archive.to_string_lossy(), staging.to_string_lossy());
    let tar = ctx.exec.run(
        "tar",
        &[
            "-xzf",
            &archive,
            "-C",
            &staging_s,
            "--strip-components=1",
            "--no-same-owner",
        ],
    );
    if tar.code != 0 {
        return Err(AgentError::new(
            ErrorCode::Failed,
            format!("could not unpack Java: {}", tar.stderr.trim()),
        ));
    }
    if !staging.join("bin").join("java").exists() {
        return Err(AgentError::new(
            ErrorCode::Failed,
            "unpacked Java has no bin/java",
        ));
    }
    let marker = json!({ "vendor": "temurin", "version": asset.version }).to_string();
    write(&staging.join(MARKER), &marker, 0o666)
}

/// One lock per Java version, so two installs of the same one (two servers created at once)
/// take turns: the second then finds the first's runtime and answers `alreadyInstalled`.
fn lock_for(major: i64) -> Arc<Mutex<()>> {
    static LOCKS: Mutex<BTreeMap<i64, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());
    let mut locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(locks.entry(major).or_default())
}

/// Every install gets its own staging folder, even within one process.
fn staging_suffix() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// `runtime.install`. Idempotent: an installed runtime answers `alreadyInstalled`.
///
/// # Errors
/// `not_found` with no build for this machine, `failed` if a step fails.
pub fn install(major: i64, ctx: &Context) -> Result<Value, AgentError> {
    let lock = lock_for(major);
    let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
    let java_home = Path::new(&ctx.paths.runtimes).join(format!("temurin-{major}"));
    let home = java_home.to_string_lossy().into_owned();
    if let Some(marker) = read(&java_home.join(MARKER)) {
        let version = serde_json::from_str::<Value>(&marker)
            .ok()
            .and_then(|m| m.get("version")?.as_str().map(str::to_string))
            .unwrap_or_default();
        return Ok(json!({ "javaHome": home, "version": version, "alreadyInstalled": true }));
    }

    let asset = latest_asset(ctx, major)?;
    mkdir(Path::new(&ctx.paths.runtimes), 0o755)?;
    let staging = PathBuf::from(format!("{home}.staging-{}", staging_suffix()));
    let archive = PathBuf::from(format!("{}.tar.gz", staging.display()));
    let result = unpack(ctx, &asset, &archive, &staging).and_then(|()| {
        remove(&java_home)?;
        std::fs::rename(&staging, &java_home).map_err(|e| {
            AgentError::new(
                ErrorCode::Failed,
                format!("can't move Java into place: {e}"),
            )
        })
    });
    // Whatever happened, leave nothing half-done behind.
    let _ = remove(&archive);
    let _ = remove(&staging);
    result?;
    Ok(json!({ "javaHome": home, "version": asset.version, "alreadyInstalled": false }))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::exec::RealExec;
    use crate::fetch::{Fetch, sha256_file};
    use crate::handlers::testing::{Fake, TempRoot};

    /// Serves text and files from tables, and records what was asked for.
    #[derive(Default)]
    struct Web {
        text: BTreeMap<String, String>,
        files: BTreeMap<String, PathBuf>,
        seen: Mutex<Vec<String>>,
    }

    impl Fetch for Web {
        fn text(&self, url: &str) -> Result<String, String> {
            self.seen.lock().unwrap().push(url.into());
            let hit = self.text.iter().find(|(k, _)| url.starts_with(k.as_str()));
            hit.map(|(_, v)| v.clone()).ok_or_else(|| "404".into())
        }
        fn save(&self, url: &str, dest: &Path) -> Result<(), String> {
            self.seen.lock().unwrap().push(url.into());
            let src = self.files.get(url).ok_or("404")?;
            std::fs::copy(src, dest)
                .map(drop)
                .map_err(|e| e.to_string())
        }
    }

    fn setup(checksum: Option<&str>) -> (TempRoot, Context, Arc<Web>) {
        let root = TempRoot::new("runtime");
        let src = Path::new(&root.paths.state).join("src/jdk-25.0.1+8-jre/bin");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("java"), "#!/bin/sh\n").unwrap();
        let tarball = Path::new(&root.paths.state).join("jre.tar.gz");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(Path::new(&root.paths.state).join("src"))
            .arg("jdk-25.0.1+8-jre")
            .status()
            .unwrap();
        assert!(status.success());
        let sha = checksum.map_or_else(|| sha256_file(&tarball).unwrap(), str::to_string);
        let listing = json!([{
            "binary": { "package": { "link": "https://dl.example/jre.tar.gz", "checksum": sha, "name": "jre.tar.gz" } },
            "version": { "semver": "25.0.1+8" },
        }]);
        let web = Arc::new(Web {
            text: [("https://api.adoptium.net/".to_string(), listing.to_string())].into(),
            files: [("https://dl.example/jre.tar.gz".to_string(), tarball)].into(),
            seen: Mutex::default(),
        });
        let mut ctx = Fake::new(vec![]).context(&root.paths);
        ctx.exec = Arc::new(RealExec::default());
        ctx.fetch = Arc::clone(&web) as Arc<dyn Fetch>;
        ctx.arch = "x86_64".into();
        (root, ctx, web)
    }

    #[test]
    fn downloads_verifies_and_unpacks_then_is_idempotent() {
        let (root, ctx, web) = setup(None);
        let home = format!("{}/temurin-25", root.paths.runtimes);
        let first = install(25, &ctx).unwrap();
        assert_eq!(
            first,
            json!({ "javaHome": home, "version": "25.0.1+8", "alreadyInstalled": false })
        );
        assert!(crate::verbs::check_result("runtime.install", &first).is_ok());
        assert!(Path::new(&home).join("bin/java").exists());
        let seen = web.seen.lock().unwrap().clone();
        assert!(
            seen[0].contains("/25/hotspot?architecture=x64&image_type=jre&os=linux&vendor=eclipse")
        );
        let second = install(25, &ctx).unwrap();
        assert_eq!(second["alreadyInstalled"], true);
        assert_eq!(second["version"], "25.0.1+8");
        // Nothing left over beside the runtime.
        let names: Vec<String> = std::fs::read_dir(&root.paths.runtimes)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["temurin-25"]);
    }

    #[test]
    fn two_installs_of_one_version_at_once_take_turns() {
        let (root, ctx, web) = setup(None);
        let results: Vec<Value> = std::thread::scope(|s| {
            let a = s.spawn(|| install(25, &ctx).unwrap());
            let b = s.spawn(|| install(25, &ctx).unwrap());
            vec![a.join().unwrap(), b.join().unwrap()]
        });
        let fresh = results
            .iter()
            .filter(|r| r["alreadyInstalled"] == false)
            .count();
        assert_eq!(fresh, 1, "{results:?}");
        let downloads = web
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|u| u.ends_with(".tar.gz"))
            .count();
        assert_eq!(downloads, 1);
        let names: Vec<String> = std::fs::read_dir(&root.paths.runtimes)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["temurin-25"]);
    }

    #[test]
    fn staging_folders_differ_per_call() {
        assert_ne!(staging_suffix(), staging_suffix());
    }

    #[test]
    fn refuses_a_bad_checksum_and_leaves_nothing_behind() {
        let (root, ctx, _) = setup(Some(&"a".repeat(64)));
        let err = install(25, &ctx).unwrap_err();
        assert_eq!(err.code, ErrorCode::Failed);
        assert!(err.message.contains("checksum mismatch"), "{}", err.message);
        let left: Vec<_> = std::fs::read_dir(&root.paths.runtimes).unwrap().collect();
        assert!(left.is_empty());
    }

    #[test]
    fn refuses_a_missing_checksum_and_unknown_machines() {
        let (_root, ctx, _) = setup(Some(""));
        assert!(
            install(25, &ctx)
                .unwrap_err()
                .message
                .contains("no usable checksum")
        );
        let (_root, mut ctx, _) = setup(None);
        ctx.arch = "riscv64".into();
        assert!(install(25, &ctx).unwrap_err().message.contains("riscv64"));
    }
}
