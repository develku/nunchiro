//! Ticket 990 slice g: the job ledger (concept approved by the owner on 2026-11-16 night,
//! docs/design/leader-room/concept-report-1116.html). A task is an outcome with acceptance conditions that uses zero
//! or more worktrees. A lead (an agent) only decides; this record is the core's, so a lead's new conversation and a
//! core restart read the same tasks, seats, direct corrections and review.
//!
//! One file, `<home>/ledger.json`, for every place (a project root, or the Home folder). What can be read from
//! somewhere else is not stored here: whether a seat lives (the registry), an open question (the room's log), and
//! whether a review still holds (the worktree's revision now, compared at each read).
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_MAX: u64 = 4 << 20;
const OPEN_MAX: usize = 200;
/// Closed tasks kept, newest first out.
const CLOSED_KEPT: usize = 200;
const TITLE_MAX: usize = 200;
const ACCEPT_MAX: usize = 8;
const LINE_MAX: usize = 300;
/// What the user told a task's seats directly: the newest are kept.
const TOLD_KEPT: usize = 50;
const SEATS_KEPT: usize = 40;
/// The merge card shows at most two lessons: a third pushes the oldest out.
pub const LEARNED_KEPT: usize = 2;
/// The same words to the same seat inside this window are one correction (the prompt paths can each report a send).
const TOLD_TWICE_MS: u64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    /// The project root, or the Home folder.
    pub place: PathBuf,
    /// The outcome, one line.
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accept: Vec<String>,
    /// The lead (team.rs teammate id) it was made for; a teammate id, so the task outlives the lead's session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    /// Made by the core for a lead's worktree that named no task: its title is the worktree's name.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worktrees: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seats: Vec<Seat>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub told: Vec<Told>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<Review>,
    /// Slice h: lessons its seats proposed, at most `LEARNED_KEPT`. They are no notes: the user's yes on the merge
    /// card copies one to `notes.json`; a dropped task's lessons go with it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub learned: Vec<Lesson>,
    /// Slice h: the user's yes to the merge, for the files at this revision only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<MergeOk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<Closed>,
    /// Ticket 1004: what its seats' check-ins found; absent until the first one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall: Option<Stall>,
    pub created: u64,
    pub updated: u64,
}

/// Ticket 1004: a task's check-ins. A check-in is a seat's turn that ended and was told to its lead (sessions/wake.rs).
/// Progress is what the core records itself: the task's record (`updated`: a seat, a review, a worktree, the user's
/// words) and its worktrees' files (`revision`). Never what an agent wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stall {
    /// `updated` and the revision at the last check-in; empty when the task has no worktree that could be read.
    pub mark: String,
    /// Check-ins in a row that found `mark` as the one before left it.
    pub quiet: u32,
    /// The last check-in's error (a failed seat's cause; empty: none), and how many in a row said the same.
    pub error: String,
    pub same: u32,
    /// Its card was raised. One per stall: a card the user dismissed does not come back until the task moved.
    pub card: bool,
}
/// A task stalls at this many quiet check-ins in a row, or at this many in a row with the same error.
pub const STALL_QUIET: u32 = 2;
pub const STALL_SAME: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lesson {
    pub text: String,
    /// Who proposed it, as the card shows it ("Reviewer · review-tax").
    pub name: String,
    /// The proposer's role, the default when the user keeps it as a role note.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cites: Option<String>,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeOk {
    pub revision: String,
    pub at: u64,
}

/// One session of a role on this task. Never reused: a second builder after the first ended is a second seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    pub session: String,
    pub name: String,
    pub role: String,
    /// Whether this seat changes files. One live writer per worktree.
    pub writes: bool,
    /// Slice h: its first prompt from the lead carried the notes it reads.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub briefed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<PathBuf>,
    pub at: u64,
}

/// What the user said to a seat directly, in the user's words (masked and cut by the caller).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Told {
    pub at: u64,
    pub session: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Review {
    /// What was reviewed: `revision` of every worktree of the task at that moment, in the task's order.
    pub revision: String,
    pub pass: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// The reviewing seat's session, or `user`.
    pub by: String,
    pub name: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Closed {
    pub at: u64,
    /// `done` (the lead or the user said so), `merged` (its last worktree went with nothing left outside the project),
    /// `removed` (an unnamed task's worktree went with its branch kept), `dropped`.
    pub how: String,
}

/// Slice i: what a place (a project, or Home) decided for the work done in it. A role carries neither: the same
/// Builder asks before each edit in one project and edits freely in another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    /// The way of working: `solo` (build only), `team` (build, then a fresh review), `strict` (team plus a security
    /// review). The guide's `levels.md`.
    pub way: String,
    /// What a seat that writes may do without asking: `ask` (every edit and command asks the user) or `edits` (it
    /// edits files in its worktree without asking; commands still ask).
    pub seats: String,
}
impl Default for Place {
    fn default() -> Self {
        Self {
            way: "team".into(),
            seats: "ask".into(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    next: u32,
    tasks: Vec<Task>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    places: std::collections::BTreeMap<PathBuf, Place>,
}

/// A task as a reader gets it: the record, and what the core worked out now.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct View {
    #[serde(flatten)]
    pub task: Task,
    /// `needs` (a seat waits for the user), `working`, `review` (a reviewer runs, or the files changed after the
    /// review), `changes` (the review asked for changes), `approved` (the review passed and nothing changed since),
    /// `merge` (approved, and the user said yes to merging these files), `asked` (no seat works and one of its room asks
    /// is open), `idle`, or how it closed.
    pub state: String,
    /// A review exists and the worktrees are no longer at its revision.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
    /// The seats whose session runs now.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub live: Vec<String>,
    /// Open room asks of its seats, as "from → to: words".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<String>,
    /// The seats (session ids) with an open ask: they wait for the answer, also while their turn runs the wait. The
    /// window reads the state from the seats again with it (look 1117 v11 B N11-S2-3).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asking: Vec<String>,
}

/// A change reads, edits and writes the whole file: one at a time, in this process (one core per home).
static CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct Ledger {
    file: PathBuf,
}

fn line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // The ledger is read by every session of the place: a secret typed into a title or a review note is masked, as in notes.
    let flat = String::from_utf8_lossy(&crate::logs::mask(flat.as_bytes())).into_owned();
    flat.chars().take(max).collect()
}

impl Ledger {
    pub fn open(home: &Path) -> Self {
        Self {
            file: home.join("ledger.json"),
        }
    }

