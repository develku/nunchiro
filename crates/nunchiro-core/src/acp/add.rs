//! V2-4b: the owner's writes and launches of Settings > Agents. `add` appends one validated `[[agent]]` table to
//! `agents.toml` and never approves; `login` opens a visible shell tab running an approved entry's own command. The
//! hash a later grant quotes is the one `add` returns (`approval::agent_status`), so the sheet approves what it showed.
//!
//! Ticket 358: `sign_in` and `sign_out` run the approved command confined as the check is (`probe::run`) and ask it to
//! `authenticate` by a method it reported, or to `logout`. Behaviour after T3 Code's `provider-acp-registry` `auth.ts`; the
//! agent keeps its own login, and Nunchiro stores no token and reads no credential.
use super::{
    config::{self, Entry},
    probe,
};
use crate::{
    account_signin::{self, Phase, Reason},
    api::{AgentKind, Reply, Response, StartSession},
    approval::{self, State},
    sessions::Sessions,
    store,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
    },
    thread,
    time::{Duration, Instant},
};

/// Adds and removes share one read-modify-write of `agents.toml`.
static WRITE: Mutex<()> = Mutex::new(());
const MAX_BYTES: usize = 256 * 1024;

/// Env names the sheet accepts: `^[A-Z_][A-Z0-9_]*$` (a value or a key typed by mistake is refused).
fn upper_name(n: &str) -> bool {
    n.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_uppercase() || b == b'_')
        && n.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn check_new(entry: &Entry) -> Result<(), String> {
    if let Some(bad) = entry.env.iter().find(|n| !upper_name(n)) {
        // The offending text is not echoed: it may be a secret typed by mistake.
        let _ = bad;
        return Err("env holds variable names only (A-Z, 0-9, _), names only; values stay in your environment".into());
    }
    let control = |s: &str| s.chars().any(char::is_control);
    if control(&entry.command) || entry.args.iter().any(|a| control(a)) {
        return Err("the command and its arguments cannot hold control characters".into());
    }
    config::validate(entry).map_err(|e| e.replace("invalid agents.toml: ", ""))?;
    if let Some(reason) = config::claude_refusal(entry) {
        return Err(reason);
    }
    Ok(())
}

/// The `[[agent]]` table for `entry`, serialized by `toml_edit` (quoting and escaping are its).
fn table(entry: &Entry) -> String {
    use toml_edit::{Array, ArrayOfTables, DocumentMut, Item, Table, value};
    let list = |items: &[String]| -> Array { items.iter().map(String::as_str).collect() };
    let mut t = Table::new();
    t["name"] = value(&entry.name);
    t["command"] = value(&entry.command);
    t["args"] = value(list(&entry.args));
    t["env"] = value(list(&entry.env));
    if let Some(display) = &entry.display {
        t["display"] = value(display);
    }
    let mut tables = ArrayOfTables::new();
    tables.push(t);
    let mut doc = DocumentMut::new();
    doc["agent"] = Item::ArrayOfTables(tables);
    doc.to_string()
}

