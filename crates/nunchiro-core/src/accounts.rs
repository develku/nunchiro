//! V2-2a: agent accounts. The registry `accounts.toml` in the data folder names each account; its config folder is
//! `accounts/<agent>/<id>/`. Nunchiro creates the folder and points the agent's own login and status commands at
//! it; it never opens what the agent writes there. "Your own" (no override) is implicit, never stored.
use crate::{
    api::{AgentKind, RemoveStep, Reply, Request, Response, Session, StartSession},
    sessions::Sessions,
    store,
};
/// V2-2b: the variables that point an agent at a config folder; an account's folder is never a core's own.
pub const CONFIG_ENV: [&str; 3] = [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_HOME",
];
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    ffi::{CStr, CString, OsString},
    fs,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Claude,
    Codex,
}
pub fn agent_name(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "claude",
        Agent::Codex => "codex",
    }
}
/// The variable that points the agent at a config folder.
pub(crate) fn variable(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "CLAUDE_CONFIG_DIR",
        Agent::Codex => "CODEX_HOME",
    }
}
/// V2-2b: the agent whose accounts a session kind runs on; a shell has none.
pub(crate) fn agent_of(kind: AgentKind) -> Option<Agent> {
    match kind {
        AgentKind::Claude => Some(Agent::Claude),
        AgentKind::Codex => Some(Agent::Codex),
        AgentKind::Shell | AgentKind::Acp => None, // V2-4a: an ACP agent has no account
    }
}
/// V2-2b: the config folder a session of `kind` reads its transcripts and config from: its account's, else "Your own"
/// (the core's variable, else the agent's default under HOME).
pub(crate) fn config_home(kind: AgentKind, config_dir: Option<&Path>) -> Option<PathBuf> {
    config_dir
        .map(Path::to_path_buf)
        .or_else(|| own_folder(agent_of(kind)?))
}
/// V2-2b: the folder and label of `agent`'s account named `label`, through the registry only: a path is just an
/// unknown label.
pub(crate) fn folder_by_label(
    home: &Path,
    agent: Agent,
    label: &str,
) -> Result<(PathBuf, String), String> {
    // Debug quoting escapes control and format characters, so a hostile label cannot reach a terminal raw.
    match find(home, agent, |e, _| e.label == label)?.as_slice() {
        [] => Err(format!(
            "unknown account {label:?} for {}; see nunchiro account list",
            agent_name(agent)
        )),
        [one] => Ok(one.clone()),
        // Two accounts may share a name (the registry allows it): never guess which one was meant.
        _ => Err(format!(
            "two {} accounts are named {label:?}; remove one",
            agent_name(agent)
        )),
    }
}
/// V2-2d: a launch on `folder` (through `variable`) still names a registered account, checked again under the session
/// lock so a launch prepared before a remove never starts on the moved folder.
pub(crate) fn still_registered(
    home: &Path,
    variable: &str,
    folder: &Path,
) -> Result<String, String> {
    let agent = [Agent::Claude, Agent::Codex]
        .into_iter()
        .find(|a| self::variable(*a) == variable)
        .ok_or("not an account variable")?;
    folder_again(home, agent, folder).map(|(_, label)| label)
}
/// Ticket 358: every registered account's folder and name, for a core that is starting; empty when the registry cannot
/// be read, so a start never fails on it.
pub(crate) fn labels_by_folder(home: &Path) -> std::collections::HashMap<PathBuf, String> {
    let Ok(home) = fs::canonicalize(home) else {
        return Default::default();
    };
    let entries = WRITE
        .lock()
        .map_err(|_| "account registry unavailable".to_string())
        .and_then(|_write| load(&home))
        .unwrap_or_default();
    entries
        .into_iter()
        .map(|e| (account_folder(&home, e.agent, &e.id), e.label))
        .collect()
}
/// Ticket 178 finding 20: `agent`'s registered account `id` as (real folder, label).
pub(crate) fn by_id(home: &Path, agent: Agent, id: &str) -> Result<(PathBuf, String), String> {
    find(home, agent, |e, _| e.id == id)?
        .pop()
        .ok_or_else(|| format!("unknown {} account", agent_name(agent)))
}
/// V2-2b: a stored session's folder (and its account's label), again only while the registry still names it and it
/// is a real folder: a resumed conversation keeps its account.
pub(crate) fn folder_again(
    home: &Path,
    agent: Agent,
    folder: &Path,
) -> Result<(PathBuf, String), String> {
    find(home, agent, |_, f| f == folder)?
        .pop()
        .ok_or_else(|| "this conversation's account is no longer in the account list".to_string())
}
/// `agent`'s accounts that `pick` (entry, folder) keeps, each as (real folder, label) from one registry read.
fn find(
    home: &Path,
    agent: Agent,
    pick: impl Fn(&Entry, &Path) -> bool,
) -> Result<Vec<(PathBuf, String)>, String> {
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    let entries = {
        let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
        load(&home)?
    };
    entries
        .iter()
        .filter(|e| e.agent == agent && pick(e, &account_folder(&home, agent, &e.id)))
        .map(|e| real_folder(&home, agent, &e.id, false).map(|folder| (folder, e.label.clone())))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignedIn {
    Yes,
    No,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub agent: Agent,
    pub id: String,
    pub label: String,
    pub folder: PathBuf,
    pub signed_in: SignedIn,
    pub default: bool,
    /// The owner picked this account for new sessions of its agent (`settings.json` `features` `accounts.default.<agent>`).
    #[serde(default)]
    pub session_default: bool,
    /// Ticket 358: on "Your own" when the picked default's account is gone and new sessions fell back here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fell_back: bool,
    /// Ticket 323: the plan word from the status command of a signed-in Claude account (`max`); absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Ticket 423 round 2: an `account_check` reply whose check is still queued for a probe slot (`signed_in` unknown):
    /// the page shows Checking and asks again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub checking: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u64,
    #[serde(default)]
    accounts: Vec<Entry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    agent: Agent,
    id: String,
    label: String,
}

/// The id of each agent's "Your own" row; `new_id` never makes it.
pub const OWN: &str = "own";
/// Owner 11-16: the name that row shows until the owner renames it.
pub const OWN_LABEL: &str = "Default";
const VERSION: u64 = 1;
const NAME: &str = "accounts.toml";
// Bounds the probe threads one list starts and the file one read takes.
const MAX_ACCOUNTS: usize = 64;
const MAX_FILE: u64 = 1 << 20;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Runs of the status command one probe may make: the second only when the first gave no answer (`probe_runs`).
const PROBE_RUNS: usize = 2;
/// At most this many status commands run at once in this core, across every list, check, window and CLI call
/// (each Claude status run is a full Node start).
const PROBES_AT_ONCE: usize = 8;
static PROBES: ProbeQueue = ProbeQueue::new();
/// "Your own" is probed only when the owner asks, at most once a minute per agent: the status command writes into the
/// owner's live config, which the owner's own sessions write too.
const OWN_CHECK_EVERY: Duration = Duration::from_secs(60);
/// A status answer: the signed-in word and, for Claude, the plan word.
type Answer = (SignedIn, Option<String>);
/// Round 3: one "Your own" check's answer, shared with the callers that joined it. Only that check completes it, so a
/// joiner gets that check's answer whatever happens to the cache meanwhile. Ticket 423: it also records when the check
/// got its probe slot, so a busy probe queue alone never reads as "Couldn't check" (see `wait`).
#[derive(Default)]
struct Completion {
    /// When the check got its probe slot, and its answer once it landed.
    /// Ticket 431: the landed answer is None when the check gave up its place in the probe queue (`OWN_JOIN_BOUND`).
    state: Mutex<(Option<Instant>, Option<Option<Answer>>)>,
    changed: Condvar,
}
impl Completion {
    fn update(&self, change: impl FnOnce(&mut (Option<Instant>, Option<Option<Answer>>))) {
        change(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()));
        self.changed.notify_all();
    }
    fn slotted(&self) {
        self.update(|s| s.0 = Some(Instant::now()));
    }
    fn complete(&self, answer: Option<Answer>) {
        self.update(|s| s.1 = Some(answer));
    }
    /// Waits at most `bound` from this call. The check's answer when it landed; else unknown when the check has held its
    /// probe slot for `bound` (it is overdue), and None ("still checking") when it has no slot yet or got it less than
    /// `bound` ago (ticket 423 round 2: a busy queue, not a failed check; the caller's thread is freed all the same).
    fn wait(&self, bound: Duration) -> Option<Answer> {
        let until = Instant::now() + bound;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(landed) = state.1.as_ref() {
                return landed.clone();
            }
            let now = Instant::now();
            let left = until.saturating_duration_since(now);
            if left.is_zero() {
                let overdue = state.0.is_some_and(|slotted| now - slotted >= bound);
                return overdue.then_some((SignedIn::Unknown, None));
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}
/// An agent's last "Your own" check: when it started, its answer (unknown while it runs) and, while it runs, the
/// completion its joiners wait on.
#[derive(Clone)]
struct OwnEntry {
    at: Instant,
    state: SignedIn,
    plan: Option<String>,
    running: Option<Arc<Completion>>,
}
/// Each agent's last "Your own" check.
struct OwnCache {
    entries: Mutex<[Option<OwnEntry>; 2]>,
}
impl OwnCache {
    const fn new() -> Self {
        OwnCache {
            entries: Mutex::new([None, None]),
        }
    }
}
static OWN_CHECKS: OwnCache = OwnCache::new();
/// How long a caller waits for a check in flight, its whole thread hold: that check's own bound once it holds its probe
/// slot, two runs of the limit, plus a margin (over the 2 s kill grace of each run, `process::output`).
const OWN_JOIN_BOUND: Duration =
    Duration::from_secs(PROBE_TIMEOUT.as_secs() * PROBE_RUNS as u64 + 5);
/// One registry writer at a time (read, change, atomic replace).
static WRITE: Mutex<()> = Mutex::new(());
/// V2-2d: removed account folders wait here (`accounts/.trash/<id>-<unix seconds>/`) this long, for manual recovery.
const TRASH: &str = ".trash";
const TRASH_KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Owner and window only: `check_agent` refuses both requests to session callers before this runs, unlocked.
pub(crate) fn handle(
    home: &Path,
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    request: Request,
) -> Response {
    // Canonical, so a folder path is the one `prepare` resolves for the login tab.
    let home = &fs::canonicalize(home).map_err(|e| e.to_string())?;
    match request {
        request @ (Request::AccountList | Request::AccountCheck { .. }) => {
            probe_reply(home, request)
        }
        Request::AccountAdd { agent, label } => {
            let account = add(home, agent, &label)?;
            match login(registry, stopping, &account) {
                Ok(session) => Ok(Reply::AccountAdded { account, session }),
                Err(e) => {
                    if let Err(undo) = forget(home, &account) {
                        eprintln!("account add rollback failed: {undo}");
                    }
                    Err(e)
                }
            }
        }
        Request::AccountRename { agent, id, label } => {
            rename(home, registry, agent, &id, &label).map(|()| Reply::Ack)
        }
        Request::AccountRemove {
            agent,
            id,
            step,
            leftovers,
        } => remove(home, registry, stopping, agent, &id, step, leftovers),
        _ => Err("not an account request".into()),
    }
}

/// The list and check replies; they need no session registry, so the window runs them off its frame loop.
pub(crate) fn probe_reply(home: &Path, request: Request) -> Response {
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    match request {
        Request::AccountList => list(&home).map(|accounts| Reply::Accounts { accounts }),
        Request::AccountCheck { agent, force } => Ok(Reply::AccountChecked {
            account: check_own(&home, agent, force),
        }),
        _ => Err("not an account request".into()),
    }
}

/// Each agent's "Your own" row (its last owner-started check, else unknown; never probed here), then its accounts in
/// registry order, each probed (at most two 5 s runs each, under the core-wide probe cap).
pub fn list(home: &Path) -> Result<Vec<Account>, String> {
    // Under the writer lock: a load may set a file of another version aside, which two loads must not race.
    let entries = {
        let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
        load(home)?
    };
    let mut rows = vec![];
    for agent in [Agent::Claude, Agent::Codex] {
        let (state, plan) =
            own_checked(agent).map_or((SignedIn::Unknown, None), |e| (e.state, e.plan));
        rows.push(own_row(home, agent, state, plan));
        rows.extend(
            entries
                .iter()
                .filter(|e| e.agent == agent)
                .map(|e| Account {
                    agent,
                    id: e.id.clone(),
                    label: e.label.clone(),
                    folder: account_folder(home, agent, &e.id),
                    signed_in: SignedIn::Unknown,
                    default: false,
                    session_default: false,
                    fell_back: false,
                    checking: false,
                    plan: None,
                }),
        );
    }
    let states: Vec<Option<(SignedIn, Option<String>)>> = std::thread::scope(|scope| {
        let probes: Vec<_> = rows
            .iter()
            .map(|row| {
                scope.spawn(move || {
                    if row.default {
                        None
                    } else if real_folder(home, row.agent, &row.id, false).is_ok() {
                        probe_status(row.agent, Some(&row.folder), &|| (), None)
                    } else {
                        // A link or a missing folder is never handed to the agent.
                        Some((SignedIn::Unknown, None))
                    }
                })
            })
            .collect();
        probes
            .into_iter()
            .map(|p| p.join().unwrap_or(Some((SignedIn::Unknown, None))))
            .collect()
    });
    for (row, state) in rows.iter_mut().zip(states) {
        if let Some((state, plan)) = state {
            row.signed_in = state;
            row.plan = plan;
        }
    }
    let picked = session_defaults(home);
    for row in &mut rows {
        row.session_default = picked[row.agent as usize].as_deref() == Some(row.id.as_str());
    }
    // Ticket 358: a pick whose account is gone falls back to "Your own", visibly, rather than to a guess.
    for agent in [Agent::Claude, Agent::Codex] {
        let orphan = picked[agent as usize].is_some()
            && !rows.iter().any(|r| r.agent == agent && r.session_default);
        if let Some(own) = rows
            .iter_mut()
            .find(|r| orphan && r.agent == agent && r.default)
        {
            own.session_default = true;
            own.fell_back = true;
        }
    }
    Ok(rows)
}

/// `settings.json` `features` as stored; anything unreadable reads as none.
/// Ticket 435: a FIFO or other non-regular `settings.json` is refused at once (`read_regular`).
fn features(home: &Path) -> serde_json::Value {
    store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .map(|v| v["features"].clone())
        .unwrap_or_default()
}

/// Each agent's picked account id, written only through the owner's `quit_settings`. An id no row has marks nothing.
fn session_defaults(home: &Path) -> [Option<String>; 2] {
    let features = features(home);
    [Agent::Claude, Agent::Codex].map(|agent| {
        let key = format!("accounts.default.{}", agent_name(agent));
        features[key.as_str()].as_str().map(str::to_string)
    })
}

fn own_label_key(agent: Agent) -> String {
    format!("accounts.own_label.{}", agent_name(agent))
}
/// Owner 11-16: the name of `agent`'s "Your own" row: the owner's (`settings.json` `features`
/// `accounts.own_label.<agent>`), else `OWN_LABEL`. A stored value that is no account name reads as none.
pub(crate) fn own_label(home: &Path, agent: Agent) -> String {
    features(home)[own_label_key(agent).as_str()]
        .as_str()
        .filter(|l| check_label(l).is_ok())
        .unwrap_or(OWN_LABEL)
        .to_string()
}
/// Owner 11-16: a new name for `agent`'s "Your own" row. Only the settings file is written: no folder, no session
/// and nothing in the agent's own config. An empty name (or `OWN_LABEL`) removes the stored one.
fn rename_own(
    home: &Path,
    registry: &Mutex<Sessions>,
    agent: Agent,
    label: &str,
) -> Result<(), String> {
    let label = label.trim();
    let value = if label.is_empty() || label == OWN_LABEL {
        serde_json::Value::Null
    } else {
        check_label(label)?;
        label.into()
    };
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    if load(home)?
        .iter()
        .any(|e| e.agent == agent && e.label == label)
    {
        return Err(format!(
            "a {} account named {label:?} already exists",
            agent_name(agent)
        ));
    }
    sessions
        .quit_settings(crate::api::LifetimePatch {
            features: Some([(own_label_key(agent), value)].into()),
            ..Default::default()
        })
        .map(|_| ())
}

fn own_checked(agent: Agent) -> Option<OwnEntry> {
    OWN_CHECKS.entries.lock().ok()?[agent as usize].clone()
}

/// The owner's "Check" on a "Your own" row: probes once, unless a check of this agent ended in the last minute, whose
/// result is returned instead. `force` (the owner pressed Check) skips that minute. Accounts probe 11-10 round 2: a check
/// still running is joined, forced or not, and the caller gets that check's answer, never the "unknown" stored while it
/// runs; round 3: it waits on that check alone, at most `OWN_JOIN_BOUND`. Ticket 423 round 2: when that check is still
/// queued for its probe slot then, the row is unknown with `checking` set, and the page asks again (ownCheck.ts).
fn check_own(home: &Path, agent: Agent, force: bool) -> Account {
    let answer = own_check(
        &OWN_CHECKS,
        agent as usize,
        force,
        OWN_JOIN_BOUND,
        // Ticket 431: the initiating check waits for its probe slot at most the joiners' bound too.
        |slotted| probe_status(agent, None, slotted, Some(OWN_JOIN_BOUND)),
    );
    let checking = answer.is_none();
    let (state, plan) = answer.unwrap_or((SignedIn::Unknown, None));
    Account {
        checking,
        ..own_row(home, agent, state, plan)
    }
}

/// Round 3: the check behind `check_own`, with its cache, wait bound and probe passed in. A caller that finds a check of
/// this agent running joins it, forced or not: it holds a handle to that check's completion, lets go of the cache and
/// waits on that completion only, at most `bound`, and gets None ("still checking") or unknown past it as
/// `Completion::wait` says (the probe calls its argument once it holds its slot); a joiner stores nothing. Otherwise a check
/// that ended within the minute answers, unless `force`. Else this caller runs the check: its guard completes its own
/// completion (on a panic too, with unknown) and writes the cache only if the entry still holds that completion, so an
/// older check never finishes a newer one, and a sign-in or sign-out tab that cleared the entry stays cleared. Ticket 431:
/// a probe that gave up waiting for its slot (None) stores nothing and answers its caller and joiners None.
fn own_check(
    cache: &OwnCache,
    i: usize,
    force: bool,
    bound: Duration,
    probe: impl FnOnce(&dyn Fn()) -> Option<Answer>,
) -> Option<Answer> {
    let mut entries = cache.entries.lock().unwrap_or_else(|e| e.into_inner());
    match &entries[i] {
        Some(OwnEntry {
            running: Some(check),
            ..
        }) => {
            let check = Arc::clone(check);
            drop(entries);
            return check.wait(bound);
        }
        Some(entry) if !force && entry.at.elapsed() < OWN_CHECK_EVERY => {
            return Some((entry.state, entry.plan.clone()));
        }
        _ => {}
    }
    let mine = Arc::new(Completion::default());
    entries[i] = Some(OwnEntry {
        at: Instant::now(),
        state: SignedIn::Unknown,
        plan: None,
        running: Some(Arc::clone(&mine)),
    });
    drop(entries);
    struct Land<'a> {
        cache: &'a OwnCache,
        i: usize,
        mine: Arc<Completion>,
        /// None while the probe runs (still None on a panic); Some(None) when it gave up its place in the queue.
        answer: Option<Option<Answer>>,
    }
    impl Drop for Land<'_> {
        fn drop(&mut self) {
            let answer = self.answer.take();
            {
                let mut entries = self.cache.entries.lock().unwrap_or_else(|e| e.into_inner());
                let current = matches!(&entries[self.i], Some(OwnEntry { running: Some(c), .. }) if Arc::ptr_eq(c, &self.mine));
                if current {
                    match &answer {
                        Some(Some((state, plan))) => {
                            if let Some(entry) = entries[self.i].as_mut() {
                                (entry.state, entry.plan, entry.running) =
                                    (*state, plan.clone(), None);
                            }
                        }
                        // The probe panicked or gave up its queue place: nothing is stored, so the next caller checks again.
                        _ => entries[self.i] = None,
                    }
                }
            }
            self.mine
                .complete(answer.unwrap_or(Some((SignedIn::Unknown, None))));
        }
    }
    let mut land = Land {
        cache,
        i,
        mine,
        answer: None,
    };
    let answer = probe(&|| land.mine.slotted());
    land.answer = Some(answer.clone());
    drop(land);
    answer
}