    fn read(&self) -> Result<Stored, String> {
        let bytes = match store::open_regular(&self.file)
            .and_then(|file| store::read_capped(file, FILE_MAX))
        {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Stored {
                    version: 1,
                    next: 1,
                    tasks: vec![],
                    places: Default::default(),
                });
            }
            Err(e) => return Err(format!("ledger.json: {e}")),
        };
        let stored: Stored =
            serde_json::from_slice(&bytes).map_err(|e| format!("ledger.json: {e}"))?;
        if stored.version != 1 {
            return Err(format!(
                "ledger.json has version {}, this build reads 1",
                stored.version
            ));
        }
        Ok(stored)
    }

    /// Ticket 1040 (Locate): the place moved; its tasks, its place record and the worktrees under it follow.
    pub(crate) fn locate(&self, from: &Path, to: &Path) -> Result<(), String> {
        self.change(|stored| {
            let mut changed = false;
            let mut go = |p: &mut PathBuf| {
                if let Some(next) = crate::tree::moved_path(p, from, to) {
                    (*p, changed) = (next, true);
                }
            };
            for task in &mut stored.tasks {
                go(&mut task.place);
                task.worktrees.iter_mut().for_each(&mut go);
                let seats = task.seats.iter_mut();
                seats.filter_map(|s| s.worktree.as_mut()).for_each(&mut go);
            }
            if let Some(place) = stored.places.remove(from) {
                stored.places.insert(to.into(), place);
                changed = true;
            }
            Ok(((), changed))
        })
    }

    /// Reads, runs `f`, and writes when `f` says something changed.
    fn change<T>(
        &self,
        f: impl FnOnce(&mut Stored) -> Result<(T, bool), String>,
    ) -> Result<T, String> {
        let _one = CHANGE
            .lock()
            .map_err(|_| "ledger unavailable".to_string())?;
        let mut stored = self.read()?;
        let (out, changed) = f(&mut stored)?;
        if changed {
            // The oldest closed tasks go first; an open task is never dropped.
            let closed = stored.tasks.iter().filter(|t| t.closed.is_some()).count();
            let mut over = closed.saturating_sub(CLOSED_KEPT);
            stored.tasks.retain(|t| {
                let drop = over > 0 && t.closed.is_some();
                over -= drop as usize;
                !drop
            });
            // Never a file its own reader refuses: closed tasks go, oldest first, until it fits.
            let mut bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
            while bytes.len() as u64 > FILE_MAX {
                let Some(at) = stored.tasks.iter().position(|t| t.closed.is_some()) else {
                    return Err("the ledger is full: close or drop tasks first".into());
                };
                stored.tasks.remove(at);
                bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
            }
            store::write_capped(&self.file, &bytes, FILE_MAX)?;
        }
        Ok(out)
    }

    pub fn list(&self) -> Result<Vec<Task>, String> {
        Ok(self.read()?.tasks)
    }

    /// What this place decided; the defaults until the user changes one.
    pub fn place(&self, place: &Path) -> Place {
        self.read()
            .ok()
            .and_then(|s| s.places.get(place).cloned())
            .unwrap_or_default()
    }

    /// The user's choice for a place: its way of working and/or what its seats may do without asking.
    pub fn set_place(
        &self,
        place: &Path,
        way: Option<&str>,
        seats: Option<&str>,
    ) -> Result<Place, String> {
        if way.is_some_and(|w| !["solo", "team", "strict"].contains(&w)) {
            return Err("the way of working is solo, team or strict".into());
        }
        if seats.is_some_and(|s| !["ask", "edits"].contains(&s)) {
            return Err(
                "seats either ask before each edit (ask) or edit without asking (edits)".into(),
            );
        }
        self.change(|s| {
            let p = s.places.entry(place.to_path_buf()).or_default();
            if let Some(way) = way {
                p.way = way.into();
            }
            if let Some(seats) = seats {
                p.seats = seats.into();
            }
            Ok((p.clone(), true))
        })
    }

    /// A new open task, or the open one of this place that already has this title (a lead that asks twice, after a
    /// restart or in a new conversation, gets the same task back): `false` then.
    pub fn make(
        &self,
        place: &Path,
        lead: Option<&str>,
        title: &str,
        accept: &[String],
        auto: bool,
        now: u64,
    ) -> Result<(Task, bool), String> {
        let title = line(title, TITLE_MAX);
        if title.is_empty() {
            return Err("a task needs its outcome in one line".into());
        }
        if accept.len() > ACCEPT_MAX {
            return Err(format!(
                "a task takes at most {ACCEPT_MAX} acceptance conditions"
            ));
        }
        let accept: Vec<String> = accept
            .iter()
            .map(|a| line(a, LINE_MAX))
            .filter(|a| !a.is_empty())
            .collect();
        self.change(|s| {
            let same = |t: &&mut Task| {
                t.closed.is_none()
                    && t.place == place
                    && t.title.to_lowercase() == title.to_lowercase()
            };
            if let Some(t) = s.tasks.iter_mut().find(same) {
                // The explicit call wins over the core's own: the task is the lead's from now, with its conditions.
                let named = t.auto && !auto;
                if named {
                    t.auto = false;
                    if t.accept.is_empty() {
                        t.accept = accept;
                    }
                    t.updated = now;
                }
                return Ok(((t.clone(), false), named));
            }
            if s.tasks.iter().filter(|t| t.closed.is_none()).count() >= OPEN_MAX {
                return Err(format!("the ledger holds at most {OPEN_MAX} open tasks"));
            }
            let task = Task {
                id: format!("t{}", s.next),
                place: place.into(),
                title,
                accept,
                lead: lead.map(Into::into),
                auto,
                worktrees: vec![],
                seats: vec![],
                told: vec![],
                review: None,
                learned: vec![],
                merge: None,
                closed: None,
                stall: None,
                created: now,
                updated: now,
            };
            s.next += 1;
            s.tasks.push(task.clone());
            Ok(((task, true), true))
        })
    }

    /// The open task that uses the worktree at `path`.
    pub fn of_worktree(&self, path: &Path) -> Option<Task> {
        let tasks = self.list().ok()?;
        tasks
            .into_iter()
            .find(|t| t.closed.is_none() && t.worktrees.iter().any(|w| w == path))
    }

    /// The open task this session is a seat of.
    pub fn of_seat(&self, session: &str) -> Option<Task> {
        let tasks = self.list().ok()?;
        tasks
            .into_iter()
            .find(|t| t.closed.is_none() && t.seats.iter().any(|s| s.session == session))
    }

    /// A lead's worktree joined its team: it goes to the open task of the same name, or to a task made for it.
    pub fn worktree_made(
        &self,
        place: &Path,
        lead: &str,
        path: &Path,
        name: &str,
        now: u64,
    ) -> Result<Task, String> {
        if let Some(task) = self.of_worktree(path) {
            return Ok(task);
        }
        let (task, _) = self.make(place, Some(lead), name, &[], true, now)?;
        self.attach(&task.id, path, now)
    }

    /// Moves the worktree to this task, with the seats that sit in it. An unnamed task left with nothing is deleted.
    pub fn attach(&self, id: &str, path: &Path, now: u64) -> Result<Task, String> {
        self.change(|s| {
            let to = s
                .tasks
                .iter()
                .position(|t| t.id == id && t.closed.is_none())
                .ok_or_else(|| format!("no open task {id}"))?;
            if s.tasks[to].worktrees.iter().any(|w| w == path) {
                return Ok((s.tasks[to].clone(), false));
            }
            let mut seats = vec![];
            let mut told = vec![];
            for t in s.tasks.iter_mut().filter(|t| t.closed.is_none()) {
                if t.worktrees.iter().any(|w| w == path) {
                    t.worktrees.retain(|w| w != path);
                    let (moved, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut t.seats)
                        .into_iter()
                        .partition(|s| s.worktree.as_deref() == Some(path));
                    t.seats = kept;
                    let sessions: Vec<&str> = moved.iter().map(|s| s.session.as_str()).collect();
                    let (went, stay): (Vec<_>, Vec<_>) = std::mem::take(&mut t.told)
                        .into_iter()
                        .partition(|n| sessions.contains(&n.session.as_str()));
                    t.told = stay;
                    told.extend(went);
                    seats.extend(moved);
                    t.review = None; // it was bound to the worktree that left
                    t.updated = now;
                }
            }
            let target = s.tasks[to].id.clone();
            s.tasks
                .retain(|t| t.id == target || !(t.auto && t.closed.is_none() && empty(t)));
            let t = s
                .tasks
                .iter_mut()
                .find(|t| t.id == target)
                .ok_or("task lost")?;
            t.worktrees.push(path.into());
            t.seats.extend(seats);
            t.told.extend(told);
            t.review = None; // a review never covers a worktree it did not see
            t.updated = now;
            Ok((t.clone(), true))
        })
    }

    /// The worktree's folder went. `merged`: nothing of it is left outside the project. The task closes with its
    /// last worktree when the work is in the project; an unnamed task closes either way.
    /// Returns the task's id when this closed it.
    pub fn worktree_gone(
        &self,
        path: &Path,
        merged: Option<bool>,
        now: u64,
    ) -> Result<Option<String>, String> {
        self.change(|s| {
            // Look 1117 v14 N14-S3-2: a task closed before its folder went (merged, closed by `task list`) lists it no more.
            let mut changed = false;
            for t in s.tasks.iter_mut().filter(|t| t.closed.is_some()) {
                let before = t.worktrees.len();
                t.worktrees.retain(|w| w != path);
                changed |= t.worktrees.len() != before;
            }
            let Some(t) = s
                .tasks
                .iter_mut()
                .find(|t| t.closed.is_none() && t.worktrees.iter().any(|w| w == path))
            else {
                return Ok((None, changed));
            };
            t.worktrees.retain(|w| w != path);
            t.updated = now;
            if t.worktrees.is_empty() && (merged == Some(true) || t.auto) {
                let how = if merged == Some(true) {
                    "merged"
                } else {
                    "removed"
                };
                t.closed = Some(Closed {
                    at: now,
                    how: how.into(),
                });
            }
            Ok((t.closed.as_ref().map(|_| t.id.clone()), true))
        })
    }

    /// The user took the worktree back from the lead: it is no task's any more.
    pub fn worktree_taken(&self, path: &Path, now: u64) -> Result<(), String> {
        self.change(|s| {
            let mut changed = false;
            for t in s.tasks.iter_mut().filter(|t| t.closed.is_none()) {
                if t.worktrees.iter().any(|w| w == path) {
                    t.worktrees.retain(|w| w != path);
                    t.seats.retain(|s| s.worktree.as_deref() != Some(path));
                    t.review = None;
                    t.updated = now;
                    changed = true;
                }
            }
            s.tasks
                .retain(|t| !(t.auto && t.closed.is_none() && empty(t)));
            Ok(((), changed))
        })
    }

    /// One writer per worktree: refused while a seat that writes lives in this task's worktree.
    pub fn writer_free(&self, path: &Path, live: impl Fn(&str) -> bool) -> Result<(), String> {
        let Some(task) = self.of_worktree(path) else {
            return Ok(());
        };
        match task
            .seats
            .iter()
            .find(|s| s.writes && s.worktree.as_deref() == Some(path) && live(&s.session))
        {
            Some(s) => Err(format!(
                "task {} ({}) already has a writer in this worktree: {} ({}). Send it the work \
                 (`nunchiro agent send`), or start a reviewer (a name that starts with `review`).",
                task.id, task.title, s.name, s.session
            )),
            None => Ok(()),
        }
    }

    /// Records a seat on the task of its worktree. Nothing happens for a folder no task uses.
    pub fn seat(
        &self,
        path: &Path,
        session: &str,
        name: &str,
        now: u64,
        live: &dyn Fn(&str) -> bool,
    ) -> Result<Option<Task>, String> {
        let Some(task) = self.of_worktree(path) else {
            return Ok(None);
        };
        self.seat_on(&task.id, session, name, Some(path), now, live)
            .map(Some)
    }

    /// Records a seat on a named task (`worktree` absent: a task that uses none).
    pub fn seat_on(
        &self,
        id: &str,
        session: &str,
        name: &str,
        worktree: Option<&Path>,
        now: u64,
        live: &dyn Fn(&str) -> bool,
    ) -> Result<Task, String> {
        // Slice i: the seat's name says its role ("Reviewer · tax"), by the user's roles.
        let (role, writes) = crate::roles::of(self.file.parent().unwrap_or(Path::new("")), name);
        self.change(|s| {
            // A session sits on one task.
            for t in s.tasks.iter_mut().filter(|t| t.id != id) {
                t.seats.retain(|s| s.session != session);
            }
            let t = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none())
                .ok_or_else(|| format!("no open task {id}"))?;
            if t.seats.iter().any(|s| s.session == session) {
                return Ok((t.clone(), false));
            }
            // Full: the oldest ended seat makes room. A running seat is never forgotten (its record is what keeps a
            // second writer out).
            if t.seats.len() >= SEATS_KEPT {
                let at = t
                    .seats
                    .iter()
                    .position(|s| !live(&s.session))
                    .ok_or_else(|| format!("task {id} already has {SEATS_KEPT} running seats"))?;
                t.seats.remove(at);
            }
            t.seats.push(Seat {
                session: session.into(),
                name: name.into(),
                role: role.clone(),
                writes,
                briefed: false,
                worktree: worktree.map(Into::into),
                at: now,
            });
            t.updated = now;
            Ok((t.clone(), true))
        })
    }

    /// The seat got its notes.
    pub fn briefed(&self, session: &str) -> Result<(), String> {
        self.change(|s| {
            let mut changed = false;
            for seat in s.tasks.iter_mut().flat_map(|t| t.seats.iter_mut()) {
                if seat.session == session && !seat.briefed {
                    seat.briefed = true;
                    changed = true;
                }
            }
            Ok(((), changed))
        })
    }

    /// A resumed run has a new session id: the seat follows it.
    pub fn reseat(&self, prior: &[String], next: &str) -> Result<(), String> {
        if prior.is_empty()
            || self
                .list()?
                .iter()
                .all(|t| t.seats.iter().all(|s| !prior.contains(&s.session)))
        {
            return Ok(());
        }
        self.change(|s| {
            for seat in s.tasks.iter_mut().flat_map(|t| t.seats.iter_mut()) {
                if prior.contains(&seat.session) {
                    seat.session = next.into();
                }
            }
            for told in s.tasks.iter_mut().flat_map(|t| t.told.iter_mut()) {
                if prior.contains(&told.session) {
                    told.session = next.into();
                }
            }
            Ok(((), true))
        })
    }

    /// What the user said to a seat directly. The task is the seat's, or the one of the folder it works in. True when
    /// a task took it.
    pub fn told(
        &self,
        session: &str,
        cwd: &Path,
        name: &str,
        text: &str,
        now: u64,
    ) -> Result<bool, String> {
        let text = line(text, LINE_MAX);
        if text.is_empty() {
            return Ok(false);
        }
        let Some(task) = self.of_seat(session).or_else(|| self.of_worktree(cwd)) else {
            return Ok(false);
        };
        self.change(|s| {
            let Some(t) = s.tasks.iter_mut().find(|t| t.id == task.id) else {
                return Ok((false, false));
            };
            if t.told.iter().rev().any(|n| {
                n.session == session && n.text == text && now.saturating_sub(n.at) < TOLD_TWICE_MS
            }) {
                return Ok((true, false));
            }
            t.told.push(Told {
                at: now,
                session: session.into(),
                name: name.into(),
                text,
            });
            if t.told.len() > TOLD_KEPT {
                t.told.remove(0);
            }
            t.updated = now;
            Ok((true, true))
        })
    }

    /// The review of what the worktrees hold now. A later review replaces it.
    pub fn review(&self, id: &str, review: Review) -> Result<Task, String> {
        self.change(|s| {
            let t = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none())
                .ok_or_else(|| format!("no open task {id}"))?;
            t.updated = review.at;
            t.merge = None; // the yes was for the earlier review's files
            t.review = Some(Review {
                note: line(&review.note, LINE_MAX),
                ..review
            });
            Ok((t.clone(), true))
        })
    }

    /// A seat's lesson from this task, for the merge card.
    pub fn learn(&self, id: &str, lesson: Lesson) -> Result<Task, String> {
        let text = crate::notes::line(&lesson.text);
        if text.is_empty() {
            return Err("a lesson is a line or two".into());
        }
        self.change(|s| {
            let t = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none())
                .ok_or_else(|| format!("no open task {id}"))?;
            if t.learned.iter().any(|l| l.text == text) {
                return Ok((t.clone(), false));
            }
            t.updated = lesson.at;
            t.learned.push(Lesson {
                text,
                cites: lesson.cites.as_deref().and_then(crate::notes::inside),
                ..lesson
            });
            if t.learned.len() > LEARNED_KEPT {
                t.learned.remove(0);
            }
            Ok((t.clone(), true))
        })
    }

    /// The user's yes to merging the files at `revision`.
    pub fn merge_ok(&self, id: &str, revision: &str, now: u64) -> Result<Task, String> {
        self.change(|s| {
            let t = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none())
                .ok_or_else(|| format!("no open task {id}"))?;
            t.merge = Some(MergeOk {
                revision: revision.into(),
                at: now,
            });
            t.updated = now;
            Ok((t.clone(), true))
        })
    }

    /// The user's no: any yes left from an earlier answer goes. A task the ledger does not hold open has none.
    pub fn merge_no(&self, id: &str, now: u64) -> Result<(), String> {
        self.change(|s| {
            match s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none() && t.merge.is_some())
            {
                Some(t) => {
                    t.merge = None;
                    t.updated = now;
                    Ok(((), true))
                }
                None => Ok(((), false)),
            }
        })
    }

    /// Ticket 1004: one check-in of open task `id`. `revision` is its worktrees' now (`revision_of`, read outside
    /// every lock); `None` (no worktree, or one that cannot be read) is never counted quiet.
    /// shortcut: a task with no worktree stalls on a repeated error only (the core sees none of its progress), and
    /// work kept in untracked files reads as quiet (`revision` leaves them out); a stall mark of its own when either bites.
    /// `Some(true)`: it just stalled (`STALL_QUIET`, `STALL_SAME`): its card is raised. `Some(false)`: it moved
    /// again: the card goes. `updated` is left alone: a check-in is no progress.
    pub fn check_in(
        &self,
        id: &str,
        revision: Option<&str>,
        error: Option<&str>,
    ) -> Result<Option<bool>, String> {
        self.change(|s| {
            let Some(t) = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none())
            else {
                return Ok((None, false));
            };
            let was = t.stall.clone().unwrap_or_default();
            let mark = revision
                .map(|r| format!("{} {r}", t.updated))
                .unwrap_or_default();
            let quiet = if !mark.is_empty() && mark == was.mark {
                was.quiet + 1
            } else {
                0
            };
            let same = match error {
                Some(e) if e == was.error => was.same + 1,
                Some(_) => 1,
                None => 0,
            };
            let now = Stall {
                mark,
                quiet,
                error: error.unwrap_or_default().into(),
                same,
                card: quiet >= STALL_QUIET || same >= STALL_SAME,
            };
            let turned = (now.card != was.card).then_some(now.card);
            let changed = now != was;
            t.stall = Some(now);
            Ok((turned, changed))
        })
    }

    pub fn close(&self, id: &str, how: &str, now: u64) -> Result<Task, String> {
        self.change(|s| {
            let t = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| format!("no task {id}"))?;
            if t.closed.is_some() {
                return Ok((t.clone(), false));
            }
            t.closed = Some(Closed {
                at: now,
                how: how.into(),
            });
            t.updated = now;
            let closed = t.clone();
            // A task the core made for a new worktree, dropped before anyone sat on it, leaves no row (real-app look
            // 11-17: a lead made its worktrees, then its own tasks, and the view read "2 dropped today").
            if how == "dropped"
                && closed.auto
                && closed.seats.is_empty()
                && closed.told.is_empty()
                && closed.review.is_none()
            {
                s.tasks.retain(|t| t.id != id);
            }
            Ok((closed, true))
        })
    }
}