pub(crate) fn add(home: &Path, mut entry: Entry) -> Response {
    // T3 Code's rule for a provider's display name: trimmed, and empty removes it.
    entry.display = entry
        .display
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    check_new(&entry)?;
    let _write = WRITE.lock().map_err(|_| "agents.toml is busy")?;
    let existing = config::load(home)?;
    if let Some(same) = existing.iter().find(|e| e.name == entry.name) {
        if *same != entry {
            // 변경: the owner's edit of a listed entry. Its hash changes, so it cannot run until a new grant.
            rewrite(home, &entry.name, Some(&entry))?;
        }
        return Ok(Reply::AcpAgent {
            view: approval::agent_status(home, &entry.name)?,
        });
    }
    let path = home.join("agents.toml");
    // As `config::load` and `rewrite`: a FIFO swapped in never blocks while `WRITE` is held.
    let read = store::open_regular(&path).and_then(|f| store::read_capped(f, MAX_BYTES as u64));
    let mut text = match read {
        Ok(bytes) => String::from_utf8(bytes).map_err(|e| format!("agents.toml: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("agents.toml: {e}")),
    };
    // The earlier text stays byte for byte; only the new table follows it.
    if !text.is_empty() {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push('\n');
    }
    text.push_str(&table(&entry));
    if text.len() > MAX_BYTES {
        return Err("agents.toml is too large".into());
    }
    // The whole new file must load and hold exactly this entry (a quoting surprise is caught before it is written).
    let loaded = config::parse_for_write(&text, &entry.name)?;
    if loaded.iter().find(|e| e.name == entry.name) != Some(&entry) {
        return Err("the entry did not round-trip through agents.toml".into());
    }
    store::atomic_write(&path, text.as_bytes())?;
    Ok(Reply::AcpAgent {
        view: approval::agent_status(home, &entry.name)?,
    })
}

/// 제거: takes `name` out of `agents.toml` and revokes its grant, so the same content added back asks again. A session
/// already running is left alone. The grant goes first: a failure in between leaves an entry that needs approval, never a
/// grant waiting for the entry to come back.
pub(crate) fn remove(home: &Path, name: &str) -> Result<(), String> {
    let _write = WRITE.lock().map_err(|_| "agents.toml is busy")?;
    let mut approvals = approval::store::load(home)?;
    if approvals.find(approval::SubjectKind::Agent, name).is_some() {
        approvals.remove(approval::SubjectKind::Agent, name);
        approvals.save(home)?;
    }
    rewrite(home, name, None)
}

/// Replaces (or with `None` drops) the one `[[agent]]` table called `name`; every other table and comment stays. The caller
/// holds `WRITE`. The result must load and hold exactly what was asked before it is written.
fn rewrite(home: &Path, name: &str, new: Option<&Entry>) -> Result<(), String> {
    use toml_edit::{DocumentMut, Item};
    let path = home.join("agents.toml");
    // Q9 pin-J17-1: as `config::load`, so a FIFO swapped in never blocks while `WRITE` is held.
    let text = store::open_regular(&path)
        .and_then(|f| store::read_capped(f, MAX_BYTES as u64))
        .map_err(|e| format!("agents.toml: {e}"))?;
    let text = String::from_utf8(text).map_err(|e| format!("agents.toml: {e}"))?;
    let mut doc: DocumentMut = text.parse().map_err(|e| format!("agents.toml: {e}"))?;
    let tables = doc
        .get_mut("agent")
        .and_then(Item::as_array_of_tables_mut)
        .ok_or_else(|| format!("no agent {name:?} in agents.toml"))?;
    let at = tables
        .iter()
        .position(|t| t.get("name").and_then(Item::as_str) == Some(name))
        .ok_or_else(|| format!("no agent {name:?} in agents.toml"))?;
    match new {
        Some(entry) => {
            let list = |items: &[String]| -> toml_edit::Array {
                items.iter().map(String::as_str).collect()
            };
            let t = tables.get_mut(at).ok_or("agents.toml changed")?;
            t["command"] = toml_edit::value(&entry.command);
            t["args"] = toml_edit::value(list(&entry.args));
            t["env"] = toml_edit::value(list(&entry.env));
            match &entry.display {
                Some(display) => t["display"] = toml_edit::value(display),
                None => drop(t.remove("display")),
            }
        }
        None => {
            tables.remove(at);
        }
    }
    if tables.is_empty() {
        doc.remove("agent");
    }
    let text = doc.to_string();
    let loaded = config::parse_for_write(&text, name)?;
    if loaded.iter().find(|e| e.name == name) != new {
        return Err("the entry did not round-trip through agents.toml".into());
    }
    store::atomic_write(&path, text.as_bytes())
}

fn approved(home: &Path, name: &str) -> Result<approval::AgentView, String> {
    match approval::agent_status(home, name) {
        Ok(view) if view.state == State::Approved && view.refused.is_none() => Ok(view),
        _ => Err("approve the agent first".into()),
    }
}

/// A visible shell tab labelled `Login: <name>` running the approved entry's command with `args` (none for its plain login),
/// in `project`. It stores nothing and sets nothing beyond what any shell tab has. The approval is read again under the
/// lock that starts the tab, so an entry changed meanwhile never runs.
pub(crate) fn login(
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    home: &Path,
    name: &str,
    project: &Path,
    args: Vec<String>,
) -> Response {
    let view = approved(home, name)?;
    let mut argv = vec![view.entry.command.clone()];
    argv.extend(args);
    let start = StartSession {
        account: None,
        kind: AgentKind::Shell,
        project: project.to_path_buf(),
        worktree: false,
        label: format!("Login: {name}"),
        args: argv,
        model: None,
        effort: None,
        resume: None,
    };
    let lock = || registry.lock().map_err(|_| "session registry unavailable");
    let launch = lock()?.launch_as(None, start, false)?;
    let mut launch = launch.prepare()?;
    let result = {
        let mut sessions = lock()?;
        if stopping.is_some_and(|s| s.load(Ordering::SeqCst)) {
            Err("core is stopping".into())
        } else if approved(home, name)?.hash != view.hash {
            Err("approve the agent first".into())
        } else {
            sessions.start(&launch)
        }
    };
    if result.is_ok() {
        launch.committed = true;
    }
    result.map(|session| Reply::Started { session })
}

/// What the window polls for one `agent` sign-in; a terminal method is a tab, not an attempt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SignIn {
    pub attempt: String,
    pub name: String,
    pub method: String,
    pub phase: Phase,
    /// Only ever a link `account_signin::allowed_acp` let through. Copied by the owner; the core does not open it.
    pub link: Option<String>,
    pub reason: Option<Reason>,
}

struct Attempt {
    state: SignIn,
    cancel: bool,
    ended: Option<Instant>,
    /// A sign-out holding the agent's slot: counted and stopped like a sign-in, never shown as one.
    sign_out: bool,
}
static ATTEMPTS: LazyLock<Mutex<HashMap<String, Attempt>>> = LazyLock::new(Default::default);
const LIVE_AT_ONCE: usize = 4;
const KEEP_ENDED: Duration = Duration::from_secs(600);
/// T3 Code's bound for a sign-out and, as `account_signin`, ten minutes for a person to finish a sign-in.
const LOGOUT_CAP: Duration = Duration::from_secs(60);
const SIGN_IN_CAP: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(100);
/// Long enough for the check in front of a sign-in (3 s `--version`, 5 s handshake) and one more behind it.
const CHECK_SLOT_WAIT: Duration = Duration::from_secs(15);
/// The handshake's request ids, which are also the order of its stages.
const STAGE_INITIALIZE: u64 = 0;
const STAGE_AUTHENTICATE: u64 = 1;
const STAGE_OPEN: u64 = 2;

fn with<T>(f: impl FnOnce(&mut HashMap<String, Attempt>) -> T) -> Result<T, String> {
    let mut all = ATTEMPTS.lock().map_err(|_| "sign-in list unavailable")?;
    Ok(f(&mut all))
}

/// Sign-ins that have not ended. An unreadable list counts as one, so a core swap waits rather than kills a login.
pub(crate) fn signing_in() -> usize {
    with(|all| all.values().filter(|a| a.ended.is_none()).count()).unwrap_or(1)
}

/// The sign-in running for `name`, for a window that did not start it or has reloaded since.
pub(crate) fn live(name: &str) -> Option<SignIn> {
    with(|all| {
        all.values()
            .find(|a| a.ended.is_none() && !a.sign_out && a.state.name == name)
            .map(|a| a.state.clone())
    })
    .ok()
    .flatten()
}

fn cancelled(key: &str) -> bool {
    with(|all| all.get(key).is_none_or(|a| a.cancel)).unwrap_or(true)
}

/// The core is stopping: every attempt ends its agent's group as it returns.
pub(crate) fn stop_sign_ins() {
    let _ = with(|all| all.values_mut().for_each(|a| a.cancel = true));
    let until = Instant::now() + POLL * 20;
    while signing_in() > 0 && Instant::now() < until {
        thread::sleep(POLL);
    }
}

/// Signs in by `method`, which must be one the agent reports right now: a terminal method opens its visible tab, an `agent`
/// method starts an attempt the window polls.
pub(crate) fn sign_in(
    registry: &Mutex<Sessions>,
    stopping: Option<&AtomicBool>,
    home: &Path,
    name: &str,
    method: &str,
    project: Option<&Path>,
) -> Response {
    let view = approved(home, name)?;
    let check = check_when_free(home, &view.entry)?;
    let Some(chosen) = check.auth_methods.iter().find(|m| m.id == method) else {
        return Err("the agent no longer reports this sign-in method".into());
    };
    if chosen.kind == "terminal" {
        let project = project.ok_or("start a session in a project folder first")?;
        // T3 Code's `terminalAuthCommand`: the configured command and its args, then the method's.
        let args = [view.entry.args.as_slice(), chosen.args.as_slice()].concat();
        return login(registry, stopping, home, name, project, args);
    }
    let path = super::found(&view.entry.command)
        .ok_or_else(|| format!("{} was not found", view.entry.command))?;
    start(home, view.entry, path, method)
}

/// The check runs one at a time and a window's own check may hold the slot, so a sign-in waits its turn.
fn check_when_free(home: &Path, entry: &Entry) -> Result<probe::Check, String> {
    let until = Instant::now() + CHECK_SLOT_WAIT;
    loop {
        match probe::check(home, entry) {
            Err(_) if Instant::now() < until => thread::sleep(POLL),
            result => return result,
        }
    }
}

fn start(home: &Path, entry: Entry, path: PathBuf, method: &str) -> Response {
    with(|all| {
        all.retain(|_, a| a.ended.is_none_or(|t| t.elapsed() < KEEP_ENDED));
        let mut live = all.values().filter(|a| a.ended.is_none());
        if live.clone().count() >= LIVE_AT_ONCE {
            return Err(format!("at most {LIVE_AT_ONCE} sign-ins at once"));
        }
        if live.any(|a| a.state.name == entry.name) {
            return Err(format!("{} is already signing in", entry.name));
        }
        let attempt = store::new_id()?;
        let state = SignIn {
            attempt: attempt.clone(),
            name: entry.name.clone(),
            method: method.to_string(),
            phase: Phase::Starting,
            link: None,
            reason: None,
        };
        all.insert(
            attempt.clone(),
            Attempt {
                state: state.clone(),
                cancel: false,
                ended: None,
                sign_out: false,
            },
        );
        let (home, method) = (home.to_path_buf(), method.to_string());
        thread::spawn(move || {
            run_attempt(&attempt, || {
                authenticate(&home, &attempt, &entry, &path, &method)
            });
        });
        Ok(Reply::AcpSignIn { state })
    })?
}

pub(crate) fn state(attempt: &str) -> Response {
    with(|all| {
        all.get(attempt)
            .map(|a| Reply::AcpSignIn {
                state: a.state.clone(),
            })
            .ok_or_else(|| "unknown sign-in".to_string())
    })?
}

pub(crate) fn cancel(attempt: &str) -> Response {
    with(|all| {
        all.get_mut(attempt).ok_or("unknown sign-in")?.cancel = true;
        Ok(Reply::Ack)
    })?
}

type End = (Phase, Option<Reason>);

/// Marks the attempt ended however its work leaves: a panic reads as a failed start, so `signing_in` cannot stay above zero.
struct Finish<'a> {
    key: &'a str,
    end: End,
}
impl Drop for Finish<'_> {
    fn drop(&mut self) {
        let (phase, reason) = self.end;
        let _ = with(|all| {
            if let Some(a) = all.get_mut(self.key) {
                a.state.phase = phase;
                a.state.reason = reason;
                a.ended = Some(Instant::now());
            }
        });
    }
}

