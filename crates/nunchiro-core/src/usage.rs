//! V2-2c: tokens per account per local day, counted from the agents' own transcripts (Claude `projects/**/*.jsonl`,
//! Codex `sessions/**/*.jsonl` under the account's folder). Nothing else under a folder is opened, so credentials
//! and settings stay unread. The per-message dedup and the four-way token sum follow Orca's `claude-usage` reader;
//! the streaming reader, the Codex running-total rule and the local-day windows are new.
//!
//! Orca `src/main/claude-usage/*` at `2eb0bb63`: MIT License, Copyright (c) 2026 Lovecast Inc.
//! Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//! documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//! the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//! to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//! copyright notice and this permission notice shall be included in all copies or substantial portions of the
//! Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//! LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//! SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//! OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//! DEALINGS IN THE SOFTWARE.
use crate::{
    accounts::{Agent, agent_of, real_folder, registered, variable},
    api::{AgentKind, Reply, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    pub today: u64,
    pub week: u64,
}
/// V2.5-10: what the last 24 h or 7 days (rolling, not local days) spent on one account.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub tokens: u64,
    /// List-price estimate in millionths of a US dollar, over the tokens of models `PRICES` knows.
    pub cost_micro: u64,
    /// Tokens of a model `PRICES` does not know: in `tokens`, left out of `cost_micro`.
    pub unpriced: u64,
}
/// V2.5-10: an agent's own record of a usage limit, still ahead (Codex rollouts carry it; Claude's transcripts do not).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limit {
    pub left_pct: u8,
    pub resets_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub agent: Agent,
    pub id: String,
    pub today: u64,
    pub week: u64,
    /// The request's work cap ran out before this row was fully counted: the numbers are a lower bound.
    pub partial: bool,
    /// V2-2c limit mark: the reset time as the agent printed it on a session's screen ("11pm"), while it is ahead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_resets: Option<String>,
    #[serde(default)]
    pub last_24h: Window,
    #[serde(default)]
    pub last_7d: Window,
    /// The 5-hour style window's remaining share and reset, from the newest local record; none when no source has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<Limit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly: Option<Limit>,
    /// Ticket 1036: when Claude Code last handed this account's limits to its status line (Unix seconds); the
    /// `session` and `weekly` of a Claude row come from that record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits_at: Option<i64>,
    /// Ticket 211: the user's own default folder is a link; where it points and whether it was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<Link>,
    /// Models seen in the last 7 days that `PRICES` does not list: the page says "cost unknown for" them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unpriced_models: Vec<String>,
}
/// Why a link in the user's own default folder was or was not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    Followed,
    /// Followed, but the linked scan's own file or byte cap ran out: the numbers are a lower bound.
    Capped,
    /// The target is outside the user's home and every volume the owner named.
    Outside,
    /// The target is not a folder, cannot be read, or is writable by others.
    Unsafe,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub target: String,
    pub status: LinkStatus,
}

/// Where `PRICES` comes from: Anthropic's public price page, read on the date shown (Claude rows; GPT-5 is OpenAI's list).
pub const PRICE_SOURCE: &str = "Anthropic list prices, https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-27";

/// Millionths of a dollar per token = milli-dollars per million tokens / 1000: (input, output, cache write, cache
/// read). Public list prices, an estimate (`PRICE_SOURCE`); the first prefix that matches wins, so a longer name goes first,
/// and a prefix never ends inside a number (`price_of`).
// shortcut: a model not listed is left out of the cost and counted as `unpriced`; add it when a new model ships.
// shortcut: Haiku 5.5 is priced at its up-to-100k-prompt tier (5x above that), so a long prompt is under-estimated.
const PRICES: &[(&str, [u64; 4])] = &[
    ("claude-fable-5-2", [8000, 40000, 10000, 200]),
    ("claude-fable-5-1", [10000, 50000, 12500, 250]),
    ("claude-fable-5", [10000, 50000, 12500, 1000]),
    ("claude-opus-5-5", [4000, 20000, 5000, 200]),
    ("claude-opus-5", [5000, 25000, 6250, 500]),
    ("claude-opus-4-8", [5000, 25000, 6250, 500]),
    ("claude-opus-4-7", [5000, 25000, 6250, 500]),
    ("claude-opus-4-6", [5000, 25000, 6250, 500]),
    ("claude-opus-4-5", [5000, 25000, 6250, 500]),
    // Opus 4 and 4.1 only: a later 4.x id is left unpriced rather than priced at 4.1 rates.
    ("claude-opus-4-1", [15000, 75000, 18750, 1500]),
    ("claude-opus-4-20250514", [15000, 75000, 18750, 1500]),
    ("claude-sonnet-5-5", [2000, 10000, 2500, 100]),
    ("claude-sonnet-5", [2000, 10000, 2500, 200]),
    ("claude-sonnet-4", [3000, 15000, 3750, 300]),
    ("claude-haiku-5-5", [100, 500, 125, 10]),
    ("claude-haiku-4-5", [1000, 5000, 1250, 100]),
    ("gpt-5", [1250, 10000, 0, 125]),
];
/// The price row of `model`, by the first matching prefix that does not end inside a number, so a dated
/// `claude-fable-5-20261001` stays Fable 5 and is not read as Fable 5.2.
pub fn price_of(model: &str) -> Option<[u64; 4]> {
    PRICES.iter().find_map(|(p, price)| {
        let rest = model.strip_prefix(p)?;
        (!rest.starts_with(|c: char| c.is_ascii_digit())).then_some(*price)
    })
}

/// One counted message or turn: its time, the sum `Totals` counts, and the four parts a price applies to.
struct Event {
    at: i64,
    tokens: u64,
    parts: [u64; 4],
    model: Option<String>,
    /// The folder the agent ran in and its own session id, when the record names them (the Usage page's tabs).
    cwd: Option<String>,
    session: Option<String>,
}
impl Window {
    fn add(&mut self, e: &Event) {
        self.tokens += e.tokens;
        let price = e.model.as_deref().and_then(price_of);
        match price {
            Some(p) => {
                self.cost_micro += e
                    .parts
                    .iter()
                    .zip(p)
                    .map(|(n, p)| n * p / 1000)
                    .sum::<u64>()
            }
            None => self.unpriced += e.tokens,
        }
    }
}

// shortcut: a transcript line over 1 MiB is skipped whole (a huge tool result or write), so an assistant line that
// large is not counted; upgrade when such lines show up in real transcripts.
const MAX_LINE: usize = 1 << 20;
const MAX_DEPTH: u8 = 8;
const DAY: i64 = 86_400;

