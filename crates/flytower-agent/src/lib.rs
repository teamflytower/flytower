//! Flytower's system helper, in Rust. It runs as root and does a fixed list of jobs for the
//! panel, over newline-delimited JSON on a Unix socket (`packages/protocol`). It replaced the
//! Bun agent in 1.5.0. See `docs/decisions/0001-rust-and-go.md`.

pub mod caddy;
pub mod dispatch;
pub mod entry_points;
pub mod envelope;
pub mod events;
pub mod exec;
pub mod fetch;
pub mod folders;
pub mod handlers;
pub mod logs;
pub mod release;
pub mod safe_fs;
pub mod server;
pub mod stream;
pub mod time;
pub mod units;
pub mod updater;
pub mod verbs;
pub mod versions;
