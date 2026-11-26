//! V2.5-11 (needs 136): scheduled runs. A schedule is a closed `Run` the owner picked (Claude or Codex, a model and
//! effort the window offers, a known project, a name) with a local time of day; it is no session row until it fires,
//! so it stays out of the tree until then. `schedules.json` keeps each entry's next fire time, so a core restart keeps
//! the schedule, and a time passed while no core ran fires once on the next start. Ticket 1002: once at most, and only
//! within 2 h (`LATE_MS`); a later one is skipped and logged as its run (`take_due`).
//! Only the owner adds or removes one (`Sessions::check_agent`, server's remote list, the browser role's allowlist):
//! a timer that starts agent work never takes a request from an agent, Remote or a browser. The file is written by
//! the core alone: each entry carries an HMAC-SHA256 under `schedule.key`, so an entry another process wrote or changed
//! is refused on load, and a `Run` holds no args, shell, account or folder, so even a forged one can start nothing an
//! agent could not start itself (needs 47).
//! Ticket 981: a `Run` may also hold a task (the owner's words, sent to the session as its first message) and a
//! teammate (team.rs): the teammate's folder, agent and brief are read when it fires. Both are under the MAC. Agents
//! still cannot add a schedule, so a teammate asks the owner for one.
//! Ticket 993: an entry may repeat on days of the week, be switched off (`paused`) and carries its last run. The
//! owner runs one now. A place's lead reads its place's entries and proposes one or a change (sessions.rs
//! `schedule_propose`, `schedule_change`): that is a card for the owner (`queue::OwnerAsk::Schedule`), and only the
//! owner's yes writes here. A session that does a scheduled run proposes nothing.
//! Ticket 1002 lane 3: the Home lead's morning and evening brief arrive once, switched off (`seed_presets`), and each
//! entry keeps its earlier runs (`earlier`) for the run log. `Entry` and `Last` deny unknown fields, so a core from
//! before this reads a file with `earlier` or a skipped run as broken, and no schedule runs until it is updated.
use crate::api::{AgentKind, StartSession};
use crate::sessions::Sessions;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const FILE: &str = "schedules.json";
const KEY: &str = "schedule.key";
const LABEL_MAX: usize = 80;
const TASK_MAX: usize = 4000;
const FILE_MAX: u64 = 1 << 20;
const MAX_ENTRIES: usize = 100;
const DAY_MS: u64 = 86_400_000;
/// Ticket 1002: a run missed by more than this (the Mac slept, no core ran) is skipped, not caught up.
const LATE_MS: u64 = 2 * 3_600_000;
/// Ticket 1002: the run log keeps this many runs before the last one.
const EARLIER_MAX: usize = 9;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub run: Run,
    /// Local `HH:MM`, or `YYYY-MM-DD HH:MM` for a once-schedule made with a date (ticket 333). Entries from before
    /// dates have the bare time and keep working.
    pub at: String,
    /// Fires every day at `at`; false: once. A once entry that fired stays listed, switched off (`paused`), with its
    /// last run, until the user removes it or edits it (look 11-17 v8 Home S2-C: it vanished the moment it fired,
    /// and nothing said that it ran). Entries from before load unchanged.
    pub daily: bool,
    /// Unix ms of the next fire (the core moves it, so it is outside the MAC).
    pub next_ms: u64,
    /// Hex HMAC-SHA256 of `id`, `run`, `at` and `daily` (and `days`, when it has any) under `schedule.key`.
    #[serde(default)]
    pub mac: String,
    /// Ticket 993: the days of the week a repeating entry runs on, sorted (0 Sunday to 6 Saturday, as JavaScript's
    /// `getDay`). Empty, as in every entry from before: every day. Not written when empty, so an old entry keeps
    /// its bytes and its MAC.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub days: Vec<u8>,
    /// Ticket 993: the user switched it off: it stays listed and does not run. `next_ms` means nothing while paused;
    /// a resume sets it again. Like `next_ms`, outside the MAC.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub paused: bool,
    /// Ticket 993: the last run, the core's own note (outside the MAC).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<Last>,
    /// Ticket 1002: the runs before `last`, newest first, at most `EARLIER_MAX` (outside the MAC). Not written when
    /// empty, so an entry from before keeps its bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub earlier: Vec<Last>,
}

/// Ticket 993: an entry's last run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Last {
    /// The session the run started or sent its task to; absent when it could not start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// When it ran (unix ms).
    pub at: u64,
    /// Absent: the session still works on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Outcome>,
    /// One line on why it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Finished,
    NeedsYou,
    Failed,
    /// Ticket 1002: more than 2 h late (`LATE_MS`), so not run.
    Skipped,
    /// Not run: the Mac was low on memory when it was due (`pressure`); `reason` says so.
    Held,
}
impl Outcome {
    /// A slot that was no run: too late, or held for low memory. It neither ends a failed run's card nor breaks a
    /// streak of failures.
    pub(crate) fn no_run(self) -> bool {
        matches!(self, Outcome::Skipped | Outcome::Held)
    }
}

