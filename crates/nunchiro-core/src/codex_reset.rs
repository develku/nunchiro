//! Codex reset tickets (needs 225; design docs/design/usage-1106/codex-reset.md). A third outbound caller, through the
//! user's own installed `codex` only: with `settings.json` `features` `usage.codex_resets` on (off by default) the core
//! starts `codex <ARGV>` once for one request, with the account's `CODEX_HOME`, sends `initialize`, `initialized` and
//! one `account/rateLimits/read` or `account/rateLimitResetCredit/consume` (a fresh idempotency key each use), and kills
//! it. Nunchiro never reads `auth.json` or a token and never calls a ChatGPT or OpenAI host itself; codex's stderr is
//! dropped and its answers are reduced to a count, an expiry and an outcome word, held in memory for the reply only.
//! The use log (`codex-resets.json`) keeps who, when, why, the policy rule and the outcome word: never a count, an
//! expiry, a percentage, an account id or anything codex printed. There is no timer: a read is the owner's Refresh
//! press, a use the owner's confirmed click or an agent's ask under the owner's policy.
//!
//! Adapted from Orca (MIT License, Copyright (c) 2026 Lovecast Inc.; source 1.4.214): the read-only app-server argv
//! (`src/main/codex-cli/codex-read-only-app-server-args.ts`), the line protocol and its 30 s / 10 s timeouts
//! (`src/main/rate-limits/codex-rpc-rate-limit-probe.ts`, `codex-fetcher.ts:38-41`), the earliest available expiry
//! (`codex-reset-credit-client.ts:65-99`) and the four outcome names (`:179-193`). Not lifted: Orca's `auth.json` read
//! and its direct `wham/*` HTTPS calls (THIRD_PARTY_NOTICES.md).
use crate::{
    accounts::{self, Agent},
    api::{Reply, Response},
    grants::Caller,
    queue::OwnerAsk,
    sessions::Sessions,
    store,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The fixed argument vector after `codex`: read-only sandbox, never ask, no plugins (Orca's).
pub const ARGV: [&str; 9] = [
    "-c",
    "approval_policy=never",
    "-c",
    "features.plugins=false",
    "-s",
    "read-only",
    "-a",
    "never",
    "app-server",
];
const INIT_WAIT: Duration = Duration::from_secs(30);
const READ_WAIT: Duration = Duration::from_secs(10);
const USE_WAIT: Duration = Duration::from_secs(30);
/// A line codex sends past this, or more than READ_MAX in all, is not read on: the call fails.
const LINE_MAX: u64 = 1 << 20;
const READ_MAX: u64 = 8 << 20;
const LOG: &str = "codex-resets.json";
const LOG_FILE_MAX: u64 = 1 << 20;
const LOG_KEEP: usize = 200;
const LOG_DAYS: u64 = 90;
const REASON_MAX: usize = 200;
const TITLE_MAX: usize = 80;
const DAY: i64 = 86_400;
/// One use (its consume and its log line) at a time in this core, and every log write.
static GATE: Mutex<()> = Mutex::new(());

pub const OFF: &str = "Codex resets are off (Settings > Accounts & Usage > Show Codex resets)";
const UNKNOWN: &str = "the result is unknown; refresh before trying again";
const LOG_DOWN: &str =
    "the Codex reset log cannot be read or written, so no reset is used without the owner";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum How {
    /// The owner's own click (window or owner socket).
    Owner,
    /// The owner allowed an agent's ask in the Decisions widget.
    Approved,
    /// Used for an agent under "allow ahead" without asking.
    Auto,
    /// An agent's ask, waiting in the Decisions widget.
    Asked,
    Denied,
    Refused,
}

/// One line of the use log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "CodexResetEntry"))]
pub struct Entry {
    /// Unix seconds.
    pub at: u64,
    /// The account's label; "Your own" when `own`.
    pub account: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub own: bool,
    pub how: How,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The policy rule that decided it (`off`, `conditions`, `expiring`, `weekly_not_used_up`, `week_max`,
    /// `keep_last`, `none_left`, `ask`, `account_gone`, `codex_error`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    /// The agent's reason, cleaned and capped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// `reset`, `nothing_to_reset`, `no_credit`, `already_redeemed`, `unknown` (maybe spent) or `failed` (not spent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

/// What a read shows: the available count and the earliest expiry (Unix seconds) among available credits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Summary {
    pub available: u64,
    pub next_expires_at: Option<i64>,
}

/// A read as the policy needs it; `weekly_used` is the weekly window's used percentage.
#[derive(Debug, Clone, PartialEq)]
struct Limits {
    available: u64,
    next_expires_at: Option<i64>,
    /// The id of that earliest available credit (held for one use, never stored or shown).
    next_id: Option<String>,
    weekly_used: Option<f64>,
}

/// The account a request is for: its folder (`None` = "Your own") and label.
#[derive(Debug, Clone)]
struct Target {
    folder: Option<PathBuf>,
    label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Off,
    Ask,
    Allow,
}
/// The owner's settings (`settings.json` `features`, written only through the owner's `quit_settings`).
#[derive(Debug, Clone, PartialEq)]
struct Policy {
    on: bool,
    mode: Mode,
    weekly_only: bool,
    week_max: u64,
    keep_last: bool,
    expiring: bool,
}
fn policy(home: &Path) -> Policy {
    let f = crate::store::read_settings(&home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .map(|v| v["features"].clone())
        .unwrap_or(Value::Null);
    let flag = |k: &str, d: bool| f[k].as_bool().unwrap_or(d);
    Policy {
        on: flag("usage.codex_resets", false),
        mode: match f["usage.codex_reset_agent"].as_str() {
            Some("off") => Mode::Off,
            Some("allow") => Mode::Allow,
            _ => Mode::Ask,
        },
        weekly_only: flag("usage.codex_reset_weekly_only", true),
        week_max: f["usage.codex_reset_week_max"].as_u64().unwrap_or(2).min(9),
        keep_last: flag("usage.codex_reset_keep_last", true),
        expiring: flag("usage.codex_reset_expiring", true),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Use(&'static str),
    Ask(&'static str),
    Refuse(&'static str),
}
/// "Allow ahead": a ticket expiring within 3 days is used without asking (it would be lost anyway); otherwise every
/// checked condition must hold, and a failed one sends the ask to the owner as "ask every time" does.
fn decide(p: &Policy, r: &Limits, auto_this_week: u64, now: i64) -> Verdict {
    if r.available == 0 {
        return Verdict::Refuse("none_left");
    }
    if p.expiring && r.next_expires_at.is_some_and(|t| t <= now + 3 * DAY) {
        return Verdict::Use("expiring");
    }
    if p.weekly_only && !r.weekly_used.is_some_and(|u| u >= 100.0) {
        return Verdict::Ask("weekly_not_used_up");
    }
    if p.week_max > 0 && auto_this_week >= p.week_max {
        return Verdict::Ask("week_max");
    }
    if p.keep_last && r.available < 2 {
        return Verdict::Ask("keep_last");
    }
    Verdict::Use("conditions")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fail {
    NoCodex,
    NotSignedIn,
    TooOld,
    /// No answer in time.
    Slow,
    /// Codex exited, or sent something that is not its protocol.
    Gone,
    /// Another JSON-RPC error.
    Refused,
    /// The setting changed while codex started: the request was not sent.
    Withdrawn,
}
impl Fail {
    fn text(self) -> &'static str {
        match self {
            Fail::NoCodex => "codex is not installed (Nunchiro uses your own codex)",
            Fail::NotSignedIn => "codex is not signed in for this account",
            Fail::TooOld => "this codex is too old for resets; update codex",
            Fail::Slow => "codex did not answer in time",
            Fail::Gone => "codex stopped before it answered",
            Fail::Refused => "codex refused the request",
            Fail::Withdrawn => "the owner changed the setting before the reset was used",
        }
    }
}

#[cfg(test)]
thread_local! {
    /// A test's stand-in for the user's `codex`, for the thread that runs the request only.
    static CODEX: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}
fn codex_program() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = CODEX.with(|c| c.borrow().clone()) {
        return p;
    }
    PathBuf::from("codex")
}
/// One request through a fresh `codex app-server`; `still` is asked once codex has started (its start may take 30 s),
/// right before the request is sent. `Err.1` says whether the request itself was sent (a use whose answer never came
/// may have been spent).
fn rpc(
    folder: Option<&Path>,
    method: &str,
    params: Value,
    wait: Duration,
    still: &dyn Fn() -> bool,
) -> Result<Value, (Fail, bool)> {
    let env = accounts::probe_env(Agent::Codex, folder, |k| std::env::var_os(k));
    let name = codex_program();
    let program = crate::process::resolve_program(&name, crate::process::env_path(&env));
    let mut command = crate::process::command(program);
    command
        .arg0(name) // argv[0] stays the bare name the child saw before
        .args(ARGV)
        .env_clear()
        .envs(env);
    app_server(command, INIT_WAIT, method, params, wait, still, None)
}
/// `rpc`'s exchange with the `codex app-server` that `command` starts (its program, arguments and environment), for
/// the reset reader and for the start check of ticket 1150 (`outward::codex_runs_hook`). `init_wait`: how long its
/// answer to `initialize` may take. `until`: an absolute end for the whole exchange, start included, when set.
pub(crate) fn app_server(
    mut command: std::process::Command,
    init_wait: Duration,
    method: &str,
    params: Value,
    wait: Duration,
    still: &dyn Fn() -> bool,
    until: Option<Instant>,
) -> Result<Value, (Fail, bool)> {
    let by = |wait: Duration| {
        let relative = Instant::now() + wait;
        until.map_or(relative, |u| u.min(relative))
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn().map_err(|e| {
        let f = if e.kind() == std::io::ErrorKind::NotFound {
            Fail::NoCodex
        } else {
            Fail::Gone
        };
        (f, false)
    })?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        end(child);
        return Err((Fail::Gone, false));
    };
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0;
        loop {
            let mut line = Vec::new();
            match (&mut reader)
                .take(LINE_MAX + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) | Err(_) => return,
                Ok(n) if n as u64 > LINE_MAX || total + n as u64 > READ_MAX => return,
                Ok(n) => {
                    total += n as u64;
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            }
        }
    });
    let mut sent = false;
    let result = (|| {
        let init = json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "nunchiro", "title": null, "version": env!("CARGO_PKG_VERSION")},
            "capabilities": null}});
        line(&mut stdin, &init)?;
        answer(&rx, 1, by(init_wait))?;
        line(&mut stdin, &json!({"method": "initialized"}))?;
        if !still() {
            return Err(Fail::Withdrawn);
        }
        line(
            &mut stdin,
            &json!({"id": 2, "method": method, "params": params}),
        )?;
        sent = true;
        answer(&rx, 2, by(wait))
    })();
    end(child);
    result.map_err(|f| (f, sent))
}
/// How long `end` waits for the killed codex to be reaped.
const REAP_WAIT: Duration = Duration::from_secs(2);
/// Ends codex and anything it started: its group, and the child itself, which may have left that group (Codex look on
/// ticket 1150: the group's kill then misses it and a plain wait never returned). The wait is bounded, so no caller
/// hangs on a codex that does not die; one still there after `REAP_WAIT` is reaped by a thread of its own.
fn end(mut child: std::process::Child) {
    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
    let _ = child.kill();
    let until = Instant::now() + REAP_WAIT;
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() >= until {
            thread::spawn(move || child.wait());
            return;
        }
        thread::sleep(Duration::from_millis(2));
    }
}
fn line(stdin: &mut impl Write, v: &Value) -> Result<(), Fail> {
    stdin
        .write_all(format!("{v}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|_| Fail::Gone)
}
/// The result of the answer to request `id`; notifications and other ids are skipped.
fn answer(rx: &mpsc::Receiver<Vec<u8>>, id: u64, until: Instant) -> Result<Value, Fail> {
    loop {
        let left = until.saturating_duration_since(Instant::now());
        let bytes = rx.recv_timeout(left).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => Fail::Slow,
            mpsc::RecvTimeoutError::Disconnected => Fail::Gone,
        })?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
            return Err(Fail::Gone);
        };
        if v["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(e) = v.get("error") {
            return Err(error_kind(e));
        }
        return v.get("result").cloned().ok_or(Fail::Gone);
    }
}
/// A JSON-RPC error as one fixed kind; codex's own message only picks the kind and is never shown or kept.
fn error_kind(e: &Value) -> Fail {
    let message = e["message"].as_str().unwrap_or("").to_lowercase();
    if e["code"].as_i64() == Some(-32601) || message.contains("unknown method") {
        Fail::TooOld
    } else if [
        "auth",
        "sign in",
        "signed in",
        "log in",
        "logged in",
        "login",
    ]
    .iter()
    .any(|w| message.contains(w))
    {
        Fail::NotSignedIn
    } else {
        Fail::Refused
    }
}

