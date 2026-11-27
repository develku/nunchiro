//! V2-8c: PR badge tier 2, live PR status through the user's own `gh` (ADR 0001 "outside services" block). Off until
//! the owner turns it on; then, only while the window is in front, every 60 s, one `gh api graphql` run per repository
//! for the PRs an agent created (tier-1 scan) or the owner pinned. `gh` owns auth and host: Nunchiro reads and stores
//! no token. The argument vector is constants plus validated pieces, no interpreter in between; only an enum state and
//! a URL rebuilt from those pieces reach the window.
use crate::{api::*, chat::pr::PrState, sessions::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::{LazyLock, Mutex, Once},
    thread,
    time::{Duration, Instant},
};

pub const EVERY: Duration = Duration::from_secs(60);
/// A window heartbeat older than this counts as not in front (the window sends one every 30 s while in front).
pub const STALE: Duration = Duration::from_secs(90);
const TIMEOUT: Duration = Duration::from_secs(15);
const TICK: Duration = Duration::from_secs(2);
/// A repository whose `gh` run failed (or found no gh or no login) waits this long before its next try.
pub const BACKOFF: Duration = Duration::from_secs(300);
/// A closed PR can be reopened: it is re-checked this long after it was last seen closed, inside a due poll (so the
/// MAX_REPOS and PER_REPO caps hold). A slow interval rather than "on the next focus", because the heartbeat carries no
/// focus edge and a window kept in front would otherwise never re-check it.
pub const RECHECK_CLOSED: Duration = Duration::from_secs(600);
const GH: &str = "gh";
const HOST: &str = "github.com";
const PULL_HEAD: &str = "https://github.com/";
/// shortcut: PRs past this many per repository are not polled; raise it if someone pins more.
const PER_REPO: usize = 50;
/// Repositories one poll runs `gh` for: 10 a minute is the owner packet's ~600 points an hour.
pub const MAX_REPOS: usize = 10;
/// What the owner may pin in total (stored in settings.json).
pub const MAX_PINNED: usize = 100;
/// Fields asked of each PR; titles and branch names are never asked, so they cannot reach the window.
const FIELDS: &str = "number url state isDraft reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}";
/// The user environment `gh` keeps: PATH to find it, HOME for its config and keychain lookup, GH_CONFIG_DIR when the
/// user moved its config there. Everything else is cleared: tokens (gh's own login is the only auth), DO_NOT_TRACK
/// (telemetry is turned off explicitly instead), GH_HOST (tier-1 links are github.com only, pinned by `--hostname`).
const KEPT: [&str; 3] = ["PATH", "HOME", "GH_CONFIG_DIR"];

/// What the window gets for one PR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Live {
    pub state: PrState,
    /// `https://github.com/<owner>/<repo>/pull/<n>`, rebuilt from validated pieces.
    pub url: String,
}

/// `^[A-Za-z0-9._-]{1,100}$`, not `.`/`..`-shaped and not a leading `-`.
pub(crate) fn piece(s: &str) -> bool {
    (1..=100).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && !s.starts_with('-')
        && !s.contains("..")
        && s != "."
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Pull {
    pub(crate) owner: String,
    pub(crate) repo: String,
    pub(crate) number: u64,
}
impl Pull {
    /// Only the exact `https://github.com/<owner>/<repo>/pull/<n>` shape tier 1 produces.
    pub(crate) fn parse(url: &str) -> Option<Self> {
        let rest = url.strip_prefix(PULL_HEAD)?;
        let [owner, repo, "pull", n] = rest.split('/').collect::<Vec<_>>()[..] else {
            return None;
        };
        let number = n
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| n.parse::<u64>().ok())??;
        (piece(owner) && piece(repo) && number > 0 && n.len() <= 10).then(|| Self {
            owner: owner.into(),
            repo: repo.into(),
            number,
        })
    }
    fn url(&self) -> String {
        format!(
            "{PULL_HEAD}{}/{}/pull/{}",
            self.owner, self.repo, self.number
        )
    }
}

/// `true` when `url` is a link `Poller` would accept; the window's watch op is refused otherwise.
pub fn valid_url(url: &str) -> bool {
    Pull::parse(url).is_some()
}