/// Ticket 993: when an entry runs. `at` and `daily` as on `Entry`; `days` only on a repeating one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct When {
    pub at: String,
    #[serde(default)]
    pub daily: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub days: Vec<u8>,
}
const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
impl When {
    /// `nunchiro schedule propose --when`: `daily HH:MM`, `weekdays HH:MM`, `weekly <day> HH:MM` or
    /// `once YYYY-MM-DD HH:MM`. The time itself is checked where an entry is made (`check_at`).
    pub fn parse(words: &str) -> Result<When, String> {
        let bad = || {
            format!(
                "when {words:?} is not `daily HH:MM`, `weekdays HH:MM`, `weekly <day> HH:MM` or `once YYYY-MM-DD HH:MM`"
            )
        };
        let parts: Vec<&str> = words.split_whitespace().collect();
        let (at, daily, days) = match parts[..] {
            ["daily", at] => (at.to_string(), true, vec![]),
            ["weekdays", at] => (at.to_string(), true, vec![1, 2, 3, 4, 5]),
            ["weekly", day, at] => {
                let day = day.to_lowercase();
                // A full name or its first three letters.
                let n = DAY_NAMES
                    .iter()
                    .position(|name| *name == day || (day.len() == 3 && name.starts_with(&day)))
                    .ok_or_else(bad)?;
                (at.to_string(), true, vec![n as u8])
            }
            ["once", date, at] => (format!("{date} {at}"), false, vec![]),
            _ => return Err(bad()),
        };
        Ok(When { at, daily, days })
    }
    /// How a card says it: "Every day 9:00 PM", "Weekdays 9:00 AM", "Mondays 9:00 AM", "Once, 2026-11-19 9:00 AM".
    pub fn words(&self) -> String {
        let (date, time) = match self.at.split_once(' ') {
            Some((date, time)) => (Some(date), time),
            None => (None, self.at.as_str()),
        };
        let time = match minute_of_day(time) {
            Ok(m) => format!(
                "{}:{:02} {}",
                (m / 60 + 11) % 12 + 1,
                m % 60,
                if m < 720 { "AM" } else { "PM" }
            ),
            Err(_) => time.to_string(),
        };
        let name = |d: &u8| DAY_NAMES.get(*d as usize).copied().unwrap_or("?");
        let cap = |word: &str| word[..1].to_uppercase() + &word[1..];
        match (self.daily, date, &self.days[..]) {
            (false, Some(date), _) => format!("Once, {date} {time}"),
            (false, None, _) => format!("Once, {time}"),
            (true, _, []) => format!("Every day {time}"),
            (true, _, [1, 2, 3, 4, 5]) => format!("Weekdays {time}"),
            (true, _, [day]) => format!("{}s {time}", cap(name(day))),
            (true, _, days) => format!(
                "{} {time}",
                days.iter()
                    .map(|d| cap(name(d).get(..3).unwrap_or("?")))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

/// What a schedule starts: the owner's closed choice, never a raw `StartSession`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub kind: AgentKind,
    pub project: PathBuf,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Ticket 981: what the session is told when it starts. `None`: the session only opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// Ticket 981: the teammate (team.rs id) that does the task. Its folder, agent, name and brief are read at each
    /// fire; `kind`, `project` and `label` here are what they were when the schedule was made, for the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teammate: Option<String>,
    /// Ticket 992: the level the teammate's seat opens at for this task (team.rs `open_seat`). Absent asks none and
    /// is not written, so an entry from before levels keeps its MAC. Never stored for a teammate that leads its place
    /// (look 11-17 v8: its seat is not replaced for a scheduled run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<crate::team::Level>,
}
impl Run {
    /// Kind, model and effort from the window's own lists; a name of printable characters.
    fn check(&self) -> Result<(), String> {
        self.check_stored()?;
        self.check_model()
    }
    /// `check` without the model: what a stored entry must still pass after an update retires its model or effort
    /// (Q9 ja-J12-1). The model is checked when the entry is made and when it fires.
    fn check_stored(&self) -> Result<(), String> {
        // Ticket 994: a teammate may run an ACP agent. Its agent, model and effort are read from the teammate at
        // each fire (`team::open_seat`); what is stored here is for the list.
        let acp = self.kind == AgentKind::Acp && self.teammate.is_some();
        if !acp && !matches!(self.kind, AgentKind::Claude | AgentKind::Codex) {
            return Err("a schedule runs Claude or Codex only".into());
        }
        if self.label.chars().count() > LABEL_MAX || self.label.chars().any(char::is_control) {
            return Err("schedule name is too long or has control characters".into());
        }
        if let Some(task) = &self.task {
            // Tab and newline are fine in a task; other control characters are not.
            if task.trim().is_empty()
                || task.chars().count() > TASK_MAX
                || task
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err(format!(
                    "a schedule's task has 1 to {TASK_MAX} characters and no control characters"
                ));
            }
        }
        if let Some(id) = &self.teammate
            && (!crate::store::valid_id(id) || self.task.is_none())
        {
            return Err("a teammate's schedule needs a teammate and a task".into());
        }
        if self.level.is_some() && self.teammate.is_none() {
            return Err("only a teammate's schedule has a level".into());
        }
        Ok(())
    }
    fn check_model(&self) -> Result<(), String> {
        if self.kind == AgentKind::Acp && self.teammate.is_some() {
            return Ok(());
        }
        crate::sessions::check_model(self.kind, self.model.as_deref(), self.effort.as_deref())
    }
    fn start(&self) -> StartSession {
        StartSession {
            kind: self.kind,
            project: self.project.clone(),
            worktree: false,
            label: self.label.clone(),
            args: vec![],
            model: self.model.clone(),
            effort: self.effort.clone(),
            resume: None,
            account: None,
        }
    }
}

/// The project as given, only when it is already canonical (no symlink on the way) and a known project or inside one.
pub(crate) fn known_project(project: &Path, known: &BTreeSet<String>) -> Result<(), String> {
    let found = crate::projects::inside(project, known)?;
    (found == project)
        .then_some(())
        .ok_or_else(|| "schedule project must be a real path, not through a symlink".into())
}

pub(crate) fn hmac(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let pad = |b: u8| k.iter().map(|x| x ^ b).collect::<Vec<u8>>();
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(msg)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}
fn mac_of(key: &[u8], e: &Entry) -> String {
    // Days join the message only when there are any, so an entry from before days keeps its MAC. So does `paused`,
    // only when set: switched off is the owner's word that nothing runs, and a file edit that clears it must not
    // start unattended work (Codex look on wave 14).
    let msg = if e.paused {
        serde_json::to_vec(&(&e.id, &e.run, &e.at, e.daily, &e.days, true))
    } else if e.days.is_empty() {
        serde_json::to_vec(&(&e.id, &e.run, &e.at, e.daily))
    } else {
        serde_json::to_vec(&(&e.id, &e.run, &e.at, e.daily, &e.days))
    }
    .unwrap_or_default();
    hmac(key, &msg).iter().map(|b| format!("{b:02x}")).collect()
}
/// Constant-time compare, so the check does not leak how much of a forged MAC matched.
pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u32,
    schedules: Vec<Entry>,
}

pub struct Schedules {
    path: PathBuf,
    key: Result<Vec<u8>, String>,
    /// `Err`: the file could not be read; nothing fires and nothing is written over it.
    entries: Result<Vec<Entry>, String>,
}

/// `HH:MM` as minutes after local midnight.
fn minute_of_day(at: &str) -> Result<u64, String> {
    let bad = || format!("schedule time {at:?} is not HH:MM");
    let (h, m) = at.split_once(':').ok_or_else(bad)?;
    if h.len() != 2 || m.len() != 2 {
        return Err(bad());
    }
    let (h, m): (u64, u64) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    (h < 24 && m < 60).then_some(h * 60 + m).ok_or_else(bad)
}

/// The unix ms of a dated `at` (`YYYY-MM-DD HH:MM`, local); `None` when `at` has no date.
fn dated_ms(at: &str, offset: &dyn Fn(i64) -> i64) -> Result<Option<i64>, String> {
    let Some((date, time)) = at.split_once(' ') else {
        return Ok(None);
    };
    let bad = || format!("schedule date {at:?} is not YYYY-MM-DD HH:MM");
    let [y, m, d] = date.split('-').collect::<Vec<_>>()[..] else {
        return Err(bad());
    };
    if y.len() != 4
        || m.len() != 2
        || d.len() != 2
        || ![y, m, d]
            .iter()
            .all(|p| p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(bad());
    }
    let (y, m, d): (i64, i64, i64) = (
        y.parse().map_err(|_| bad())?,
        m.parse().map_err(|_| bad())?,
        d.parse().map_err(|_| bad())?,
    );
    // Back through the calendar: month 13 or February 31 comes back as another date.
    let days = crate::usage::days_from_civil(y, m, d);
    if !(1..=12).contains(&m) || crate::usage::civil_from_days(days) != (y, m, d) {
        return Err(bad());
    }
    let local = days * DAY_MS as i64 + minute_of_day(time)? as i64 * 60_000;
    // The offset on that date, not today's: a date past a daylight-saving change still fires at the time picked.
    let guess = local - offset(local / 1000) * 1000;
    Ok(Some(local - offset(guess / 1000) * 1000))
}

/// A stored or requested `at` is well formed for its entry: a date only on a once-schedule.
fn check_at(at: &str, daily: bool) -> Result<(), String> {
    if dated_ms(at, &|_| 0)?.is_some() {
        return (!daily)
            .then_some(())
            .ok_or_else(|| "a daily schedule has a time, not a date".to_string());
    }
    minute_of_day(at).map(|_| ())
}

/// Ticket 993: days are 0 to 6, sorted, each once, and only on a repeating entry.
fn check_days(days: &[u8], daily: bool) -> Result<(), String> {
    if days.iter().any(|d| *d > 6) || days.windows(2).any(|w| w[0] >= w[1]) {
        return Err("schedule days are 0 (Sunday) to 6 (Saturday), sorted, each once".into());
    }
    (daily || days.is_empty())
        .then_some(())
        .ok_or_else(|| "only a repeating schedule has days".to_string())
}

/// The day of the week (0 Sunday) of a local time in ms; 1970-01-01 was a Thursday.
fn weekday(local_ms: i64) -> u8 {
    (local_ms.div_euclid(DAY_MS as i64) + 4).rem_euclid(7) as u8
}

/// Ticket 993: the first `at` after `now_ms` on one of `days` (empty: any day), in the user's local time as `next_at`.
pub fn next_on(
    at: &str,
    days: &[u8],
    now_ms: u64,
    offset: &dyn Fn(i64) -> i64,
) -> Result<u64, String> {
    let mut next = next_at(at, now_ms, offset)?;
    let offset_ms = offset((now_ms / 1000) as i64) * 1000;
    // At most six steps: `days` holds a day of the week (`check_days`).
    for _ in 0..6 {
        if days.is_empty() || days.contains(&weekday(next as i64 + offset_ms)) {
            break;
        }
        next += DAY_MS;
    }
    Ok(next)
}

/// When a new or resumed entry runs first: its date (refused once it has passed), else its next time of day.
fn first_ms(when: &When, now_ms: u64, offset: &dyn Fn(i64) -> i64) -> Result<u64, String> {
    match dated_ms(&when.at, offset)? {
        // Only here: a dated entry whose time passed while no core ran still loads and fires once.
        Some(ms) if ms <= now_ms as i64 => Err("schedule date is in the past".into()),
        Some(ms) => Ok(ms as u64),
        None => next_on(&when.at, &when.days, now_ms, offset),
    }
}

impl Entry {
    pub fn when(&self) -> When {
        When {
            at: self.at.clone(),
            daily: self.daily,
            days: self.days.clone(),
        }
    }
}
/// When a switched-off entry would run first if it were switched on now; a date that passed is refused.
pub(crate) fn resume_ms(
    e: &Entry,
    now_ms: u64,
    offset: &dyn Fn(i64) -> i64,
) -> Result<u64, String> {
    first_ms(&e.when(), now_ms, offset).map_err(|e| format!("{e}: change its time or remove it"))
}

/// The first `at` (local) strictly after `now_ms`; `offset` gives the local offset in seconds at a unix time.
// shortcut: the offset is taken at `now`, so a fire on a DST-change day lands an hour off once; upgrade with tz rules.
pub fn next_at(at: &str, now_ms: u64, offset: &dyn Fn(i64) -> i64) -> Result<u64, String> {
    let minute = minute_of_day(at)?;
    let offset_ms = offset((now_ms / 1000) as i64) * 1000;
    let local = now_ms as i64 + offset_ms;
    let midnight = local - local.rem_euclid(DAY_MS as i64);
    let mut next = (midnight + (minute * 60_000) as i64 - offset_ms) as u64;
    while next <= now_ms {
        next += DAY_MS;
    }
    Ok(next)
}

impl Schedules {
    pub fn load(home: &Path) -> Self {
        let path = home.join(FILE);
        let key = key(&home.join(KEY));
        let entries = key.clone().and_then(|key| read(&path, &key));
        if let Err(e) = &entries {
            eprintln!("{e}");
        }
        Self { path, key, entries }
    }
    pub fn list(&self) -> Result<Vec<Entry>, String> {
        self.entries.clone()
    }
    /// What the owner reads (the list reply, `schedule list`): a teammate's schedule carries the teammate's name as it is
    /// now. The stored label is what the teammate was called when the entry was made (look v12 C V3: a rename left it).
    pub fn shown(&self) -> Result<Vec<Entry>, String> {
        let mut all = self.list()?;
        let mates = self
            .path
            .parent()
            .map(|home| crate::team::Team::open(home).list().unwrap_or_default())
            .unwrap_or_default();
        for e in &mut all {
            if let Some(m) = e
                .run
                .teammate
                .as_ref()
                .and_then(|id| mates.iter().find(|m| &m.id == id))
            {
                e.run.label = m.name.clone();
            }
        }
        Ok(all)
    }
    fn edit<T>(
        &mut self,
        f: impl FnOnce(&mut Vec<Entry>) -> Result<T, String>,
    ) -> Result<T, String> {
        let entries = self.entries.as_mut().map_err(|e| e.clone())?;
        let mut next = entries.clone();
        let out = f(&mut next)?;
        // Every write is this core's: an entry switched off or on since it was made gets the MAC of what it is now.
        if let Ok(key) = &self.key {
            for e in &mut next {
                e.mac = mac_of(key, e);
            }
        }
        let bytes = serde_json::to_vec_pretty(&Stored {
            version: 1,
            schedules: next.clone(),
        })
        .map_err(|e| e.to_string())?;
        // What is written must load again: a file over the read limit would stop every schedule at the next start.
        if bytes.len() as u64 > FILE_MAX {
            return Err(format!(
                "{FILE} would be too large: remove a schedule or shorten a task"
            ));
        }
        crate::store::atomic_write(&self.path, &bytes)?;
        *entries = next;
        Ok(out)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &mut self,
        run: Run,
        at: String,
        daily: bool,
        replace: Option<&str>,
        known: &BTreeSet<String>,
        now_ms: u64,
        offset: &dyn Fn(i64) -> i64,
    ) -> Result<Entry, String> {
        let when = When {
            at,
            daily,
            days: vec![],
        };
        self.add_on(run, when, replace, known, now_ms, offset)
    }
    /// The entry an add would store, checked as an add checks it; nothing is written. Ticket 993: a proposal is
    /// checked with this before its card is raised, so a card can always be applied. `kept`: the run of the entry an
    /// edit replaces.
    pub fn checked(
        &self,
        mut run: Run,
        when: When,
        kept: Option<&Run>,
        known: &BTreeSet<String>,
        now_ms: u64,
        offset: &dyn Fn(i64) -> i64,
    ) -> Result<Entry, String> {
        run.check()?;
        match &run.teammate {
            // The teammate's own folder (a project, or the team's Home folder, which is no project of the tree).
            Some(id) => {
                let home = self.path.parent().ok_or("schedules.json has no folder")?;
                match crate::team::Team::open(home).seat(id) {
                    Ok((mate, project)) => {
                        run = Run {
                            kind: mate.kind,
                            project,
                            label: mate.name,
                            model: mate.model,
                            effort: mate.effort,
                            // A lead's schedule stores no level: its run never replaces the lead's seat (`team::open_seat`).
                            level: run.level.filter(|_| !mate.lead),
                            ..run
                        };
                    }
                    // Look 11-17 v13 N2: an edit of a schedule whose teammate was removed keeps the target it stored
                    // (a fire fails "no longer a teammate", or a teammate of that name added later takes it over).
                    Err(e) => {
                        let old = kept
                            .filter(|old| {
                                old.teammate == run.teammate && e.starts_with("no teammate ")
                            })
                            .ok_or(e)?;
                        run = Run {
                            kind: old.kind,
                            project: old.project.clone(),
                            label: old.label.clone(),
                            model: old.model.clone(),
                            effort: old.effort.clone(),
                            ..run
                        };
                    }
                }
            }
            // Ticket 991 C4: a typed path is kept as the core resolves it (as a session's project); `fire` still
            // refuses it when the stored path no longer resolves to itself (a folder replaced by a link since).
            None => run.project = crate::projects::inside(&run.project, known)?,
        }
        let key = self.key.clone()?;
        check_at(&when.at, when.daily)?;
        check_days(&when.days, when.daily)?;
        let mut entry = Entry {
            id: crate::store::new_id()?,
            next_ms: first_ms(&when, now_ms, offset)?,
            run,
            at: when.at,
            daily: when.daily,
            mac: String::new(),
            days: when.days,
            paused: false,
            last: None,
            earlier: vec![],
        };
        entry.mac = mac_of(&key, &entry);
        Ok(entry)
    }
    /// Ticket 993: `add` with the days of the week. An edit (`replace`) keeps the replaced entry's switch, and its
    /// last run unless that failed. A once entry that fired was switched off by the core, not the user: its edit (a
    /// new time, still to come) switches it on again.
    pub fn add_on(
        &mut self,
        run: Run,
        when: When,
        replace: Option<&str>,
        known: &BTreeSet<String>,
        now_ms: u64,
        offset: &dyn Fn(i64) -> i64,
    ) -> Result<Entry, String> {
        self.add_as(run, when, replace, false, known, now_ms, offset)
    }
    /// `add_on`, switched off from the start when `paused` (ticket 1002: the brief presets), in the same one write.
    #[allow(clippy::too_many_arguments)]
    fn add_as(
        &mut self,
        run: Run,
        when: When,
        replace: Option<&str>,
        paused: bool,
        known: &BTreeSet<String>,
        now_ms: u64,
        offset: &dyn Fn(i64) -> i64,
    ) -> Result<Entry, String> {
        let kept = replace.and_then(|id| {
            let all = self.entries.as_ref().ok()?;
            all.iter().find(|e| e.id == id).map(|e| e.run.clone())
        });
        let mut entry = self.checked(run, when, kept.as_ref(), known, now_ms, offset)?;
        // `edit` gives it the MAC of what it is now, switch included.
        entry.paused = paused;
        self.edit(|all| {
            if let Some(old) = replace {
                let at = all
                    .iter()
                    .position(|e| e.id == old)
                    .ok_or("no such schedule")?;
                let old = all.remove(at);
                // A failed run is the user's cue to act; the edit is that act, so the failure does not outlive it.
                let ran = |l: &Last| !matches!(l.result, Some(Outcome::Failed | Outcome::Held));
                // Fired: its run is at or after its time. Run now before that time is no fire.
                let fired = !old.daily && old.last.as_ref().is_some_and(|l| l.at >= old.next_ms);
                (entry.paused, entry.last) = (old.paused && !fired, old.last.filter(ran));
                entry.earlier = old.earlier;
            }
            if all.len() >= MAX_ENTRIES {
                return Err(format!("at most {MAX_ENTRIES} schedules"));
            }
            all.push(entry.clone());
            Ok(entry)
        })
    }
    /// Ticket 1040 (Locate): the project's schedules follow it to its new folder switched off (`paused`), so nothing
    /// runs there unattended until the owner turns each on again; `edit` signs them as they are now. An unreadable
    /// file names no project this core can see, so it is left alone.
    pub(crate) fn locate(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        let mine = |e: &Entry| e.run.project == from;
        if !self.entries.as_ref().is_ok_and(|all| all.iter().any(mine)) {
            return Ok(());
        }
        self.edit(|all| {
            for e in all.iter_mut().filter(|e| e.run.project == from) {
                (e.run.project, e.paused) = (to.into(), true);
            }
            Ok(())
        })
    }
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.edit(|all| {
            let before = all.len();
            all.retain(|e| e.id != id);
            (all.len() < before)
                .then_some(())
                .ok_or_else(|| "no such schedule".into())
        })
    }
    /// Ticket 993: switches an entry off or on. A resumed one runs at its next time from now, never for a time that
    /// passed while it was off.
    pub fn pause(
        &mut self,
        id: &str,
        paused: bool,
        now_ms: u64,
        offset: &dyn Fn(i64) -> i64,
    ) -> Result<(), String> {
        self.edit(|all| {
            let e = all
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or("no such schedule")?;
            if e.paused && !paused {
                e.next_ms = resume_ms(e, now_ms, offset)?;
            }
            e.paused = paused;
            Ok(())
        })
    }
    /// Ticket 993: `entry` ran (or could not start) just now. An entry removed meanwhile keeps no note.
    pub(crate) fn record(&mut self, entry: &Entry, last: Last) {
        let result = self.edit(|all| {
            if let Some(e) = all.iter_mut().find(|e| e.id == entry.id) {
                push_last(e, last);
            }
            Ok(())
        });
        if let Err(e) = result {
            eprintln!("schedules: last run not recorded: {e}");
        }
    }
    /// Ticket 993: the last run's result follows its session. Called only when a session's state changed
    /// (`events::Seen::observe`); `state` is the events' word, `before` the one it had (`None`: first seen).
    // shortcut: it follows the session, not the one turn of the task: a task queued behind another turn of an open
    // seat reads finished when that turn ends, and a later talk with the session moves the result again; upgrade by
    // following the task's own send row (its `completion_seq`) when the row must mean that one turn.
    /// True when a last result changed.
    pub(crate) fn follow(&mut self, session: &str, before: Option<&str>, state: &str) -> bool {
        let of = |e: &Entry| {
            e.last
                .as_ref()
                .filter(|l| l.session.as_deref() == Some(session))
                .map(|l| l.result)
        };
        let Some(now) = self
            .entries
            .as_ref()
            .ok()
            .and_then(|all| all.iter().find_map(of))
        else {
            return false;
        };
        let (result, reason) = match state {
            "working" => (None, None),
            "question" | "permission" => (Some(Outcome::NeedsYou), None),
            "failed" => (Some(Outcome::Failed), Some("the session failed")),
            // A turn ended. The first state of a new session is "waiting" too: its task is still on its way.
            "waiting" if before.is_some() => (Some(Outcome::Finished), None),
            // Gone while it worked on it. First seen so (no `before`): the app closed during the run (look v15 Home S3).
            "exited" | "lost" | "ended" if now.is_none() => (
                Some(Outcome::Failed),
                Some(if before.is_none() {
                    "interrupted when the app closed"
                } else {
                    "the session ended before the task was done"
                }),
            ),
            _ => return false,
        };
        if result == now {
            return false;
        }
        let saved = self.edit(|all| {
            for e in all.iter_mut().filter(|e| of(e).is_some()) {
                if let Some(last) = &mut e.last {
                    (last.result, last.reason) = (result, reason.map(Into::into));
                }
            }
            Ok(())
        });
        if let Err(e) = &saved {
            eprintln!("schedules: last result not recorded: {e}");
        }
        saved.is_ok()
    }
    /// The entries due at `now_ms`, saved first as fired (a daily one moves to its next time, a once one is switched
    /// off and so never fires again by itself), so a crash during the start never fires it twice. Ticket 993: a
    /// paused entry is never due. Ticket 1002: one more than 2 h late moves on the same way but is not returned; its
    /// last run says it was skipped. Either way it runs once at most, however many of its times passed.
    pub fn take_due(&mut self, now_ms: u64, offset: &dyn Fn(i64) -> i64) -> Vec<Entry> {
        let due = |e: &Entry| !e.paused && e.next_ms <= now_ms;
        if !matches!(&self.entries, Ok(all) if all.iter().any(due)) {
            return vec![];
        }
        let mut skipped_any = false;
        let result = self.edit(|all| {
            let mut fired = vec![];
            for e in all.iter_mut().filter(|e| due(e)) {
                // A repeating entry is late only when none of its times fell in the last 2 h either: after days
                // asleep, a wake just after today's time still runs it (once).
                let late = now_ms - e.next_ms > LATE_MS
                    && (!e.daily
                        || next_on(&e.at, &e.days, now_ms - LATE_MS - 1, offset)? > now_ms);
                if !late {
                    fired.push(e.clone());
                }
                if e.daily {
                    e.next_ms = next_on(&e.at, &e.days, now_ms, offset)?;
                } else {
                    e.paused = true;
                }
                if late {
                    let skipped = Last {
                        session: None,
                        at: now_ms,
                        result: Some(Outcome::Skipped),
                        reason: Some("more than 2 h late, so not caught up".into()),
                    };
                    push_last(e, skipped);
                    skipped_any = true;
                }
            }
            Ok(fired)
        });
        // A run's own record tells the readers; a skip has none. Only the readers: a skip is no good run, so a failed
        // run's card stays (`Sessions::schedules_changed` would weigh it).
        if skipped_any && result.is_ok() {
            crate::events::schedules_changed();
        }
        result.unwrap_or_else(|e| {
            eprintln!("schedules: {e}");
            vec![]
        })
    }
}