/// `account/rateLimits/read`'s result reduced to what the page and the policy use.
fn parse_read(v: &Value) -> Limits {
    let credits = &v["rateLimitResetCredits"];
    let next = credits["credits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["status"] == "available")
        .filter_map(|c| Some((c["expiresAt"].as_i64()?, c["id"].as_str())))
        .min_by_key(|(at, _)| *at);
    let limits = &v["rateLimits"];
    let weekly = [&limits["primary"], &limits["secondary"]]
        .into_iter()
        .find(|w| {
            w["windowDurationMins"]
                .as_u64()
                .is_some_and(|m| m >= 7 * 24 * 60)
        })
        .unwrap_or(&limits["secondary"]);
    Limits {
        available: credits["availableCount"].as_u64().unwrap_or(0),
        next_expires_at: next.map(|(at, _)| at),
        next_id: next.and_then(|(_, id)| id.map(str::to_string)),
        weekly_used: weekly["usedPercent"].as_f64(),
    }
}
fn read(t: &Target) -> Result<Limits, String> {
    rpc(
        t.folder.as_deref(),
        "account/rateLimits/read",
        json!({}),
        READ_WAIT,
        &|| true,
    )
    .map(|v| parse_read(&v))
    .map_err(|(f, _)| f.text().to_string())
}

fn gate() -> std::sync::MutexGuard<'static, ()> {
    GATE.lock().unwrap_or_else(|e| e.into_inner())
}
/// One use through codex with a fresh key (and `credit` when the policy picked that one), logged as `entry`: first as
/// `unknown` (maybe spent, so a lost answer or a crash still counts), then with its outcome word. An automatic use
/// whose line cannot be written is not made. `still` is the setting asked again once codex has started; when it says
/// no, nothing is sent, the reserved line is taken back and the error is `Fail::Withdrawn`'s text. The caller holds the
/// gate.
fn consume_locked(
    home: &Path,
    t: &Target,
    credit: Option<&str>,
    entry: Entry,
    still: &dyn Fn() -> bool,
) -> Result<String, String> {
    let key = store::new_id()?;
    let reserved = Entry {
        outcome: Some("unknown".into()),
        ..entry
    };
    if let Err(err) = append_locked(home, reserved.clone()) {
        eprintln!("codex reset log: {err}");
        if reserved.how == How::Auto {
            return Err(LOG_DOWN.into());
        }
    }
    let mut params = json!({"idempotencyKey": key});
    if let Some(id) = credit {
        params["creditId"] = id.into();
    }
    let r = rpc(
        t.folder.as_deref(),
        "account/rateLimitResetCredit/consume",
        params,
        USE_WAIT,
        still,
    );
    if let Err((Fail::Withdrawn, _)) = r {
        report(settle_locked(home, &reserved, None));
        return Err(Fail::Withdrawn.text().into());
    }
    let outcome = match &r {
        Ok(v) => match v["outcome"].as_str() {
            Some("reset") => "reset",
            Some("nothingToReset") => "nothing_to_reset",
            Some("noCredit") => "no_credit",
            Some("alreadyRedeemed") => "already_redeemed",
            _ => "unknown",
        },
        Err((Fail::Slow | Fail::Gone, true)) => "unknown",
        Err(_) => "failed",
    };
    report(settle_locked(home, &reserved, Some(outcome)));
    match r {
        Ok(_) if outcome != "unknown" => Ok(outcome.into()),
        Ok(_) | Err((Fail::Slow | Fail::Gone, true)) => Err(UNKNOWN.into()),
        Err((f, _)) => Err(f.text().into()),
    }
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
/// Text from an agent or a session label, safe to show: control and bidi/format characters dropped, capped, trimmed.
fn clean(text: &str, max: usize) -> Option<String> {
    let out: String = text
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
        .take(max)
        .collect();
    let out = out.trim();
    (!out.is_empty()).then(|| out.to_string())
}
fn entry(t: &Target, how: How) -> Entry {
    Entry {
        at: now_s(),
        account: t.label.clone(),
        own: t.folder.is_none(),
        how,
        session: None,
        title: None,
        rule: None,
        why: None,
        outcome: None,
    }
}

/// What is wrong with the log, for the Usage page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct LogProblem {
    /// The log file cannot be read now (the next log write moves it aside).
    pub unreadable: bool,
    /// When a log that could not be read was moved aside within the last 7 days (Unix seconds): agents' automatic
    /// uses are refused until 7 days after, as their weekly count went with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_aside_at: Option<u64>,
}
/// The stored log, newest first (a missing, oversized or unreadable file reads as empty), and what is wrong with it.
pub fn log(home: &Path) -> (Vec<Entry>, Option<LogProblem>) {
    let read = read_log(home);
    let set_aside_at = set_aside(home, now_s());
    let problem = (read.is_err() || set_aside_at.is_some()).then_some(LogProblem {
        unreadable: read.is_err(),
        set_aside_at,
    });
    (read.unwrap_or_default(), problem)
}
/// The newest `codex-resets.json.bad-<ts>` from the last 7 days.
fn set_aside(home: &Path, now: u64) -> Option<u64> {
    let prefix = format!("{LOG}.bad-");
    fs::read_dir(home)
        .ok()?
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_prefix(&prefix)?
                .parse::<u64>()
                .ok()
        })
        .filter(|at| at + 7 * 86_400 > now)
        .max()
}
/// The log to write on, under the gate: one that cannot be read is moved aside as `codex-resets.json.bad-<ts>` (kept for
/// the owner, never read again) and logging starts over.
fn read_log_locked(home: &Path) -> Result<Vec<Entry>, String> {
    read_log(home).or_else(|err| {
        eprintln!("codex reset log: {err}; moved aside");
        fs::rename(home.join(LOG), home.join(format!("{LOG}.bad-{}", now_s())))
            .map(|_| vec![])
            .map_err(|e| e.to_string())
    })
}
/// The stored log, newest first: a missing file is empty, one that cannot be read or parsed is an error (the weekly cap
/// is counted from it, and a write never replaces it).
fn read_log(home: &Path) -> Result<Vec<Entry>, String> {
    let file = match crate::store::open_regular(&home.join(LOG)) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut bytes = vec![];
    file.take(LOG_FILE_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LOG_FILE_MAX {
        return Err("the log is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
/// A log write outside a use: a failure is reported on stderr, never fatal.
fn append(home: &Path, e: Entry) {
    let _gate = gate();
    report(append_locked(home, e));
}
fn report(written: Result<(), String>) {
    if let Err(err) = written {
        eprintln!("codex reset log: {err}");
    }
}
fn append_locked(home: &Path, e: Entry) -> Result<(), String> {
    let mut all = read_log_locked(home)?;
    all.insert(0, e);
    save_locked(home, all)
}
/// A use's reserved line (`unknown`) gets its outcome; without one (its write failed) the line is added. `None` (the
/// use was never sent) takes the reserved line back.
fn settle_locked(home: &Path, reserved: &Entry, outcome: Option<&str>) -> Result<(), String> {
    let mut all = read_log_locked(home)?;
    let at = all.iter().position(|x| x == reserved);
    match (at, outcome) {
        (Some(i), None) => drop(all.remove(i)),
        (None, None) => return Ok(()),
        (Some(i), Some(o)) => all[i].outcome = Some(o.into()),
        (None, Some(o)) => all.insert(
            0,
            Entry {
                outcome: Some(o.into()),
                ..reserved.clone()
            },
        ),
    }
    save_locked(home, all)
}
/// Keeps, within LOG_DAYS, the newest LOG_KEEP uses (entries with an outcome) and the newest LOG_KEEP other lines, so a
/// flood of asks never pushes a use out; an automatic use the weekly cap counts is never dropped by those numbers, so
/// a flood of uses that spent nothing never pushes a spend out of the count.
fn save_locked(home: &Path, all: Vec<Entry>) -> Result<(), String> {
    let now = now_s();
    let oldest = now.saturating_sub(LOG_DAYS * 86_400);
    let (mut uses, mut other) = (0, 0);
    let all: Vec<Entry> = all
        .into_iter()
        .filter(|x| x.at >= oldest)
        .filter(|x| {
            if counts(x, now) {
                return true;
            }
            let n = if x.outcome.is_some() {
                &mut uses
            } else {
                &mut other
            };
            *n += 1;
            *n <= LOG_KEEP
        })
        .collect();
    serde_json::to_vec_pretty(&all)
        .map_err(|e| e.to_string())
        .and_then(|b| store::write_capped(&home.join(LOG), &b, LOG_FILE_MAX))
}
/// An automatic use this week that may have spent a ticket: `reset`, or `unknown` (a reserved line never settled, or an
/// answer that never came).
fn counts(e: &Entry, now: u64) -> bool {
    e.how == How::Auto
        && matches!(e.outcome.as_deref(), Some("reset" | "unknown"))
        && e.at + 7 * 86_400 > now
}
/// Automatic uses this week that may have spent a ticket. A log that cannot be read, or one moved aside this week (its
/// count is lost), is an error: the caller refuses. The caller holds the gate.
fn auto_uses_this_week(home: &Path, now: u64) -> Result<u64, String> {
    let all = read_log_locked(home)?;
    if set_aside(home, now).is_some() {
        return Err(LOG_DOWN.into());
    }
    Ok(all.iter().filter(|e| counts(e, now)).count() as u64)
}

/// The owner's account pick: `own`, or a registered Codex account id (never a path).
fn owner_target(home: &Path, id: &str) -> Result<Target, String> {
    if id == accounts::OWN {
        return Ok(Target {
            folder: None,
            label: accounts::own_label(home, Agent::Codex),
        });
    }
    let (folder, label) = accounts::by_id(home, Agent::Codex, id)?;
    Ok(Target {
        folder: Some(folder),
        label,
    })
}
/// An ask's account again at answer time: still registered, or "Your own".
fn target_again(home: &Path, folder: Option<&Path>, label: &str) -> Result<Target, String> {
    match folder {
        None => Ok(Target {
            folder: None,
            label: label.into(),
        }),
        Some(f) => accounts::folder_again(home, Agent::Codex, f).map(|(folder, label)| Target {
            folder: Some(folder),
            label,
        }),
    }
}

/// The owner's three requests (window or owner socket): read, use, log.
pub(crate) fn owner(home: &Path, request: crate::api::Request) -> Response {
    use crate::api::Request;
    match request {
        Request::CodexResetRead { account } => owner_read(home, &account),
        Request::CodexResetUse { account, .. } => {
            owner_use(home, account.as_deref().unwrap_or(accounts::OWN))
        }
        Request::CodexResetLog => {
            let (entries, problem) = log(home);
            Ok(Reply::CodexResetLog { entries, problem })
        }
        _ => Err("not a codex reset request".into()),
    }
}
/// The owner's Refresh: one read for account `id`.
pub(crate) fn owner_read(home: &Path, id: &str) -> Response {
    if !policy(home).on {
        return Err(OFF.into());
    }
    let t = owner_target(home, id)?;
    let r = read(&t)?;
    Ok(Reply::CodexResets {
        account: id.into(),
        available: r.available,
        next_expires_at: r.next_expires_at,
    })
}
/// The owner's confirmed "Use a reset" (the window's confirm, or the CLI's `--yes`): one use, then one read again.
pub(crate) fn owner_use(home: &Path, id: &str) -> Response {
    if !policy(home).on {
        return Err(OFF.into());
    }
    let t = owner_target(home, id)?;
    let outcome = {
        let _held = gate();
        consume_locked(home, &t, None, entry(&t, How::Owner), &|| policy(home).on)
    }?;
    let after = read(&t).ok().map(|r| Summary {
        available: r.available,
        next_expires_at: r.next_expires_at,
    });
    Ok(Reply::CodexResetUsed { outcome, after })
}

/// An agent's ask (the `nunchiro account codex-reset` CLI from a session, after `check_agent`), under the owner's
/// policy. Its account is its own session's Codex account, or "Your own" for any other session; the registry lock is
/// held only to look the caller up and to file the owner item, never while codex runs.
pub(crate) fn agent_use(
    registry: &Mutex<Sessions>,
    home: &Path,
    caller: &Caller,
    reason: &str,
) -> Response {
    let (title, folder) = registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .codex_reset_caller(&caller.id)
        .ok_or("operation not granted")?;
    let p = policy(home);
    if !p.on {
        return Err(OFF.into());
    }
    let t = match folder {
        None => Target {
            folder: None,
            label: accounts::own_label(home, Agent::Codex),
        },
        Some(f) => target_again(home, Some(&f), "")?,
    };
    let why = clean(reason, REASON_MAX);
    let base = Entry {
        session: Some(caller.id.clone()),
        title: clean(&title, TITLE_MAX),
        why: why.clone(),
        ..entry(&t, How::Refused)
    };
    let refuse = |rule: &str, text: &str| -> Response {
        append(
            home,
            Entry {
                rule: Some(rule.into()),
                ..base.clone()
            },
        );
        Err(text.into())
    };
    let ask = |rule: &str| -> Response {
        let item = registry
            .lock()
            .map_err(|_| "session registry unavailable")?
            .queue
            .ask_owner(
                &caller.id,
                OwnerAsk::CodexReset {
                    folder: t.folder.clone(),
                    account: t.label.clone(),
                    reason: why.clone().unwrap_or_default(),
                },
            )?;
        append(
            home,
            Entry {
                how: How::Asked,
                rule: Some(rule.into()),
                ..base.clone()
            },
        );
        Ok(Reply::Waiting { item })
    };
    by_policy(home, &t, &base, &refuse, &ask)
}
/// An agent's ask decided on the owner's policy: refused, sent to the owner (`ask`), or used under "allow ahead". The
/// whole policy is read once per decision and must be unchanged right before the consume is sent (codex's start may
/// take 30 s): if the owner changed any of it ("keep the last one", the weekly cap, the mode, ...), nothing is sent and
/// the ask is decided again from the start, as a fresh one.
fn by_policy(
    home: &Path,
    t: &Target,
    base: &Entry,
    refuse: &dyn Fn(&str, &str) -> Response,
    ask: &dyn Fn(&str) -> Response,
) -> Response {
    const NO_AGENTS: &str = "the owner does not let agents use Codex resets";
    loop {
        let p = policy(home);
        if !p.on {
            return refuse("off", OFF);
        }
        match p.mode {
            Mode::Off => return refuse("off", NO_AGENTS),
            Mode::Ask => return ask("ask"),
            Mode::Allow => {}
        }
        // Read, decide and use under one gate: two asks at once cannot both pass "keep the last one" or the cap.
        let held = gate();
        let r = match read(t) {
            Ok(r) => r,
            Err(e) => {
                drop(held);
                return refuse("codex_error", &e);
            }
        };
        let unchanged = || policy(home) == p;
        // The owner may have changed the policy while this ask waited on the gate or on codex.
        if !unchanged() {
            continue;
        }
        let now = now_s();
        let Ok(used) = auto_uses_this_week(home, now) else {
            drop(held);
            return refuse("log", LOG_DOWN);
        };
        let rule = match decide(&p, &r, used, now as i64) {
            Verdict::Use(rule) => rule,
            Verdict::Refuse(rule) => {
                drop(held);
                return refuse(rule, "no Codex reset is left on this account");
            }
            Verdict::Ask(rule) => {
                drop(held);
                return ask(rule);
            }
        };
        // The expiring rule spends that very ticket; otherwise codex's backend picks the next one.
        let credit = (rule == "expiring")
            .then_some(r.next_id.as_deref())
            .flatten();
        let outcome = consume_locked(
            home,
            t,
            credit,
            Entry {
                how: How::Auto,
                rule: Some(rule.into()),
                ..base.clone()
            },
            // Asked again once codex has started, right before the consume is sent.
            &unchanged,
        );
        drop(held);
        if matches!(&outcome, Err(e) if e == Fail::Withdrawn.text()) {
            continue;
        }
        return Ok(Reply::CodexResetUsed {
            outcome: outcome?,
            after: None,
        });
    }
}

/// The owner answered an agent's ask (the registry lock is held by the caller): on a thread of its own, under the gate
/// (a use may hold it while codex takes 30 s), Allow spends one and Deny logs it. The setting and the account are
/// checked again first.
pub(crate) fn answered(
    home: &Path,
    ask: &OwnerAsk,
    session: &str,
    title: Option<&str>,
    allow: bool,
) {
    let OwnerAsk::CodexReset {
        folder,
        account,
        reason,
    } = ask
    else {
        return;
    };
    let base = Entry {
        session: Some(session.into()),
        title: title.and_then(|t| clean(t, TITLE_MAX)),
        why: clean(reason, REASON_MAX),
        ..entry(
            &Target {
                folder: folder.clone(),
                label: account.clone(),
            },
            How::Denied,
        )
    };
    let home = home.to_path_buf();
    let folder = folder.clone();
    let account = account.clone();
    // Off the registry lock: the gate may be held by a use for up to a minute.
    thread::spawn(move || {
        let _held = gate();
        if !allow {
            return report(append_locked(&home, base));
        }
        if !policy(&home).on {
            return report(append_locked(
                &home,
                Entry {
                    how: How::Refused,
                    rule: Some("off".into()),
                    ..base
                },
            ));
        }
        match target_again(&home, folder.as_deref(), &account) {
            Ok(t) => {
                let approved = Entry {
                    how: How::Approved,
                    ..base.clone()
                };
                let r = consume_locked(&home, &t, None, approved, &|| policy(&home).on);
                if matches!(&r, Err(e) if e == Fail::Withdrawn.text()) {
                    report(append_locked(
                        &home,
                        Entry {
                            how: How::Refused,
                            rule: Some("off".into()),
                            ..base
                        },
                    ));
                }
            }
            Err(_) => report(append_locked(
                &home,
                Entry {
                    how: How::Refused,
                    rule: Some("account_gone".into()),
                    ..base
                },
            )),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_on() -> Policy {
        Policy {
            on: true,
            mode: Mode::Allow,
            weekly_only: true,
            week_max: 2,
            keep_last: true,
            expiring: true,
        }
    }
    fn r(available: u64, next: Option<i64>, weekly: Option<f64>) -> Limits {
        Limits {
            available,
            next_expires_at: next,
            next_id: None,
            weekly_used: weekly,
        }
    }

    // Allow ahead (needs 225): each checked condition, the expiring exception and the empty account.
    #[test]
    fn decide_follows_each_condition() {
        let p = policy_on();
        let now = 1_000_000;
        let far = Some(now + 9 * DAY);
        assert_eq!(
            decide(&p, &r(2, far, Some(100.0)), 0, now),
            Verdict::Use("conditions")
        );
        assert_eq!(
            decide(&p, &r(2, far, Some(99.5)), 0, now),
            Verdict::Ask("weekly_not_used_up")
        );
        assert_eq!(
            decide(&p, &r(2, far, None), 0, now),
            Verdict::Ask("weekly_not_used_up")
        );
        assert_eq!(
            decide(&p, &r(2, far, Some(100.0)), 2, now),
            Verdict::Ask("week_max")
        );
        assert_eq!(
            decide(&p, &r(1, far, Some(100.0)), 0, now),
            Verdict::Ask("keep_last")
        );
        assert_eq!(
            decide(&p, &r(0, far, Some(100.0)), 0, now),
            Verdict::Refuse("none_left")
        );
        // Expiring within 3 days: used even as the last one, past the weekly cap, with the weekly window not used up.
        let soon = Some(now + 3 * DAY);
        assert_eq!(
            decide(&p, &r(1, soon, Some(10.0)), 5, now),
            Verdict::Use("expiring")
        );
        let off = Policy {
            expiring: false,
            ..p.clone()
        };
        assert_eq!(
            decide(&off, &r(1, soon, Some(10.0)), 5, now),
            Verdict::Ask("weekly_not_used_up")
        );
        // Unchecked conditions do not apply; 0 means no weekly cap.
        let loose = Policy {
            weekly_only: false,
            week_max: 0,
            keep_last: false,
            ..p
        };
        assert_eq!(
            decide(&loose, &r(1, far, None), 50, now),
            Verdict::Use("conditions")
        );
    }

    // The earliest expiry is among available credits only; the weekly window is the one 7 days long.
    #[test]
    fn parse_read_takes_available_credits_and_the_weekly_window() {
        let v = json!({
            "rateLimits": {"primary": {"usedPercent": 100.0, "windowDurationMins": 10080}, "secondary": {"usedPercent": 5.0, "windowDurationMins": 300}},
            "rateLimitResetCredits": {"availableCount": 3, "credits": [
                {"status": "redeemed", "expiresAt": 10}, {"status": "available", "expiresAt": 50},
                {"status": "available", "expiresAt": 30}, {"status": "available", "expiresAt": null}]}});
        let got = parse_read(&v);
        assert_eq!(got.next_id, None, "the fixture credits carry no id");
        assert_eq!(got, r(3, Some(30), Some(100.0)));
        let with_id = json!({"rateLimitResetCredits": {"availableCount": 2, "credits": [
            {"id": "late", "status": "available", "expiresAt": 90}, {"id": "soon", "status": "available", "expiresAt": 20},
            {"id": "used", "status": "redeemed", "expiresAt": 5}]}});
        assert_eq!(parse_read(&with_id).next_id.as_deref(), Some("soon"));
        let bare = json!({"rateLimits": {"secondary": {"usedPercent": 7.0}}, "rateLimitResetCredits": null});
        assert_eq!(parse_read(&bare), r(0, None, Some(7.0)));
    }

    // Codex's error text picks a fixed kind and is never passed on.
    #[test]
    fn error_kinds_are_fixed() {
        let kind = |code: i64, m: &str| error_kind(&json!({"code": code, "message": m}));
        assert_eq!(
            kind(
                -32600,
                "codex account authentication required to read rate limits"
            ),
            Fail::NotSignedIn
        );
        assert_eq!(kind(-32601, "method not found"), Fail::TooOld);
        assert_eq!(kind(-32000, "backend said no"), Fail::Refused);
        assert!(!Fail::NotSignedIn.text().contains("authentication required"));
    }

    // An agent's reason and a session label are shown in the window: no control or bidi characters, capped.
    #[test]
    fn clean_drops_controls_and_caps() {
        assert_eq!(
            clean(" a\u{1b}[31mb\u{202e}c\n ", 200).as_deref(),
            Some("a[31mbc")
        );
        assert_eq!(
            clean(&"x".repeat(500), REASON_MAX).unwrap().len(),
            REASON_MAX
        );
        assert_eq!(clean(" \u{200b} ", 10), None);
    }

    // An agent asking over and over never pushes a use out of the log; the asks keep their own newest LOG_KEEP.
    #[test]
    fn log_flood_of_asks_keeps_the_uses() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cxlog-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        let t = Target {
            folder: None,
            label: "Default".into(),
        };
        append(
            &home,
            Entry {
                outcome: Some("reset".into()),
                ..entry(&t, How::Owner)
            },
        );
        for _ in 0..LOG_KEEP + 5 {
            append(&home, entry(&t, How::Asked));
        }
        let all = log(&home).0;
        assert_eq!(all.len(), LOG_KEEP + 1);
        assert_eq!(all.iter().filter(|e| e.how == How::Owner).count(), 1);
        fs::remove_dir_all(&home).unwrap();
    }

    // MUST (round 3): the weekly cap counts from its own record, not the display log's newest LOG_KEEP: cap 2, one
    // automatic spend, LOG_KEEP automatic attempts that spent nothing, then two more spends: the second is not automatic.
    #[test]
    fn cap_survives_a_flood_of_nonspending_attempts() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cxflood-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        let t = Target {
            folder: None,
            label: "Default".into(),
        };
        let auto = |o: &str| Entry {
            rule: Some("conditions".into()),
            outcome: Some(o.into()),
            ..entry(&t, How::Auto)
        };
        let p = Policy {
            weekly_only: false,
            keep_last: false,
            expiring: false,
            ..policy_on()
        };
        let verdict = || {
            let now = now_s();
            decide(
                &p,
                &r(5, None, None),
                auto_uses_this_week(&home, now).unwrap(),
                now as i64,
            )
        };
        append(&home, auto("reset"));
        for _ in 0..LOG_KEEP {
            append(&home, auto("nothing_to_reset"));
        }
        assert_eq!(verdict(), Verdict::Use("conditions"));
        append(&home, auto("reset"));
        assert_eq!(
            verdict(),
            Verdict::Ask("week_max"),
            "a spend was pushed out of the cap's count"
        );
        fs::remove_dir_all(&home).unwrap();
    }

    // SHOULD (round 2): the owner's Deny returns at once while a use holds the gate (it is answered under the session
    // registry lock); the denial is logged once the gate is free.
    #[test]
    fn deny_returns_while_the_gate_is_held() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cxdeny-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        let ask = OwnerAsk::CodexReset {
            folder: None,
            account: "Default".into(),
            reason: "weekly is out".into(),
        };
        let held = gate();
        let (tx, rx) = mpsc::channel();
        let h = home.clone();
        thread::spawn(move || {
            answered(&h, &ask, "s1", Some("add tests"), false);
            let _ = tx.send(());
        });
        let returned = rx.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(held);
        assert!(returned, "Deny waited on the gate");
        let until = Instant::now() + Duration::from_secs(5);
        while log(&home).0.is_empty() {
            assert!(Instant::now() < until, "the denial was never logged");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(log(&home).0[0].how, How::Denied);
        fs::remove_dir_all(&home).unwrap();
    }

    /// A stand-in codex in `dir`: answers a read with `dir/count` tickets and the weekly window used up; its second
    /// start (the use) waits after `initialize` until `dir/go` exists, saying so with `dir/waiting`; a consume it is
    /// sent leaves `dir/consumed`.
    fn fake_codex(dir: &Path) -> PathBuf {
        let path = dir.join("codex");
        fs::write(
            &path,
            r#"#!/bin/sh
d=$(dirname "$0")
n=$(($(cat "$d/starts" 2>/dev/null || echo 0) + 1)); echo $n > "$d/starts"
read -r l
if [ $n -eq 2 ]; then : > "$d/waiting"; while [ ! -f "$d/go" ]; do sleep 0.05; done; fi
echo '{"id":1,"result":{}}'
read -r l; read -r l
case "$l" in
*consume*) : > "$d/consumed"; echo '{"id":2,"result":{"outcome":"reset"}}' ;;
*) echo '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":100.0,"windowDurationMins":10080}},"rateLimitResetCredits":{"availableCount":'$(cat "$d/count")',"credits":[]}}}' ;;
esac
read -r l
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
    /// Ticket 1150 round 2 (Codex look P2): a codex that leaves its process group is not reached by the group's
    /// kill, and waiting for it without a bound never returned (under the registry lock, at a Codex start). The
    /// exchange ends the child itself too and its wait is bounded: it returns, and the child is gone.
    #[test]
    fn app_server_ends_a_codex_that_left_its_process_group() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cxgroup-{}", store::new_id().unwrap()));
        fs::create_dir_all(&dir).unwrap();
        let program = dir.join("codex");
        // Joins the test's own group (same session), says where it is, then answers nothing for 30 s.
        let script = "#!/usr/bin/env python3\nimport os, sys, time\nos.setpgid(0, os.getpgid(os.getppid()))\nopen(os.path.join(os.path.dirname(sys.argv[0]), 'pid'), 'w').write(str(os.getpid()))\ntime.sleep(30)\n";
        fs::write(&program, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let (tx, rx) = mpsc::channel();
        let command = crate::process::command(&program);
        thread::spawn(move || {
            // Longer than the fake takes to start and leave the group, under load too.
            let wait = Duration::from_secs(3);
            let _ = tx.send(app_server(
                command,
                wait,
                "hooks/list",
                json!({}),
                wait,
                &|| true,
                None,
            ));
        });
        let answer = rx.recv_timeout(Duration::from_secs(20));
        let pid: i32 = fs::read_to_string(dir.join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        let alive = || unsafe { libc::kill(pid, 0) } == 0;
        let returned = answer.is_ok();
        if !returned {
            unsafe { libc::kill(pid, libc::SIGKILL) }; // the old code's leftover
        }
        assert!(returned, "the exchange never returned");
        assert_eq!(answer.unwrap(), Err((Fail::Slow, false)));
        let until = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!alive(), "the codex that left its group still runs");
        let _ = fs::remove_dir_all(dir);
    }
    fn settings(home: &Path, features: Value) {
        fs::write(
            home.join("settings.json"),
            json!({ "features": features }).to_string(),
        )
        .unwrap();
    }
    /// An agent's ask under "allow ahead" (`before`); while its use waits on codex's start the owner tightens the policy
    /// to `after`: nothing may be consumed, and the ask is decided again under `after`, whose rule is returned.
    fn tightened_during_start(
        count: u64,
        before: Value,
        after: Value,
        auto_spent: usize,
    ) -> Option<String> {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cxtight-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("count"), count.to_string()).unwrap();
        settings(&home, before);
        let t = Target {
            folder: None,
            label: "Default".into(),
        };
        for _ in 0..auto_spent {
            append(
                &home,
                Entry {
                    outcome: Some("reset".into()),
                    ..entry(&t, How::Auto)
                },
            );
        }
        let program = fake_codex(&home);
        let h = home.clone();
        let run = thread::spawn(move || {
            CODEX.with(|c| *c.borrow_mut() = Some(program));
            let asked = Mutex::new(None::<String>);
            let base = entry(&t, How::Refused);
            let refuse = |rule: &str, text: &str| -> Response {
                *asked.lock().unwrap() = Some(format!("refused {rule}"));
                Err(text.into())
            };
            let ask = |rule: &str| -> Response {
                *asked.lock().unwrap() = Some(rule.into());
                Ok(Reply::Waiting { item: "x".into() })
            };
            let _ = by_policy(&h, &t, &base, &refuse, &ask);
            asked.into_inner().unwrap()
        });
        let until = Instant::now() + Duration::from_secs(20);
        while !home.join("waiting").exists() {
            assert!(Instant::now() < until, "the use never started codex");
            thread::sleep(Duration::from_millis(10));
        }
        settings(&home, after);
        fs::write(home.join("go"), "").unwrap();
        let decided = run.join().unwrap();
        let consumed = home.join("consumed").exists();
        let spent = log(&home).0.iter().filter(|e| e.how == How::Auto).count();
        fs::remove_dir_all(&home).unwrap();
        assert!(!consumed, "a reset was consumed under the old policy");
        assert_eq!(spent, auto_spent, "a use was logged under the old policy");
        decided
    }

    // MUST (security review): the owner turns on "keep the last one" while an allowed use waits on codex's start.
    #[test]
    fn keep_last_turned_on_during_start_stops_the_use() {
        let allow = |keep: bool| {
            json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow",
                "usage.codex_reset_keep_last": keep, "usage.codex_reset_week_max": 0})
        };
        assert_eq!(
            tightened_during_start(1, allow(false), allow(true), 0).as_deref(),
            Some("keep_last")
        );
    }

    // MUST (security review): the owner lowers the weekly cap below this use while it waits on codex's start.
    #[test]
    fn week_max_lowered_during_start_stops_the_use() {
        let allow = |max: u64| {
            json!({"usage.codex_resets": true, "usage.codex_reset_agent": "allow",
                "usage.codex_reset_keep_last": false, "usage.codex_reset_week_max": max})
        };
        assert_eq!(
            tightened_during_start(2, allow(2), allow(1), 1).as_deref(),
            Some("week_max")
        );
    }

    #[test]
    fn policy_defaults_are_off_and_ask() {
        // No settings file: every default.
        let p = policy(Path::new("/nonexistent/nunchiro-home"));
        assert!(!p.on);
        assert_eq!(p.mode, Mode::Ask);
        assert!(p.weekly_only && p.keep_last && p.expiring && p.week_max == 2);
    }
}
