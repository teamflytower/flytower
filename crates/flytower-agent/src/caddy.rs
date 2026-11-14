//! Keeps the Caddyfile the installer wrote up to date.
//! Since 1.2, a server's own hostname shows its public status page, which needs Caddy to get
//! certificates on demand. Only the installer wrote that, so installs from before 1.2 that
//! were updated from the panel never got it. The agent adds it when it starts.

use std::path::Path;

use crate::handlers::Context;

const MARKER: &str = "# Managed by Flytower";
const ASK: &str = "/api/public/tls-ask";

/// The Caddyfile for a panel on `domain`, with every other name a server hostname whose page
/// Caddy checks with the panel first. Must match what `installer/install.sh` writes.
#[must_use]
pub fn caddyfile(domain: &str, port: u16) -> String {
    format!(
        "# Managed by Flytower. Re-running the installer rewrites this file.
{{
\ton_demand_tls {{
\t\task http://127.0.0.1:{port}{ASK}
\t}}
}}

{domain} {{
\tencode zstd gzip
\treverse_proxy 127.0.0.1:{port}
}}

https:// {{
\ttls {{
\t\ton_demand
\t}}
\tencode zstd gzip
\treverse_proxy 127.0.0.1:{port}
}}
"
    )
}

/// The panel's domain and port, from the `panel.env` the installer wrote.
#[must_use]
pub fn panel_address(env: &str) -> Option<(String, u16)> {
    let value = |key: &str| {
        env.lines()
            .find_map(|l| l.strip_prefix(key).map(|v| v.trim().to_string()))
    };
    let domain = value("NUXT_RP_ID=")?;
    let valid = !domain.is_empty()
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !valid {
        return None;
    }
    let port = value("PORT=").and_then(|p| p.parse().ok()).unwrap_or(3000);
    Some((domain, port))
}

fn run(ctx: &Context, file: &str, args: &[&str]) -> Result<(), String> {
    let r = ctx.exec.run(file, args);
    if r.code == 0 {
        return Ok(());
    }
    let why = r.stderr.trim();
    Err(format!(
        "{file} {}: {}",
        args.first().copied().unwrap_or_default(),
        if why.is_empty() { "failed" } else { why }
    ))
}

