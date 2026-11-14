//! Creating, changing and removing the OS side of a server.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{Value, json};

use super::Context;
use super::files::{mkdir, read, remove as rm, write};
use super::service::unit_name;
use crate::envelope::{AgentError, ErrorCode};
use crate::folders::archive_dir;
use crate::units::{env_file, limits_drop_in, template_unit};

/// The Linux user that owns and runs a server.
#[must_use]
pub fn user_name(server: &str) -> String {
    format!("mc-{server}")
}

/// ufw rules are tagged so delete can find exactly the rule create added.
#[must_use]
pub fn ufw_comment(server: &str) -> String {
    format!("flytower server {server}")
}

pub(crate) fn run(ctx: &Context, file: &str, args: &[&str]) -> Result<String, AgentError> {
    let r = ctx.exec.run(file, args);
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

fn user_exists(ctx: &Context, user: &str) -> bool {
    ctx.exec.run("id", &["-u", user]).code == 0
}

struct Files {
    dir: PathBuf,
    env: PathBuf,
    drop_in_dir: PathBuf,
    template: PathBuf,
}

fn files(ctx: &Context, name: &str) -> Files {
    let systemd = Path::new(&ctx.paths.systemd);
    Files {
        dir: Path::new(&ctx.paths.servers).join(name),
        env: Path::new(&ctx.paths.config)
            .join("servers")
            .join(format!("{name}.env")),
        drop_in_dir: systemd.join(format!("{}.d", unit_name(name))),
        template: systemd.join("flytower-mc@.service"),
    }
}

fn str(p: &Path) -> &str {
    p.to_str().unwrap_or_default()
}

fn java_home(ctx: &Context, major: i64) -> Result<PathBuf, AgentError> {
    let home = Path::new(&ctx.paths.runtimes).join(format!("temurin-{major}"));
    if home.join("bin").join("java").exists() {
        Ok(home)
    } else {
        Err(AgentError::new(
            ErrorCode::Failed,
            format!("Java {major} is not installed; run runtime.install first"),
        ))
    }
}

/// Brings the systemd template up to date when the agent starts, so servers made by an older
/// version pick up changes. Only if a server exists (the template does) and it differs.
/// `daemon-reload` doesn't restart running servers.
///
/// # Errors
/// If the template can't be written or systemd can't reload.
pub fn refresh_template(ctx: &Context) -> Result<bool, AgentError> {
    let file = Path::new(&ctx.paths.systemd).join("flytower-mc@.service");
    let wanted = template_unit(&ctx.paths, &ctx.panel_group);
    match read(&file) {
        None => Ok(false),
        Some(current) if current == wanted => Ok(false),
        Some(_) => {
            write(&file, &wanted, 0o644)?;
            run(ctx, "systemctl", &["daemon-reload"])?;
            Ok(true)
        }
    }
}

/// `server.create`: its user, its folder (owned by the server, group = the panel, setgid so
/// files stay manageable), its environment file, memory limits and a firewall rule. It doesn't
/// download Minecraft; the panel writes the jar into the folder.
///
/// # Errors
/// `conflict` if it exists, `failed` if Java is missing or a step fails.
pub fn create(
    name: &str,
    port: i64,
    memory_mb: i64,
    java_major: i64,
    ctx: &Context,
) -> Result<Value, AgentError> {
    let user = user_name(name);
    let f = files(ctx, name);
    if f.dir.exists() || user_exists(ctx, &user) {
        return Err(AgentError::new(
            ErrorCode::Conflict,
            format!("a server called {name} already exists"),
        ));
    }
    let java = java_home(ctx, java_major)?;
    let dir = str(&f.dir);
    run(
        ctx,
        "useradd",
        &[
            "--system",
            "--home-dir",
            dir,
            "--no-create-home",
            "--shell",
            "/usr/sbin/nologin",
            "--user-group",
            &user,
        ],
    )?;
    mkdir(&f.dir, 0o777)?;
    run(ctx, "chown", &[&format!("{user}:{}", ctx.panel_group), dir])?;
    run(ctx, "chmod", &["2770", dir])?;

    mkdir(&Path::new(&ctx.paths.config).join("servers"), 0o755)?;
    write(&f.env, &env_file(str(&java), memory_mb), 0o644)?;
    mkdir(&f.drop_in_dir, 0o755)?;
    write(
        &f.template,
        &template_unit(&ctx.paths, &ctx.panel_group),
        0o644,
    )?;
    write(
        &f.drop_in_dir.join("limits.conf"),
        &limits_drop_in(memory_mb),
        0o644,
    )?;
    let unit = unit_name(name);
    run(ctx, "systemctl", &["daemon-reload"])?;
    run(ctx, "systemctl", &["enable", &unit])?;
    run(
        ctx,
        "ufw",
        &[
            "allow",
            &format!("{port}/tcp"),
            "comment",
            &ufw_comment(name),
        ],
    )?;

    Ok(json!({ "directory": dir, "user": user, "unit": unit }))
}

fn env_value<'a>(env: &'a str, key: &str) -> Option<&'a str> {
    env.lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
}