/// What one request may spend across all its rows, so a tree an agent can write cannot stall a window job. The
/// defaults cover a heavy user (about 18 000 Codex rollouts a year; a week of Claude transcripts is far below
/// 20 000 files or 2 GiB); the first limit hit marks the rest of the request partial.
pub struct Budget {
    entries: usize,
    files: usize,
    bytes: u64,
    pub partial: bool,
    /// Folders a link in the user's own default folder may point into (canonical); empty follows none.
    pub link_roots: Vec<PathBuf>,
    /// (entries, files, bytes) one linked scan may spend, inside this budget: the owner check is weak on a
    /// `noowners` volume, so a planted link cannot point the scan at an unbounded tree.
    pub link_cap: (usize, usize, u64),
    /// Ticket 1031: only the records that carry limits are read (Codex); Claude's rows come back with no tokens.
    pub limits_only: bool,
}
impl Budget {
    pub fn new(entries: usize, files: usize, bytes: u64) -> Self {
        Self {
            entries,
            files,
            bytes,
            partial: false,
            link_roots: vec![],
            link_cap: (100_000, 5_000, 512 << 20),
            limits_only: false,
        }
    }
    pub fn request() -> Self {
        Self::new(500_000, 20_000, 2 << 30)
    }
}

/// The folders a link may point into: the user's home, the folders the owner named in Usage (settings.json
/// `usage_link_roots`, written by `quit_settings`), and, as a hidden extra for scripts, the canonical paths in
/// `NUNCHIRO_USAGE_LINK_ROOTS` (colon-separated). Each is canonicalized again here.
fn link_roots(home: &Path) -> Vec<PathBuf> {
    let named = std::env::var("NUNCHIRO_USAGE_LINK_ROOTS").unwrap_or_default();
    let saved = crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["usage_link_roots"].as_array().cloned())
        .unwrap_or_default();
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .into_iter()
        .chain(
            named
                .split(':')
                .filter(|p| !p.is_empty())
                .map(PathBuf::from),
        )
        .chain(saved.iter().filter_map(|v| v.as_str().map(PathBuf::from)))
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect()
}

/// The owner's "Allow this folder": `path` as one canonical, existing folder, or why not.
pub fn allow_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("the folder to allow must be an absolute path".into());
    }
    let root = fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if root.is_dir() {
        Ok(root)
    } else {
        Err(format!("{} is not a folder", root.display()))
    }
}

/// `dir` when it is a link: one `realpath`, then the target must be a folder inside a named root, owned by this user
/// and not writable by group or world. `Err` is the label to show; the scan reads nothing then.
fn resolve_link(dir: &Path, roots: &[PathBuf]) -> Option<Result<PathBuf, Link>> {
    if !fs::symlink_metadata(dir).ok()?.file_type().is_symlink() {
        return None;
    }
    let refused = |target: String, status| Err(Link { target, status });
    let Ok(target) = fs::canonicalize(dir) else {
        let shown = fs::read_link(dir).unwrap_or_default();
        return Some(refused(shown.to_string_lossy().into(), LinkStatus::Unsafe));
    };
    let shown = target.to_string_lossy().to_string();
    if !roots.iter().any(|r| target.starts_with(r)) {
        return Some(refused(shown, LinkStatus::Outside));
    }
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no arguments and cannot fail.
    let mine = unsafe { libc::geteuid() };
    // The checks run on an opened handle (O_DIRECTORY | O_NOFOLLOW), so they judge the folder this open reached, not a
    // path that can change between the check and the open.
    // shortcut: the walk below re-opens the target by path (std has no openat/fdopendir), so a swap of the target or a
    // parent between this check and the walk is not caught; reads only, no nested links, capped. Upgrade with a
    // handle-based walk (rustix/nix openat) if the link roots ever include a folder others can write above.
    let safe = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&target)
        .and_then(|d| d.metadata())
        .is_ok_and(|m| m.is_dir() && m.uid() == mine && m.mode() & 0o022 == 0);
    Some(if safe {
        Ok(target)
    } else {
        refused(shown, LinkStatus::Unsafe)
    })
}

/// Seconds east of UTC at the epoch second `t` in this machine's zone.
pub fn local_offset(t: i64) -> i64 {
    let t = t as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are to live locals; localtime_r writes only `tm`.
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        0
    } else {
        tm.tm_gmtoff
    }
}

/// The window's reply: a row for each agent's "Your own" folder, then for each registered account.
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
fn now_secs() -> Result<i64, String> {
    Ok(SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64)
}
pub fn reply(home: &Path, limits: bool) -> Response {
    let now = now_secs()?;
    let own = own_folder;
    // Canonical, as the accounts requests do, so `real_folder` opens the same path.
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    let mut budget = Budget::request();
    budget.link_roots = link_roots(&home);
    budget.limits_only = limits;
    rows(&home, &own, now, &local_offset, &mut budget).map(|rows| Reply::AccountUsage { rows })
}