fn run_attempt(key: &str, work: impl FnOnce() -> End) {
    let mut finish = Finish {
        key,
        end: (Phase::Failed, Some(Reason::StartFailed)),
    };
    finish.end = work();
}

/// One confined run asked to `authenticate`; the run's group is killed however this returns.
fn authenticate(home: &Path, key: &str, entry: &Entry, path: &Path, method: &str) -> End {
    let failed = (Phase::Failed, Some(Reason::StartFailed));
    let Ok(folder) = probe::folder(home) else {
        return failed;
    };
    let Ok(mut run) = probe::run(entry, path, &folder) else {
        return failed;
    };
    let record = account_signin::record(home, run.pid()); // a crashed core's agent goes at the next start
    let end = converse(key, &mut run, &folder, method);
    drop(run);
    if let Some(record) = record {
        record.remove();
    }
    end
}

fn converse(key: &str, run: &mut probe::Run, folder: &probe::Folder, method: &str) -> End {
    let failed = |reason| (Phase::Failed, Some(reason));
    // `auth.terminal` too, so the agent reports the same list here as at the check.
    let hello = json!({"auth": {"terminal": true}, "elicitation": {"url": {}}});
    if run.send(probe::initialize(hello)).is_err() {
        return failed(Reason::StartFailed);
    }
    let deadline = Instant::now() + account_signin::wait("NUNCHIRO_SIGNIN_TIMEOUT_MS", SIGN_IN_CAP);
    let mut stage = STAGE_INITIALIZE;
    let mut bad_link = false;
    loop {
        if cancelled(key) {
            return (Phase::Cancelled, None);
        }
        if Instant::now() >= deadline {
            return failed(Reason::TimedOut);
        }
        let message = match run.messages.recv_timeout(POLL) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return failed(if bad_link {
                    Reason::BadLink
                } else {
                    Reason::Exited
                });
            }
        };
        // A request of the agent: only a sign-in link is answered with anything but a refusal.
        if let Some(asked) = message["method"].as_str() {
            if !message["id"].is_null() {
                bad_link |= answer(key, run, asked, &message);
            }
            continue;
        }
        if message["id"].as_u64() != Some(stage) {
            continue;
        }
        let refused = !message["error"].is_null();
        match stage {
            STAGE_INITIALIZE => {
                if refused
                    || message["result"]["protocolVersion"].as_u64()
                        != Some(super::client::PROTOCOL)
                {
                    return failed(Reason::StartFailed);
                }
                set_waiting(key);
                let ask = json!({"jsonrpc":"2.0","id":STAGE_AUTHENTICATE,"method":"authenticate",
                    "params":{"methodId":method}});
                if run.send(ask).is_err() {
                    return failed(Reason::Exited);
                }
                stage = STAGE_AUTHENTICATE;
            }
            STAGE_AUTHENTICATE => {
                if refused {
                    return failed(if bad_link {
                        Reason::BadLink
                    } else {
                        Reason::Exited
                    });
                }
                // The agent says it is done; a session opening is what proves it (T3 Code does the same).
                let open = json!({"jsonrpc":"2.0","id":STAGE_OPEN,"method":"session/new",
                    "params":{"cwd":folder.0.display().to_string(),"mcpServers":[]}});
                if run.send(open).is_err() {
                    return failed(Reason::Exited);
                }
                stage = STAGE_OPEN;
            }
            _ => {
                let opened = !refused
                    && message["result"]["sessionId"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty());
                return if opened {
                    (Phase::SignedIn, None)
                } else {
                    failed(Reason::NotSignedIn)
                };
            }
        }
    }
}

