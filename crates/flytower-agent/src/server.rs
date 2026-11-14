//! The Unix socket server. The kernel's `SO_PEERCRED` says who connected, and only root or
//! the panel's user may talk to the agent. The socket's file mode still guards it as before; this is a second lock. It
//! checks the user, not the group: servers share the panel's group so they can use the files
//! the panel puts in their folders.

use std::fs;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{PermissionsExt, chown};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::envelope::{
    AgentError, End, ErrorCode, MAX_LINE_BYTES, Response, Subscribe, parse_cancel,
};
use crate::stream::{MAX_SUBSCRIPTIONS, Outbox, Stream};

/// A connection idle this long is closed, unless it has live subscriptions.
pub const IDLE_TIMEOUT: Duration = Duration::from_mins(10);

/// A panel that takes no bytes for this long while the agent has something to send is
/// dropped, so a stuck panel can't hold a thread forever.
pub const WRITE_TIMEOUT: Duration = Duration::from_mins(1);

/// Stack for a subscription's thread. Streams wait and send; they don't recurse.
const STREAM_STACK: usize = 256 * 1024;

/// What the agent does with what a connection sends.
pub trait Service: Send + Sync + 'static {
    /// Answers one request line (protocol 1).
    fn call(&self, line: &str) -> Response;

    /// Checks a subscribe (protocol 2) and returns the answer to send and the stream to run.
    ///
    /// # Errors
    /// The error response to send instead; the subscription doesn't start.
    fn subscribe(&self, sub: &Subscribe) -> Result<(Value, Stream), AgentError> {
        let quoted = Value::String(sub.verb.clone()).to_string();
        Err(AgentError::new(
            ErrorCode::UnknownVerb,
            format!("unknown subscription {quoted}"),
        ))
    }

    /// Called once a subscription has ended, for the audit log.
    fn ended(&self, _sub: &Subscribe, _end: &End, _lasted: Duration) {}
}

/// A [`Service`] that answers requests with a plain function and knows no subscriptions.
pub struct Calls<F>(F);

/// Wraps `f` as a [`Service`]; see [`Calls`].
pub const fn calls<F>(f: F) -> Calls<F>
where
    F: Fn(&str) -> Response + Send + Sync + 'static,
{
    Calls(f)
}

impl<F> Service for Calls<F>
where
    F: Fn(&str) -> Response + Send + Sync + 'static,
{
    fn call(&self, line: &str) -> Response {
        (self.0)(line)
    }
}

/// At most this many connections are served at once. The panel opens one per call and closes
/// it after, so even a busy panel stays far below this; it guards against running out of
/// threads, which would bring the whole agent down.
pub const MAX_CONNECTIONS: usize = 64;

/// Counts a connection while it is open.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(open: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        open.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < max).then_some(n + 1)
        })
        .ok()
        .map(|_| Self(Arc::clone(open)))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct ListenOptions {
    pub socket_path: PathBuf,
    /// The group allowed to connect (the panel's). `None` skips chown and the peer check, for
    /// tests that don't run as root.
    pub group: Option<u32>,
}

/// Looks up a group id in an `/etc/group` style file.
///
/// # Errors
/// If the file can't be read or the group isn't in it.
pub fn group_id(name: &str, group_file: &Path) -> io::Result<u32> {
    id_in(name, group_file, "group")
}

/// Looks up a user id in an `/etc/passwd` style file.
///
/// # Errors
/// If the file can't be read or the user isn't in it.
pub fn user_id(name: &str, passwd_file: &Path) -> io::Result<u32> {
    id_in(name, passwd_file, "user")
}