fn own_row(home: &Path, agent: Agent, signed_in: SignedIn, plan: Option<String>) -> Account {
    Account {
        agent,
        id: OWN.into(),
        label: own_label(home, agent),
        folder: own_folder(agent).unwrap_or_default(),
        signed_in,
        default: true,
        session_default: false,
        fell_back: false,
        checking: false,
        plan,
    }
}

fn add(home: &Path, agent: Agent, label: &str) -> Result<Account, String> {
    check_label(label)?;
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    let mut entries = load(home)?;
    if entries.len() >= MAX_ACCOUNTS {
        return Err(format!("at most {MAX_ACCOUNTS} accounts"));
    }
    let id = store::new_id()?;
    let folder = real_folder(home, agent, &id, true)?;
    entries.push(Entry {
        agent,
        id: id.clone(),
        label: label.into(),
    });
    if let Err(e) = save(home, entries) {
        let _ = fs::remove_dir(&folder);
        return Err(e);
    }
    Ok(Account {
        agent,
        id,
        label: label.into(),
        folder,
        // A folder made a moment ago holds no login.
        signed_in: SignedIn::No,
        default: false,
        session_default: false,
        fell_back: false,
        checking: false,
        plan: None,
    })
}

/// Ticket 358: a new name for `agent`'s account `id`; its id and folder stay, so a default (stored by id) and a resume
/// (by folder) are untouched. Takes the session lock before the writer lock, as a remove does, so no start records the
/// old name in between. Both saves land or the old name stays everywhere.
fn rename(
    home: &Path,
    registry: &Mutex<Sessions>,
    agent: Agent,
    id: &str,
    label: &str,
) -> Result<(), String> {
    if id == OWN {
        return rename_own(home, registry, agent, label);
    }
    if !store::valid_id(id) {
        return Err("invalid account id".into());
    }
    let label = label.trim();
    check_label(label)?;
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    let before = load(home)?;
    // Two accounts of an agent under one name would break `folder_by_label`.
    if before
        .iter()
        .any(|e| e.agent == agent && e.id != id && e.label == label)
    {
        return Err(format!(
            "a {} account named {label:?} already exists",
            agent_name(agent)
        ));
    }
    let mut entries = before.clone();
    let entry = entries
        .iter_mut()
        .find(|e| e.agent == agent && e.id == id)
        .ok_or_else(|| format!("unknown {} account", agent_name(agent)))?;
    let folder = account_folder(home, agent, id);
    if entry.label == label {
        // Nothing for the registry, but a session a crash left on an earlier name still takes this one.
        return sessions.account_renamed(&folder, label, label);
    }
    let old = std::mem::replace(&mut entry.label, label.into());
    save(home, entries)?;
    if let Err(e) = sessions.account_renamed(&folder, &old, label) {
        let undo = save(home, before);
        if undo.is_err() {
            // The registry kept the new name, so the sessions in memory go with it; the next load settles the file.
            sessions.account_relabel(&folder, label);
        }
        return Err(rename_failed(e, undo, label));
    }
    Ok(())
}