fn set_waiting(key: &str) {
    let _ = with(|all| {
        if let Some(a) = all.get_mut(key) {
            a.state.phase = Phase::Waiting;
        }
    });
}

/// Answers one request of the agent; true when it was a sign-in link that failed the gate.
fn answer(key: &str, run: &mut probe::Run, asked: &str, message: &Value) -> bool {
    let id = message["id"].clone();
    let elicitation = matches!(
        asked,
        "elicitation/create" | "session/elicitation" | "_session/elicitation"
    );
    let params = &message["params"];
    let url = params["url"].as_str().filter(|_| params["mode"] == "url");
    if !elicitation || url.is_none() {
        let error = json!({"code":-32601,"message":"not offered during sign-in"});
        let _ = run.send(json!({"jsonrpc":"2.0","id":id,"error":error}));
        return false;
    }
    let link = url.filter(|url| account_signin::allowed_acp(url));
    if let Some(link) = link {
        let _ = with(|all| {
            if let Some(a) = all.get_mut(key) {
                a.state.link = Some(link.to_string());
            }
        });
    }
    // Accepting opens nothing: the link only reaches the owner's clipboard, on their click.
    let action = if link.is_some() { "accept" } else { "decline" };
    let _ = run.send(json!({"jsonrpc":"2.0","id":id,"result":{"action":action}}));
    link.is_none()
}