/// The third field of the line whose first field is `name`; both files share that layout.
fn id_in(name: &str, file: &Path, kind: &str) -> io::Result<u32> {
    fs::read_to_string(file)?
        .lines()
        .find_map(|line| {
            let mut parts = line.split(':');
            let group = parts.next()?;
            let gid = parts.nth(1)?;
            (group == name).then(|| gid.parse().ok()).flatten()
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{kind} {name} not found")))
}

/// True if a peer with this uid may use the agent: root or the panel's user.
#[must_use]
pub const fn allowed(uid: u32, panel_uid: u32) -> bool {
    uid == 0 || uid == panel_uid
}

/// Creates the socket: directory 0750 and socket 0660, both `root:<panel group>`.
///
/// # Errors
/// If the directory or socket can't be made or given the right owner and mode.
pub fn bind(opts: &ListenOptions) -> io::Result<UnixListener> {
    let dir = opts.socket_path.parent().unwrap_or_else(|| Path::new("/"));
    fs::create_dir_all(dir)?;
    match fs::remove_file(&opts.socket_path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(&opts.socket_path)?;
    if let Some(gid) = opts.group {
        chown(dir, Some(0), Some(gid))?;
        chown(&opts.socket_path, Some(0), Some(gid))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o750))?;
    }
    fs::set_permissions(&opts.socket_path, fs::Permissions::from_mode(0o660))?;
    Ok(listener)
}

/// Accepts connections forever, one thread each, at most [`MAX_CONNECTIONS`] at once.
/// `handle` answers requests and starts subscriptions. `panel_uid` is the panel's user; `None`
/// skips the peer check, for tests.
pub fn serve<H: Service>(listener: &UnixListener, panel_uid: Option<u32>, handle: H) {
    serve_at_most(listener, panel_uid, MAX_CONNECTIONS, handle);
}

/// [`serve`] with a chosen limit, so tests can reach it.
pub fn serve_at_most<H: Service>(
    listener: &UnixListener,
    panel_uid: Option<u32>,
    max: usize,
    handle: H,
) {
    let handle = Arc::new(handle);
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let Some(slot) = Slot::take(&open, max) else {
            let busy = AgentError::new(ErrorCode::Failed, "the agent is busy; try again shortly");
            let _ = stream.write_all(Response::err("unknown", &busy).encode().as_bytes());
            continue;
        };
        let handle = Arc::clone(&handle);
        // If the system can't give us a thread, drop this connection rather than abort the
        // agent (a plain thread::spawn panics, and release builds abort on panic).
        let _ = thread::Builder::new().spawn(move || {
            let _slot = slot;
            // A connection that fails just ends; the panel reconnects.
            let _ = connection(stream, panel_uid, &handle);
        });
    }
}

fn connection<H: Service>(
    mut stream: UnixStream,
    panel_uid: Option<u32>,
    handle: &Arc<H>,
) -> io::Result<()> {
    if let Some(panel_uid) = panel_uid {
        let cred = rustix::net::sockopt::socket_peercred(&stream)?;
        if !allowed(cred.uid.as_raw(), panel_uid) {
            let refused = AgentError::new(ErrorCode::Forbidden, "only the panel may use the agent");
            stream.write_all(Response::err("unknown", &refused).encode().as_bytes())?;
            return Ok(());
        }
    }
    stream.set_read_timeout(Some(IDLE_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let out = Outbox::new();
    let mut writer = stream.try_clone()?;
    let writing = {
        let out = Arc::clone(&out);
        thread::Builder::new().spawn(move || {
            // A panel that stopped reading is dropped, which also ends the read below.
            if out.write_all(&mut writer).is_err() {
                let _ = writer.shutdown(Shutdown::Both);
            }
        })?
    };
    let read = read_requests(&mut stream, &out, handle);
    out.close_gracefully();
    let _ = writing.join();
    let _ = stream.shutdown(Shutdown::Both);
    read
}

/// Reads lines until the panel hangs up, answering requests and starting and cancelling
/// subscriptions. Requests are answered strictly in order, so a panel that wants to cancel a
/// subscription while a long request runs uses another connection for the request.
fn read_requests<H: Service>(
    stream: &mut UnixStream,
    out: &Arc<Outbox>,
    handle: &Arc<H>,
) -> io::Result<()> {
    let mut lines = Lines::default();
    let mut chunk = [0u8; 8192];
    loop {
        if out.is_closed() {
            return Ok(());
        }
        let n = match stream.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // The idle timeout only applies to a connection with nothing live.
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) && out.live() > 0 =>
            {
                continue;
            }
            Err(e) => return Err(e),
        };
        for line in lines.feed(&chunk[..n])? {
            match classify(&line) {
                Line::Subscribe(sub) => start(sub, handle, out),
                Line::Cancel(id) => out.cancel(&id),
                Line::Bad(message) => {
                    let bad = AgentError::new(ErrorCode::BadRequest, message);
                    out.reply(Response::err("unknown", &bad).encode());
                }
                Line::Request => out.reply(handle.call(&line).encode()),
            }
        }
    }
}

