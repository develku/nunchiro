//! V2-4a: ACP agents (Agent Client Protocol v1 over stdio), declared in `agents.toml` and launched only at the content
//! a human approved. An ACP session has no PTY and no holder: the agent is a child of the core and ends with it.
//! Every request the agent makes of a person becomes a decision queue item whether or not a prompt is in flight, and
//! is answered allow once or reject once only; the chat comes from `session/update`.
pub(crate) mod add;
mod client;
pub mod config;
pub mod probe;

use crate::{
    api::{Reply, Response, Session},
    queue::{self, Queue},
};
use client::{Client, Event};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

/// A terminal-only or ACP agent Settings > Agents offers (`known.toml`, bundled, never fetched).
#[derive(serde::Deserialize)]
struct Known {
    name: String,
    label: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
    install_url: String,
    /// Ticket 358: the tool's docs and source pages, when confirmed. Only ever from this bundled table.
    #[serde(default)]
    docs_url: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    acp: bool,
    /// An API key service run through another agent: listed with its own display name, never as an agent program.
    #[serde(default)]
    service: bool,
}
#[derive(serde::Deserialize)]
struct KnownFile {
    known: Vec<Known>,
}
fn known() -> &'static [Known] {
    static KNOWN: std::sync::OnceLock<Vec<Known>> = std::sync::OnceLock::new();
    KNOWN.get_or_init(|| {
        toml::from_str::<KnownFile>(include_str!("known.toml"))
            .expect("known.toml parses")
            .known
    })
}
/// Display names by entry name, as the last listing read them.
// ponytail: `label_of`'s callers in sessions.rs hold no home to read agents.toml with, and every window start lists the
// agents first; a start before any listing shows the known label. Pass `home` to `label_of` when sessions.rs is open for it.
static DISPLAY: std::sync::Mutex<BTreeMap<String, String>> = std::sync::Mutex::new(BTreeMap::new());
/// The name the window shows for an agent: its display name, else the known list's label, else the name.
pub(crate) fn label_of(name: &str) -> String {
    match DISPLAY.lock() {
        Ok(names) => label_from(&names, name),
        Err(_) => label_from(&BTreeMap::new(), name),
    }
}
fn label_from(names: &BTreeMap<String, String>, name: &str) -> String {
    names.get(name).cloned().unwrap_or_else(|| {
        known()
            .iter()
            .find(|k| k.name == name)
            .map_or_else(|| name.to_string(), |k| k.label.clone())
    })
}
fn display_names(entries: &[config::Entry]) -> BTreeMap<String, String> {
    entries
        .iter()
        .filter_map(|e| Some((e.name.clone(), e.display.clone()?)))
        .collect()
}

/// Ticket 358: one model an agent reported in its Session Config Options; `value` goes back to it exactly as it came.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AcpModel {
    pub value: String,
    pub label: String,
}
/// What is read of one agent's list: the same limit `config_options` keeps for a session's model, so a value is never cut.
const MODELS_MAX: usize = 500;
const MODEL_TEXT_MAX: usize = 100;
/// Per agent, the list it last reported: Settings shows it with no agent running. Names of models only.
const MODELS_FILE: &str = "acp-models.json";
/// Ticket 994: the same for its thinking levels (`thought_level`), in a file of their own so the models' file keeps
/// its form. shortcut: the levels of the model that ran last; keep them per model when an agent's models differ in them.
const EFFORTS_FILE: &str = "acp-efforts.json";
fn remembered(home: &Path, file: &str) -> BTreeMap<String, Vec<AcpModel>> {
    crate::store::read_regular(&home.join(file))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
/// Ticket 994: the models and thinking levels `agent` last reported (a level slot is checked against them when a seat
/// opens with no session to ask yet).
pub(crate) fn reported(home: &Path, agent: &str) -> (Vec<AcpModel>, Vec<AcpModel>) {
    let of = |file| remembered(home, file).remove(agent).unwrap_or_default();
    (of(MODELS_FILE), of(EFFORTS_FILE))
}
/// An empty list forgets the agent: one that stopped reporting models has no 모델 section. The registry lock serialises writers.
fn remember(home: &Path, file: &str, agent: &str, models: &[AcpModel]) {
    let mut all = remembered(home, file);
    if all.get(agent).map_or(&[][..], Vec::as_slice) == models {
        return;
    }
    if models.is_empty() {
        all.remove(agent);
    } else {
        all.insert(agent.into(), models.to_vec());
    }
    let written = serde_json::to_vec(&all)
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            crate::store::write_capped(&home.join(file), &bytes, crate::store::READ_MAX)
        });
    if let Err(error) = written {
        eprintln!("acp models of {agent} not remembered: {error}");
    }
}

/// One row of Settings > Agents' ACP table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcpRow {
    pub name: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<String>,
    /// `known` (the bundled list; an `agents.toml` entry of the same name supplies its content), `service` (the same, an
    /// API key service) or `custom`.
    pub source: String,
    /// Per name in `env`: whether the core has a value to pass. Never the value.
    #[serde(default)]
    pub env_set: BTreeMap<String, bool>,
    /// False: a terminal-only CLI (no chat view or waiting detection).
    pub acp: bool,
    pub found_path: Option<String>,
    pub version: Option<String>,
    pub install_url: Option<String>,
    pub state: Option<crate::approval::State>,
    pub hash: Option<String>,
    pub refused: Option<String>,
    /// Ticket 358: the owner's name for this entry, when one is set (`label` already shows it).
    #[serde(default)]
    pub display: Option<String>,
    /// The tool's https pages, from `known.toml` only: never from the agent or `agents.toml`.
    #[serde(default)]
    pub docs_url: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    /// What 진단 복사 copies (`diagnostics`). Never a variable's value.
    #[serde(default)]
    pub diagnostics: String,
    /// Ticket 358: the models this agent last reported; empty: it reported none, or never ran.
    #[serde(default)]
    pub models: Vec<AcpModel>,
    /// Ticket 994: the thinking levels it last reported, lowest first as it listed them; empty: it has none.
    #[serde(default)]
    pub efforts: Vec<AcpModel>,
}

