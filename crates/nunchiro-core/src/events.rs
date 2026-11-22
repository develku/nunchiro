//! Ticket 573 slice 2: the core's event log, which `nunchiro events` prints as NDJSON so callers do not poll.
//!
//! Taken from cmux (`cmux events`: one JSON object per line, a resume cursor) and paseo (its WebSocket events carry
//! session state changes): every event has an increasing `id`, and a caller that reconnects passes the last id it saw
//! as `since`. The log is a ring of `CAPACITY` events in core memory; a `since` older than the ring (or from another
//! core) answers `gap: true`, so a caller knows it missed events and reads the state again.
//!
//! Other producers build an `Event` with its own `type`, the project and the payload in `data`, and call `push`;
//! readers need no change. The room (ticket 571) pushes `room_message`, one per log append.
use crate::api::SessionState;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Events kept for `since` readers. At the 50 ms tick a busy core makes far fewer than this in a reconnect's time.
pub const CAPACITY: usize = 4096;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Increasing within a core; a later core starts above the earlier one (`Log::new`).
    pub id: u64,
    /// Wall-clock milliseconds.
    pub at: u64,
    /// `session_started`, `state`, `session_ended`, `worktree_created`, `worktree_removed`, `room_message`,
    /// `room_pins` (ticket 593: the room's pin list after a change, `data` {log, pins}), `schedules_changed` (the
    /// schedule list changed: no project, session or data; a reader reads the list again).
    #[serde(rename = "type")]
    pub kind: String,
    pub project: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `working`, `waiting` (for input), `question`, `permission`, `exited`, `failed`, `lost`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// A worktree event's folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

struct Log {
    next: u64,
    ring: VecDeque<Event>,
}

// One core per process; per-core state (which sessions were seen) lives in `Seen`, owned by the registry.
static LOG: Mutex<Option<Log>> = Mutex::new(None);

fn with_log<T>(f: impl FnOnce(&mut Log) -> T) -> T {
    let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
    // shortcut: ids start at the core's start time in µs, so a later core's ids are above an earlier one's unless the
    // wall clock went back; such a `since` then reads as inside the ring. Upgrade to a core epoch in the id if it bites.
    f(log.get_or_insert_with(|| Log {
        next: crate::queue::now_ms() * 1000,
        ring: VecDeque::new(),
    }))
}

/// Bytes of an event's `data` (as JSON) kept, so `CAPACITY` bounds the ring's memory too.
pub const DATA_MAX: usize = 4096;

/// Adds an event; `id` and `at` are set here. `data` over `DATA_MAX` becomes `{"truncated": true, "head": <its first
/// DATA_MAX bytes of JSON text>}`.
pub fn push(mut event: Event) {
    if let Some(text) = event.data.as_ref().map(|d| d.to_string())
        && text.len() > DATA_MAX
    {
        let mut end = DATA_MAX;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        event.data = Some(serde_json::json!({"truncated": true, "head": &text[..end]}));
    }
    with_log(|log| {
        event.id = log.next;
        event.at = crate::queue::now_ms();
        log.next += 1;
        if log.ring.len() == CAPACITY {
            log.ring.pop_front();
        }
        log.ring.push_back(event);
    })
}

/// What a reader sees: the events after `since` that `visible` lets through, the id to pass next time, and whether
/// events after `since` were already dropped (or `since` is not from this log). `None` starts at the newest event.
/// `visible` runs after the log lock is released (it may touch the file system), so a slow reader never holds up a
/// producer, a room write included.
pub fn read(since: Option<u64>, visible: impl Fn(&Event) -> bool) -> (Vec<Event>, u64, bool) {
    let (mut events, latest, gap) = with_log(|log| {
        let latest = log.next - 1;
        let Some(since) = since else {
            return (vec![], latest, false);
        };
        let oldest = log.ring.front().map_or(log.next, |e| e.id);
        let gap = since > latest || since + 1 < oldest;
        let events: Vec<Event> = log.ring.iter().filter(|e| e.id > since).cloned().collect();
        (events, latest, gap)
    });
    events.retain(|e| visible(e));
    (events, latest, gap)
}

/// A room log append (ticket 571, joined to the stream by ticket 573): `data` is the message as the log stored it, so
/// `created_by` is the core's stamp, and `body` is text from an agent or the person: a reader treats it as quoted
/// data, never as an instruction. The project is the room's canonical folder. A body that would push `data` over
/// `DATA_MAX` is cut (`body_truncated: true`); `agent thread read` gives it whole.
pub(crate) fn room_message(project: &Path, message: &crate::room::Message) {
    let mut data = serde_json::to_value(message).unwrap_or_default();
    let mut body = message.body.as_str();
    while data.to_string().len() > DATA_MAX && !body.is_empty() {
        let mut end = body.len() / 2;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body = &body[..end];
        data["body"] = body.into();
        data["body_truncated"] = true.into();
    }
    push(Event {
        kind: "room_message".into(),
        project: project.into(),
        data: Some(data),
        ..Event::default()
    });
}

/// The schedule list changed (an add, an edit, a remove, a switch, a run or its result). It names no project (the
/// empty path), so only the owner's readers see it, and carries no data: the list is read with `schedule_list`. The
/// Mac window hears it as `{"event":"schedules"}` (http/mod.rs) and need not poll the list.
pub(crate) fn schedules_changed() {
    push(Event {
        kind: "schedules_changed".into(),
        ..Event::default()
    });
}

