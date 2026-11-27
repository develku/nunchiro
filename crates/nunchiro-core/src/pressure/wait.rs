//! Held new-seat starts that wait for memory: the core keeps each as an entry (who asked, what to start, when) in memory
//! only, so a core restart drops them and starts nothing. While one waits the level is read every `tick`; an entry goes
//! when the level is below its asker's hold level on `STREAK` reads in a row, one start at a time, the next not before
//! `gap` and a fresh read. One older than `max` is dropped. Nothing is read while the list is empty.
//!
//! Each entry carries its own start (`Go`), which reports to its asker (a wake line, a schedule's record); the list
//! keeps the window's notes. Only the owner (window, CLI) starts an entry anyway or cancels it.
use crate::sessions::Sessions;
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex, atomic::AtomicBool},
    time::Duration,
};

/// Reads below the hold level in a row before an entry may go.
const STREAK: u32 = 3;
/// Window notes kept for a window that reconnects.
const NOTES: usize = 10;

/// How an entry leaves the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Done {
    /// Memory was free on `STREAK` reads.
    Released,
    /// The owner's Start anyway.
    Anyway,
    /// The owner's Cancel.
    Cancelled,
    /// Older than `max`.
    Dropped,
}

/// Who asked, as the window's list says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Asker {
    Owner,
    /// A session or a lead, by its name.
    Session(String),
    Schedule,
}

/// An entry's start (`Released`, `Anyway`: the started session's id) or its report (`Cancelled`, `Dropped`). Run off
/// every lock, with the hold passed (`passing`).
pub(crate) type Go =
    Box<dyn FnOnce(&Mutex<Sessions>, &AtomicBool, Done) -> Result<String, String> + Send>;

pub(crate) struct Entry {
    id: String,
    /// The same ask repeated while it waits adds no entry.
    key: String,
    agent: String,
    project: String,
    asker: Asker,
    at: u64,
    /// The level that holds it: 4 for the owner's window, 2 for the rest.
    from: i32,
    streak: u32,
    go: Go,
}

/// What the window draws of an entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Shown {
    pub id: String,
    pub agent: String,
    pub project: String,
    /// `you`, `session` or `schedule`.
    pub asker: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    pub at: u64,
}

/// A window note: an entry that started by itself or was dropped.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Note {
    pub n: u64,
    pub agent: String,
    /// `started`, `dropped` or `failed`.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The owner asked: the window opens it as a background tab.
    pub mine: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
pub(crate) struct List {
    entries: Vec<Entry>,
    last_start: Option<u64>,
    notes: VecDeque<Note>,
    n: u64,
}

/// Its times, in ms.
#[derive(Clone, Copy)]
pub(crate) struct Times {
    pub tick: u64,
    pub gap: u64,
    pub max: u64,
}

impl Times {
    /// Every 10 s, 30 s apart, 30 minutes at most. Debug builds: `NUNCHIRO_TEST_MEMORY_WAIT=tick,gap,max` in ms.
    pub(crate) fn now() -> Times {
        let real = Times {
            tick: 10_000,
            gap: 30_000,
            max: 30 * 60_000,
        };
        if !cfg!(debug_assertions) {
            return real;
        }
        let Some(set) = std::env::var("NUNCHIRO_TEST_MEMORY_WAIT").ok() else {
            return real;
        };
        let v: Vec<u64> = set.split(',').filter_map(|v| v.parse().ok()).collect();
        match v[..] {
            [tick, gap, max] => Times { tick, gap, max },
            _ => real,
        }
    }
}