/// The first dotted number in a `--version` output: the rest of that output is the program's own text.
fn version_number(text: &str) -> Option<&str> {
    text.split(|c: char| !c.is_ascii_digit() && c != '.')
        .find(|t| t.contains('.') && t.split('.').all(|part| !part.is_empty()))
}

/// The text a failed row copies, built field by field from an allowlist: the entry's name, its state and failure as fixed
/// words, the version number, the found path, and each variable's name with set or unset. `logs::redact` only knows
/// registered tokens, so it is the second layer here; what keeps a value out is that no argument, display name, check
/// error or program output is ever a field.
fn diagnostics(row: &AcpRow) -> String {
    use crate::approval::State;
    let failure = if row.refused.is_some() {
        "refused"
    } else if row.found_path.is_none() {
        "command not found"
    } else if row.env_set.values().any(|set| !set) {
        "variable missing"
    } else {
        "none"
    };
    let state = match row.state {
        Some(State::Approved) => "approved",
        Some(State::Unapproved) => "unapproved",
        Some(State::Changed) => "changed",
        None => "not added",
    };
    let version = row.version.as_deref().and_then(version_number);
    let head = format!(
        "name: {}\nstate: {state}\nfailure: {failure}\nversion: {}\npath: {}\n",
        row.name,
        version.unwrap_or("unknown"),
        row.found_path.as_deref().unwrap_or("none"),
    );
    let mut text = String::from_utf8_lossy(&crate::logs::redact(head.as_bytes())).into_owned();
    // After `redact`, which masks whatever follows a `SECRET:` or `KEY:`: here that is only the fixed word this text exists
    // to show, after a name `config::validate` holds to letters, digits and `_`.
    for name in &row.env {
        let set = row.env_set.get(name).copied().unwrap_or(false);
        text.push_str(&format!("{name}: {}\n", if set { "set" } else { "unset" }));
    }
    text
}

/// `command` as an executable file: a path as it is, a bare name in the first absolute PATH entry holding it.
pub(crate) fn found(command: &str) -> Option<PathBuf> {
    if command.contains('/') {
        let path = PathBuf::from(command);
        return std::fs::metadata(&path)
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .then_some(path);
    }
    crate::firstrun::on_path(command)
}

/// The known rows (an `agents.toml` entry of the same name takes their command, args and env), then every other
/// `agents.toml` entry as a custom row. Each row's `--version` runs on its own thread (3 s at most).
pub(crate) fn rows(home: &Path) -> Result<Vec<AcpRow>, String> {
    let entries = config::load(home)?;
    if let Ok(mut names) = DISPLAY.lock() {
        *names = display_names(&entries);
    }
    let mut rows: Vec<AcpRow> = known()
        .iter()
        .map(|k| {
            let entry = entries.iter().find(|e| e.name == k.name);
            let display = entry.and_then(|e| e.display.clone());
            AcpRow {
                name: k.name.clone(),
                label: display.clone().unwrap_or_else(|| k.label.clone()),
                display,
                docs_url: k.docs_url.clone(),
                source_url: k.source_url.clone(),
                diagnostics: String::new(),
                command: entry.map_or(k.command.clone(), |e| e.command.clone()),
                args: entry.map_or(k.args.clone(), |e| e.args.clone()),
                env: entry.map_or(k.env.clone(), |e| e.env.clone()),
                source: if k.service { "service" } else { "known" }.into(),
                env_set: BTreeMap::new(),
                acp: k.acp,
                found_path: None,
                version: None,
                install_url: Some(k.install_url.clone()),
                state: None,
                hash: None,
                refused: None,
                models: vec![],
                efforts: vec![],
            }
        })
        .collect();
    for e in &entries {
        if !rows.iter().any(|r| r.name == e.name) {
            rows.push(AcpRow {
                name: e.name.clone(),
                label: e.display.clone().unwrap_or_else(|| e.name.clone()),
                display: e.display.clone(),
                docs_url: None,
                source_url: None,
                diagnostics: String::new(),
                command: e.command.clone(),
                args: e.args.clone(),
                env: e.env.clone(),
                source: "custom".into(),
                env_set: BTreeMap::new(),
                acp: true,
                found_path: None,
                version: None,
                install_url: None,
                state: None,
                hash: None,
                refused: None,
                models: vec![],
                efforts: vec![],
            });
        }
    }
    let (mut models, mut efforts) = (
        remembered(home, MODELS_FILE),
        remembered(home, EFFORTS_FILE),
    );
    for row in &mut rows {
        row.models = models.remove(&row.name).unwrap_or_default();
        row.efforts = efforts.remove(&row.name).unwrap_or_default();
    }
    std::thread::scope(|scope| {
        for row in rows.iter_mut() {
            let listed = entries.iter().any(|e| e.name == row.name);
            scope.spawn(move || {
                row.env_set = client::env_set(&row.env);
                let path = found(&row.command);
                if listed && let Ok(view) = crate::approval::agent_status(home, &row.name) {
                    row.state = Some(view.state);
                    row.hash = Some(view.hash);
                    row.refused = view.refused;
                }
                // `--version` runs a binary: only the bundled list's own command on the PATH, or an entry a human
                // approved. A command named by an unapproved or changed `agents.toml` entry is never run for a listing
                // (the sheet's check, which the user starts, shows its version).
                let may_run = !listed || row.state == Some(crate::approval::State::Approved);
                row.version = path
                    .as_deref()
                    .filter(|_| may_run)
                    .and_then(crate::firstrun::version);
                row.found_path = path.map(|p| p.display().to_string());
                row.diagnostics = diagnostics(row);
            });
        }
    });
    Ok(rows)
}