/// `own` names an agent's own config folder; an account's is reached through `accounts::real_folder`. A registry
/// `accounts::load` refuses (link, FIFO, other version, bad entry, over 1 MiB) gives no added rows; "Your own" still
/// counts. An account folder, `projects` or `sessions` that is a link counts 0.
pub fn rows(
    home: &Path,
    own: &dyn Fn(Agent) -> Option<PathBuf>,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    budget: &mut Budget,
) -> Result<Vec<Row>, String> {
    rows_with(home, own, now, offset, budget, 8 * DAY, &mut |_, _, _| true)
}
/// `rows`, reading files written within `horizon` and handing every counted record to `each` (agent, account id).
fn rows_with(
    home: &Path,
    own: &dyn Fn(Agent) -> Option<PathBuf>,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    budget: &mut Budget,
    horizon: i64,
    each: &mut dyn FnMut(Agent, &str, &Event) -> bool,
) -> Result<Vec<Row>, String> {
    let accounts = registered(home).unwrap_or_default();
    let mut rows = vec![];
    for agent in [Agent::Claude, Agent::Codex] {
        let folders = std::iter::once(("own".to_string(), own(agent), false)).chain(
            accounts
                .iter()
                .filter(|(a, _)| *a == agent)
                .map(|(_, id)| (id.clone(), real_folder(home, agent, id, false).ok(), true)),
        );
        for (id, folder, added) in folders {
            let mut link = None;
            let found = match folder {
                // Claude writes no limits into its transcripts, so a limits-only read opens none of them.
                Some(_) if budget.limits_only && agent == Agent::Claude => Scanned::default(),
                // An added account may not hold a link (its sign-in records rule): it counts 0.
                Some(f) if added && !real_dir(&f.join(subfolder(agent))) => Scanned::default(),
                Some(f) => {
                    let dir = f.join(subfolder(agent));
                    match resolve_link(&dir, &budget.link_roots) {
                        None => scan_all(
                            &dir,
                            agent,
                            now,
                            offset,
                            &mut |_| {},
                            budget,
                            horizon,
                            &mut |e| each(agent, &id, e),
                        ),
                        Some(Err(refused)) if !added => {
                            link = Some(refused);
                            Scanned::default()
                        }
                        Some(Ok(target)) if !added => {
                            let (found, capped) = scan_linked(
                                &target,
                                agent,
                                now,
                                offset,
                                budget,
                                horizon,
                                &mut |e| each(agent, &id, e),
                            );
                            let status = if capped {
                                LinkStatus::Capped
                            } else {
                                LinkStatus::Followed
                            };
                            link = Some(Link {
                                target: target.to_string_lossy().into(),
                                status,
                            });
                            found
                        }
                        Some(_) => Scanned::default(),
                    }
                }
                None => Scanned::default(),
            };
            let totals = found.totals;
            let limit_resets = limit_of(home, agent, &id, now);
            // Ticket 1036: Claude writes no limits into its transcripts; its status line record has them.
            let told = (agent == Agent::Claude)
                .then(|| claude_limits(home).remove(&id))
                .flatten();
            let ahead = |l: Option<Limit>| l.filter(|l| l.resets_at > now);
            rows.push(Row {
                agent,
                id,
                today: totals.today,
                week: totals.week,
                partial: budget.partial
                    || link
                        .as_ref()
                        .is_some_and(|l| l.status == LinkStatus::Capped),
                limit_resets,
                last_24h: found.last_24h,
                last_7d: found.last_7d,
                session: found
                    .session
                    .map(|l| l.1)
                    .or(ahead(told.and_then(|t| t.session))),
                weekly: found
                    .weekly
                    .map(|l| l.1)
                    .or(ahead(told.and_then(|t| t.weekly))),
                limits_at: told.map(|t| t.at),
                link,
                unpriced_models: found.unpriced_models.into_iter().collect(),
            });
        }
    }
    Ok(rows)
}

/// The v4 Usage page (usage.html v4, lane v25c-usage-split): sums over a rolling range for its tiles, token mix, busy
/// hours and tabs, and the 42 local days of its intensity grid. Read from the same local records as `rows`, in the
/// same budget; nothing is stored. Lifted from Orca (MIT License, Copyright (c) 2026 Lovecast Inc.; 1.4.214): the
/// cache share (cache read / (new input + cache read), `usage-overview-model.ts:72-73`) and the 42-day window
/// (`UsageOverviewPane.tsx:13`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sum {
    pub tokens: u64,
    /// New input, output, cache write, cache read.
    pub parts: [u64; 4],
    pub cost_micro: u64,
    /// Tokens of models `PRICES` does not list (in `tokens`, not in `cost_micro`).
    pub unpriced: u64,
    pub turns: u64,
}
impl Sum {
    fn add(&mut self, e: &Event) {
        self.tokens += e.tokens;
        self.turns += 1;
        for (s, n) in self.parts.iter_mut().zip(e.parts) {
            *s += n;
        }
        match e.model.as_deref().and_then(price_of) {
            Some(p) => {
                self.cost_micro += e
                    .parts
                    .iter()
                    .zip(p)
                    .map(|(n, p)| n * p / 1000)
                    .sum::<u64>()
            }
            None => self.unpriced += e.tokens,
        }
    }
}
/// One row of a tab: an agent, a model, a folder or an agent session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub key: String,
    #[serde(flatten)]
    pub sum: Sum,
    /// Distinct agent sessions in the row.
    pub sessions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<Agent>,
    /// The account id ("own" or a registry id) a session ran on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Detail {
    pub days: u32,
    pub total: Sum,
    /// Local days in the range with any tokens.
    pub active_days: u32,
    /// The local day (days since 1970-01-01 in local time) of `daily[0]`; `daily` runs 42 days to today.
    pub first_day: i64,
    pub daily: Vec<u64>,
    /// Tokens by local weekday and hour, Monday 00:00 first (7 x 24), over the range.
    pub hours: Vec<u64>,
    pub agents: Vec<Group>,
    pub models: Vec<Group>,
    pub folders: Vec<Group>,
    pub sessions: Vec<Group>,
    pub partial: bool,
}
pub const DETAIL_DAYS: [u32; 4] = [1, 7, 30, 90];
const GRID_DAYS: i64 = 42;
const MAX_GROUPS: usize = 100;
/// Read caps (round 4), so a transcript an agent can write cannot grow what one request holds. A session id, message id
/// or model longer than `MAX_NAME` bytes, or a folder longer than `MAX_PATH` (macOS PATH_MAX), is read as absent: the
/// record still counts, under no session, model or folder (a Claude message without a usable id is skipped, as
/// before). The Usage page keeps at most `MAX_TRACKED` groups per tab and `MAX_ENTRIES` sessions and models inside
/// all groups together; the first record past either stops the reading and marks the result partial. 20 000 is the
/// request's file budget, so a real Codex history (one session a file) reaches the file limit first.
const MAX_NAME: usize = 256;
const MAX_PATH: usize = 1024;
const MAX_TRACKED: usize = 20_000;
const MAX_ENTRIES: usize = 400_000;
/// Claude message ids one folder's read remembers for counting a message once; past it the read stops, partial.
const MAX_SEEN: usize = 1_000_000;

/// The string at `v` when it is at most `max` bytes.
fn short(v: &Value, max: usize) -> Option<String> {
    v.as_str().filter(|s| s.len() <= max).map(String::from)
}