/// The `gh` arguments for one repository: constants, the validated pieces as `-f` (raw string, never `@file`)
/// variables and the PR numbers as integers in the query.
pub fn argv(owner: &str, repo: &str, numbers: &[u64]) -> Result<Vec<String>, String> {
    if !piece(owner) || !piece(repo) {
        return Err("invalid repository".into());
    }
    if numbers.is_empty() || numbers.contains(&0) {
        return Err("no pull request numbers".into());
    }
    let pulls: Vec<String> = numbers
        .iter()
        .map(|n| format!("p{n}:pullRequest(number:{n}){{{FIELDS}}}"))
        .collect();
    let query = format!(
        "query=query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{}}}}}",
        pulls.join(" ")
    );
    Ok([
        "api",
        "graphql",
        "--hostname",
        HOST,
        "-f",
        &query,
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={repo}"),
    ]
    .map(String::from)
    .to_vec())
}

/// `gh`'s stdout for `argv(owner, repo, numbers)`: one `Live` per PR whose fields are all known values and whose URL
/// matches its piece; anything else is dropped. Not JSON, cut at the output cap, or no `repository`: an error.
pub fn parse(owner: &str, repo: &str, numbers: &[u64], stdout: &[u8]) -> Result<Vec<Live>, String> {
    if stdout.len() >= crate::process::OUTPUT_CAP {
        return Err("gh output too large".into());
    }
    let v: Value = serde_json::from_slice(stdout).map_err(|_| "gh output is not JSON")?;
    let repository = v["data"]["repository"]
        .as_object()
        .ok_or("gh output has no repository")?;
    Ok(numbers
        .iter()
        .filter_map(|&n| {
            let p = repository.get(&format!("p{n}"))?;
            let url = Pull {
                owner: owner.into(),
                repo: repo.into(),
                number: n,
            }
            .url();
            let same =
                p["number"].as_u64() == Some(n) && p["url"].as_str()?.eq_ignore_ascii_case(&url);
            let draft = p["isDraft"].as_bool()?;
            let review = match &p["reviewDecision"] {
                Value::Null => None,
                Value::String(s)
                    if ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]
                        .contains(&s.as_str()) =>
                {
                    Some(s.as_str())
                }
                _ => return None,
            };
            let checks = match &p["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] {
                Value::Null => None,
                Value::String(s)
                    if ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]
                        .contains(&s.as_str()) =>
                {
                    Some(s.as_str())
                }
                _ => return None,
            };
            // The order tier 1 reads a `gh pr view` in (chat::pr::state_of).
            let state = match p["state"].as_str()? {
                "MERGED" => PrState::Merged,
                "CLOSED" => PrState::Closed,
                "OPEN" if draft => PrState::Draft,
                "OPEN" if review == Some("APPROVED") => PrState::Approved,
                "OPEN" if matches!(checks, Some("FAILURE" | "ERROR")) => PrState::ChecksFail,
                "OPEN" if checks == Some("SUCCESS") => PrState::ChecksPass,
                "OPEN" => PrState::Open,
                _ => return None,
            };
            same.then_some(Live { state, url })
        })
        .collect())
}

enum Outcome {
    Live(Vec<Live>),
    /// No live status at all; the text is the Settings hint.
    Hint(String),
    /// Logged; the last values stay.
    Failed(String),
}

struct Batch {
    owner: String,
    repo: String,
    numbers: Vec<u64>,
}
impl Batch {
    fn urls(&self) -> impl Iterator<Item = String> + '_ {
        self.numbers.iter().map(|&number| {
            Pull {
                owner: self.owner.clone(),
                repo: self.repo.clone(),
                number,
            }
            .url()
        })
    }
    fn run(&self, env: &[(OsString, OsString)]) -> Outcome {
        let args = match argv(&self.owner, &self.repo, &self.numbers) {
            Ok(a) => a,
            Err(e) => return Outcome::Failed(e),
        };
        let out = match gh_output(env, &args, TIMEOUT) {
            Ok(out) => out,
            Err(e) if e.contains("os error 2") => {
                return Outcome::Hint(
                    "gh was not found on PATH; live PR status needs the GitHub CLI.".into(),
                );
            }
            Err(e) => return Outcome::Failed(e),
        };
        // A partial answer (one PR not found) still carries the others.
        if let Ok(live) = parse(&self.owner, &self.repo, &self.numbers, &out.stdout) {
            return Outcome::Live(live);
        }
        let err = String::from_utf8_lossy(&out.stderr);
        if out.status.code() == Some(4) || err.contains("gh auth login") {
            return Outcome::Hint("gh is not logged in; run `gh auth login` in a terminal.".into());
        }
        Outcome::Failed(format!("exit {:?}: {err}", out.status.code()))
    }
}