/// The task's work is in its place: the user said yes to exactly these committed files, and the place's checkout
/// holds every worktree's commit. Reads git; call it with no lock held.
fn in_project(t: &Task) -> bool {
    let Some(yes) = &t.merge else {
        return false;
    };
    if t.closed.is_some()
        || t.worktrees.is_empty()
        || !t.review.as_ref().is_some_and(|r| r.pass)
        || yes.revision.contains('+')
        || revision_of(t).as_deref() != Some(yes.revision.as_str())
    {
        return false;
    }
    let wait = std::time::Duration::from_secs(10);
    yes.revision.split(' ').all(|commit| {
        crate::process::git_read(&t.place, &["merge-base", commit, "HEAD"], wait)
            .ok()
            .and_then(|out| String::from_utf8(out).ok())
            .is_some_and(|base| base.trim() == commit)
    })
}

fn empty(t: &Task) -> bool {
    t.worktrees.is_empty() && t.seats.is_empty() && t.told.is_empty() && t.review.is_none()
}

/// The most a folder's uncommitted files may hold for a review to bind to them.
const DIRTY_MAX: u64 = 256 << 20;

/// What a folder holds now, as one word: its commit, and a digest of every uncommitted change to a tracked file (the
/// file's whole content). Untracked files are left out (seen with real agents: a lane's BRIEF.md, REPORT.md and a
/// test run's `__pycache__` made every review stale and every merge ask refused): they are in no merge, and one
/// that is committed later moves the commit. Two reads are equal only when no tracked file changed between them. `None`: not readable (the folder is gone or
/// not git, the listing was cut, a file cannot be read, or the uncommitted files are over `DIRTY_MAX`): then no
/// review binds and none holds.
pub fn revision(dir: &Path) -> Option<String> {
    use sha2::Digest;
    use std::os::unix::ffi::OsStrExt;
    let wait = std::time::Duration::from_secs(10);
    let head = crate::process::git_read(dir, &["rev-parse", "HEAD"], wait).ok()?;
    let head = String::from_utf8(head).ok()?.trim().to_string();
    // `git_read` refuses a listing that reached its cap, so a cut one is never hashed as if whole.
    let status = crate::process::git_read(
        dir,
        // No rename detection: every entry is then "XY path", with no second, bare name that could read as an entry.
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=no",
            "--no-renames",
        ],
        wait,
    )
    .ok()?;
    if status.is_empty() {
        return Some(head);
    }
    let mut h = sha2::Sha256::new();
    h.update(&status);
    let mut left = DIRTY_MAX;
    for entry in status.split(|b| *b == 0) {
        let Some(path) = entry.get(3..).filter(|_| entry.get(2) == Some(&b' ')) else {
            continue;
        };
        // Git lists paths inside the folder; one that is not (absolute, or with `..`) is not read: no revision.
        let inside = Path::new(std::ffi::OsStr::from_bytes(path));
        if !inside
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        let path = dir.join(inside);
        let Ok(meta) = path.symlink_metadata() else {
            continue; // deleted: the listing says so
        };
        if meta.file_type().is_symlink() {
            h.update(std::fs::read_link(&path).ok()?.as_os_str().as_bytes());
        } else if meta.is_file() {
            // Judged on the open file (a link or a device put there after the listing is refused), and counted as it
            // is read: a file that grows meanwhile ends the read at the cap instead of running on.
            let mut file = store::open_regular(&path).ok()?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                match std::io::Read::read(&mut file, &mut buf).ok()? {
                    0 => break,
                    n => {
                        left = left.checked_sub(n as u64)?;
                        h.update(&buf[..n]);
                    }
                }
            }
        }
        h.update([0]);
    }
    let digest = h.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Some(format!("{head}+{hex}"))
}

/// The revision of a whole task: each worktree's, in order. Empty for a task that uses none. `None` when one cannot be
/// read.
pub fn revision_of(task: &Task) -> Option<String> {
    task.worktrees
        .iter()
        .map(|w| revision(w))
        .collect::<Option<Vec<_>>>()
        .map(|all| all.join(" "))
}

/// Ticket 1004: a check-in as the registry saw it, under its lock: which seat's turn ended, on which task.
pub(crate) struct CheckIn {
    pub task: Task,
    /// The seat's session and its name.
    pub session: String,
    pub name: String,
    /// A failed seat's cause.
    pub error: Option<String>,
}
impl CheckIn {
    /// Reads git and writes the ledger, so with no registry lock held. `Ledger::check_in`'s answer.
    pub(crate) fn stalled(&self, home: &Path) -> Option<bool> {
        let revision = (!self.task.worktrees.is_empty())
            .then(|| revision_of(&self.task))
            .flatten();
        Ledger::open(home)
            .check_in(&self.task.id, revision.as_deref(), self.error.as_deref())
            .unwrap_or_else(|e| {
                eprintln!("task {}: check-in not recorded: {e}", self.task.id);
                None
            })
    }
}

