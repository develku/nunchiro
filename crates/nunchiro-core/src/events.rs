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
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
        journal_append(&event); // under the ring's lock, so the journal's lines keep the ids' order
        if log.ring.len() == CAPACITY {
            log.ring.pop_front();
        }
        log.ring.push_back(event);
    })
}

/// Ticket 1130 C-C3: the durable journal. Every event the ring takes is also appended, one line, to
/// `$NUNCHIRO_HOME/logs/events/events-<UTC date>.ndjson` (dir 0700, files 0600, opened with O_APPEND and never
/// rewritten), so a core restart loses none and `nunchiro events --history` reads past days. A room event's `data` (a
/// message body, a pin list) is left out, and each line goes through the log redactor. A day file stops taking lines
/// at `JOURNAL_DAY_BYTES` (one `journal_full` line says so) and files older than `JOURNAL_DAYS` are removed when a day
/// file opens: the whole journal stays under 14 x 4 MiB.
pub const JOURNAL_DAYS: i64 = 14;
pub const JOURNAL_DAY_BYTES: u64 = 4 * 1024 * 1024;
const DAY_MS: u64 = 86_400_000;

struct Journal {
    dir: PathBuf,
    users: usize,
    day: i64,
    file: Option<std::fs::File>,
    size: u64,
    /// The day file ends with its `journal_full` line: nothing more goes into it.
    full: bool,
    /// The day file does not end with a newline (a write failed partway, or a core stopped mid-line): the next line
    /// starts with one, so it is never glued to the unfinished one.
    torn: bool,
    /// The last append failed and said so on stderr; said again only after one works.
    failed: bool,
}
static JOURNAL: Mutex<Option<Journal>> = Mutex::new(None);
fn lock_journal() -> std::sync::MutexGuard<'static, Option<Journal>> {
    JOURNAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// The journal stays open while this lives. As `logs::start`, the first core in a process owns it (a test process may
/// run several cores; the later ones write to the first one's journal).
#[must_use]
pub struct Journaling(());
impl Drop for Journaling {
    fn drop(&mut self) {
        let mut journal = lock_journal();
        if let Some(j) = journal.as_mut() {
            j.users -= 1;
            if j.users == 0 {
                *journal = None;
            }
        }
    }
}
pub fn journal(home: &Path) -> Result<Journaling, String> {
    let mut journal = lock_journal();
    if let Some(j) = journal.as_mut() {
        j.users += 1;
        return Ok(Journaling(()));
    }
    let dir = crate::logs::dir(home)?.join("events");
    crate::store::private_dir(&dir)?;
    *journal = Some(Journal {
        dir,
        users: 1,
        day: i64::MIN,
        file: None,
        size: 0,
        full: false,
        torn: false,
        failed: false,
    });
    Ok(Journaling(()))
}

fn day_name(day: i64) -> String {
    let (y, m, d) = crate::usage::civil_from_days(day);
    format!("events-{y:04}-{m:02}-{d:02}.ndjson")
}
fn name_day(name: &str) -> Option<i64> {
    let date = name.strip_prefix("events-")?.strip_suffix(".ndjson")?;
    let mut parts = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    Some(crate::usage::days_from_civil(y, m, d))
}

fn journal_append(event: &Event) {
    let mut journal = lock_journal();
    let Some(j) = journal.as_mut() else {
        return;
    };
    let mut value = serde_json::to_value(event).unwrap_or_default();
    if event.kind.starts_with("room_")
        && let Some(object) = value.as_object_mut()
    {
        object.remove("data");
    }
    let mut line = crate::logs::redact(value.to_string().as_bytes());
    line.push(b'\n');
    match write_line(j, event.at, &line) {
        Ok(()) => j.failed = false,
        // Said on stderr (core.log) once per failing run; the event stays in the ring.
        Err(e) if !j.failed => {
            j.failed = true;
            eprintln!("event journal: {e}; events are not kept until it recovers");
        }
        Err(_) => {}
    }
}