/// Ticket 1002: `last` is now this run; the one before goes to the front of the run log.
fn push_last(e: &mut Entry, last: Last) {
    if let Some(old) = e.last.replace(last) {
        e.earlier.insert(0, old);
        e.earlier.truncate(EARLIER_MAX);
    }
}

/// Reads `path` through one NOFOLLOW handle: a regular file of at most `FILE_MAX` bytes, or `None` when absent.
fn read_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    // NOFOLLOW: a symlinked file is refused, never read through (as tree.toml).
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{name}: {e}")),
    };
    let meta = file.metadata().map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() || meta.len() > FILE_MAX {
        return Err(format!("{name} is not a regular file or is too large"));
    }
    let mut bytes = Vec::new();
    file.take(FILE_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{name}: {e}"))?;
    Ok(Some(bytes))
}

/// The core's MAC key, made once (0600, create_new so a planted file is never taken over silently).
/// Also `extensions.key` (ticket 276).
pub(crate) fn key(path: &Path) -> Result<Vec<u8>, String> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if let Some(bytes) = read_file(path)? {
        return (bytes.len() >= 32)
            .then_some(bytes)
            .ok_or_else(|| format!("{name} is too short"));
    }
    let key = (crate::store::new_id()? + &crate::store::new_id()?).into_bytes();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("{name}: {e}"))?;
    std::io::Write::write_all(&mut file, &key).map_err(|e| format!("{name}: {e}"))?;
    Ok(key)
}