/// `gh` with `args` and only `env` of the user's environment, never prompting: the one spawn here.
fn gh_output(
    env: &[(OsString, OsString)],
    args: &[String],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    gh_output_in(None, env, args, timeout)
}
/// Ticket 373: `gh_output` run in `dir` (the by-branch lookup lets gh find the repository from the worktree's remotes).
fn gh_output_in(
    dir: Option<&Path>,
    env: &[(OsString, OsString)],
    args: &[String],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    gh_output_with(dir, env, args, timeout, None)
}
/// `gh_output_in` with `input` on gh's stdin (`--body-file -`).
fn gh_output_with(
    dir: Option<&Path>,
    env: &[(OsString, OsString)],
    args: &[String],
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<std::process::Output, String> {
    let program = crate::process::resolve_program(GH, crate::process::env_path(env));
    let mut c = crate::process::command(program);
    std::os::unix::process::CommandExt::arg0(&mut c, GH); // argv[0] stays the bare name
    if let Some(dir) = dir {
        c.current_dir(dir);
    }
    c.args(args)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        // gh 2.x sends usage telemetry by default; the ADR block allows no data about the user to leave.
        .env("GH_TELEMETRY", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    match input {
        Some(bytes) => crate::process::output_with_input(c, timeout, bytes),
        None => crate::process::output(c, timeout),
    }
}

/// V2.5-8/9: one `gh` run for the PR view, list or merge, with the poller's environment; stdout, or the error
/// text (the not-found and not-logged-in cases worded as the Settings hint).
pub(crate) fn run_gh(args: &[String], timeout: Duration) -> Result<Vec<u8>, String> {
    run_gh_in(None, args, timeout)
}
/// Ticket 373: `run_gh` in `dir`.
pub(crate) fn run_gh_in(
    dir: Option<&Path>,
    args: &[String],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    run_gh_with(dir, args, timeout, None)
}
/// `run_gh_in` with `input` on gh's stdin.
pub(crate) fn run_gh_with(
    dir: Option<&Path>,
    args: &[String],
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let env = shared().env.clone();
    let out = gh_output_with(dir, &env, args, timeout, input).map_err(|e| {
        if e.contains("os error 2") {
            "gh was not found on PATH; the PR view needs the GitHub CLI.".to_string()
        } else {
            e
        }
    })?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(4) || err.contains("gh auth login") {
        return Err("gh is not logged in; run `gh auth login` in a terminal.".into());
    }
    Err(format!("gh failed: {}", crate::logs::excerpt(&err)))
}

/// V2.5-8/9: the rebuilt link when `url` is a pull link the poller would accept.
pub(crate) fn clean_url(url: &str) -> Option<String> {
    Pull::parse(url).map(|p| p.url())
}

/// V2.5-9: the repositories of the PRs the core knows (agent-created or pinned), at most MAX_REPOS.
pub(crate) fn known_repos() -> Vec<(String, String)> {
    let p = shared();
    let set: BTreeSet<_> = p
        .pinned
        .iter()
        .chain(&p.created)
        .chain(&p.found) // ticket 373: listed and viewed, never merged
        .map(|x| (x.owner.clone(), x.repo.clone()))
        .collect();
    set.into_iter().take(MAX_REPOS).collect()
}

/// V2.5-8/9: `url`'s repository holds a PR an agent created or the owner pinned.
pub(crate) fn known_repo(url: &str) -> bool {
    let Some(pull) = Pull::parse(url) else {
        return false;
    };
    let p = shared();
    p.pinned
        .iter()
        .chain(&p.created)
        .any(|x| x.owner == pull.owner && x.repo == pull.repo)
}

/// Ticket 373 round 2 (owner rule): merge only for this very PR when an agent made it or the owner pinned it; a PR only
/// the by-branch lookup found is never merged, even beside agent PRs in its repository.
pub(crate) fn mergeable(url: &str) -> bool {
    let Some(pull) = Pull::parse(url) else {
        return false;
    };
    let p = shared();
    p.pinned.contains(&pull) || p.created.contains(&pull)
}

/// Ticket 373: `known_repo`, or the repository of a PR the by-branch lookup found. The view and list only: merge keeps
/// to `known_repo`.
pub(crate) fn shown_repo(url: &str) -> bool {
    let Some(pull) = Pull::parse(url) else {
        return false;
    };
    known_repo(url)
        || shared()
            .found
            .iter()
            .any(|x| x.owner == pull.owner && x.repo == pull.repo)
}

/// V2.5-9: the stored pins, so the list knows repositories before the first poll.
pub(crate) fn sync_pins(on: bool, pinned: &[String]) {
    shared().sync(on, pinned);
}

/// The poll state. `step` runs at most one `gh` on a caller's clock and `tick` a whole poll; the core's thread
/// (`start`) runs `take` and `apply` itself so `gh` runs outside the lock.
pub struct Poller {
    env: Vec<(OsString, OsString)>,
    on: bool,
    pinned: BTreeSet<Pull>,
    created: BTreeSet<Pull>,
    /// Ticket 373: PRs the by-branch lookup found; shown, never polled and never a reason to allow a merge.
    found: BTreeSet<Pull>,
    front: Option<Instant>,
    last: Option<Instant>,
    live: BTreeMap<String, Live>,
    hint: Option<String>,
    /// The rest of the current poll, one `gh` run each.
    pending: VecDeque<Batch>,
    /// Per repository, the earliest next try after an error.
    backoff: BTreeMap<(String, String), Instant>,
    /// Merged: the state is final, not polled again while the core runs.
    done: BTreeSet<Pull>,
    /// Closed, and when it was last seen so: skipped until RECHECK_CLOSED has passed.
    closed: BTreeMap<Pull, Instant>,
}
impl Poller {
    /// `env` is all `gh` will see of the user's environment.
    pub fn new(env: Vec<(OsString, OsString)>) -> Self {
        Self {
            env,
            on: false,
            pinned: BTreeSet::new(),
            created: BTreeSet::new(),
            found: BTreeSet::new(),
            front: None,
            last: None,
            live: BTreeMap::new(),
            hint: None,
            pending: VecDeque::new(),
            backoff: BTreeMap::new(),
            done: BTreeSet::new(),
            closed: BTreeMap::new(),
        }
    }
    fn from_env() -> Self {
        Self::new(
            KEPT.iter()
                .filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v)))
                // A relative or empty PATH entry would resolve `gh` against the core's working folder.
                .map(|(k, v)| {
                    if k != "PATH" {
                        return (k, v);
                    }
                    let abs = std::env::split_paths(&v).filter(|p| p.is_absolute());
                    (k, std::env::join_paths(abs).unwrap_or_default())
                })
                .collect(),
        )
    }
    /// The stored setting and pins, as the settings store holds them now; invalid links are ignored.
    pub fn sync(&mut self, on: bool, pinned: &[String]) {
        self.on = on;
        self.pinned = pinned.iter().filter_map(|u| Pull::parse(u)).collect();
    }
    /// The PRs an agent created (`chat::pr::created`); kept while the core runs.
    pub fn created(&mut self, urls: impl IntoIterator<Item = String>) {
        // shortcut: links past MAX_PINNED are dropped until the core restarts; agent transcripts are untrusted text.
        for pull in urls.into_iter().filter_map(|u| Pull::parse(&u)) {
            if self.created.len() >= MAX_PINNED {
                break;
            }
            self.created.insert(pull);
        }
    }
    /// The window's heartbeat: `false` (blur, hidden) stops polling at once.
    pub fn front(&mut self, now: Instant, front: bool) {
        self.front = front.then_some(now);
    }
    pub fn live(&self, url: &str) -> Option<Live> {
        let pull = Pull::parse(url)?;
        let watched = self.pinned.contains(&pull) || self.created.contains(&pull);
        (self.on && watched).then(|| self.live.get(url).cloned())?
    }
    pub fn hint(&self) -> Option<&str> {
        self.hint.as_deref()
    }
    /// One whole poll on the caller's clock, `gh` runs included; returns the log lines it wrote.
    pub fn tick(&mut self, now: Instant) -> Vec<String> {
        let mut logged = vec![];
        while let Some(lines) = self.step(now) {
            logged.extend(lines);
        }
        logged
    }
    /// At most one `gh` run; `None` when none may start now.
    pub fn step(&mut self, now: Instant) -> Option<Vec<String>> {
        let batch = self.take(now)?;
        let outcome = batch.run(&self.env);
        Some(self.apply(batch, outcome, now))
    }
    /// The next repository to run, checked right before its spawn: the setting on and the window in front, else the
    /// rest of the poll is dropped.
    fn take(&mut self, now: Instant) -> Option<Batch> {
        let in_front = self
            .front
            .is_some_and(|t| now.saturating_duration_since(t) < STALE);
        if !(self.on && in_front) {
            self.pending.clear();
            return None;
        }
        if self.pending.is_empty() {
            self.pending = self.due(now);
        }
        self.pending.pop_front()
    }
    /// The batches of a new poll when one is due (and marks it), or none.
    fn due(&mut self, now: Instant) -> VecDeque<Batch> {
        let waited = self
            .last
            .is_none_or(|t| now.saturating_duration_since(t) >= EVERY);
        if !waited {
            return VecDeque::new();
        }
        let mut repos: BTreeMap<(String, String), Vec<u64>> = BTreeMap::new();
        // Pinned first: the owner's own picks win the MAX_REPOS slots over agent-created ones.
        for p in self
            .pinned
            .iter()
            .chain(self.created.difference(&self.pinned))
        {
            let key = (p.owner.clone(), p.repo.clone());
            let waiting = self.backoff.get(&key).is_some_and(|t| now < *t);
            let closed = self
                .closed
                .get(p)
                .is_some_and(|t| now.saturating_duration_since(*t) < RECHECK_CLOSED);
            if self.done.contains(p) || closed || waiting {
                continue;
            }
            if !repos.contains_key(&key) && repos.len() >= MAX_REPOS {
                continue;
            }
            let numbers = repos.entry(key).or_default();
            if numbers.len() < PER_REPO {
                numbers.push(p.number);
            }
        }
        if !repos.is_empty() {
            self.last = Some(now);
        }
        repos
            .into_iter()
            .map(|((owner, repo), numbers)| Batch {
                owner,
                repo,
                numbers,
            })
            .collect()
    }
    fn apply(&mut self, b: Batch, outcome: Outcome, now: Instant) -> Vec<String> {
        let key = (b.owner.clone(), b.repo.clone());
        match outcome {
            Outcome::Live(live) => {
                self.backoff.remove(&key);
                for url in b.urls() {
                    self.live.remove(&url);
                    if let Some(pull) = Pull::parse(&url) {
                        self.closed.remove(&pull);
                    }
                }
                for l in live {
                    if let Some(pull) = Pull::parse(&l.url) {
                        match l.state {
                            PrState::Merged => {
                                self.done.insert(pull);
                            }
                            PrState::Closed => {
                                self.closed.insert(pull, now);
                            }
                            _ => {}
                        }
                    }
                    self.live.insert(l.url.clone(), l);
                }
                self.hint = None;
                vec![]
            }
            Outcome::Hint(h) => {
                self.backoff.insert(key, now + BACKOFF);
                // A merged PR cannot change back, so its chip stays; every other live state falls back to tier 1.
                self.live.retain(|_, l| l.state == PrState::Merged);
                self.hint = Some(h);
                vec![]
            }
            Outcome::Failed(e) => {
                self.backoff.insert(key, now + BACKOFF);
                // The chips fall back to tier 1 (with its age) rather than show a stale live state.
                for url in b.urls() {
                    self.live.remove(&url);
                }
                let line = format!(
                    "pr_live: gh for {}/{}: {}",
                    b.owner,
                    b.repo,
                    crate::logs::excerpt(&e)
                );
                eprintln!("{line}");
                vec![line]
            }
        }
    }
}

