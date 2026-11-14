# 1. Rust and Go alongside Bun

- **Status:** accepted, 2026-11-10
- **Tracking issue:** #134

## Context

Flytower is all TypeScript on Bun: the panel and the root helper (the agent and its updater). That works, but a few parts would be better in another language:

- **The agent runs as root.** It carries a whole JavaScript runtime to do a short, fixed list of jobs, and it can't check who's on the other end of its socket, because Bun has no `SO_PEERCRED`. Today it relies on the socket's file permissions alone.
- **The updater has to keep working when the release it's replacing is broken.** It's safest as something that doesn't depend on that release's runtime.
- **Some OS work is clumsy from Bun.** Following systemd means running `journalctl` and parsing what it prints. Following a log means polling it. Measuring disk use walks big worlds one folder at a time.
- **Upcoming networking work** needs long-lived proxies and links: the hostname router (#76) and managing servers on other machines (#29).

## Decision

Each language does what it's best at:

- **Rust** is for anything that runs as root or works closely with the OS: the agent, the updater, disk walking, log following and, later, perhaps backups. The result is small static binaries with memory safety, `SO_PEERCRED`, systemd over D-Bus, and inotify.
- **Go** is for networking: the hostname router, the link between machines, and possibly a `flytower` command-line tool to replace most of `install.sh`.
- **Bun** keeps everything else: the panel, the UI, the API, the database, providers, jobs, RCON, and every build and release script. Node still doesn't appear anywhere.

## Rules

1. **Separate processes only.** Languages talk over a socket, never through FFI or by sharing code.
2. **The protocol is the contract.** Everything uses the agent protocol: one JSON message per line, the envelope in `packages/protocol/src/envelope.ts`, and the verbs in `verbs.ts`. The Zod schemas stay the source of truth. `bun scripts/protocol-schema.ts` exports them to [`protocol/schema.json`](../../protocol/schema.json), and CI fails if that file is out of date. Rust and Go types are generated from it or checked against it.
3. **Shared fixtures.** [`protocol/fixtures/`](../../protocol/fixtures) holds valid and invalid messages for every verb. The TypeScript, Rust and Go tests all replay the same files, so implementations can't drift apart without someone noticing.
4. **Every new binary has a way back.** That's either a Bun fallback while a part is new, or the previous release, which the updater already rolls back to.
5. **Stable entry points.** systemd units start `current/bin/flytower-agent`, and the agent starts the updater as `releases/<version>/bin/flytower-updater`, never a language runtime directly. Whatever is behind those paths can then change between releases. Until the Rust agent shipped they were shell wrappers that ran Bun; since 1.5.0 they are the Rust programs themselves.
6. **No extra CI for panel work.** Rust jobs run only when `crates/**` or `protocol/**` change, and Go jobs only when `go/**` or `protocol/**` change.
7. **Short dependency lists,** checked with `cargo deny` and `govulncheck`.

## Layout

| Folder               | What's in it                                                    |
| -------------------- | --------------------------------------------------------------- |
| `apps/`, `packages/` | Bun workspaces, as today                                        |
| `protocol/`          | the exported JSON Schema and shared fixtures                    |
| `crates/`            | a Cargo workspace: `flytower-du`, later `flytower-agent`        |
| `go/`                | one Go module: `cmd/flytower-router`, later `cmd/flytower-link` |

Rust builds static musl binaries for amd64 and arm64 on native runners. Go cross-compiles with cgo off. `scripts/package.ts` (still Bun) puts both in each release tarball's `bin/`, and the existing signature covers them.

## Building

**Rust.** The toolchain is pinned in `crates/rust-toolchain.toml`, so `rustup` picks it up by itself. From `crates/`: `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo build --release`.

**Go.** `go/go.mod` pins the toolchain with its `toolchain` line, so any Go 1.21 or later downloads the right version on first use. `staticcheck` and `govulncheck` are pinned there as tools too, so everyone runs the same versions. From `go/`:

```sh
gofmt -l .                 # lists files that need formatting
go vet ./...
go tool staticcheck ./...
go test -race ./...
go tool govulncheck ./...
CGO_ENABLED=0 go build -o flytower-router ./cmd/flytower-router
```

Packages that something else might import, such as the protocol envelope in `go/protocol`, live outside `go/internal/`. Each command in `go/cmd/` stays a thin wrapper around them. The Go tests replay `protocol/fixtures/` like the TypeScript and Rust ones do.

The `Go` and `Rust` workflows run only when their folder or `protocol/` changes. Release and test builds need both toolchains: `scripts/package.ts` builds the Rust binaries with cargo and cross-compiles the Go ones with `GOARCH` set, stamping the release version in with `-ldflags "-X main.version=…"`.

## Stages

0. Groundwork: this record, the schema export and fixtures, and stable entry points (#135)
1. `flytower-du`, the first Rust binary (#136)
2. The agent and updater in Rust (#137)
3. Events: protocol subscriptions and inotify log following (#138)
4. The hostname router in Go (#139, for #76)
5. The Go link for managing several machines (#140, for #29)

## Consequences

- Contributors to the panel only need Bun and TypeScript. Agent and router work needs Rust or Go as well.
- Release builds get a little longer, and tarballs a few MB bigger.
- Plugins never run as root and can't add agent verbs at runtime. A plugin that needs something privileged, such as containers, gets it through a verb added to the agent in a release.