/// The owner's setup requests (Settings > Agents), run off the registry lock; `check_agent` refused every session
/// caller before they get here.
pub(crate) fn setup(
    home: &Path,
    registry: &std::sync::Mutex<crate::sessions::Sessions>,
    stopping: Option<&std::sync::atomic::AtomicBool>,
    request: crate::api::Request,
) -> Response {
    use crate::api::Request;
    let listing = || {
        Ok(Reply::AcpAgents {
            terminal: crate::firstrun::detect_all(),
            acp: rows(home)?,
            file: home.join("agents.toml"),
        })
    };
    match request {
        Request::AcpAgents => listing(),
        // ponytail: an empty command means "remove this name", so removing needs no new op in the owner-only allowlists
        // (api.rs, server.rs, sessions.rs, http); give it its own `Request` when those files are next open for this.
        Request::AcpAgentAdd { entry } if entry.command.is_empty() => {
            add::remove(home, &entry.name)?;
            listing()
        }
        Request::AcpAgentCheck { entry, confirmed } => {
            // An entry that is in agents.toml (which an agent may edit) and not approved as it stands runs only on the
            // owner's explicit click; one the owner typed in the sheet, or a bundled one not in the file, is not that.
            // A file that will not load is not "entry absent": nothing is checked until it is fixed.
            let in_file = config::load(home)
                .map_err(|e| format!("{e}; fix agents.toml, then run the check again"))?
                .iter()
                .any(|e| e.same_content(&entry));
            let approved = crate::approval::agent_status(home, &entry.name)
                .is_ok_and(|v| v.state == crate::approval::State::Approved);
            if in_file && !approved && !confirmed {
                // The request carries no origin, so a typed entry equal to a file entry gets this same refusal.
                return Err(
                    "this entry is identical to one in agents.toml and is not approved: press Run check on its row in Settings > Agents (an entry you typed here that matches the file counts as that entry)".into(),
                );
            }
            let mut check = probe::check(home, &entry)?;
            check.sign_in = add::live(&entry.name);
            Ok(Reply::AcpCheck(check))
        }
        Request::AcpAgentAdd { entry } => add::add(home, entry),
        Request::AcpAgentLogin { name, project } => {
            add::login(registry, stopping, home, &name, &project, vec![])
        }
        Request::AcpAgentSignIn {
            name,
            method,
            project,
        } => add::sign_in(registry, stopping, home, &name, &method, project.as_deref()),
        Request::AcpAgentSignInState { attempt } => add::state(&attempt),
        Request::AcpAgentSignInCancel { attempt } => add::cancel(&attempt),
        Request::AcpAgentSignOut { name } => add::sign_out(home, &name),
        _ => Err("not an agent setup request".into()),
    }
}

/// One chat event's JSON at most; a bigger one is cut and marked `truncated`.
const EVENT_MAX: usize = 64 * 1024;
/// One session's chat in memory at most (bytes, events); past either, the oldest events go.
// shortcut: an ACP chat lives in memory only and keeps its newest FEED_BYTES; persist it when ended ACP runs need
// their chat.
const FEED_BYTES: usize = 8 * 1024 * 1024;
const FEED_EVENTS: usize = 50_000;
/// How long an exited agent's last messages may take to arrive through the reader.
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_millis(200);
/// The most the drain of an exited agent may take: a child it left that keeps writing never makes a pass quiet.
const EXIT_TOTAL: std::time::Duration = std::time::Duration::from_secs(2);

/// The exited agent's drain is over: a quiet pass after EXIT_GRACE, or EXIT_TOTAL since it was first seen exited.
fn drain_over(since: std::time::Instant, quiet: bool) -> bool {
    let elapsed = since.elapsed();
    elapsed >= EXIT_TOTAL || (quiet && elapsed >= EXIT_GRACE)
}

/// An ACP session's chat: the newest events, bounded in bytes. Cursors count every event ever pushed, so a window's
/// `after` stays valid while old events go; `skipped` says how many went.
#[derive(Default)]
struct Feed {
    events: VecDeque<(crate::chat::Event, usize)>,
    bytes: usize,
    dropped: u64,
}
impl Feed {
    fn end(&self) -> u64 {
        self.dropped + self.events.len() as u64
    }
    fn push(&mut self, data: Value) {
        let data = cut(data);
        let size = data.to_string().len();
        let cursor = self.end() + 1;
        self.events.push_back((
            crate::chat::Event {
                schema_version: 1,
                cursor,
                data,
            },
            size,
        ));
        self.bytes += size;
        while self.bytes > FEED_BYTES || self.events.len() > FEED_EVENTS {
            let Some((_, size)) = self.events.pop_front() else {
                break;
            };
            self.bytes -= size;
            self.dropped += 1;
        }
        // An ACP agent's chat is its output: windows keep their fast cadence and send it now.
        crate::pty::notify_output();
    }
    fn page_of(&self, from: u64, to: u64, older: bool) -> crate::chat::Page {
        crate::chat::Page {
            generation: 0,
            schema_version: 1,
            banner: None,
            no_transcript: None,
            skipped: self.dropped,
            events: self
                .events
                .iter()
                .filter(|(e, _)| e.cursor > from && e.cursor <= to)
                .map(|(e, _)| e.clone())
                .collect(),
            before: (older && from > self.dropped).then_some(from + 1),
            end: self.end(),
        }
    }
    /// Events after `after`, at most 200 (from the oldest kept when `after` went already).
    fn since(&self, after: u64) -> Result<crate::chat::Page, String> {
        if after > self.end() {
            return Err("invalid chat cursor".into());
        }
        let from = after.max(self.dropped);
        Ok(self.page_of(from, from + 200, false))
    }
    /// The 200 events before `before` (default: the newest).
    fn page(&self, before: Option<u64>) -> Result<crate::chat::Page, String> {
        let end = self.end();
        if before.is_some_and(|c| c == 0 || c > end + 1) {
            return Err("invalid chat cursor".into());
        }
        let to = before.map_or(end, |c| c - 1);
        Ok(self.page_of(to.saturating_sub(200).max(self.dropped), to, true))
    }
}

/// An event over EVENT_MAX: its text or payload fields are cut and it is marked `truncated`; one still over is
/// replaced by a `skipped` marker.
fn cut(mut data: Value) -> Value {
    if data.to_string().len() <= EVENT_MAX {
        return data;
    }
    for key in ["text", "input", "output"] {
        let field = &mut data[key];
        if field.is_null() {
            continue;
        }
        let text = match field.as_str() {
            Some(s) => s.to_string(),
            None => field.to_string(),
        };
        let mut end = (EVENT_MAX / 2).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        *field = Value::String(text[..end].to_string());
    }
    data["truncated"] = Value::Bool(true);
    if data.to_string().len() > EVENT_MAX {
        return json!({"kind":"skipped","count":1});
    }
    data
}