/// What the owner is told when the session store refused a rename, and whether the registry went back.
fn rename_failed(e: String, undo: Result<(), String>, label: &str) -> String {
    match undo {
        Ok(()) => e,
        Err(undo) => format!(
            "{e}; putting the old name back also failed ({undo}), so the account list keeps the new name {label:?}"
        ),
    }
}

/// Ticket 178 finding 20: a new, empty account folder for a browser sign-in, not yet in the registry (no session can
/// start on it, the list does not show it). `enroll` registers it once signed in; `discard` deletes it otherwise.
/// `pending` counts the new accounts other sign-ins may still register, so together they never pass the cap.
pub(crate) fn fresh(
    home: &Path,
    agent: Agent,
    label: &str,
    pending: usize,
) -> Result<(String, PathBuf), String> {
    check_label(label)?;
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    if load(home)?.len() + pending >= MAX_ACCOUNTS {
        return Err(format!("at most {MAX_ACCOUNTS} accounts"));
    }
    let id = store::new_id()?;
    let folder = real_folder(home, agent, &id, true)?;
    Ok((id, folder))
}
/// Registers a `fresh` folder under `label`.
pub(crate) fn enroll(
    home: &Path,
    agent: Agent,
    id: &str,
    label: &str,
    signed_in: SignedIn,
) -> Result<Account, String> {
    let folder = real_folder(home, agent, id, false)?;
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    let mut entries = load(home)?;
    if entries.len() >= MAX_ACCOUNTS {
        return Err(format!("at most {MAX_ACCOUNTS} accounts"));
    }
    entries.push(Entry {
        agent,
        id: id.into(),
        label: label.into(),
    });
    save(home, entries)?;
    Ok(Account {
        agent,
        id: id.into(),
        label: label.into(),
        folder,
        signed_in,
        default: false,
        session_default: false,
        fell_back: false,
        checking: false,
        plan: None,
    })
}
/// Deletes a `fresh` folder that never signed in, by directory fds without following links; a registered account's
/// folder is never deleted here.
pub(crate) fn discard(home: &Path, agent: Agent, id: &str) -> Result<(), String> {
    if !store::valid_id(id) || id == OWN {
        return Err("invalid account id".into());
    }
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    if load(home)?.iter().any(|e| e.agent == agent && e.id == id) {
        return Err("a registered account folder is never discarded".into());
    }
    let accounts =
        open_dir(open_home(home)?.as_raw_fd(), &cstr("accounts")?).map_err(folder_error)?;
    let parent = open_dir(accounts.as_raw_fd(), &cstr(agent_name(agent))?).map_err(folder_error)?;
    remove_tree(&parent, &cstr(id)?)
}

/// Undoes an `add` whose login tab did not start: the entry goes, the folder only while still empty.
fn forget(home: &Path, account: &Account) -> Result<(), String> {
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    let mut entries = load(home)?;
    entries.retain(|e| !(e.agent == account.agent && e.id == account.id));
    save(home, entries)?;
    let _ = fs::remove_dir(&account.folder);
    Ok(())
}

/// The visible login tab: a shell session running the agent's own fixed login words in the account folder, with
/// only that folder as its config override. The label names the tab; it never reaches the argv or the env.
fn login(
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    account: &Account,
) -> Result<Session, String> {
    let args = match account.agent {
        Agent::Claude => ["claude", "auth", "login"].as_slice(),
        Agent::Codex => ["codex", "login"].as_slice(),
    };
    let args = args.iter().map(|a| a.to_string()).collect();
    let label = format!("Login: {}", account.label);
    tab(
        registry,
        stopping,
        account.agent,
        &account.folder,
        label,
        args,
        false,
        |_| Ok(()),
        // Ticket 32: signed in again, so no earlier logout tab keeps agents off the folder.
        |sessions, _| {
            sessions.logout_clear(&account.folder);
        },
    )
}

/// A visible shell tab running `args` in account folder `folder`, with only that folder as its config override (`own`:
/// none, so "Your own" keeps its stored-login name, as `probe` does). `check`
/// and `started` run on the same registry guard that starts the tab, so nothing they guard can be recorded in between.
#[allow(clippy::too_many_arguments)]
fn tab(
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    agent: Agent,
    folder: &Path,
    label: String,
    args: Vec<String>,
    own: bool,
    check: impl FnOnce(&Sessions) -> Result<(), String>,
    started: impl FnOnce(&mut Sessions, &Session),
) -> Result<Session, String> {
    let start = StartSession {
        account: None,
        kind: AgentKind::Shell,
        project: folder.to_path_buf(),
        worktree: false,
        label,
        args,
        model: None,
        effort: None,
        resume: None,
    };
    let launch = {
        let sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        if own {
            sessions.launch(start)
        } else {
            sessions.launch_account(start, variable(agent), folder.to_path_buf())
        }
    };
    // Ticket 322: set here, never from a request, so a tab an agent starts cannot pass for an account tab.
    let mut launch = launch.with_account_tab().prepare()?;
    let result = {
        let mut sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        if stopping.is_some_and(|s| s.load(Ordering::SeqCst)) {
            Err("core is stopping".into())
        } else {
            check(&sessions)
                .and_then(|()| sessions.start(&launch))
                .inspect(|tab| started(&mut sessions, tab))
        }
    };
    if result.is_ok() {
        launch.committed = true;
    }
    result
}

pub(crate) fn check_label(label: &str) -> Result<(), String> {
    let chars = label.chars().count();
    if label.trim().is_empty()
        || chars > 64
        || label.len() > 192
        // Letters, marks, numbers, punctuation, symbols and spaces only: no control, format (bidi), private-use or
        // unassigned character.
        || !label.chars().all(crate::delivery::shown)
    {
        return Err(
            "account name must be 1-64 visible characters (192 bytes), spaces allowed".into(),
        );
    }
    Ok(())
}

/// V2-2c: the registered (agent, id) pairs, read as `list` reads them (writer lock, every refusal of `load`); no
/// account folder is touched.
pub(crate) fn registered(home: &Path) -> Result<Vec<(Agent, String)>, String> {
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    Ok(load(home)?.into_iter().map(|e| (e.agent, e.id)).collect())
}

fn load(home: &Path) -> Result<Vec<Entry>, String> {
    let path = home.join(NAME);
    // Never through a link; non-blocking so a FIFO planted at the name cannot hold the open.
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path);
    let mut file = match file {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err(format!("{NAME} must not be a symlink"));
        }
        Err(e) => return Err(format!("{NAME}: {e}")),
    };
    let judged = file.metadata().map_err(|e| e.to_string())?;
    if !judged.is_file() {
        return Err(format!("{NAME} is not a regular file"));
    }
    let mut text = String::new();
    (&mut file)
        .take(MAX_FILE + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("invalid {NAME}: {e}"))?;
    if text.len() as u64 > MAX_FILE {
        return Err(format!("invalid {NAME}: larger than 1 MiB"));
    }
    let table: toml::Table = toml::from_str(&text).map_err(|e| format!("invalid {NAME}: {e}"))?;
    // Another integer version is a newer (or older) core's file: kept aside, never rewritten by this one.
    if let Some(version) = table.get("version").and_then(toml::Value::as_integer)
        && version != VERSION as i64
    {
        let version = u64::try_from(version).map_err(|_| format!("invalid {NAME}: version"))?;
        store::set_aside(&path, &judged, version)?;
        return Ok(vec![]);
    }
    let registry: Registry = toml::Value::Table(table)
        .try_into()
        .map_err(|e| format!("invalid {NAME}: {e}"))?;
    let mut seen = HashSet::new();
    if registry.accounts.len() > MAX_ACCOUNTS
        || !registry.accounts.iter().all(|e| {
            store::valid_id(&e.id)
                && e.id != OWN
                && check_label(&e.label).is_ok()
                && seen.insert((e.agent, e.id.clone()))
        })
    {
        return Err(format!("invalid {NAME}: account entry"));
    }
    Ok(registry.accounts)
}

fn save(home: &Path, accounts: Vec<Entry>) -> Result<(), String> {
    let text = toml::to_string(&Registry {
        version: VERSION,
        accounts,
    })
    .map_err(|e| e.to_string())?;
    // A temporary file renamed over the name: a link there is replaced, never written through.
    store::atomic_write(&home.join(NAME), text.as_bytes())
}

fn account_folder(home: &Path, agent: Agent, id: &str) -> PathBuf {
    home.join("accounts").join(agent_name(agent)).join(id)
}