fn swap_firewall_rule(name: &str, port: i64, ctx: &Context) -> Result<(), AgentError> {
    let status = ctx.exec.run("ufw", &["status", "numbered"]);
    for n in ufw_rule_numbers(&status.stdout, name) {
        run(ctx, "ufw", &["--force", "delete", &n.to_string()])?;
    }
    run(
        ctx,
        "ufw",
        &[
            "allow",
            &format!("{port}/tcp"),
            "comment",
            &ufw_comment(name),
        ],
    )?;
    Ok(())
}

/// `server.expose`: opens the server's own port in the firewall, or closes it when players
/// reach the server through the hostname router instead.
///
/// # Errors
/// `not_found` for an unknown server, `failed` if ufw fails.
pub fn expose(name: &str, port: i64, public: bool, ctx: &Context) -> Result<Value, AgentError> {
    if !files(ctx, name).env.exists() {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            format!("no server called {name}"),
        ));
    }
    if public {
        swap_firewall_rule(name, port, ctx)?;
    } else {
        let status = ctx.exec.run("ufw", &["status", "numbered"]);
        for n in ufw_rule_numbers(&status.stdout, name) {
            run(ctx, "ufw", &["--force", "delete", &n.to_string()])?;
        }
    }
    Ok(json!({}))
}

/// `server.configure`: memory and Java rewrite the env file (memory also the `MemoryMax`
/// drop-in); port swaps the firewall rule. All take effect on the next restart.
///
/// # Errors
/// `not_found` for an unknown server, `failed` if Java is missing or a step fails.
pub fn configure(
    name: &str,
    memory_mb: Option<i64>,
    port: Option<i64>,
    java_major: Option<i64>,
    ctx: &Context,
) -> Result<Value, AgentError> {
    let f = files(ctx, name);
    if !f.env.exists() {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            format!("no server called {name}"),
        ));
    }
    if memory_mb.is_some() || java_major.is_some() {
        let env = read(&f.env).unwrap_or_default();
        let java = match java_major {
            Some(major) => Some(str(&java_home(ctx, major)?).to_string()),
            // An empty `JAVA_HOME=` counts as none.
            None => env_value(&env, "JAVA_HOME")
                .filter(|v| !v.is_empty())
                .map(str::to_string),
        };
        let heap = memory_mb.or_else(|| {
            env_value(&env, "HEAP_MB")
                .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|v| v.parse().ok())
        });
        let env_path = f.env.display();
        let java = java.ok_or_else(|| {
            AgentError::new(ErrorCode::Failed, format!("{env_path} has no JAVA_HOME"))
        })?;
        let heap = heap.filter(|h| *h != 0).ok_or_else(|| {
            AgentError::new(ErrorCode::Failed, format!("{env_path} has no HEAP_MB"))
        })?;
        write(&f.env, &env_file(&java, heap), 0o644)?;
        if let Some(memory_mb) = memory_mb {
            mkdir(&f.drop_in_dir, 0o755)?;
            write(
                &f.drop_in_dir.join("limits.conf"),
                &limits_drop_in(memory_mb),
                0o644,
            )?;
            run(ctx, "systemctl", &["daemon-reload"])?;
        }
    }
    if let Some(port) = port {
        swap_firewall_rule(name, port, ctx)?;
    }
    Ok(json!({}))
}

/// `server.permissions`: restores group access across a server folder (the owner stays the
/// server's user). Symlinks aren't followed.
///
/// # Errors
/// `not_found` for an unknown server, `failed` if chgrp or chmod fail.
pub fn permissions(name: &str, ctx: &Context) -> Result<Value, AgentError> {
    let f = files(ctx, name);
    if !f.dir.exists() {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            format!("no server called {name}"),
        ));
    }
    let dir = str(&f.dir);
    run(
        ctx,
        "chgrp",
        &["-R", "--no-dereference", &ctx.panel_group, dir],
    )?;
    run(ctx, "chmod", &["-R", "g+rwX,o-rwx", dir])?;
    Ok(json!({}))
}

