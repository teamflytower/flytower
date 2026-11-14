//! A test build of the agent: the same socket server, envelope and subscriptions as
//! `flytower-agent`, plus the `testing.*` subscriptions, listening on the socket named by its
//! first argument without root and without the start-up steps that change the machine. The
//! TypeScript client's tests run against it (`FLYTOWER_AGENT_TESTING`). Only built with the
//! `testing` feature, never released.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use flytower_agent::exec::{Exec, RealExec};
use flytower_agent::fetch::Curl;
use flytower_agent::handlers::{Agent, Context, system_clock};
use flytower_agent::server::{ListenOptions, bind, serve};
use flytower_agent::systemd::Bus;
use flytower_agent::units::Paths;

fn main() -> ExitCode {
    let Some(socket) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: flytower-agent-testing <socket>");
        return ExitCode::FAILURE;
    };
    let root = socket.parent().map(PathBuf::from).unwrap_or_default();
    let exec: Arc<dyn Exec> = Arc::new(RealExec::default());
    let ctx = Context {
        version: std::env::var("FLYTOWER_VERSION").unwrap_or_else(|_| "0.0.0-testing".into()),
        exec: Arc::clone(&exec),
        now: system_clock(),
        fetch: Arc::new(Curl {
            exec: Arc::clone(&exec),
        }),
        arch: std::env::consts::ARCH.into(),
        events: None,
        systemd: Arc::new(Bus::new()),
        paths: Paths::under(&root),
        panel_group: "flytower".into(),
        releases_url: String::new(),
        release_key: String::new(),
        updating: Arc::default(),
    };
    let opts = ListenOptions {
        socket_path: socket,
        group: None,
    };
    let listener = match bind(&opts) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("flytower-agent-testing: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("flytower-agent-testing listening");
    serve(
        &listener,
        None,
        Agent {
            ctx: Arc::new(ctx),
            log: Arc::new(|audit| println!("{audit}")),
        },
    );
    ExitCode::SUCCESS
}
