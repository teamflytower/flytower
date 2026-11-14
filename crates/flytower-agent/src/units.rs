//! systemd units and the files beside them. The agent rewrites the template whenever it
//! differs, and so did the releases before this one, so the text must not drift by accident.
//! `protocol/fixtures/server-unit.service` pins it, and the tests check it.

use std::path::Path;

/// Where the agent keeps things, from environment variables, with the installer's defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub servers: String,
    pub runtimes: String,
    /// Root's, readable by the panel's group (0750).
    pub archive: String,
    pub config: String,
    pub systemd: String,
    /// Root only (0700): SSH timer, update record, database copies.
    pub state: String,
    /// Where releases live, with `current` pointing at one.
    pub prefix: String,
    /// The panel's data folder, holding its database.
    pub panel_data: String,
    /// Where `/var/log`, `/var/cache/apt` and `/tmp` are found: `/` except in tests.
    pub system: String,
    /// The Caddyfile the installer wrote.
    pub caddyfile: String,
    /// The agent's socket. Servers can't see its folder.
    pub socket: String,
}

impl Paths {
    /// The defaults, each overridden by its `FLYTOWER_*` variable.
    #[must_use]
    pub fn from_env() -> Self {
        let env = |name: &str, fallback: &str| {
            std::env::var(name).unwrap_or_else(|_| fallback.to_string())
        };
        Self {
            servers: env("FLYTOWER_SERVERS_DIR", "/srv/flytower/servers"),
            runtimes: env("FLYTOWER_RUNTIMES_DIR", "/opt/flytower/runtimes"),
            archive: env("FLYTOWER_ARCHIVE_DIR", "/var/lib/flytower-archive"),
            config: env("FLYTOWER_CONFIG_DIR", "/etc/flytower"),
            systemd: env("FLYTOWER_SYSTEMD_DIR", "/etc/systemd/system"),
            state: env("FLYTOWER_AGENT_STATE_DIR", "/var/lib/flytower-agent"),
            prefix: env("FLYTOWER_PREFIX", "/opt/flytower"),
            panel_data: env("FLYTOWER_PANEL_DATA", "/var/lib/flytower"),
            system: "/".into(),
            caddyfile: env("FLYTOWER_CADDYFILE", "/etc/caddy/Caddyfile"),
            socket: env("FLYTOWER_AGENT_SOCKET", "/run/flytower/agent.sock"),
        }
    }

    /// Everything under one folder, for tests.
    #[must_use]
    pub fn under(root: &Path) -> Self {
        let at = |name: &str| root.join(name).to_string_lossy().into_owned();
        Self {
            servers: at("servers"),
            runtimes: at("runtimes"),
            archive: at("archive"),
            config: at("etc"),
            systemd: at("systemd"),
            state: at("state"),
            prefix: at("prefix"),
            panel_data: at("panel"),
            system: at("system"),
            caddyfile: at("Caddyfile"),
            socket: at("agent.sock"),
        }
    }
}

/// Paths a server must never see: the agent's socket, the panel's data, the agent's state, the
/// archive of deleted servers and the panel's secrets. A path inside another listed one is
/// dropped, since hiding the parent already hides it. Matches `hiddenPaths` in units.ts.
#[must_use]
pub fn hidden_paths(paths: &Paths) -> Vec<String> {
    let socket_dir = Path::new(&paths.socket)
        .parent()
        .map_or_else(|| "/".into(), |p| p.to_string_lossy().into_owned());
    let panel_env = Path::new(&paths.config)
        .join("panel.env")
        .to_string_lossy()
        .into_owned();
    let mut all: Vec<String> = Vec::new();
    for p in [
        socket_dir,
        paths.panel_data.clone(),
        paths.state.clone(),
        paths.archive.clone(),
        panel_env,
    ] {
        if !all.contains(&p) {
            all.push(p);
        }
    }
    let within = |child: &str, parent: &str| {
        Path::new(child) != Path::new(parent) && Path::new(child).starts_with(parent)
    };
    all.iter()
        .filter(|p| !all.iter().any(|other| within(p, other)))
        .cloned()
        .collect()
}