fn read(path: &Path, key: &[u8]) -> Result<Vec<Entry>, String> {
    let Some(bytes) = read_file(path)? else {
        return Ok(vec![]);
    };
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|e| format!("{FILE}: {e}"))?;
    if stored.version != 1 {
        return Err(format!("{FILE}: unknown version {}", stored.version));
    }
    // An entry the core did not write, or a hand-edited one, is refused whole, as a broken file: a duplicate id would
    // fire twice, a bad time would fail every tick. The project is checked against the known ones at each fire, since
    // that set changes while the file does not.
    let mut ids = BTreeSet::new();
    for e in &stored.schedules {
        if !same(&e.mac, &mac_of(key, e)) {
            return Err(format!(
                "{FILE}: entry {} was not written by this core",
                e.id
            ));
        }
        check_at(&e.at, e.daily).map_err(|m| format!("{FILE}: {m}"))?;
        check_days(&e.days, e.daily).map_err(|m| format!("{FILE}: {m}"))?;
        e.run.check_stored().map_err(|m| format!("{FILE}: {m}"))?;
        if !ids.insert(e.id.as_str()) || !e.run.project.is_absolute() {
            return Err(format!(
                "{FILE}: duplicate id or relative project in {}",
                e.id
            ));
        }
    }
    Ok(stored.schedules)
}