static SHARED: LazyLock<Mutex<Poller>> = LazyLock::new(|| Mutex::new(Poller::from_env()));
fn shared() -> std::sync::MutexGuard<'static, Poller> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}
/// The core's poll thread, started by the first heartbeat with the setting on; `gh` runs outside the lock.
fn start() {
    static THREAD: Once = Once::new();
    THREAD.call_once(|| {
        thread::spawn(|| {
            loop {
                // One `gh` at a time; `take` re-checks the setting and the front before each.
                loop {
                    let (batch, env) = {
                        let mut p = shared();
                        match p.take(Instant::now()) {
                            Some(b) => (b, p.env.clone()),
                            None => break,
                        }
                    };
                    let outcome = batch.run(&env);
                    shared().apply(batch, outcome, Instant::now());
                }
                thread::sleep(TICK);
            }
        });
    });
}

/// Ticket 373: a PR the by-branch lookup found for a worktree's own branch: the PR view and list accept it, merge does
/// not (owner decision 11-10: merge stays with PRs an agent made or the owner pinned).
pub(crate) fn note_found(url: &str) {
    let mut p = shared();
    // shortcut: past MAX_PINNED found links are dropped until the core restarts.
    if let Some(pull) = Pull::parse(url)
        && p.found.len() < MAX_PINNED
    {
        p.found.insert(pull);
    }
}