#[derive(Default)]
struct Acc {
    sum: Sum,
    sessions: std::collections::BTreeSet<Arc<str>>,
    models: BTreeMap<Arc<str>, u64>,
    agent: Option<Agent>,
    account: Option<Arc<str>>,
    cwds: BTreeMap<Arc<str>, u64>,
}
/// Ticket 324: which records the Usage page counts. The default counts all of them.
#[derive(Default)]
pub struct Filter {
    account: Option<String>,
    sessions: Option<HashSet<String>>,
}
impl Filter {
    pub fn new(account: Option<String>, sessions: Option<Vec<String>>) -> Self {
        Self {
            account,
            sessions: sessions.map(|s| s.into_iter().collect()),
        }
    }
    fn keeps(&self, agent: Agent, id: &str, e: &Event) -> bool {
        let of_account = self
            .account
            .as_deref()
            .is_none_or(|a| a.split_once(':') == Some((crate::accounts::agent_name(agent), id)));
        let of_session = self
            .sessions
            .as_ref()
            .is_none_or(|ids| e.session.as_ref().is_some_and(|s| ids.contains(s)));
        of_account && of_session
    }
}
struct Detailer<'a> {
    days: u32,
    since: i64,
    first_day: i64,
    offset: &'a dyn Fn(i64) -> i64,
    total: Sum,
    active: std::collections::BTreeSet<i64>,
    daily: Vec<u64>,
    hours: Vec<u64>,
    tabs: [BTreeMap<Arc<str>, Acc>; 4],
    /// Each kept string once, shared by every group that names it.
    names: HashSet<Arc<str>>,
    /// Sessions and models held inside groups, against `MAX_ENTRIES`.
    entries: usize,
    /// A cap was hit: nothing more is read.
    full: bool,
}
impl<'a> Detailer<'a> {
    fn new(now: i64, days: u32, offset: &'a dyn Fn(i64) -> i64) -> Self {
        let today = (now + offset(now)).div_euclid(DAY);
        Self {
            days,
            since: now - i64::from(days) * DAY,
            first_day: today - (GRID_DAYS - 1),
            offset,
            total: Sum::default(),
            active: Default::default(),
            daily: vec![0; GRID_DAYS as usize],
            hours: vec![0; 7 * 24],
            tabs: Default::default(),
            names: HashSet::new(),
            entries: 0,
            full: false,
        }
    }
    fn name(names: &mut HashSet<Arc<str>>, s: &str) -> Arc<str> {
        if let Some(n) = names.get(s) {
            return n.clone();
        }
        let n: Arc<str> = s.into();
        names.insert(n.clone());
        n
    }
    /// False once a cap is hit (the record is not kept): the reader stops.
    fn add(&mut self, agent: Agent, account: &str, e: &Event) -> bool {
        let session = e
            .session
            .as_ref()
            .map(|s| format!("{}:{s}", crate::accounts::agent_name(agent)));
        let keys = [
            Some(crate::accounts::agent_name(agent)),
            Some(e.model.as_deref().unwrap_or_default()),
            Some(e.cwd.as_deref().unwrap_or_default()),
            session.as_deref(),
        ];
        // A record adds at most three entries to each of its four groups.
        self.full |= self.entries + 12 > MAX_ENTRIES
            || self.tabs.iter().zip(keys).any(|(tab, key)| {
                key.is_some_and(|k| tab.len() >= MAX_TRACKED && !tab.contains_key(k))
            });
        if self.full {
            return false;
        }
        let local = e.at + (self.offset)(e.at);
        let day = local.div_euclid(DAY);
        if let Some(slot) = usize::try_from(day - self.first_day)
            .ok()
            .and_then(|i| self.daily.get_mut(i))
        {
            *slot += e.tokens;
        }
        if e.at <= self.since {
            return true;
        }
        self.total.add(e);
        self.active.insert(day);
        // 1970-01-01 was a Thursday: Monday is 0.
        let weekday = (day + 3).rem_euclid(7) as usize;
        self.hours[weekday * 24 + (local.rem_euclid(DAY) / 3600) as usize] += e.tokens;
        let names = &mut self.names;
        let session = session.as_deref().map(|s| Self::name(names, s));
        let model = e.model.as_deref().map(|m| Self::name(names, m));
        let cwd = e.cwd.as_deref().map(|c| Self::name(names, c));
        for (tab, key) in self.tabs.iter_mut().zip(keys) {
            let Some(key) = key else { continue };
            if !tab.contains_key(key) {
                tab.insert(Self::name(names, key), Acc::default());
            }
            let g = tab.get_mut(key).expect("inserted above");
            g.sum.add(e);
            if let Some(s) = &session {
                self.entries += usize::from(g.sessions.insert(s.clone()));
            }
            if let Some(m) = &model {
                let n = g.models.entry(m.clone()).or_insert_with(|| {
                    self.entries += 1;
                    0
                });
                *n += e.tokens;
            }
            g.agent.get_or_insert(agent);
            if g.account.is_none() {
                g.account = Some(Self::name(names, account));
            }
            if let Some(c) = &cwd {
                let n = g.cwds.entry(c.clone()).or_insert_with(|| {
                    self.entries += 1;
                    0
                });
                *n += e.tokens;
            }
        }
        true
    }
    fn finish(self, partial: bool) -> Detail {
        let [agents, models, folders, sessions] = self.tabs.map(|tab| {
            let mut rows: Vec<(Arc<str>, Acc)> = tab.into_iter().collect();
            rows.sort_by(|a, b| {
                b.1.sum
                    .tokens
                    .cmp(&a.1.sum.tokens)
                    .then_with(|| a.0.cmp(&b.0))
            });
            rows.truncate(MAX_GROUPS);
            rows.into_iter()
                .map(|(key, a)| Group {
                    key: key.to_string(),
                    sessions: a.sessions.len() as u64,
                    top_model: a
                        .models
                        .into_iter()
                        .max_by_key(|(_, n)| *n)
                        .map(|(m, _)| m.to_string()),
                    agent: a.agent,
                    account: a.account.map(|s| s.to_string()),
                    cwd: a
                        .cwds
                        .into_iter()
                        .max_by_key(|(_, n)| *n)
                        .map(|(c, _)| c.to_string()),
                    sum: a.sum,
                })
                .collect()
        });
        Detail {
            days: self.days,
            total: self.total,
            active_days: self.active.len() as u32,
            first_day: self.first_day,
            daily: self.daily,
            hours: self.hours,
            agents,
            models,
            folders,
            sessions,
            partial: partial || self.full,
        }
    }
}
/// `detail_reply`'s work with the clock, the zone and the folders given (tests pass their own).
pub fn detail(
    home: &Path,
    own: &dyn Fn(Agent) -> Option<PathBuf>,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    days: u32,
    filter: &Filter,
    budget: &mut Budget,
) -> Result<Detail, String> {
    if !DETAIL_DAYS.contains(&days) {
        return Err("days must be 1, 7, 30 or 90".into());
    }
    let mut d = Detailer::new(now, days, offset);
    let horizon = (i64::from(days).max(GRID_DAYS) + 1) * DAY;
    rows_with(
        home,
        own,
        now,
        offset,
        budget,
        horizon,
        &mut |agent, id, e| !filter.keeps(agent, id, e) || d.add(agent, id, e),
    )?;
    Ok(d.finish(budget.partial))
}
/// The window's `usage_detail` request (owner and window only, like `account_usage`).
pub fn detail_reply(home: &Path, days: u32, filter: Filter) -> Response {
    let now = now_secs()?;
    let home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    let mut budget = Budget::request();
    budget.link_roots = link_roots(&home);
    let detail = detail(
        &home,
        &own_folder,
        now,
        &local_offset,
        days,
        &filter,
        &mut budget,
    )?;
    Ok(Reply::UsageDetail {
        detail,
        claude_default: claude_default(),
    })
}
/// W35-picker2 S3: `model` in the user's own Claude settings.json, when it is a plain model name or id.
fn claude_default() -> Option<String> {
    let root = crate::accounts::config_home(crate::api::AgentKind::Claude, None)?;
    claude_default_at(&root.join("settings.json"))
}
/// The most of the user's Claude settings.json read for its `model` (Codex round-3 MUST); a longer file names no default.
const CLAUDE_DEFAULT_READ_MAX: u64 = 256 << 10;
/// `claude_default` of one settings file: opened without following a link and without waiting on a FIFO, a regular file
/// only, at most `CLAUDE_DEFAULT_READ_MAX` bytes. The answer is kept by (path, mtime, size), so a request reads the
/// file again only after it changed.
fn claude_default_at(path: &Path) -> Option<String> {
    type Key = (PathBuf, std::time::SystemTime, u64);
    static KEPT: std::sync::Mutex<Option<(Key, Option<String>)>> = std::sync::Mutex::new(None);
    let file = crate::store::open_regular(path).ok()?;
    let meta = file.metadata().ok()?;
    let key = (path.to_path_buf(), meta.modified().ok()?, meta.len());
    if let Some((kept, model)) = KEPT.lock().ok()?.as_ref()
        && *kept == key
    {
        return model.clone();
    }
    let model = crate::store::read_capped(file, CLAUDE_DEFAULT_READ_MAX)
        .ok()
        .and_then(|text| {
            let v: serde_json::Value = serde_json::from_slice(&text).ok()?;
            let model = v["model"].as_str()?;
            (model.len() <= 100
                && !model.is_empty()
                && model
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-._[]".contains(c)))
            .then(|| model.to_string())
        });
    *KEPT.lock().ok()? = Some((key, model.clone()));
    model
}

/// V2-2c limit mark: what one session's screen last showed of its agent's usage limit. In memory only, keyed by
/// (core home, session), so a later screen of that session replaces or clears it and a core restart forgets it. The
/// account comes from the session's own record, never from the screen. An ended session's mark stays until its reset
/// time (`until`), so its account keeps the badge after the session ends; a later mark of the same session replaces it.
struct Mark {
    /// The core home's real path, so `rows` (which canonicalizes its home) finds it without a lookup per row.
    home: PathBuf,
    agent: Agent,
    id: String,
    resets: String,
    until: i64,
    /// The session's latest screen shows it. A hidden mark keeps its first reading, so the same line repainted later
    /// is not read again as the next day.
    shown: bool,
}
static MARKS: Mutex<BTreeMap<(PathBuf, String), Mark>> = Mutex::new(BTreeMap::new());
/// A mark further ahead than this is not believed (Claude's longest window is a week).
const MAX_AHEAD: i64 = 8 * DAY;

/// The screen hook: reads `text`, the screen of session `session` (its agent `kind`, its account folder `config_dir`, none for
/// "Your own") and sets or clears that session's mark. Writes nothing but `MARKS`; takes no other lock.
pub(crate) fn observe_limit(
    home: &Path,
    session: &str,
    kind: AgentKind,
    config_dir: Option<&Path>,
    text: &str,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
) {
    let Some(agent) = agent_of(kind) else {
        return;
    };
    // An account folder is `<home>/accounts/<agent>/<id>` (checked when the session's record loads).
    let id = match config_dir {
        None => crate::accounts::OWN.to_string(),
        Some(folder) => match folder.file_name().and_then(|n| n.to_str()) {
            Some(id) => id.to_string(),
            None => return,
        },
    };
    let found = limit_line(agent, text);
    let key = (home.to_path_buf(), session.to_string());
    let Ok(mut marks) = MARKS.lock() else {
        return;
    };
    // Ended marks of this core's other sessions go here; this session's stays while its screen still shows it, so the
    // map holds at most one mark per session.
    marks.retain(|k, m| k.0 != home || k.1 == session || m.until > now);
    let Some(resets) = found else {
        if let Some(m) = marks.get_mut(&key) {
            m.shown = false;
        }
        return;
    };
    // The same text again keeps its first reading, so a screen left up past its reset is not read as the next day.
    if let Some(m) = marks.get_mut(&key)
        && m.agent == agent
        && m.id == id
        && m.resets == resets
    {
        m.shown = true;
        return;
    }
    match reset_at(agent, &resets, now, offset) {
        Some(until) => {
            marks.insert(
                key,
                Mark {
                    home: fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()),
                    agent,
                    id,
                    resets,
                    until,
                    shown: true,
                },
            );
        }
        None => {
            marks.remove(&key);
        }
    }
}