fn lock(registry: &Mutex<Sessions>) -> Result<std::sync::MutexGuard<'_, Sessions>, String> {
    registry
        .lock()
        .map_err(|_| "session registry unavailable".to_string())
}

/// Starts every schedule due at `now_ms` through the owner's own `Start` path (server.rs, owner socket): the
/// schedule was made by the owner, so it starts with exactly the owner's authority, no more.
pub fn fire(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    now_ms: u64,
    offset: &dyn Fn(i64) -> i64,
) -> Vec<Result<String, String>> {
    let (due, again) = match lock(registry) {
        Ok(mut sessions) => {
            let due = sessions.schedules.take_due(now_ms, offset);
            // The owner's "run it again" on a failed run's card (sessions.rs, the schedule card): as Run now.
            let again = std::mem::take(&mut sessions.schedule_reruns);
            let all = sessions.schedules.list().unwrap_or_default();
            let again: Vec<Entry> = all.into_iter().filter(|e| again.contains(&e.id)).collect();
            (due, again)
        }
        Err(_) => return vec![],
    };
    // "Run it again" is the owner's press in the window; a due run starts by itself.
    use crate::pressure::Who;
    for entry in &again {
        let _ = run_entry(registry, stopping, entry, now_ms, Who::Window);
    }
    due.into_iter()
        .map(|entry| run_entry(registry, stopping, &entry, now_ms, Who::Session))
        .collect()
}