/// `accounts/<agent>/<id>` under `home` when each part is a real folder, never a link. With `create`, missing
/// parts are made 0700 and the account folder itself must be new.
pub(crate) fn real_folder(
    home: &Path,
    agent: Agent,
    id: &str,
    create: bool,
) -> Result<PathBuf, String> {
    if !store::valid_id(id) || id == OWN {
        return Err("invalid account id".into());
    }
    let mut dir = open_home(home)?;
    let parts = [("accounts", false), (agent_name(agent), false), (id, true)];
    for (part, last) in parts {
        let name = cstr(part)?;
        if create && unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            let e = std::io::Error::last_os_error();
            if last || e.raw_os_error() != Some(libc::EEXIST) {
                return Err(format!("account folder: {e}"));
            }
        }
        dir = open_dir(dir.as_raw_fd(), &name).map_err(folder_error)?;
        if create && unsafe { libc::fchmod(dir.as_raw_fd(), 0o700) } != 0 {
            return Err(format!(
                "account folder: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(account_folder(home, agent, id))
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|e| e.to_string())
}
/// The real folder `name` in directory `at`, never through a link (`ELOOP`) or a non-folder (`ENOTDIR`).
fn open_dir(at: libc::c_int, name: &CStr) -> std::io::Result<OwnedFd> {
    let flags =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(at, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn open_home(home: &Path) -> Result<OwnedFd, String> {
    let home = CString::new(home.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    open_dir(libc::AT_FDCWD, &home).map_err(folder_error)
}
fn folder_error(e: std::io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::ELOOP) | Some(libc::ENOTDIR) => {
            "account folder must be a real folder, not a link".to_string()
        }
        _ => format!("account folder: {e}"),
    }
}
fn stat_at(at: libc::c_int, name: &CStr) -> std::io::Result<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(at, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(st)
}
fn rename_at(from: &OwnedFd, old: &CStr, to: &OwnedFd, new: &CStr) -> std::io::Result<()> {
    let r = unsafe { libc::renameat(from.as_raw_fd(), old.as_ptr(), to.as_raw_fd(), new.as_ptr()) };
    if r != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// V2-2d: one step of removing `agent`'s account `id` (owner and window only; never "Your own"). Every step first finds
/// the account through the registry as a real folder and refuses while a session is live or resumable on it.
fn remove(
    home: &Path,
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    agent: Agent,
    id: &str,
    step: RemoveStep,
    leftovers: bool,
) -> Response {
    if id == OWN {
        return match step {
            RemoveStep::Logout | RemoveStep::Login => {
                own_tab(home, registry, stopping, agent, step)
            }
            _ => Err("the built-in account is the agent's own config and is never removed".into()),
        };
    }
    if !store::valid_id(id) {
        return Err("invalid account id".into());
    }
    let (folder, label) = find(home, agent, |e, _| e.id == id)?
        .pop()
        .ok_or_else(|| format!("unknown {} account", agent_name(agent)))?;
    let in_use = |sessions: &Sessions| {
        // Ticket 178 finding 20: a browser sign-in running on the folder is not a session, but it writes there too.
        if crate::account_signin::busy(&folder) {
            return Err(format!(
                "account {label:?} is signing in; cancel the sign-in first"
            ));
        }
        let (blocking, others) = sessions.account_users(&folder);
        if blocking.is_empty() {
            return Ok(others);
        }
        let names: Vec<String> = blocking.iter().map(|l| format!("{l:?}")).collect();
        Err(format!(
            "account {label:?} is in use by {}; close them first",
            names.join(", ")
        ))
    };
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    match step {
        RemoveStep::Login => Err("only the agent's own account signs in through this step".into()),
        RemoveStep::Check => {
            // Ticket 322: also for a second window with a stale list, where the card still offers Remove.
            if session_defaults(home)[agent as usize].as_deref() == Some(id) {
                return Err(format!(
                    "account {label:?} is the default for new sessions; pick another default first"
                ));
            }
            let sessions = in_use(&*lock()?)?;
            // Every remove starts here: a logout status from an earlier attempt (since signed in again) never counts.
            status(home, agent, id, false)?;
            Ok(Reply::AccountRemoveCheck { sessions })
        }
        RemoveStep::Logout => {
            in_use(&*lock()?)?;
            // An exit status from an earlier attempt never counts for this one.
            status(home, agent, id, false)?;
            let words = match agent {
                Agent::Claude => ["claude", "auth", "logout"].as_slice(),
                Agent::Codex => ["codex", "logout"].as_slice(),
            };
            // The agent's own logout, then its exit status into a new file the move reads (`set -C`: never written
            // through a planted name). The path is passed as an argument, never spliced into the script.
            let script = r#"f=$1; shift; "$@"; s=$?; set -C; printf '%s\n' "$s" > "$f"; exit "$s""#;
            let mut args = vec![
                "/bin/sh".to_string(),
                "-c".into(),
                script.into(),
                "sh".into(),
            ];
            args.push(status_path(home, agent, id).display().to_string());
            args.extend(words.iter().map(|w| w.to_string()));
            let session = tab(
                registry,
                stopping,
                agent,
                &folder,
                format!("Logout: {label}"),
                args,
                false,
                // Again on the guard that starts the tab: a session started since the check above is never logged out.
                |sessions| in_use(sessions).map(|_| ()),
                // Ticket 32: from here no agent starts on the folder (`Sessions::start`) while this tab is listed.
                |sessions, tab| {
                    sessions.logout_mark(&folder, &tab.id);
                },
            )?;
            Ok(Reply::AccountLogout { session })
        }
        RemoveStep::Move => {
            // Under the session lock to the end: no session starts on the folder between the check and the move.
            let mut sessions = lock()?;
            if stopping.is_some_and(|s| s.load(Ordering::SeqCst)) {
                return Err("core is stopping".into());
            }
            in_use(&sessions)?;
            let code = status(home, agent, id, true)?;
            if code != Some(0) && !leftovers {
                return Ok(Reply::AccountLeftovers { code });
            }
            let now = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();
            let trash = to_trash(home, agent, id, now, || {})?;
            if let Err(e) = status(home, agent, id, false) {
                eprintln!("account remove: {e}");
            }
            sessions.logout_clear(&folder);
            drop(sessions);
            Ok(Reply::AccountRemoved { trash })
        }
    }
}

/// Sign out of or in to "Your own": the agent's own command in a visible tab. Nothing moves, and no mark or status file
/// is kept. The last check is dropped, so the row stops showing the old state and the next Check really probes.
fn own_tab(
    home: &Path,
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    agent: Agent,
    step: RemoveStep,
) -> Response {
    let folder = own_folder(agent).ok_or("no config folder for the agent's own account")?;
    let login = matches!(step, RemoveStep::Login);
    // Ticket 509: a new user who never ran the agent has no config folder yet, and the tab runs inside it. The login
    // makes it (as the agent does on its first run): only the last part, owner-only, only when nothing is there.
    let made = login && make_own_folder(&folder)?;
    let words = match (login, agent) {
        (false, Agent::Claude) => ["claude", "auth", "logout"].as_slice(),
        (false, Agent::Codex) => ["codex", "logout"].as_slice(),
        (true, Agent::Claude) => ["claude", "auth", "login"].as_slice(),
        (true, Agent::Codex) => ["codex", "login"].as_slice(),
    };
    let label = format!(
        "{}: {}",
        if login { "Login" } else { "Logout" },
        own_label(home, agent)
    );
    let session = tab(
        registry,
        stopping,
        agent,
        &folder,
        label,
        words.iter().map(|w| w.to_string()).collect(),
        true,
        |_| Ok(()),
        |_, _| {},
    )
    .inspect_err(|_| {
        if made {
            let _ = fs::remove_dir(&folder); // still empty: the tab never started
        }
    })?;
    if let Ok(mut checks) = OWN_CHECKS.entries.lock() {
        checks[agent as usize] = None;
    }
    Ok(Reply::AccountLogout { session })
}

/// Makes "Your own"'s missing config folder, mode 0700, with its parent as it is; true when it was made here. A folder,
/// file or link already at that path is left as it is (and the tab start then reports what is wrong with it). A relative
/// path (a variable set without shell expansion, such as a literal `~`) is never made: it would land in the core's
/// working folder, and a folder named `~` there invites `rm -rf ~`.
fn make_own_folder(folder: &Path) -> Result<bool, String> {
    if !folder.is_absolute() {
        return Ok(false);
    }
    match fs::symlink_metadata(folder) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Ok(false),
    }
    match fs::DirBuilder::new().mode(0o700).create(folder) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(format!("could not make {}: {e}", folder.display())),
    }
}

/// Where the logout tab leaves its exit status: beside the account folder, under a name no id can have.
fn status_path(home: &Path, agent: Agent, id: &str) -> PathBuf {
    home.join("accounts")
        .join(agent_name(agent))
        .join(format!(".logout-{id}"))
}
/// With `read`, the logout's exit status (none when it never finished); otherwise the status file is deleted. Through
/// the real folders only, never a link.
fn status(home: &Path, agent: Agent, id: &str, read: bool) -> Result<Option<i32>, String> {
    let accounts =
        open_dir(open_home(home)?.as_raw_fd(), &cstr("accounts")?).map_err(folder_error)?;
    let parent = open_dir(accounts.as_raw_fd(), &cstr(agent_name(agent))?).map_err(folder_error)?;
    let name = cstr(&format!(".logout-{id}"))?;
    if !read {
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("logout status: {e}"));
            }
        }
        return Ok(None);
    }
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Ok(None);
    }
    let file = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Ok(None);
    }
    let mut text = String::new();
    let _ = file.take(16).read_to_string(&mut text);
    Ok(text.trim().parse().ok())
}

