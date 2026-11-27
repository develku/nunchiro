//! Ticket 990 slice g: the job ledger (concept approved by the owner on 2026-11-16 night,
//! docs/design/leader-room/concept-report-1116.html). A task is an outcome with acceptance conditions that uses zero
//! or more worktrees. A lead (an agent) only decides; this record is the core's, so a lead's new conversation and a
//! core restart read the same tasks, seats, direct corrections and review.
//!
//! One file, `<home>/ledger.json`, for every place (a project root, or the Home folder). What can be read from
//! somewhere else is not stored here: whether a seat lives (the registry), an open question (the room's log), and
//! whether a review still holds (the worktree's revision now, compared at each read).
use crate::store;
pub mod package;
use package::Packages;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
// Ticket 1162: the request side and the staffing moved out; each child says its own in one `//!` line.
mod ops;
mod staff;
pub(crate) use ops::*;
use staff::known_account;
pub use staff::seat_up;
pub(crate) use staff::staff_plan;

const FILE_MAX: u64 = 4 << 20;
const OPEN_MAX: usize = 200;
/// Closed tasks kept, newest first out.
const CLOSED_KEPT: usize = 200;
const TITLE_MAX: usize = 200;
const ACCEPT_MAX: usize = 8;
const LINE_MAX: usize = 300;
/// Ticket 1054: a reviewer's note says what to change; it keeps its lines.
const NOTE_MAX: usize = 4000;
/// What the user told a task's seats directly: the newest are kept.
const TOLD_KEPT: usize = 50;
const SEATS_KEPT: usize = 40;
/// The merge card shows at most two lessons: a third pushes the oldest out.
pub const LEARNED_KEPT: usize = 2;
/// The same words to the same seat inside this window are one correction (the prompt paths can each report a send).
const TOLD_TWICE_MS: u64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
    /// Ticket 1081: what the core's auto-advance (advance.rs) did for its seats; empty until it first acts.
    #[serde(default, skip_serializing_if = "Advance::is_empty")]
    pub advance: Advance,
    /// The tasks of the same place it waits for, at most `AFTER_MAX`. Whether it still waits is worked out at each read
    /// (`blockers`): one closed as merged or done holds it no more. A build without the field reads the file and drops
    /// it on its next write.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
    /// Who last changed `after`, so a lead's handover reads who ordered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered: Option<Ordered>,
    /// The tasks of `after` whose landing or drop its lead was told (advance.rs `release`), so a restart tells it once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub released: Vec<String>,
    pub created: u64,
    pub updated: u64,
}

/// Ticket 1004: a task's check-ins. A check-in is a seat's turn that ended and was told to its lead (sessions/wake.rs).
/// Progress is what the core records itself: the task's record (`updated`: a seat, a review, a worktree, the user's
/// words) and its worktrees' files (`revision`). Never what an agent wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
/// Ticket 1081: the core's auto-advance record of a task. Kept so a restart repeats no nudge and no card.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct Advance {
    /// What was done once, as `nudge:<session>:<n>` and `card:<session>:<n>` (`n`: the stall's start), newest last.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub done: Vec<String>,
    /// The seats seen stalled and not moved since.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stalled: Vec<Stalled>,
    /// Part B: the review rounds whose findings the core forwarded to the Builder.
    #[serde(skip_serializing_if = "is_zero")]
    pub round: u32,
    /// Part B: `waits` (its Reviewer waits for a free seat) or `started` (the core started it), for the task's row.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub review: String,
}
fn is_zero(n: &u32) -> bool {
    *n == 0
}
impl Advance {
    pub fn is_empty(&self) -> bool {
        self.done.is_empty() && self.stalled.is_empty() && self.round == 0 && self.review.is_empty()
    }
}
/// One stalled seat: `why` is a plain line ("quiet for 20 min"), `at` the nudge's time, `n` the stall's start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Stalled {
    pub session: String,
    pub name: String,
    pub why: String,
    pub n: u64,
    pub at: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub card: bool,
}

/// A task stalls at this many quiet check-ins in a row, or at this many in a row with the same error.
pub const STALL_QUIET: u32 = 2;
pub const STALL_SAME: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Ordered {
    /// `the user`, or the lead's seat name.
    pub by: String,
    pub at: u64,
}