/// One run of `entry`, recorded as its last run (ticket 993): the session it reached, or why it could not start.
fn run_entry(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    entry: &Entry,
    now_ms: u64,
    who: crate::pressure::Who,
) -> Result<String, String> {
    let result = if stopping.load(Ordering::SeqCst) {
        Err("core is stopping".into())
    } else {
        start(registry, stopping, entry, who)
    };
    let held = result.as_ref().is_err_and(|e| crate::pressure::is_held(e));
    // A schedule's own words: the start's sentence names `agent start --anyway`, which runs no schedule.
    let result = match held {
        true => Err(crate::pressure::HELD_SCHEDULE.to_string()),
        false => result,
    };
    if let Err(e) = &result {
        eprintln!("schedule {}: {e}", entry.id);
    }
    let reason = result.as_ref().err().map(|e| {
        let line = e.split_whitespace().collect::<Vec<_>>().join(" ");
        line.chars().take(200).collect()
    });
    let last = Last {
        session: result.as_ref().ok().cloned(),
        at: now_ms,
        result: reason.is_some().then_some(match held {
            true => Outcome::Held,
            false => Outcome::Failed,
        }),
        reason,
    };
    if let Ok(mut sessions) = lock(registry) {
        if let Some(session) = &last.session {
            sessions.scheduled_run(session, &entry.id);
        }
        // A held run is no failure: no card, its record says why.
        let failed = last.reason.clone().filter(|_| !held);
        sessions.schedules.record(entry, last);
        // Look 11-17 v8 (Home S2-B): a failed run is the owner's card; a good one takes the card of an earlier
        // failure away (`schedules_changed`).
        if let Some(reason) = failed {
            sessions.failed_run_card(&entry.id, &reason);
        }
        sessions.schedules_changed();
    }
    result
}

