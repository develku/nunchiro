//! Ticket 358 (327): the path, arguments and env names Claude or Codex launch with, approved by the owner. One file per
//! agent under `<home>/agent-commands/` holds the `approved` command and the `pending` one that passed the confined check
//! and waits for its grant, so a change never replaces what new sessions run until the owner approves it.
//!
//! The grant lives in `approvals.json` under its own subject, because the ACP path refuses these commands on purpose
//! (`claude_refusal`, the handshake). The hash binds the text of the path, arguments and env names, not the binary at that
//! path: see the shortcut above `check_agent`.
use super::{Level, State, SubjectKind, confined, hash, store};
use crate::{
    acp::config::{self, Entry},
    agent_permission::agent_key,
    api::AgentKind,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// One confined run at a time; a second waits at most the run's cap, off the registry lock.
static CHECKING: Mutex<()> = Mutex::new(());
/// One read-modify-write of an agent's file at a time. Held briefly: the grant takes it under the registry lock.
static FILE: Mutex<()> = Mutex::new(());
const VERSION: u32 = 1;
const DAMAGED: &str = "command file is damaged";

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approved: Option<Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Entry>,
}
impl Default for Stored {
    fn default() -> Self {
        Self {
            version: VERSION,
            approved: None,
            pending: None,
        }
    }
}

/// What the row shows. `state` is `None` when there is no override: new sessions run the agent found on PATH.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct CommandView {
    pub agent: String,
    pub state: Option<State>,
    pub approved: Option<Entry>,
    /// Passed the check and waits for the owner; new sessions do not use it.
    pub pending: Option<Entry>,
    /// Per saved env name: whether the core has a value. Never the value.
    pub env_set: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct CommandCheck {
    pub version: Option<String>,
    pub error: Option<String>,
    /// Only when the check passed: the hash the grant must quote.
    pub hash: Option<String>,
    pub env_set: BTreeMap<String, bool>,
}

/// Held by a launch. Only `check_command` makes one, and the start reads it again under the session lock.
#[derive(Debug, Clone)]
pub struct CommandProof {
    entry: Entry,
    hash: String,
}
impl CommandProof {
    pub fn path(&self) -> &str {
        &self.entry.command
    }
    pub fn args(&self) -> &[String] {
        &self.entry.args
    }
    pub fn hash(&self) -> &str {
        &self.hash
    }
}

fn name(kind: AgentKind) -> Result<&'static str, String> {
    agent_key(kind).ok_or_else(|| "only Claude and Codex have a command to approve".to_string())
}
fn folder(home: &Path) -> PathBuf {
    home.join("agent-commands")
}
fn file(home: &Path, agent: &str) -> PathBuf {
    folder(home).join(format!("{agent}.json"))
}

/// Per name, whether the core has a usable value (the rule of `acp::client::env_set`, private to that module).
fn env_set(names: &[String]) -> BTreeMap<String, bool> {
    names
        .iter()
        .map(|n| (n.clone(), std::env::var(n).is_ok_and(|v| !v.is_empty())))
        .collect()
}

fn read(home: &Path, agent: &str) -> Result<Stored, String> {
    let bytes = match crate::store::read_regular(&file(home, agent)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Stored::default()),
        Err(e) => return Err(format!("{agent} command: {e}")),
    };
    let stored: Stored =
        serde_json::from_slice(&bytes).map_err(|_| format!("{agent} {DAMAGED}"))?;
    if stored.version != VERSION {
        // Not damaged: a newer Nunchiro wrote it, and a check must not rewrite it without its approved command.
        return Err(format!(
            "{agent} command: version {} is not read here",
            stored.version
        ));
    }
    Ok(stored)
}
fn save(home: &Path, agent: &str, stored: &Stored) -> Result<(), String> {
    crate::store::private_dir(&folder(home))?;
    let bytes = serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?;
    crate::store::write_capped(&file(home, agent), &bytes, crate::store::READ_MAX)
}
fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    FILE.lock()
        .map_err(|_| "agent commands are busy".to_string())
}

fn view_default(agent: &str) -> CommandView {
    CommandView {
        agent: agent.into(),
        state: None,
        approved: None,
        pending: None,
        env_set: BTreeMap::new(),
    }
}

pub fn command_status(home: &Path, kind: AgentKind) -> Result<CommandView, String> {
    let agent = name(kind)?;
    // A damaged store must not stop every Claude and Codex start: with no command file there is no override to verify.
    let approvals = match store::load(home) {
        Err(_) if !file(home, agent).exists() => return Ok(view_default(agent)),
        other => other?,
    };
    let granted = approvals
        .find(SubjectKind::AgentCommand, agent)
        .map(|a| a.hash.clone());
    let (stored, damaged) = match read(home, agent) {
        Ok(stored) => (stored, false),
        Err(_) => (Stored::default(), true),
    };
    let state = match (&stored.approved, &granted) {
        _ if damaged => Some(State::Changed),
        (None, None) => None,
        (Some(entry), Some(hash)) if hash::entry(entry) == *hash => Some(State::Approved),
        (Some(_), None) => Some(State::Unapproved),
        // Granted, but the text differs or the entry is gone: never a fall-through to the PATH command.
        (_, Some(_)) => Some(State::Changed),
    };
    let env = stored.approved.as_ref().map_or(&[][..], |e| &e.env);
    Ok(CommandView {
        agent: agent.into(),
        state,
        env_set: env_set(env),
        pending: stored
            .pending
            .filter(|p| Some(p) != stored.approved.as_ref()),
        approved: stored.approved,
    })
}

