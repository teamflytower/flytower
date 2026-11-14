//! Talks to the agent over a real Unix socket, as the panel does.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::thread;

use std::time::Duration;

use flytower_agent::dispatch::dispatch;
use flytower_agent::envelope::{AgentError, ErrorCode, MAX_LINE_BYTES, Response, Subscribe};
use flytower_agent::exec::{Exec, RealExec};
use flytower_agent::fetch::Curl;
use flytower_agent::handlers::streams::ticks;
use flytower_agent::handlers::{Agent, Context, handle, system_clock};
use flytower_agent::server::{ListenOptions, Service, bind, calls, serve, serve_at_most};
use flytower_agent::stream::Stream;
use flytower_agent::units::Paths;
use serde_json::{Value, json};

#[test]
fn answers_in_order_over_a_socket() {
    let dir = std::env::temp_dir().join(format!("flytower-agent-socket-{}", std::process::id()));
    let opts = ListenOptions {
        socket_path: dir.join("agent.sock"),
        group: None,
    };
    let listener = bind(&opts).unwrap();
    let mode = std::fs::metadata(&opts.socket_path)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o660);

    let exec: Arc<dyn Exec> = Arc::new(RealExec::default());
    let ctx = Context {
        version: "1.2.0-test".into(),
        exec: Arc::clone(&exec),
        now: system_clock(),
        fetch: Arc::new(Curl {
            exec: Arc::clone(&exec),
        }),
        arch: std::env::consts::ARCH.into(),
        events: None,
        systemd: Arc::new(flytower_agent::systemd::Bus::new()),
        paths: Paths::under(&dir),
        panel_group: "flytower".into(),
        releases_url: String::new(),
        release_key: String::new(),
        updating: Arc::default(),
    };
    thread::spawn(move || {
        serve(
            &listener,
            None,
            calls(move |line| dispatch(line, |p| handle(&p, &ctx), drop)),
        );
    });

    let mut stream = UnixStream::connect(&opts.socket_path).unwrap();
    // Two requests in one write, the second split across writes.
    stream
        .write_all(b"{\"id\":\"a\",\"verb\":\"ping\",\"params\":{}}\n{\"id\":\"b\",\"verb\":\"service.start\",")
        .unwrap();
    stream.write_all(b"\"params\":{}}\n").unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut read = || {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        line
    };
    let first: Value = serde_json::from_str(&read()).unwrap();
    assert_eq!(
        first,
        json!({ "id": "a", "ok": true, "result": { "agentVersion": "1.2.0-test", "protocol": 1 } })
    );
    let second: Value = serde_json::from_str(&read()).unwrap();
    assert_eq!(
        (second["id"].as_str(), second["error"]["code"].as_str()),
        (Some("b"), Some("invalid_params"))
    );

    // An overlong line drops the connection.
    stream.write_all(&vec![b'x'; MAX_LINE_BYTES + 1]).unwrap();
    assert_eq!(read(), "");

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn turns_away_connections_over_the_limit_and_frees_their_slots() {
    let dir = std::env::temp_dir().join(format!("flytower-agent-cap-{}", std::process::id()));
    let opts = ListenOptions {
        socket_path: dir.join("agent.sock"),
        group: None,
    };
    let listener = bind(&opts).unwrap();
    thread::spawn(move || {
        serve_at_most(&listener, None, 2, calls(|_| Response::ok("x", json!({}))));
    });
    let ask = |stream: &mut UnixStream| {
        let _ = stream.write_all(b"{}\n");
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    let mut first = UnixStream::connect(&opts.socket_path).unwrap();
    let mut second = UnixStream::connect(&opts.socket_path).unwrap();
    assert_eq!(ask(&mut first)["ok"], true);
    assert_eq!(ask(&mut second)["ok"], true);
    // A third is told the agent is busy, then closed.
    let mut third = UnixStream::connect(&opts.socket_path).unwrap();
    let mut line = String::new();
    BufReader::new(third.try_clone().unwrap())
        .read_line(&mut line)
        .unwrap();
    let busy: Value = serde_json::from_str(&line).unwrap();
    assert!(busy["error"]["message"].as_str().unwrap().contains("busy"));
    let _ = third.write_all(b"{}\n");
    // Closing one frees its slot.
    drop(first);
    let mut freed = None;
    for _ in 0..50 {
        let mut again = UnixStream::connect(&opts.socket_path).unwrap();
        if ask(&mut again)["ok"] == true {
            freed = Some(again);
            break;
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(freed.is_some());
    drop(second);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Answers requests with an empty result and serves `testing.ticks` whatever the build, so the
/// subscription machinery is tested without the `testing` feature.
struct Ticks;

impl Service for Ticks {
    fn call(&self, line: &str) -> Response {
        let id = serde_json::from_str::<Value>(line).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        Response::ok(id, json!({}))
    }

    fn subscribe(&self, sub: &Subscribe) -> Result<(Value, Stream), AgentError> {
        if sub.verb != "testing.ticks" {
            return Err(AgentError::new(ErrorCode::UnknownVerb, "unknown"));
        }
        let count = sub.params["count"].as_u64().unwrap();
        let ms = sub.params["intervalMs"].as_u64().unwrap();
        Ok((json!({}), ticks(count, Duration::from_millis(ms))))
    }
}

struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Client {
    fn connect(label: &str) -> (Self, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("flytower-agent-sub-{label}-{}", std::process::id()));
        let opts = ListenOptions {
            socket_path: dir.join("agent.sock"),
            group: None,
        };
        let listener = bind(&opts).unwrap();
        thread::spawn(move || serve(&listener, None, Ticks));
        let stream = UnixStream::connect(&opts.socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let reader = BufReader::new(stream.try_clone().unwrap());
        (Self { stream, reader }, dir)
    }

    fn send(&mut self, v: &Value) {
        self.stream.write_all(format!("{v}\n").as_bytes()).unwrap();
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or(Value::Null)
    }
}

fn ticks_request(id: &str, count: u64, ms: u64) -> Value {
    json!({ "id": id, "subscribe": "testing.ticks", "params": { "count": count, "intervalMs": ms } })
}

#[test]
fn streams_a_subscription_beside_requests() {
    let (mut c, dir) = Client::connect("stream");
    c.send(&ticks_request("t", 3, 50));
    assert_eq!(c.read(), json!({ "id": "t", "ok": true, "result": {} }));
    assert_eq!(c.read(), json!({ "id": "t", "event": { "n": 1 } }));
    // A request on the same connection is answered between events.
    c.send(&json!({ "id": "r", "verb": "ping", "params": {} }));
    let mut seen = Vec::new();
    loop {
        let f = c.read();
        let end = f.get("end").is_some();
        seen.push(f);
        if end {
            break;
        }
    }
    assert!(seen.contains(&json!({ "id": "r", "ok": true, "result": {} })));
    assert!(seen.contains(&json!({ "id": "t", "event": { "n": 3 } })));
    assert_eq!(
        seen.last().unwrap(),
        &json!({ "id": "t", "end": true, "reason": "finished" })
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn cancels_a_subscription() {
    let (mut c, dir) = Client::connect("cancel");
    c.send(&ticks_request("t", 1000, 20));
    assert_eq!(c.read()["ok"], true);
    assert_eq!(c.read()["event"]["n"], 1);
    c.send(&json!({ "id": "t", "cancel": true }));
    let end = loop {
        let f = c.read();
        if f.get("end").is_some() {
            break f;
        }
    };
    assert_eq!(
        end,
        json!({ "id": "t", "end": true, "reason": "cancelled" })
    );
    // The id is free again.
    c.send(&ticks_request("t", 1, 0));
    assert_eq!(c.read()["ok"], true);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn refuses_bad_subscriptions() {
    let (mut c, dir) = Client::connect("refuse");
    c.send(&json!({ "id": "u", "subscribe": "nope", "params": {} }));
    assert_eq!(c.read()["error"]["code"], "unknown_verb");
    c.send(&json!({ "id": "b", "subscribe": "testing.ticks" }));
    assert_eq!(c.read()["error"]["code"], "bad_request");
    c.send(&json!({ "id": "b", "cancel": "yes" }));
    assert_eq!(c.read()["error"]["code"], "bad_request");
    c.send(&ticks_request("same", 1000, 1000));
    assert_eq!(c.read()["ok"], true);
    assert_eq!(c.read()["event"]["n"], 1);
    c.send(&ticks_request("same", 1, 0));
    assert_eq!(
        c.read(),
        json!({ "id": "same", "ok": false, "error": { "code": "bad_request", "message": "that id is already in use on this connection" } })
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn holds_at_most_64_subscriptions_per_connection() {
    let (mut c, dir) = Client::connect("limit");
    for n in 0..64 {
        c.send(&ticks_request(&format!("s{n}"), 1000, 60_000));
    }
    let mut acks = 0;
    while acks < 64 {
        if c.read()["ok"] == true {
            acks += 1;
        }
    }
    c.send(&ticks_request("one-more", 1, 0));
    let refused = loop {
        let f = c.read();
        if f["id"] == "one-more" {
            break f;
        }
    };
    assert_eq!(refused["error"]["code"], "conflict");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn says_hello() {
    let dir = std::env::temp_dir().join(format!("flytower-agent-hello-{}", std::process::id()));
    let exec: Arc<dyn Exec> = Arc::new(RealExec::default());
    let ctx = Context {
        version: "1.5.0-test".into(),
        exec: Arc::clone(&exec),
        now: system_clock(),
        fetch: Arc::new(Curl {
            exec: Arc::clone(&exec),
        }),
        arch: std::env::consts::ARCH.into(),
        events: None,
        systemd: Arc::new(flytower_agent::systemd::Bus::new()),
        paths: Paths::under(&dir),
        panel_group: "flytower".into(),
        releases_url: String::new(),
        release_key: String::new(),
        updating: Arc::default(),
    };
    let agent = Agent {
        ctx: Arc::new(ctx),
        log: Arc::new(drop),
    };
    let res: Value = serde_json::from_str(
        &agent
            .call(r#"{"id":"h","verb":"agent.hello","params":{}}"#)
            .encode(),
    )
    .unwrap();
    let subscriptions: Vec<Value> = if cfg!(feature = "testing") {
        vec![json!("log.follow"), json!("testing.ticks")]
    } else {
        vec![json!("log.follow")]
    };
    assert_eq!(
        res["result"],
        json!({ "kind": "rust", "version": "1.5.0-test", "protocols": [1, 2], "subscriptions": subscriptions })
    );
    // Without the testing feature, testing.ticks doesn't start.
    let sub = Subscribe::parse(&ticks_request("t", 1, 0)).unwrap();
    assert_eq!(agent.subscribe(&sub).is_ok(), cfg!(feature = "testing"));
}
