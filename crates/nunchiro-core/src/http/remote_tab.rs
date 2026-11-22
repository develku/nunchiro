//! Q10: the owner window's tab on a session of an SSH machine. One thread per window, started at its first such frame:
//! it runs the window's requests on remote rows in order (keys must not overtake each other), and while a remote
//! session is watched it reads its output over the machine's master every `POLL` and hands the new bytes to the
//! window as the same binary frames a local session gets. The machine runs only the one-shot requests its relay
//! already takes (`read`, `send_text`, `send_keys`, `resize`, `close`, `answer`), so its installed Nunchiro is unchanged.
use super::Lease;
use crate::{api::*, sessions::Sessions};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};

// shortcut: a watched remote session is polled (one ssh request over the master per POLL); upgrade to output pushed
// on the relay stream when the relay protocol next changes.
const POLL: Duration = Duration::from_millis(250);
/// Requests that may wait for the machine (each is an ssh round trip, run one at a time), by count and by bytes; a
/// request over either is refused, never queued (security look 11-17: the queue had no bound).
const INBOX: usize = 256;
const INBOX_BYTES: usize = 4 << 20;
/// Replies and output frames (each at most one replay) that may wait for the window. The thread stops reading the
/// machine while this many wait, so a noisy machine and a slow window never grow the core's memory.
const OUTBOX: usize = 16;
#[cfg(test)]
const BUSY: &str = "too many requests wait for this machine";

enum Msg {
    Watch {
        id: String,
        alias: String,
        after: u64,
    },
    Unwatch(String),
    Call {
        frame: u64,
        alias: String,
        request: Box<Request>,
    },
}
/// What the window loop sends on: a reply or event (text) or an output frame (binary).
pub(super) enum Out {
    Text(String),
    Binary(Vec<u8>),
}
pub(super) struct RemoteTab {
    tx: SyncSender<Msg>,
    rx: Receiver<Out>,
    /// The bytes of the requests in `tx`, counted in as they are queued and out as the thread takes them.
    queued: Arc<AtomicUsize>,
    /// What the window acked as parsed, per watched session (cumulative data bytes since its watch).
    acks: Acks,
}
type Acks = Arc<Mutex<BTreeMap<String, u64>>>;
/// A remote session is not read while the window has this much of it sent and not parsed (the local sessions' rule,
/// `UNACKED_MAX`): a machine that prints faster than the window draws never grows the window's memory. As for a local
/// session, only a window that acks is paced. The machine's replay keeps the newest output meanwhile.
fn held(sent: u64, acked: Option<u64>) -> bool {
    acked.is_some_and(|acked| sent.saturating_sub(acked) > super::UNACKED_MAX)
}
fn weight(msg: &Msg) -> usize {
    match msg {
        Msg::Call { request, .. } => match &**request {
            Request::SendText { text, .. } => 256 + text.len(),
            _ => 4096,
        },
        _ => 256,
    }
}
impl RemoteTab {
    pub(super) fn start(
        registry: &Arc<Mutex<Sessions>>,
        home: &Path,
        stopping: &Arc<AtomicBool>,
        lease: Arc<Lease>,
    ) -> Self {
        let (tx, inbox) = sync_channel(INBOX);
        let (outbox, rx) = sync_channel(OUTBOX);
        let queued = Arc::new(AtomicUsize::new(0));
        let taken = queued.clone();
        let acks = Acks::default();
        let acked = acks.clone();
        let (registry, home, stopping) = (registry.clone(), home.to_path_buf(), stopping.clone());
        // The window loop drops `tx` when it ends; the thread ends at its next wait (its lease keeps the place till then).
        let _ = thread::Builder::new().spawn(move || {
            let _lease = lease;
            run(&registry, &home, &stopping, &inbox, &outbox, &taken, &acked);
        });
        Self {
            tx,
            rx,
            queued,
            acks,
        }
    }
    /// The window parsed `bytes` of a watched remote session's output since its watch.
    pub(super) fn ack(&self, id: &str, bytes: u64) {
        if let Ok(mut acks) = self.acks.lock() {
            let at = acks.entry(id.into()).or_default();
            *at = (*at).max(bytes);
        }
    }
    /// Queues one message for the thread, or refuses it when the queue is at its bound.
    fn put(&self, msg: Msg) -> Result<(), String> {
        let bytes = weight(&msg);
        if self.queued.fetch_add(bytes, Ordering::SeqCst) + bytes > INBOX_BYTES
            || self.tx.try_send(msg).is_err()
        {
            self.queued.fetch_sub(bytes, Ordering::SeqCst);
            // A literal: the window's refusal check (web/tests/core-reasons.ts) reads refusal texts from the source.
            return Err("too many requests wait for this machine".into());
        }
        Ok(())
    }
    pub(super) fn watch(&self, id: String, alias: String, after: u64) -> Result<(), String> {
        self.put(Msg::Watch { id, alias, after })
    }
    pub(super) fn unwatch(&self, id: String) -> Result<(), String> {
        self.put(Msg::Unwatch(id))
    }
    pub(super) fn call(&self, frame: u64, alias: String, request: Request) -> Result<(), String> {
        self.put(Msg::Call {
            frame,
            alias,
            request: Box::new(request),
        })
    }
    pub(super) fn ready(&self) -> Option<Out> {
        self.rx.try_recv().ok()
    }
}

