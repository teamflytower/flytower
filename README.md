# Flytower

A self-hosted web panel for running Minecraft servers. Install it once on a fresh VPS, then create, configure and look after any number of servers from the browser. You sign in with a passkey, and you never need SSH again.

**Latest:** see [Releases](https://github.com/teamflytower/flytower/releases). **Install:** [docs/install.md](docs/install.md). **Everything else:** [the documentation](docs/README.md).

## What it is

- **One install, then the browser.** The installer sets up the panel only. Servers, Java runtimes, mods and datapacks are all managed from the panel.
- **Specs, not scripts.** Each server is a YAML spec. Edit it as a form or as YAML, then apply it.
- **Trusted sources, no lock-in.** Mojang, Fabric, PaperMC, Modrinth, Hangar and Vanilla Tweaks are built in. Every server folder is an ordinary server folder that still runs without Flytower.
- **Many servers per box.** Each server gets its own user, folder, memory limit, port and hostname.
- **Safe by design.** The panel never runs as root. A small root helper does a fixed list of jobs, and every release is signed and checked before it's installed.

## Features

- **Servers and content:** vanilla, Fabric and Paper servers; mods, plugins and datapacks from Modrinth, Hangar and Vanilla Tweaks, or your own files; a live console, players, whitelist and operators.
- **Backups:** scheduled backups with retention, restores, off-site copies to S3-compatible storage, and past worlds kept when you reset one. [More](docs/backups.md)
- **Keeping an eye on things:** crash detection with automatic restarts, notifications to Discord, ntfy or a webhook, disk-use warnings, and performance history. [Crashes](docs/crashes.md), [notifications](docs/notifications.md), [disk](docs/disk.md)
- **Scheduled tasks:** restarts with an in-game countdown, console commands and announcements. [More](docs/schedules.md)
- **People and permissions:** invite others with roles that say what each person can do, and a log of who changed what. [More](docs/people.md)
- **Community:** a public [status page](docs/status-page.md), [Discord](docs/discord.md) chat and roles, and a [web map](docs/map.md) of your world.
- **Your own look:** name, accent colour, font, logo and favicon across the panel, sign-in page, Discord and in-game messages. [More](docs/branding.md)
- **Self-updates:** signed updates from the panel on a Stable or Beta channel, rolled back automatically if they fail, with **Go back to** for the previous version. [More](docs/updating.md)

What's new in each version is in the [release notes](https://github.com/teamflytower/flytower/releases).

## Install

On a fresh Ubuntu 24.04+ or Debian 12+ server, with a domain pointing at it:

```sh
curl -fsSL https://github.com/teamflytower/flytower/releases/latest/download/install.sh \
  | sudo bash -s -- --domain panel.example.com
```

The installer prints a one-time setup token. Open your domain, enter it, and create your passkey. You can also install on Hetzner Cloud with no SSH at all, through cloud-config. See [Installing Flytower](docs/install.md) for both.

**Stable or Beta.** The installer installs the newest stable release by default. Add `--beta` for the newest release including betas, or `--version <x.y.z>` for a specific one. Once installed, choose the update channel under **System → Updates**. See [Stable or Beta](docs/updating.md#stable-or-beta). Running the installer again on a box that has Flytower keeps the version it has, unless you pass one of these.

**Testing a pull request.** `--pr <number>` installs the signed test build of that pull request. It's for test boxes, not real servers. Each release's testing notes are in `docs/testing/testing-<version>.md`.

## Development

Flytower uses [Bun](https://bun.sh) 1.4 or later for everything: runtime, package manager, scripts and tests. There's no Node.js and no npm.

```sh
bun install
bun test
bun run lint
bun run typecheck
```

To work on the panel without root or systemd, run the stand-in agent next to the dev server. It's a small TypeScript fake that simulates services, logs and RCON; real boxes run the Rust agent in `crates/flytower-agent`:

```sh
bun run --filter @flytower/dev-agent dev   # terminal 1
bun run --filter @flytower/panel dev       # terminal 2, then open http://localhost:3000 (setup token: dev-setup-token)
```

The agent, updater and other root helpers are in Rust (`crates/`), and the networking helpers, starting with the hostname router, are in Go (`go/`). The `flytower-proxy` Fabric mod (`mods/`) is Java, built with its Gradle wrapper and Java 25. You only need those toolchains to work on them; the versions are pinned in `crates/rust-toolchain.toml`, `go/go.mod` and `mods/flytower-proxy/gradle.properties`. [Decision record 0001](docs/decisions/0001-rust-and-go.md#building) says how to build and check each.

Commit and pull request titles use Conventional Commits (`feat:`, `fix:`, `docs:` and so on), because release notes are built from them.

### Layout

| Path                 | What                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `apps/panel`         | Nuxt web app (UI and API), runs unprivileged                                                  |
| `crates/`            | Rust: the root helper (agent and updater), disk measuring and the web map renderer            |
| `packages/dev-agent` | Stand-in agent for working on the panel without root (never shipped)                          |
| `packages/protocol`  | Shared message schemas between the panel and the agent                                        |
| `packages/providers` | Where servers and content come from (Mojang, Fabric, Paper, Modrinth, Hangar, Vanilla Tweaks) |
| `packages/rcon`      | Minecraft RCON client                                                                         |
| `crates/`            | Rust helpers: the agent, the updater, `flytower-du` and `flytower-map`                        |
| `go/`                | Go helpers: `flytower-router`, and the protocol envelope in Go                                |
| `mods/`              | Minecraft mods Flytower ships: `flytower-proxy`, which shows real addresses behind the router |
| `protocol/`          | The agent protocol exported as JSON Schema, and fixtures every language replays               |
| `installer/`         | One-line installer for a fresh Ubuntu or Debian VPS                                           |
| `scripts/`           | Release packaging and notes                                                                   |
| `tests/e2e/`         | Installer and browser end-to-end test (Bun.WebView, systemd container)                        |
| `docs/`              | User documentation and testing notes                                                          |

## Documentation and roadmap

- [Documentation](docs/README.md): installing, running servers, and looking after the machine.
- [Milestones](https://github.com/teamflytower/flytower/milestones): what's planned for each release.
- [Issues](https://github.com/teamflytower/flytower/issues): bugs and feature requests.
- [Releases](https://github.com/teamflytower/flytower/releases): signed builds and release notes.

## Licence

Flytower is free software under the [GNU Affero General Public License v3.0](LICENSE). You can use, change and share it. If you run a changed version for other people over a network, you must offer them its source.
