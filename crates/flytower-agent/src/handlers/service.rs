//! Server services through systemd. For now this calls `systemctl`; talking to systemd over
//! D-Bus may come later (#235), behind the same functions.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::Context;
use crate::envelope::{AgentError, ErrorCode};

/// The systemd instance for a server.
#[must_use]
pub fn unit_name(server: &str) -> String {
    format!("flytower-mc@{server}.service")
}

const ACTIVE_STATES: [&str; 5] = ["active", "inactive", "activating", "deactivating", "failed"];

/// systemd prints this when it has no figure.
const UNSET: &str = "18446744073709551615";

fn systemctl(ctx: &Context, args: &[&str]) -> Result<String, AgentError> {
    let r = ctx.exec.run("systemctl", args);
    if r.code != 0 {
        let stderr = r.stderr.trim();
        let message = if stderr.is_empty() {
            format!("systemctl {} failed", args.first().unwrap_or(&""))
        } else {
            stderr.to_string()
        };
        return Err(AgentError::new(ErrorCode::Failed, message));
    }
    Ok(r.stdout)
}

/// Refuse to act on a unit systemd has never heard of, rather than letting systemctl guess.
fn assert_known(ctx: &Context, server: &str) -> Result<(), AgentError> {
    let unit = unit_name(server);
    let r = ctx.exec.run(
        "systemctl",
        &["show", &unit, "--property=LoadState", "--value"],
    );
    if r.stdout.trim() == "loaded" {
        Ok(())
    } else {
        Err(AgentError::new(
            ErrorCode::NotFound,
            format!("no server called {server}"),
        ))
    }
}

