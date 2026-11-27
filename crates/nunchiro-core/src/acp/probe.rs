//! V2-4b: the setup sheet's check of a typed entry, which runs BEFORE any approval. It is therefore confined: the
//! command the user typed runs once, with only the entry's allowed env names, in a fresh empty folder under
//! `<home>/acp-check/`, for at most `CAP`; only the handshake (`initialize`, `session/new`) is read, and nothing the
//! agent asks of the client (a file, a terminal, a permission) is ever answered. The agent's whole process group is
//! killed and the folder removed on every way out. It never reads or writes the approvals file or `agents.toml`.
use super::{client::allowed_env, config::Entry};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

/// The handshake's total time, spawn included.
const CAP: Duration = Duration::from_secs(5);
/// One agent message at most (the client's own limit).
const LINE_MAX: u64 = 1024 * 1024;
const INITIALIZE: u64 = 0;
const OPEN: u64 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Check {
    pub found_path: Option<String>,
    pub version: Option<String>,
    /// Milliseconds from the start of the handshake to a v1 `initialize` result.
    pub acp_v1_ms: Option<u64>,
    /// What the agent says it can do (`agentCapabilities` entries that are true).
    pub capabilities: Vec<String>,
    /// True when `session/new` gave a session, false when it answered `auth_required`, none when it did not get there.
    pub signed_in: Option<bool>,
    pub error: Option<String>,
    /// Per env name: whether the core has a value to pass. Never the value.
    #[serde(default)]
    pub env_set: std::collections::BTreeMap<String, bool>,
    /// Ticket 358: the sign-in methods the agent reports and this client can offer (`auth_methods`).
    #[serde(default)]
    pub auth_methods: Vec<AuthMethod>,
    /// The agent advertises `logout` (`agentCapabilities.auth.logout`).
    #[serde(default)]
    pub can_logout: bool,
    /// The sign-in running for this agent, so a reloaded window finds it (filled in by `acp::setup`).
    #[serde(default)]
    pub sign_in: Option<super::add::SignIn>,
}

/// One sign-in method as the agent reported it, bounded. `kind` is `agent` or `terminal` only: a browser and a device code
/// are both `agent` (ACP cannot tell them apart), and `env_var` is left out, since Nunchiro stores no key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// What a terminal method appends to the agent's command; read at sign-in, never sent to the window.
    #[serde(skip)]
    pub(super) args: Vec<String>,
}

const METHODS_MAX: usize = 16;
const METHOD_ID_MAX: usize = 128;
const METHOD_NAME_MAX: usize = 64;
const METHOD_ARGS_MAX: usize = 16;
const METHOD_ARG_MAX: usize = 1024;