/// Moves `agent`'s account `id` to `accounts/.trash/<id>-<now>/` and drops it from the registry, by directory fds
/// opened without following links. `between` runs after the folder is opened and before the move (a test seam). The
/// moved entry is checked to be the folder that was opened; anything else swapped in goes back and nothing is removed.
fn to_trash(
    home: &Path,
    agent: Agent,
    id: &str,
    now: u64,
    between: impl FnOnce(),
) -> Result<PathBuf, String> {
    if !store::valid_id(id) || id == OWN {
        return Err("invalid account id".into());
    }
    let _write = WRITE.lock().map_err(|_| "account registry unavailable")?;
    let mut entries = load(home)?;
    let before = entries.len();
    entries.retain(|e| !(e.agent == agent && e.id == id));
    if entries.len() == before {
        return Err(format!("unknown {} account", agent_name(agent)));
    }
    let accounts =
        open_dir(open_home(home)?.as_raw_fd(), &cstr("accounts")?).map_err(folder_error)?;
    let parent = open_dir(accounts.as_raw_fd(), &cstr(agent_name(agent))?).map_err(folder_error)?;
    let source = cstr(id)?;
    let opened = open_dir(parent.as_raw_fd(), &source).map_err(folder_error)?;
    let judged = fs::File::from(opened)
        .metadata()
        .map_err(|e| e.to_string())?;
    let trash_name = cstr(TRASH)?;
    if unsafe { libc::mkdirat(accounts.as_raw_fd(), trash_name.as_ptr(), 0o700) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EEXIST) {
            return Err(format!("account trash: {e}"));
        }
    }
    let trash = open_dir(accounts.as_raw_fd(), &trash_name).map_err(folder_error)?;
    let name = format!("{id}-{now}");
    let target = cstr(&name)?;
    between();
    rename_at(&parent, &source, &trash, &target).map_err(|e| format!("account remove: {e}"))?;
    use std::os::unix::fs::MetadataExt;
    let same = stat_at(trash.as_raw_fd(), &target).is_ok_and(|st| {
        (st.st_mode & libc::S_IFMT) == libc::S_IFDIR
            && st.st_dev as u64 == judged.dev()
            && st.st_ino == judged.ino()
    });
    let back = || {
        if let Err(e) = rename_at(&trash, &target, &parent, &source) {
            eprintln!("account remove: could not put {name} back: {e}");
        }
    };
    if !same {
        back();
        return Err("account folder changed during the remove; nothing was removed".into());
    }
    if let Err(e) = save(home, entries) {
        back();
        return Err(e);
    }
    Ok(home.join("accounts").join(TRASH).join(name))
}