/// What the registry knows about a seat's session at this moment.
#[derive(Debug, Clone, Default)]
pub struct SeatNow {
    pub live: bool,
    /// `working`, `waiting`, `question`, `permission`, `exited`, `failed`, `lost` (events.rs).
    pub state: &'static str,
}

/// The state word. `asks` are the seats' open asks, each as (the asking session, its line). `revision` is the task's
/// revision now (`revision_of`), read outside every lock.
pub fn view(
    task: Task,
    seats: &dyn Fn(&str) -> SeatNow,
    asks: Vec<(String, String)>,
    revision: &str,
) -> View {
    // Look 1117 v14 N14-S3-3: an ask waits only while its seat's agent lives. One that quit in its shell (`agent_ended`,
    // the session still running) gets no `lost` event (room_lost reads the session state), so its ask stays open.
    let asks: Vec<_> = asks
        .into_iter()
        .filter(|(from, _)| seats(from).live)
        .collect();
    // Look v10 Home S2-3: a seat that waits for its open ask inside its turn (`agent ask --wait`, or a loop on
    // `agent check`) runs a command, but it waits for the answer: it is not working.
    let asking = |s: &Seat| asks.iter().any(|(from, _)| *from == s.session);
    let now: Vec<(&Seat, SeatNow)> = task.seats.iter().map(|s| (s, seats(&s.session))).collect();
    let waiting: Vec<String> = task
        .seats
        .iter()
        .filter(|s| asking(s))
        .map(|s| s.session.clone())
        .collect();
    let live: Vec<String> = now
        .iter()
        .filter(|(_, n)| n.live)
        .map(|(s, _)| s.session.clone())
        .collect();
    // A closed task's files are not read: its review is history, never "changed after the review".
    let stale =
        task.closed.is_none() && task.review.as_ref().is_some_and(|r| r.revision != revision);
    let needs = now
        .iter()
        .any(|(_, n)| n.live && matches!(n.state, "question" | "permission"));
    let reviewing = now
        .iter()
        .any(|(s, n)| n.live && !s.writes && n.state == "working" && !asking(s));
    let working = now
        .iter()
        .any(|(s, n)| n.live && s.writes && n.state == "working" && !asking(s));
    let state = match (&task.closed, &task.review) {
        (Some(c), _) => c.how.as_str(),
        _ if needs => "needs",
        _ if reviewing => "review",
        _ if working => "working",
        // Look v9 B N2-S2-1: a seat whose ask in the room is open waits for that answer (its lead's, by design), not idle.
        _ if !asks.is_empty() => "asked",
        // Changed after the review: the approval (or the asked change) no longer speaks for these files.
        (_, Some(_)) if stale => "review",
        // The user said yes to merging exactly these files.
        (_, Some(r)) if r.pass && task.merge.as_ref().is_some_and(|m| m.revision == revision) => {
            "merge"
        }
        (_, Some(r)) if r.pass => "approved",
        (_, Some(_)) => "changes",
        _ => "idle",
    }
    .to_string();
    View {
        task,
        state,
        stale,
        live,
        asks: asks.into_iter().map(|(_, line)| line).collect(),
        asking: waiting,
    }
}

/// Home view change 1 (11-17): one registered project as the Home view's Projects part shows it. Every number is the
/// core's, from the ledger, the decision queue and the sessions; no agent writes one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DigestRow {
    pub project: PathBuf,
    /// The project's lead (a teammate id); none: the row is never counted for that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    /// Look 11-17 v5 item 4: "failed" when the lead's seat session failed and none of its sessions runs; look 11-17 v9
    /// (Home S2-3): "missing" when the project's folder is gone; absent else. Either needs the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_state: Option<String>,
    pub open: usize,
    /// Pending decisions only: its sessions' asks and the owner cards about it, as Decisions and the tree count them.
    pub needs: usize,
    /// The oldest of those, which "Answer" opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest: Option<String>,
    pub working: usize,
    /// The newest change: when (ms) and one line (a task's title or a session's name).
    pub at: u64,
    pub line: String,
    /// Since the window was last there (`since`, ms): tasks merged and decisions that came.
    pub merged: usize,
    pub decisions: usize,
}

/// Ticket 993 rule 6: a schedule whose last run failed, for the digest: which schedule (its id, and `line`, the
/// sentence its card would say) and why. It stays until the schedule runs again, is edited or is removed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FailedRun {
    pub schedule: String,
    pub line: String,
    pub reason: String,
    /// When that run was (ms).
    pub at: u64,
    /// The session it started, when it got that far.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// A session counts as working for the digest as the tree reads it: its agent runs a turn and nothing waits for the
/// user (look 1117 v3 N2: a real Claude at a permission card still reported its turn as running).
pub(crate) fn working_now(live: bool, attention: &crate::queue::Attention, asks: usize) -> bool {
    live && attention.working && !attention.waiting && asks == 0
}

/// Every registered project's row, needs-you first, then working, then quiet, each newest first. The Home folder is
/// no project.
pub(crate) fn digest(
    tasks: &[Task],
    roots: Vec<PathBuf>,
    mut facts: std::collections::BTreeMap<PathBuf, crate::sessions::DigestFacts>,
    team: &crate::team::Team,
    since: u64,
) -> Vec<DigestRow> {
    let home = team.home();
    let mut rows: Vec<DigestRow> = roots
        .into_iter()
        // Look 11-17 v9 (Home S2-3): a project whose folder was removed while it has a lead stays, as needing the user.
        .filter(|p| *p != home && (p.is_dir() || team.lead_of(Some(p.as_path())).is_some()))
        .map(|project| {
            let f = facts.remove(&project).unwrap_or_default();
            let mine: Vec<&Task> = tasks.iter().filter(|t| t.place == project).collect();
            let open = mine.iter().filter(|t| t.closed.is_none()).count();
            let newest = mine.iter().max_by_key(|t| t.updated);
            let (at, line) = match newest {
                Some(t) if t.updated >= f.last.0 => (t.updated, t.title.clone()),
                _ => f.last.clone(),
            };
            let oldest = f.pending.iter().min_by_key(|p| p.1).map(|p| p.0.clone());
            let lead = team.lead_of(Some(&project)).map(|t| t.id);
            let lead_state = if !project.is_dir() {
                Some("missing".to_string())
            } else {
                lead.as_ref()
                    .filter(|l| f.seats_failed.contains(*l) && !f.seats_live.contains(*l))
                    .map(|_| "failed".to_string())
            };
            DigestRow {
                lead,
                lead_state,
                open,
                needs: f.pending.len(),
                oldest,
                working: f.working,
                at,
                line,
                merged: mine
                    .iter()
                    .filter(|t| {
                        t.closed
                            .as_ref()
                            .is_some_and(|c| c.how == "merged" && since > 0 && c.at >= since)
                    })
                    .count(),
                decisions: f
                    .pending
                    .iter()
                    .filter(|p| since > 0 && p.1 >= since)
                    .count(),
                project,
            }
        })
        .collect();
    let rank = |r: &DigestRow| {
        if r.needs > 0 || r.lead_state.is_some() {
            0
        } else if r.working > 0 {
            1
        } else {
            2
        }
    };
    rows.sort_by(|a, b| rank(a).cmp(&rank(b)).then(b.at.cmp(&a.at)));
    rows
}

/// Who asks (`Sessions::task_caller`).
pub(crate) struct Who {
    /// `None`: the owner with no project named, who reads every place.
    pub place: Option<PathBuf>,
    /// The lead of the place (the owner's request), or the lead this session is or works for.
    pub lead: Option<String>,
    /// The owner, or the lead's own seat: makes, staffs and closes tasks.
    pub decides: bool,
    pub session: Option<String>,
    pub name: String,
}

/// `Request::Task`, as its fields.
pub(crate) struct Ask {
    pub operation: String,
    pub id: Option<String>,
    pub text: String,
    pub accept: Vec<String>,
    pub project: Option<PathBuf>,
    pub path: Option<PathBuf>,
    pub session: Option<String>,
    pub cites: Option<String>,
    pub all: bool,
    pub level: Option<crate::team::Level>,
    pub who: Option<String>,
    pub due: Option<String>,
}

/// The three requests of slices g to i, for the socket and the window alike.
pub(crate) fn dispatch(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    caller: Option<&crate::grants::Caller>,
    request: crate::api::Request,
) -> crate::api::Response {
    use crate::api::Request;
    match request {
        Request::Task {
            operation,
            id,
            text,
            accept,
            project,
            path,
            session,
            cites,
            all,
            level,
            who,
            due,
        } => serve(
            registry,
            caller,
            Ask {
                operation,
                id,
                text,
                accept,
                project,
                path,
                session,
                cites,
                all,
                level,
                who,
                due,
            },
        ),
        Request::Note {
            operation,
            id,
            text,
            scope,
            task,
            lesson,
        } => crate::notes::serve(registry, caller, operation, id, text, scope, task, lesson),
        Request::Role {
            operation,
            role,
            name,
            why,
        } => crate::roles::serve(registry, caller, operation, role, name, why),
        _ => Err("not a ledger request".into()),
    }
}