/// A PR the app created for `session` (the Diff panel's Create PR): it joins the created ones (live status, the PR view,
/// merge) and is that session's chip until its transcript names one. Kept in memory: a core restart drops it.
pub(crate) fn note_made(session: &str, url: &str, draft: bool) {
    note(session, url, draft, None);
}
/// `note_made` for a PR found in `agent`'s terminal output (`link_later`): never over a PR the app made itself.
fn note_linked(session: &str, url: &str, draft: bool, agent: String) {
    let app_made = MADE.lock().ok().is_some_and(|m| {
        m.get(session)
            .is_some_and(|(_, _, linked)| linked.is_none())
    });
    if !app_made {
        note(session, url, draft, Some(agent));
    }
}
fn note(session: &str, url: &str, draft: bool, linked: Option<String>) {
    let Some(pull) = Pull::parse(url) else {
        return;
    };
    shared().created.insert(pull.clone());
    if let Ok(mut made) = MADE.lock() {
        // shortcut: past MAX_PINNED sessions the map is emptied; a session's chip then waits for its transcript.
        if made.len() >= MAX_PINNED {
            made.clear();
        }
        made.insert(session.to_string(), (pull.url(), draft, linked));
    }
}
/// Per session: the PR link, whether it is a draft, and the agent whose output it was linked from (`None`: the app made it).
type Made = BTreeMap<String, (String, bool, Option<String>)>;
static MADE: std::sync::LazyLock<Mutex<Made>> = std::sync::LazyLock::new(Default::default);
/// How often one session's terminal output is looked at for a PR link it printed.
const LINK_EVERY: Duration = Duration::from_secs(30);
static LINK_TRIED: std::sync::LazyLock<Mutex<BTreeMap<String, Instant>>> =
    std::sync::LazyLock::new(Default::default);