impl List {
    /// Adds an entry unless one with `key` waits; whether it was added.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add(
        &mut self,
        key: String,
        agent: String,
        project: String,
        asker: Asker,
        from: i32,
        at: u64,
        go: Go,
    ) -> bool {
        if self.entries.iter().any(|e| e.key == key) {
            return false;
        }
        self.n += 1;
        self.entries.push(Entry {
            id: format!("w{}", self.n),
            key,
            agent,
            project,
            asker,
            at,
            from,
            streak: 0,
            go,
        });
        true
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// One read of the level (`read`, never called on an empty list) at `now`: the entries that leave, the dropped
    /// ones and at most one released.
    pub(crate) fn tick(
        &mut self,
        read: impl FnOnce() -> Option<i32>,
        now: u64,
        times: Times,
    ) -> Vec<(Entry, Done)> {
        if self.entries.is_empty() {
            return vec![];
        }
        // A reading that failed holds nothing, as at the start.
        let level = read();
        for e in &mut self.entries {
            e.streak = match level {
                Some(level) if level >= e.from => 0,
                _ => e.streak + 1,
            };
        }
        let mut out = vec![];
        let (old, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.entries)
            .into_iter()
            .partition(|e| now.saturating_sub(e.at) >= times.max);
        self.entries = keep;
        out.extend(old.into_iter().map(|e| (e, Done::Dropped)));
        let free = self
            .last_start
            .is_none_or(|t| now.saturating_sub(t) >= times.gap);
        if free && let Some(at) = self.entries.iter().position(|e| e.streak >= STREAK) {
            self.last_start = Some(now);
            out.push((self.entries.remove(at), Done::Released));
        }
        out
    }

    /// The entry `id`, out of the list (the owner's Start anyway or Cancel).
    pub(crate) fn take(&mut self, id: &str) -> Option<Entry> {
        let at = self.entries.iter().position(|e| e.id == id)?;
        Some(self.entries.remove(at))
    }

    pub(crate) fn shown(&self) -> Vec<Shown> {
        self.entries
            .iter()
            .map(|e| Shown {
                id: e.id.clone(),
                agent: e.agent.clone(),
                project: e.project.clone(),
                asker: match e.asker {
                    Asker::Owner => "you",
                    Asker::Session(_) => "session",
                    Asker::Schedule => "schedule",
                },
                by: match &e.asker {
                    Asker::Session(name) => Some(name.clone()),
                    _ => None,
                },
                at: e.at,
            })
            .collect()
    }

    /// The window's note for an entry that left by itself.
    fn note(&mut self, entry: &Entry, done: Done, result: &Result<String, String>) {
        let outcome = match (done, result) {
            (Done::Released, Ok(_)) => "started",
            (Done::Released, Err(_)) => "failed",
            (Done::Dropped, _) => "dropped",
            _ => return,
        };
        self.n += 1;
        self.notes.push_back(Note {
            n: self.n,
            agent: entry.agent.clone(),
            outcome,
            session: result.as_ref().ok().cloned(),
            mine: entry.asker == Asker::Owner,
            error: result
                .as_ref()
                .err()
                .filter(|_| done == Done::Released)
                .cloned(),
        });
        while self.notes.len() > NOTES {
            self.notes.pop_front();
        }
    }
}

static LIST: Mutex<List> = Mutex::new(List {
    entries: Vec::new(),
    last_start: None,
    notes: VecDeque::new(),
    n: 0,
});
/// Wakes the ticker when the first entry arrives.
static ADDED: Condvar = Condvar::new();

/// Bumped by every use that may change the list (`list`), so a window sends the event only after one.
static VERSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The list for a change.
fn list() -> std::sync::MutexGuard<'static, List> {
    VERSION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    read()
}
/// The list to read only.
fn read() -> std::sync::MutexGuard<'static, List> {
    LIST.lock().unwrap_or_else(|e| e.into_inner())
}

/// Changes when the list or its notes may have changed.
pub(crate) fn version() -> u64 {
    VERSION.load(std::sync::atomic::Ordering::SeqCst)
}

