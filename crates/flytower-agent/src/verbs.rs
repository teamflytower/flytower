//! Every operation the agent performs, matching `packages/protocol/src/verbs.ts`. The agent
//! refuses anything not listed here, so this list is the whole of the panel's root access.
//!
//! Params are strict: unknown keys are refused, so nothing extra reaches root. Results are
//! checked before they're sent. The shared fixtures in `protocol/fixtures` keep this and the
//! panel's Zod schemas in step (see `tests/fixtures.rs`).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// A field that must be present but may be `null` (Zod's `.nullable()` without `.optional()`).
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}

/// A server's short name: used in unit names, user names and paths, so kept strict.
/// `^[a-z][a-z0-9-]{1,30}$`, not ending in a hyphen.
#[must_use]
pub fn is_server_name(name: &str) -> bool {
    let b = name.as_bytes();
    (2..=31).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && !name.ends_with('-')
}

/// A release version: `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`.
#[must_use]
pub fn is_version(v: &str) -> bool {
    let (main, pre) = match v.split_once('-') {
        Some((m, p)) => (m, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = main.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(|p| {
            !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.')
        })
}

fn check(ok: bool, message: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(message.to_string()) }
}

fn server(name: &str) -> Result<(), String> {
    check(
        is_server_name(name),
        "lowercase letters, digits and hyphens, 2 to 31 characters, starting with a letter, \
         not ending with a hyphen",
    )
}

fn port(p: i64) -> Result<(), String> {
    check(
        (1024..=65535).contains(&p),
        "port must be from 1024 to 65535",
    )
}

fn memory(mb: i64) -> Result<(), String> {
    check(
        (512..=262_144).contains(&mb),
        "memoryMb must be from 512 to 262144",
    )
}

fn java(major: i64) -> Result<(), String> {
    check((8..=99).contains(&major), "javaMajor must be from 8 to 99")
}

fn servers(list: &[String]) -> Result<(), String> {
    check(list.len() <= 100, "at most 100 servers")?;
    list.iter().try_for_each(|s| server(s))
}

fn version(v: &str) -> Result<(), String> {
    check(is_version(v), "not a release version")
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerParam {
    pub server: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NameParam {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageParams {
    pub servers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WaitParams {
    pub servers: Vec<String>,
    #[serde(deserialize_with = "nullable")]
    pub after: Option<String>,
    pub timeout_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeParams {
    pub vendor: String,
    pub major: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateParams {
    pub name: String,
    pub port: i64,
    pub memory_mb: i64,
    pub java_major: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConfigureParams {
    pub name: String,
    #[serde(default)]
    pub memory_mb: Option<i64>,
    #[serde(default)]
    pub port: Option<i64>,
    #[serde(default)]
    pub java_major: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SshSetParams {
    pub open: bool,
    #[serde(default)]
    pub minutes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiskUsageParams {
    pub servers: Vec<String>,
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VacuumParams {
    pub max_mb: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionParam {
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExposeParams {
    pub name: String,
    pub port: i64,
    pub public: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortParam {
    pub port: i64,
}

/// A request's params, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Params {
    Ping,
    AgentHello,
    ServiceStatus(ServerParam),
    ServiceUsage(UsageParams),
    ServiceWait(WaitParams),
    ServiceStart(ServerParam),
    ServiceStop(ServerParam),
    ServiceRestart(ServerParam),
    RuntimeInstall(RuntimeParams),
    ServerCreate(CreateParams),
    ServerConfigure(ConfigureParams),
    ServerPermissions(NameParam),
    SshStatus,
    SshSet(SshSetParams),
    UpdateStatus,
    UpdateInstall(VersionParam),
    UpdateRollback(VersionParam),
    ServerDelete(NameParam),
    DiskUsage(DiskUsageParams),
    DiskVacuumJournal(VacuumParams),
    DiskCleanApt,
    DiskPruneFlytower,
    ServerExpose(ExposeParams),
    RouterEnable(PortParam),
    RouterDisable,
}

/// Every verb, in the same order as `verbs.ts`.
pub const VERBS: [&str; 25] = [
    "ping",
    "agent.hello",
    "service.status",
    "service.usage",
    "service.wait",
    "service.start",
    "service.stop",
    "service.restart",
    "runtime.install",
    "server.create",
    "server.configure",
    "server.permissions",
    "ssh.status",
    "ssh.set",
    "update.status",
    "update.install",
    "update.rollback",
    "server.delete",
    "disk.usage",
    "disk.vacuum-journal",
    "disk.clean-apt",
    "disk.prune-flytower",
    "server.expose",
    "router.enable",
    "router.disable",
];

fn de<T: DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}

impl Params {
    /// Checks `params` for `verb`. `Ok(None)` means the verb doesn't exist.
    ///
    /// # Errors
    /// A message saying what's wrong with the params.
    pub fn parse(verb: &str, params: &Value) -> Result<Option<Self>, String> {
        let p = match verb {
            "ping" => de::<Empty>(params).map(|_| Self::Ping)?,
            "agent.hello" => de::<Empty>(params).map(|_| Self::AgentHello)?,
            "service.status" | "service.start" | "service.stop" | "service.restart" => {
                let p: ServerParam = de(params)?;
                server(&p.server)?;
                match verb {
                    "service.status" => Self::ServiceStatus(p),
                    "service.start" => Self::ServiceStart(p),
                    "service.stop" => Self::ServiceStop(p),
                    _ => Self::ServiceRestart(p),
                }
            }
            "service.usage" => {
                let p: UsageParams = de(params)?;
                servers(&p.servers)?;
                Self::ServiceUsage(p)
            }
            "service.wait" => {
                let p: WaitParams = de(params)?;
                servers(&p.servers)?;
                check(
                    p.after.as_ref().is_none_or(|a| a.chars().count() <= 64),
                    "after is at most 64 characters",
                )?;
                check(
                    (1000..=300_000).contains(&p.timeout_ms),
                    "timeoutMs must be from 1000 to 300000",
                )?;
                Self::ServiceWait(p)
            }
            "runtime.install" => {
                let p: RuntimeParams = de(params)?;
                check(p.vendor == "temurin", "vendor must be temurin")?;
                check((8..=99).contains(&p.major), "major must be from 8 to 99")?;
                Self::RuntimeInstall(p)
            }
            "server.create" => {
                let p: CreateParams = de(params)?;
                server(&p.name)?;
                port(p.port)?;
                memory(p.memory_mb)?;
                java(p.java_major)?;
                Self::ServerCreate(p)
            }
            "server.configure" => {
                let p: ConfigureParams = de(params)?;
                server(&p.name)?;
                p.memory_mb.map_or(Ok(()), memory)?;
                p.port.map_or(Ok(()), port)?;
                p.java_major.map_or(Ok(()), java)?;
                check(
                    p.memory_mb.is_some() || p.port.is_some() || p.java_major.is_some(),
                    "nothing to change",
                )?;
                Self::ServerConfigure(p)
            }
            "server.permissions" | "server.delete" => {
                let p: NameParam = de(params)?;
                server(&p.name)?;
                if verb == "server.delete" {
                    Self::ServerDelete(p)
                } else {
                    Self::ServerPermissions(p)
                }
            }
            "ssh.status" => de::<Empty>(params).map(|_| Self::SshStatus)?,
            "ssh.set" => {
                let p: SshSetParams = de(params)?;
                p.minutes.map_or(Ok(()), |m| {
                    check((1..=1440).contains(&m), "minutes must be from 1 to 1440")
                })?;
                check(
                    p.open || p.minutes.is_none(),
                    "minutes only applies when opening",
                )?;
                Self::SshSet(p)
            }
            "update.status" => de::<Empty>(params).map(|_| Self::UpdateStatus)?,
            "update.install" | "update.rollback" => {
                let p: VersionParam = de(params)?;
                version(&p.version)?;
                if verb == "update.install" {
                    Self::UpdateInstall(p)
                } else {
                    Self::UpdateRollback(p)
                }
            }
            _ => return Self::parse_disk(verb, params),
        };
        Ok(Some(p))
    }

    /// The `disk.*` verbs.
    fn parse_disk(verb: &str, params: &Value) -> Result<Option<Self>, String> {
        let p = match verb {
            "disk.usage" => {
                let p: DiskUsageParams = de(params)?;
                servers(&p.servers)?;
                Self::DiskUsage(p)
            }
            "disk.vacuum-journal" => {
                let p: VacuumParams = de(params)?;
                check(
                    (16..=100_000).contains(&p.max_mb),
                    "maxMb must be from 16 to 100000",
                )?;
                Self::DiskVacuumJournal(p)
            }
            "disk.clean-apt" => de::<Empty>(params).map(|_| Self::DiskCleanApt)?,
            "disk.prune-flytower" => de::<Empty>(params).map(|_| Self::DiskPruneFlytower)?,
            "server.expose" => {
                let p: ExposeParams = de(params)?;
                server(&p.name)?;
                port(p.port)?;
                Self::ServerExpose(p)
            }
            "router.enable" => {
                let p: PortParam = de(params)?;
                port(p.port)?;
                Self::RouterEnable(p)
            }
            "router.disable" => de::<Empty>(params).map(|_| Self::RouterDisable)?,
            _ => return Ok(None),
        };
        Ok(Some(p))
    }
}

// ---------------------------------------------------------------- results

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmptyResult {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub agent_version: String,
    pub protocol: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Rust,
    Bun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResult {
    pub kind: AgentKind,
    pub version: String,
    pub protocols: Vec<u32>,
    pub subscriptions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActiveState {
    Active,
    Inactive,
    Activating,
    Deactivating,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExitKind {
    Exited,
    Killed,
    Dumped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub active: ActiveState,
    #[serde(deserialize_with = "nullable")]
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restarts: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_kind: Option<ExitKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub active: bool,
    #[serde(deserialize_with = "nullable")]
    pub cpu_ns: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub memory_bytes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageResult {
    pub usage: std::collections::BTreeMap<String, Usage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitResult {
    pub cursor: String,
    pub changed: Vec<String>,
    pub following: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResult {
    pub java_home: String,
    pub version: String,
    pub already_installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateResult {
    pub directory: String,
    pub user: String,
    pub unit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshState {
    /// True if any firewall rule lets SSH in.
    pub open: bool,
    pub ports: Vec<i64>,
    /// When a temporary opening ends, as an ISO time.
    #[serde(deserialize_with = "nullable")]
    pub closes_at: Option<String>,
    /// False if ufw is inactive, in which case nothing can be closed.
    pub firewall: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateState {
    Running,
    Succeeded,
    RolledBack,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRecord {
    pub state: UpdateState,
    pub from: String,
    pub to: String,
    #[serde(deserialize_with = "nullable")]
    pub reason: Option<String>,
    pub at: String,
    pub manual: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateStatusResult {
    pub current: String,
    pub releases: Vec<String>,
    #[serde(deserialize_with = "nullable")]
    pub last: Option<UpdateRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartedResult {
    pub started: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    #[serde(deserialize_with = "nullable")]
    pub archived_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerDiskGroups {
    pub world: u64,
    pub logs: u64,
    pub content: u64,
    pub map: u64,
    pub backups: u64,
    pub exports: u64,
    pub other: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerDisk {
    pub groups: ServerDiskGroups,
    pub unreadable: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedDisk {
    pub imports: u64,
    pub archive: u64,
    pub unreadable: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDisk {
    pub java: u64,
    pub flytower: u64,
    pub logs: u64,
    pub temp: u64,
    pub unreadable: u64,
    pub journal: u64,
    pub apt_cache: u64,
    pub old_releases: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskUsageResult {
    pub servers: std::collections::BTreeMap<String, ServerDisk>,
    #[serde(deserialize_with = "nullable")]
    pub shared: Option<SharedDisk>,
    #[serde(deserialize_with = "nullable")]
    pub system: Option<SystemDisk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreedResult {
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub freed_bytes: u64,
    pub removed: Vec<String>,
}

/// Checks a verb's result before it's sent.
///
/// # Errors
/// A message saying what's wrong, or that the verb doesn't exist.
pub fn check_result(verb: &str, result: &Value) -> Result<(), String> {
    match verb {
        "ping" => de::<PingResult>(result).map(drop),
        "agent.hello" => de::<HelloResult>(result).map(drop),
        "service.status" => de::<StatusResult>(result).map(drop),
        "service.usage" => de::<UsageResult>(result).map(drop),
        "service.wait" => de::<WaitResult>(result).map(drop),
        "service.start" | "service.stop" | "service.restart" | "server.configure"
        | "server.permissions" | "server.expose" | "router.enable" | "router.disable" => {
            de::<EmptyResult>(result).map(drop)
        }
        "runtime.install" => de::<RuntimeResult>(result).map(drop),
        "server.create" => de::<CreateResult>(result).map(drop),
        "ssh.status" | "ssh.set" => de::<SshState>(result).map(drop),
        "update.status" => de::<UpdateStatusResult>(result).map(drop),
        "update.install" | "update.rollback" => check(
            de::<StartedResult>(result)?.started,
            "started is always true",
        ),
        "server.delete" => de::<DeleteResult>(result).map(drop),
        "disk.usage" => de::<DiskUsageResult>(result).map(drop),
        "disk.vacuum-journal" | "disk.clean-apt" => de::<FreedResult>(result).map(drop),
        "disk.prune-flytower" => de::<PruneResult>(result).map(drop),
        _ => Err(format!("unknown verb {verb}")),
    }
}

// ---------------------------------------------------------------- subscriptions (protocol 2)

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicksParams {
    pub count: u64,
    pub interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LogFollowParams {
    pub server: String,
    pub seed_bytes: u64,
    #[serde(default)]
    pub crashes: Option<bool>,
}

/// A subscription's params, checked. Like [`Params`], the list is the whole of what the panel
/// can follow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubParams {
    /// Each server's state now, then every change to it.
    ServiceEvents(UsageParams),
    /// A server's `logs/latest.log`, line by line, and new crash reports if asked.
    LogFollow(LogFollowParams),
    /// Counts to `count`, one event every `interval_ms`. Only test builds start it.
    TestingTicks(TicksParams),
}

/// Every subscription verb, in the same order as `subscriptions` in `verbs.ts`.
pub const SUBSCRIPTIONS: [&str; 3] = ["log.follow", "service.events", "testing.ticks"];

impl SubParams {
    /// Checks `params` for the subscription `verb`. `Ok(None)` means it doesn't exist.
    ///
    /// # Errors
    /// A message saying what's wrong with the params.
    pub fn parse(verb: &str, params: &Value) -> Result<Option<Self>, String> {
        let p = match verb {
            "log.follow" => {
                let p: LogFollowParams = de(params)?;
                server(&p.server)?;
                check(
                    p.seed_bytes <= 1_048_576,
                    "seedBytes must be from 0 to 1048576",
                )?;
                Self::LogFollow(p)
            }
            "service.events" => {
                let p: UsageParams = de(params)?;
                servers(&p.servers)?;
                Self::ServiceEvents(p)
            }
            "testing.ticks" => {
                let p: TicksParams = de(params)?;
                check(
                    (1..=100_000).contains(&p.count),
                    "count must be from 1 to 100000",
                )?;
                check(
                    p.interval_ms <= 60_000,
                    "intervalMs must be from 0 to 60000",
                )?;
                Self::TestingTicks(p)
            }
            _ => return Ok(None),
        };
        Ok(Some(p))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceStates {
    pub states: std::collections::BTreeMap<String, StatusResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceChange {
    pub server: String,
    pub status: StatusResult,
}

/// A `log.follow` event: exactly one of `seed` or `lines` (at least one line each), or
/// `crash`, a report's path inside the server's folder.
fn check_log_event(event: &Value) -> Result<(), String> {
    let obj = event.as_object().ok_or("not an object")?;
    let lines = |v: &Value| {
        v.as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string))
    };
    let ok = obj.len() == 1
        && match (obj.get("seed"), obj.get("lines"), obj.get("crash")) {
            (Some(s), None, None) => lines(s),
            (None, Some(l), None) => lines(l),
            (None, None, Some(c)) => c.is_string(),
            _ => false,
        };
    check(ok, "not a log.follow event")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TickEvent {
    pub n: u64,
}

/// Checks the answer to a subscribe, before it's sent.
///
/// # Errors
/// A message saying what's wrong, or that the verb doesn't exist.
pub fn check_sub_result(verb: &str, result: &Value) -> Result<(), String> {
    match verb {
        "service.events" => de::<ServiceStates>(result).map(drop),
        "log.follow" | "testing.ticks" => de::<EmptyResult>(result).map(drop),
        _ => Err(format!("unknown subscription {verb}")),
    }
}

/// Checks one event of a subscription.
///
/// # Errors
/// A message saying what's wrong, or that the verb doesn't exist.
pub fn check_event(verb: &str, event: &Value) -> Result<(), String> {
    match verb {
        "log.follow" => check_log_event(event),
        "service.events" => de::<ServiceChange>(event).and_then(|c| server(&c.server)),
        "testing.ticks" => check(de::<TickEvent>(event)?.n >= 1, "n counts from 1"),
        _ => Err(format!("unknown subscription {verb}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_names() {
        for ok in ["survival", "creative-2", "ab"] {
            assert!(is_server_name(ok), "{ok}");
        }
        for bad in [
            "",
            "a",
            "2fast",
            "Survival",
            "has_underscore",
            "trailing-",
            "../etc",
        ] {
            assert!(!is_server_name(bad), "{bad}");
        }
        assert!(!is_server_name(&"a".repeat(32)));
        assert!(is_server_name(&"a".repeat(31)));
    }

    #[test]
    fn versions() {
        for ok in ["1.2.0", "1.2.0-beta.2", "1.2.0-beta.2.native.1", "10.20.30"] {
            assert!(is_version(ok), "{ok}");
        }
        for bad in [
            "latest",
            "v1.2.0",
            "1.2",
            "1.2.0-",
            "1.2.0/../../etc",
            "1.2.0-a_b",
        ] {
            assert!(!is_version(bad), "{bad}");
        }
    }

    #[test]
    fn every_verb_is_known() {
        for verb in VERBS {
            assert!(check_result(verb, &Value::Null).is_err());
            assert!(
                !matches!(check_result(verb, &Value::Null), Err(e) if e.starts_with("unknown"))
            );
        }
    }
}