/// A request of the agent waiting for its queue item's answer.
struct Ask {
    rpc: Value,
    /// The permission options offered, or `None` for an elicitation.
    options: Option<Vec<Value>>,
    /// Ticket 1149: the `terminal/create` this asks about (an outward command), run only on the owner's allow.
    terminal: Option<Value>,
}
/// What the agent reads when the owner did not allow its outward command.
const NOT_ALLOWED: &str = "The user did not allow this command. Do not retry it.";
/// The most a card's text holds; a longer request is cut to it, except a terminal's, which is refused.
const CARD_MAX: usize = 4096;
/// Round 2: what the agent reads when its outward command does not fit a card.
const TOO_LONG: &str = "This command is too long to show the user whole, so the user was not asked and it did not run. Shorten it.";

/// The registry's side of one ACP session.
pub(crate) struct Acp {
    client: Client,
    /// Ticket 358: the core's home and this agent's entry name, where its model list is remembered.
    home: PathBuf,
    agent: String,
    /// The model option the agent reports now; only its values are ever sent back.
    models: Option<ModelOption>,
    /// Ticket 994: its thinking level option (`thought_level`), likewise.
    efforts: Option<ModelOption>,
    /// The `session/set_config_option` in flight: whether it sets the thinking level (else the model), and the value.
    setting: Option<(bool, String)>,
    /// Ticket 994: the model and thinking level still to set (a seat's level slot, or a pick of both): one request at
    /// a time, each once the agent has listed its options. A prompt waits for it (`ready`).
    want: Option<(Option<String>, Option<String>)>,
    /// The agent's session id once the handshake finished.
    session: Option<String>,
    /// By queue item id.
    asks: BTreeMap<String, Ask>,
    feed: Feed,
    /// V2-CF4: the children the agent announced, folded from the `subagent_update`s; never part of the chat.
    kids: crate::chat::kids::Kids,
    /// Open tool calls by id: whether the kind is `edit`, and the file and line count of a whole-file write its
    /// rawInput gave (OpenCode's write tool sends no diff item, only `{path, content}` before it completes).
    tools: BTreeMap<String, (bool, Option<(String, usize)>)>,
    /// Consecutive chunks of one kind, shown as one chat message once another kind or the turn's end arrives.
    chunk: Option<(&'static str, String, bool)>,
    prompting: bool,
    /// When this registry first saw the agent exited.
    exited: Option<std::time::Instant>,
    /// The turn ended while a request of it was still open: done once the last one is answered.
    ended: bool,
}

impl Acp {
    /// `home` is the core's home: it and the agents' own config folders stay out of reach of the agent's file
    /// requests, and the user's home folder itself is never a session root.
    pub fn spawn(
        proof: &crate::approval::AgentProof,
        root: &Path,
        home: &Path,
        resume: Option<String>,
    ) -> Result<Self, String> {
        let entry = proof.entry();
        let user = std::env::var_os("HOME").map(PathBuf::from);
        if user
            .as_deref()
            .is_some_and(|h| std::fs::canonicalize(h).is_ok_and(|h| h == root))
        {
            return Err(
                "an ACP agent cannot run in your home folder itself; pick a project folder".into(),
            );
        }
        let mut denied = vec![home.to_path_buf()];
        if let Some(user) = &user {
            denied.extend([
                user.join(".claude"),
                user.join(".codex"),
                user.join(".nunchiro"),
            ]);
        }
        denied.extend(
            ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]
                .iter()
                .filter_map(|v| std::env::var_os(v).map(PathBuf::from)),
        );
        let denied = denied
            .into_iter()
            .flat_map(|d| std::fs::canonicalize(&d).into_iter().chain([d]))
            .collect();
        Ok(Self {
            client: Client::spawn(
                &entry.command,
                &entry.args,
                client::allowed_env(&entry.env),
                root,
                denied,
                resume,
            )?,
            home: home.to_path_buf(),
            agent: entry.name.clone(),
            models: None,
            efforts: None,
            setting: None,
            want: None,
            session: None,
            asks: BTreeMap::new(),
            feed: Default::default(),
            kids: Default::default(),
            tools: BTreeMap::new(),
            chunk: None,
            prompting: false,
            exited: None,
            ended: false,
        })
    }
    /// The handshake finished (a session exists): what ends the agent after this is not "no ACP answer".
    pub fn handshaken(&self) -> bool {
        self.session.is_some()
    }
    pub fn pid(&self) -> u32 {
        self.client.pid()
    }
    pub fn terminal_pids(&self) -> Vec<u32> {
        self.client.terminal_pids()
    }
    /// A prompt can go now: the handshake finished, no turn is in flight, and a seat's model is set (ticket 994: its
    /// first prompt must not run on the agent's default).
    pub fn ready(&self) -> bool {
        self.session.is_some() && !self.prompting && self.want.is_none()
    }
    /// V2-CF4: the children this agent announced (`subagent_update`), read-only.
    pub fn kids(&self) -> &crate::chat::kids::Kids {
        &self.kids
    }
    pub fn stop(&mut self) {
        self.client.stop();
    }
    pub fn chat(
        &self,
        before: Option<u64>,
        after: Option<u64>,
    ) -> Result<crate::chat::Page, String> {
        match after {
            Some(after) => self.feed.since(after),
            None => self.feed.page(before),
        }
    }

