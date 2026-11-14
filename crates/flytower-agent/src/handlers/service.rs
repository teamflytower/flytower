//! Server services through systemd, over D-Bus (`crate::systemd`), as systemctl would.

use serde_json::{Value, json};

use super::Context;
use crate::envelope::{AgentError, ErrorCode};

/// The systemd instance for a server.
#[must_use]
pub fn unit_name(server: &str) -> String {
    format!("flytower-mc@{server}.service")
}

const ACTIVE_STATES: [&str; 5] = ["active", "inactive", "activating", "deactivating", "failed"];

/// systemd says this when it has no figure.
const UNSET: &str = "18446744073709551615";

const STATUS: [&str; 6] = [
    "ActiveState",
    "ActiveEnterTimestamp",
    "Result",
    "NRestarts",
    "ExecMainCode",
    "ExecMainStatus",
];

const USAGE: [&str; 3] = ["ActiveState", "CPUUsageNSec", "MemoryCurrent"];

fn failed(message: String) -> AgentError {
    AgentError::new(ErrorCode::Failed, message)
}

/// Refuse to act on a unit systemd has never heard of, rather than letting it guess.
fn assert_known(ctx: &Context, server: &str) -> Result<(), AgentError> {
    let props = ctx
        .systemd
        .show(&unit_name(server), &["LoadState"])
        .map_err(failed)?;
    if props.get("LoadState").is_some_and(|s| s == "loaded") {
        Ok(())
    } else {
        Err(AgentError::new(
            ErrorCode::NotFound,
            format!("no server called {server}"),
        ))
    }
}

fn int(v: Option<&String>) -> Option<u64> {
    v.filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse().ok())
}

fn non_empty(v: Option<&String>) -> Option<&String> {
    v.filter(|v| !v.is_empty())
}

/// `service.status`.
///
/// # Errors
/// `not_found` if systemd doesn't know the server, `failed` if systemd can't be asked.
pub fn status(server: &str, ctx: &Context) -> Result<Value, AgentError> {
    assert_known(ctx, server)?;
    let props = ctx
        .systemd
        .show(&unit_name(server), &STATUS)
        .map_err(failed)?;
    let active = props
        .get("ActiveState")
        .map(String::as_str)
        .filter(|s| ACTIVE_STATES.contains(s))
        .unwrap_or("unknown");
    // ExecMainCode, from siginfo: CLD_EXITED, CLD_KILLED, CLD_DUMPED.
    let exit_kind = match props.get("ExecMainCode").map(String::as_str) {
        Some("1") => Some("exited"),
        Some("2") => Some("killed"),
        Some("3") => Some("dumped"),
        _ => None,
    };
    Ok(json!({
        "active": active,
        "since": non_empty(props.get("ActiveEnterTimestamp")),
        "result": non_empty(props.get("Result")),
        "restarts": int(props.get("NRestarts")),
        "exitKind": exit_kind,
        "exitStatus": exit_kind.and_then(|_| int(props.get("ExecMainStatus"))),
    }))
}

/// `service.usage`: CPU time and memory systemd has counted for each server. A server systemd
/// can't be asked about is left out, as before.
#[must_use]
pub fn usage(servers: &[String], ctx: &Context) -> Value {
    let figure = |v: Option<&String>| int(v.filter(|v| v.as_str() != UNSET));
    let mut out = serde_json::Map::new();
    let servers: std::collections::BTreeSet<&String> = servers.iter().collect();
    for server in servers {
        let Ok(props) = ctx.systemd.show(&unit_name(server), &USAGE) else {
            continue;
        };
        let active = props.get("ActiveState").is_some_and(|s| s == "active");
        out.insert(
            server.clone(),
            json!({
                "active": active,
                "cpuNs": if active { figure(props.get("CPUUsageNSec")) } else { None },
                "memoryBytes": if active { figure(props.get("MemoryCurrent")) } else { None },
            }),
        );
    }
    json!({ "usage": out })
}

/// `service.wait` when systemd isn't being followed: says so straight away, and the panel
/// polls instead.
#[must_use]
pub fn not_following(servers: &[String]) -> Value {
    json!({ "cursor": "", "changed": servers, "following": false })
}

