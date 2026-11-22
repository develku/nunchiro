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
                let ran = |l: &Last| l.result != Some(Outcome::Failed);
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
    for entry in &again {
        let _ = run_entry(registry, stopping, entry, now_ms);
    }
    due.into_iter()
        .map(|entry| run_entry(registry, stopping, &entry, now_ms))
        .collect()
}

/// One run of `entry`, recorded as its last run (ticket 993): the session it reached, or why it could not start.
fn run_entry(
    registry: &Mutex<Sessions>,
    stopping: &AtomicBool,
    entry: &Entry,
    now_ms: u64,
) -> Result<String, String> {
    let result = if stopping.load(Ordering::SeqCst) {
        Err("core is stopping".into())
    } else {
        start(registry, stopping, entry)
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
        result: reason.is_some().then_some(Outcome::Failed),
        reason,
    };
    if let Ok(mut sessions) = lock(registry) {
        if let Some(session) = &last.session {
            sessions.scheduled_run(session, &entry.id);
        }
        let failed = last.reason.clone();
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
            crate::team::Opener::Schedule(&entry.id),
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
mod tests {
    use super::*;
    use crate::api::Request;

    #[test]
    fn next_at_is_strictly_later_local_time() {
        let utc = |_: i64| 0;
        assert_eq!(next_at("00:00", 0, &utc).unwrap(), DAY_MS);
        assert_eq!(next_at("21:00", 0, &utc).unwrap(), 21 * 3_600_000);
        // UTC+10: 21:00 local is 11:00 UTC.
        assert_eq!(next_at("21:00", 0, &|_| 36_000).unwrap(), 11 * 3_600_000);
        for bad in ["9:00", "24:00", "12:60", "ab:cd", ""] {
            assert!(next_at(bad, 0, &utc).is_err(), "{bad}");
        }
    }

    fn run(dir: &Path) -> Run {
        Run {
            kind: AgentKind::Claude,
            project: dir.to_path_buf(),
            label: String::new(),
            model: None,
            effort: None,
            task: None,
            teammate: None,
            level: None,
        }
    }
    fn known(dir: &Path) -> BTreeSet<String> {
        BTreeSet::from([dir.to_string_lossy().into_owned()])
    }
    fn home(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nunchiro-sched-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }
    fn day_s(y: i64, m: i64, d: i64) -> i64 {
        crate::usage::days_from_civil(y, m, d) * 86_400
    }

    /// Ticket 991 C4: a path through a link (macOS /var -> /private/var) is saved resolved, and that stored path
    /// still passes the fire-time check; once the folder is swapped for a link, the check refuses it.
    /// C3: `replace` swaps one entry for the edited one in the same write.
    #[test]
    fn linked_path_is_saved_resolved_and_replace_edits_in_place() {
        let utc = |_: i64| 0;
        let dir = home("linked");
        let real = dir.join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();
        let mut all = Schedules::load(&dir);
        let made = all
            .add(
                run(&dir.join("link")),
                "21:00".into(),
                true,
                None,
                &known(&real),
                0,
                &utc,
            )
            .unwrap();
        assert_eq!(made.run.project, real);
        known_project(&made.run.project, &known(&real)).unwrap();
        let edited = all
            .add(
                run(&real),
                "22:00".into(),
                true,
                Some(&made.id),
                &known(&real),
                0,
                &utc,
            )
            .unwrap();
        let left = all.list().unwrap();
        assert_eq!(
            (left.len(), left[0].id.as_str(), left[0].at.as_str()),
            (1, edited.id.as_str(), "22:00")
        );
        assert!(
            all.add(
                run(&real),
                "22:00".into(),
                true,
                Some("gone"),
                &known(&real),
                0,
                &utc
            )
            .is_err()
        );
        assert_eq!(
            all.list().unwrap().len(),
            1,
            "a failed edit changes nothing"
        );
        std::fs::rename(&real, dir.join("moved")).unwrap();
        std::os::unix::fs::symlink(dir.join("moved"), &real).unwrap();
        assert!(known_project(&made.run.project, &known(&real)).is_err());
    }

    /// 2026-11-05 18:00 at UTC+9 is 09:00 UTC: it fires then, once; a restart in between keeps it. Look 11-17 v8
    /// (Home S2-C): fired, it stays listed and switched off, never fires again by itself (nor after a restart), cannot
    /// be switched on for its passed date, and an edit to a later time arms it again.
    #[test]
    fn dated_once_fires_on_its_date_and_survives_restart() {
        let kst = |_: i64| 32_400;
        let dir = home("dated");
        let fire_ms = (day_s(2026, 11, 5) + 9 * 3600) as u64 * 1000;
        let added = Schedules::load(&dir)
            .add(
                run(&dir),
                "2026-11-05 18:00".into(),
                false,
                None,
                &known(&dir),
                0,
                &kst,
            )
            .unwrap();
        assert_eq!(added.next_ms, fire_ms);
        let mut again = Schedules::load(&dir);
        assert!(again.take_due(fire_ms - 1, &kst).is_empty());
        assert_eq!(again.take_due(fire_ms, &kst).len(), 1);
        let ran = Last {
            session: Some("s1".into()),
            at: fire_ms,
            result: None,
            reason: None,
        };
        again.record(&added, ran.clone());
        let mut after = Schedules::load(&dir);
        let listed = after.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].paused, listed[0].daily, &listed[0].last),
            (true, false, &Some(ran.clone()))
        );
        assert!(after.take_due(fire_ms + DAY_MS, &kst).is_empty());
        assert!(after.pause(&added.id, false, fire_ms + 1, &kst).is_err());
        let edit = |all: &mut Schedules, old: &str, at: &str, now| {
            all.add(
                run(&dir),
                at.into(),
                false,
                Some(old),
                &known(&dir),
                now,
                &kst,
            )
        };
        assert!(
            edit(&mut after, &added.id, "2026-11-05 18:00", fire_ms + 1).is_err(),
            "the same passed time"
        );
        let armed = edit(&mut after, &added.id, "2026-11-06 18:00", fire_ms + 1).unwrap();
        assert_eq!(
            (armed.paused, armed.next_ms, &armed.last),
            (false, fire_ms + DAY_MS, &Some(ran)),
            "on again, with its last run"
        );
        // A once entry the user switched off before its time is still off after an edit.
        after.pause(&armed.id, true, fire_ms + 2, &kst).unwrap();
        let still = edit(&mut after, &armed.id, "2026-11-07 18:00", fire_ms + 3).unwrap();
        assert!(still.paused, "the user's own switch");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The offset of the picked date counts, not the offset today (US Eastern, DST ends 2026-11-01).
    #[test]
    fn dated_once_uses_the_offset_on_that_date() {
        let change = day_s(2026, 11, 1) + 6 * 3600;
        let eastern = move |t: i64| if t < change { -14_400 } else { -18_000 };
        let ms = dated_ms("2026-11-05 18:00", &eastern).unwrap().unwrap();
        assert_eq!(ms, (day_s(2026, 11, 5) + 23 * 3600) * 1000);
    }

    #[test]
    fn past_or_impossible_dates_are_refused() {
        let dir = home("refused");
        let mut all = Schedules::load(&dir);
        let now = day_s(2026, 11, 9) as u64 * 1000;
        let utc = |_: i64| 0;
        for past in ["2026-11-08 23:59", "2026-11-09 00:00", "0001-01-01 00:00"] {
            let refused = all.add(run(&dir), past.into(), false, None, &known(&dir), now, &utc);
            assert_eq!(
                refused.unwrap_err(),
                "schedule date is in the past",
                "{past}"
            );
        }
        for bad in [
            "2026-02-31 10:00",
            "2026-13-01 10:00",
            "2026-1-01 10:00",
            "+026-11-10 10:00",
            "2026-11-10 25:00",
            "2026-11-10 ",
            "2026-11-10 10:00 x",
        ] {
            assert!(
                all.add(run(&dir), bad.into(), false, None, &known(&dir), now, &utc)
                    .is_err(),
                "{bad}"
            );
        }
        assert!(
            all.add(
                run(&dir),
                "2026-11-10 10:00".into(),
                true,
                None,
                &known(&dir),
                now,
                &utc
            )
            .is_err(),
            "a daily schedule has no date"
        );
        assert!(all.list().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A file written before dates existed: bare `HH:MM`, once. It loads, and fires at its stored time.
    #[test]
    fn stored_once_without_a_date_still_loads_and_fires() {
        let dir = home("legacy");
        let key = key(&dir.join(KEY)).unwrap();
        let mut old = Entry {
            id: "old1".into(),
            run: run(&dir),
            at: "21:00".into(),
            daily: false,
            next_ms: 5_000,
            mac: String::new(),
            days: vec![],
            paused: false,
            last: None,
            earlier: vec![],
        };
        old.mac = mac_of(&key, &old);
        let file = serde_json::json!({"version": 1, "schedules": [old]});
        std::fs::write(dir.join(FILE), file.to_string()).unwrap();
        let mut all = Schedules::load(&dir);
        assert_eq!(all.list().unwrap().len(), 1);
        assert_eq!(all.take_due(5_000, &|_| 0)[0].id, "old1");
        assert!(all.take_due(9_000, &|_| 0).is_empty(), "once");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Q9 ja-J12-1: an entry whose model a later release retired loads with the rest; only its own run is refused.
    #[test]
    fn a_retired_model_fails_its_run_not_the_file() {
        let dir = home("retired");
        let key = key(&dir.join(KEY)).unwrap();
        let mut old = Entry {
            id: "old1".into(),
            run: Run {
                model: Some("retired-model".into()),
                ..run(&dir)
            },
            at: "21:00".into(),
            daily: true,
            next_ms: 5_000,
            mac: String::new(),
            days: vec![],
            paused: false,
            last: None,
            earlier: vec![],
        };
        old.mac = mac_of(&key, &old);
        let file = serde_json::json!({"version": 1, "schedules": [old]});
        std::fs::write(dir.join(FILE), file.to_string()).unwrap();
        let mut all = Schedules::load(&dir);
        assert_eq!(all.list().unwrap().len(), 1);
        all.add(
            run(&dir),
            "22:00".into(),
            true,
            None,
            &known(&dir),
            0,
            &|_| 0,
        )
        .unwrap();
        let due = all.take_due(5_000, &|_| 0);
        assert_eq!(due[0].run.check_model().unwrap_err(), "unknown model");
        all.remove("old1").unwrap();
        assert_eq!(Schedules::load(&dir).list().unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 981: tasks can be long, so a write that would pass the read limit is refused and the file still loads.
    #[test]
    fn a_write_over_the_read_limit_is_refused_and_the_file_still_loads() {
        let dir = home("big");
        let utc = |_: i64| 0;
        let mut all = Schedules::load(&dir);
        let big = Run {
            task: Some("\u{1F600}".repeat(TASK_MAX)),
            ..run(&dir)
        };
        let mut kept = 0;
        let refused = loop {
            match all.add(
                big.clone(),
                "21:00".into(),
                true,
                None,
                &known(&dir),
                0,
                &utc,
            ) {
                Ok(_) => kept += 1,
                Err(e) => break e,
            }
        };
        assert!(refused.contains("would be too large"), "{refused}");
        assert!(kept > 10 && kept < MAX_ENTRIES, "{kept}");
        assert_eq!(Schedules::load(&dir).list().unwrap().len(), kept);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 993: a file from before days, the switch and the last run loads as it is, reads as "every day, on,
    /// never ran", and an entry that uses none of them is written with none of them (so its bytes and MAC stay).
    #[test]
    fn a_file_from_before_days_and_pause_loads_unchanged() {
        let dir = home("old-file");
        let made = Schedules::load(&dir)
            .add(
                run(&dir),
                "21:00".into(),
                true,
                None,
                &known(&dir),
                0,
                &|_| 0,
            )
            .unwrap();
        // The file as the earlier build wrote it: these six keys and no other.
        let old = serde_json::json!({"version": 1, "schedules": [{
            "id": made.id, "run": made.run, "at": "21:00", "daily": true, "next_ms": made.next_ms, "mac": made.mac,
        }]});
        let bytes = serde_json::to_vec_pretty(&old).unwrap();
        std::fs::write(dir.join(FILE), &bytes).unwrap();
        let all = Schedules::load(&dir);
        let e = &all.list().unwrap()[0];
        assert_eq!(
            (e.days.as_slice(), e.paused, &e.last),
            (&[][..], false, &None)
        );
        assert_eq!(
            std::fs::read(dir.join(FILE)).unwrap(),
            bytes,
            "a load writes nothing"
        );
        let text = serde_json::to_string(e).unwrap();
        for key in ["days", "paused", "last"] {
            assert!(!text.contains(key), "{text}");
        }
        // Days are under the MAC: a hand-edit of them is refused as any other.
        let mut edited = old.clone();
        edited["schedules"][0]["days"] = serde_json::json!([1]);
        std::fs::write(dir.join(FILE), edited.to_string()).unwrap();
        assert!(Schedules::load(&dir).list().is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 993: the day is the user's local day. Monday 00:30 at UTC+9 is Sunday 15:30 UTC; Friday 23:30 at UTC-5
    /// is Saturday 04:30 UTC, and after it the next weekday run is Monday's.
    #[test]
    fn weekly_and_weekdays_follow_the_local_day() {
        let ms = |y, m, d, h: i64, min: i64| ((day_s(y, m, d) + h * 3600 + min * 60) * 1000) as u64;
        let kst = |_: i64| 32_400;
        let sunday_utc = ms(2026, 11, 15, 15, 0); // Monday 00:00 in Seoul
        assert_eq!(
            next_on("00:30", &[1], sunday_utc, &kst).unwrap(),
            ms(2026, 11, 15, 15, 30)
        );
        // Just after it ran: the next Monday, seven days on.
        assert_eq!(
            next_on("00:30", &[1], ms(2026, 11, 15, 15, 30), &kst).unwrap(),
            ms(2026, 11, 22, 15, 30)
        );
        let est = |_: i64| -18_000;
        let friday_evening = ms(2026, 11, 14, 1, 0); // Friday 20:00 in New York
        let weekdays = [1, 2, 3, 4, 5];
        assert_eq!(
            next_on("23:30", &weekdays, friday_evening, &est).unwrap(),
            ms(2026, 11, 14, 4, 30)
        );
        assert_eq!(
            next_on("23:30", &weekdays, ms(2026, 11, 14, 4, 30), &est).unwrap(),
            ms(2026, 11, 17, 4, 30),
            "Saturday and Sunday are skipped"
        );
        assert_eq!(
            next_on("09:00", &[], 0, &|_| 0).unwrap(),
            9 * 3_600_000,
            "no days: every day"
        );

        // Through the store: a weekly entry fires on its day and moves a week on; days are checked on the way in.
        let dir = home("weekly");
        let mut all = Schedules::load(&dir);
        let when = |days: &[u8], daily| When {
            at: "00:30".into(),
            daily,
            days: days.to_vec(),
        };
        let made = all
            .add_on(
                run(&dir),
                when(&[1], true),
                None,
                &known(&dir),
                sunday_utc,
                &kst,
            )
            .unwrap();
        assert_eq!(made.next_ms, ms(2026, 11, 15, 15, 30));
        assert!(all.take_due(made.next_ms - 1, &kst).is_empty());
        assert_eq!(all.take_due(made.next_ms, &kst).len(), 1);
        assert_eq!(all.list().unwrap()[0].next_ms, ms(2026, 11, 22, 15, 30));
        assert_eq!(
            Schedules::load(&dir).list().unwrap()[0].days,
            [1],
            "days survive a reload"
        );
        for (days, daily) in [
            (&[7][..], true),
            (&[2, 1], true),
            (&[1, 1], true),
            (&[1], false),
        ] {
            assert!(
                all.add_on(run(&dir), when(days, daily), None, &known(&dir), 0, &kst)
                    .is_err(),
                "{days:?} {daily}"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 993: a switched-off entry is never due and keeps its place; switched on again it runs at its next time
    /// from then, not for the time it missed. An edit keeps the switch.
    // Ticket 1040 (Locate): a moved project's schedule follows it switched off, signed as it is now, and another
    // project's is as it was.
    #[test]
    fn a_located_projects_schedule_moves_paused_and_still_loads() {
        let utc = |_: i64| 0;
        let dir = home("located").canonicalize().unwrap();
        let (old, new) = (dir.join("old"), dir.join("new"));
        std::fs::create_dir_all(&old).unwrap();
        let mut all = Schedules::load(&dir);
        let known = BTreeSet::from([
            old.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
        ]);
        let run_in = |p: &Path| Run {
            project: p.to_path_buf(),
            ..run(&dir)
        };
        let mine = all
            .add(run_in(&old), "21:00".into(), true, None, &known, 0, &utc)
            .unwrap();
        let other = all
            .add(run_in(&dir), "21:00".into(), true, None, &known, 0, &utc)
            .unwrap();
        all.locate(&old, &new).unwrap();
        for all in [&all, &Schedules::load(&dir)] {
            let list = all.list().unwrap();
            let of = |id: &str| list.iter().find(|e| e.id == id).unwrap();
            assert_eq!(
                (&of(&mine.id).run.project, of(&mine.id).paused),
                (&new, true)
            );
            assert_eq!(
                (&of(&other.id).run.project, of(&other.id).paused),
                (&dir, false)
            );
        }
        // At 21:00 only the other project's runs: the moved one is switched off.
        let due = all.take_due(21 * 3_600_000, &utc);
        assert_eq!(due.iter().map(|e| &e.id).collect::<Vec<_>>(), [&other.id]);
    }

    #[test]
    fn a_paused_entry_does_not_run_and_resumes_at_its_next_time() {
        let utc = |_: i64| 0;
        let dir = home("paused");
        let mut all = Schedules::load(&dir);
        let daily = all
            .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
            .unwrap();
        let once = all
            .add(
                run(&dir),
                "1970-01-01 22:00".into(),
                false,
                None,
                &known(&dir),
                0,
                &utc,
            )
            .unwrap();
        for e in [&daily, &once] {
            all.pause(&e.id, true, 0, &utc).unwrap();
        }
        let day3 = 3 * DAY_MS;
        assert!(all.take_due(day3, &utc).is_empty());
        assert_eq!(
            all.list().unwrap().len(),
            2,
            "a paused once entry is not dropped"
        );
        assert!(
            Schedules::load(&dir)
                .list()
                .unwrap()
                .iter()
                .all(|e| e.paused)
        );
        all.pause(&daily.id, false, day3, &utc).unwrap();
        let on = all
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.id == daily.id)
            .unwrap();
        assert_eq!((on.paused, on.next_ms), (false, day3 + 21 * 3_600_000));
        assert!(
            all.take_due(day3 + 1, &utc).is_empty(),
            "the missed days do not run"
        );
        // A date that passed while it was off cannot be switched on; it says what to do.
        let refused = all.pause(&once.id, false, day3, &utc).unwrap_err();
        assert!(
            refused.contains("in the past: change its time or remove it"),
            "{refused}"
        );
        assert!(all.pause("gone", true, 0, &utc).is_err());
        // An edit of a paused entry stays paused and keeps its last run.
        all.pause(&daily.id, true, day3, &utc).unwrap();
        all.record(
            &daily,
            Last {
                session: Some("s1".into()),
                at: 7,
                result: None,
                reason: None,
            },
        );
        let edited = all
            .add(
                run(&dir),
                "22:00".into(),
                true,
                Some(&daily.id),
                &known(&dir),
                day3,
                &utc,
            )
            .unwrap();
        assert!(edited.paused);
        assert_eq!(edited.last.unwrap().session.as_deref(), Some("s1"));
        // A failed last run does not outlive the edit that answers it.
        all.follow("s1", Some("working"), "failed");
        let again = all
            .add(
                run(&dir),
                "23:00".into(),
                true,
                Some(&edited.id),
                &known(&dir),
                day3,
                &utc,
            )
            .unwrap();
        assert_eq!((again.paused, again.last), (true, None));
        // Switched off is under the entry's MAC: it loads again as it is, and a file edit that switches it on is an
        // entry this core did not write (it would run unattended work the owner stopped).
        assert!(Schedules::load(&dir).list().unwrap()[0].paused);
        let file = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(file.contains("\"paused\": true"));
        std::fs::write(
            dir.join(FILE),
            file.replace("\"paused\": true", "\"paused\": false"),
        )
        .unwrap();
        let forged = Schedules::load(&dir).list().unwrap_err();
        assert!(forged.contains("was not written by this core"), "{forged}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 993: the last run is recorded, a once entry that fired is switched off (with its reason when it could
    /// not start), and the result follows the session's state changes.
    #[test]
    fn the_last_run_is_recorded_and_follows_its_session() {
        let utc = |_: i64| 0;
        let dir = home("last");
        let mut all = Schedules::load(&dir);
        let daily = all
            .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
            .unwrap();
        let once = all
            .add(
                run(&dir),
                "22:00".into(),
                false,
                None,
                &known(&dir),
                0,
                &utc,
            )
            .unwrap();
        // Both within 2 h of their time (21:00 and 22:00): neither is skipped.
        assert_eq!(all.take_due(22 * 3_600_000 + 1, &utc).len(), 2);
        let failed = |why: &str| Last {
            session: None,
            at: DAY_MS,
            result: Some(Outcome::Failed),
            reason: Some(why.into()),
        };
        all.record(&once, failed("Lister is no longer a teammate"));
        all.record(
            &daily,
            Last {
                session: Some("s1".into()),
                at: DAY_MS,
                result: None,
                reason: None,
            },
        );
        let get = |all: &Schedules, id: &str| {
            all.list()
                .unwrap()
                .into_iter()
                .find(|e| e.id == id)
                .unwrap()
        };
        let back = get(&all, &once.id);
        assert!(back.paused, "it does not run again by itself");
        assert_eq!(back.last, Some(failed("Lister is no longer a teammate")));
        // Its MAC covers "switched off" now, so it is not the fired entry's; the file loads again with it.
        let again = Schedules::load(&dir).list().unwrap();
        assert!(again.iter().any(|e| e.id == once.id && e.paused));
        // An entry removed meanwhile keeps no note.
        let gone = Entry {
            id: "other".into(),
            ..once.clone()
        };
        all.record(
            &gone,
            Last {
                session: Some("s9".into()),
                at: 1,
                result: None,
                reason: None,
            },
        );
        assert_eq!(all.list().unwrap().len(), 2);

        let result = |all: &Schedules| get(all, &daily.id).last.unwrap().result;
        all.follow("s1", None, "waiting"); // the new session's first state: its task is on its way
        assert_eq!(result(&all), None);
        all.follow("s1", Some("waiting"), "working");
        assert_eq!(result(&all), None);
        all.follow("s1", Some("working"), "permission");
        assert_eq!(result(&all), Some(Outcome::NeedsYou));
        all.follow("s1", Some("permission"), "working");
        assert_eq!(result(&all), None);
        all.follow("s1", Some("working"), "waiting");
        assert_eq!(result(&all), Some(Outcome::Finished));
        all.follow("s1", Some("waiting"), "exited");
        assert_eq!(
            result(&all),
            Some(Outcome::Finished),
            "ended after its turn: still finished"
        );
        all.follow("s1", Some("exited"), "working");
        all.follow("s1", Some("working"), "ended");
        let last = get(&all, &daily.id).last.unwrap();
        assert_eq!(last.result, Some(Outcome::Failed));
        assert_eq!(
            last.reason.as_deref(),
            Some("the session ended before the task was done")
        );
        all.follow("s1", Some("ended"), "working");
        all.follow("s1", None, "lost"); // the next app start finds it stopped mid-run
        assert_eq!(
            get(&all, &daily.id).last.unwrap().reason.as_deref(),
            Some("interrupted when the app closed")
        );
        all.follow("s1", Some("lost"), "working");
        all.follow("s1", Some("working"), "failed");
        assert_eq!(
            get(&all, &daily.id).last.unwrap().reason.as_deref(),
            Some("the session failed")
        );
        // Another session's change touches nothing, and the file reloads with what was recorded.
        all.follow("s2", Some("working"), "waiting");
        assert_eq!(
            get(&Schedules::load(&dir), &daily.id).last.unwrap().result,
            Some(Outcome::Failed)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 993: the words of `schedule propose --when`, and how a card says a time.
    #[test]
    fn when_parses_the_four_forms_and_reads_in_words() {
        let when = |words: &str| When::parse(words).unwrap();
        assert_eq!(
            when("daily 21:00"),
            When {
                at: "21:00".into(),
                daily: true,
                days: vec![]
            }
        );
        assert_eq!(when("weekdays 09:00").days, [1, 2, 3, 4, 5]);
        assert_eq!(when("weekly Monday 09:00").days, [1]);
        assert_eq!(when("weekly sun 00:05").days, [0]);
        assert_eq!(
            when("once 2026-11-19 09:00"),
            When {
                at: "2026-11-19 09:00".into(),
                daily: false,
                days: vec![]
            }
        );
        for bad in [
            "",
            "21:00",
            "hourly 21:00",
            "weekly 09:00",
            "weekly someday 09:00",
            "weekly mo 09:00",
            "once 09:00",
            "daily 21:00 x",
        ] {
            assert!(When::parse(bad).is_err(), "{bad}");
        }
        for (words, says) in [
            ("daily 21:00", "Every day 9:00 PM"),
            ("weekdays 09:00", "Weekdays 9:00 AM"),
            ("weekly monday 00:05", "Mondays 12:05 AM"),
            ("once 2026-11-19 12:00", "Once, 2026-11-19 12:00 PM"),
        ] {
            assert_eq!(when(words).words(), says);
        }
        let two = When {
            at: "09:00".into(),
            daily: true,
            days: vec![1, 3],
        };
        assert_eq!(two.words(), "Mon, Wed 9:00 AM");
    }

    /// RFC 4231 test case 2.
    /// Ticket 994: a teammate's schedule may be on an ACP agent (the teammate's); a plain one still may not.
    #[test]
    fn only_a_teammates_schedule_runs_an_acp_agent() {
        let acp = |teammate: Option<&str>| Run {
            kind: AgentKind::Acp,
            task: Some("sort".into()),
            teammate: teammate.map(Into::into),
            ..run(Path::new("/tmp"))
        };
        acp(Some("0123456789abcdef0123456789abcdef"))
            .check()
            .unwrap();
        assert_eq!(
            acp(None).check().unwrap_err(),
            "a schedule runs Claude or Codex only"
        );
    }
    #[test]
    fn hmac_sha256_matches_rfc4231() {
        let mac: String = hmac(b"Jefe", b"what do ya want for nothing?")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            mac,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// Ticket 1002: a run more than 2 h late is skipped and logged, its time moves on, and it never fires for that
    /// time; one under 2 h late runs once, however many of its times passed. The MAC stays what the owner made.
    #[test]
    fn a_late_run_is_skipped_and_logged_and_a_near_one_runs_once() {
        let utc = |_: i64| 0;
        let hour = 3_600_000;
        let dir = home("late");
        let mut all = Schedules::load(&dir);
        let made = all
            .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
            .unwrap();
        let mac = all.list().unwrap()[0].mac.clone();
        // Asleep from 21:00 to 00:01 the next day: skipped, and the next time is tomorrow's 21:00.
        assert!(all.take_due(24 * hour + 60_000, &utc).is_empty());
        let e = Schedules::load(&dir).list().unwrap()[0].clone();
        let last = e.last.clone().unwrap();
        assert_eq!(
            (last.result, last.session, last.at),
            (Some(Outcome::Skipped), None, 24 * hour + 60_000)
        );
        assert_eq!(e.next_ms, DAY_MS + 21 * hour);
        assert_eq!(e.mac, mac, "a skip is outside the MAC");
        // Days missed, the last one 1 h ago: one run, not one per day.
        let now = 4 * DAY_MS + 22 * hour;
        let due = all.take_due(now, &utc);
        assert_eq!(
            due.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            [made.id.as_str()]
        );
        assert!(all.take_due(now, &utc).is_empty());
        // Exactly 2 h late still runs; a once entry more than 2 h late is switched off, skipped.
        let next = all.list().unwrap()[0].next_ms;
        assert_eq!(all.take_due(next + LATE_MS, &utc).len(), 1);
        let once = all
            .add(
                run(&dir),
                "23:00".into(),
                false,
                None,
                &known(&dir),
                now,
                &utc,
            )
            .unwrap();
        assert!(all.take_due(once.next_ms + LATE_MS + 1, &utc).is_empty());
        let e = all
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.id == once.id)
            .unwrap();
        assert!(e.paused);
        assert_eq!(e.last.unwrap().result, Some(Outcome::Skipped));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 1002: the run log keeps the 9 runs before the last one, newest first, and an edit keeps it.
    #[test]
    fn the_run_log_keeps_earlier_runs_newest_first() {
        let utc = |_: i64| 0;
        let dir = home("runlog");
        let mut all = Schedules::load(&dir);
        let made = all
            .add(run(&dir), "21:00".into(), true, None, &known(&dir), 0, &utc)
            .unwrap();
        let ran = |at| Last {
            session: Some(format!("s{at}")),
            at,
            result: Some(Outcome::Finished),
            reason: None,
        };
        for at in 1..=12 {
            all.record(&made, ran(at));
        }
        let e = Schedules::load(&dir).list().unwrap()[0].clone();
        assert_eq!(e.last, Some(ran(12)));
        assert_eq!(
            e.earlier.iter().map(|l| l.at).collect::<Vec<_>>(),
            (3..=11).rev().collect::<Vec<_>>()
        );
        let edited = all
            .add(
                run(&dir),
                "22:00".into(),
                true,
                Some(&made.id),
                &known(&dir),
                0,
                &utc,
            )
            .unwrap();
        assert_eq!(edited.earlier.len(), EARLIER_MAX, "an edit keeps the log");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ticket 1002 lane 3: the Home lead's two briefs arrive once, switched off, and the key is set; with the key
    /// cleared they are not added a second time; a removed one does not come back while the key is set.
    #[test]
    fn brief_presets_arrive_once_and_paused() {
        let utc = |_: i64| 0;
        let dir = home("presets");
        let mut core = Sessions::open(&dir).unwrap();
        seed_presets(&mut core, 0, &utc);
        assert!(
            core.schedules.list().unwrap().is_empty(),
            "no Home lead yet"
        );
        let lead = crate::team::Team::open(&dir)
            .save(
                None,
                crate::team::Teammate {
                    id: String::new(),
                    name: "Chief".into(),
                    job: "Chief of staff.".into(),
                    kind: AgentKind::Claude,
                    model: None,
                    effort: None,
                    project: None,
                    lead: true,
                    level: None,
                    level_max: None,
                    next_level: None,
                    agent: None,
                },
            )
            .unwrap()
            .remove(0);
        seed_presets(&mut core, 0, &utc);
        seed_presets(&mut core, 0, &utc);
        let all = core.schedules.list().unwrap();
        assert_eq!(all.len(), 2);
        for e in &all {
            assert!(e.paused, "arrives switched off");
            assert_eq!(e.run.teammate.as_deref(), Some(lead.id.as_str()));
            assert_eq!(e.days, [1, 2, 3, 4, 5]);
        }
        assert_eq!(
            all.iter().map(|e| e.at.as_str()).collect::<Vec<_>>(),
            ["08:30", "18:00"]
        );
        assert_eq!(core.feature::<bool>(PRESETS_KEY), Some(true));
        assert!(
            core.schedules.take_due(u64::MAX / 2, &utc).is_empty(),
            "never runs while off"
        );
        // A key write lost: the next pass adds nothing twice.
        let clear = crate::api::LifetimePatch {
            features: Some([(PRESETS_KEY.to_string(), serde_json::Value::Null)].into()),
            ..Default::default()
        };
        core.quit_settings(clear).unwrap();
        seed_presets(&mut core, 0, &utc);
        assert_eq!(core.schedules.list().unwrap().len(), 2);
        // The owner removes one: it stays removed.
        core.schedules.remove(&all[0].id).unwrap();
        seed_presets(&mut core, 0, &utc);
        assert_eq!(core.schedules.list().unwrap().len(), 1);
        drop(core);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The browser role and agents never reach a schedule request.
    #[test]
    fn browser_role_refuses_schedule() {
        let add = Request::ScheduleAdd {
            run: Run {
                kind: AgentKind::Claude,
                project: "/tmp".into(),
                label: String::new(),
                model: None,
                effort: None,
                task: None,
                teammate: None,
                level: None,
            },
            at: "21:00".into(),
            daily: true,
            replace: None,
            days: vec![],
        };
        for r in [
            add,
            Request::ScheduleList,
            Request::ScheduleRemove { id: "x".into() },
            Request::ScheduleRunNow { id: "x".into() },
            Request::SchedulePause {
                id: "x".into(),
                paused: true,
            },
        ] {
            assert!(!crate::http::browser::request_allowed(&r), "{r:?}");
        }
    }
}