/// Links looked at in one output.
const LINKS_MAX: usize = 20;

/// The pull request links in terminal `output`, rebuilt from validated pieces, at most `LINKS_MAX`.
pub fn pr_links(output: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(output);
    let mut found: Vec<String> = vec![];
    for (at, _) in text.match_indices(PULL_HEAD) {
        let link: String = text[at..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || "/:._-".contains(*c))
            .collect();
        if let Some(url) = clean_url(link.trim_end_matches(['.', ':']))
            && !found.contains(&url)
        {
            found.push(url);
        }
        if found.len() >= LINKS_MAX {
            break;
        }
    }
    found
}

/// Auto-link (no agent command): a PR link a session's agent printed in its terminal becomes that session's PR once the
/// by-branch lookup (`gh pr view <branch>` in its folder) names that very PR. At most once per `LINK_EVERY` per
/// session, off the caller's thread, and only with live PR status on (outside traffic only then).
/// Whether `session`'s output may be looked at now (at most once per `LINK_EVERY`); a yes counts as the look. The caller
/// asks before it copies the output.
pub(crate) fn link_due(session: &str) -> bool {
    let Ok(mut tried) = LINK_TRIED.lock() else {
        return false;
    };
    if tried.get(session).is_some_and(|t| t.elapsed() < LINK_EVERY) {
        return false;
    }
    if tried.len() >= MAX_PINNED {
        tried.clear();
    }
    tried.insert(session.to_string(), Instant::now());
    true
}