/// One ledger request. Git is read with no lock held; the registry is locked only to ask who the caller is and what
/// each seat does now.
pub(crate) fn serve(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    caller: Option<&crate::grants::Caller>,
    ask: Ask,
) -> crate::api::Response {
    let lock = || {
        registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())
    };
    let now = crate::queue::now_ms();
    let (home, who) = {
        let sessions = lock()?;
        (
            sessions.home().to_path_buf(),
            sessions.task_caller(caller, ask.project.as_deref())?,
        )
    };
    let ledger = Ledger::open(&home);
    let decides = |what: &str| {
        if who.decides {
            Ok(())
        } else {
            Err(format!(
                "only the lead of a place or the user may {what} a task"
            ))
        }
    };
    // A session reaches the tasks of its own place only.
    let mine = |t: &Task| who.place.as_ref().is_none_or(|p| *p == t.place);
    // Home view change 5: the Home lead's own seat reads every place's tasks, and nothing more.
    let team = crate::team::Team::open(&home);
    let home_lead = who.decides
        && who.session.is_some()
        && who
            .lead
            .as_ref()
            .is_some_and(|l| team.lead_of(None).is_some_and(|t| t.id == *l));
    let named = |id: &Option<String>| -> Result<Task, String> {
        let id = id
            .as_deref()
            .ok_or("name the task: its id is in `nunchiro task list`")?;
        let all = ledger.list()?;
        if let Some(t) = all.iter().find(|t| t.id == id && mine(t)) {
            return Ok(t.clone());
        }
        // Look 1117 home S2-5: the Home lead sees every place's tasks, so "no task" read as a missing task. It is a
        // refusal, and says what to do instead.
        match all.iter().find(|t| t.id == id) {
            Some(t) if home_lead => Err(format!(
                "task {id} is in {}: the Home lead reads other projects' tasks; it cannot change them. Send a goal to that project's lead with nunchiro task goal --project {}",
                t.place
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                t.place.display()
            )),
            _ => Err(format!("no task {id} in this place")),
        }
    };
    // Look 1117 home S2-4: the Home lead names another project with --project to read that place's tasks (read only).
    let other = match (&ask.project, &who.place) {
        (Some(p), Some(own)) if home_lead => {
            let p = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
            (p != *own).then_some(p)
        }
        _ => None,
    };
    let changed: Vec<Task> = match ask.operation.as_str() {
        // Read only: no task is closed from here (`list` closes the merged ones of its own place).
        "list-all" => {
            if !home_lead {
                return Err("only the Home lead lists every place's tasks".into());
            }
            let mut tasks: Vec<Task> = ledger
                .list()?
                .into_iter()
                .filter(|t| ask.all || t.closed.is_none())
                .collect();
            tasks.sort_by(|a, b| a.place.cmp(&b.place));
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, tasks)?,
                place: None,
            });
        }
        // Home view change 1: the user's digest of every registered project. `text` is when the window was last
        // there (ms), for what changed since.
        // Look 1117 home S2-4: the Home lead reads it too (`nunchiro task digest`), to say which project needs the user.
        "digest" => {
            if who.session.is_some() && !home_lead {
                return Err("only the user and the Home lead read the Home digest".into());
            }
            let since = ask.text.trim().parse::<u64>().unwrap_or(0);
            let tasks = ledger.list()?;
            let sessions = lock()?;
            let (roots, facts) = sessions.digest_facts();
            // Ticket 993: both readers of the digest (the user, the Home lead) read every place's schedules.
            let failed_runs = sessions.failed_runs();
            let outbox = sessions.outbox_count(); // ticket 1002 lane 2
            let loop_cards = sessions.loop_card_count(); // ticket 1003
            drop(sessions);
            // Ticket 1003: the open loops' counts; a store that cannot be read counts as none here (`task loops` says why).
            let open = crate::loops::Loops::open(&home).list().unwrap_or_default();
            return Ok(crate::api::Reply::Digest {
                projects: digest(&tasks, roots, facts, &team, since),
                failed_runs,
                outbox,
                loops: crate::loops::counts(&open, &crate::loops::today(now)),
                loop_cards,
            });
        }
        // Ticket 1003: the open loops (`loops.rs`). The user and the Home lead read them. The user's own shell adds
        // and closes rows; the Home lead only asks, on a card, and nothing is stored or closed before the yes.
        "loops" | "promise" | "waiting" | "loop-close" => {
            let owner = who.session.is_none();
            if !owner && !home_lead {
                return Err("only the user and the Home lead reach the open loops".into());
            }
            let loops = crate::loops::Loops::open(&home);
            let text = |text: String| Ok(crate::api::Reply::Text { text });
            let session = who.session.clone().unwrap_or_default();
            return match ask.operation.as_str() {
                "loops" => {
                    let open = loops.list()?;
                    let today = crate::loops::today(now);
                    Ok(crate::api::Reply::Loops {
                        counts: crate::loops::counts(&open, &today),
                        loops: open,
                        today,
                    })
                }
                "loop-close" => {
                    let id = ask
                        .id
                        .as_deref()
                        .ok_or("name the open loop: its id is in `nunchiro task loops`")?;
                    let row = loops
                        .list()?
                        .into_iter()
                        .find(|r| r.id == id)
                        .ok_or_else(|| format!("no open loop {id}"))?;
                    let words = crate::loops::words(&row);
                    if owner {
                        loops.close(id, now)?;
                        lock()?.retire_loop_cards(id)?;
                        return text(format!("Closed open loop {id}: {words}."));
                    }
                    let why = Some(line(&ask.text, 300)).filter(|w| !w.is_empty());
                    lock()?.ask_loop(&session, "close", row, who.name.clone(), why)?;
                    text(format!(
                        "Asked the user to close open loop {id} ({words}). It stays open until their yes; the answer comes as a line in your room."
                    ))
                }
                kind => {
                    let source = if owner {
                        "the user"
                    } else {
                        "the user's words, heard by the Home lead"
                    };
                    let row = crate::loops::draft(
                        kind,
                        ask.who.as_deref().unwrap_or_default(),
                        &ask.text,
                        ask.due.as_deref(),
                        ask.cites.as_deref().unwrap_or(source),
                    )?;
                    let words = crate::loops::words(&row);
                    if owner {
                        let kept = loops.add(row, now)?;
                        lock()?.loops_changed();
                        return text(format!("Kept open loop {}: {words}.", kept.id));
                    }
                    if let Some(open) = loops
                        .list()?
                        .into_iter()
                        .find(|r| crate::loops::same(r, &row))
                    {
                        return text(format!(
                            "Open loop {} already holds this: {}.",
                            open.id,
                            crate::loops::words(&open)
                        ));
                    }
                    lock()?.ask_loop(&session, "add", row, who.name.clone(), None)?;
                    text(format!(
                        "Asked the user to keep this open loop: {words}. Nothing is kept before their yes; the answer comes as a line in your room."
                    ))
                }
            };
        }
        // Home view change 4: the Home lead asks to give a project's lead a goal. It becomes the user's card; nothing
        // reaches the project before the yes.
        "goal" => {
            if !home_lead {
                return Err("only the Home lead asks to give a project's lead a goal".into());
            }
            let project = ask
                .project
                .as_deref()
                .ok_or("name the project with --project")?;
            let project = std::fs::canonicalize(project).map_err(|e| e.to_string())?;
            let name = project
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let lead = team.lead_of(Some(&project)).ok_or_else(|| {
                format!(
                    "{name} has no leader: a goal goes to a project's leader, and only the user adds one (the tree or Settings > Team)"
                )
            })?;
            let text = line(&ask.text, 2000);
            if text.is_empty() {
                return Err("say the goal in a line".into());
            }
            let session = who.session.clone().unwrap_or_default();
            lock()?.ask_goal(&session, project, lead.id, who.name.clone(), text)?;
            return Ok(crate::api::Reply::Tasks {
                tasks: vec![],
                place: None,
            });
        }
        "list" if other.is_some() => {
            let tasks = ledger
                .list()?
                .into_iter()
                .filter(|t| Some(&t.place) == other.as_ref() && (ask.all || t.closed.is_none()))
                .collect();
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, tasks)?,
                place: None,
            });
        }
        "list" => {
            let mut tasks = ledger.list()?;
            // A task whose approved commit is in the project is closed here, not when its lead gets to say done
            // (real-app look 11-17: a merged task read "merge" for minutes while the lead worked on the next one).
            for t in tasks.iter_mut().filter(|t| mine(t)) {
                if in_project(t) {
                    *t = ledger.close(&t.id, "merged", now)?;
                    lock()?.retire_merge_card(&t.id)?;
                    crate::events::tasks(&t.place);
                }
            }
            let tasks = tasks
                .into_iter()
                .filter(|t| mine(t) && (ask.all || t.closed.is_none()))
                .collect();
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, tasks)?,
                place: who.place.as_deref().map(|p| ledger.place(p)),
            });
        }
        "show" => {
            // Reading is the Home lead's in every place.
            let task = match (home_lead, ask.id.as_deref()) {
                (true, Some(id)) => ledger.list()?.into_iter().find(|t| t.id == id),
                _ => None,
            };
            let task = match task {
                Some(t) => t,
                None => named(&ask.id)?,
            };
            return Ok(crate::api::Reply::Tasks {
                tasks: views(registry, &home, vec![task])?,
                place: who.place.as_deref().map(|p| ledger.place(p)),
            });
        }
        // Slice i: the user's choices for this place (`text`): `way` solo|team|strict, `grant` ask|edits. The
        // place's lead hears a new way in the room.
        op @ ("way" | "grant") => {
            if who.session.is_some() {
                return Err(
                    "only the user sets a place's way of working and what its seats may do".into(),
                );
            }
            let place = who
                .place
                .as_deref()
                .ok_or("name the project with --project")?;
            let now_is = if op == "way" {
                ledger.set_place(place, Some(ask.text.trim()), None)?
            } else {
                ledger.set_place(place, None, Some(ask.text.trim()))?
            };
            crate::events::tasks(place);
            if let Some(lead) = &who.lead {
                let body = if op == "way" {
                    format!(
                        "The user set the way of working here to {} (`nunchiro skill get orchestration --file levels.md`).",
                        now_is.way
                    )
                } else if now_is.seats == "edits" {
                    "The user lets seats here edit files in their worktree without asking; commands still ask.".to_string()
                } else {
                    "The user wants seats here to ask before each edit and command.".to_string()
                };
                lock()?.team_note(
                    place,
                    lead,
                    None,
                    body,
                    crate::room::TeamNote {
                        what: op.into(),
                        worktree: None,
                        name: None,
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                );
            }
            return Ok(crate::api::Reply::Tasks {
                tasks: vec![],
                place: Some(now_is),
            });
        }
        "new" => {
            decides("make")?;
            let place = who
                .place
                .as_deref()
                .ok_or("name the project with --project")?;
            let (task, _) = ledger.make(
                place,
                who.lead.as_deref(),
                &ask.text,
                &ask.accept,
                false,
                now,
            )?;
            vec![task]
        }
        "attach" => {
            decides("staff")?;
            let task = named(&ask.id)?;
            let path = ask.path.as_deref().ok_or("requires --path")?;
            let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
            // Only a worktree this core manages for the task's own project.
            if lock()?
                .recorded_worktree(&path)
                .is_none_or(|w| w.project != task.place || w.missing)
            {
                return Err("not a worktree of this task's project".into());
            }
            vec![ledger.attach(&task.id, &path, now)?]
        }
        "assign" => {
            decides("staff")?;
            let task = named(&ask.id)?;
            let session = ask.session.as_deref().ok_or("requires a session id")?;
            let (label, cwd) = lock()?.seat_place(session, &task.place)?;
            // A seat inside one of the task's worktrees is under the one-writer rule like a start there.
            let worktree = task.worktrees.iter().find(|w| **w == cwd).cloned();
            if let Some(w) = &worktree
                && crate::roles::of(&home, &label).1
            {
                let sessions = lock()?;
                ledger.writer_free(w, |s| s != session && sessions.seat_now(s).live)?;
            }
            let running: std::collections::BTreeSet<String> = {
                let sessions = lock()?;
                task.seats
                    .iter()
                    .filter(|s| sessions.seat_now(&s.session).live)
                    .map(|s| s.session.clone())
                    .collect()
            };
            let seated =
                ledger.seat_on(&task.id, session, &label, worktree.as_deref(), now, &|s| {
                    running.contains(s)
                })?;
            // Look v9 B N-S3-6: the level `staff` opened the seat at, so its rows show the bars and what it runs.
            if let Some(level) = ask.level {
                lock()?.role_seat_level(session, level)?;
            }
            vec![seated]
        }
        verdict @ ("pass" | "changes") => {
            // The task is named, or it is the one the calling seat sits on.
            let task = match (&ask.id, &who.session) {
                (None, Some(session)) => ledger
                    .of_seat(session)
                    .filter(|t| mine(t))
                    .ok_or("this session is no seat of a task of its place; name the task")?,
                _ => named(&ask.id)?,
            };
            // A review is a reviewer's: the user, or a seat of this task that does not write. Never the builder's own.
            let by = match &who.session {
                None => "user".to_string(),
                Some(session) => {
                    let seat = task.seats.iter().find(|s| s.session == *session);
                    if seat.is_none_or(|s| s.writes) {
                        return Err(format!(
                            "only a reviewer seat of task {} reviews it (a session started in its worktree with a \
                             name that starts with `review`)",
                            task.id
                        ));
                    }
                    session.clone()
                }
            };
            // Read now, with no lock: the review speaks for exactly these files.
            let revision = revision_of(&task).ok_or(
                "the task's files cannot be read as one revision now: no review can bind to them",
            )?;
            vec![ledger.review(
                &task.id,
                Review {
                    revision,
                    pass: verdict == "pass",
                    note: ask.text.clone(),
                    by,
                    name: who.name.clone(),
                    at: now,
                },
            )?]
        }
        "learn" => {
            // A lesson is proposed by who learned it: a seat of the task (the task named or its own), or its lead.
            let task = match (&ask.id, &who.session) {
                (None, Some(session)) => ledger
                    .of_seat(session)
                    .filter(|t| mine(t))
                    .ok_or("this session is no seat of a task of its place; name the task")?,
                _ => named(&ask.id)?,
            };
            let seat = who
                .session
                .as_ref()
                .and_then(|s| task.seats.iter().find(|x| x.session == *s));
            let (name, role) = match seat {
                // A seat started by `task staff` is already named by its role ("Builder · tax").
                Some(seat)
                    if seat
                        .name
                        .to_lowercase()
                        .starts_with(&format!("{} ·", seat.role)) =>
                {
                    (seat.name.clone(), seat.role.clone())
                }
                Some(seat) => (
                    format!("{} · {}", cap(&seat.role), seat.name),
                    seat.role.clone(),
                ),
                None if who.decides && who.session.is_some() => {
                    (format!("Lead · {}", who.name), "lead".to_string())
                }
                None if who.decides => ("the user".to_string(), "lead".to_string()),
                None => return Err("only a seat of the task or its lead proposes a lesson".into()),
            };
            vec![ledger.learn(
                &task.id,
                Lesson {
                    text: ask.text.clone(),
                    name,
                    role,
                    cites: ask.cites.clone(),
                    at: now,
                },
            )?]
        }
        "merge" => {
            decides("ask to merge")?;
            let task = named(&ask.id)?;
            if task.worktrees.is_empty() {
                return Err("this task uses no worktree: there is nothing to merge (close it with `task done`)".into());
            }
            // Never a card for files no review saw: the state is read now, from the files as they are.
            let view = views(registry, &home, vec![task])?.remove(0);
            if !matches!(view.state.as_str(), "approved" | "merge") {
                let why = if view.stale {
                    ", the files changed after the review"
                } else {
                    ""
                };
                return Err(format!(
                    "task {} is not approved for the files as they are now (state: {}{why}): have it reviewed \
                     first (`nunchiro task pass` by its reviewer seat)",
                    view.task.id, view.state
                ));
            }
            if view.state == "merge" {
                return Err(format!(
                    "the user already said yes to merging task {} at these files: merge it now",
                    view.task.id
                ));
            }
            let revision = view
                .task
                .review
                .as_ref()
                .map(|r| r.revision.clone())
                .unwrap_or_default();
            // The yes names commits: a reviewed worktree with uncommitted files has nothing exact to merge.
            if revision.contains('+') {
                return Err(format!(
                    "task {} was reviewed with uncommitted files: commit them, have that commit reviewed, then ask \
                     again (the user's yes names the exact commit to merge)",
                    view.task.id
                ));
            }
            let session = who.session.clone().unwrap_or_default();
            lock()?.ask_merge(&session, &view.task, &revision)?;
            return Ok(crate::api::Reply::Tasks {
                tasks: vec![view],
                place: None,
            });
        }
        // Slice i: what to start for a seat of `text` (a role's name) on this task. The caller then sends the start
        // itself, so every start check holds; the seat is recorded there by its name.
        "staff" => {
            decides("staff")?;
            let task = named(&ask.id)?;
            if task.closed.is_some() {
                return Err(format!("task {} is closed", task.id));
            }
            let role = crate::roles::Roles::open(&home)
                .get(&ask.text)
                .ok_or_else(|| {
                    let have = crate::roles::Roles::open(&home)
                        .list()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|r| r.name)
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(
                        "no role named {}; the roles are: {have} (propose a new one with `nunchiro role propose`)",
                        ask.text.trim()
                    )
                })?;
            let folder = match (&ask.path, task.worktrees.as_slice()) {
                (Some(path), all) => {
                    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
                    if !all.contains(&path) {
                        return Err("that folder is no worktree of this task".into());
                    }
                    Some(path)
                }
                (None, [one]) => Some(one.clone()),
                (None, []) => None,
                (None, _) => {
                    return Err("this task uses several worktrees: name one with --path".into());
                }
            };
            // Ticket 993 rule 9: a role's seat opens at a level as a teammate's does (`team::open_seat`): standard
            // when none is asked, the level table gives model and effort. A role with its own model keeps it (it
            // was the agent's own default before, the strongest and dearest model).
            let level = role
                .model
                .is_none()
                .then(|| ask.level.unwrap_or(crate::team::Level::Standard));
            let (model, effort) = match (&role.model, level) {
                (Some(model), _) => (Some(model.clone()), role.effort.clone()),
                (None, level) => {
                    let table = lock()?.feature::<serde_json::Value>(crate::team::LEVELS_KEY);
                    let level = level.unwrap_or(crate::team::Level::Standard);
                    let agent = crate::team::agent_key(role.kind, None);
                    let pick = crate::team::level_pick(table.as_ref(), &agent, level);
                    (pick.model, pick.effort.or(role.effort.clone()))
                }
            };
            return Ok(crate::api::Reply::Staff {
                task: task.id.clone(),
                folder,
                session: crate::api::StartSession {
                    kind: role.kind,
                    project: task.place.clone(),
                    worktree: false,
                    label: crate::roles::seat_name(&role.name, &task.title),
                    // A role that does not write starts without the edit tools.
                    // shortcut: Claude only, and its shell can still write; upgrade to a read-only sandbox profile
                    // when non-writing seats must be held to it.
                    args: match (role.kind, role.writes) {
                        (crate::api::AgentKind::Claude, false) => vec![
                            "--disallowedTools".into(),
                            "Edit,Write,MultiEdit,NotebookEdit".into(),
                        ],
                        // The project's grant, not the role's: where the user said so, a seat that writes edits
                        // files without asking (commands still ask). Never more than that from here.
                        (crate::api::AgentKind::Claude, true)
                            if ledger.place(&task.place).seats == "edits" =>
                        {
                            vec!["--permission-mode".into(), "acceptEdits".into()]
                        }
                        _ => vec![],
                    },
                    model,
                    effort,
                    resume: None,
                    account: None,
                },
                level,
            });
        }
        how @ ("done" | "drop") => {
            decides("close")?;
            let task = named(&ask.id)?;
            let closed = ledger.close(
                &task.id,
                if how == "done" { "done" } else { "dropped" },
                now,
            )?;
            lock()?.retire_merge_card(&closed.id)?;
            vec![closed]
        }
        _ => return Err("unknown task operation".into()),
    };
    for task in &changed {
        crate::events::tasks(&task.place);
    }
    Ok(crate::api::Reply::Tasks {
        tasks: views(registry, &home, changed)?,
        place: None,
    })
}