fn write_line(j: &mut Journal, at: u64, line: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::FileExt;
    let day = (at / DAY_MS) as i64;
    if j.file.is_none() || day != j.day {
        j.file = None;
        prune(&j.dir, day);
        let file = open_day(&j.dir.join(day_name(day)), true)?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        // The last line tells whether an earlier core left the file mid-line or full.
        let n = size.min(FULL_ROOM);
        let mut tail = vec![0; n as usize];
        file.read_exact_at(&mut tail, size - n)
            .map_err(|e| e.to_string())?;
        let last = tail.strip_suffix(b"\n").unwrap_or(&tail);
        let last = &last[last.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1)..];
        j.full = last.starts_with(FULL_MARK.as_bytes());
        j.torn = tail.last().is_some_and(|&b| b != b'\n');
        (j.day, j.file, j.size) = (day, Some(file), size);
    }
    if j.full {
        return Ok(());
    }
    let mut out = if j.torn { vec![b'\n'] } else { vec![] };
    if j.size + (out.len() + line.len()) as u64 + FULL_ROOM <= JOURNAL_DAY_BYTES {
        out.extend_from_slice(line);
    } else {
        j.full = true;
        out.extend_from_slice(format!("{FULL_MARK}\"at\":{at}}}\n").as_bytes());
    }
    let file = j.file.as_mut().ok_or("journal not open")?;
    let written = file.write_all(&out);
    // A partial write still counts toward the cap, and leaves the file mid-line.
    j.size = file
        .metadata()
        .map_or(j.size + out.len() as u64, |m| m.len());
    j.torn = written.is_err();
    written.map_err(|e| e.to_string())
}
const FULL_ROOM: u64 = 128;
const FULL_MARK: &str = "{\"type\":\"journal_full\",";

/// A day file, opened without following a link and without blocking (a FIFO at its name would hold the writer, and
/// with it every event producer, for ever), then refused unless the open descriptor is a regular file. `append`: the
/// writer's (created 0600, read for its last line); else read-only.
fn open_day(path: &Path, append: bool) -> Result<std::fs::File, String> {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt, unix::fs::PermissionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .append(append)
        .create(append)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(format!("{}: not a regular file", path.display()));
    }
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if append {
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(file)
}