enum Line {
    Subscribe(Subscribe),
    Cancel(String),
    Bad(&'static str),
    /// Anything else is a request, or answered as a bad one by [`Service::call`].
    Request,
}

fn classify(line: &str) -> Line {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Line::Request;
    };
    let Some(obj) = value.as_object() else {
        return Line::Request;
    };
    if obj.contains_key("subscribe") {
        return Subscribe::parse(&value)
            .map_or(Line::Bad("not a valid subscribe envelope"), Line::Subscribe);
    }
    if obj.contains_key("cancel") {
        return parse_cancel(&value).map_or(Line::Bad("not a valid cancel envelope"), Line::Cancel);
    }
    Line::Request
}

/// Opens a subscription: the answer goes out first, then its stream runs on a thread of its
/// own until it ends, is cancelled or the connection closes.
fn start<H: Service>(sub: Subscribe, handle: &Arc<H>, out: &Arc<Outbox>) {
    let refuse = |code, message: &str| {
        out.reply(Response::err(sub.id.as_str(), &AgentError::new(code, message)).encode());
    };
    if out.has(&sub.id) {
        return refuse(
            ErrorCode::BadRequest,
            "that id is already in use on this connection",
        );
    }
    if out.live() >= MAX_SUBSCRIPTIONS {
        return refuse(
            ErrorCode::Conflict,
            "too many subscriptions on one connection",
        );
    }
    let (result, stream) = match handle.subscribe(&sub) {
        Ok(started) => started,
        Err(e) => return out.reply(Response::err(sub.id.as_str(), &e).encode()),
    };
    let sink = out.open(&sub.id, &sub.verb);
    out.reply(Response::ok(sub.id.as_str(), result).encode());
    let id = sub.id.clone();
    let spawned = {
        let (handle, out) = (Arc::clone(handle), Arc::clone(out));
        thread::Builder::new()
            .stack_size(STREAM_STACK)
            .spawn(move || {
                let began = Instant::now();
                let end = stream(&sink);
                let end = out.finish(sink.id(), end);
                handle.ended(&sub, &end, began.elapsed());
            })
    };
    if spawned.is_err() {
        let _ = out.finish(&id, End::failed("the agent is busy; try again shortly"));
    }
}

/// Splits a byte stream into lines, refusing any longer than [`MAX_LINE_BYTES`] (the caller
/// drops the connection). Blank lines are skipped.
#[derive(Default)]
pub struct Lines {
    buffer: Vec<u8>,
}

impl Lines {
    /// Adds `chunk` and returns the lines it completed.
    ///
    /// # Errors
    /// If the unfinished line is now too long.
    pub fn feed(&mut self, chunk: &[u8]) -> io::Result<Vec<String>> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line[..nl]);
            if !line.trim().is_empty() {
                out.push(line.into_owned());
            }
        }
        if self.buffer.len() > MAX_LINE_BYTES {
            self.buffer.clear();
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines() {
        let mut l = Lines::default();
        assert_eq!(l.feed(b"{\"a\":").unwrap(), Vec::<String>::new());
        assert_eq!(
            l.feed(b"1}\n\n  \n{\"b\":2}\n{").unwrap(),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
        // A character split across chunks survives.
        let pound = "£".as_bytes();
        assert!(l.feed(&pound[..1]).unwrap().is_empty());
        assert_eq!(l.feed(&[pound[1], b'}', b'\n']).unwrap(), vec!["{£}"]);
    }

    #[test]
    fn refuses_long_lines() {
        let mut l = Lines::default();
        assert!(l.feed(&vec![b'x'; MAX_LINE_BYTES]).is_ok());
        assert!(l.feed(b"x").is_err());
    }

    #[test]
    fn reads_group_file() {
        let dir = std::env::temp_dir().join(format!("flytower-agent-group-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("group");
        fs::write(&file, "root:x:0:\nflytower:x:998:panel\nbroken\n").unwrap();
        assert_eq!(group_id("flytower", &file).unwrap(), 998);
        assert!(group_id("nobody", &file).is_err());
        let passwd = dir.join("passwd");
        fs::write(
            &passwd,
            "root:x:0:0::/root:/bin/sh\nflytower:x:997:998::/var/lib/flytower:/usr/sbin/nologin\n",
        )
        .unwrap();
        assert_eq!(user_id("flytower", &passwd).unwrap(), 997);
        assert!(user_id("mc-survival", &passwd).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peer_rules() {
        assert!(allowed(0, 997));
        assert!(allowed(997, 997));
        // A server's user is refused, whatever groups it is in.
        assert!(!allowed(1001, 997));
    }
}
