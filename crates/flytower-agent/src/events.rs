//! Following systemd instead of asking it over and over.
//! systemd signals every change to a unit (started, main process exited, failed, restart
//! scheduled, stopped) on D-Bus as it happens (`crate::systemd::UnitChanges`), and
//! `service.wait` holds a request open until one concerns a server the panel cares about.

use std::collections::{BTreeSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The server a unit is, if it's one of ours.
#[must_use]
pub fn server_of_unit(unit: &str) -> Option<String> {
    let name = unit
        .strip_prefix("flytower-mc@")?
        .strip_suffix(".service")?;
    let b = name.as_bytes();
    let ok = (1..=31).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    ok.then(|| name.to_string())
}

/// A source of unit changes.
pub trait Follow: Send + Sync + 'static {
    /// Follows until the source ends. Calls `started` once it's running (not at all if it
    /// can't start), then `on_unit` with the name of each unit that changed.
    fn run(&self, started: &mut dyn FnMut(), on_unit: &mut dyn FnMut(&str));
    /// Ends a `run` in progress, and any later one.
    fn stop(&self);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicked holder can't leave this state inconsistent in a way that matters.
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

const KEEP: usize = 1000;
/// Changes come in bursts (exited, failed, restart scheduled); answer once for the burst.
pub const SETTLE: Duration = Duration::from_millis(300);

/// What a listener hears about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change<'a> {
    /// systemd says this server's unit changed.
    Server(&'a str),
    /// systemd stopped or started being followed, so changes may have gone unseen.
    Lost,
}

/// Called on the following thread for every change; it should only note it and return.
pub type Listener = Arc<dyn Fn(Change<'_>) + Send + Sync>;

fn new_run() -> String {
    let mut bytes = [0u8; 4];
    // Without randomness, the time still tells runs apart.
    if rustix::rand::getrandom(&mut bytes, rustix::rand::GetRandomFlags::empty()).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        bytes = nanos.to_le_bytes();
    }
    format!("{:08x}", u32::from_le_bytes(bytes))
}

struct State {
    run: String,
    seq: u64,
    log: VecDeque<(u64, String)>,
    following: bool,
    stopped: bool,
}

impl State {
    /// Servers with news since `after`; `None` for none, all of `servers` when it can't tell.
    fn since(&self, servers: &[String], after: Option<&str>) -> Option<Vec<String>> {
        let (run, seq) = after.unwrap_or("").split_once(':').unwrap_or(("", ""));
        let seq = seq.parse::<u64>().ok();
        // A first call, a restarted agent or a cursor older than what's kept: everything.
        let Some(seq) = seq.filter(|s| run == self.run && *s <= self.seq) else {
            return Some(servers.to_vec());
        };
        if self.log.front().is_some_and(|(first, _)| *first > seq + 1) {
            return Some(servers.to_vec());
        }
        // Any of our servers, not only those asked about: one made since the call began counts.
        let changed: BTreeSet<&String> = self
            .log
            .iter()
            .filter(|(s, _)| *s > seq)
            .map(|(_, server)| server)
            .collect();
        (!changed.is_empty()).then(|| changed.into_iter().cloned().collect())
    }

    fn result(&self, changed: &[String]) -> Value {
        json!({ "cursor": format!("{}:{}", self.run, self.seq), "changed": changed, "following": self.following })
    }
}

/// Unit changes, as systemd reports them.
pub struct UnitEvents {
    state: Mutex<State>,
    news: Condvar,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
    follow: Arc<dyn Follow>,
    retry: Duration,
}

impl UnitEvents {
    #[must_use]
    pub fn new(follow: Arc<dyn Follow>, retry: Duration) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                run: new_run(),
                seq: 0,
                log: VecDeque::new(),
                following: false,
                stopped: false,
            }),
            news: Condvar::new(),
            listeners: Mutex::default(),
            next_listener: AtomicU64::new(0),
            follow,
            retry,
        })
    }

    /// Follows on a thread of its own until [`stop`](Self::stop), starting again after
    /// `retry` whenever following ends.
    pub fn start(self: &Arc<Self>) {
        let me = Arc::clone(self);
        thread::spawn(move || {
            while !lock(&me.state).stopped {
                me.follow.run(
                    &mut || {
                        lock(&me.state).following = true;
                        me.tell(Change::Lost);
                    },
                    &mut |unit| {
                        if let Some(server) = server_of_unit(unit) {
                            me.push(&server);
                        }
                    },
                );
                let mut s = lock(&me.state);
                s.following = false;
                // The panel can't know what it missed: everything has changed, as far as it can tell.
                s.run = new_run();
                me.news.notify_all();
                drop(s);
                me.tell(Change::Lost);
                let s = lock(&me.state);
                if s.stopped {
                    break;
                }
                drop(me.news.wait_timeout(s, me.retry));
            }
        });
    }

    pub fn stop(&self) {
        lock(&self.state).stopped = true;
        self.follow.stop();
        self.news.notify_all();
    }

    #[must_use]
    pub fn following(&self) -> bool {
        lock(&self.state).following
    }

    pub fn push(&self, server: &str) {
        let mut s = lock(&self.state);
        s.seq += 1;
        let seq = s.seq;
        s.log.push_back((seq, server.to_string()));
        while s.log.len() > KEEP {
            s.log.pop_front();
        }
        drop(s);
        self.news.notify_all();
        self.tell(Change::Server(server));
    }

    /// Calls `listener` with every change from now on, until [`unlisten`](Self::unlisten).
    pub fn listen(&self, listener: Listener) -> u64 {
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        lock(&self.listeners).push((id, listener));
        id
    }

    pub fn unlisten(&self, id: u64) {
        lock(&self.listeners).retain(|(n, _)| *n != id);
    }

    fn tell(&self, change: Change<'_>) {
        let listeners: Vec<Listener> = lock(&self.listeners)
            .iter()
            .map(|(_, l)| Arc::clone(l))
            .collect();
        for l in listeners {
            l(change);
        }
    }

    /// Answers when any server has changed since `after`, or after `timeout` with none.
    /// `servers` is what "everything" means when the agent can't tell what changed.
    pub fn wait(&self, servers: &[String], after: Option<&str>, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        let mut s = lock(&self.state);
        if !s.following {
            return s.result(servers);
        }
        if let Some(now) = s.since(servers, after) {
            return s.result(&now);
        }
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return s.result(&[]);
            }
            s = self
                .news
                .wait_timeout(s, left)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
            if !s.following {
                return s.result(servers);
            }
            if s.since(servers, after).is_some() {
                drop(s);
                thread::sleep(SETTLE);
                let s = lock(&self.state);
                return s.result(&s.since(servers, after).unwrap_or_default());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A follower the test feeds unit names into, and can make end.
    struct Fake {
        lines: Mutex<Option<mpsc::Receiver<Option<String>>>>,
        send: Mutex<mpsc::Sender<Option<String>>>,
        starts: Mutex<u32>,
    }

    impl Fake {
        fn new() -> Arc<Self> {
            let (send, lines) = mpsc::channel();
            Arc::new(Self {
                lines: Mutex::new(Some(lines)),
                send: Mutex::new(send),
                starts: Mutex::new(0),
            })
        }
        fn line(&self, unit: &str) {
            lock(&self.send).send(Some(unit.to_string())).unwrap();
        }
        fn exit(&self) {
            lock(&self.send).send(None).unwrap();
        }
    }

    impl Follow for Fake {
        fn run(&self, started: &mut dyn FnMut(), on_line: &mut dyn FnMut(&str)) {
            *lock(&self.starts) += 1;
            let Some(lines) = lock(&self.lines).take() else {
                return;
            };
            started();
            while let Ok(Some(line)) = lines.recv() {
                on_line(&line);
            }
            // A later run gets a fresh channel.
            let (send, lines) = mpsc::channel();
            *lock(&self.send) = send;
            *lock(&self.lines) = Some(lines);
        }
        fn stop(&self) {
            let _ = lock(&self.send).send(None);
        }
    }

    fn started(fake: &Arc<Fake>, retry: Duration) -> Arc<UnitEvents> {
        let ev = UnitEvents::new(Arc::clone(fake) as Arc<dyn Follow>, retry);
        ev.start();
        while !ev.following() {
            thread::yield_now();
        }
        ev
    }

    fn names(v: &Value) -> Vec<String> {
        let mut n: Vec<String> = v["changed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        n.sort();
        n
    }

    const MS: Duration = Duration::from_millis(1);
    fn ab() -> Vec<String> {
        vec!["a".into(), "b".into()]
    }

    #[test]
    fn reads_which_server_a_unit_is() {
        assert_eq!(
            server_of_unit("flytower-mc@survival.service").as_deref(),
            Some("survival")
        );
        assert_eq!(server_of_unit("ssh.service"), None);
        assert_eq!(server_of_unit("flytower-mc@../x.service"), None);
        assert_eq!(server_of_unit("flytower-mc@.service"), None);
    }

    #[test]
    fn answers_a_first_call_with_everything_then_waits_for_news() {
        let f = Fake::new();
        let ev = started(&f, MS);
        let first = ev.wait(&ab(), None, 1000 * MS);
        assert_eq!(
            (names(&first), first["following"].as_bool()),
            (ab(), Some(true))
        );
        let cursor = first["cursor"].as_str().unwrap().to_string();

        let feeder = Arc::clone(&f);
        thread::spawn(move || {
            thread::sleep(20 * MS);
            feeder.line("ssh.service");
            feeder.line("flytower-mc@b.service");
        });
        let next = ev.wait(&ab(), Some(&cursor), 5000 * MS);
        assert_eq!(names(&next), ["b"]);

        // Nothing new: it times out empty-handed.
        let cursor = next["cursor"].as_str().unwrap();
        assert!(names(&ev.wait(&ab(), Some(cursor), 100 * MS)).is_empty());
        ev.stop();
    }

    #[test]
    fn collects_a_burst_into_one_answer() {
        let f = Fake::new();
        let ev = started(&f, MS);
        let first = ev.wait(&ab(), None, 1000 * MS);
        let cursor = first["cursor"].as_str().unwrap().to_string();
        let feeder = Arc::clone(&f);
        thread::spawn(move || {
            thread::sleep(20 * MS);
            feeder.line("flytower-mc@a.service");
            thread::sleep(50 * MS);
            feeder.line("flytower-mc@b.service");
        });
        assert_eq!(names(&ev.wait(&ab(), Some(&cursor), 5000 * MS)), ab());
        ev.stop();
    }

    #[test]
    fn says_everything_changed_when_following_stops_then_follows_again() {
        let f = Fake::new();
        let ev = started(&f, 20 * MS);
        let a = vec!["a".to_string()];
        let first = ev.wait(&a, None, 1000 * MS);
        let cursor = first["cursor"].as_str().unwrap().to_string();
        let feeder = Arc::clone(&f);
        thread::spawn(move || {
            thread::sleep(20 * MS);
            feeder.exit();
        });
        let stopped = ev.wait(&a, Some(&cursor), 5000 * MS);
        assert_eq!(
            (names(&stopped), stopped["following"].as_bool()),
            (a.clone(), Some(false))
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ev.following() {
            assert!(Instant::now() < deadline, "never followed again");
            thread::sleep(MS);
        }
        assert_eq!(*lock(&f.starts), 2);
        // The old cursor belongs to the old run: everything again.
        assert_eq!(names(&ev.wait(&a, Some(&cursor), 1000 * MS)), a);
        ev.stop();
    }

    #[test]
    fn says_so_when_not_following() {
        let f = Fake::new();
        let ev = UnitEvents::new(f as Arc<dyn Follow>, MS);
        let w = ev.wait(&ab(), None, 1000 * MS);
        assert_eq!((names(&w), w["following"].as_bool()), (ab(), Some(false)));
    }
}