/// Removes day files `JOURNAL_DAYS` or more days before `today`; anything else in the folder is left alone.
fn prune(dir: &Path, today: i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if let Some(day) = entry.file_name().to_str().and_then(name_day)
            && day <= today - JOURNAL_DAYS
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The journal's lines of the last `days` UTC days (today included, at most `JOURNAL_DAYS`), oldest first, each one
/// JSON object. Read-only: a missing folder reads as empty; a link, a non-file or a line that is not JSON is skipped.
pub fn history(home: &Path, days: i64) -> Vec<serde_json::Value> {
    use std::io::Read;
    let dir = home.join("logs").join("events");
    if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return vec![];
    }
    let today = (crate::queue::now_ms() / DAY_MS) as i64;
    let mut out = vec![];
    for day in today + 1 - days.clamp(1, JOURNAL_DAYS)..=today {
        let Ok(file) = open_day(&dir.join(day_name(day)), false) else {
            continue;
        };
        let mut bytes = vec![];
        if file
            .take(JOURNAL_DAY_BYTES)
            .read_to_end(&mut bytes)
            .is_err()
        {
            continue;
        }
        out.extend(
            bytes
                .split(|&b| b == b'\n')
                .filter_map(|l| serde_json::from_slice(l).ok()),
        );
    }
    out
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

/// Ticket 1130 C-C3: a core started. Of the sessions the last core left running, `kept` came back live, `lost` can be
/// resumed (their holders died) and `exited` cannot. No project: only the owner's readers see it.
pub(crate) fn core_started(kept: usize, lost: usize, exited: usize) {
    push(Event {
        kind: "core_started".into(),
        data: Some(serde_json::json!({"kept": kept, "lost": lost, "exited": exited})),
        ..Event::default()
    });
}

/// Ticket 1130 C-C3: a send's Enter was dropped (`mark`: a `delivery::SETTLE_MARKS` drop or `enter_dropped_behind`);
/// `requeued` when the row waits to be sent again. Never the text.
pub(crate) fn send_dropped(project: &Path, session: &str, mark: &str, requeued: bool) {
    push(Event {
        kind: "send_dropped".into(),
        project: project.into(),
        session: Some(session.into()),
        data: Some(serde_json::json!({"mark": mark, "requeued": requeued})),
        ..Event::default()
    });
}

/// Ticket 1130 C-C3: the person pressed Enter in a lead's seat (a prompt to the lead). Never the text.
pub(crate) fn owner_prompt(project: &Path, session: &str) {
    push(Event {
        kind: "owner_prompt".into(),
        project: project.into(),
        session: Some(session.into()),
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
    use std::os::unix::fs::FileTypeExt;
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

    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!(
            "nunchiro-journal-{tag}-{}",
            crate::store::new_id().unwrap()
        ));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn journal_keeps_events_on_disk_owner_only_without_room_bodies() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("keep");
        let project = "/events-unit-journal";
        let journaling = journal(&home).unwrap();
        push(Event {
            kind: "room_message".into(),
            project: project.into(),
            data: Some(serde_json::json!({"body": "a private body word zq7"})),
            ..Event::default()
        });
        send_dropped(Path::new(project), "s1", "enter_dropped_composer", true);
        drop(journaling); // the core stops; the next one reads what it left
        let mine: Vec<_> = history(&home, 1)
            .into_iter()
            .filter(|e| e["project"] == project)
            .collect();
        assert_eq!(mine.len(), 2, "{mine:?}");
        assert_eq!(mine[0]["type"], "room_message");
        assert!(mine[0].get("data").is_none());
        assert_eq!(mine[1]["data"]["mark"], "enter_dropped_composer");
        let dir = home.join("logs/events");
        let file = std::fs::read_dir(&dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(!std::fs::read_to_string(&file).unwrap().contains("zq7"));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&dir), mode(&file)), (0o700, 0o600));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A home whose journal folder holds `today`'s day file as `make` leaves it.
    fn home_with_today(tag: &str, make: impl FnOnce(&Path)) -> (PathBuf, PathBuf) {
        let home = temp_home(tag);
        let dir = home.join("logs/events");
        std::fs::create_dir_all(&dir).unwrap();
        let today = dir.join(day_name((crate::queue::now_ms() / DAY_MS) as i64));
        make(&today);
        (home, today)
    }

    #[test]
    fn journal_refuses_a_fifo_at_the_day_name_without_blocking() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (home, today) = home_with_today("fifo", |p| {
            let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        });
        let journaling = journal(&home).unwrap();
        let (send, done) = std::sync::mpsc::channel();
        let reader = home.clone();
        std::thread::spawn(move || {
            worktree("created", Path::new("/events-unit-fifo"), Path::new("/w"));
            send.send(history(&reader, 1)).unwrap();
        });
        let Ok(read) = done.recv_timeout(std::time::Duration::from_secs(5)) else {
            std::mem::forget(journaling); // its drop would wait on the blocked writer's lock
            panic!("the journal blocked on a FIFO");
        };
        assert!(read.is_empty(), "{read:?}");
        drop(journaling);
        assert!(std::fs::metadata(&today).unwrap().file_type().is_fifo());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn journal_starts_a_new_line_after_an_unfinished_one() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _) = home_with_today("torn", |p| std::fs::write(p, "{\"a\":1}").unwrap());
        let journaling = journal(&home).unwrap();
        worktree("created", Path::new("/events-unit-torn"), Path::new("/w"));
        drop(journaling);
        let read = history(&home, 1);
        assert_eq!(read[0], serde_json::json!({"a": 1}));
        assert!(
            read.iter().any(|e| e["project"] == "/events-unit-torn"),
            "{read:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn journal_writes_nothing_after_its_full_line_even_after_a_restart() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let marker = "{\"type\":\"journal_full\",\"at\":1}\n";
        let (home, today) = home_with_today("full", |p| std::fs::write(p, marker).unwrap());
        let journaling = journal(&home).unwrap();
        worktree("created", Path::new("/events-unit-full"), Path::new("/w"));
        drop(journaling);
        assert_eq!(std::fs::read_to_string(&today).unwrap(), marker);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn journal_day_file_stops_at_its_cap_and_old_days_go() {
        let home = temp_home("cap");
        let dir = home.join("events");
        std::fs::create_dir_all(&dir).unwrap();
        let today = 20_000;
        std::fs::write(dir.join(day_name(today - JOURNAL_DAYS)), "{}\n").unwrap();
        std::fs::write(dir.join(day_name(today - JOURNAL_DAYS + 1)), "{}\n").unwrap();
        std::fs::write(dir.join("other.txt"), "kept").unwrap();
        let mut j = Journal {
            dir: dir.clone(),
            users: 1,
            day: i64::MIN,
            file: None,
            size: 0,
            full: false,
            torn: false,
            failed: false,
        };
        let at = today as u64 * DAY_MS;
        let line = [b"{\"x\":\"".as_slice(), &[b'a'; 64 * 1024], b"\"}\n"].concat();
        for _ in 0..(JOURNAL_DAY_BYTES / line.len() as u64 + 3) {
            write_line(&mut j, at, &line).unwrap();
        }
        write_line(&mut j, at, b"{}\n").unwrap(); // a small line after the full one: not written either
        let text = std::fs::read_to_string(dir.join(day_name(today))).unwrap();
        assert!(text.len() as u64 <= JOURNAL_DAY_BYTES, "{}", text.len());
        assert_eq!(text.matches("journal_full").count(), 1);
        assert!(text.ends_with("\"journal_full\",\"at\":1728000000000}\n"));
        assert!(!dir.join(day_name(today - JOURNAL_DAYS)).exists());
        assert!(dir.join(day_name(today - JOURNAL_DAYS + 1)).exists());
        assert!(dir.join("other.txt").exists());
        let _ = std::fs::remove_dir_all(&home);
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