fn cap(word: &str) -> String {
    let mut c = word.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// Each task with its state word now.
pub(crate) fn views(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    home: &Path,
    tasks: Vec<Task>,
) -> Result<Vec<View>, String> {
    // Git and the rooms' logs first, with no lock held; a closed task's files are not read. A revision that cannot
    // be read equals no stored one, so its review reads as not holding.
    let revisions: Vec<String> = tasks
        .iter()
        .map(|t| match (&t.closed, &t.review) {
            (None, Some(_)) => revision_of(t).unwrap_or_else(|| "unreadable".into()),
            _ => String::new(),
        })
        .collect();
    let mut rooms: std::collections::BTreeMap<PathBuf, Vec<crate::room::Message>> =
        Default::default();
    for t in tasks
        .iter()
        .filter(|t| t.closed.is_none() && !t.seats.is_empty())
    {
        if !rooms.contains_key(&t.place) {
            let all = crate::room::Log::open(home, &t.place)
                .find(|_| true)
                .unwrap_or_default();
            rooms.insert(t.place.clone(), all);
        }
    }
    // Under the lock: only what each seat does now, and names.
    let (now, names) = {
        let sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())?;
        let now: std::collections::BTreeMap<String, SeatNow> = tasks
            .iter()
            .flat_map(|t| &t.seats)
            .map(|s| (s.session.clone(), sessions.seat_now(&s.session)))
            .collect();
        let names: std::collections::BTreeMap<String, String> = rooms
            .values()
            .flatten()
            .flat_map(|m| [m.from.clone(), m.to.clone()])
            .filter_map(|id| sessions.label_of(&id).map(|l| (id, l)))
            .collect();
        (now, names)
    };
    let name = |id: &str| match names.get(id) {
        Some(label) if !label.is_empty() => label.clone(),
        _ if id == crate::room::PERSON => "the user".to_string(),
        _ => id.chars().take(6).collect(),
    };
    Ok(tasks
        .into_iter()
        .zip(revisions)
        .map(|(task, revision)| {
            let asks = rooms
                .get(&task.place)
                .map(|all| {
                    all.iter()
                        .filter(|m| {
                            m.kind == crate::room::Kind::Ask
                                && task.seats.iter().any(|s| s.session == m.from)
                                && crate::sessions::open_ask(all, m)
                        })
                        .map(|m| {
                            let words = m.body.split_whitespace().collect::<Vec<_>>().join(" ");
                            let cut: String = words.chars().take(200).collect();
                            (
                                m.from.clone(),
                                format!("{} → {}: {cut}", name(&m.from), name(&m.to)),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            view(
                task,
                &|s| now.get(s).cloned().unwrap_or_default(),
                asks,
                &revision,
            )
        })
        .collect())
}

/// A task in a few plain lines, for a lead's brief and the CLI.
pub fn lines(v: &View) -> String {
    let t = &v.task;
    let mut out = format!("{} [{}", t.id, v.state);
    if v.stale {
        out += ", changed after the review";
    }
    out += &format!("] {}\n", t.title);
    for a in &t.accept {
        out += &format!("  accept: {a}\n");
    }
    for w in &t.worktrees {
        out += &format!("  worktree: {}\n", w.display());
    }
    for s in &t.seats {
        let live = if v.live.contains(&s.session) {
            "running"
        } else {
            "ended"
        };
        out += &format!("  seat: {} · {} ({}, {live})\n", s.role, s.name, s.session);
    }
    for n in &t.told {
        out += &format!("  the user told {}: \"{}\"\n", n.name, n.text);
    }
    for a in &v.asks {
        out += &format!("  open question: {a}\n");
    }
    if let Some(r) = &t.review {
        let verdict = if r.pass { "pass" } else { "changes asked" };
        let note = if r.note.is_empty() {
            String::new()
        } else {
            format!(": {}", r.note)
        };
        out += &format!("  review by {}: {verdict}{note}\n", r.name);
    }
    for l in &t.learned {
        out += &format!("  lesson proposed by {}: {}\n", l.name, l.text);
    }
    if v.state == "merge" {
        out += "  the user said yes to merging these files\n";
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Look 11-17 v5 item 4: a project whose lead's seat failed says so in the digest ("failed"), until a session of
    /// that seat runs again.
    #[test]
    fn v5_4_the_digest_says_a_failed_lead() {
        let home = std::env::temp_dir().join(format!(
            "nunchiro-digest-{}",
            crate::store::new_id().unwrap()
        ));
        let project = home.join("harbor");
        std::fs::create_dir_all(&project).unwrap();
        let project = std::fs::canonicalize(project).unwrap();
        let team = crate::team::Team::open(&home);
        let all = team
            .save(
                None,
                crate::team::Teammate {
                    id: String::new(),
                    name: "Lead".into(),
                    job: "Leads.".into(),
                    kind: crate::api::AgentKind::Claude,
                    model: None,
                    effort: None,
                    project: Some(project.clone()),
                    lead: true,
                    level: None,
                    level_max: None,
                    next_level: None,
                    agent: None,
                },
            )
            .unwrap();
        let lead = all[0].id.clone();
        let row = |failed: bool, live: bool| {
            let mut f = crate::sessions::DigestFacts::default();
            if failed {
                f.seats_failed.insert(lead.clone());
            }
            if live {
                f.seats_live.insert(lead.clone());
            }
            digest(
                &[],
                vec![project.clone()],
                [(project.clone(), f)].into(),
                &team,
                0,
            )
            .remove(0)
            .lead_state
        };
        assert_eq!(row(false, false), None);
        assert_eq!(row(true, false).as_deref(), Some("failed"));
        assert_eq!(row(true, true), None, "a running seat session wins");
        // Look 11-17 v9 (Home S2-3): its folder removed, the project with a lead stays, as needing the user.
        std::fs::remove_dir_all(&project).unwrap();
        assert_eq!(row(false, false).as_deref(), Some("missing"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_session_that_waits_for_the_user_is_not_working() {
        // N2 (look 1117 v3)
        let working = crate::queue::Attention {
            working: true,
            ..Default::default()
        };
        assert!(working_now(true, &working, 0));
        assert!(!working_now(true, &working, 1), "a pending ask");
        let waiting = crate::queue::Attention {
            waiting: true,
            ..working.clone()
        };
        assert!(!working_now(true, &waiting, 0), "the agent waits");
        assert!(!working_now(false, &working, 0), "not running");
    }

    fn home(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }
    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            ok.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&ok.stderr)
        );
    }

    #[test]
    fn a_task_asked_twice_is_one_task_and_survives_a_reopen() {
        let home = home("twice");
        let place = home.join("p");
        let (a, made) = Ledger::open(&home)
            .make(
                &place,
                Some("lead"),
                "  Add   tax() ",
                &["tests pass".into()],
                false,
                1,
            )
            .unwrap();
        assert!(made);
        assert_eq!((a.id.as_str(), a.title.as_str()), ("t1", "Add tax()"));
        // A new conversation asks again, in other letter case: the same task, nothing new.
        let (b, made) = Ledger::open(&home)
            .make(&place, Some("lead"), "add tax()", &[], false, 2)
            .unwrap();
        assert!(!made);
        assert_eq!(b, a);
        // Another place has its own.
        let (c, made) = Ledger::open(&home)
            .make(&home.join("q"), None, "add tax()", &[], false, 3)
            .unwrap();
        assert!(made && c.id == "t2");
        // Closed: the title is free again.
        Ledger::open(&home).close("t1", "done", 4).unwrap();
        let (d, made) = Ledger::open(&home)
            .make(&place, Some("lead"), "Add tax()", &[], false, 5)
            .unwrap();
        assert!(made && d.id == "t3");
        assert_eq!(Ledger::open(&home).list().unwrap().len(), 3);
    }

    #[test]
    fn one_writer_per_worktree_and_the_seat_follows_a_resume() {
        let home = home("writer");
        let (place, wt) = (home.join("p"), home.join("wt"));
        let l = Ledger::open(&home);
        let t = l.worktree_made(&place, "lead", &wt, "tax", 1).unwrap();
        assert!(t.auto && t.worktrees == [wt.clone()]);
        // A folder no task uses takes any start and records nothing.
        assert!(l.writer_free(&home.join("other"), |_| true).is_ok());
        assert!(
            l.seat(&home.join("other"), "s0", "x", 1, &|_| true)
                .unwrap()
                .is_none()
        );

        l.writer_free(&wt, |_| true).unwrap();
        l.seat(&wt, "s1", "lane-tax", 2, &|_| true)
            .unwrap()
            .unwrap();
        // A second builder while the first lives: refused with the words that name the first.
        let no = l.writer_free(&wt, |s| s == "s1").unwrap_err();
        assert!(no.contains("lane-tax") && no.contains("t1"), "{no}");
        // A reviewer is a seat that does not write: it is never the second writer.
        let t = l
            .seat(&wt, "s2", "review-tax", 3, &|_| true)
            .unwrap()
            .unwrap();
        assert_eq!(
            t.seats
                .iter()
                .map(|s| (s.role.as_str(), s.writes))
                .collect::<Vec<_>>(),
            [("builder", true), ("reviewer", false)]
        );
        // The same start reported twice is one seat.
        let t = l
            .seat(&wt, "s2", "review-tax", 3, &|_| true)
            .unwrap()
            .unwrap();
        assert_eq!(t.seats.len(), 2);
        // The builder's run is resumed under a new id: still the one writer, now under that id.
        l.reseat(&["s1".into()], "s9").unwrap();
        assert!(l.writer_free(&wt, |s| s == "s9").is_err());
        // After one Codex look: a full task forgets its oldest ended seat, never a running one.
        for n in 0..SEATS_KEPT {
            l.seat(&wt, &format!("r{n}"), "review-x", 5, &|s| s == "s9")
                .unwrap();
        }
        let t = l.of_worktree(&wt).unwrap();
        assert_eq!(t.seats.len(), SEATS_KEPT);
        assert!(
            t.seats.iter().any(|s| s.session == "s9"),
            "the running writer stays"
        );
        assert!(l.writer_free(&wt, |s| s == "s9").is_err());
        assert!(
            l.seat(&wt, "one-more", "review-x", 6, &|_| true).is_err(),
            "all running: no seat is dropped for a new one"
        );
        // The builder ended: the next builder is a new seat.
        l.writer_free(&wt, |_| false).unwrap();
        let t = l
            .seat(&wt, "s3", "lane-tax-2", 4, &|_| false)
            .unwrap()
            .unwrap();
        assert!(t.seats.iter().any(|s| s.session == "s3"));
    }

    #[test]
    fn what_the_user_told_a_seat_is_kept_once() {
        let home = home("told");
        let (place, wt) = (home.join("p"), home.join("wt"));
        let l = Ledger::open(&home);
        l.worktree_made(&place, "lead", &wt, "tax", 1).unwrap();
        l.seat(&wt, "s1", "lane-tax", 2, &|_| true).unwrap();
        assert!(
            l.told(
                "s1",
                &wt,
                "lane-tax",
                "Use  integer cents,\nnot floats.",
                10
            )
            .unwrap()
        );
        // The same send reported by a second path, then really said again later.
        assert!(
            l.told("s1", &wt, "lane-tax", "Use integer cents, not floats.", 900)
                .unwrap()
        );
        assert!(
            l.told(
                "s1",
                &wt,
                "lane-tax",
                "Use integer cents, not floats.",
                60_000
            )
            .unwrap()
        );
        // A session that is no seat, in a folder no task uses: nothing to record.
        assert!(!l.told("zz", &home.join("other"), "x", "hello", 11).unwrap());
        // The user's own tab in the task's worktree counts for the task.
        assert!(
            l.told("mine", &wt, "my tab", "Also rename it.", 12)
                .unwrap()
        );
        let t = Ledger::open(&home).of_worktree(&wt).unwrap();
        assert_eq!(
            t.told
                .iter()
                .map(|n| (n.at, n.text.as_str()))
                .collect::<Vec<_>>(),
            [
                (10, "Use integer cents, not floats."),
                (60_000, "Use integer cents, not floats."),
                (12, "Also rename it."),
            ]
        );
    }

    #[test]
    fn a_review_holds_for_one_revision_only() {
        let home = home("review");
        let wt = home.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        git(&wt, &["init", "-q"]);
        std::fs::write(wt.join("a.txt"), "one\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-qm", "one"]);
        let l = Ledger::open(&home);
        let t = l
            .worktree_made(&home.join("p"), "lead", &wt, "tax", 1)
            .unwrap();
        l.seat(&wt, "s1", "lane-tax", 1, &|_| true).unwrap();
        l.seat(&wt, "s2", "review-tax", 1, &|_| true).unwrap();
        let idle = |_: &str| SeatNow {
            live: true,
            state: "waiting",
        };
        let at = revision_of(&t).unwrap();
        assert_eq!(at.len(), 40, "a clean folder is its commit: {at}");
        assert_eq!(view(t.clone(), &idle, vec![], &at).state, "idle");
        let t = l
            .review(
                &t.id,
                Review {
                    revision: at.clone(),
                    pass: true,
                    note: "ok".into(),
                    by: "s2".into(),
                    name: "review-tax".into(),
                    at: 5,
                },
            )
            .unwrap();
        let v = view(t.clone(), &idle, vec![], &revision_of(&t).unwrap());
        assert_eq!((v.state.as_str(), v.stale), ("approved", false));
        // An uncommitted edit after the approval: not approved any more.
        std::fs::write(wt.join("a.txt"), "two\n").unwrap();
        let dirty = revision_of(&t).unwrap();
        let v = view(t.clone(), &idle, vec![], &dirty);
        assert_eq!((v.state.as_str(), v.stale), ("review", true));
        // A second edit of the same file is a third revision, and so is a new untracked file.
        std::fs::write(wt.join("a.txt"), "three\n").unwrap();
        let dirty2 = revision_of(&t).unwrap();
        assert_ne!(dirty, dirty2);
        // An untracked file is in no merge: it changes nothing until it is added.
        std::fs::write(wt.join("new.txt"), "n\n").unwrap();
        assert_eq!(dirty2, revision_of(&t).unwrap());
        git(&wt, &["add", "new.txt"]);
        assert_ne!(dirty2, revision_of(&t).unwrap());
        // After one Codex look: an edit far past the first 64 KiB of a long file, and a changed binary file, are each a
        // new revision (the digest is of every changed file's whole content).
        let long = "line\n".repeat(40_000);
        std::fs::write(wt.join("long.txt"), format!("{long}end one\n")).unwrap();
        git(&wt, &["add", "long.txt"]);
        let far = revision_of(&t).unwrap();
        std::fs::write(wt.join("long.txt"), format!("{long}end two\n")).unwrap();
        assert_ne!(far, revision_of(&t).unwrap());
        std::fs::write(wt.join("blob.bin"), [0u8, 1, 2, 0, 255]).unwrap();
        git(&wt, &["add", "blob.bin"]);
        let bin = revision_of(&t).unwrap();
        std::fs::write(wt.join("blob.bin"), [0u8, 1, 3, 0, 255]).unwrap();
        assert_ne!(bin, revision_of(&t).unwrap());
        // Committed: still not what was reviewed.
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-qm", "two"]);
        assert!(view(t.clone(), &idle, vec![], &revision_of(&t).unwrap()).stale);
        // Back at the reviewed commit, the approval speaks again.
        git(&wt, &["reset", "-q", "--hard", "HEAD~1"]);
        assert_eq!(
            view(t.clone(), &idle, vec![], &revision_of(&t).unwrap()).state,
            "approved"
        );
        // A seat that waits for the user outranks every other word; a running reviewer reads "review".
        let asks = |s: &str| SeatNow {
            live: true,
            state: if s == "s1" { "permission" } else { "working" },
        };
        assert_eq!(view(t.clone(), &asks, vec![], &at).state, "needs");
        let reviewing = |s: &str| SeatNow {
            live: true,
            state: if s == "s2" { "working" } else { "waiting" },
        };
        assert_eq!(view(t.clone(), &reviewing, vec![], &at).state, "review");
        // An open ask of a seat (a Builder's question sent to its lead) reads "asked" while no other seat works; a
        // working one still reads its work.
        let ask = |from: &str| vec![(from.to_string(), "Builder → Lead: one or two?".to_string())];
        assert_eq!(view(t.clone(), &idle, ask("s9"), &at).state, "asked");
        assert_eq!(view(t.clone(), &reviewing, ask("s9"), &at).state, "review");
        // N14-S3-3: an asking seat whose agent ended (quit in its shell, no `lost` event) waits no more.
        assert_ne!(
            view(t.clone(), &|_: &str| SeatNow::default(), ask("s1"), &at).state,
            "asked"
        );
        // Look v10 Home S2-3: the asking seat itself runs a command while it waits (`ask --wait`): still "asked".
        let waits_in_turn = |s: &str| SeatNow {
            live: true,
            state: if s == "s1" { "working" } else { "waiting" },
        };
        let asked = view(t.clone(), &waits_in_turn, ask("s1"), &at);
        assert_eq!(
            (asked.state.as_str(), asked.asking),
            ("asked", vec!["s1".to_string()])
        );
        // A worktree that cannot be read has no revision: nothing binds to it and no review holds for it.
        let lost = Task {
            worktrees: vec![home.join("nowhere")],
            ..t.clone()
        };
        assert_eq!(revision_of(&lost), None);
        // A second worktree joins: the review never saw it, so it is gone.
        let t = l.attach(&t.id, &home.join("wt2"), 9).unwrap();
        assert!(t.review.is_none() && t.worktrees.len() == 2);
    }

    #[test]
    fn worktrees_come_and_go() {
        let home = home("gone");
        let place = home.join("p");
        let l = Ledger::open(&home);
        // A named task takes the worktree of the same name; the worktree's own unnamed task never appears.
        let (named, _) = l
            .make(&place, Some("lead"), "tax", &["cents".into()], false, 1)
            .unwrap();
        let t = l
            .worktree_made(&place, "lead", &home.join("w1"), "Tax", 2)
            .unwrap();
        assert_eq!((t.id.as_str(), t.auto), (named.id.as_str(), false));
        // An unnamed one, then moved to the named task with its seat and what was told there.
        let u = l
            .worktree_made(&place, "lead", &home.join("w2"), "tax-ui", 3)
            .unwrap();
        assert!(u.auto && u.id != named.id);
        l.seat(&home.join("w2"), "s5", "lane-ui", 3, &|_| true)
            .unwrap();
        l.told("s5", &home.join("w2"), "lane-ui", "Dark mode too.", 4)
            .unwrap();
        let t = l.attach(&named.id, &home.join("w2"), 5).unwrap();
        assert_eq!(t.worktrees.len(), 2);
        assert_eq!((t.seats.len(), t.told.len()), (1, 1));
        assert!(
            l.list().unwrap().iter().all(|x| x.id != u.id),
            "the emptied unnamed task is deleted"
        );
        // One worktree merges and goes: the task stays open for the other. The last one, unmerged: a named task stays
        // open with no worktree. Merged: closed.
        l.worktree_gone(&home.join("w1"), Some(true), 6).unwrap();
        assert!(l.of_worktree(&home.join("w2")).is_some());
        l.worktree_gone(&home.join("w2"), Some(false), 7).unwrap();
        let t = l
            .list()
            .unwrap()
            .into_iter()
            .find(|x| x.id == named.id)
            .unwrap();
        assert!(t.closed.is_none() && t.worktrees.is_empty());
        // An unnamed task closes with its worktree either way; taken back by the user, it is deleted.
        let a = l
            .worktree_made(&place, "lead", &home.join("w3"), "docs", 8)
            .unwrap();
        l.worktree_gone(&home.join("w3"), Some(false), 9).unwrap();
        let a = l
            .list()
            .unwrap()
            .into_iter()
            .find(|x| x.id == a.id)
            .unwrap();
        assert_eq!(a.closed.unwrap().how, "removed");
        // N14-S3-2: closed as merged (by `task list`) before its folder went: the folder still leaves the task.
        let m = l
            .worktree_made(&place, "lead", &home.join("w6"), "merged-first", 10)
            .unwrap();
        l.close(&m.id, "merged", 10).unwrap();
        l.worktree_gone(&home.join("w6"), Some(true), 10).unwrap();
        let m = l
            .list()
            .unwrap()
            .into_iter()
            .find(|x| x.id == m.id)
            .unwrap();
        assert!(m.worktrees.is_empty() && m.closed.unwrap().how == "merged");
        let b = l
            .worktree_made(&place, "lead", &home.join("w4"), "spike", 10)
            .unwrap();
        l.worktree_taken(&home.join("w4"), 11).unwrap();
        assert!(l.list().unwrap().iter().all(|x| x.id != b.id));
        // An unnamed task dropped before anyone sat on it leaves no row; a named one stays as "dropped".
        let c = l
            .worktree_made(&place, "lead", &home.join("w5"), "lane-api", 12)
            .unwrap();
        assert_eq!(
            l.close(&c.id, "dropped", 13).unwrap().closed.unwrap().how,
            "dropped"
        );
        assert!(l.list().unwrap().iter().all(|x| x.id != c.id));
        let (d, _) = l
            .make(&place, Some("lead"), "a named task", &[], false, 14)
            .unwrap();
        l.close(&d.id, "dropped", 15).unwrap();
        assert!(l.list().unwrap().iter().any(|x| x.id == d.id));
    }

    #[test]
    fn a_task_is_in_the_project_once_its_approved_commit_is() {
        let home = home("inproject");
        let place = home.join("p");
        std::fs::create_dir_all(&place).unwrap();
        git(&place, &["init", "-q", "-b", "main"]);
        std::fs::write(place.join("a.txt"), "one\n").unwrap();
        git(&place, &["add", "."]);
        git(&place, &["commit", "-qm", "one"]);
        let wt = home.join("wt");
        git(
            &place,
            &["worktree", "add", "-q", "-b", "lane", wt.to_str().unwrap()],
        );
        std::fs::write(wt.join("b.txt"), "two\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-qm", "two"]);
        let l = Ledger::open(&home);
        let t = l.worktree_made(&place, "lead", &wt, "tax", 1).unwrap();
        let at = revision_of(&t).unwrap();
        let review = |revision: &str| Review {
            pass: true,
            revision: revision.into(),
            by: "s2".into(),
            name: "review-tax".into(),
            note: String::new(),
            at: 2,
        };
        let t = l.review(&t.id, review(&at)).unwrap();
        assert!(!in_project(&t), "no yes from the user yet");
        let t = l.merge_ok(&t.id, &at, 3).unwrap();
        assert!(!in_project(&t), "approved, not merged yet");
        git(&place, &["merge", "-q", "lane"]);
        assert!(
            in_project(&t),
            "the approved commit is in the project's checkout"
        );
        // An edit after the yes: the files are no longer the approved ones.
        std::fs::write(wt.join("b.txt"), "three\n").unwrap();
        assert!(!in_project(&t));
    }
}