/// V2-2d, at core start: deletes each `accounts/.trash/<id>-<unix seconds>` folder older than 7 days at `now`. Only
/// direct children whose name the core makes are looked at; a link or file there is left alone, and the delete
/// follows no link inside (a link is removed itself).
pub fn sweep(home: &Path, now: SystemTime) -> Result<(), String> {
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    let missing = |e: &std::io::Error| e.kind() == std::io::ErrorKind::NotFound;
    let accounts = match open_dir(open_home(&home)?.as_raw_fd(), &cstr("accounts")?) {
        Err(e) if missing(&e) => return Ok(()),
        other => other.map_err(folder_error)?,
    };
    let trash = match open_dir(accounts.as_raw_fd(), &cstr(TRASH)?) {
        Err(e) if missing(&e) => return Ok(()),
        other => other.map_err(folder_error)?,
    };
    let now = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    for name in names(&trash)? {
        let Some((id, ts)) = name.to_str().ok().and_then(|n| n.rsplit_once('-')) else {
            continue;
        };
        let Some(ts) = ts
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| ts.parse::<u64>().ok())
            .flatten()
        else {
            continue;
        };
        if !store::valid_id(id) || now.saturating_sub(ts) <= TRASH_KEEP.as_secs() {
            continue;
        }
        if !stat_at(trash.as_raw_fd(), &name)
            .is_ok_and(|st| (st.st_mode & libc::S_IFMT) == libc::S_IFDIR)
        {
            continue;
        }
        if let Err(e) = remove_tree(&trash, &name) {
            eprintln!("account trash {name:?}: {e}");
        }
    }
    Ok(())
}
/// The entry names in directory `dir` (not `.` and `..`).
fn names(dir: &OwnedFd) -> Result<Vec<CString>, String> {
    let fd = unsafe { libc::dup(dir.as_raw_fd()) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let e = std::io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(e.to_string());
    }
    let mut out = vec![];
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            out.push(name.to_owned());
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(out)
}
/// The deepest folder nesting the sweep deletes; it holds one directory fd per level.
const TRASH_DEPTH: usize = 64;
/// Deletes `name` in `parent` and, when it is a real folder, everything in it, by directory fds; a link anywhere is
/// unlinked itself, never followed. Iterative, with a depth cap checked by a first pass that deletes nothing, so a
/// tree too deep is refused whole and left in place (no stack overflow, at most `TRASH_DEPTH` fds open).
fn remove_tree(parent: &OwnedFd, name: &CStr) -> Result<(), String> {
    walk(parent, name, false)?;
    walk(parent, name, true)
}
fn walk(parent: &OwnedFd, name: &CStr, delete: bool) -> Result<(), String> {
    let unlink = |at: &OwnedFd, name: &CStr, flags: libc::c_int| {
        if !delete || unsafe { libc::unlinkat(at.as_raw_fd(), name.as_ptr(), flags) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    };
    let not_dir =
        |e: &std::io::Error| matches!(e.raw_os_error(), Some(libc::ELOOP) | Some(libc::ENOTDIR));
    let root = match open_dir(parent.as_raw_fd(), name) {
        Ok(dir) => dir,
        Err(e) if not_dir(&e) => return unlink(parent, name, 0),
        Err(e) => return Err(e.to_string()),
    };
    // Each level: its fd, the children still to visit, and its own name in the level above.
    let mut stack = vec![(names(&root)?, root, name.to_owned())];
    while let Some((children, dir, _)) = stack.last_mut() {
        let Some(child) = children.pop() else {
            let (_, _, own) = stack.pop().unwrap_or_else(|| unreachable!());
            let above = stack.last().map_or(parent, |(_, d, _)| d);
            unlink(above, &own, libc::AT_REMOVEDIR)?;
            continue;
        };
        match open_dir(dir.as_raw_fd(), &child) {
            Ok(sub) => {
                if stack.len() >= TRASH_DEPTH {
                    return Err(format!("deeper than {TRASH_DEPTH} folders; left in place"));
                }
                stack.push((names(&sub)?, sub, child));
            }
            Err(e) if not_dir(&e) => unlink(dir, &child, 0)?,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Where "Your own" sessions of `agent` keep their config: the core's own variable, else the agent's default.
fn own_folder(agent: Agent) -> Option<PathBuf> {
    std::env::var_os(variable(agent))
        .map(PathBuf::from)
        .or_else(|| {
            let home = PathBuf::from(std::env::var_os("HOME")?);
            Some(home.join(match agent {
                Agent::Claude => ".claude",
                Agent::Codex => ".codex",
            }))
        })
}

/// The agent's own status command (`claude auth status --json`, `codex login status`) with PATH, USER and the account's
/// override only ("Your own": PATH, USER, HOME and the core's own variable, as its sessions get). Its output is parsed to
/// the signed-in word and, for Claude, the plan word (ticket 323); the rest, email and org included, is dropped.
pub(crate) fn probe(agent: Agent, folder: Option<&Path>) -> SignedIn {
    probe_status(agent, folder, &|| (), None).map_or(SignedIn::Unknown, |a| a.0)
}

/// `slotted` is called once the probe holds its slot, before the first run (ticket 423). Ticket 431: with `wait`, None
/// when no slot came within it (the probe never ran); without, it waits its turn as long as it takes and is never None.
fn probe_status(
    agent: Agent,
    folder: Option<&Path>,
    slotted: &dyn Fn(),
    wait: Option<Duration>,
) -> Option<Answer> {
    let _slot = PROBES.take(wait)?;
    slotted();
    Some(probe_runs(agent, PROBE_TIMEOUT, || {
        probe_command(agent, folder, |key| std::env::var_os(key))
    }))
}
/// The status command, its program found on the PATH the probe gets (ticket 424: started by posix_spawn, not a fork).
fn probe_command(
    agent: Agent,
    folder: Option<&Path>,
    core: impl Fn(&str) -> Option<OsString>,
) -> Command {
    let env = probe_env(agent, folder, core);
    let program =
        crate::process::resolve_program(agent_name(agent), crate::process::env_path(&env));
    let mut command = crate::process::command(program);
    // argv[0] stays the bare name the child saw before.
    std::os::unix::process::CommandExt::arg0(&mut command, agent_name(agent));
    command
        .args(match agent {
            Agent::Claude => ["auth", "status", "--json"].as_slice(),
            Agent::Codex => ["login", "status"].as_slice(),
        })
        .env_clear()
        .stdin(Stdio::null());
    command.envs(env);
    command
}

/// Runs the status command `command` builds, each run under `limit`, and parses its answer. Accounts probe 11-10: a run
/// that gave no answer (it did not start, did not end inside `limit`, or was killed before it printed anything: a busy
/// machine) is run once more, so one probe is at most `PROBE_RUNS` runs and about `PROBE_RUNS * limit` long. Any answer,
/// signed out or printed before a kill included, is kept as it is.
fn probe_runs(
    agent: Agent,
    limit: Duration,
    command: impl Fn() -> Command,
) -> (SignedIn, Option<String>) {
    for _ in 0..PROBE_RUNS {
        if let Ok(out) = crate::process::output(command(), limit)
            // Round 2: killed by a signal before it printed anything is no answer either (seen under load), so it is
            // run once more too; a run that printed before it was killed is kept as it is.
            && (out.status.code().is_some() || !out.stdout.is_empty() || !out.stderr.is_empty())
        {
            let state = parse_status(agent, out.status.code(), &out.stdout, &out.stderr);
            let plan = (state == SignedIn::Yes)
                .then(|| parse_plan(agent, &out.stdout))
                .flatten();
            return (state, plan);
        }
    }
    (SignedIn::Unknown, None)
}

/// Ticket 323: `subscriptionType` from Claude's status JSON, only as a plain word, so a changed field can never carry
/// an email or an org name to the page. Codex has no such field in what it prints.
pub fn parse_plan(agent: Agent, stdout: &[u8]) -> Option<String> {
    if agent != Agent::Claude {
        return None;
    }
    let status = serde_json::from_slice::<serde_json::Value>(stdout).ok()?;
    let plan = status.get("subscriptionType")?.as_str()?;
    let word = !plan.is_empty()
        && plan.len() <= 32
        && plan
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    word.then(|| plan.to_string())
}

/// The environment a probe gets (the command is cleared first): PATH and USER, then the account's folder, or for "Your
/// own" HOME and the core's own variables. Claude Code 2.1.311 derives its stored-login name from its SECURESTORAGE
/// variable, so "Your own" Claude passes the core's too; an account folder never inherits it. `core` reads the core's env.
/// Ticket 449: Claude Code 2.1.322 finds its stored login by USER, as its login (which has the core's USER) saved it;
/// without USER a signed-in folder answers `loggedIn: false`, and a new account was thrown away right after its sign-in.
/// The Codex reset reader (`codex_reset`) builds its `codex app-server` env here too, so it gets USER as well.
pub(crate) fn probe_env(
    agent: Agent,
    folder: Option<&Path>,
    core: impl Fn(&str) -> Option<OsString>,
) -> Vec<(&'static str, OsString)> {
    let mut env: Vec<(&'static str, OsString)> = ["PATH", "USER"]
        .into_iter()
        .filter_map(|key| core(key).map(|v| (key, v)))
        .collect();
    match folder {
        Some(folder) => env.push((variable(agent), folder.as_os_str().to_owned())),
        None => {
            let secure = (agent == Agent::Claude).then_some("CLAUDE_SECURESTORAGE_CONFIG_DIR");
            for key in ["HOME", variable(agent)].into_iter().chain(secure) {
                env.extend(core(key).map(|v| (key, v)));
            }
        }
    }
    env
}

/// Ticket 431: the PROBES_AT_ONCE places, served in arrival order: a waiter takes a free place only when it is first in
/// line, so a later ask never overtakes an earlier one.
struct ProbeQueue {
    /// Places held, the waiters' turn numbers in arrival order, and the next turn number.
    state: Mutex<(usize, VecDeque<u64>, u64)>,
    changed: Condvar,
}
impl ProbeQueue {
    const fn new() -> Self {
        ProbeQueue {
            state: Mutex::new((0, VecDeque::new(), 0)),
            changed: Condvar::new(),
        }
    }
    /// Waits its turn for a place, at most `wait` when given: None then, having left the line.
    fn take(&self, wait: Option<Duration>) -> Option<ProbeSlot<'_>> {
        let until = wait.map(|w| Instant::now() + w);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let me = state.2;
        state.2 += 1;
        state.1.push_back(me);
        while state.0 >= PROBES_AT_ONCE || state.1.front() != Some(&me) {
            let left = until.map(|u| u.saturating_duration_since(Instant::now()));
            if left.is_some_and(|l| l.is_zero()) {
                state.1.retain(|&t| t != me);
                self.changed.notify_all(); // the waiter behind may be first now
                return None;
            }
            state = match left {
                Some(left) => {
                    self.changed
                        .wait_timeout(state, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => self.changed.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
        state.1.pop_front();
        state.0 += 1;
        self.changed.notify_all(); // the next in line may take another free place
        Some(ProbeSlot(self))
    }
}
/// One of a queue's places; freed on drop, so a panicking probe frees it too.
struct ProbeSlot<'a>(&'a ProbeQueue);
impl Drop for ProbeSlot<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner()).0 -= 1;
        self.0.changed.notify_all();
    }
}

/// Recorded shapes (tests/fixtures/accounts): Claude Code 2.1.311 prints JSON with `loggedIn` (exit 0 when true,
/// 1 when false); codex-cli 0.161.0 prints `Logged in using ...` (exit 0) or `Not logged in` (exit 1) on stderr.
/// Anything else, including an exit that disagrees with the text, is unknown.
pub fn parse_status(agent: Agent, code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> SignedIn {
    match agent {
        Agent::Claude => {
            let logged = serde_json::from_slice::<serde_json::Value>(stdout)
                .ok()
                .and_then(|v| v.get("loggedIn")?.as_bool());
            match (code, logged) {
                (Some(0), Some(true)) => SignedIn::Yes,
                (Some(1), Some(false)) => SignedIn::No,
                _ => SignedIn::Unknown,
            }
        }
        Agent::Codex => {
            let text = String::from_utf8_lossy(stderr);
            let line = text.lines().next().unwrap_or("").trim();
            match code {
                Some(0) if line.starts_with("Logged in") => SignedIn::Yes,
                Some(1) if line == "Not logged in" => SignedIn::No,
                _ => SignedIn::Unknown,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // V2-2a r2: the cap holds across callers: many threads asking at once never run more than PROBES_AT_ONCE.
    #[test]
    fn probe_cap_is_global() {
        use std::sync::atomic::AtomicUsize;
        static NOW: AtomicUsize = AtomicUsize::new(0);
        static MOST: AtomicUsize = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..40 {
                scope.spawn(|| {
                    let _slot = PROBES.take(None).unwrap();
                    let n = NOW.fetch_add(1, Ordering::SeqCst) + 1;
                    MOST.fetch_max(n, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(20));
                    NOW.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        let most = MOST.load(Ordering::SeqCst);
        assert!(most > 1 && most <= PROBES_AT_ONCE, "{most}");
        assert_eq!(PROBES.state.lock().unwrap().0, 0);
    }
    /// Ticket 424: the probe runs `claude` by its absolute path on the probe's own PATH (posix_spawn, not a fork of
    /// the core), with the same arguments and environment.
    #[test]
    fn probe_command_runs_an_absolute_program() {
        use std::{ffi::OsStr, os::unix::fs::PermissionsExt};
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("probe-command-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("claude"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(dir.join("claude"), fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths(["/nonexistent-424".as_ref(), dir.as_path()]).unwrap();
        let core = |key: &str| (key == "PATH").then(|| path.clone());
        let command = probe_command(Agent::Claude, Some(Path::new("/acct")), core);
        assert_eq!(command.get_program(), dir.join("claude").as_os_str());
        assert!(Path::new(command.get_program()).is_absolute());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["auth", "status", "--json"]);
        // Round 2: argv[0] is still the bare name (std has no getter; its Debug prints `[program] "argv0" args`).
        let shown = format!("{command:?}");
        let argv = format!(
            "[{:?}] \"claude\" \"auth\" \"status\" \"--json\"",
            dir.join("claude")
        );
        assert!(shown.ends_with(&argv), "{shown}");
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("PATH"), Some(path.as_os_str()))));
        assert!(envs.contains(&(OsStr::new("CLAUDE_CONFIG_DIR"), Some(OsStr::new("/acct")))));
        assert_eq!(envs.len(), 2);
        // Not on that PATH: the bare name, so the run fails as it did before.
        let none = probe_command(Agent::Codex, None, |key| {
            (key == "PATH").then(|| "/nonexistent-424".into())
        });
        assert_eq!(none.get_program(), "codex");
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn own_probe_passes_securestorage_dir() {
        let core = |key: &str| match key {
            "PATH" => Some("/bin".into()),
            "HOME" => Some("/h".into()),
            "CLAUDE_SECURESTORAGE_CONFIG_DIR" => Some("/x".into()),
            _ => None,
        };
        let has = |env: &[(&str, OsString)], key: &str| env.iter().any(|(k, _)| *k == key);
        let own = probe_env(Agent::Claude, None, core);
        assert!(own.contains(&("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/x".into())));
        assert!(has(&own, "HOME") && has(&own, "PATH"));
        let account = probe_env(Agent::Claude, Some(Path::new("/acct")), core);
        assert!(!has(&account, "CLAUDE_SECURESTORAGE_CONFIG_DIR"));
        assert!(account.contains(&("CLAUDE_CONFIG_DIR", "/acct".into())));
        let codex = probe_env(Agent::Codex, None, core);
        assert!(!has(&codex, "CLAUDE_SECURESTORAGE_CONFIG_DIR"));
        assert!(!has(
            &probe_env(Agent::Codex, Some(Path::new("/c")), core),
            "CLAUDE_SECURESTORAGE_CONFIG_DIR"
        ));
    }
    // Ticket 449: every probe names the user as the login did, so the agent finds the login it stored.
    #[test]
    fn probe_passes_the_cores_user() {
        let core = |key: &str| match key {
            "PATH" => Some("/bin".into()),
            "USER" => Some("me".into()),
            _ => None,
        };
        for agent in [Agent::Claude, Agent::Codex] {
            for folder in [None, Some(Path::new("/acct"))] {
                assert!(probe_env(agent, folder, core).contains(&("USER", "me".into())));
            }
        }
        // A core with no USER adds none: the login had none either.
        let none = probe_env(Agent::Claude, Some(Path::new("/acct")), |_: &str| None);
        assert!(none.iter().all(|(k, _)| *k != "USER"));
    }
    // V2-2b: what a core started from a session drops is what a launch on an account clears.
    #[test]
    fn config_env_is_in_the_launch_list() {
        assert!(
            CONFIG_ENV
                .iter()
                .all(|k| crate::sessions::ACCOUNT_ENV.contains(k))
        );
    }
    // V2-2d threat 2 (TOCTOU): a link or another folder swapped in after the account folder was opened, before the
    // move, is put back and nothing is removed: the link's target is never entered or moved, the registry keeps the
    // account. Without a swap the same call moves the folder.
    #[test]
    fn to_trash_refuses_a_folder_swapped_after_open() {
        use std::os::unix::fs::symlink;
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("acct-swap-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        let home = fs::canonicalize(&home).unwrap();
        let account = add(&home, Agent::Claude, "work").unwrap();
        let outside = home.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("file"), "precious").unwrap();
        let aside = home.join("aside");
        let swaps: [&dyn Fn(); 2] = [&|| symlink(&outside, &account.folder).unwrap(), &|| {
            fs::create_dir(&account.folder).unwrap()
        }];
        for swap in swaps {
            let err = to_trash(&home, Agent::Claude, &account.id, 7, || {
                fs::rename(&account.folder, &aside).unwrap();
                swap();
            })
            .unwrap_err();
            assert!(err.contains("changed"), "{err}");
            assert_eq!(
                fs::read_to_string(outside.join("file")).unwrap(),
                "precious"
            );
            assert_eq!(
                fs::read_dir(home.join("accounts/.trash")).unwrap().count(),
                0
            );
            assert_eq!(registered(&home).unwrap().len(), 1);
            // Put the real folder back for the next round.
            let m = fs::symlink_metadata(&account.folder).unwrap();
            if m.is_dir() {
                fs::remove_dir(&account.folder).unwrap();
            } else {
                fs::remove_file(&account.folder).unwrap();
            }
            fs::rename(&aside, &account.folder).unwrap();
        }
        let moved = to_trash(&home, Agent::Claude, &account.id, 7, || {}).unwrap();
        assert_eq!(
            moved,
            home.join(format!("accounts/.trash/{}-7", account.id))
        );
        assert!(moved.is_dir() && !account.folder.exists());
        assert!(registered(&home).unwrap().is_empty());
        fs::remove_dir_all(&home).unwrap();
    }
    /// A fake `codex login status` in a fresh folder: it counts its runs in `runs` (`$n` is this run's number), then
    /// follows `script`.
    fn fake_status(name: &str, script: &str) -> (PathBuf, PathBuf) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("probe-{name}-{}", store::new_id().unwrap()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(&dir).unwrap();
        let program = dir.join("codex");
        let runs = dir.join("runs");
        fs::write(
            &program,
            format!(
                "#!/bin/sh\necho run >> '{0}'\nn=$(wc -l < '{0}')\n{script}\n",
                runs.display()
            ),
        )
        .unwrap();
        fs::set_permissions(
            &program,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        (dir, program)
    }
    fn runs(dir: &Path) -> usize {
        fs::read_to_string(dir.join("runs")).map_or(0, |s| s.lines().count())
    }
    /// For runs that never answer: short, so two of them stay quick.
    const LIMIT: Duration = Duration::from_millis(400);
    /// For runs that must answer: seconds, so a slow machine still answers inside it (round 2: 400 ms flaked under load).
    const ANSWER_LIMIT: Duration = Duration::from_secs(4);
    // Accounts probe 11-10: a status run that timed out is run once more, under the same limit, and its answer kept. The
    // first run sleeps far past the limit; the counter file makes the second answer at once.
    #[test]
    fn probe_retries_once_after_a_timeout() {
        let (dir, program) = fake_status(
            "slow-once",
            "[ \"$n\" -le 1 ] && exec sleep 60\necho 'Logged in using ChatGPT' >&2; exit 0",
        );
        let started = Instant::now();
        let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || Command::new(&program));
        let took = started.elapsed();
        assert_eq!(state, SignedIn::Yes);
        assert_eq!(runs(&dir), 2);
        // The first run used its whole limit; the second did not need another.
        assert!(took >= ANSWER_LIMIT && took < ANSWER_LIMIT * 2, "{took:?}");
        fs::remove_dir_all(&dir).unwrap();
    }
    // A run that never started is run once more too.
    #[test]
    fn probe_retries_once_after_a_start_failure() {
        let (dir, program) = fake_status("start", "echo 'Not logged in' >&2; exit 1");
        let tries = std::cell::Cell::new(0);
        let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || {
            tries.set(tries.get() + 1);
            Command::new(if tries.get() == 1 {
                dir.join("missing")
            } else {
                program.clone()
            })
        });
        assert_eq!(state, SignedIn::No);
        assert_eq!((tries.get(), runs(&dir)), (2, 1));
        fs::remove_dir_all(&dir).unwrap();
    }
    // Two timeouts: unknown, after two runs, inside two limits plus the time to stop each run.
    #[test]
    fn probe_gives_up_after_two_timeouts() {
        let (dir, program) = fake_status("slow", "exec sleep 5");
        let started = Instant::now();
        let (state, plan) = probe_runs(Agent::Codex, LIMIT, || Command::new(&program));
        let took = started.elapsed();
        assert_eq!((state, plan), (SignedIn::Unknown, None));
        assert_eq!(runs(&dir), 2);
        // The upper bound only says "it does not wait out the 5 s sleep twice": 30 s, because under a full parallel
        // test run stopping the two children took more than 5 s once (gate run 11-17; `runs == 2` is the real check).
        assert!(
            took >= LIMIT * 2 && took < LIMIT * 2 + Duration::from_secs(30),
            "{took:?}"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
    // An answer is never asked again: signed out, a garbled answer, a run killed by a signal after it printed: one run each.
    #[test]
    fn probe_keeps_any_answer_after_one_run() {
        for (name, script, want) in [
            ("out", "echo 'Not logged in' >&2; exit 1", SignedIn::No),
            ("odd", "echo 'what' >&2; exit 3", SignedIn::Unknown),
            (
                "killed-late",
                "echo 'Not logged in' >&2; kill -9 $$",
                SignedIn::Unknown,
            ),
        ] {
            let (dir, program) = fake_status(name, script);
            let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || Command::new(&program));
            assert_eq!((name, state, runs(&dir)), (name, want, 1));
            fs::remove_dir_all(&dir).unwrap();
        }
    }
    // Round 2 (captured under load: a status run killed by SIGKILL before it printed anything): a run killed before any
    // output gave no answer, like one that timed out, so it is run once more; killed twice is unknown after two runs.
    #[test]
    fn probe_retries_once_after_a_silent_kill() {
        for (name, script, want) in [
            (
                "killed-once",
                "[ \"$n\" -le 1 ] && kill -9 $$\necho 'Logged in using ChatGPT' >&2; exit 0",
                SignedIn::Yes,
            ),
            ("killed-twice", "kill -9 $$", SignedIn::Unknown),
        ] {
            let (dir, program) = fake_status(name, script);
            let (state, _) = probe_runs(Agent::Codex, ANSWER_LIMIT, || Command::new(&program));
            assert_eq!((name, state, runs(&dir)), (name, want, 2));
            fs::remove_dir_all(&dir).unwrap();
        }
    }
    /// Round 3: a fake "Your own" probe the test drives: it says when it started, then answers what the test sends.
    #[allow(clippy::type_complexity)] // a test helper's three-part handle
    fn driven(
        runs: &std::sync::atomic::AtomicUsize,
    ) -> (
        std::sync::mpsc::Sender<Answer>,
        std::sync::mpsc::Receiver<()>,
        impl FnOnce(&dyn Fn()) -> Option<Answer> + Send + '_,
    ) {
        let (answer, answers) = std::sync::mpsc::channel::<Answer>();
        let (started, starts) = std::sync::mpsc::channel();
        // Holds its probe slot at once (ticket 423: a joiner's bound counts from there).
        let probe = move |slotted: &dyn Fn()| {
            slotted();
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            started.send(()).unwrap();
            Some(answers.recv().unwrap_or((SignedIn::Unknown, None)))
        };
        (answer, starts, probe)
    }
    fn own_running(e: &OwnEntry) -> bool {
        e.running.is_some()
    }
    fn own_state(e: &OwnEntry) -> SignedIn {
        e.state
    }
    /// `n` callers hold the running check's completion besides the cache and the check itself.
    fn joined(cache: &OwnCache, n: usize) -> bool {
        matches!(&cache.entries.lock().unwrap()[0], Some(OwnEntry { running: Some(c), .. }) if Arc::strong_count(c) == 2 + n)
    }
    fn running(cache: &OwnCache) -> bool {
        matches!(&cache.entries.lock().unwrap()[0], Some(e) if own_running(e))
    }
    fn stored(cache: &OwnCache) -> Option<SignedIn> {
        cache.entries.lock().unwrap()[0].as_ref().map(own_state)
    }
    const BOUND: Duration = Duration::from_secs(10);
    // Round 3, finding 2: A runs; a sign-in tab clears the entry; B starts a replacement; A finishes. A's answer must not
    // finish B: B is still running, a caller that arrives joins B (no new probe) and gets B's answer, which the cache
    // keeps.
    #[test]
    fn own_old_check_never_finishes_a_newer_one() {
        let cache = OwnCache::new();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(|| own_check(&cache, 0, false, BOUND, a));
            a_started.recv().unwrap();
            cache.entries.lock().unwrap()[0] = None; // as `own_tab` does
            let (to_b, b_started, b) = driven(&runs);
            let b = s.spawn(|| own_check(&cache, 0, false, BOUND, b));
            b_started.recv().unwrap();
            to_a.send((SignedIn::Yes, None)).unwrap();
            assert_eq!(a.join().unwrap().unwrap().0, SignedIn::Yes);
            assert!(running(&cache), "A's answer finished B's check");
            let (_to_c, _c_started, c) = driven(&runs);
            let c = s.spawn(|| own_check(&cache, 0, true, BOUND, c));
            while !joined(&cache, 1) {
                std::thread::yield_now();
            }
            to_b.send((SignedIn::No, None)).unwrap();
            assert_eq!(b.join().unwrap().unwrap().0, SignedIn::No);
            assert_eq!(c.join().unwrap().unwrap().0, SignedIn::No);
        });
        assert_eq!(runs.into_inner(), 2);
        assert_eq!(stored(&cache), Some(SignedIn::No));
        assert!(!running(&cache));
    }
    // Round 3, finding 1: B joined A; A finishes; a forced C then starts a new check. B returns A's answer at once and
    // never follows C.
    #[test]
    fn own_joiner_takes_its_own_check_answer() {
        let cache = OwnCache::new();
        let cache = &cache;
        let runs = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
            a_started.recv().unwrap();
            let (b_done, b_answer) = std::sync::mpsc::channel();
            s.spawn(move || {
                b_done
                    .send(own_check(cache, 0, false, BOUND, |_| {
                        unreachable!("a joiner runs no probe")
                    }))
                    .unwrap()
            });
            while !joined(cache, 1) {
                std::thread::yield_now();
            }
            to_a.send((SignedIn::Yes, Some("max".into()))).unwrap();
            assert_eq!(a.join().unwrap().unwrap().0, SignedIn::Yes);
            let (to_c, c_started, c) = driven(&runs);
            let c = s.spawn(|| own_check(cache, 0, true, BOUND, c));
            c_started.recv().unwrap();
            assert!(running(cache));
            // C still runs: B must already have A's answer.
            let got = b_answer
                .recv_timeout(Duration::from_secs(5))
                .expect("B followed C");
            assert_eq!(got, Some((SignedIn::Yes, Some("max".into()))));
            to_c.send((SignedIn::No, None)).unwrap();
            assert_eq!(c.join().unwrap().unwrap().0, SignedIn::No);
        });
        assert_eq!(runs.into_inner(), 2);
        assert_eq!(stored(cache), Some(SignedIn::No));
    }
    // Round 3: a check that panics wakes its joiners with unknown and stores nothing; one whose probe gave no answer
    // stores that unknown (the real "Couldn't check"), never a false yes or no.
    #[test]
    fn own_failed_check_wakes_its_joiners() {
        let cache = OwnCache::new();
        let cache = &cache;
        let runs = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(move || {
                own_check(cache, 0, false, BOUND, |slotted| {
                    let _ = a(slotted);
                    panic!("probe panicked")
                })
            });
            a_started.recv().unwrap();
            let b = s.spawn(|| own_check(cache, 0, false, BOUND, |_| unreachable!()));
            while !joined(cache, 1) {
                std::thread::yield_now();
            }
            to_a.send((SignedIn::Yes, None)).unwrap();
            assert!(a.join().is_err());
            assert_eq!(b.join().unwrap(), Some((SignedIn::Unknown, None)));
        });
        assert_eq!(stored(cache), None);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
            a_started.recv().unwrap();
            let b = s.spawn(|| own_check(cache, 0, false, BOUND, |_| unreachable!()));
            while !joined(cache, 1) {
                std::thread::yield_now();
            }
            to_a.send((SignedIn::Unknown, None)).unwrap();
            assert_eq!(a.join().unwrap(), Some((SignedIn::Unknown, None)));
            assert_eq!(b.join().unwrap(), Some((SignedIn::Unknown, None)));
        });
        assert_eq!(stored(cache), Some(SignedIn::Unknown));
        assert!(!running(cache));
    }
    // Round 3: a joiner waits at most its bound for a check that never lands, then answers unknown and stores nothing.
    #[test]
    fn own_joiner_is_released_at_its_bound() {
        let cache = OwnCache::new();
        let cache = &cache;
        let runs = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
            a_started.recv().unwrap();
            let started = Instant::now();
            let bound = Duration::from_millis(300);
            let got = own_check(cache, 0, true, bound, |_| unreachable!());
            let took = started.elapsed();
            // The check held its slot for the whole bound (it slotted before the join): overdue, so unknown.
            assert_eq!(got, Some((SignedIn::Unknown, None)));
            assert!(
                took >= bound && took < bound + Duration::from_secs(5),
                "{took:?}"
            );
            assert!(running(cache), "the joiner stored something");
            to_a.send((SignedIn::Yes, None)).unwrap();
            a.join().unwrap();
        });
        assert_eq!(stored(cache), Some(SignedIn::Yes));
    }
    // Round 3: joiners start no process: five callers, forced or not, during one check share its one probe.
    #[test]
    fn own_joiners_start_no_probe() {
        let cache = OwnCache::new();
        let cache = &cache;
        let runs = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(|| own_check(cache, 0, false, BOUND, a));
            a_started.recv().unwrap();
            let joiners: Vec<_> = (0..5)
                .map(|n| {
                    s.spawn(move || own_check(cache, 0, n % 2 == 0, BOUND, |_| unreachable!()))
                })
                .collect();
            while !joined(cache, 5) {
                std::thread::yield_now();
            }
            to_a.send((SignedIn::No, None)).unwrap();
            assert_eq!(a.join().unwrap().unwrap().0, SignedIn::No);
            for j in joiners {
                assert_eq!(j.join().unwrap().unwrap().0, SignedIn::No);
            }
        });
        assert_eq!(runs.into_inner(), 1);
    }
    // Ticket 423 round 2: with the real probe queue held full past four bounds, every ask that joins the queued check is
    // released at its bound with "still checking" (None), never unknown, and stores nothing. Once the queue frees, the
    // check runs once and the next ask gets its real answer. Unknown needs the slot held for a whole bound.
    #[test]
    fn own_joiner_bound_starts_at_the_probe_slot() {
        let cache = OwnCache::new();
        let cache = &cache;
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let full: Vec<_> = (0..PROBES_AT_ONCE)
            .map(|_| PROBES.take(None).unwrap())
            .collect();
        let bound = Duration::from_millis(300);
        std::thread::scope(|s| {
            let (to_a, a_started, a) = driven(&runs);
            let a = s.spawn(move || {
                own_check(cache, 0, false, bound, |slotted| {
                    let _slot = PROBES.take(None).unwrap();
                    a(slotted)
                })
            });
            while !running(cache) {
                std::thread::yield_now();
            }
            for _ in 0..4 {
                let got = own_check(cache, 0, true, bound, |_| unreachable!());
                assert_eq!(got, None, "the queue alone gave an answer");
                assert!(running(cache));
            }
            assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 0);
            drop(full);
            a_started.recv().unwrap();
            to_a.send((SignedIn::Yes, Some("max".into()))).unwrap();
            assert_eq!(a.join().unwrap().unwrap().0, SignedIn::Yes);
            let got = own_check(cache, 0, false, bound, |_| unreachable!());
            assert_eq!(got, Some((SignedIn::Yes, Some("max".into()))));
        });
        assert_eq!(runs.into_inner(), 1);
        assert_eq!(stored(cache), Some(SignedIn::Yes));
    }
    // Ticket 423 round 2: a check that has no slot yet releases its joiner at the bound with "still checking", storing
    // nothing; a later ask, after the check landed, gets the real answer without a new probe.
    #[test]
    fn own_joiner_is_released_still_checking_while_queued() {
        let cache = OwnCache::new();
        let cache = &cache;
        let (free, freed) = std::sync::mpsc::channel::<()>();
        std::thread::scope(|s| {
            let a = s.spawn(move || {
                own_check(cache, 0, false, BOUND, |_| {
                    freed.recv().unwrap(); // never slotted: the queue stays full until then
                    Some((SignedIn::No, None))
                })
            });
            while !running(cache) {
                std::thread::yield_now();
            }
            let bound = Duration::from_millis(300);
            let started = Instant::now();
            let got = own_check(cache, 0, true, bound, |_| unreachable!());
            let took = started.elapsed();
            assert_eq!(got, None);
            assert!(
                took >= bound && took < bound + Duration::from_secs(5),
                "{took:?}"
            );
            assert!(running(cache), "the joiner stored something");
            free.send(()).unwrap();
            assert_eq!(a.join().unwrap().unwrap().0, SignedIn::No);
            let got = own_check(cache, 0, false, bound, |_| unreachable!());
            assert_eq!(got, Some((SignedIn::No, None)));
        });
        assert_eq!(stored(cache), Some(SignedIn::No));
    }
    // Ticket 423 round 2: the thread hold. 31 joiners of one queued check (the local API's other request threads) each
    // return within the bound plus a margin, whatever the queue does.
    #[test]
    fn own_joiners_each_free_their_thread_at_the_bound() {
        let cache = OwnCache::new();
        let cache = &cache;
        let (free, freed) = std::sync::mpsc::channel::<()>();
        let bound = Duration::from_millis(300);
        std::thread::scope(|s| {
            let a = s.spawn(move || {
                own_check(cache, 0, false, BOUND, |_| {
                    freed.recv().unwrap();
                    Some((SignedIn::Yes, None))
                })
            });
            while !running(cache) {
                std::thread::yield_now();
            }
            let joiners: Vec<_> = (0..31)
                .map(|n| {
                    s.spawn(move || {
                        let started = Instant::now();
                        let got = own_check(cache, 0, n % 2 == 0, bound, |_| unreachable!());
                        (got, started.elapsed())
                    })
                })
                .collect();
            for j in joiners {
                let (got, took) = j.join().unwrap();
                assert_eq!(got, None);
                assert!(took < bound + Duration::from_secs(2), "{took:?}");
            }
            free.send(()).unwrap();
            a.join().unwrap();
        });
    }
    // Ticket 435: a FIFO with no writer at `settings.json` is refused at once (a plain read waits for a writer forever),
    // so it marks no session default.
    #[test]
    fn session_defaults_refuse_a_fifo_at_once() {
        let dir = std::env::temp_dir().join(format!("ns-acct-fifo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let fifo = CString::new(
            dir.join("settings.json")
                .into_os_string()
                .into_encoded_bytes(),
        )
        .unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let asked = Instant::now();
        let picked = session_defaults(&dir);
        let took = asked.elapsed();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(picked, [None, None]);
        assert!(took < Duration::from_secs(1), "{took:?}");
    }
    /// Waiters in a queue's line.
    fn in_line(queue: &ProbeQueue) -> usize {
        queue.state.lock().unwrap().1.len()
    }
    // Ticket 431: with every place held, waiters that arrive one after another take the places in arrival order as
    // they free one at a time.
    #[test]
    fn probe_places_go_in_arrival_order() {
        let queue = ProbeQueue::new();
        let queue = &queue;
        let mut full: Vec<_> = (0..PROBES_AT_ONCE)
            .map(|_| queue.take(None).unwrap())
            .collect();
        let order = Mutex::new(Vec::new());
        let order = &order;
        let (hold, held) = std::sync::mpsc::channel::<()>();
        let held = Mutex::new(held);
        let held = &held;
        std::thread::scope(|s| {
            for n in 0..6 {
                s.spawn(move || {
                    let _slot = queue.take(None).unwrap();
                    order.lock().unwrap().push(n);
                    let _ = held.lock().unwrap().recv(); // keeps the place until the test is done
                });
                while in_line(queue) < n + 1 {
                    std::thread::yield_now();
                }
            }
            for n in 1..=6 {
                drop(full.pop());
                while order.lock().unwrap().len() < n {
                    std::thread::yield_now();
                }
            }
            drop(hold);
        });
        assert_eq!(*order.lock().unwrap(), (0..6).collect::<Vec<_>>());
        drop(full);
        assert_eq!(queue.state.lock().unwrap().0, 0);
    }
    // Ticket 431: an initiating wait is bounded: with every place held it leaves the line at its bound, and the waiter
    // behind it is not held up by it (it gets the next free place).
    #[test]
    fn probe_wait_is_bounded_and_leaves_the_line() {
        let queue = ProbeQueue::new();
        let queue = &queue;
        let mut full: Vec<_> = (0..PROBES_AT_ONCE)
            .map(|_| queue.take(None).unwrap())
            .collect();
        let bound = Duration::from_millis(300);
        std::thread::scope(|s| {
            let first = s.spawn(move || {
                let asked = Instant::now();
                (queue.take(Some(bound)).is_some(), asked.elapsed())
            });
            while in_line(queue) < 1 {
                std::thread::yield_now();
            }
            let behind = s.spawn(move || queue.take(None).is_some());
            let (got, took) = first.join().unwrap();
            assert!(!got);
            assert!(
                took >= bound && took < bound + Duration::from_secs(2),
                "{took:?}"
            );
            assert_eq!(in_line(queue), 1, "only the waiter behind is left");
            drop(full.pop());
            assert!(behind.join().unwrap());
        });
        drop(full);
        assert_eq!(
            *queue.state.lock().unwrap(),
            (0, VecDeque::new(), 2 + PROBES_AT_ONCE as u64)
        );
    }
    // Ticket 431: a check that gave up its queue place stores nothing; it and its joiner answer "still checking" (None),
    // and the next ask starts a new check.
    #[test]
    fn own_check_that_gave_up_its_place_stores_nothing() {
        let cache = OwnCache::new();
        let cache = &cache;
        let (go, gone) = std::sync::mpsc::channel::<()>();
        std::thread::scope(|s| {
            let a = s.spawn(move || {
                own_check(cache, 0, false, BOUND, |_| {
                    gone.recv().unwrap();
                    None
                })
            });
            while !running(cache) {
                std::thread::yield_now();
            }
            let b = s.spawn(|| own_check(cache, 0, false, BOUND, |_| unreachable!()));
            while !joined(cache, 1) {
                std::thread::yield_now();
            }
            go.send(()).unwrap();
            assert_eq!(a.join().unwrap(), None);
            assert_eq!(b.join().unwrap(), None);
        });
        assert!(cache.entries.lock().unwrap()[0].is_none());
        let got = own_check(cache, 0, false, BOUND, |_| Some((SignedIn::Yes, None)));
        assert_eq!(got, Some((SignedIn::Yes, None)));
    }
    // Ticket 358: when the rollback fails too, the owner is told the registry kept the new name.
    #[test]
    fn rename_failed_says_when_the_new_name_stayed() {
        assert_eq!(rename_failed("no".into(), Ok(()), "new"), "no");
        let both = rename_failed("no".into(), Err("disk".into()), "new");
        assert!(both.starts_with("no;") && both.contains("disk"), "{both}");
        assert!(both.contains("keeps the new name \"new\""), "{both}");
    }
    #[test]
    fn label_refuses_format_characters() {
        for bad in [
            "a\u{202E}b",
            "a\u{200B}b",
            "\u{2066}x",
            "a\u{FEFF}",
            "a\u{E000}",
            "a\u{2028}b",
            "a\tb",
        ] {
            assert!(check_label(bad).is_err(), "{bad:?}");
        }
        for good in [
            "회사 계정",
            "work (2)",
            "x; touch pwned $(id)",
            "Ünïcödé ✓",
            "-rf --help",
        ] {
            assert!(check_label(good).is_ok(), "{good:?}");
        }
    }
}