/// T3 Code's `normalizeAcpRegistryAuthMethods` (behaviour only): a missing type is `agent`, a bad id drops the method and a
/// bad name falls back to the id. A terminal method whose args do not fit is dropped: cutting one would run something else.
pub(super) fn auth_methods(reported: &Value) -> Vec<AuthMethod> {
    let mut methods: Vec<AuthMethod> = vec![];
    for method in reported.as_array().into_iter().flatten() {
        let Some(id) = method["id"].as_str().filter(|id| {
            !id.is_empty() && id.len() <= METHOD_ID_MAX && !id.chars().any(char::is_control)
        }) else {
            continue;
        };
        let kind = match method["type"].as_str() {
            None | Some("agent") => "agent",
            Some("terminal") => "terminal",
            _ => continue,
        };
        let args = if kind == "terminal" {
            let Some(args) = terminal_args(&method["args"]) else {
                continue;
            };
            args
        } else {
            vec![]
        };
        if methods.iter().any(|m| m.id == id) {
            continue;
        }
        let name: String = method["name"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(METHOD_NAME_MAX)
            .collect();
        methods.push(AuthMethod {
            id: id.into(),
            name: if crate::accounts::check_label(&name).is_ok() {
                name
            } else {
                id.chars().take(METHOD_NAME_MAX).collect()
            },
            kind: kind.into(),
            args,
        });
        if methods.len() == METHODS_MAX {
            break;
        }
    }
    methods
}

/// `None` when the args cannot be run as reported. Absent is no args.
fn terminal_args(args: &Value) -> Option<Vec<String>> {
    if args.is_null() {
        return Some(vec![]);
    }
    let args = args.as_array().filter(|a| a.len() <= METHOD_ARGS_MAX)?;
    args.iter()
        .map(|arg| {
            arg.as_str()
                .filter(|a| a.len() <= METHOD_ARG_MAX && !a.chars().any(char::is_control))
                .map(String::from)
        })
        .collect()
}

/// `agentCapabilities.auth.logout`: `{}` advertises it; absent or null does not (T3 Code `AcpSessionRuntime.logout`).
pub(super) fn can_logout(capabilities: &Value) -> bool {
    capabilities["auth"]["logout"].is_object()
}

/// At most one check at a time.
static RUNNING: AtomicBool = AtomicBool::new(false);
struct Running;
impl Running {
    fn take() -> Result<Self, String> {
        RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "a check is running".to_string())
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// The fresh empty folder the check runs in; removed on every way out (error, timeout, success, panic).
pub(super) struct Folder(pub(super) PathBuf);
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The agent's process group, killed on every way out (declared after its folder, so it is gone before the folder is).
struct Spawned(Child);
impl Drop for Spawned {
    fn drop(&mut self) {
        // Killed before it is reaped, so the group id still names this group.
        unsafe { libc::kill(-(self.0.id() as i32), libc::SIGKILL) };
        let _ = self.0.wait();
    }
}

fn refuse(error: String) -> Check {
    Check {
        error: Some(error),
        ..Check::default()
    }
}

/// `Err` only for "a check is running"; every other outcome is a `Check`.
pub(crate) fn check(home: &Path, entry: &Entry) -> Result<Check, String> {
    let _running = Running::take()?;
    let env_set = super::client::env_set(&entry.env);
    let refuse = |error| Check {
        env_set: env_set.clone(),
        ..refuse(error)
    };
    if let Some(reason) = super::config::claude_refusal(entry) {
        return Ok(refuse(reason));
    }
    if let Err(e) = super::config::validate(entry) {
        return Ok(refuse(e.replace("invalid agents.toml: ", "")));
    }
    let Some(path) = super::found(&entry.command) else {
        return Ok(refuse(format!("{} was not found", entry.command)));
    };
    let mut out = Check {
        found_path: Some(path.display().to_string()),
        env_set: env_set.clone(),
        ..Check::default()
    };
    let result = folder(home).and_then(|folder| {
        // Both runs of the typed command are confined alike: the entry's allowed env names only, in the empty folder.
        out.version = version(&path, entry, &folder.0);
        handshake(entry, &path, &folder, &mut out)
    });
    if let Err(e) = result {
        out.error = Some(crate::problems::details(&e));
    }
    Ok(out)
}

pub(super) fn folder(home: &Path) -> Result<Folder, String> {
    let folder = home
        .join("acp-check")
        .join(crate::store::new_id().map_err(|e| format!("check folder: {e}"))?);
    crate::store::private_dir(&home.join("acp-check"))?;
    crate::store::private_dir(&folder)?;
    Ok(Folder(folder))
}

/// `<command> --version` as the first-run checklist runs it (3 s), but with the check's environment, not the core's.
pub(super) fn version(path: &Path, entry: &Entry, folder: &Path) -> Option<String> {
    let mut command = crate::process::command(path);
    command
        .arg("--version")
        .env_clear()
        .envs(allowed_env(&entry.env))
        .current_dir(folder)
        .stdin(Stdio::null());
    let out = crate::process::output(command, Duration::from_secs(3)).ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// One confined run of an entry's command (only its allowed env names, in `folder`); its whole group dies with this value.
pub(super) struct Run {
    agent: Spawned,
    stdin: ChildStdin,
    /// What the agent writes, one JSON value a line, until its output closes.
    pub(super) messages: mpsc::Receiver<Value>,
}

impl Run {
    pub(super) fn pid(&self) -> i32 {
        self.agent.0.id() as i32
    }
    pub(super) fn send(&mut self, message: Value) -> Result<(), String> {
        self.stdin
            .write_all((message.to_string() + "\n").as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|e| format!("the agent is not reading its input: {e}"))
    }
}

pub(super) fn run(entry: &Entry, path: &Path, folder: &Folder) -> Result<Run, String> {
    let mut command = crate::process::command(path);
    command
        .args(&entry.args)
        .env_clear()
        .envs(allowed_env(&entry.env))
        .current_dir(&folder.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Its own session, so the group is the agent and all it starts.
    unsafe { command.pre_exec(crate::process::setsid) };
    let child = command
        .spawn()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let mut agent = Spawned(child);
    let stdin = agent.0.stdin.take().ok_or("no agent stdin")?;
    let stdout = agent.0.stdout.take().ok_or("no agent stdout")?;
    // Bounded: an agent that floods lines waits on its own stdout instead of growing the core.
    let (tell, messages) = mpsc::sync_channel::<Value>(256);
    // Ends when the pipe closes (the group is killed on the way out).
    std::thread::Builder::new()
        .name("acp-check".into())
        .spawn(move || {
            let mut lines = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match (&mut lines).take(LINE_MAX).read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if !line.ends_with(b"\n") => break,
                    Ok(_) => {}
                }
                if let Ok(message) = serde_json::from_slice::<Value>(&line)
                    && tell.send(message).is_err()
                {
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Run {
        agent,
        stdin,
        messages,
    })
}

/// The `initialize` every confined run sends. Only sign-in adds a capability the agent can use.
pub(super) fn initialize(client_capabilities: Value) -> Value {
    json!({"jsonrpc":"2.0","id":INITIALIZE,"method":"initialize","params":{
        "protocolVersion": super::client::PROTOCOL,
        "clientCapabilities": client_capabilities,
        "clientInfo": {"name": "nunchiro", "version": env!("CARGO_PKG_VERSION")},
    }})
}

fn handshake(entry: &Entry, path: &Path, folder: &Folder, out: &mut Check) -> Result<(), String> {
    let began = Instant::now();
    let mut agent = run(entry, path, folder)?;
    // No file, terminal or elicitation is answered here. `auth.terminal` only asks the agent to list its terminal sign-in.
    agent.send(initialize(json!({"auth": {"terminal": true}})))?;
    let mut stage = "initialize";
    loop {
        let left = CAP.saturating_sub(began.elapsed());
        let message = match agent.messages.recv_timeout(left) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "the agent did not answer {stage} within {} s",
                    CAP.as_secs()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "the agent closed its output before answering {stage}"
                ));
            }
        };
        // A request of the agent (it has a method): never answered.
        if message.get("method").is_some() {
            continue;
        }
        let error = message.get("error").filter(|e| !e.is_null()).map(|e| {
            e["message"]
                .as_str()
                .map_or_else(|| e.to_string(), String::from)
        });
        match (message["id"].as_u64(), stage) {
            (Some(INITIALIZE), "initialize") => {
                if let Some(e) = error {
                    return Err(format!("initialize: {e}"));
                }
                let version = &message["result"]["protocolVersion"];
                if version.as_u64() != Some(super::client::PROTOCOL) {
                    return Err(format!(
                        "the agent speaks ACP version {version}; Nunchiro speaks version {}",
                        super::client::PROTOCOL
                    ));
                }
                out.acp_v1_ms = Some(began.elapsed().as_millis() as u64);
                out.capabilities = capabilities(&message["result"]["agentCapabilities"]);
                out.auth_methods = auth_methods(&message["result"]["authMethods"]);
                out.can_logout = can_logout(&message["result"]["agentCapabilities"]);
                stage = "session/new";
                agent.send(json!({"jsonrpc":"2.0","id":OPEN,"method":"session/new",
                    "params":{"cwd":folder.0.display().to_string(),"mcpServers":[]}}))?;
            }
            (Some(OPEN), "session/new") => {
                return match error {
                    None if message["result"]["sessionId"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty()) =>
                    {
                        out.signed_in = Some(true);
                        Ok(())
                    }
                    None => Err("session/new answered no session id".into()),
                    Some(e) if auth_required(&message["error"], &e) => {
                        out.signed_in = Some(false);
                        Err(e)
                    }
                    Some(e) => Err(format!("session start: {e}")),
                };
            }
            _ => {}
        }
    }
}

/// ACP's `auth_required` is error code -32000; agents also say it in words.
pub(super) fn auth_required(error: &Value, message: &str) -> bool {
    let lower = message.to_lowercase();
    error["code"] == -32000
        || lower.contains("auth_required")
        || lower.contains("authentication required")
}

/// The `agentCapabilities` entries that are true, one level deep (`promptCapabilities.image`), sorted.
fn capabilities(caps: &Value) -> Vec<String> {
    let mut names = vec![];
    for (key, value) in caps.as_object().into_iter().flatten() {
        match value {
            Value::Bool(true) => names.push(key.clone()),
            Value::Object(inner) => names.extend(
                inner
                    .iter()
                    .filter(|(_, v)| **v == true)
                    .map(|(k, _)| format!("{key}.{k}")),
            ),
            _ => {}
        }
    }
    names.truncate(32);
    names
        .into_iter()
        .map(|n| n.chars().take(64).collect())
        .collect()
}