/// Rule numbers tagged for this server, highest first so deleting one doesn't renumber the
/// rest. Lines look like `[ 2] 25565/tcp  ALLOW IN  Anywhere  # flytower server survival`.
#[must_use]
pub fn ufw_rule_numbers(status_numbered: &str, name: &str) -> Vec<u32> {
    ufw_rules_tagged(status_numbered, &ufw_comment(name))
}

/// Rule numbers whose comment is exactly `wanted`, highest first.
#[must_use]
pub fn ufw_rules_tagged(status_numbered: &str, wanted: &str) -> Vec<u32> {
    let mut numbers: Vec<u32> = status_numbered
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix('[')?;
            let (number, rest) = rest.split_once(']')?;
            let (_, comment) = rest.rsplit_once("# ")?;
            (comment.trim() == wanted)
                .then(|| number.trim().parse().ok())
                .flatten()
        })
        .collect();
    numbers.sort_unstable_by(|a, b| b.cmp(a));
    numbers
}

/// `server.delete`. The folder is archived to a tarball first, so a mistaken delete can be
/// undone by hand; the panel prunes old archives.
///
/// # Errors
/// `not_found` for an unknown server, `failed` if a step fails.
pub fn remove(name: &str, ctx: &Context) -> Result<Value, AgentError> {
    let user = user_name(name);
    let f = files(ctx, name);
    if !f.dir.exists() && !user_exists(ctx, &user) {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            format!("no server called {name}"),
        ));
    }
    ctx.exec
        .run("systemctl", &["disable", "--now", &unit_name(name)]);

    let archived_to = if f.dir.exists() {
        // Readable by the panel's group, so a deleted server can be imported again. Only root
        // can change the folder, so the tarball's path can't be swapped for a link.
        let archive = archive_dir(ctx)?;
        let stamp = crate::time::iso(SystemTime::now()).replace([':', '.'], "-");
        let tarball = archive.join(format!("{name}-{stamp}.tar.gz"));
        let to = str(&tarball);
        run(ctx, "tar", &["-czf", to, "-C", &ctx.paths.servers, name])?;
        run(ctx, "chgrp", &[&ctx.panel_group, to])?;
        run(ctx, "chmod", &["0640", to])?;
        rm(&f.dir)?;
        Some(to.to_string())
    } else {
        None
    };

    let status = ctx.exec.run("ufw", &["status", "numbered"]);
    for n in ufw_rule_numbers(&status.stdout, name) {
        run(ctx, "ufw", &["--force", "delete", &n.to_string()])?;
    }
    rm(&f.env)?;
    rm(&f.drop_in_dir)?;
    if user_exists(ctx, &user) {
        run(ctx, "userdel", &[&user])?;
    }
    run(ctx, "systemctl", &["daemon-reload"])?;
    Ok(json!({ "archivedTo": archived_to }))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::handlers::testing::{Fake, TempRoot, out};

    struct Setup {
        root: TempRoot,
        fake: Fake,
    }

    impl Setup {
        fn new(answers: Vec<(&str, crate::exec::ExecResult)>) -> Self {
            let root = TempRoot::new("server");
            let java = Path::new(&root.paths.runtimes).join("temurin-25/bin");
            fs::create_dir_all(&java).unwrap();
            fs::write(java.join("java"), "").unwrap();
            Self {
                fake: Fake::new(answers),
                root,
            }
        }
        fn ctx(&self) -> Context {
            self.fake.context(&self.root.paths)
        }
        fn path(&self, p: &str) -> PathBuf {
            Path::new(&self.root.paths.servers)
                .parent()
                .unwrap()
                .join(p)
        }
    }

    fn absent() -> crate::exec::ExecResult {
        crate::exec::ExecResult {
            code: 1,
            ..Default::default()
        }
    }

    #[test]
    fn creates_user_folder_env_limits_unit_and_firewall_rule() {
        let s = Setup::new(vec![("id -u mc-survival", absent())]);
        let r = create("survival", 25565, 6144, 25, &s.ctx()).unwrap();
        assert_eq!(r["user"], "mc-survival");
        assert!(crate::verbs::check_result("server.create", &r).is_ok());
        let dir = s.path("servers/survival");
        let cmds = s.fake.ran();
        assert!(cmds.contains(&format!("useradd --system --home-dir {} --no-create-home --shell /usr/sbin/nologin --user-group mc-survival", dir.display())));
        assert!(cmds.contains(&format!("chown mc-survival:flytower {}", dir.display())));
        assert!(cmds.contains(&format!("chmod 2770 {}", dir.display())));
        assert!(cmds.contains(&"ufw allow 25565/tcp comment flytower server survival".to_string()));
        let at = |c: &str| cmds.iter().position(|x| x == c).unwrap();
        assert!(
            at("systemctl daemon-reload") < at("systemctl enable flytower-mc@survival.service")
        );

        let env = fs::read_to_string(s.path("etc/servers/survival.env")).unwrap();
        assert!(env.contains(&format!("JAVA_HOME={}/temurin-25", s.root.paths.runtimes)));
        assert!(env.contains("HEAP_MB=6144"));
        let limits =
            fs::read_to_string(s.path("systemd/flytower-mc@survival.service.d/limits.conf"))
                .unwrap();
        assert!(limits.contains("MemoryMax=7168M"));
        let unit = fs::read_to_string(s.path("systemd/flytower-mc@.service")).unwrap();
        assert!(unit.contains("User=mc-%i") && unit.contains("ProtectSystem=strict"));
    }

    #[test]
    fn refuses_to_create_twice_or_without_java() {
        let s = Setup::new(vec![]);
        assert_eq!(
            create("survival", 25565, 6144, 25, &s.ctx())
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(!s.fake.ran().iter().any(|c| c.starts_with("useradd")));

        let s = Setup::new(vec![("id -u", absent())]);
        let err = create("survival", 25565, 6144, 21, &s.ctx()).unwrap_err();
        assert!(err.message.contains("Java 21"), "{}", err.message);
    }

    #[test]
    fn exposes_and_hides_a_server() {
        let status = "[ 1] 25566/tcp  ALLOW IN    Anywhere    # flytower server survival\n\
                      [ 2] 25565/tcp  ALLOW IN    Anywhere    # flytower router\n";
        let s = Setup::new(vec![("ufw status numbered", out(status))]);
        assert_eq!(
            expose("survival", 25566, false, &s.ctx()).unwrap_err().code,
            ErrorCode::NotFound
        );
        fs::create_dir_all(s.path("etc/servers")).unwrap();
        fs::write(s.path("etc/servers/survival.env"), "HEAP_MB=1024\n").unwrap();

        expose("survival", 25566, false, &s.ctx()).unwrap();
        let cmds = s.fake.ran();
        assert!(
            cmds.contains(&"ufw --force delete 1".to_string()),
            "{cmds:?}"
        );
        assert!(!cmds.iter().any(|c| c.starts_with("ufw allow")), "{cmds:?}");
        assert!(
            !cmds.contains(&"ufw --force delete 2".to_string()),
            "touched the router's rule"
        );

        s.fake.clear();
        expose("survival", 25566, true, &s.ctx()).unwrap();
        assert!(
            s.fake
                .ran()
                .contains(&"ufw allow 25566/tcp comment flytower server survival".to_string())
        );
    }

    #[test]
    fn deletes_archiving_first() {
        let status = "[ 1] 22/tcp     ALLOW IN    Anywhere\n\
                      [ 2] 25565/tcp  ALLOW IN    Anywhere    # flytower server survival\n\
                      [ 3] 25565/tcp (v6) ALLOW IN Anywhere (v6) # flytower server survival\n";
        let s = Setup::new(vec![("ufw status numbered", out(status))]);
        fs::create_dir_all(s.path("servers/survival")).unwrap();
        let r = remove("survival", &s.ctx()).unwrap();
        assert!(
            r["archivedTo"]
                .as_str()
                .unwrap()
                .starts_with(&s.root.paths.archive)
        );
        let cmds = s.fake.ran();
        let deletes: Vec<&String> = cmds
            .iter()
            .filter(|c| c.starts_with("ufw --force delete"))
            .collect();
        assert_eq!(deletes, ["ufw --force delete 3", "ufw --force delete 2"]);
        assert!(cmds.contains(&"userdel mc-survival".to_string()));
        assert!(
            cmds.iter()
                .any(|c| c.starts_with("tar -czf") && c.contains(&s.root.paths.archive))
        );
        assert!(!s.path("servers/survival").exists());
        assert!(crate::verbs::check_result("server.delete", &r).is_ok());
    }

    #[test]
    fn only_matches_rules_for_that_exact_server() {
        let line = "[ 4] 25566/tcp ALLOW IN Anywhere # flytower server survival-2\n";
        assert!(ufw_rule_numbers(line, "survival").is_empty());
        assert_eq!(
            ufw_rule_numbers("[12] 1/tcp ALLOW # flytower server a\n", "a"),
            [12]
        );
    }

    #[test]
    fn restores_permissions_without_following_links() {
        let s = Setup::new(vec![("id -u mc-survival", absent())]);
        create("survival", 25565, 6144, 25, &s.ctx()).unwrap();
        s.fake.clear();
        permissions("survival", &s.ctx()).unwrap();
        let dir = s.path("servers/survival");
        assert_eq!(
            s.fake.ran(),
            [
                format!("chgrp -R --no-dereference flytower {}", dir.display()),
                format!("chmod -R g+rwX,o-rwx {}", dir.display()),
            ]
        );
        assert_eq!(
            permissions("nope", &s.ctx()).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn configures_memory_keeping_java() {
        let s = Setup::new(vec![("id -u mc-survival", absent())]);
        create("survival", 25565, 6144, 25, &s.ctx()).unwrap();
        configure("survival", Some(2048), None, None, &s.ctx()).unwrap();
        let env = fs::read_to_string(s.path("etc/servers/survival.env")).unwrap();
        assert!(env.contains(&format!("JAVA_HOME={}/temurin-25", s.root.paths.runtimes)));
        assert!(env.contains("HEAP_MB=2048"));
        let limits =
            fs::read_to_string(s.path("systemd/flytower-mc@survival.service.d/limits.conf"))
                .unwrap();
        assert!(limits.contains("MemoryMax=3072M"));
    }

    #[test]
    fn refuses_an_empty_java_home_like_bun() {
        let s = Setup::new(vec![("id -u mc-survival", absent())]);
        create("survival", 25565, 6144, 25, &s.ctx()).unwrap();
        let env = s.path("etc/servers/survival.env");
        fs::write(&env, "JAVA_HOME=\nHEAP_MB=6144\n").unwrap();
        let err = configure("survival", Some(2048), None, None, &s.ctx()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Failed);
        assert!(err.message.ends_with("has no JAVA_HOME"), "{}", err.message);
        // And the file is left as it was.
        assert_eq!(
            fs::read_to_string(&env).unwrap(),
            "JAVA_HOME=\nHEAP_MB=6144\n"
        );
    }

    #[test]
    fn switches_java_keeping_the_heap() {
        let s = Setup::new(vec![("id -u mc-survival", absent())]);
        create("survival", 25565, 6144, 25, &s.ctx()).unwrap();
        let err = configure("survival", None, None, Some(21), &s.ctx()).unwrap_err();
        assert!(err.message.contains("Java 21 is not installed"));
        let java = Path::new(&s.root.paths.runtimes).join("temurin-21/bin");
        fs::create_dir_all(&java).unwrap();
        fs::write(java.join("java"), "").unwrap();
        configure("survival", None, None, Some(21), &s.ctx()).unwrap();
        let env = fs::read_to_string(s.path("etc/servers/survival.env")).unwrap();
        assert!(env.contains(&format!("JAVA_HOME={}/temurin-21", s.root.paths.runtimes)));
        assert!(env.contains("HEAP_MB=6144"));
    }

    #[test]
    fn swaps_the_firewall_rule_for_a_new_port() {
        let status = "Status: active\n\
                      [ 1] 22/tcp                     ALLOW IN    Anywhere\n\
                      [ 2] 25565/tcp                  ALLOW IN    Anywhere                   # flytower server survival\n";
        let s = Setup::new(vec![
            ("id -u mc-survival", absent()),
            ("ufw status numbered", out(status)),
        ]);
        create("survival", 25565, 6144, 25, &s.ctx()).unwrap();
        s.fake.clear();
        configure("survival", None, Some(25570), None, &s.ctx()).unwrap();
        assert_eq!(
            s.fake.ran(),
            [
                "ufw status numbered",
                "ufw --force delete 2",
                "ufw allow 25570/tcp comment flytower server survival"
            ]
        );
        let s = Setup::new(vec![]);
        assert_eq!(
            configure("survival", None, Some(30000), None, &s.ctx())
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn refreshes_the_template_only_when_it_differs() {
        let s = Setup::new(vec![]);
        assert!(!refresh_template(&s.ctx()).unwrap());
        assert!(s.fake.ran().is_empty());

        let file = s.path("systemd/flytower-mc@.service");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            "# an older template\n[Service]\nRestart=on-failure\n",
        )
        .unwrap();
        assert!(refresh_template(&s.ctx()).unwrap());
        let unit = fs::read_to_string(&file).unwrap();
        assert!(unit.contains("StartLimitIntervalSec=600") && unit.contains("StartLimitBurst=3"));
        assert_eq!(s.fake.ran(), ["systemctl daemon-reload"]);

        s.fake.clear();
        assert!(!refresh_template(&s.ctx()).unwrap());
        assert!(s.fake.ran().is_empty());
    }
}