struct Watch {
    alias: String,
    cursor: u64,
    replay: bool,
    /// Data bytes sent to the window since the watch.
    sent: u64,
}
fn run(
    registry: &Arc<Mutex<Sessions>>,
    home: &Path,
    stopping: &AtomicBool,
    inbox: &Receiver<Msg>,
    outbox: &SyncSender<Out>,
    queued: &AtomicUsize,
    acks: &Acks,
) {
    // Every message leaves the count as it leaves the channel.
    let took = |msg: Msg| {
        queued.fetch_sub(weight(&msg), Ordering::SeqCst);
        msg
    };
    let mut watches: BTreeMap<String, Watch> = BTreeMap::new();
    let mut backlog = std::collections::VecDeque::new();
    let mut due = Instant::now();
    loop {
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        let next = match backlog.pop_front() {
            Some(msg) => Ok(msg),
            None => inbox
                .recv_timeout(due.saturating_duration_since(Instant::now()))
                .map(took),
        };
        match next {
            Ok(Msg::Watch { id, alias, after }) => {
                // A new watch counts from zero on both sides.
                if let Ok(mut acks) = acks.lock() {
                    acks.remove(&id);
                }
                watches.insert(
                    id,
                    Watch {
                        alias,
                        cursor: after,
                        replay: true,
                        sent: 0,
                    },
                );
                due = Instant::now();
            }
            Ok(Msg::Unwatch(id)) => {
                watches.remove(&id);
                if let Ok(mut acks) = acks.lock() {
                    acks.remove(&id);
                }
            }
            Ok(Msg::Call {
                frame,
                alias,
                mut request,
            }) => {
                // Each request is a round trip to the machine (~0.2 s): keys typed meanwhile go together, in order.
                let mut frames = vec![frame];
                if let Request::SendText {
                    id,
                    text,
                    seen,
                    composer: false,
                } = &mut *request
                    && seen.is_empty()
                {
                    while let Ok(msg) = inbox.try_recv().map(took) {
                        let Msg::Call {
                            frame,
                            alias: a,
                            request: next,
                        } = &msg
                        else {
                            backlog.push_back(msg);
                            break;
                        };
                        match &**next {
                            Request::SendText {
                                id: i,
                                text: t,
                                seen: s,
                                composer: false,
                            } if *a == alias
                                && i == id
                                && s.is_empty()
                                && text.len() + t.len() <= crate::pty::INPUT_BYTES =>
                            {
                                text.push_str(t);
                                frames.push(*frame);
                            }
                            _ => {
                                backlog.push_back(msg);
                                break;
                            }
                        }
                    }
                }
                let response = serde_json::to_value(crate::server::remote_from_owner(
                    registry, home, "", alias, *request, stopping,
                ))
                .unwrap_or_default();
                for frame in frames {
                    let text = serde_json::json!({"id":frame,"response":response}).to_string();
                    if outbox.send(Out::Text(text)).is_err() {
                        return;
                    }
                }
                crate::pty::wake_windows();
                // A key's echo shows at once, not at the next poll; requests still queued go first.
                due = Instant::now();
                if backlog.is_empty()
                    && let Ok(msg) = inbox.try_recv().map(took)
                {
                    backlog.push_back(msg);
                }
                if !backlog.is_empty() {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if Instant::now() < due {
            continue;
        }
        due = Instant::now() + POLL;
        let (mut ended, mut sent) = (vec![], false);
        let acked = acks.lock().map(|a| a.clone()).unwrap_or_default();
        for (id, w) in &mut watches {
            if held(w.sent, acked.get(id).copied()) {
                continue;
            }
            match crate::machines::read_output(registry, home, &w.alias, id, w.cursor) {
                Ok((data, start, end, truncated)) if w.replay || !data.is_empty() || truncated => {
                    let frame = super::output_frame(id, start, end, truncated, w.replay, &data);
                    if outbox.send(Out::Binary(frame)).is_err() {
                        return;
                    }
                    w.sent += data.len() as u64;
                    (w.cursor, w.replay, sent) = (end, false, true);
                }
                Ok(_) => {}
                // The machine is not reachable now: the watch stays and goes on from its cursor once the master is up.
                Err(e) if e.starts_with(&format!("machine {}: ", w.alias)) => {}
                // The remote core refused the read (the session ended there): as a local session that ends.
                // Its text is the relay's: bounded.
                Err(error) => ended.push((id.clone(), error.chars().take(512).collect::<String>())),
            }
        }
        for (id, error) in ended {
            watches.remove(&id);
            let event = serde_json::json!({"event":"unwatched","session":id,"error":error});
            if outbox.send(Out::Text(event.to_string())).is_err() {
                return;
            }
            sent = true;
        }
        if sent {
            crate::pty::wake_windows();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_that_falls_behind_holds_the_read() {
        let max = super::super::UNACKED_MAX;
        assert!(
            !held(max * 4, None),
            "a window that never acks is not paced"
        );
        assert!(!held(max, Some(0)));
        assert!(held(max + 1, Some(0)));
        assert!(!held(max + 1, Some(1)), "an ack lets the read go on");
        assert!(
            !held(10, Some(99)),
            "an ack past what was sent holds nothing"
        );
    }
    fn tab() -> (RemoteTab, Receiver<Msg>) {
        let (tx, inbox) = sync_channel(INBOX);
        let (_outbox, rx) = sync_channel::<Out>(OUTBOX);
        let queued = Arc::new(AtomicUsize::new(0));
        (
            RemoteTab {
                tx,
                rx,
                queued,
                acks: Acks::default(),
            },
            inbox,
        )
    }

    /// Security look 11-17: the queue of requests for a machine had no bound. Over the count or the bytes a request is
    /// refused, and a refused one leaves nothing counted.
    #[test]
    fn requests_over_the_bound_are_refused_not_queued() {
        let (t, _inbox) = tab();
        for i in 0..INBOX {
            assert!(t.unwatch(format!("s{i}")).is_ok(), "{i}");
        }
        let counted = t.queued.load(Ordering::SeqCst);
        assert_eq!(t.unwatch("one more".into()).unwrap_err(), BUSY);
        assert_eq!(t.queued.load(Ordering::SeqCst), counted);

        let (t, _inbox) = tab();
        let text = |n: usize| Request::SendText {
            id: "s".into(),
            text: "x".repeat(n),
            seen: vec![],
            composer: false,
        };
        for frame in 0..3 {
            assert!(t.call(frame, "m".into(), text(1 << 20)).is_ok());
        }
        assert_eq!(t.call(3, "m".into(), text(1 << 20)).unwrap_err(), BUSY);
        assert!(
            t.call(4, "m".into(), text(16)).is_ok(),
            "a small one still fits"
        );
    }
}