    /// Applies what the agent sent since the last pass. `Err` ends the session as failed; `Ok(false)` as exited.
    pub fn pump(
        &mut self,
        meta: &mut Session,
        queue: &mut Queue,
    ) -> Result<Result<bool, String>, String> {
        let id = meta.id.clone();
        // Read before the events, so what the agent sent before it exited is still applied. Once it exited the whole
        // channel is drained (no per-pass cap: nothing refills it but the rest of its pipe), and the session ends on
        // the first pass that finds nothing more after EXIT_GRACE, so a final burst (its turn's end too) is kept.
        let exited = self.client.exited();
        self.exited = match (exited, self.exited) {
            (false, _) => None,
            (true, None) => Some(std::time::Instant::now()),
            (true, since) => since,
        };
        let events = if exited {
            self.client.all_events()
        } else {
            self.client.events()
        };
        let quiet = events.is_empty();
        for event in events {
            match event {
                Event::Ready {
                    session,
                    load,
                    config,
                } => {
                    // Kept only when the agent can load it again: what makes the session resumable after a restart.
                    meta.agent_session_id =
                        (load && crate::store::valid_id(&session)).then(|| session.clone());
                    self.session = Some(session);
                    // No config options at all is an agent reporting none.
                    let none = Value::Array(vec![]);
                    self.config(meta, if config.is_null() { &none } else { &config });
                    self.flush(); // what `session/load` replayed
                    self.apply_want(meta);
                }
                Event::Failed(reason) => {
                    self.client.stop();
                    return Ok(Err(reason));
                }
                Event::Ask {
                    rpc,
                    method,
                    params,
                } => {
                    // An elicitation is answered like a permission (allow once or reject once), under the same rule
                    // for session callers (`grants::check_answer`).
                    let terminal = (method == "terminal/create").then(|| params.clone());
                    let (kind, text, options) = if let Some(params) = &terminal {
                        let command = crate::outward::acp_card(params);
                        (queue::Kind::Permission, format!("Allow: {command}"), None)
                    } else if method == "elicitation/create" {
                        let url = params["url"]
                            .as_str()
                            .map(|u| format!(" ({u})"))
                            .unwrap_or_default();
                        let message = params["message"]
                            .as_str()
                            .unwrap_or("The agent asks for input");
                        (queue::Kind::Permission, format!("{message}{url}"), None)
                    } else {
                        let title = params["toolCall"]["title"]
                            .as_str()
                            .unwrap_or("A tool call");
                        let options = params["options"].as_array().cloned().unwrap_or_default();
                        (
                            queue::Kind::Permission,
                            format!("Allow: {title}"),
                            Some(options),
                        )
                    };
                    // Round 2 (Codex look): the owner never allows what the card does not show. A cut card of
                    // `echo <4100 characters>; npm publish` hid the publish that Allow then ran, so a terminal
                    // request that does not fit is refused, never cut. (Another request's text is the agent's own
                    // title of a tool it runs itself; the client runs nothing for it.)
                    if terminal.is_some() && text.chars().count() > CARD_MAX {
                        let _ = self.client.refuse(&rpc, TOO_LONG);
                        continue;
                    }
                    let text: String = text.chars().take(CARD_MAX).collect();
                    match queue.acp_ask(&id, kind, text) {
                        Ok(item) => {
                            self.asks.insert(
                                item,
                                Ask {
                                    rpc,
                                    options,
                                    terminal,
                                },
                            );
                        }
                        // Never left unanswered where nobody sees it: the agent gets a refusal it can show.
                        Err(error) => {
                            eprintln!("acp request of {id} not queued: {error}");
                            let _ = self.refuse(&Ask {
                                rpc,
                                options,
                                terminal,
                            });
                        }
                    }
                }
                Event::Update(update) => {
                    queue.activity(&id, queue::now_ms())?;
                    self.update(meta, &update);
                }
                Event::ConfigSet(answer) => {
                    let set = self.setting.take();
                    let effort = set.as_ref().is_some_and(|(effort, _)| *effort);
                    match answer {
                        Ok(config) if config.is_array() => self.config(meta, &config),
                        Ok(_) => match set {
                            Some((true, value)) => meta.effort = Some(value),
                            Some((false, value)) => meta.model = Some(value),
                            None => {}
                        },
                        Err(error) => {
                            let what = if effort { "Thinking level" } else { "Model" };
                            self.flush();
                            self.push(json!({"kind":"message","role":"assistant",
                                "text":format!("{what} change failed: {error}")}));
                        }
                    }
                    self.apply_want(meta);
                }
                Event::TurnEnd(end) => {
                    self.flush();
                    self.prompting = false;
                    let state = match &end {
                        Ok(reason) if reason == "cancelled" => "interrupted",
                        Ok(_) => "completed",
                        Err(_) => "interrupted",
                    };
                    self.push(json!({"kind":"turn","turn_id":null,"state":state}));
                    if let Err(error) = end {
                        self.push(json!({"kind":"message","role":"assistant","text":format!("Agent error: {error}")}));
                    }
                    // Done only when nothing the turn asked is still open (not from `end_turn` alone).
                    self.ended = !self.asks.is_empty();
                    if !self.ended {
                        queue.acp_turn(&id, false)?;
                    }
                }
                // Closed before the handshake finished: the agent does not speak ACP (or exited at once).
                Event::Closed if self.session.is_none() => {
                    self.client.stop();
                    return Ok(Err(
                        "the agent closed its output before answering ACP".into()
                    ));
                }
                Event::Closed => return Ok(Ok(false)),
            }
        }
        // Its stdout can outlive it in a child it left; the session ends with the agent (`stop` ends the group).
        let over = self.exited.is_some_and(|since| drain_over(since, quiet));
        Ok(Ok(!over))
    }
    fn push(&mut self, data: Value) {
        self.feed.push(data);
    }
    /// An event built from update `u`: marked `truncated` when the reader cut `u`.
    fn push_cut(&mut self, u: &Value, mut data: Value) {
        if u["truncated"] == true {
            data["truncated"] = Value::Bool(true);
        }
        self.push(data);
    }
    fn flush(&mut self) {
        if let Some((kind, text, cut)) = self.chunk.take() {
            let mut data = match kind {
                "thinking" => json!({"kind":"thinking","text":text}),
                role => json!({"kind":"message","role":role,"text":text}),
            };
            if cut {
                data["truncated"] = Value::Bool(true);
            }
            self.push(data);
        }
    }
    fn update(&mut self, meta: &mut Session, u: &Value) {
        let text = u["content"]["text"].as_str().unwrap_or_default();
        let chunk = match u["sessionUpdate"].as_str().unwrap_or_default() {
            "user_message_chunk" => Some("user"),
            "agent_message_chunk" => Some("assistant"),
            "agent_thought_chunk" => Some("thinking"),
            _ => None,
        };
        if let Some(kind) = chunk {
            // The reader cut each chunk to its share; past EVENT_MAX the message stops growing, marked cut.
            let cut = u["truncated"] == true;
            match &mut self.chunk {
                Some((k, t, c)) if *k == kind => {
                    if t.len() <= EVENT_MAX {
                        t.push_str(text);
                    } else {
                        *c = true;
                    }
                    *c |= cut;
                }
                _ => {
                    self.flush();
                    self.chunk = Some((kind, text.into(), cut));
                }
            }
            return;
        }
        self.flush();
        if matches!(
            u["sessionUpdate"].as_str(),
            Some("tool_call" | "tool_call_update")
        ) {
            self.note_tool(u);
        }
        match u["sessionUpdate"].as_str().unwrap_or_default() {
            // V2-CF4: the association names the child in the body's own `sessionId`; it is kept for the tree, not as a
            // chat row (the child's transcript still arrives on its own sessionId and stays out of this feed).
            "subagent_update" => crate::chat::kids::fold_acp(u, &mut self.kids),
            "tool_call" => self.push_cut(u, json!({"kind":"tool_use","tool_id":u["toolCallId"],
                "name":u["title"].as_str().or(u["kind"].as_str()).unwrap_or("tool"),"input":u["rawInput"]})),
            "tool_call_update" if matches!(u["status"].as_str(), Some("completed" | "failed")) => {
                let tool = self.tools.remove(u["toolCallId"].as_str().unwrap_or_default());
                let mut diffs = 0;
                for c in u["content"].as_array().into_iter().flatten().filter(|c| c["type"] == "diff") {
                    let lines = |v: &Value| v.as_str().map(|s| s.lines().count());
                    self.push(json!({"kind":"edit","tool_id":u["toolCallId"],"path":c["path"],
                        "added":lines(&c["newText"]).unwrap_or(0),"removed":lines(&c["oldText"]),"hunks":[]}));
                    diffs += 1;
                }
                // A completed edit with no diff item: the whole-file write its rawInput named, as a new file.
                if let (0, "completed", Some((true, Some((path, added))))) = (diffs, u["status"].as_str().unwrap_or_default(), tool) {
                    self.push(json!({"kind":"edit","tool_id":u["toolCallId"],"path":path,
                        "added":added,"removed":null,"hunks":[]}));
                }
                self.push_cut(u, json!({"kind":"tool_result","tool_id":u["toolCallId"],
                    "output":if u["rawOutput"].is_null() { u["content"].clone() } else { u["rawOutput"].clone() },
                    "is_error":u["status"] == "failed"}));
            }
            // A cut update holds cut values: the last whole list stands.
            "config_option_update" if u["truncated"] != true => {
                self.config(meta, &u["configOptions"]);
            }
            _ => {}
        }
    }