/// One running sign-out in the attempts list, so the core counts it and a stop ends it. Gone on every way out.
struct SignOutSlot(String);
impl SignOutSlot {
    fn take(name: &str) -> Result<Self, String> {
        with(|all| {
            if all
                .values()
                .any(|a| a.ended.is_none() && a.state.name == name)
            {
                return Err(format!("{name} is signing in"));
            }
            let key = store::new_id()?;
            all.insert(
                key.clone(),
                Attempt {
                    state: SignIn {
                        attempt: key.clone(),
                        name: name.to_string(),
                        method: String::new(),
                        phase: Phase::Starting,
                        link: None,
                        reason: None,
                    },
                    cancel: false,
                    ended: None,
                    sign_out: true,
                },
            );
            Ok(Self(key))
        })?
    }
}
impl Drop for SignOutSlot {
    fn drop(&mut self) {
        let _ = with(|all| all.remove(&self.0));
    }
}

/// Asks the agent to `logout`, only when it advertises that. It runs confined and off the lock, like the check.
pub(crate) fn sign_out(home: &Path, name: &str) -> Response {
    let entry = approved(home, name)?.entry;
    let slot = SignOutSlot::take(name)?; // first, so it is given back after the run below is killed
    let path =
        super::found(&entry.command).ok_or_else(|| format!("{} was not found", entry.command))?;
    let folder = probe::folder(home)?;
    let mut run = probe::run(&entry, &path, &folder)?;
    run.send(probe::initialize(json!({})))?;
    let deadline = Instant::now() + LOGOUT_CAP;
    let mut stage = STAGE_INITIALIZE;
    loop {
        if cancelled(&slot.0) {
            return Err("core is stopping".into());
        }
        if Instant::now() >= deadline {
            return Err("the agent did not finish signing out".into());
        }
        let message = match run.messages.recv_timeout(POLL) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err("the agent did not finish signing out".into());
            }
        };
        if message.get("method").is_some() || message["id"].as_u64() != Some(stage) {
            continue;
        }
        let refused = !message["error"].is_null();
        if stage == STAGE_INITIALIZE {
            if refused || !probe::can_logout(&message["result"]["agentCapabilities"]) {
                return Err("this agent does not offer sign-out".into());
            }
            run.send(
                json!({"jsonrpc":"2.0","id":STAGE_AUTHENTICATE,"method":"logout","params":{}}),
            )?;
            stage = STAGE_AUTHENTICATE;
        } else if refused {
            return Err("the agent could not sign out".into());
        } else {
            return Ok(Reply::Ack);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(command: &str) -> Entry {
        Entry {
            name: "a".into(),
            command: command.into(),
            args: vec![],
            env: vec![],
            display: None,
        }
    }
    #[test]
    fn a_change_replaces_only_its_table_and_remove_drops_it() {
        let home = std::env::temp_dir().join(format!("nunchiro-add-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join("agents.toml");
        std::fs::write(
            &path,
            "# mine\n[[agent]]\nname = \"a\"\ncommand = \"/bin/a\"\n\n[[agent]]\nname = \"b\"\ncommand = \"/bin/b\"\n",
        )
        .unwrap();
        rewrite(&home, "a", Some(&entry("/bin/new"))).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# mine") && text.contains("/bin/new") && text.contains("/bin/b"));
        assert!(!text.contains("/bin/a\""));
        rewrite(&home, "a", None).unwrap();
        let names: Vec<_> = config::load(&home)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["b"]);
        assert!(rewrite(&home, "a", None).is_err());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_panicking_attempt_still_ends() {
        let key = "panic-test-attempt";
        with(|all| {
            all.insert(
                key.to_string(),
                Attempt {
                    state: SignIn {
                        attempt: key.into(),
                        name: "panic-test".into(),
                        method: String::new(),
                        phase: Phase::Starting,
                        link: None,
                        reason: None,
                    },
                    cancel: false,
                    ended: None,
                    sign_out: false,
                },
            )
        })
        .unwrap();
        let panicked = thread::spawn(|| run_attempt(key, || panic!("agent parser bug"))).join();
        assert!(panicked.is_err());
        let (ended, phase) = with(|all| {
            let a = all.remove(key).unwrap();
            (a.ended.is_some(), a.state.phase)
        })
        .unwrap();
        assert!(ended, "a panicked attempt stayed live");
        assert_eq!(phase, Phase::Failed);
    }

    #[test]
    fn auth_methods_are_bounded_and_env_var_is_never_offered() {
        let long = "x".repeat(200);
        let reported = json!([
            {"id":"a","name":"Browser","type":"agent"},
            {"id":"untyped","name":"No type"},
            {"id":"key","name":"API key","type":"env_var"},
            {"id":"t","name":"Term","type":"terminal","args":["login"]},
            {"id":"a","name":"Repeated id","type":"agent"},
            {"id":long,"name":"Long id","type":"agent"},
            {"id":"bad\nid","name":"Control","type":"agent"},
            {"id":"odd","name":"\u{202e}spoof","type":"agent"},
            {"id":"cut","name":long,"type":"agent"},
            {"id":"unrunnable","name":"Bad args","type":"terminal","args":["a\nb"]},
            {"id":"not-text","name":"Bad args","type":"terminal","args":[1]},
        ]);
        let methods = probe::auth_methods(&reported);
        let ids: Vec<_> = methods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["a", "untyped", "t", "odd", "cut"]);
        assert_eq!(methods[1].kind, "agent");
        assert_eq!(methods[2].args, ["login"]);
        assert_eq!(
            methods[3].name, "odd",
            "a name that hides text falls back to the id"
        );
        assert_eq!(methods[4].name.chars().count(), 64);
        let many: Vec<_> = (0..40)
            .map(|i| json!({"id":i.to_string(),"name":"m"}))
            .collect();
        assert_eq!(probe::auth_methods(&json!(many)).len(), 16);
    }

    #[test]
    fn logout_counts_only_when_advertised() {
        assert!(probe::can_logout(&json!({"auth":{"logout":{}}})));
        for caps in [
            json!({}),
            json!({"auth":{}}),
            json!({"auth":{"logout":null}}),
        ] {
            assert!(!probe::can_logout(&caps), "{caps}");
        }
    }

    // Threat 2: an agent's link passes the structural half of the Claude gate; its host is the agent's own.
    #[test]
    fn acp_link_gate() {
        for good in [
            "https://accounts.example.com/o/oauth2/auth?x=1&redirect_uri=http://localhost:1/cb",
            "https://acme.example/login",
        ] {
            assert!(account_signin::allowed_acp(good), "{good}");
        }
        for bad in [
            "http://acme.example/login",
            "HTTPS://acme.example/login",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user@acme.example/login",
            "https://acme.example:8443/login",
            "https://ACME.example/login",
            "https://localhost/login",
            "https://127.0.0.1/login",
            "https://acme.example./login",
            "https://evil.example\\@acme.example/",
            "https://acme.example/\u{202e}x",
            "https://acme.example/a b",
        ] {
            assert!(!account_signin::allowed_acp(bad), "{bad}");
        }
        assert!(!account_signin::allowed_acp(&format!(
            "https://acme.example/{}",
            "x".repeat(5000)
        )));
    }
}
