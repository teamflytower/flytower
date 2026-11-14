# Protocol fixtures

Messages that every implementation of the agent protocol must agree on, whatever language it's written in. See [the decision record](../../docs/decisions/0001-rust-and-go.md).

There's one JSON object per line:

- `envelope.jsonl` has `kind` set to `request`, `response`, `subscribe`, `cancel` or `frame`, and checks the envelope only. A `frame` is anything the agent sends: a response, or a subscription's `event`, `skipped`, `end` or `ping` frame (protocol 2).
- `verbs.jsonl` adds a `verb`, and `kind` is `params` or `result`. It checks that verb's params or result.
- `subscriptions.jsonl` is the same for subscriptions, with a third `kind`, `event`, for the events each one sends.
- `valid` says whether an implementation must accept `value` (`true`) or refuse it (`false`).
- `note` says why a line is there, which matters most for the refused ones.

Some rules are Zod refinements that JSON Schema can't express. A note ending in "(a refinement, not in schema.json)" marks those lines, so other languages have to check them in code.

The TypeScript tests (`packages/protocol/src/fixtures.test.ts`) replay every line against the Zod schemas. They also check that each verb has at least one valid params line and one valid result line. When you add or change a verb or a subscription, add lines here in the same commit.

`server-unit.service` and `server.env` are the systemd template and environment file the agent writes for a server, with the default paths and the `flytower` group. The agent rewrites the template whenever it differs, and so did every release before, so a change here is a change on every box. The Rust agent's `units.rs` tests check these files.

`disk-groups.jsonl` says which part of a server's space each top-level entry of its folder counts towards in `disk.usage`: `entry` is the name, `levelName` the server's `level-name` property (or null), and `group` the answer. The Rust agent's `disk.rs` tests and the stand-in agent's (`packages/dev-agent/test/disk.test.ts`) both replay it.

`proxy-v2.jsonl` pins the PROXY protocol version 2 headers the hostname router sends ahead of a player's connection: `src` and `dst` are the addresses it's given, `header` the bytes in hex, and `source` (when it differs from `src`) the player address a server should read back. `go/router/proxyproto` writes them and the `flytower-proxy` Fabric mod (`mods/flytower-proxy`) reads them, and both test suites replay this file.