/// The printed reset of the latest-ending mark on `home`'s account (`agent`, `id`) still ahead of `now`.
fn limit_of(home: &Path, agent: Agent, id: &str, now: i64) -> Option<String> {
    let marks = MARKS.lock().ok()?;
    marks
        .iter()
        .filter(|(_, m)| {
            m.shown && m.agent == agent && m.id == id && m.until > now && m.home == home
        })
        .max_by_key(|(_, m)| m.until)
        .map(|(_, m)| m.resets.clone())
}

/// Ticket 372: session `session`'s own mark on `home` (the core's home as `observe_limit` got it), shown or not, whatever
/// its reset, as (printed reset, reset epoch second, shown): the caller decides what an ended or hidden mark means.
pub(crate) fn session_mark(home: &Path, session: &str) -> Option<(String, i64, bool)> {
    let marks = MARKS.lock().ok()?;
    let m = marks.get(&(home.to_path_buf(), session.to_string()))?;
    Some((m.resets.clone(), m.until, m.shown))
}

/// The reset time an agent printed with its usage limit, from the lowest such line on the screen. Claude Code
/// 2.1.312: `You've hit your <limit> · resets <time> (<zone>)`; Codex 0.161.0: one of `problems.rs`'s limit wordings
/// with `try again at <time>.` (a long line may wrap, so the next two rows are read with it).
fn limit_line(agent: Agent, text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let printed = lines
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, line)| match agent {
            Agent::Claude => {
                let rest = &line[line.find("You've hit your ")?..];
                let time = &rest[rest.find(" \u{b7} resets ")? + " \u{b7} resets ".len()..];
                // Ends at the zone or at a further ` · ` part ("progress saved").
                let end = [" (", " \u{b7} "]
                    .iter()
                    .filter_map(|e| time.find(e))
                    .min()
                    .unwrap_or(time.len());
                Some(time[..end].trim().to_string())
            }
            Agent::Codex => {
                crate::problems::CODEX_LIMIT_PHRASES
                    .iter()
                    .any(|w| line.contains(w))
                    .then_some(())?;
                let joined = lines[i..lines.len().min(i + 3)].concat();
                // A wrap inside "try again at" drops the row's trailing space: "again" then "at", spaces optional.
                let again = ["try again", "Try again"]
                    .iter()
                    .find_map(|a| joined.find(a).map(|n| n + a.len()))?;
                let time = joined[again..]
                    .trim_start()
                    .strip_prefix("at")?
                    .trim_start();
                // No printed time holds a dot; the sentence ends at the first.
                Some(time[..time.find('.')?].trim().to_string())
            }
        })?;
    // Only the characters a printed time uses, and short: a crafted line carries nothing else to the page.
    (!printed.is_empty()
        && printed.len() <= 32
        && printed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | ':' | ',')))
    .then_some(printed)
}