/// The command a new session must run: `None` for the PATH command, `Err` when the stored one cannot be trusted.
pub fn check_command(home: &Path, kind: AgentKind) -> Result<Option<CommandProof>, String> {
    let Some(agent) = agent_key(kind) else {
        return Ok(None);
    };
    let view = command_status(home, kind)?;
    match (view.state, view.approved) {
        (None, _) => Ok(None),
        (Some(State::Approved), Some(entry)) => Ok(Some(CommandProof {
            hash: hash::entry(&entry),
            entry,
        })),
        (Some(State::Unapproved), _) => Err(format!("{agent} command is not approved")),
        _ => Err(format!("{agent} command changed since it was approved")),
    }
}

/// The rules at the trust boundary. `config::validate` holds the shape; a secret typed as a name is refused, not echoed.
fn problem(entry: &Entry) -> Option<String> {
    if let Err(e) = config::validate(entry) {
        return Some(e.replace("invalid agents.toml: ", ""));
    }
    let control = |s: &str| s.chars().any(char::is_control);
    if control(&entry.command) || entry.args.iter().any(|a| control(a)) {
        return Some("the command and its arguments cannot hold control characters".into());
    }
    if entry
        .env
        .iter()
        .any(|n| n.bytes().any(|b| b.is_ascii_lowercase()))
    {
        return Some(
            "env holds variable names only (A-Z, 0-9, _); values stay in your environment".into(),
        );
    }
    None
}

/// Runs the confined check; a pass holds the command as `pending`, the only way one gets there. `Err` only for a request
/// that is not about Claude or Codex.
pub fn command_check(
    home: &Path,
    kind: AgentKind,
    path: String,
    args: Vec<String>,
    env: Vec<String>,
) -> Result<CommandCheck, String> {
    let agent = name(kind)?;
    let env_set = env_set(&env);
    let entry = Entry {
        name: agent.into(),
        command: path,
        args,
        env,
        display: None,
    };
    let refuse = |error: String| CommandCheck {
        error: Some(error),
        env_set: env_set.clone(),
        ..CommandCheck::default()
    };
    if let Some(reason) = problem(&entry) {
        return Ok(refuse(reason));
    }
    let Some(found) = crate::acp::found(&entry.command) else {
        return Ok(refuse(format!("{} was not found", entry.command)));
    };
    let _running = CHECKING.lock().map_err(|_| "a check failed".to_string())?;
    let version = match confined::version(home, &found) {
        Ok(version) => version,
        Err(reason) => return Ok(refuse(reason)),
    };
    let hash = hash::entry(&entry);
    let _file = lock()?;
    // A damaged file must not block the repair: the check and grant replace it. Q9 tt-J11-2: a file that could not be
    // read is not damaged, and rewriting it would drop the approved command.
    let mut stored = match read(home, agent) {
        Err(e) if !e.ends_with(DAMAGED) => return Err(e),
        read => read.unwrap_or_default(),
    };
    stored.pending = Some(entry);
    save(home, agent, &stored)?;
    Ok(CommandCheck {
        version: Some(version),
        error: None,
        hash: Some(hash),
        env_set,
    })
}

/// Promotes the held command whose hash the form showed. When the grant cannot be saved, the command file is put back,
/// so the old grant keeps matching the approved command; if that write fails too, the mismatch refuses the launch.
pub fn command_grant(home: &Path, kind: AgentKind, seen_hash: &str) -> Result<CommandView, String> {
    let agent = name(kind)?;
    {
        let _file = lock()?;
        let mut stored = read(home, agent).unwrap_or_default();
        let before = stored.approved.clone();
        let pending = stored.pending.take().ok_or("check the command first")?;
        let hash = hash::entry(&pending);
        if hash != seen_hash {
            return Err("the command changed since it was checked; check it again".into());
        }
        // The file is the same user's to edit: what is promoted meets the rules whatever wrote it.
        if let Some(reason) = problem(&pending) {
            return Err(reason);
        }
        let mut approvals = store::load(home)?;
        approvals.set(store::Approval {
            kind: SubjectKind::AgentCommand,
            name: agent.into(),
            level: Level::Act,
            hash,
            granted_at_ms: crate::queue::now_ms(),
        });
        stored.approved = Some(pending);
        save(home, agent, &stored)?;
        if let Err(e) = approvals.save(home) {
            // Q9 tt-J11-1: back to the approved command the old grant names, the new one held again for a retry.
            stored.pending = std::mem::replace(&mut stored.approved, before);
            let _ = save(home, agent, &stored);
            return Err(e);
        }
    }
    command_status(home, kind)
}

/// `draft_only` drops the held command and keeps the approved one (취소). Otherwise back to the PATH command: the grant
/// goes first, so a failure in between leaves a command that needs approval, never a grant waiting for one.
pub fn command_reset(
    home: &Path,
    kind: AgentKind,
    draft_only: bool,
) -> Result<CommandView, String> {
    let agent = name(kind)?;
    {
        let _file = lock()?;
        if draft_only {
            let mut stored = read(home, agent)?;
            stored.pending = None;
            save(home, agent, &stored)?;
        } else {
            // A store that will not load must not trap the owner: this is the only way back to the PATH agent. A grant
            // left in it reads as changed if the store is repaired, so it refuses the start and never runs anything.
            if let Ok(mut approvals) = store::load(home)
                && approvals.find(SubjectKind::AgentCommand, agent).is_some()
            {
                approvals.remove(SubjectKind::AgentCommand, agent);
                approvals.save(home)?;
            }
            match std::fs::remove_file(file(home, agent)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(format!("{agent} command: {e}"));
                }
                _ => {}
            }
        }
    }
    command_status(home, kind)
}