    /// What a tool call's updates told so far: its kind (the last one given) and, for a `{path, content}` rawInput, the
    /// file (its first location, absolute, else the rawInput path) and the content's line count. A cut update's
    /// rawInput is not read.
    fn note_tool(&mut self, u: &Value) {
        let Some(id) = u["toolCallId"].as_str() else {
            return;
        };
        let tool = self.tools.entry(id.into()).or_default();
        if let Some(kind) = u["kind"].as_str() {
            tool.0 = kind == "edit";
        }
        let input = &u["rawInput"];
        if let (Some(path), Some(content), false) = (
            input["path"].as_str(),
            input["content"].as_str(),
            u["truncated"] == true,
        ) {
            let path = u["locations"][0]["path"].as_str().unwrap_or(path);
            tool.1 = Some((path.into(), content.lines().count()));
        }
    }

    /// The session's model and effort, and the model list when `options` holds the agent's config options.
    fn config(&mut self, meta: &mut Session, options: &Value) {
        config_options(meta, options);
        if options.is_array() {
            self.models = select_option(options, "model");
            self.efforts = select_option(options, "thought_level");
            for (file, option) in [(MODELS_FILE, &self.models), (EFFORTS_FILE, &self.efforts)] {
                let list = option.as_ref().map_or(&[][..], |o| &o.models[..]);
                remember(&self.home, file, &self.agent, list);
            }
        }
    }