/// `printed` as the epoch second it names in local time (`offset`), when it lies after `now` and within `MAX_AHEAD`.
/// A time without a date is today's, or (Claude, which drops the date within 24 h) tomorrow's when today's passed over
/// an hour ago; a date without a year is this year's, or next year's when it is over a day behind.
fn reset_at(agent: Agent, printed: &str, now: i64, offset: &dyn Fn(i64) -> i64) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let mut words = printed
        .split([' ', ','])
        .filter(|w| !w.is_empty())
        .peekable();
    let (today, year) = {
        let day = (now + offset(now)).div_euclid(DAY);
        (day, civil_from_days(day).0)
    };
    let mut date = None;
    if let Some(month) = words
        .peek()
        .and_then(|w| MONTHS.iter().position(|m| w.to_ascii_lowercase() == *m))
    {
        words.next();
        let day = words.next()?;
        let day: i64 = day
            .trim_end_matches(|c: char| c.is_ascii_alphabetic())
            .parse()
            .ok()
            .filter(|d| (1..=31).contains(d))?;
        let year = match words.peek() {
            Some(w) if w.len() == 4 && w.bytes().all(|b| b.is_ascii_digit()) => {
                let y = w.parse().ok()?;
                words.next();
                Some(y)
            }
            _ => None,
        };
        date = Some((year, month as i64 + 1, day));
    }
    let clock = words.collect::<String>().to_ascii_lowercase();
    let (clock, half) = match clock
        .strip_suffix("am")
        .or_else(|| clock.strip_suffix("pm"))
    {
        Some(c) => (c, Some(clock.ends_with("pm"))),
        None => (clock.as_str(), None),
    };
    let (h, m) = clock.split_once(':').unwrap_or((clock, "0"));
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    if !(0..=59).contains(&m) || !(0..=23).contains(&h) {
        return None;
    }
    let h = match half {
        Some(pm) if (1..=12).contains(&h) => h % 12 + if pm { 12 } else { 0 },
        Some(_) => return None,
        None => h,
    };
    let at = |day: i64| {
        let local = day * DAY + h * 3600 + m * 60;
        local - offset(local)
    };
    let until = match date {
        None => {
            let t = at(today);
            if agent == Agent::Claude && t < now - 3600 {
                at(today + 1)
            } else {
                t
            }
        }
        Some((Some(y), mo, d)) => at(days_from_civil(y, mo, d)),
        Some((None, mo, d)) => {
            let t = at(days_from_civil(year, mo, d));
            if t < now - DAY {
                at(days_from_civil(year + 1, mo, d))
            } else {
                t
            }
        }
    };
    (now < until && until <= now + MAX_AHEAD).then_some(until)
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
/// The civil (year, month, day) of a day since 1970-01-01 (Howard Hinnant).
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn subfolder(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "projects",
        Agent::Codex => "sessions",
    }
}
/// A folder that is itself one, not a link to one.
fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

/// Sums `root`'s transcripts for the local day of `now` and the six before it. `opened` sees each file before it is
/// read. Returns the totals and the largest line buffer the reader held.
pub fn scan(
    root: &Path,
    agent: Agent,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    opened: &mut dyn FnMut(&Path),
) -> (Totals, usize) {
    scan_with(root, agent, now, offset, opened, &mut Budget::request())
}

/// `scan` spending from `budget`; at its limit the walk or the reading stops and `budget.partial` is set.
pub fn scan_with(
    root: &Path,
    agent: Agent,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    opened: &mut dyn FnMut(&Path),
    budget: &mut Budget,
) -> (Totals, usize) {
    let found = scan_all(
        &root.join(subfolder(agent)),
        agent,
        now,
        offset,
        opened,
        budget,
        8 * DAY,
        &mut |_| true,
    );
    (found.totals, found.widest)
}

#[derive(Default)]
struct Scanned {
    totals: Totals,
    widest: usize,
    last_24h: Window,
    last_7d: Window,
    /// The newest record's (time, limit), kept only while its reset is ahead.
    session: Option<(i64, Limit)>,
    weekly: Option<(i64, Limit)>,
    unpriced_models: std::collections::BTreeSet<String>,
}

/// `scan_all` over a followed link, inside `link_cap`; what it used is charged to the request. True when a limit
/// stopped it (the request's own limit also marks the request partial).
#[allow(clippy::too_many_arguments)]
fn scan_linked(
    dir: &Path,
    agent: Agent,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    budget: &mut Budget,
    horizon: i64,
    each: &mut dyn FnMut(&Event) -> bool,
) -> (Scanned, bool) {
    let (e, f, b) = budget.link_cap;
    let request_binds = budget.entries <= e || budget.files <= f || budget.bytes <= b;
    let mut sub = Budget::new(
        e.min(budget.entries),
        f.min(budget.files),
        b.min(budget.bytes),
    );
    let start = (sub.entries, sub.files, sub.bytes);
    let found = scan_all(
        dir,
        agent,
        now,
        offset,
        &mut |_| {},
        &mut sub,
        horizon,
        each,
    );
    budget.entries -= start.0 - sub.entries;
    budget.files -= start.1 - sub.files;
    budget.bytes -= start.2 - sub.bytes;
    budget.partial |= sub.partial && request_binds;
    (found, sub.partial)
}