/// Ticket 993: the owner's Run now. The entry runs once, at once, also when it is switched off; its next time stays.
pub(crate) fn run_now(registry: &Mutex<Sessions>, id: &str) -> crate::api::Response {
    let entry = lock(registry)?
        .schedules
        .list()?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("no such schedule")?;
    // `start` and `open_seat` refuse a core the owner stopped (`Sessions::stopped`).
    run_entry(
        registry,
        &AtomicBool::new(false),
        &entry,
        crate::queue::now_ms(),
        crate::pressure::Who::Window, // the owner's press in the window
    )?;
    Ok(crate::api::Reply::Schedules {
        schedules: lock(registry)?.schedules.shown()?,
    })
}

/// The teammate a teammate's schedule runs as. Look 11-17 v9 (Home S2-5): the entry names it by id; once that id is
/// gone, the teammate of the same name (the entry's label) in the same place takes the schedule over, and the entry is
/// repointed to it (as an edit to it would: its agent, model and effort for the list). Else the old id, which fails.
fn teammate_of(registry: &Mutex<Sessions>, entry: &Entry) -> Result<String, String> {
    let old = entry.run.teammate.clone().unwrap_or_default();
    let mut sessions = lock(registry)?;
    let team = crate::team::Team::open(sessions.home());
    let all = team.list()?;
    if all.iter().any(|t| t.id == old) {
        return Ok(old);
    }
    let Some(mate) = all.into_iter().find(|t| {
        t.name == entry.run.label
            && t.project.clone().unwrap_or_else(|| team.home()) == entry.run.project
    }) else {
        return Ok(old);
    };
    sessions.schedules.edit(|all| {
        for e in all.iter_mut().filter(|e| e.id == entry.id) {
            e.run.teammate = Some(mate.id.clone());
            e.run.kind = mate.kind;
            e.run.model = mate.model.clone();
            e.run.effort = mate.effort.clone();
            e.run.level = e.run.level.filter(|_| !mate.lead);
        }
        Ok(())
    })?;
    Ok(mate.id)
}