/// `service.start`, `service.stop` and `service.restart`.
///
/// # Errors
/// `not_found` for an unknown server, `failed` if systemd refuses or the job fails.
pub fn action(verb: &str, server: &str, ctx: &Context) -> Result<Value, AgentError> {
    assert_known(ctx, server)?;
    let unit = unit_name(server);
    // A server left stopped after a crash loop has hit its start limit, and systemd refuses
    // to start it until that is cleared. Starting it from the panel is the person saying so.
    // A unit with nothing to clear answers with an error, which doesn't matter here.
    if verb != "stop" {
        let _ = ctx.systemd.reset_failed(&unit);
    }
    ctx.systemd.job(verb, &unit).map_err(failed)?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::testing::{FakeSystemd, TempRoot};
    use std::sync::Arc;

    fn ctx(systemd: &Arc<FakeSystemd>) -> (Context, TempRoot) {
        let root = TempRoot::new("service");
        let mut c = crate::handlers::testing::Fake::default().context(&root.paths);
        c.systemd = Arc::clone(systemd) as Arc<dyn crate::systemd::Systemd>;
        (c, root)
    }

    const UNIT: &str = "flytower-mc@survival.service";

    #[test]
    fn reports_status() {
        let sd = FakeSystemd::with(&[(
            UNIT,
            &[
                ("ActiveState", "failed"),
                ("ActiveEnterTimestamp", "Tue 2026-11-10 15:00:00 UTC"),
                ("Result", "signal"),
                ("NRestarts", "2"),
                ("ExecMainCode", "2"),
                ("ExecMainStatus", "9"),
            ],
        )]);
        let (c, _root) = ctx(&sd);
        let s = status("survival", &c).unwrap();
        assert_eq!(
            s,
            json!({ "active": "failed", "since": "Tue 2026-11-10 15:00:00 UTC", "result": "signal", "restarts": 2, "exitKind": "killed", "exitStatus": 9 })
        );
        assert!(crate::verbs::check_result("service.status", &s).is_ok());
    }

    #[test]
    fn status_of_a_quiet_unit() {
        let sd = FakeSystemd::with(&[(
            UNIT,
            &[
                ("ActiveState", "weird"),
                ("ActiveEnterTimestamp", ""),
                ("ExecMainCode", "0"),
            ],
        )]);
        let (c, _root) = ctx(&sd);
        let s = status("survival", &c).unwrap();
        assert_eq!(
            s,
            json!({ "active": "unknown", "since": null, "result": null, "restarts": null, "exitKind": null, "exitStatus": null })
        );
        assert!(crate::verbs::check_result("service.status", &s).is_ok());
    }

    #[test]
    fn refuses_unknown_servers() {
        let sd = FakeSystemd::with(&[]);
        let (c, _root) = ctx(&sd);
        assert_eq!(
            status("survival", &c).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            action("start", "survival", &c).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            sd.ran(),
            [
                format!("show {UNIT} LoadState"),
                format!("show {UNIT} LoadState")
            ],
            "nothing else ran"
        );
    }

    #[test]
    fn starts_after_clearing_the_start_limit() {
        let sd = FakeSystemd::with(&[(UNIT, &[])]);
        let (c, _root) = ctx(&sd);
        action("start", "survival", &c).unwrap();
        assert_eq!(
            sd.ran()[1..],
            [format!("reset-failed {UNIT}"), format!("start {UNIT}")]
        );
        let sd = FakeSystemd::with(&[(UNIT, &[])]);
        let (c, _root) = ctx(&sd);
        action("stop", "survival", &c).unwrap();
        assert_eq!(sd.ran()[1..], [format!("stop {UNIT}")]);
    }

    #[test]
    fn passes_systemd_errors_on() {
        let sd = FakeSystemd::with(&[(UNIT, &[])]);
        sd.fail("stop", "Access denied");
        let (c, _root) = ctx(&sd);
        let err = action("stop", "survival", &c).unwrap_err();
        assert_eq!(
            (err.code, err.message.as_str()),
            (ErrorCode::Failed, "Access denied")
        );
    }

    #[test]
    fn reports_usage() {
        let sd = FakeSystemd::with(&[
            (
                UNIT,
                &[
                    ("ActiveState", "active"),
                    ("CPUUsageNSec", "1200"),
                    ("MemoryCurrent", UNSET),
                ],
            ),
            (
                "flytower-mc@creative.service",
                &[
                    ("ActiveState", "inactive"),
                    ("CPUUsageNSec", "5"),
                    ("MemoryCurrent", "10"),
                ],
            ),
        ]);
        sd.fail("show flytower-mc@gone.service", "Connection refused");
        let (c, _root) = ctx(&sd);
        let u = usage(&["survival".into(), "creative".into(), "gone".into()], &c);
        assert_eq!(
            u,
            json!({ "usage": {
                "creative": { "active": false, "cpuNs": null, "memoryBytes": null },
                "survival": { "active": true, "cpuNs": 1200, "memoryBytes": null },
            } })
        );
        assert!(crate::verbs::check_result("service.usage", &u).is_ok());
        let none = FakeSystemd::with(&[]);
        let (c, _root) = ctx(&none);
        assert_eq!(usage(&[], &c), json!({ "usage": {} }));
        assert!(none.ran().is_empty(), "no servers, no systemd");
    }

    #[test]
    fn wait_falls_back_to_polling() {
        let w = not_following(&["survival".into()]);
        assert_eq!(
            w,
            json!({ "cursor": "", "changed": ["survival"], "following": false })
        );
        assert!(crate::verbs::check_result("service.wait", &w).is_ok());
    }
}