/// `horizon`: how far back (seconds) a file's last write may be and still be read; `each` sees every counted record and
/// stops the read (partial) by returning false.
#[allow(clippy::too_many_arguments)]
fn scan_all(
    dir: &Path,
    agent: Agent,
    now: i64,
    offset: &dyn Fn(i64) -> i64,
    opened: &mut dyn FnMut(&Path),
    budget: &mut Budget,
    horizon: i64,
    each: &mut dyn FnMut(&Event) -> bool,
) -> Scanned {
    let day_of = |t: i64| (t + offset(t)).div_euclid(DAY);
    let today = day_of(now);
    let first = today - 6;
    // A file last written before the window's first local day (a day of slack for zone changes) holds no line in it.
    let oldest = (first * DAY - offset(now) - DAY).min(now - horizon.max(8 * DAY));
    let mut files = vec![];
    walk(dir, 0, &mut files, budget);
    // Newest first (Codex names its folders by date): when a cap trips, it drops the old rollouts, not the limits.
    files.sort_by(|a, b| b.cmp(a));
    let mut out = Scanned::default();
    let mut seen = HashSet::new();
    let mut buf = Vec::with_capacity(MAX_LINE + 1);
    'files: for path in files {
        // Size and time come from the open handle: the listing is stale by now and an agent can write there.
        let Some((file, meta)) = open_regular(&path) else {
            continue;
        };
        let fresh = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .is_none_or(|t| t.as_secs() as i64 >= oldest);
        if !fresh {
            continue;
        }
        if budget.files == 0 || budget.bytes < meta.len() {
            budget.partial = true;
            break;
        }
        budget.files -= 1;
        budget.bytes -= meta.len();
        opened(&path);
        // Reads no more than the size judged above, so a file that grows meanwhile cannot enlarge the request.
        let mut reader = BufReader::with_capacity(64 << 10, file.take(meta.len()));
        let mut previous_total = None;
        let mut model = None;
        let mut meta = (None, None);
        while let Ok(true) = next_line(&mut reader, &mut buf) {
            let Ok(line) = std::str::from_utf8(&buf) else {
                continue;
            };
            let event = match agent {
                Agent::Claude => claude(line, &mut seen),
                Agent::Codex => {
                    if let Some(m) = codex_model(line) {
                        model = m;
                        continue;
                    }
                    if let Some(m) = codex_meta(line) {
                        meta = m;
                        continue;
                    }
                    if let Some((at, session, weekly)) = codex_limits(line, now) {
                        keep_newest(&mut out.session, at, session);
                        keep_newest(&mut out.weekly, at, weekly);
                    }
                    codex(line, &mut previous_total, &model, &meta)
                }
            };
            if seen.len() > MAX_SEEN {
                budget.partial = true;
                break 'files;
            }
            let Some(e) = event else {
                continue;
            };
            if !each(&e) {
                budget.partial = true;
                break 'files;
            }
            let day = day_of(e.at);
            if (first..=today).contains(&day) {
                out.totals.week += e.tokens;
                if day == today {
                    out.totals.today += e.tokens;
                }
            }
            if e.at > now - 7 * DAY {
                // The page names at most `MAX_GROUPS` unpriced models.
                if let Some(m) = e
                    .model
                    .as_ref()
                    .filter(|m| price_of(m).is_none() && out.unpriced_models.len() < MAX_GROUPS)
                {
                    out.unpriced_models.insert(m.clone());
                }
                out.last_7d.add(&e);
                if e.at > now - DAY {
                    out.last_24h.add(&e);
                }
            }
        }
    }
    out.widest = buf.capacity();
    out
}

fn keep_newest(slot: &mut Option<(i64, Limit)>, at: i64, found: Option<Limit>) {
    if let Some(l) = found
        && slot.is_none_or(|(t, _)| at >= t)
    {
        *slot = Some((at, l));
    }
}

/// The model a Codex rollout's `turn_context` line names; the turns after it are priced with it (none when it names no
/// model of at most `MAX_NAME` bytes).
fn codex_model(line: &str) -> Option<Option<String>> {
    if !line.contains("turn_context") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    (v["type"] == "turn_context").then_some(())?;
    Some(short(&v["payload"]["model"], MAX_NAME))
}

/// A `token_count` event's `rate_limits` as (time, session, weekly): a window of at most 12 h is the session's, a
/// longer one the week's. Taken from the event as written; one already reset by `now` is none.
fn codex_limits(line: &str, now: i64) -> Option<(i64, Option<Limit>, Option<Limit>)> {
    if !line.contains("rate_limits") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let limits = &v["payload"]["rate_limits"];
    if v["payload"]["type"] != "token_count" || !limits.is_object() {
        return None;
    }
    let at = epoch(v["timestamp"].as_str()?)?;
    let (mut session, mut weekly) = (None, None);
    for w in [&limits["primary"], &limits["secondary"]] {
        let (Some(used), Some(resets_at)) = (w["used_percent"].as_f64(), w["resets_at"].as_i64())
        else {
            continue;
        };
        if resets_at <= now {
            continue;
        }
        let limit = Limit {
            left_pct: (100.0 - used).clamp(0.0, 100.0).round() as u8,
            resets_at,
        };
        if w["window_minutes"].as_u64().is_some_and(|m| m <= 720) {
            session = Some(limit);
        } else {
            weekly = Some(limit);
        }
    }
    Some((at, session, weekly))
}

/// The file and its metadata when `path` is a regular file now: never through a link, and non-blocking so a FIFO
/// swapped in after the listing cannot hold the open.
pub fn open_regular(path: &Path) -> Option<(fs::File, fs::Metadata)> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    meta.is_file().then_some((file, meta))
}

/// Regular `.jsonl` files below `dir`, never through a link.
pub(crate) fn walk(dir: &Path, depth: u8, out: &mut Vec<PathBuf>, budget: &mut Budget) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if budget.entries == 0 {
            budget.partial = true;
            return;
        }
        budget.entries -= 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, depth + 1, out, budget);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

/// One line into `buf` (cleared first), at most `MAX_LINE` bytes: a longer line is drained to its newline and left
/// empty. A last line with no newline is returned like any other; a half-written one fails to parse. `false` at EOF.
fn next_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> io::Result<bool> {
    buf.clear();
    let n = reader.take(MAX_LINE as u64 + 1).read_until(b'\n', buf)?;
    if n == 0 {
        return Ok(false);
    }
    if buf.last() == Some(&b'\n') || buf.len() <= MAX_LINE {
        return Ok(true);
    }
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            break;
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(end) => {
                reader.consume(end + 1);
                break;
            }
            None => {
                let all = chunk.len();
                reader.consume(all);
            }
        }
    }
    buf.clear();
    Ok(true)
}