/// `link_due` said yes: when the branch's own PR (gh, by branch) is one `agent` printed and not the session's PR yet, it
/// becomes the session's PR, also after an earlier linked one (a new PR on another branch).
pub(crate) fn link_later(session: &str, agent: String, dir: std::path::PathBuf, output: &[u8]) {
    let links = pr_links(output);
    if links.is_empty() {
        return;
    }
    let session = session.to_string();
    thread::spawn(move || {
        if let Ok(Some(pr)) = crate::pr::branch_pr(&dir)
            && links.contains(&pr.url)
            && made_chip(&session).is_none_or(|c| c.url != pr.url)
        {
            note_linked(&session, &pr.url, pr.state == PrState::Draft, agent);
        }
    });
}

/// The chip of the PR the app made for `session`, if any.
pub(crate) fn made_chip(session: &str) -> Option<crate::chat::pr::PrChip> {
    let (url, draft, linked) = MADE.lock().ok()?.get(session)?.clone();
    Some(crate::chat::pr::PrChip {
        state: if draft { PrState::Draft } else { PrState::Open },
        url,
        at: None,
        linked,
    })
}

/// The PRs a session's agent created, from the events the tier-1 chip read scanned.
pub(crate) fn note_created(events: &[Value]) {
    shared().created(crate::chat::pr::created(events));
}

/// The window's `pr_live`, `pr_live_set`, `pr_watch` and `pr_front` ops (window only, see `sessions.rs`).
pub(crate) fn answer(registry: &Mutex<Sessions>, request: Request) -> Response {
    let (url, on, offered, watch, front) = match request {
        Request::PrLive { url } => (url, None, None, None, None),
        Request::PrLiveSet { on, offered } => (None, on, offered, None, None),
        Request::PrWatch { url, on } => {
            if !valid_url(&url) {
                return Err("not a GitHub pull request link".into());
            }
            (Some(url.clone()), None, None, Some((url, on)), None)
        }
        Request::PrFront { front } => (None, None, None, None, Some(front)),
        _ => return Err("not a live PR op".into()),
    };
    let (on, offered, pinned) = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .pr_live(on, offered, watch)?;
    let mut p = shared();
    p.sync(on, &pinned);
    if let Some(front) = front {
        p.front(Instant::now(), front);
        if front && on {
            start();
        }
    }
    Ok(Reply::PrLive {
        on,
        offered,
        watched: url.as_ref().is_some_and(|u| pinned.contains(u)),
        live: url.as_deref().and_then(|u| p.live(u)),
        hint: on.then(|| p.hint().map(String::from)).flatten(),
    })
}

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn pr_links_read_terminal_text() {
        let out = b"\x1b[32mhttps://github.com/develku/nunchiro/pull/12\x1b[0m\r\n\
            see https://user:token@github.com/develku/nunchiro/pull/13 and https://github.com/other/thing/pull/7.\n\
            https://github.com/develku/nunchiro/pull/12 again, https://gitlab.com/o/r/pull/1";
        assert_eq!(
            pr_links(out),
            vec![
                "https://github.com/develku/nunchiro/pull/12".to_string(),
                "https://github.com/other/thing/pull/7".to_string(),
            ]
        );
        let many: String = (1..=50)
            .map(|n| format!("https://github.com/o/r/pull/{n} "))
            .collect();
        assert_eq!(pr_links(many.as_bytes()).len(), LINKS_MAX);
    }

    #[test]
    fn link_checks_are_rate_limited_per_session() {
        assert!(link_due("rate-a"));
        assert!(!link_due("rate-a"), "a second look within 30 s");
        assert!(link_due("rate-b"));
    }
}