/// The one systemd template every server runs under. Per-server values come from the
/// environment file and a drop-in, never from string-building inside this template. `$$` is
/// systemd's escape for a literal `$`, so the shell (not systemd) expands the variables.
#[must_use]
pub fn template_unit(paths: &Paths, panel_group: &str) -> String {
    let servers = &paths.servers;
    let config = &paths.config;
    let hidden = hidden_paths(paths)
        .iter()
        .map(|p| format!("-{p}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"# Managed by Flytower. Changes are overwritten.
[Unit]
Description=Minecraft server %i (Flytower)
After=network-online.target
Wants=network-online.target
# Three failed starts in ten minutes is a crash loop: systemd leaves the server failed
# instead of restarting it forever. Starting it from the panel clears this.
StartLimitIntervalSec=600
StartLimitBurst=3

[Service]
User=mc-%i
Group=mc-%i
# The panel's group as an extra, so the server can use the files the panel puts in its folder.
SupplementaryGroups={panel_group}
UMask=0007
WorkingDirectory={servers}/%i
EnvironmentFile={config}/servers/%i.env
ExecStart=/bin/sh -c 'exec "$$JAVA_HOME/bin/java" -Xms$${{HEAP_MB}}M -Xmx$${{HEAP_MB}}M $$JVM_FLAGS -jar server.jar nogui'
SuccessExitStatus=0 143
TimeoutStopSec=120
Restart=on-failure
RestartSec=15
# systemd 254+ waits longer after each crash, up to a minute; older versions ignore these.
RestartSteps=3
RestartMaxDelaySec=60
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths={servers}/%i
# Mods run with the server's rights, so keep the root agent and the panel's secrets out of reach.
InaccessiblePaths={hidden}
Slice=flytower-mc.slice

[Install]
WantedBy=multi-user.target
"#
    )
}

/// Aikar's G1 flags.
pub const JVM_FLAGS: &str = "-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 \
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch \
-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M \
-XX:G1ReservePercent=20 -XX:InitiatingHeapOccupancyPercent=15 -XX:SurvivorRatio=32 \
-XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1";

#[must_use]
pub fn env_file(java_home: &str, heap_mb: i64) -> String {
    format!(
        "# Managed by Flytower.\nJAVA_HOME={java_home}\nHEAP_MB={heap_mb}\nJVM_FLAGS={JVM_FLAGS}\n"
    )
}

/// Heap plus 1 GB for the JVM's own overhead, so a leak can't take the whole box down.
#[must_use]
pub fn limits_drop_in(heap_mb: i64) -> String {
    format!(
        "# Managed by Flytower.\n[Service]\nMemoryMax={}M\nMemorySwapMax=0\n",
        heap_mb + 1024
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../protocol/fixtures")
            .join(name);
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn template_matches_the_typescript_agent() {
        let paths = Paths {
            servers: "/srv/flytower/servers".into(),
            config: "/etc/flytower".into(),
            panel_data: "/var/lib/flytower".into(),
            state: "/var/lib/flytower-agent".into(),
            archive: "/var/lib/flytower-archive".into(),
            socket: "/run/flytower/agent.sock".into(),
            ..Paths::under(Path::new("/x"))
        };
        assert_eq!(
            template_unit(&paths, "flytower"),
            fixture("server-unit.service")
        );
    }

    #[test]
    fn hides_nested_paths_once() {
        let paths = Paths {
            config: "/etc/flytower".into(),
            socket: "/run/flytower/agent.sock".into(),
            panel_data: "/var/lib/flytower".into(),
            state: "/var/lib/flytower/agent".into(),
            archive: "/var/lib/flytower/archive".into(),
            ..Paths::under(Path::new("/x"))
        };
        assert_eq!(
            hidden_paths(&paths),
            [
                "/run/flytower",
                "/var/lib/flytower",
                "/etc/flytower/panel.env"
            ]
        );
    }

    #[test]
    fn env_and_limits_match_the_typescript_agent() {
        assert_eq!(
            env_file("/opt/flytower/runtimes/temurin-25", 6144),
            fixture("server.env")
        );
        assert_eq!(
            limits_drop_in(6144),
            "# Managed by Flytower.\n[Service]\nMemoryMax=7168M\nMemorySwapMax=0\n"
        );
    }
}