thread_local! {
    /// Set while an entry's start runs: its hold is passed (`pressure::check`).
    static PASSING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether the start running on this thread was let through by the waiting list.
pub(crate) fn passing() -> bool {
    PASSING.with(|p| p.get())
}

/// Runs an entry's `go` with its hold passed, then keeps the window's note.
fn run(
    entry: Entry,
    done: Done,
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
) -> Result<String, String> {
    let Entry { go, .. } = entry;
    let shell = Entry {
        go: Box::new(|_, _, _| Ok(String::new())),
        ..entry
    };
    PASSING.with(|p| p.set(true));
    let result = go(registry, stopping, done);
    PASSING.with(|p| p.set(false));
    if let Err(e) = &result
        && matches!(done, Done::Released | Done::Anyway)
    {
        eprintln!("memory pressure: a waiting start failed: {e}");
    }
    list().note(&shell, done, &result);
    crate::pty::wake_windows();
    result
}

/// Keeps a held start to go by itself; `false` when the same ask already waits (nothing added).
pub(crate) fn hold(
    key: String,
    agent: String,
    project: String,
    asker: Asker,
    from: i32,
    go: Go,
) -> bool {
    let added = list().add(key, agent, project, asker, from, crate::queue::now_ms(), go);
    if added {
        eprintln!("memory pressure: a held start waits");
        ADDED.notify_all();
        crate::pty::wake_windows();
    }
    added
}

/// The owner's Start anyway (`anyway`) or Cancel of entry `id`.
pub(crate) fn answer(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    id: &str,
    anyway: bool,
) -> crate::api::Response {
    let entry = list()
        .take(id)
        .ok_or("this start is no longer waiting for memory")?;
    let mine = entry.asker == Asker::Owner;
    let done = match anyway {
        true => Done::Anyway,
        false => Done::Cancelled,
    };
    let result = run(entry, done, registry, stopping);
    match (anyway, result) {
        (true, Ok(session)) => Ok(crate::api::Reply::MemoryWaitStarted { session, mine }),
        (true, Err(e)) => Err(e),
        (false, _) => Ok(crate::api::Reply::Ack),
    }
}

/// The entry asked as `key`, out of the list without running it; `restore` puts it back.
pub(crate) fn take_key(key: &str) -> Option<Entry> {
    let mut list = list();
    let at = list.entries.iter().position(|e| e.key == key)?;
    Some(list.entries.remove(at))
}

/// Drops the entry asked as `key` without running it (its schedule went, or another start took its place); whether
/// one waited.
pub(crate) fn forget(key: &str) -> bool {
    take_key(key).is_some()
}

/// An entry taken by `take_key` waits again, as it was (its time, its count of free reads).
pub(crate) fn restore(entry: Entry) {
    list().entries.push(entry);
    ADDED.notify_all();
    crate::pty::wake_windows();
}

/// The waiting starts, for the owner's list.
pub(crate) fn shown() -> Vec<Shown> {
    read().shown()
}

/// The window's event: the list and the last notes.
pub(crate) fn event() -> String {
    let list = read();
    serde_json::json!({"event": "memory_wait", "entries": list.shown(), "notes": list.notes})
        .to_string()
}

/// The core's ticker: asleep while the list is empty (no read), a read every `tick` while something waits.
pub(crate) fn spawn(
    registry: std::sync::Arc<Mutex<Sessions>>,
    stopping: std::sync::Arc<AtomicBool>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    use std::sync::atomic::Ordering;
    std::thread::Builder::new()
        .name("memory-wait".into())
        .spawn(move || {
            let times = Times::now();
            while !stopping.load(Ordering::SeqCst) {
                {
                    let list = read();
                    if list.is_empty() {
                        // Woken by `hold`: no wakeup and no reading while nothing waits.
                        drop(ADDED.wait(list));
                        continue;
                    }
                }
                std::thread::sleep(Duration::from_millis(times.tick));
                let due = list().tick(super::level, crate::queue::now_ms(), times);
                let changed = !due.is_empty();
                for (entry, done) in due {
                    if stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let _ = run(entry, done, &registry, &stopping);
                }
                if changed {
                    crate::pty::wake_windows();
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const T: Times = Times {
        tick: 10_000,
        gap: 30_000,
        max: 30 * 60_000,
    };
    fn nop() -> Go {
        Box::new(|_, _, _| Ok(String::new()))
    }
    fn add(list: &mut List, key: &str, from: i32, at: u64) -> bool {
        list.add(
            key.into(),
            key.into(),
            "p".into(),
            Asker::Owner,
            from,
            at,
            nop(),
        )
    }
    fn keys(out: &[(Entry, Done)]) -> Vec<(String, Done)> {
        out.iter().map(|(e, d)| (e.key.clone(), *d)).collect()
    }

    #[test]
    fn an_empty_list_reads_nothing() {
        let reads = AtomicUsize::new(0);
        let mut list = List::default();
        for now in 0..100 {
            let out = list.tick(
                || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Some(1)
                },
                now * 10_000,
                T,
            );
            assert!(out.is_empty());
        }
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "no read while nothing waits"
        );
        add(&mut list, "a", 2, 0);
        list.tick(
            || {
                reads.fetch_add(1, Ordering::SeqCst);
                Some(2)
            },
            10_000,
            T,
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "one read per tick while one waits"
        );
    }

    #[test]
    fn an_entry_goes_after_three_free_reads_below_its_level() {
        let mut list = List::default();
        add(&mut list, "window", 4, 0);
        add(&mut list, "session", 2, 0);
        // Warning holds the session's entry, not the window's.
        assert!(list.tick(|| Some(2), 10_000, T).is_empty());
        assert!(list.tick(|| Some(2), 20_000, T).is_empty());
        assert_eq!(
            keys(&list.tick(|| Some(2), 30_000, T)),
            [("window".into(), Done::Released)]
        );
        // A critical read starts the session's count again.
        assert!(list.tick(|| Some(4), 70_000, T).is_empty());
        assert!(list.tick(|| Some(1), 80_000, T).is_empty());
        assert!(list.tick(|| Some(1), 90_000, T).is_empty());
        assert_eq!(
            keys(&list.tick(|| Some(1), 100_000, T)),
            [("session".into(), Done::Released)]
        );
        assert!(list.is_empty());
    }

    #[test]
    fn one_start_at_a_time_at_least_the_gap_apart() {
        let mut list = List::default();
        for k in ["a", "b", "c"] {
            add(&mut list, k, 2, 0);
        }
        let mut started = vec![];
        for i in 1..=20u64 {
            let now = i * 10_000;
            // Warning again after the first start stops the rest.
            let level = if (5..=8).contains(&i) { 2 } else { 1 };
            for (e, d) in list.tick(|| Some(level), now, T) {
                assert_eq!(d, Done::Released);
                started.push((e.key, now));
            }
        }
        let keys: Vec<_> = started.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["a", "b", "c"], "oldest first");
        for pair in started.windows(2) {
            assert!(pair[1].1 - pair[0].1 >= T.gap, "{started:?}");
        }
        // a at 30 s; warning from 50 s to 80 s holds b until three free reads after it (90, 100, 110 s).
        assert_eq!(started[1].1, 110_000, "{started:?}");
    }

    #[test]
    fn an_entry_older_than_the_longest_wait_is_dropped() {
        let short = Times {
            tick: 10,
            gap: 30,
            max: 100,
        };
        let mut list = List::default();
        add(&mut list, "a", 2, 0);
        assert!(list.tick(|| Some(2), 90, short).is_empty());
        assert_eq!(
            keys(&list.tick(|| Some(2), 100, short)),
            [("a".into(), Done::Dropped)]
        );
        assert!(list.is_empty());
    }

    #[test]
    fn the_same_ask_waits_once() {
        let mut list = List::default();
        assert!(add(&mut list, "lead:Bo", 2, 0));
        assert!(!add(&mut list, "lead:Bo", 2, 5));
        assert_eq!(list.shown().len(), 1);
        let id = list.shown()[0].id.clone();
        assert!(list.take(&id).is_some());
        assert!(list.take(&id).is_none());
        assert!(add(&mut list, "lead:Bo", 2, 9), "asked again after it left");
    }

    #[test]
    fn notes_say_what_went_by_itself() {
        let mut list = List::default();
        add(&mut list, "a", 2, 0);
        let e = list.take("w1").unwrap();
        list.note(&e, Done::Released, &Ok("s1".into()));
        list.note(&e, Done::Dropped, &Err(String::new()));
        list.note(&e, Done::Cancelled, &Err(String::new()));
        list.note(&e, Done::Anyway, &Ok("s2".into()));
        let outcomes: Vec<_> = list.notes.iter().map(|n| n.outcome).collect();
        assert_eq!(
            outcomes,
            ["started", "dropped"],
            "the owner's own answers leave no note"
        );
        assert_eq!(list.notes[0].session.as_deref(), Some("s1"));
        assert!(list.notes[0].mine);
    }
}