    /// The agent's option for the model (ticket 358) or the thinking level (ticket 994), when it listed `value` in it:
    /// only a value the agent itself listed is ever sent back.
    fn listed(&self, effort: bool, value: &str) -> Result<&ModelOption, String> {
        let has = |o: &&ModelOption| o.models.iter().any(|m| m.value == value);
        if effort {
            // The refusal an ACP effort always got stays for what the agent did not list.
            return self
                .efforts
                .as_ref()
                .filter(has)
                .ok_or_else(|| "an ACP agent's effort is set in the agent".to_string());
        }
        let option = self.models.as_ref().ok_or("this agent reports no models")?;
        if !has(&option) {
            return Err("this agent did not report that model".into());
        }
        Ok(option)
    }
    /// Ticket 358: asks the agent to run `model`, which must be one it reported; ticket 994: and at `effort`, which
    /// must be a thinking level it listed. Refused before anything is sent; the session's model and effort change when
    /// the agent answers.
    pub fn switch(
        &mut self,
        meta: &Session,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(), String> {
        self.session.as_ref().ok_or("agent is starting")?;
        if self.prompting || !self.asks.is_empty() || self.setting.is_some() || self.want.is_some()
        {
            return Err("switch when the agent is idle".into());
        }
        for (effort, value) in [(false, &model), (true, &effort)] {
            if let Some(value) = value {
                self.listed(effort, value)?;
            }
        }
        self.want(model, effort);
        self.apply_want(meta);
        Ok(())
    }
    /// Ticket 994: a seat's level slot, set once the agent has listed its options (`apply_want`).
    pub fn want(&mut self, model: Option<String>, effort: Option<String>) {
        self.want = (model.is_some() || effort.is_some()).then_some((model, effort));
    }
    /// Sends the next part of `want`, the model first (an agent's thinking levels may follow its model), each after the
    /// answer to the one before. A part the agent does not list, or cannot take now, is said in the chat and left as
    /// the agent has it.
    fn apply_want(&mut self, meta: &Session) {
        let Some(session) = self.session.clone() else {
            return;
        };
        while self.setting.is_none() {
            let Some((model, effort)) = self.want.as_mut() else {
                return;
            };
            let Some((effort, value)) = model
                .take()
                .map(|m| (false, m))
                .or_else(|| effort.take().map(|e| (true, e)))
            else {
                self.want = None;
                return;
            };
            let now = if effort { &meta.effort } else { &meta.model };
            if now.as_deref() == Some(value.as_str()) {
                continue;
            }
            let sent = self
                .listed(effort, &value)
                .map(|o| o.id.clone())
                .and_then(|option| self.client.set_config_option(&session, &option, &value));
            match sent {
                Ok(()) => self.setting = Some((effort, value)),
                Err(error) => {
                    let what = if effort { "thinking level" } else { "model" };
                    self.flush();
                    self.push(json!({"kind":"message","role":"assistant",
                        "text":format!("The {what} {value} was not set ({error}); this agent runs on its own choice.")}));
                }
            }
        }
    }

    /// Sends the user's prompt as one turn.
    pub fn prompt(&mut self, meta: &Session, queue: &mut Queue, text: &str) -> Result<(), String> {
        let session = self.session.clone().ok_or("agent is starting")?;
        if self.prompting {
            return Err("agent is busy".into());
        }
        self.flush();
        self.push(json!({"kind":"turn","turn_id":null,"state":"started"}));
        self.push(json!({"kind":"message","role":"user","text":text}));
        self.client.prompt(&session, text)?;
        self.prompting = true;
        self.ended = false;
        queue.acp_turn(&meta.id, true)
    }

    /// Cancels the turn: every open permission answers `cancelled` (an elicitation `cancel`), then `session/cancel`.
    /// Requests the agent makes after this reach the queue like any other.
    pub fn cancel(&mut self, queue: &mut Queue) -> Result<(), String> {
        let session = self.session.clone().ok_or("agent is starting")?;
        for (item, ask) in std::mem::take(&mut self.asks) {
            // Removed durably before answering: a crash can lose an answer, never replay one.
            queue.remove(&item)?;
            self.refuse(&ask)?;
        }
        self.client.cancel(&session)
    }
    /// What an unanswerable, cancelled or denied request gets: `refusal`, or (ticket 1149) an error for a terminal.
    fn refuse(&self, ask: &Ask) -> Result<(), String> {
        match ask.terminal {
            Some(_) => self.client.refuse(&ask.rpc, NOT_ALLOWED),
            None => self
                .client
                .respond(&ask.rpc, refusal(ask.options.is_some())),
        }
    }

    /// Answers the agent's request behind queue item `item`: allow once or reject once only, never an always.
    pub fn answer(
        &mut self,
        meta: &Session,
        queue: &mut Queue,
        item: &queue::Decision,
        answer: &queue::Answer,
    ) -> Response {
        let ask = self
            .asks
            .get(&item.id)
            .ok_or("decision needs live reconciliation")?;
        let result = match (&ask.options, answer) {
            (Some(options), queue::Answer::AllowOnce | queue::Answer::Deny) => {
                let kind = if matches!(answer, queue::Answer::AllowOnce) {
                    "allow_once"
                } else {
                    "reject_once"
                };
                match options
                    .iter()
                    .find(|o| o["kind"] == kind)
                    .and_then(|o| o["optionId"].as_str())
                {
                    Some(option) => json!({"outcome":{"outcome":"selected","optionId":option}}),
                    None if kind == "reject_once" => refusal(true),
                    None => return Err(
                        "the agent offers no allow-once option; reject it or answer in the agent"
                            .into(),
                    ),
                }
            }
            (None, queue::Answer::AllowOnce) => json!({"action":"accept"}),
            (None, queue::Answer::Deny) => json!({"action":"decline"}),
            (
                _,
                queue::Answer::Choose { .. }
                | queue::Answer::ChooseWith { .. }
                | queue::Answer::AllowAlways
                | queue::Answer::DenyWith { .. },
            ) => {
                return Err("an ACP request takes allow_once or deny".into());
            }
        };
        let ask = self.asks.remove(&item.id).expect("checked above");
        queue.remove(&item.id)?;
        // Ticket 1149: an outward `terminal/create` runs on the owner's allow only; a deny is an error to the agent.
        match &ask.terminal {
            Some(params) if matches!(answer, queue::Answer::AllowOnce) => self
                .client
                .create_terminal(ask.rpc.clone(), params.clone())?,
            Some(_) => self.refuse(&ask)?,
            None => self.client.respond(&ask.rpc, result)?,
        }
        if self.ended && self.asks.is_empty() {
            self.ended = false;
            queue.acp_turn(&meta.id, false)?;
        }
        Ok(Reply::Ack)
    }
}

/// What an unanswerable or cancelled request gets: `cancelled` for a permission, `cancel` for an elicitation.
fn refusal(permission: bool) -> Value {
    if permission {
        json!({"outcome":{"outcome":"cancelled"}})
    } else {
        json!({"action":"cancel"})
    }
}

/// Ticket 358: an agent's model option and its choices.
struct ModelOption {
    id: String,
    models: Vec<AcpModel>,
}
/// The first select option of `category` (`model`, or ticket 994's `thought_level`) and its choices, flat or in groups;
/// `None` when it offers none. After t3code runtimeModel.ts `findModelConfigOption` and
/// `collectSessionConfigOptionValues` (behaviour only).
fn select_option(options: &Value, category: &str) -> Option<ModelOption> {
    let option = options.as_array()?.iter().find(|o| {
        o["category"] == category
            && o["type"] == "select"
            && o["id"]
                .as_str()
                .is_some_and(|id| !id.trim().is_empty() && id.len() <= 256)
    })?;
    let mut models: Vec<AcpModel> = Vec::new();
    for entry in option["options"]
        .as_array()?
        .iter()
        .flat_map(|e| match e["options"].as_array() {
            Some(group) => group.iter().collect::<Vec<_>>(),
            None => vec![e],
        })
    {
        let Some(value) = entry["value"]
            .as_str()
            .filter(|v| !v.is_empty() && v.chars().count() <= MODEL_TEXT_MAX)
        else {
            continue;
        };
        if models.len() < MODELS_MAX && !models.iter().any(|m| m.value == value) {
            let name = entry["name"].as_str().filter(|n| !n.trim().is_empty());
            models.push(AcpModel {
                value: value.into(),
                label: name.unwrap_or(value).chars().take(MODEL_TEXT_MAX).collect(),
            });
        }
    }
    (!models.is_empty()).then(|| ModelOption {
        id: option["id"].as_str().unwrap_or_default().into(),
        models,
    })
}

/// Model and effort from the Session Config Options (categories `model` and `thought_level`).
fn config_options(meta: &mut Session, options: &Value) {
    for o in options.as_array().into_iter().flatten() {
        let value = o["currentValue"]
            .as_str()
            .map(|v| v.chars().take(100).collect::<String>());
        match o["category"].as_str() {
            Some("model") => meta.model = value,
            Some("thought_level") => meta.effort = value,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn known_list_parses_and_has_no_claude_template() {
        let names: Vec<&str> = known().iter().map(|k| k.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "gemini",
                "opencode",
                "goose",
                "aider",
                "cursor",
                "grok",
                "antigravity",
                "openrouter",
                "glm",
                "kimi"
            ]
        );
        assert!(
            known()
                .iter()
                .all(|k| !k.name.contains("claude") && !k.command.contains("claude"))
        );
        assert!(
            known()
                .iter()
                .all(|k| k.install_url.starts_with("https://"))
        );
        assert!(!known().iter().find(|k| k.name == "aider").unwrap().acp);
    }

    /// The `http://` links in a table's text, in any case.
    fn plain_links(text: &str) -> usize {
        text.to_ascii_lowercase().matches("http://").count()
    }

    #[test]
    fn every_link_is_https_from_the_fixed_tables() {
        for k in known() {
            for url in [
                Some(&k.install_url),
                k.docs_url.as_ref(),
                k.source_url.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                assert!(url.starts_with("https://"), "{}: {url}", k.name);
            }
        }
        for (table, text) in [
            ("known.toml", include_str!("known.toml")),
            (
                "providers.tsx",
                include_str!("../../../../web/src/settings/accounts/providers.tsx"),
            ),
            (
                "state.ts",
                include_str!("../../../../web/src/settings/onboarding/state.ts"),
            ),
        ] {
            assert_eq!(plain_links(text), 0, "{table} holds an http link");
            assert!(text.contains("https://"), "{table} lost its links");
        }
        assert_eq!(plain_links("url = 'HTTP://example.com'"), 1);
    }

    #[test]
    fn diagnostics_are_built_from_the_allowlist_only() {
        let planted = "sk-planted-0123456789";
        let mut row = AcpRow {
            name: "tool".into(),
            label: format!("label {planted}"),
            command: format!("/x/{planted}"),
            args: vec![format!("--key={planted}")],
            env: vec!["SET_ONE".into(), "UNSET_ONE".into()],
            source: "custom".into(),
            env_set: BTreeMap::from([("SET_ONE".into(), true), ("UNSET_ONE".into(), false)]),
            acp: true,
            found_path: Some("/bin/tool".into()),
            version: Some(format!("tool 1.2.3 {planted}")),
            install_url: None,
            state: Some(crate::approval::State::Approved),
            hash: None,
            refused: None,
            display: Some(planted.into()),
            docs_url: None,
            source_url: None,
            diagnostics: String::new(),
            models: vec![],
            efforts: vec![],
        };
        let text = diagnostics(&row);
        assert_eq!(
            text,
            "name: tool\nstate: approved\nfailure: variable missing\nversion: 1.2.3\npath: /bin/tool\nSET_ONE: set\nUNSET_ONE: unset\n"
        );
        row.refused = Some(format!("refused because {planted}"));
        assert!(!diagnostics(&row).contains(planted));
        assert!(diagnostics(&row).contains("failure: refused"));
        assert_eq!(version_number("no number"), None);
    }

    #[test]
    fn a_display_name_comes_before_the_known_label() {
        // On its own map: the process-wide `DISPLAY` is replaced by any `rows()` running beside this test. That wiring is
        // covered end to end, in a core of its own, by `acp_display_name_keeps_the_entry_approved`.
        let entries = config::parse(
            "[[agent]]\nname = \"labelled\"\ncommand = \"/bin/a\"\ndisplay = \"내 도구\"\n\n[[agent]]\nname = \"gemini\"\ncommand = \"/bin/g\"\n",
        )
        .unwrap();
        let names = display_names(&entries);
        assert_eq!(label_from(&names, "labelled"), "내 도구");
        assert_eq!(label_from(&names, "gemini"), "Gemini CLI");
        assert_eq!(label_from(&names, "unlisted"), "unlisted");
    }

    fn model_option(options: &Value) -> Option<ModelOption> {
        select_option(options, "model")
    }
    #[test]
    fn model_option_reads_groups_and_never_cuts_a_value() {
        let long = "x".repeat(MODEL_TEXT_MAX + 1);
        let options = json!([
            {"id":"mode","category":"mode","type":"select","options":[{"value":"plan","name":"Plan"}]},
            {"id":"m","category":"model","type":"select","options":[
                {"value":"a","name":"A"},
                {"group":"g","name":"G","options":[{"value":"b","name":" "},{"value":"a","name":"again"},{"value":long,"name":"L"},{"name":"no value"}]}
            ]}
        ]);
        let option = model_option(&options).unwrap();
        assert_eq!(option.id, "m");
        let got: Vec<(&str, &str)> = option
            .models
            .iter()
            .map(|m| (m.value.as_str(), m.label.as_str()))
            .collect();
        assert_eq!(got, [("a", "A"), ("b", "b")]);
        // A model option with nothing to pick is no model option; nor is a toggle, or none at all.
        assert!(
            model_option(&json!([{"id":"m","category":"model","type":"select","options":[]}]))
                .is_none()
        );
        assert!(
            model_option(
                &json!([{"id":"m","category":"model","type":"boolean","options":[{"value":"a"}]}])
            )
            .is_none()
        );
        assert!(model_option(&json!([])).is_none());
    }

    #[test]
    fn exit_drain_ends_at_the_total_cap_even_when_not_quiet() {
        let ago = |ms| Instant::now() - Duration::from_millis(ms);
        // Quiet after the grace: as before.
        assert!(drain_over(ago(300), true));
        // Not quiet within the total cap: keeps draining.
        assert!(!drain_over(ago(300), false));
        assert!(!drain_over(ago(1500), false));
        // A child that keeps writing never goes quiet: the cap ends it.
        assert!(drain_over(ago(2100), false));
        // Quiet inside the grace: not yet.
        assert!(!drain_over(ago(50), true));
    }
}