fn claude(line: &str, seen: &mut HashSet<String>) -> Option<Event> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v["type"] != "assistant" {
        return None;
    }
    let at = epoch(v["timestamp"].as_str()?)?;
    let message = &v["message"];
    let usage = &message["usage"];
    let parts = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .map(|k| usage[k].as_u64().unwrap_or(0));
    // A message id is how a resumed or streamed copy is told from a new message; one without cannot be counted once.
    seen.insert(short(&message["id"], MAX_NAME)?)
        .then(|| Event {
            at,
            tokens: parts.iter().sum(),
            parts,
            model: short(&message["model"], MAX_NAME),
            cwd: short(&v["cwd"], MAX_PATH),
            session: short(&v["sessionId"], MAX_NAME),
        })
}

/// Codex repeats a `token_count` event with the same running total; each distinct total adds its `last` turn.
/// `cached_input_tokens` is a part of `input_tokens` and `reasoning_output_tokens` of `output_tokens`, so neither is
/// added again.
/// A Codex rollout's `session_meta` line: its session id and folder, which the turns after it belong to.
fn codex_meta(line: &str) -> Option<(Option<String>, Option<String>)> {
    if !line.contains("session_meta") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    (v["type"] == "session_meta").then_some(())?;
    let p = &v["payload"];
    Some((short(&p["id"], MAX_NAME), short(&p["cwd"], MAX_PATH)))
}

fn codex(
    line: &str,
    previous: &mut Option<u64>,
    model: &Option<String>,
    meta: &(Option<String>, Option<String>),
) -> Option<Event> {
    if !line.contains("token_count") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let payload = &v["payload"];
    if payload["type"] != "token_count" || !payload["info"].is_object() {
        return None;
    }
    let total = payload["info"]["total_token_usage"]["total_tokens"].as_u64()?;
    if previous.replace(total) == Some(total) {
        return None;
    }
    let last = &payload["info"]["last_token_usage"];
    let (input, output) = (
        last["input_tokens"].as_u64().unwrap_or(0),
        last["output_tokens"].as_u64().unwrap_or(0),
    );
    let cached = last["cached_input_tokens"].as_u64().unwrap_or(0).min(input);
    Some(Event {
        at: epoch(v["timestamp"].as_str()?)?,
        tokens: input + output,
        parts: [input - cached, output, 0, cached],
        model: model.clone(),
        session: meta.0.clone(),
        cwd: meta.1.clone(),
    })
}

/// Ticket 1036: what Claude Code last handed its status line command about one account's limits. Claude Code puts
/// `rate_limits` (`five_hour` and `seven_day`, each `used_percentage` and `resets_at`) into the JSON it pipes to that
/// command; Nunchiro's per-session settings name `nunchiro hook statusline` as the command, which passes only
/// `rate_limits` on as a `StatusLine` hook. Percentages and reset times only, no token: kept in memory and in
/// `claude-limits.json` (0600) in the core's home, so the bar has the last numbers after a restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Told {
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<Limit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly: Option<Limit>,
}
const CLAUDE_LIMITS: &str = "claude-limits.json";
/// One writer at a time; a record within this many seconds of the kept one with the same numbers is not written again
/// (a status line runs after every message).
static TOLD: Mutex<()> = Mutex::new(());
const TOLD_QUIET: i64 = 60;

/// Every account's record on `home`, by account id; an unreadable file is none.
pub(crate) fn claude_limits(home: &Path) -> BTreeMap<String, Told> {
    crate::store::open_regular(&home.join(CLAUDE_LIMITS))
        .and_then(|f| crate::store::read_capped(f, 64 << 10))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// A status line's `rate_limits` for the session whose account folder is `config_dir` (none for "Your own"). True when
/// the kept weekly share changed (ticket 1126 runs its rule only then).
pub(crate) fn observe_status(
    home: &Path,
    config_dir: Option<&Path>,
    limits: &Value,
    now: i64,
) -> bool {
    let id = match config_dir {
        None => crate::accounts::OWN.to_string(),
        Some(folder) => match folder.file_name().and_then(|n| n.to_str()) {
            Some(id) => id.to_string(),
            None => return false,
        },
    };
    let (session, weekly) = (
        told_window(&limits["five_hour"]),
        told_window(&limits["seven_day"]),
    );
    if session.is_none() && weekly.is_none() {
        return false;
    }
    let Ok(_one) = TOLD.lock() else {
        return false;
    };
    let mut all = claude_limits(home);
    // A push may carry one window only; the other one stays while its reset is still ahead.
    let kept = |new: Option<Limit>, old: Option<Limit>| new.or(old.filter(|l| l.resets_at > now));
    let before = all.get(&id).copied();
    let (session, weekly) = (
        kept(session, before.and_then(|t| t.session)),
        kept(weekly, before.and_then(|t| t.weekly)),
    );
    let told = Told {
        at: now,
        session,
        weekly,
    };
    if all
        .get(&id)
        .is_some_and(|t| (t.session, t.weekly) == (session, weekly) && now - t.at < TOLD_QUIET)
    {
        return false;
    }
    all.insert(id, told);
    let path = home.join(CLAUDE_LIMITS);
    if crate::store::atomic_write(&path, &serde_json::to_vec(&all).unwrap_or_default()).is_ok() {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    before.and_then(|t| t.weekly) != weekly
}
/// `{"used_percentage": 37.5, "resets_at": 1763740800}` (epoch seconds; an ISO time is read too) as a `Limit`.
fn told_window(w: &Value) -> Option<Limit> {
    let used = w["used_percentage"].as_f64().filter(|u| u.is_finite())?;
    let resets_at = match &w["resets_at"] {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(t) => t.parse::<i64>().ok().or_else(|| epoch(t)),
        _ => None,
    }?;
    // Milliseconds, if a later Claude sends them.
    let resets_at = if resets_at > 10_000_000_000 {
        resets_at / 1000
    } else {
        resets_at
    };
    Some(Limit {
        left_pct: (100.0 - used.clamp(0.0, 100.0)).round() as u8,
        resets_at,
    })
}

/// `2026-10-24T01:00:05.000Z` as epoch seconds; any other shape is `None`. V2-CF4 reads a launch record's own
/// timestamp through the same parser, so the two never disagree about what a transcript time means.
pub(crate) fn epoch(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || !s.ends_with('Z')
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d) * DAY + n(11..13)? * 3600 + n(14..16)? * 60 + n(17..19)?)
}

#[cfg(test)]
mod tests;
