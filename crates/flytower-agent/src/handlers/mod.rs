//! What each verb does, one module per area. Every
//! verb in the protocol is handled here.

pub mod disk;
pub(crate) mod files;
pub mod router;
pub mod runtime;
pub mod server;
pub mod service;
pub mod ssh;
pub mod streams;
#[cfg(test)]
pub mod testing;
pub mod update;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

use crate::dispatch::{dispatch, dispatch_subscribe, end_line};
use crate::envelope::{
    AgentError, End, ErrorCode, PROTOCOL_VERSION, PROTOCOL_VERSIONS, Response, Subscribe,
};
use crate::events::UnitEvents;
use crate::exec::Exec;
use crate::fetch::Fetch;
use crate::server::Service;
use crate::stream::Stream;
use crate::systemd::Systemd;
use crate::units::Paths;
use crate::verbs::{Params, SUBSCRIPTIONS, SubParams};

/// What time it is. Tests set their own.
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

#[must_use]
pub fn system_clock() -> Clock {
    Arc::new(SystemTime::now)
}

/// Everything a handler may touch, from environment variables. Tests swap `exec` for a fake.
pub struct Context {
    pub version: String,
    pub exec: Arc<dyn Exec>,
    pub now: Clock,
    /// Downloads; `curl` in production.
    pub fetch: Arc<dyn Fetch>,
    /// The CPU, as Rust names it: `x86_64` or `aarch64`.
    pub arch: String,
    /// Unit changes from systemd; `None` makes `service.wait` tell the panel to poll.
    pub events: Option<Arc<UnitEvents>>,
    /// systemd itself, over D-Bus; tests use a fake.
    pub systemd: Arc<dyn Systemd>,
    pub paths: Paths,
    /// The panel's group, which owns the agent's socket and shares server folders.
    pub panel_group: String,
    /// Where releases are downloaded from: `<url>/<tag>/<file>`.
    pub releases_url: String,
    /// The key releases are signed with, as a PEM `PUBLIC KEY`; tests use their own.
    pub release_key: String,
    /// Set while an update, a rollback or a clean-up of old releases runs.
    pub updating: Arc<AtomicBool>,
}

/// Runs one checked request.
///
/// # Errors
/// An [`AgentError`] that becomes the error response.
pub fn handle(params: &Params, ctx: &Context) -> Result<Value, AgentError> {
    match params {
        Params::Ping => Ok(json!({ "agentVersion": ctx.version, "protocol": PROTOCOL_VERSION })),
        Params::AgentHello => Ok(hello(ctx)),
        Params::ServiceStatus(p) => service::status(&p.server, ctx),
        Params::ServiceUsage(p) => Ok(service::usage(&p.servers, ctx)),
        Params::ServiceWait(p) => Ok(match &ctx.events {
            Some(events) => {
                let timeout = Duration::from_millis(u64::try_from(p.timeout_ms).unwrap_or(0));
                events.wait(&p.servers, p.after.as_deref(), timeout)
            }
            None => service::not_following(&p.servers),
        }),
        Params::ServiceStart(p) => service::action("start", &p.server, ctx),
        Params::ServiceStop(p) => service::action("stop", &p.server, ctx),
        Params::ServiceRestart(p) => service::action("restart", &p.server, ctx),
        Params::ServerCreate(p) => server::create(&p.name, p.port, p.memory_mb, p.java_major, ctx),
        Params::ServerConfigure(p) => {
            server::configure(&p.name, p.memory_mb, p.port, p.java_major, ctx)
        }
        Params::ServerPermissions(p) => server::permissions(&p.name, ctx),
        Params::ServerDelete(p) => server::remove(&p.name, ctx),
        Params::RuntimeInstall(p) => runtime::install(p.major, ctx),
        Params::SshStatus => Ok(ssh::status(ctx)),
        Params::SshSet(p) => ssh::set(p.open, p.minutes, ctx),
        Params::UpdateStatus => Ok(update::status(ctx)),
        Params::UpdateInstall(p) => update::install(&p.version, ctx),
        Params::UpdateRollback(p) => update::rollback(&p.version, ctx),
        Params::DiskUsage(p) => Ok(disk::usage(&p.servers, p.system, ctx)),
        Params::DiskVacuumJournal(p) => disk::vacuum_journal(p.max_mb, ctx),
        Params::DiskCleanApt => disk::clean_apt(ctx),
        Params::DiskPruneFlytower => disk::prune_flytower(ctx),
        Params::ServerExpose(p) => server::expose(&p.name, p.port, p.public, ctx),
        Params::RouterEnable(p) => router::enable(p.port, ctx),
        Params::RouterDisable => router::disable(ctx),
    }
}

/// True if this build starts `verb`. The `testing.*` subscriptions exist only in test builds
/// (the `testing` feature).
#[must_use]
pub fn offers(verb: &str) -> bool {
    cfg!(feature = "testing") || !verb.starts_with("testing.")
}

/// What `agent.hello` says: which agent this is and what it can do, so the panel can choose
/// between subscriptions and the protocol 1 ways.
#[must_use]
pub fn hello(ctx: &Context) -> Value {
    let subscriptions: Vec<&str> = SUBSCRIPTIONS
        .into_iter()
        .filter(|v| offers(v) && (*v != "service.events" || ctx.events.is_some()))
        .collect();
    json!({
        "kind": "rust",
        "version": ctx.version,
        "protocols": PROTOCOL_VERSIONS,
        "subscriptions": subscriptions,
    })
}

/// Starts one checked subscription.
///
/// # Errors
/// An [`AgentError`] that becomes the error response.
pub fn subscribe(params: &SubParams, ctx: &Arc<Context>) -> Result<(Value, Stream), AgentError> {
    match params {
        SubParams::LogFollow(p) => Ok((
            json!({}),
            crate::logs::follow(
                std::path::Path::new(&ctx.paths.servers).join(&p.server),
                p.seed_bytes,
                p.crashes.unwrap_or(false),
            )?,
        )),
        SubParams::ServiceEvents(p) => streams::service_events(p.servers.clone(), ctx),
        SubParams::TestingTicks(p) if offers("testing.ticks") => Ok((
            json!({}),
            streams::ticks(p.count, Duration::from_millis(p.interval_ms)),
        )),
        SubParams::TestingTicks(_) => Err(AgentError::new(
            ErrorCode::UnknownVerb,
            "unknown subscription \"testing.ticks\"",
        )),
    }
}

/// Where audit lines go.
pub type AuditLog = Arc<dyn Fn(String) + Send + Sync>;

/// The agent as the socket server sees it: requests through [`handle`] and subscriptions
/// through [`subscribe`], each written to the audit log.
pub struct Agent {
    pub ctx: Arc<Context>,
    pub log: AuditLog,
}

impl Service for Agent {
    fn call(&self, line: &str) -> Response {
        dispatch(line, |p| handle(&p, &self.ctx), |a| (self.log)(a))
    }

    fn subscribe(&self, sub: &Subscribe) -> Result<(Value, Stream), AgentError> {
        dispatch_subscribe(sub, |p| subscribe(&p, &self.ctx), |a| (self.log)(a))
    }

    fn ended(&self, sub: &Subscribe, end: &End, lasted: Duration) {
        (self.log)(end_line(SystemTime::now(), sub, end, lasted.as_millis()));
    }
}