/// A task this one waits for, as a reader gets it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Blocker {
    pub id: String,
    pub title: String,
    /// `plan`, `build`, `review`, `gate` (`stage`), or how it closed when that was not a landing (`dropped`).
    pub stage: String,
    /// It closed without landing (dropped, or its worktree removed): the waiting task asks instead of waiting.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dropped: bool,
}

/// The refusal of a seat that writes on a task that waits.
pub(crate) fn not_started(t: &Task, b: &[Blocker]) -> String {
    let (what, have) = match b {
        [one] => (format!("\"{}\"", one.title), "has"),
        many => (
            format!(
                "{} tasks ({})",
                many.len(),
                quoted(many.iter().map(|b| b.title.as_str()))
            ),
            "have",
        ),
    };
    format!(
        "Not started: \"{}\" waits for {what}, which {have} not landed. You are told when it lands. A seat that does \
         not write files may start now. To stop waiting: nunchiro task after {} --none",
        t.title, t.id
    )
}

/// `"a"`, `"a" and "b"`, `"a", "b" and "c"`.
pub(crate) fn quoted<'a>(titles: impl Iterator<Item = &'a str>) -> String {
    let all: Vec<String> = titles.map(|t| format!("\"{t}\"")).collect();
    match all.split_last() {
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// A task waits for at most this many.
pub const AFTER_MAX: usize = 8;

/// It landed: closed as merged or done. A task waiting for it waits no more.
fn landed(t: &Task) -> bool {
    t.closed
        .as_ref()
        .is_some_and(|c| c.how == "merged" || c.how == "done")
}

/// The board's stage of a task, from its record only (the CLI's word; the board works out its own).
fn stage(t: &Task) -> &str {
    match (&t.closed, &t.review) {
        (Some(c), _) => &c.how,
        (_, Some(r)) if r.pass => "gate",
        (_, Some(_)) => "review",
        _ if t.seats.iter().any(|s| s.writes) => "build",
        _ => "plan",
    }
}

/// What `t` still waits for among `all`: each id of `after` whose task has not landed. An id the ledger no longer
/// holds waits for nothing.
/// shortcut: a dropped blocker pruned with the oldest closed tasks (`CLOSED_KEPT`) stops holding its waiter; a
/// tombstone when a place closes that many tasks while one waits.
pub fn blockers(t: &Task, all: &[Task]) -> Vec<Blocker> {
    t.after
        .iter()
        .filter_map(|id| all.iter().find(|b| b.id == *id))
        .filter(|b| !landed(b))
        .map(|b| Blocker {
            id: b.id.clone(),
            title: b.title.clone(),
            stage: stage(b).into(),
            dropped: b.closed.is_some(),
        })
        .collect()
}

/// The open tasks that wait for `t` now.
pub fn waiters(t: &Task, all: &[Task]) -> usize {
    all.iter()
        .filter(|w| w.closed.is_none() && w.after.contains(&t.id) && !landed(t))
        .count()
}

/// `after` for task `id` (`None`: a task not made yet) of `place`, checked against every task of the ledger: each id an
/// open task of the place, not the task itself, no cycle (depth first over `after` of every open task, no cap), at most
/// `AFTER_MAX`. The ids once each, in the given order.
fn check_after(
    all: &[Task],
    id: Option<&str>,
    place: &Path,
    after: &[String],
) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = vec![];
    for a in after.iter().map(|a| a.trim()) {
        if !ids.iter().any(|i| i == a) {
            ids.push(a.into());
        }
    }
    if ids.len() > AFTER_MAX {
        return Err(format!(
            "Refused: a task waits for at most {AFTER_MAX} tasks."
        ));
    }
    let title = |id: &str| {
        all.iter()
            .find(|t| t.id == id)
            .map(|t| t.title.clone())
            .unwrap_or_default()
    };
    for b in &ids {
        if Some(b.as_str()) == id {
            return Err("Refused: a task cannot wait for itself.".into());
        }
        match all.iter().find(|t| t.id == *b && t.place == place) {
            Some(t) if t.closed.as_ref().is_some_and(|c| c.how == "dropped") => {
                return Err(format!(
                    "Refused: \"{}\" was dropped; a task cannot wait for it.",
                    t.title
                ));
            }
            Some(t) if t.closed.is_none() => {}
            _ => return Err(format!("Refused: no open task {b} in this project.")),
        }
    }
    let Some(id) = id else { return Ok(ids) };
    // A cycle: `id` is reached from one of its new blockers.
    for b in &ids {
        let mut seen = std::collections::BTreeSet::new();
        let mut stack = vec![b.as_str()];
        while let Some(at) = stack.pop() {
            if at == id {
                return Err(format!(
                    "Refused: \"{}\" would wait for \"{}\", which already waits for it.",
                    title(id),
                    title(b)
                ));
            }
            if !seen.insert(at) {
                continue;
            }
            if let Some(t) = all.iter().find(|t| t.id == at && t.closed.is_none()) {
                stack.extend(t.after.iter().map(String::as_str));
            }
        }
    }
    Ok(ids)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MergeOk {
    pub revision: String,
    pub at: u64,
}

/// One session of a role on this task. Never reused: a second builder after the first ended is a second seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "LedgerSeat"))]
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Told {
    pub at: u64,
    pub session: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Closed {
    pub at: u64,
    /// `done` (the lead or the user said so), `merged` (its last worktree went with nothing left outside the project),
    /// `removed` (an unnamed task's worktree went with its branch kept), `dropped`.
    pub how: String,
}

/// Slice i: what a place (a project, or Home) decided for the work done in it. A role carries neither: the same
/// Builder asks before each edit in one project and edits freely in another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Place {
    /// The way of working: `solo` (build only), `team` (build, then a fresh review), `strict` (team plus a security
    /// review). The guide's `levels.md`.
    pub way: String,
    /// What a seat that writes may do without asking: `ask` (every edit and command asks the user) or `edits` (it
    /// edits files in its worktree without asking; commands still ask).
    pub seats: String,
    /// Ticket 1081: the core nudges stalled seats, raises their card and wakes the lead (advance.rs). Off: it does nothing.
    /// Left out while on, so a place reads as before the setting (tests/ledger.rs).
    #[serde(default = "on", skip_serializing_if = "is_on")]
    pub auto: bool,
    /// Ticket 1081 part B: the live seats of this place at which the core stops starting Reviewers (`task cap`). The
    /// lead's own staffing is counted, never held back. Left out at the default.
    #[serde(default = "cap_default", skip_serializing_if = "is_cap_default")]
    pub cap: u32,
    /// Ticket 1120: the agent account (a label of accounts.toml) the seats of this place start on (`task account`).
    /// The user's choice only: ACCOUNTPICK lets a session of this place start seats on it as on its own account.
    /// Absent: the lead's own account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// The user's "Ask me before merging task work" (`task merge-ask on|off`). Off (the default): a lead merges reviewed
    /// task work into its working branch with no merge card (`ops::working_branch`); the default branch always asks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ask_merge: bool,
}
/// The choices of `Place.cap`, and its default.
pub const CAPS: [u32; 4] = [2, 4, 6, 8];
const CAP: u32 = 4;
fn on() -> bool {
    true
}
fn is_on(auto: &bool) -> bool {
    *auto
}
fn cap_default() -> u32 {
    CAP
}
fn is_cap_default(cap: &u32) -> bool {
    *cap == CAP
}
impl Default for Place {
    fn default() -> Self {
        Self {
            way: "team".into(),
            seats: "ask".into(),
            auto: true,
            cap: CAP,
            account: None,
            ask_merge: false,
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "LedgerView"))]
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
    /// Ticket 1055 rule 2: a seat that does not write runs its role's own model, so the floor of its Builder's level
    /// could not apply. One plain line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor: Option<String>,
    /// Ticket 1081: each seat's last activity (ms), for "N min ago".
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub seen: std::collections::BTreeMap<String, u64>,
    /// Ticket 1081: what waits on the lead: `review` (a done report newer than the last review, no seat at work) or
    /// `merge` (approved).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waits: Option<String>,
    /// Ticket 1095: the task's work package, read for `show` and the package verbs only (its own file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<package::Package>,
    /// Ticket 1120: each seat's account label (session id to label); a seat on its lead's own default is not listed.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub accounts: std::collections::BTreeMap<String, String>,
    /// The tasks of `after` that have not landed (`blockers`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<Blocker>,
    /// How many open tasks wait for this one.
    #[serde(default, skip_serializing_if = "is_zero_usize")]
    pub waiters: usize,
    /// A task it waits for was dropped: what the user is asked (the state is then `needs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stuck: Option<String>,
    /// A seat that writes sat on it before it waited: `started before "<title>" landed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early: Option<String>,
}
fn is_zero_usize(n: &usize) -> bool {
    *n == 0
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

/// A review note: masked as `line`, its lines kept (each trimmed at the end), at most `NOTE_MAX` chars.
fn note(text: &str) -> String {
    let mask = |s: &str| String::from_utf8_lossy(&crate::logs::mask(s.as_bytes())).into_owned();
    let flat = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let lines: Vec<&str> = text.trim().lines().map(str::trim_end).collect();
    let kept = mask(&lines.join("\n"));
    // Trap: mask reads a value on its key's line only, so "password:\n<secret>" passes it with the break kept. The
    // one-line copy is masked as before; when it masks more, it is stored and the breaks go.
    let joined = mask(&flat(text));
    let note = if flat(&kept) == joined { kept } else { joined };
    note.chars().take(NOTE_MAX).collect()
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
        auto: Option<bool>,
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
            if let Some(auto) = auto {
                p.auto = auto;
            }
            Ok((p.clone(), true))
        })
    }

    /// Ticket 1081 part B: the user's seat cap for a place, one of `CAPS`.
    pub fn set_cap(&self, place: &Path, cap: u32) -> Result<Place, String> {
        if !CAPS.contains(&cap) {
            return Err("seats at once is 2, 4, 6 or 8".into());
        }
        self.change(|s| {
            let p = s.places.entry(place.to_path_buf()).or_default();
            p.cap = cap;
            Ok((p.clone(), true))
        })
    }

    /// The user's "Ask me before merging task work" for a place.
    pub fn set_ask_merge(&self, place: &Path, on: bool) -> Result<Place, String> {
        self.change(|s| {
            let p = s.places.entry(place.to_path_buf()).or_default();
            p.ask_merge = on;
            Ok((p.clone(), true))
        })
    }

    /// Ticket 1120: the account the seats of a place start on; `None` is the lead's own. The caller checks the label.
    pub fn set_account(&self, place: &Path, account: Option<String>) -> Result<Place, String> {
        self.change(|s| {
            let p = s.places.entry(place.to_path_buf()).or_default();
            p.account = account;
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
                advance: Advance::default(),
                after: vec![],
                ordered: None,
                released: vec![],
                created: now,
                updated: now,
            };
            s.next += 1;
            s.tasks.push(task.clone());
            Ok(((task, true), true))
        })
    }

    /// Sets what open task `id` waits for (`check_after`); `by` is who, kept on the task. Empty clears it.
    pub fn set_after(
        &self,
        id: &str,
        after: &[String],
        by: &str,
        now: u64,
    ) -> Result<Task, String> {
        self.change(|s| {
            let t = s
                .tasks
                .iter()
                .find(|t| t.id == id && t.closed.is_none())
                .ok_or_else(|| format!("no open task {id}"))?;
            let ids = check_after(&s.tasks, Some(id), &t.place, after)?;
            let t = s.tasks.iter_mut().find(|t| t.id == id).ok_or("task lost")?;
            if t.after == ids {
                return Ok((t.clone(), false));
            }
            t.after = ids;
            t.ordered = Some(Ordered {
                by: by.into(),
                at: now,
            });
            t.updated = now;
            Ok((t.clone(), true))
        })
    }

    /// Marks, on each open task of `waiters`, that its lead was told `blocker` closed. The ones marked now.
    pub(crate) fn mark_released(
        &self,
        blocker: &str,
        waiters: &[String],
    ) -> Result<Vec<String>, String> {
        self.change(|s| {
            let mut now = vec![];
            for t in s.tasks.iter_mut().filter(|t| {
                t.closed.is_none()
                    && waiters.contains(&t.id)
                    && !t.released.iter().any(|r| r == blocker)
            }) {
                t.released.push(blocker.into());
                // Only the ids it still names matter: the rest go, so the list stays as short as `after`.
                t.released.retain(|r| t.after.contains(r));
                now.push(t.id.clone());
            }
            let changed = !now.is_empty();
            Ok((now, changed))
        })
    }

    /// Refused before `make` when `after` is wrong for a new task of `place`, so a refusal leaves no task behind.
    pub(crate) fn check_new_after(&self, place: &Path, after: &[String]) -> Result<(), String> {
        check_after(&self.list()?, None, place, after).map(|_| ())
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
            drop_unused(&mut s.tasks, Some(&target), now);
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
            drop_unused(&mut s.tasks, None, now);
            Ok(((), changed))
        })
    }

    /// One writer per worktree: refused while a seat that writes lives in this task's worktree.
    pub fn writer_free(&self, path: &Path, live: impl Fn(&str) -> bool) -> Result<(), String> {
        let Some(task) = self.of_worktree(path) else {
            return Ok(());
        };
        let waits = blockers(&task, &self.list()?);
        if !waits.is_empty() {
            return Err(not_started(&task, &waits));
        }
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
                note: note(&review.note),
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

    /// Ticket 1095: keeps `text` as the brief of seat `session` of open task `id`. What the seat is sent: the package's
    /// block (in full), then `text`; `text` alone when the package holds no quote, background, line or link.
    pub fn brief(&self, id: &str, session: &str, text: &str, now: u64) -> Result<String, String> {
        let task = self
            .list()?
            .into_iter()
            .find(|t| t.id == id && t.closed.is_none())
            .ok_or_else(|| format!("no open task {id}"))?;
        let name = task
            .seats
            .iter()
            .find(|s| s.session == session)
            .map(|s| s.name.clone())
            .ok_or_else(|| format!("{session} is no seat of task {id}"))?;
        let home = self.file.parent().unwrap_or(Path::new(""));
        let ((), p) = Packages::open(home)
            .change(id, |p| package::keep_brief(p, session, &name, text, now))?;
        let block = package::block(&p);
        Ok(if block.is_empty() {
            text.to_string()
        } else {
            format!("{block}\n{text}")
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

    /// Ticket 1081: advance.rs's record of open task `id`; `updated` is left alone (no progress of the task).
    pub fn set_advance(&self, id: &str, advance: Advance) -> Result<(), String> {
        self.change(|s| {
            match s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.closed.is_none())
            {
                Some(t) if t.advance != advance => {
                    t.advance = advance;
                    Ok(((), true))
                }
                _ => Ok(((), false)),
            }
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
                // Its waiters read it as dropped and ask; gone, they would start as if it had landed.
                && !s.tasks.iter().any(|w| w.closed.is_none() && w.after.contains(&closed.id))
                && closed.seats.is_empty()
                && closed.told.is_empty()
                && closed.review.is_none()
                // Ticket 1095: a package the lead filled keeps its task's row.
                && self.file.parent().is_some_and(|home| {
                    Packages::open(home).get(id).is_ok_and(|p| p.is_empty())
                })
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

/// An automatic task left with nothing (no worktree, seat, word or review) goes, but `keep`; one an open task waits for
/// closes as dropped instead, so its waiters ask rather than start as if it had landed.
fn drop_unused(tasks: &mut Vec<Task>, keep: Option<&str>, now: u64) {
    let unused = |t: &Task| Some(t.id.as_str()) != keep && t.auto && t.closed.is_none() && empty(t);
    let waited: Vec<String> = tasks
        .iter()
        .filter(|t| {
            unused(t)
                && tasks
                    .iter()
                    .any(|w| w.closed.is_none() && w.after.contains(&t.id))
        })
        .map(|t| t.id.clone())
        .collect();
    for t in tasks.iter_mut().filter(|t| waited.contains(&t.id)) {
        t.closed = Some(Closed {
            at: now,
            how: "dropped".into(),
        });
        t.updated = now;
    }
    tasks.retain(|t| !unused(t));
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
        floor: None,
        seen: Default::default(),
        waits: None,
        package: None,
        accounts: Default::default(),
        blockers: vec![],
        waiters: 0,
        stuck: None,
        early: None,
    }
}

/// Home view change 1 (11-17): one registered project as the Home view's Projects part shows it. Every number is the
/// core's, from the ledger, the decision queue and the sessions; no agent writes one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
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

/// Each task with its state word now.
pub(crate) fn views(
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    home: &Path,
    tasks: Vec<Task>,
) -> Result<Vec<View>, String> {
    // Ticket 1081: an open task's done report, newer than its last review, read with no lock held.
    let reported: Vec<bool> = tasks
        .iter()
        .map(|t| {
            let since = t.review.as_ref().map_or(0, |r| r.at + 1);
            t.closed.is_none()
                && t.worktrees.iter().any(|w| {
                    crate::sessions::report_status(w, since)
                        .is_some_and(|s| s.starts_with("STATUS: done"))
                })
        })
        .collect();
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
    let (now, names, levels, seen, accounts) = {
        let mut sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable".to_string())?;
        let levels: std::collections::BTreeMap<String, crate::team::Level> = tasks
            .iter()
            .flat_map(|t| &t.seats)
            .filter_map(|s| {
                Some((
                    s.session.clone(),
                    sessions.session_of(&s.session).ok()?.level?,
                ))
            })
            .collect();
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
        let seen: std::collections::BTreeMap<String, u64> = tasks
            .iter()
            .flat_map(|t| &t.seats)
            .map(|s| (s.session.clone(), sessions.seat_facts(&s.session).last))
            .collect();
        let accounts: std::collections::BTreeMap<String, String> = tasks
            .iter()
            .flat_map(|t| &t.seats)
            .filter_map(|s| {
                Some((
                    s.session.clone(),
                    sessions.session_of(&s.session).ok()?.account?,
                ))
            })
            .collect();
        (now, names, levels, seen, accounts)
    };
    let roles = crate::roles::Roles::open(home).list().unwrap_or_default();
    // Every task, for what each waits for and what waits for it.
    let all = Ledger::open(home).list().unwrap_or_default();
    let name = |id: &str| match names.get(id) {
        Some(label) if !label.is_empty() => label.clone(),
        _ if id == crate::room::PERSON => "the user".to_string(),
        _ => id.chars().take(6).collect(),
    };
    Ok(tasks
        .into_iter()
        .zip(revisions)
        .zip(reported)
        .map(|((task, revision), reported)| {
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
            // Ticket 1055 rule 2: the floor could not apply to a reviewing seat whose role names its own model.
            let built = task
                .seats
                .iter()
                .any(|s| s.writes && levels.contains_key(&s.session));
            let floor = task
                .seats
                .iter()
                .filter(|s| built && !s.writes && !levels.contains_key(&s.session))
                .find(|s| {
                    roles
                        .iter()
                        .any(|r| r.name.to_lowercase() == s.role && r.model.is_some())
                })
                .map(|s| {
                    format!(
                        "{} runs its role's own model, so it did not open at its builder's level",
                        s.name
                    )
                });
            let seen = task
                .seats
                .iter()
                .filter_map(|s| {
                    Some((
                        s.session.clone(),
                        *seen.get(&s.session).filter(|t| **t > 0)?,
                    ))
                })
                .collect();
            let v = view(
                task,
                &|s| now.get(s).cloned().unwrap_or_default(),
                asks,
                &revision,
            );
            let waits = match v.state.as_str() {
                "approved" => Some("merge".to_string()),
                "idle" | "asked" | "changes" | "review"
                    if reported && (v.state != "review" || v.stale) && !working(&v, &now) =>
                {
                    Some("review".to_string())
                }
                _ => None,
            };
            let accounts = task_accounts(&v.task, &accounts);
            let blockers = blockers(&v.task, &all);
            let stuck = blockers.iter().find(|b| b.dropped).map(|b| {
                format!(
                    "\"{}\" was dropped, so this cannot start. Stop waiting for it, or drop this too?",
                    b.title
                )
            });
            let early = blockers
                .iter()
                .find(|b| !b.dropped)
                .filter(|_| v.task.closed.is_none() && v.task.seats.iter().any(|s| s.writes))
                .map(|b| format!("started before \"{}\" landed", b.title));
            // It asks the user, unless a seat that writes is at work on it (the board tells the truth).
            let state = match &stuck {
                Some(_) if v.task.closed.is_none() && v.state != "working" => "needs".to_string(),
                _ => v.state.clone(),
            };
            View {
                floor,
                seen,
                waits,
                accounts,
                waiters: waiters(&v.task, &all),
                blockers,
                stuck,
                early,
                state,
                ..v
            }
        })
        .collect())
}

/// Ticket 1120: the accounts of this task's seats only.
fn task_accounts(
    task: &Task,
    all: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    task.seats
        .iter()
        .filter_map(|s| Some((s.session.clone(), all.get(&s.session)?.clone())))
        .collect()
}

/// Ticket 1081: a live seat of the task runs a turn (a Builder at work, or a Reviewer reading).
fn working(v: &View, now: &std::collections::BTreeMap<String, SeatNow>) -> bool {
    v.task.seats.iter().any(|s| {
        now.get(&s.session)
            .is_some_and(|n| n.live && n.state == "working")
    })
}

/// A task in a few plain lines, for a lead's brief and the CLI; `whole` (`task show`) gives a review note all its
/// lines, a list its first.
pub fn lines(v: &View, whole: bool) -> String {
    let t = &v.task;
    let mut out = format!("{} [{}", t.id, v.state);
    if v.stale {
        out += ", changed after the review";
    }
    out += &format!("] {}\n", t.title);
    for a in &t.accept {
        out += &format!("  accept: {a}\n");
    }
    for b in &v.blockers {
        out += &format!("  waits for {} \"{}\" ({})\n", b.id, b.title, b.stage);
    }
    if let Some(s) = &v.stuck {
        out += &format!("  asks: {s}\n");
    }
    if let Some(e) = &v.early {
        out += &format!("  {e}\n");
    }
    match v.waiters {
        0 => {}
        1 => out += "  1 task waits for this\n",
        n => out += &format!("  {n} tasks wait for this\n"),
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
        // Ticket 1081: a running seat's last activity, as the Team view shows it.
        let ago = match v.seen.get(&s.session) {
            Some(at) if v.live.contains(&s.session) => {
                match crate::queue::now_ms().saturating_sub(*at) / 60_000 {
                    0 => ", active now".to_string(),
                    m => format!(", active {m} min ago"),
                }
            }
            _ => String::new(),
        };
        // Ticket 1120: the account the seat runs on, when it is not the default one.
        let on = v
            .accounts
            .get(&s.session)
            .map_or(String::new(), |a| format!(", on {a}"));
        out += &format!(
            "  seat: {} · {} ({}, {live}{ago}{on})\n",
            s.role, s.name, s.session
        );
    }
    for n in &t.told {
        out += &format!("  the user told {}: \"{}\"\n", n.name, n.text);
    }
    for a in &v.asks {
        out += &format!("  open question: {a}\n");
    }
    if let Some(f) = &v.floor {
        out += &format!("  note: {f}\n");
    }
    // Ticket 1081: what the core's auto-advance saw.
    for s in &t.advance.stalled {
        out += &format!("  stalled: {} ({})\n", s.name, s.why);
    }
    match v.waits.as_deref() {
        Some("review") => out += "  waits: its report for a review\n",
        Some("merge") => out += "  waits: the merge\n",
        _ => {}
    }
    if let Some(r) = &t.review {
        let verdict = if r.pass { "pass" } else { "changes asked" };
        let mut parts = r.note.lines();
        let note = match parts.next() {
            None => String::new(),
            Some(first) if whole => {
                let rest: String = parts.map(|l| format!("\n    {l}")).collect();
                format!(": {first}{rest}")
            }
            Some(first) if parts.next().is_some() => {
                format!(": {first} (more: nunchiro task show {})", t.id)
            }
            Some(first) => format!(": {first}"),
        };
        out += &format!("  review by {}: {verdict}{note}\n", r.name);
    }
    for l in &t.learned {
        out += &format!("  lesson proposed by {}: {}\n", l.name, l.text);
    }
    if v.state == "merge" {
        out += "  the user said yes to merging these files\n";
    }
    if whole && let Some(o) = &t.ordered {
        out += &format!("  order set by {}\n", o.by);
    }
    if whole && let Some(p) = &v.package {
        out += &package::lines(p, &t.id);
    }
    out
}

#[cfg(test)]
mod tests;