/// Splits `systemctl show a b c` output into one property map per unit.
#[must_use]
pub fn parse_show(stdout: &str) -> Vec<BTreeMap<String, String>> {
    let mut blocks = Vec::new();
    let mut current = BTreeMap::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else if let Some((key, value)) = line.split_once('=') {
            current.insert(key.to_string(), value.to_string());
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
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
/// `not_found` if systemd doesn't know the server.
pub fn status(server: &str, ctx: &Context) -> Result<Value, AgentError> {
    assert_known(ctx, server)?;
    let unit = unit_name(server);
    let r = ctx.exec.run(
        "systemctl",
        &[
            "show",
            &unit,
            "--property=ActiveState,ActiveEnterTimestamp,Result,NRestarts,ExecMainCode,ExecMainStatus",
        ],
    );
    let props = parse_show(&r.stdout).into_iter().next().unwrap_or_default();
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

/// `service.usage`: CPU time and memory systemd has counted for each server.
pub fn usage(servers: &[String], ctx: &Context) -> Value {
    if servers.is_empty() {
        return json!({ "usage": {} });
    }
    let units: BTreeMap<String, &String> = servers.iter().map(|s| (unit_name(s), s)).collect();
    let mut args = vec!["show"];
    args.extend(units.keys().map(String::as_str));
    args.push("--property=Id,ActiveState,CPUUsageNSec,MemoryCurrent");
    let r = ctx.exec.run("systemctl", &args);
    let figure = |v: Option<&String>| int(v.filter(|v| v.as_str() != UNSET));
    let mut out = serde_json::Map::new();
    for props in parse_show(&r.stdout) {
        let Some(server) = props.get("Id").and_then(|id| units.get(id)) else {
            continue;
        };
        let active = props.get("ActiveState").is_some_and(|s| s == "active");
        out.insert(
            (*server).clone(),
            json!({
                "active": active,
                "cpuNs": if active { figure(props.get("CPUUsageNSec")) } else { None },
                "memoryBytes": if active { figure(props.get("MemoryCurrent")) } else { None },
            }),
        );
    }
    json!({ "usage": out })
}

/// `service.wait` when the journal isn't being followed: says so straight away, and the panel
/// polls instead.
#[must_use]
pub fn not_following(servers: &[String]) -> Value {
    json!({ "cursor": "", "changed": servers, "following": false })
}

/// `service.start`, `service.stop` and `service.restart`.
///
/// # Errors
/// `not_found` for an unknown server, `failed` if systemctl fails.
pub fn action(verb: &str, server: &str, ctx: &Context) -> Result<Value, AgentError> {
    assert_known(ctx, server)?;
    let unit = unit_name(server);
    // A server left stopped after a crash loop has hit its start limit, and systemd refuses
    // to start it until that is cleared. Starting it from the panel is the person saying so.
    if verb != "stop" {
        ctx.exec.run("systemctl", &["reset-failed", &unit]);
    }
    systemctl(ctx, &[verb, &unit])?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::ExecResult;
    use crate::handlers::testing::{Fake, TempRoot};

    fn result(stdout: &str) -> ExecResult {
        ExecResult {
            stdout: stdout.to_string(),
            ..Default::default()
        }
    }

    fn fake(answers: Vec<(&str, ExecResult)>) -> (Context, Fake) {
        let fake = Fake::new(answers);
        let root = TempRoot::new("service");
        (fake.context(&root.paths), fake)
    }

    fn ctx(answers: &[(&str, &str)]) -> (Context, Fake) {
        fake(answers.iter().map(|(c, out)| (*c, result(out))).collect())
    }

    fn ran(fake: &Fake) -> Vec<String> {
        fake.ran()
    }

    const KNOWN: &str = "systemctl show flytower-mc@survival.service --property=LoadState --value";
    const STATUS: &str = "systemctl show flytower-mc@survival.service --property=ActiveState,ActiveEnterTimestamp,Result,NRestarts,ExecMainCode,ExecMainStatus";

    #[test]
    fn parses_show_output() {
        let out = "Id=a\nActiveState=active\n\nId=b\nX=1=2\n\n";
        let blocks = parse_show(out);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1]["X"], "1=2");
    }

    #[test]
    fn reports_status() {
        let (c, _) = ctx(&[
            (KNOWN, "loaded\n"),
            (
                STATUS,
                "ActiveState=failed\nActiveEnterTimestamp=Tue 2026-11-10 15:00:00 UTC\nResult=signal\nNRestarts=2\nExecMainCode=2\nExecMainStatus=9\n",
            ),
        ]);
        let s = status("survival", &c).unwrap();
        assert_eq!(
            s,
            json!({ "active": "failed", "since": "Tue 2026-11-10 15:00:00 UTC", "result": "signal", "restarts": 2, "exitKind": "killed", "exitStatus": 9 })
        );
        assert!(crate::verbs::check_result("service.status", &s).is_ok());
    }

    #[test]
    fn status_of_a_quiet_unit() {
        let (c, _) = ctx(&[
            (KNOWN, "loaded\n"),
            (
                STATUS,
                "ActiveState=weird\nActiveEnterTimestamp=\nExecMainCode=0\n",
            ),
        ]);
        let s = status("survival", &c).unwrap();
        assert_eq!(
            s,
            json!({ "active": "unknown", "since": null, "result": null, "restarts": null, "exitKind": null, "exitStatus": null })
        );
        assert!(crate::verbs::check_result("service.status", &s).is_ok());
    }

    #[test]
    fn refuses_unknown_servers() {
        let (c, r) = ctx(&[(KNOWN, "not-found\n")]);
        assert_eq!(
            status("survival", &c).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            action("start", "survival", &c).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(ran(&r).len(), 2, "nothing else ran");
    }

    #[test]
    fn starts_after_clearing_the_start_limit() {
        let (c, r) = ctx(&[(KNOWN, "loaded\n")]);
        action("start", "survival", &c).unwrap();
        assert_eq!(
            ran(&r)[1..],
            [
                "systemctl reset-failed flytower-mc@survival.service",
                "systemctl start flytower-mc@survival.service"
            ]
        );
        let (c, r) = ctx(&[(KNOWN, "loaded\n")]);
        action("stop", "survival", &c).unwrap();
        assert_eq!(
            ran(&r)[1..],
            ["systemctl stop flytower-mc@survival.service"]
        );
    }

    #[test]
    fn passes_systemctl_errors_on() {
        let denied = ExecResult {
            code: 1,
            stderr: "Access denied\n".into(),
            ..Default::default()
        };
        let (c, _) = fake(vec![
            (KNOWN, result("loaded\n")),
            ("systemctl stop flytower-mc@survival.service", denied),
        ]);
        let err = action("stop", "survival", &c).unwrap_err();
        assert_eq!(
            (err.code, err.message.as_str()),
            (ErrorCode::Failed, "Access denied")
        );
    }

    #[test]
    fn reports_usage() {
        let cmd = "systemctl show flytower-mc@creative.service flytower-mc@survival.service --property=Id,ActiveState,CPUUsageNSec,MemoryCurrent";
        let out = format!(
            "Id=flytower-mc@survival.service\nActiveState=active\nCPUUsageNSec=1200\nMemoryCurrent={UNSET}\n\nId=flytower-mc@creative.service\nActiveState=inactive\nCPUUsageNSec=5\nMemoryCurrent=10\n\nId=other.service\nActiveState=active\n"
        );
        let (c, _) = ctx(&[(cmd, &out)]);
        let u = usage(&["survival".into(), "creative".into()], &c);
        assert_eq!(
            u,
            json!({ "usage": {
                "creative": { "active": false, "cpuNs": null, "memoryBytes": null },
                "survival": { "active": true, "cpuNs": 1200, "memoryBytes": null },
            } })
        );
        assert!(crate::verbs::check_result("service.usage", &u).is_ok());
        let (none, r) = ctx(&[]);
        assert_eq!(usage(&[], &none), json!({ "usage": {} }));
        assert!(ran(&r).is_empty(), "no servers, no systemctl");
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