/// Rewrites a Caddyfile the installer wrote that can't serve server hostnames yet, and
/// reloads Caddy. A Caddyfile without the installer's marker is the person's own and is left
/// alone. The old file is kept beside it as `Caddyfile.before-hostnames`.
///
/// # Errors
/// If Caddy rejects the new file (the old one stays), a file can't be written, or Caddy
/// won't reload.
pub fn refresh_caddyfile(ctx: &Context) -> Result<bool, String> {
    let path = Path::new(&ctx.paths.caddyfile);
    let Ok(current) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    if !current.starts_with(MARKER) || current.contains(ASK) {
        return Ok(false);
    }
    let env =
        std::fs::read_to_string(Path::new(&ctx.paths.config).join("panel.env")).unwrap_or_default();
    let Some((domain, port)) = panel_address(&env) else {
        return Ok(false);
    };

    let display = path.display();
    let next = format!("{display}.new");
    std::fs::write(&next, caddyfile(&domain, port)).map_err(|e| format!("writing {next}: {e}"))?;
    if let Err(e) = run(
        ctx,
        "caddy",
        &["validate", "--config", &next, "--adapter", "caddyfile"],
    ) {
        let _ = std::fs::remove_file(&next);
        return Err(e);
    }
    std::fs::copy(path, format!("{display}.before-hostnames"))
        .map_err(|e| format!("keeping the old Caddyfile: {e}"))?;
    std::fs::rename(&next, path).map_err(|e| format!("replacing {display}: {e}"))?;
    run(ctx, "systemctl", &["reload-or-restart", "caddy"])?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::ExecResult;
    use crate::handlers::testing::{Fake, TempRoot};

    const OLD: &str = "# Managed by Flytower. Re-running the installer rewrites this file.
panel.example.com {
\tencode zstd gzip
\treverse_proxy 127.0.0.1:3000
}
";
    const ENV: &str = "NUXT_APP_SECRET=x\nNUXT_RP_ID=panel.example.com\nPORT=3000\n";

    fn machine(file: Option<&str>, env: &str, fake: &Fake) -> (TempRoot, Context) {
        let root = TempRoot::new("caddy");
        std::fs::create_dir_all(&root.paths.config).unwrap();
        std::fs::write(Path::new(&root.paths.config).join("panel.env"), env).unwrap();
        if let Some(f) = file {
            std::fs::write(&root.paths.caddyfile, f).unwrap();
        }
        let ctx = fake.context(&root.paths);
        (root, ctx)
    }

    fn read(path: &str) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn adds_server_hostnames_to_an_old_caddyfile_keeps_it_and_reloads() {
        let fake = Fake::default();
        let (root, ctx) = machine(Some(OLD), ENV, &fake);
        assert!(refresh_caddyfile(&ctx).unwrap());
        let path = &root.paths.caddyfile;
        assert_eq!(read(path), caddyfile("panel.example.com", 3000));
        assert_eq!(read(&format!("{path}.before-hostnames")), OLD);
        assert!(!Path::new(&format!("{path}.new")).exists());
        assert_eq!(
            fake.ran(),
            vec![
                format!("caddy validate --config {path}.new --adapter caddyfile"),
                "systemctl reload-or-restart caddy".to_string(),
            ]
        );
    }

    #[test]
    fn uses_the_port_in_panel_env() {
        let fake = Fake::default();
        let (root, ctx) = machine(
            Some(OLD),
            "NUXT_RP_ID=panel.example.com\nPORT=3100\n",
            &fake,
        );
        refresh_caddyfile(&ctx).unwrap();
        assert!(
            read(&root.paths.caddyfile).contains("ask http://127.0.0.1:3100/api/public/tls-ask")
        );
    }

    #[test]
    fn leaves_current_and_hand_written_caddyfiles_alone() {
        let current = caddyfile("panel.example.com", 3000);
        let own = "panel.example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n";
        for file in [current.as_str(), own] {
            let fake = Fake::default();
            let (root, ctx) = machine(Some(file), ENV, &fake);
            assert!(!refresh_caddyfile(&ctx).unwrap());
            assert_eq!(read(&root.paths.caddyfile), file);
            assert!(fake.ran().is_empty());
        }
    }

    #[test]
    fn does_nothing_without_caddy_or_a_domain() {
        let fake = Fake::default();
        assert!(!refresh_caddyfile(&machine(None, ENV, &fake).1).unwrap());
        assert!(!refresh_caddyfile(&machine(Some(OLD), "PORT=3000\n", &fake).1).unwrap());
        assert!(fake.ran().is_empty());
    }

    #[test]
    fn keeps_the_old_file_when_caddy_rejects_the_new_one() {
        let fake = Fake::new(vec![(
            "caddy validate",
            ExecResult {
                code: 1,
                stdout: String::new(),
                stderr: "bad config".into(),
            },
        )]);
        let (root, ctx) = machine(Some(OLD), ENV, &fake);
        assert_eq!(
            refresh_caddyfile(&ctx).unwrap_err(),
            "caddy validate: bad config"
        );
        assert_eq!(read(&root.paths.caddyfile), OLD);
        assert!(!Path::new(&format!("{}.new", root.paths.caddyfile)).exists());
        assert!(!fake.ran().iter().any(|c| c.starts_with("systemctl")));
    }

    #[test]
    fn is_what_the_installer_writes() {
        let script = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../installer/install.sh"),
        )
        .unwrap();
        let start = "cat >\"$caddyfile\" <<EOF\n";
        let body = &script[script.find(start).unwrap() + start.len()..];
        let heredoc = &body[..=body.find("\nEOF\n").unwrap()];
        let written = heredoc
            .replace("$domain", "panel.example.com")
            .replace("$PANEL_PORT", "3000");
        assert_eq!(caddyfile("panel.example.com", 3000), written);
    }

    #[test]
    fn reads_the_domain_and_port() {
        assert_eq!(panel_address(ENV), Some(("panel.example.com".into(), 3000)));
        assert_eq!(
            panel_address("NUXT_RP_ID=a.example\n"),
            Some(("a.example".into(), 3000))
        );
        assert_eq!(panel_address("NUXT_RP_ID=bad name\n"), None);
    }
}
