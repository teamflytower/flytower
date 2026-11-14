# The agent protocol

How the panel talks to the agent, which runs as root. The Zod schemas in `packages/protocol` are the source of truth; [`schema.json`](schema.json) is generated from them (`bun scripts/protocol-schema.ts`) and [`fixtures/`](fixtures) holds messages every implementation must agree on. See [the decision record](../docs/decisions/0001-rust-and-go.md).

Messages are JSON objects, one per line, over the Unix socket at `/run/flytower/agent.sock`. Only root and the panel's user may connect.

## Protocol 1: requests

The panel sends `{id, verb, params}` and the agent answers `{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`. Requests on one connection are answered in order. `verbs.ts` lists every verb; anything else is refused, so that list is the whole of the panel's root access.

## Protocol 2: subscriptions

For things that keep happening, such as a server's log or its state, the panel opens a subscription and the agent keeps sending until it's cancelled. Only the Rust agent speaks protocol 2. Ask `agent.hello` first: it says which agent is running (`rust` or `bun`), which protocols it speaks and which subscriptions it offers. An agent that answers `unknown_verb` speaks protocol 1 only.

| Panel sends                     | Agent sends                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `{id, subscribe: verb, params}` | `{id, ok: true, result}`, or an error as for a request, then                                    |
|                                 | `{id, event}` for each event,                                                                   |
|                                 | `{id, skipped: n}` if it dropped `n` events because the panel fell behind,                      |
|                                 | `{id, end: true, reason, message?}` last, where `reason` is `finished`, `cancelled` or `failed` |
| `{id, cancel: true}`            | the end frame, with reason `cancelled`                                                          |
|                                 | `{ping: true}` after 30 s without sending anything, while subscriptions are live                |

- `subscriptions` in `verbs.ts` lists every subscription, with the schemas of its params, its answer and its events.
- Several subscriptions can share one connection, up to 64. Requests can be sent on it too, but they're answered in order, so a long request delays reading a cancel.
- Each subscription queues at most 1024 events. When the panel reads too slowly, the agent counts what it drops and sends `skipped` rather than using more memory.
- A connection with live subscriptions is never closed for being idle; one without is closed after 10 minutes, as before.
- A frame can be up to 1 MB (`MAX_FRAME_BYTES`), since a batch of log lines can be large; requests stay under 64 KB.
- Ids belong to a connection. An id can be reused once its end frame has been sent.

`AgentStreams` and `subscribeAgent` in `@flytower/protocol/client` do this for the panel: one connection shared by every subscription, and after the agent restarts (an update, say) they reconnect with backoff and subscribe again, calling `onStart(result, true)` so callers can catch up on what they missed.

### Subscriptions

- `log.follow {server, seedBytes, crashes?}`: a server's `logs/latest.log`. First up to `seedBytes` of what's already there as `{seed: [lines]}`, then `{lines: [...]}` as the server writes. It takes a server name, never a path. The agent follows the file with inotify (one watch per server however many follow it), keeps going when Minecraft rotates the log or it's truncated, waits for a server that hasn't written one yet, and never sends half a line. Lines over 64 KB are cut and bad UTF-8 is replaced. With `crashes: true` each new file in `crash-reports/` comes as `{crash: "crash-reports/<file>"}`. Nothing is followed through a symlink, and `latest.log` must be a regular file with a single link. If the server is deleted, the subscription ends with `finished`.

- `service.events {servers}`: answers with `{states: {server: status}}`, every server's state as `service.status` gives it (`unknown` if systemd doesn't know it), then sends `{server, status}` whenever one changes. The agent hears about changes from systemd's D-Bus signals, the same source as `service.wait`, so nothing polls. A burst (exited, failed, restart scheduled) settles for 300 ms and each server is sent once, and only if its state really changed. If systemd stops being followed for a moment, every server is checked again. To change the list of servers, cancel and subscribe again. Offered only when the agent can follow systemd; `service.wait` stays for older panels.

`testing.ticks` exists only in test builds (`cargo build --features testing`, binary `flytower-agent-testing`), so the client can be tested against the real agent. Release builds answer it with `unknown_verb`.