fn start(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    entry: &Entry,
    who: crate::pressure::Who,
) -> Result<String, String> {
    let run = &entry.run;
    // A teammate's schedule opens its seat (team.rs): the teammate as it is now, one session per seat, the task in
    // the brief of a new seat or alone to an open one. A removed teammate starts nothing.
    if let (Some(_), Some(task)) = (&run.teammate, &run.task) {
        let id = teammate_of(registry, entry)?;
        return crate::team::open_seat(
            registry,
            &id,
            Some(task),
            run.level,
            crate::team::Opener::Schedule(&entry.id, who),
        )
        .map(|opened| opened.session.id)
        // Ticket 993: the list shows this line; the id alone says nothing to the user.
        .map_err(|e| match e.starts_with("no teammate ") {
            true => format!("{} is no longer a teammate", run.label),
            false => e,
        });
    }
    // A model retired since the entry was made is this run's failure, not the whole file's (`check_stored`).
    run.check_model()?;
    let (session, first) = (run.start(), run.task.clone());
    crate::pressure::check_start(&session, who, false, "schedule")?;
    let launch = {
        let sessions = lock(registry)?;
        // The known projects now, not when it was made: a project gone since then is refused.
        known_project(&run.project, &sessions.known_projects())?;
        sessions.launch_as(None, session.clone(), false)?
    };
    // As the owner's Start: a missing agent still opens a tab, with its card.
    let mut launch = match launch.prepare() {
        Ok(launch) => launch,
        Err(e) => {
            lock(registry)?.start_failed_at(&session, None, e.clone())?;
            return Err(e);
        }
    };
    let mut sessions = lock(registry)?;
    if stopping.load(Ordering::SeqCst) || sessions.stopped() {
        return Err("core is stopping".into());
    }
    let session = sessions.start(&launch)?;
    launch.committed = true;
    // Marked before its task is sent (Codex look on wave 14), in this same lock.
    sessions.scheduled_run(&session.id, &entry.id);
    if let Some(text) = first {
        // As the window's start-then-prompt: the core holds the text until the agent takes input.
        sessions.prompt_as_user(&session.id, text)?;
    }
    Ok(session.id)
}

/// Ticket 1002: the feature key set once the brief presets were added; a preset the owner removed never comes back.
pub(crate) const PRESETS_KEY: &str = "home.brief_presets";
/// Ticket 1002 lane 3: the Home lead's two briefs. The task's first line is what the Schedules row shows.
const PRESETS: [(&str, &str); 2] = [
    (
        "weekdays 08:30",
        "Morning brief: calendar, important mail, decisions, failed runs.\n\
         Run `nunchiro task digest` and `nunchiro schedule list` now; every number (needs you, failed runs, outbox, open loops) \
         comes only from them. Add today's calendar and important mail in words. Stage any reply with \
         `nunchiro outbox stage`; never send. End with one line to the user: `nunchiro agent send --to person \"...\"`.",
    ),
    (
        "weekdays 18:00",
        "Evening brief: what landed today, what waits for tomorrow.\n\
         Run `nunchiro task digest` and `nunchiro schedule list` now; every number (needs you, failed runs, outbox, open loops) \
         comes only from them. Say in words what landed today and what waits for tomorrow. Stage any reply with \
         `nunchiro outbox stage`; never send. End with one line to the user: `nunchiro agent send --to person \"...\"`.",
    ),
];
/// Ticket 1002 lane 3: once the Home lead exists, its morning and evening brief are added once, switched off (the
/// owner turns them on), and `PRESETS_KEY` is set. A preset already there for the lead (same first line of its task)
/// is not added twice, so a failed key write only retries the key.
pub(crate) fn seed_presets(sessions: &mut Sessions, now_ms: u64, offset: &dyn Fn(i64) -> i64) {
    if sessions.feature::<bool>(PRESETS_KEY).is_some() {
        return;
    }
    let team = crate::team::Team::open(sessions.home());
    let Some(lead) = team.lead_of(None) else {
        return;
    };
    let known = sessions.known_projects();
    let head = |task: &str| task.lines().next().map(str::to_string);
    let mut added_any = false;
    for (words, task) in PRESETS {
        let Ok(all) = sessions.schedules.list() else {
            return; // an unreadable file: nothing is added, and the key waits
        };
        if all.iter().any(|e| {
            e.run.teammate.as_deref() == Some(lead.id.as_str())
                && e.run.task.as_deref().and_then(head) == head(task)
        }) {
            continue;
        }
        // `checked` fills the agent, folder and name from the teammate.
        let run = Run {
            kind: lead.kind,
            project: team.home(),
            label: lead.name.clone(),
            model: None,
            effort: None,
            task: Some(task.into()),
            teammate: Some(lead.id.clone()),
            level: None,
        };
        let added = When::parse(words).and_then(|when| {
            sessions
                .schedules
                .add_as(run, when, None, true, &known, now_ms, offset)
        });
        if let Err(e) = added {
            eprintln!("schedules: brief preset not added: {e}");
            return;
        }
        added_any = true;
    }
    let patch = crate::api::LifetimePatch {
        features: Some([(PRESETS_KEY.to_string(), true.into())].into()),
        ..Default::default()
    };
    if let Err(e) = sessions.quit_settings(patch) {
        eprintln!("schedules: {PRESETS_KEY} not set: {e}");
    }
    if added_any {
        sessions.schedules_changed();
    }
}

/// The core's timer: once a second, fires what is due (`fire`). It holds the registry lock only to take the due list.
pub(crate) fn spawn(
    registry: std::sync::Arc<Mutex<Sessions>>,
    stopping: std::sync::Arc<AtomicBool>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("schedule".into())
        .spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if let Ok(mut sessions) = registry.lock() {
                    seed_presets(
                        &mut sessions,
                        crate::queue::now_ms(),
                        &crate::usage::local_offset,
                    );
                }
                fire(
                    &registry,
                    &stopping,
                    crate::queue::now_ms(),
                    &crate::usage::local_offset,
                );
            }
        })
}

#[cfg(test)]
mod tests;