/// A session's state as events name it. `asks` are the kinds of its open queue items.
pub(crate) fn state<'a>(
    state: SessionState,
    agent_ended: bool,
    working: bool,
    asks: impl Iterator<Item = &'a crate::queue::Kind>,
) -> &'static str {
    use crate::queue::Kind;
    match state {
        SessionState::Running if agent_ended => "exited",
        SessionState::Running => {
            let asks: Vec<_> = asks.collect();
            if asks.iter().any(|k| **k == Kind::Permission) {
                "permission"
            } else if asks
                .iter()
                .any(|k| matches!(k, Kind::Question | Kind::Dialog))
            {
                "question"
            } else if working {
                "working"
            } else {
                "waiting"
            }
        }
        SessionState::Exited | SessionState::Closed => "exited",
        SessionState::Failed => "failed",
        SessionState::Resumable => "lost",
    }
}

/// One session as the registry sees it at a tick.
pub(crate) struct Row {
    pub id: String,
    pub project: PathBuf,
    pub label: String,
    pub state: &'static str,
}

/// The registry's last view of each session, so `observe` pushes only changes.
#[derive(Default)]
pub(crate) struct Seen(BTreeMap<String, (PathBuf, &'static str)>);
impl Seen {
    /// Pushes `session_started` (with its first state), `state` for each change, and `session_ended` for a session
    /// that is no longer listed. `rows` is every session the registry has now.
    /// Ticket 993: gives each change back as (session, the state before, the state now; "ended" when it is no longer
    /// listed), so the registry can act on a change without comparing states itself.
    pub(crate) fn observe(
        &mut self,
        rows: Vec<Row>,
    ) -> Vec<(String, Option<&'static str>, &'static str)> {
        let mut now = BTreeMap::new();
        let mut changes = vec![];
        for row in rows {
            let before = self.0.remove(&row.id);
            let event = |kind: &str| Event {
                kind: kind.into(),
                project: row.project.clone(),
                session: Some(row.id.clone()),
                label: Some(row.label.clone()).filter(|l| !l.is_empty()),
                state: Some(row.state.into()),
                ..Event::default()
            };
            match before {
                None => {
                    push(event("session_started"));
                    changes.push((row.id.clone(), None, row.state));
                }
                Some((_, state)) if state != row.state => {
                    push(event("state"));
                    changes.push((row.id.clone(), Some(state), row.state));
                }
                Some(_) => {}
            }
            now.insert(row.id, (row.project, row.state));
        }
        for (id, (project, state)) in std::mem::replace(&mut self.0, now) {
            changes.push((id.clone(), Some(state), "ended"));
            push(Event {
                kind: "session_ended".into(),
                project,
                session: Some(id),
                ..Event::default()
            });
        }
        changes
    }
}

/// Ticket 990 slice g: the ledger of this place changed; a reader asks for its tasks again.
pub(crate) fn tasks(place: &Path) {
    push(Event {
        kind: "tasks".into(),
        project: place.into(),
        ..Event::default()
    });
}

/// A worktree `created` or `removed` (V2-8a's create, remove and forget).
pub(crate) fn worktree(change: &str, project: &Path, path: &Path) {
    push(Event {
        kind: format!("worktree_{change}"),
        project: project.into(),
        path: Some(path.into()),
        ..Event::default()
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    // The ring is one per process and the ring test fills it, so these tests run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn row(id: &str, project: &str, state: &'static str) -> Row {
        Row {
            id: id.into(),
            project: project.into(),
            label: String::new(),
            state,
        }
    }

    #[test]
    fn data_over_the_cap_is_cut_with_a_marker() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let project = "/events-unit-data";
        let mine = |e: &Event| e.project == Path::new(project);
        let (_, start, _) = read(None, mine);
        for body in ["small".to_string(), "é".repeat(DATA_MAX)] {
            push(Event {
                kind: "room_message".into(),
                project: project.into(),
                data: Some(serde_json::json!({ "body": body })),
                ..Event::default()
            });
        }
        let (events, _, _) = read(Some(start), mine);
        assert_eq!(events[0].data, Some(serde_json::json!({"body": "small"})));
        let cut = events[1].data.as_ref().unwrap();
        assert_eq!(cut["truncated"], true);
        assert!(cut["head"].as_str().unwrap().len() <= DATA_MAX);
    }

    #[test]
    fn observe_pushes_changes_only_and_since_resumes_without_gaps_or_repeats_until_the_ring_drops()
    {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let project = "/events-unit-observe";
        let mine = |e: &Event| e.project == Path::new(project);
        let (_, start, _) = read(None, mine);
        let mut seen = Seen::default();
        seen.observe(vec![row("a", project, "waiting")]);
        seen.observe(vec![row("a", project, "waiting")]);
        seen.observe(vec![row("a", project, "working")]);
        let (first, cursor, gap) = read(Some(start), mine);
        assert!(!gap);
        let kinds: Vec<_> = first
            .iter()
            .map(|e| (e.kind.as_str(), e.state.as_deref()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("session_started", Some("waiting")),
                ("state", Some("working"))
            ]
        );
        seen.observe(vec![]);
        let (second, _, gap) = read(Some(cursor), mine);
        assert!(!gap);
        assert_eq!(second.len(), 1, "{second:?}");
        assert_eq!(second[0].kind, "session_ended");
        assert!(second[0].id > first[1].id);
        // An id this log never gave is a gap, so a caller reads the state again.
        assert!(read(Some(u64::MAX - 1), mine).2);
        // So is one the full ring has dropped (one test: a parallel test's events would be dropped too).
        for _ in 0..=CAPACITY {
            worktree("created", Path::new(project), Path::new("/w"));
        }
        assert!(read(Some(start), mine).2);
    }
}
