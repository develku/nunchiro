//! The ACP v1 client side of one agent: a stdio child of the core (its own session, ended with the core), one reader
//! thread and one writer thread. The reader answers the client capabilities itself (files confined to the session
//! root, terminals in core PTYs) and hands everything a person or the registry must see to `events`; nothing here
//! takes the registry lock, and nothing the registry calls blocks on the agent.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
};

/// The only protocol version this client speaks; v2 (draft) stays off until it stabilizes.
pub const PROTOCOL: u64 = 1;
/// One agent message at most; a longer line refuses the agent (the session ends failed).
const LINE_MAX: u64 = 1024 * 1024;
/// What one queued event may hold: the reader cuts payloads to this before queueing (same rule as the chat feed),
/// so the bounded channel holds at most EVENTS_MAX of these.
pub const QUEUED_MAX: usize = 64 * 1024;
const TERMINALS_MAX: usize = 16;
const TERMINAL_OUTPUT_MAX: usize = 1024 * 1024;
/// Messages waiting for the registry's next pass; a full channel holds the reader, so the agent waits on its own
/// stdout (backpressure) instead of the core growing.
const EVENTS_MAX: usize = 1024;
/// At most this many events per registry pass, so a flooding agent cannot hold the registry lock.
const EVENTS_PER_PASS: usize = 256;
/// Messages waiting for the agent to read its stdin.
const OUTGOING_MAX: usize = 1024;
/// `terminal/wait_for_exit` requests waiting on one terminal; more are refused (-32000).
const WAITERS_MAX: usize = 64;
/// Request ids this client uses for the handshake; prompts take ids from `FIRST_PROMPT` on.
const INITIALIZE: u64 = 0;
const OPEN: u64 = 1;
const FIRST_PROMPT: u64 = 2;

#[derive(Debug)]
pub enum Event {
    /// The handshake finished: the agent's session id, whether it declared `loadSession`, and its config options.
    Ready {
        session: String,
        load: bool,
        config: Value,
    },
    /// The handshake failed or the agent speaks another protocol version; the child is being ended.
    Failed(String),
    /// A request a person answers: `session/request_permission` or `elicitation/create`.
    Ask {
        rpc: Value,
        method: String,
        params: Value,
    },
    /// One `session/update` body.
    Update(Value),
    /// Ticket 358: the answer to `session/set_config_option`: the agent's config options (`Null` when it sent none), or its error.
    ConfigSet(Result<Value, String>),
    /// A prompt's response: its stop reason, or the error.
    TurnEnd(Result<String, String>),
    /// The agent's stdout closed.
    Closed,
}

pub struct Client {
    child: Child,
    out: SyncSender<Value>,
    events: Receiver<Event>,
    next: u64,
    /// The id of the prompt in flight (0: none). Only its response ends a turn.
    prompting: Arc<AtomicU64>,
    /// The id of the `session/set_config_option` in flight (0: none). A newer one replaces it, so an agent that never
    /// answers cannot lock the choice.
    setting: Arc<AtomicU64>,
    terminals: Arc<Terminals>,
}

/// Per name, whether `allowed_env` would pass a usable value. An empty value counts as unset; the value is never returned.
pub fn env_set(names: &[String]) -> std::collections::BTreeMap<String, bool> {
    env_set_in(names, |n| std::env::var(n).ok())
}

fn env_set_in(
    names: &[String],
    value: impl Fn(&str) -> Option<String>,
) -> std::collections::BTreeMap<String, bool> {
    names
        .iter()
        .map(|n| (n.clone(), value(n).is_some_and(|v| !v.is_empty())))
        .collect()
}

#[cfg(test)]
mod env_set_tests {
    #[test]
    fn reports_set_or_unset_and_never_the_value() {
        let names = ["SET", "EMPTY", "NONE"].map(String::from);
        let got = super::env_set_in(&names, |n| match n {
            "SET" => Some("sk-secret".into()),
            "EMPTY" => Some(String::new()),
            _ => None,
        });
        assert!(got["SET"]);
        assert!(!got["EMPTY"]);
        assert!(!got["NONE"]);
        assert!(!serde_json::to_string(&got).unwrap().contains("sk-secret"));
    }
}

/// What an agent may see of the core's environment: the entry's allowed names with the core's values.
pub fn allowed_env(names: &[String]) -> Vec<(String, String)> {
    names
        .iter()
        .filter_map(|n| std::env::var(n).ok().map(|v| (n.clone(), v)))
        .collect()
}

impl Client {
    /// Starts `command` in `root` with only `env`, and runs the handshake in the background: `session/load` of
    /// `resume` when given (the caller checked the agent declared it), else `session/new`.
    pub fn spawn(
        command: &str,
        args: &[String],
        env: Vec<(String, String)>,
        root: &Path,
        denied: Vec<PathBuf>,
        resume: Option<String>,
    ) -> Result<Self, String> {
        let mut cmd = crate::process::command(command);
        cmd.args(args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Its own session: `peer::containing` places the agent and all it starts inside this Nunchiro session.
        unsafe { cmd.pre_exec(crate::process::setsid) };
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("acp agent {command}: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("no agent stdin")?;
        let stdout = child.stdout.take().ok_or("no agent stdout")?;
        let (out, outgoing) = mpsc::sync_channel::<Value>(OUTGOING_MAX);
        let (tell, events) = mpsc::sync_channel(EVENTS_MAX);
        std::thread::Builder::new()
            .name("acp-write".into())
            .spawn(move || {
                for message in outgoing {
                    let line = message.to_string() + "\n";
                    if stdin
                        .write_all(line.as_bytes())
                        .and_then(|()| stdin.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let terminals = Arc::new(Terminals {
            root: root.to_path_buf(),
            env,
            out: out.clone(),
            list: Mutex::new(BTreeMap::new()),
        });
        let prompting = Arc::new(AtomicU64::new(0));
        let setting = Arc::new(AtomicU64::new(0));
        let reader = Reader {
            root: root.to_path_buf(),
            denied,
            out: out.clone(),
            tell,
            resume,
            terminals: terminals.clone(),
            prompting: prompting.clone(),
            setting: setting.clone(),
            session: None,
            load: false,
            initialized: false,
            opened: false,
        };
        out.send(
            json!({"jsonrpc":"2.0","id":INITIALIZE,"method":"initialize","params":{
                "protocolVersion": PROTOCOL,
                "clientCapabilities": {
                    "fs": {"readTextFile": true, "writeTextFile": true},
                    "terminal": true,
                    "elicitation": {"url": {}},
                },
                "clientInfo": {"name": "nunchiro", "version": env!("CARGO_PKG_VERSION")},
            }}),
        )
        .map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("acp-read".into())
            .spawn(move || reader.run(stdout))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            child,
            out,
            events,
            next: FIRST_PROMPT,
            prompting,
            setting,
            terminals,
        })
    }
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
    /// Pids of the core PTYs the agent's terminals run in (each its own session leader).
    pub fn terminal_pids(&self) -> Vec<u32> {
        self.terminals
            .list
            .lock()
            .map(|l| l.values().filter_map(|t| t.pid).collect())
            .unwrap_or_default()
    }
    /// The agent itself exited (its stdout may stay open in a child it left behind).
    pub fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }
    pub fn events(&self) -> Vec<Event> {
        self.events.try_iter().take(EVENTS_PER_PASS).collect()
    }
    /// Everything queued: once the agent exited nothing refills the channel but the rest of its pipe.
    pub fn all_events(&self) -> Vec<Event> {
        self.events.try_iter().collect()
    }
    /// Never blocks the registry: an agent that stopped reading its stdin gets nothing more.
    fn send(&self, message: Value) -> Result<(), String> {
        self.out.try_send(message).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => "the agent is not reading its input".into(),
            mpsc::TrySendError::Disconnected(_) => "agent is not running".into(),
        })
    }
    pub fn prompt(&mut self, session: &str, text: &str) -> Result<(), String> {
        let id = self.next;
        self.next += 1;
        self.prompting.store(id, Ordering::SeqCst);
        let sent = self.send(
            json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{
            "sessionId": session, "prompt": [{"type":"text","text":text}]}}),
        );
        if sent.is_err() {
            self.prompting.store(0, Ordering::SeqCst);
        }
        sent
    }
    /// `value` is one the agent reported for `config` (`Acp::set_model` checks).
    pub fn set_config_option(
        &mut self,
        session: &str,
        config: &str,
        value: &str,
    ) -> Result<(), String> {
        let id = self.next;
        self.next += 1;
        self.setting.store(id, Ordering::SeqCst);
        let sent = self.send(
            json!({"jsonrpc":"2.0","id":id,"method":"session/set_config_option","params":{
            "sessionId": session, "configId": config, "value": value}}),
        );
        if sent.is_err() {
            self.setting.store(0, Ordering::SeqCst);
        }
        sent
    }
    pub fn cancel(&self, session: &str) -> Result<(), String> {
        self.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}))
    }
    pub fn respond(&self, rpc: &Value, result: Value) -> Result<(), String> {
        self.send(json!({"jsonrpc":"2.0","id":rpc,"result":result}))
    }
    /// Ends the agent's whole process group (it and everything it started, also after the agent itself exited) and
    /// its terminals. The group id stays reserved while any member lives, so it never names another process's group.
    pub fn stop(&mut self) {
        self.terminals.release_all();
        let pid = self.child.id() as i32;
        let group = || unsafe { libc::kill(-pid, 0) } == 0;
        // Pid reuse: a group id stays taken while any member lives; once all are gone the signal finds no group
        // (ESRCH) unless the pid was reused by a new group leader in between (a narrow window, accepted).
        unsafe { libc::kill(-pid, libc::SIGTERM) };
        let until = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while (matches!(self.child.try_wait(), Ok(None)) || group())
            && std::time::Instant::now() < until
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        let _ = self.child.wait();
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Reader {
    root: PathBuf,
    /// Agent config and the core's home: never read or written, even inside the root.
    denied: Vec<PathBuf>,
    out: SyncSender<Value>,
    tell: SyncSender<Event>,
    resume: Option<String>,
    terminals: Arc<Terminals>,
    prompting: Arc<AtomicU64>,
    setting: Arc<AtomicU64>,
    session: Option<String>,
    load: bool,
    initialized: bool,
    opened: bool,
}
impl Reader {
    fn run(mut self, stdout: std::process::ChildStdout) {
        let mut lines = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            match (&mut lines).take(LINE_MAX).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if !line.ends_with(b"\n") && line.len() as u64 >= LINE_MAX => {
                    let _ = self
                        .tell
                        .send(Event::Failed("agent message too large".into()));
                    break;
                }
                Ok(_) => {}
            }
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                continue; // not JSON-RPC (a log line): ignored
            };
            if !self.message(message) {
                break;
            }
        }
        let _ = self.tell.send(Event::Closed);
    }
    /// False once the agent is refused.
    fn message(&mut self, m: Value) -> bool {
        let method = m["method"].as_str().map(String::from);
        let has_id = m.get("id").is_some_and(|id| !id.is_null());
        match (method, has_id) {
            (None, true) => self.response(&m),
            (Some(method), true) => {
                self.request(m["id"].clone(), &method, m["params"].clone());
                true
            }
            (Some(method), false) => {
                if method == "session/update"
                    && self.session.is_some()
                    && m["params"]["sessionId"].as_str() == self.session.as_deref()
                {
                    let mut update = m["params"]["update"].clone();
                    if !fit(&mut update) {
                        // Too big even cut: what kind of update it was, marked.
                        update = json!({"sessionUpdate": m["params"]["update"]["sessionUpdate"].as_str()
                            .map(|k| k.chars().take(64).collect::<String>()), "truncated": true});
                    }
                    let _ = self.tell.send(Event::Update(update));
                }
                true
            }
            (None, false) => true,
        }
    }
    fn fail(&self, reason: String) -> bool {
        let _ = self.tell.send(Event::Failed(reason));
        false
    }
    fn response(&mut self, m: &Value) -> bool {
        let error = m.get("error").filter(|e| !e.is_null()).map(|e| {
            e["message"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| e.to_string())
        });
        match m["id"].as_u64() {
            // The handshake's ids count once each: a repeat after it is a forged response, ignored below.
            Some(INITIALIZE) if !self.initialized => {
                self.initialized = true;
                if let Some(e) = error {
                    return self.fail(format!("initialize: {e}"));
                }
                let version = m["result"]["protocolVersion"].as_u64();
                if version != Some(PROTOCOL) {
                    return self.fail(format!(
                        "the agent speaks ACP version {}; Nunchiro speaks version {PROTOCOL}",
                        m["result"]["protocolVersion"]
                    ));
                }
                self.load = m["result"]["agentCapabilities"]["loadSession"] == true;
                let root = self.root.display().to_string();
                let open = match &self.resume {
                    Some(_) if !self.load => {
                        return self.fail("the agent cannot load a session".into());
                    }
                    Some(id) => json!({"jsonrpc":"2.0","id":OPEN,"method":"session/load",
                        "params":{"sessionId":id,"cwd":root,"mcpServers":[]}}),
                    None => json!({"jsonrpc":"2.0","id":OPEN,"method":"session/new",
                        "params":{"cwd":root,"mcpServers":[]}}),
                };
                // Updates replayed by `session/load` belong to this session already.
                self.session = self.resume.clone();
                let _ = self.out.send(open);
                true
            }
            Some(OPEN) if self.initialized && !self.opened => {
                self.opened = true;
                if let Some(e) = error {
                    return self.fail(format!("session start: {e}"));
                }
                let session = match (&self.resume, m["result"]["sessionId"].as_str()) {
                    (Some(id), _) => id.clone(),
                    (None, Some(id)) if !id.is_empty() && id.len() <= 256 => id.into(),
                    _ => return self.fail("session/new answered no session id".into()),
                };
                self.session = Some(session.clone());
                let _ = self.tell.send(Event::Ready {
                    session,
                    load: self.load,
                    config: m["result"]["configOptions"].clone(),
                });
                true
            }
            Some(id)
                if id >= FIRST_PROMPT
                    && self
                        .setting
                        .compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok() =>
            {
                let _ = self.tell.send(Event::ConfigSet(match error {
                    Some(e) => Err(e),
                    None => Ok(m["result"]["configOptions"].clone()),
                }));
                true
            }
            // Only the prompt in flight ends a turn; any other id (forged, repeated, late) is ignored.
            Some(id)
                if id >= FIRST_PROMPT
                    && self
                        .prompting
                        .compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok() =>
            {
                let end = match error {
                    Some(e) => Err(e),
                    None => Ok(m["result"]["stopReason"]
                        .as_str()
                        .unwrap_or("end_turn")
                        .to_string()),
                };
                let _ = self.tell.send(Event::TurnEnd(end));
                true
            }
            _ => {
                eprintln!("acp: ignored a response to no request in flight");
                true
            }
        }
    }
    fn request(&mut self, rpc: Value, method: &str, params: Value) {
        let reply = |result: Result<Value, String>| {
            let _ = self.out.send(match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":rpc,"result":result}),
                Err(message) => {
                    json!({"jsonrpc":"2.0","id":rpc,"error":{"code":-32602,"message":message}})
                }
            });
        };
        if self.session.is_none() || params["sessionId"].as_str() != self.session.as_deref() {
            return reply(Err("unknown session".into()));
        }
        match method {
            "session/request_permission" | "elicitation/create" => {
                let mut params = params;
                if !fit(&mut params) {
                    // Still shown and answerable (reject only: no option survives).
                    params = json!({"message": "The agent sent a request too large to show",
                        "toolCall": {"title": "a request too large to show"}, "options": [], "truncated": true});
                }
                let _ = self.tell.send(Event::Ask {
                    rpc: rpc.clone(),
                    method: method.into(),
                    params,
                });
            }
            "fs/read_text_file" => reply(read(&self.root, &self.denied, &params)),
            "fs/write_text_file" => {
                reply(write(&self.root, &self.denied, &params).map(|()| Value::Null))
            }
            "terminal/create" => reply(self.terminals.create(&params)),
            "terminal/output" => reply(self.terminals.output(&params)),
            "terminal/kill" => reply(self.terminals.kill(&params, false)),
            "terminal/release" => reply(self.terminals.kill(&params, true)),
            // Answered by the terminal's own exit watcher: no thread per request.
            "terminal/wait_for_exit" => match self.terminals.wait(&params, &rpc) {
                Ok(Some(exit)) => reply(Ok(exit)),
                Ok(None) => {}
                Err((code, message)) => {
                    let _ = self.out.send(
                        json!({"jsonrpc":"2.0","id":rpc,"error":{"code":code,"message":message}}),
                    );
                }
            },
            _ => {
                let _ = self.out.send(json!({"jsonrpc":"2.0","id":rpc,
                    "error":{"code":-32601,"message":"method not found"}}));
            }
        }
    }
}

/// B3 confinement: an absolute path under the session root, with no `..`, `.` or `.git` component.
fn relative<'a>(root: &Path, path: &'a str) -> Result<&'a Path, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "outside the session root")?;
    if rel.as_os_str().is_empty()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("path not allowed".into());
    }
    Ok(rel)
}

/// `path` (canonical) is in agent config or the core's home. Compared component by component ignoring ASCII case,
/// because the default macOS volume does (V2.5-41).
fn is_denied(denied: &[PathBuf], path: &Path) -> bool {
    denied.iter().any(|d| {
        let mut parts = path.components();
        d.components().all(|want| {
            parts.next().is_some_and(|got| {
                got.as_os_str()
                    .as_encoded_bytes()
                    .eq_ignore_ascii_case(want.as_os_str().as_encoded_bytes())
            })
        })
    })
}

fn read(root: &Path, denied: &[PathBuf], params: &Value) -> Result<Value, String> {
    let rel = relative(root, params["path"].as_str().ok_or("missing path")?)?;
    let real = std::fs::canonicalize(root.join(rel)).map_err(|_| "not found")?;
    if is_denied(denied, &real) || is_denied(denied, &root.join(rel)) {
        return Err("path not allowed".into());
    }
    // The window's confined reader: canonical root check after opening, no final link, no `.git`.
    let file = crate::files::read(
        &crate::files::Root::Folder(root.to_path_buf()),
        rel.to_str().ok_or("path not allowed")?,
    )?;
    let text = file.text.ok_or("not a text file or too large")?;
    let start = params["line"].as_u64().unwrap_or(1).max(1) as usize - 1;
    let content = match params["limit"].as_u64() {
        None if start == 0 => text,
        limit => text
            .split_inclusive('\n')
            .skip(start)
            .take(limit.map_or(usize::MAX, |l| l as usize))
            .collect(),
    };
    Ok(json!({ "content": content }))
}

fn write(root: &Path, denied: &[PathBuf], params: &Value) -> Result<(), String> {
    let rel = relative(root, params["path"].as_str().ok_or("missing path")?)?;
    let content = params["content"].as_str().ok_or("missing content")?;
    if rel.components().any(|c| {
        c.as_os_str()
            .as_encoded_bytes()
            .eq_ignore_ascii_case(b".git")
    }) {
        return Err("path not allowed".into());
    }
    let name = rel.file_name().ok_or("path not allowed")?;
    let base = std::fs::canonicalize(root).map_err(|_| "root unavailable")?;
    // The folder is opened, then checked where it really is; the file is created relative to that descriptor
    // without following a final link, so a link swapped in anywhere on the way cannot lead out.
    let dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NONBLOCK)
        .open(base.join(rel.parent().unwrap_or(Path::new(""))))
        .map_err(|_| "folder not found")?;
    let folder = fd_path(&dir)?;
    if !folder.starts_with(&base) {
        return Err("outside the session root".into());
    }
    if is_denied(denied, &folder) || is_denied(denied, &folder.join(name)) {
        return Err("path not allowed".into());
    }
    let name = std::ffi::CString::new(name.as_encoded_bytes()).map_err(|_| "path not allowed")?;
    let dir_fd = std::os::fd::AsRawFd::as_raw_fd(&dir);
    // V2.5-41: the target is opened, never created, so a write that fails leaves no new (empty) file behind; a new
    // name appears only by the final exclusive rename. No final link is followed.
    let fd = unsafe {
        libc::openat(
            dir_fd,
            name.as_ptr(),
            libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    // The existing target's permission bits; setuid, setgid and sticky never carry over (V2.5-41).
    let mode = if fd < 0 {
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
            return Err("not writable".into());
        }
        None
    } else {
        let file = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fd) };
        let meta = file.metadata().map_err(|e| e.to_string())?;
        // A hard link inside the root can name a file outside it: refused before anything is replaced.
        if !meta.is_file() || std::os::unix::fs::MetadataExt::nlink(&meta) != 1 {
            return Err("not a regular file".into());
        }
        Some(std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o777)
    };
    // Quality audit 1101 D1: the new text goes to a temp file in the same folder (the target's mode), synced, then
    // renamed over the target, so a write that fails partway (disk full) leaves the old file whole.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = std::ffi::CString::new(format!(
        ".nunchiro-acp-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
    .map_err(|e| e.to_string())?;
    let tmp_fd = unsafe {
        libc::openat(
            dir_fd,
            tmp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode.unwrap_or(0o644) as libc::c_uint,
        )
    };
    if tmp_fd < 0 {
        return Err("not writable".into());
    }
    let mut out = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(tmp_fd) };
    // An existing file's mode is set exactly (past the umask); a new file keeps 0o644 under the umask.
    let written = mode
        .map_or(Ok(()), |m| {
            out.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(m))
        })
        .and_then(|()| out.write_all(content.as_bytes()))
        .and_then(|()| out.sync_all())
        .and_then(|()| {
            #[cfg(test)]
            if let Some(race) = tests::BEFORE_RENAME.take() {
                race();
            }
            // A new name is placed only if nothing took it meanwhile (RENAME_EXCL), so a file or link swapped in
            // after the open is never replaced.
            let flags = if mode.is_none() { libc::RENAME_EXCL } else { 0 };
            match unsafe { libc::renameatx_np(dir_fd, tmp.as_ptr(), dir_fd, name.as_ptr(), flags) }
            {
                0 => Ok(()),
                _ => Err(std::io::Error::last_os_error()),
            }
        });
    if let Err(e) = written {
        unsafe { libc::unlinkat(dir_fd, tmp.as_ptr(), 0) };
        return Err(e.to_string());
    }
    Ok(())
}

use std::os::unix::fs::OpenOptionsExt;
fn fd_path(file: &std::fs::File) -> Result<PathBuf, String> {
    use std::{ffi::OsStr, os::fd::AsRawFd, os::unix::ffi::OsStrExt};
    let mut buf = [0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) } == -1 {
        return Err("not readable".into());
    }
    let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(OsStr::from_bytes(&buf[..n])))
}

/// The agent's terminals: commands in core PTYs, rooted in the session folder, with the agent's own env.
struct Terminals {
    root: PathBuf,
    env: Vec<(String, String)>,
    out: SyncSender<Value>,
    list: Mutex<BTreeMap<String, Arc<Terminal>>>,
}
struct Terminal {
    pid: Option<u32>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    output: Mutex<(Vec<u8>, bool)>,
    limit: usize,
    /// The exit status once known, and the `wait_for_exit` requests answered when it is.
    exit: Mutex<(Option<Value>, Vec<Value>)>,
    // Kept open so the reader sees the output until the command's last writer closes.
    _master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
}
impl Terminal {
    /// The command's whole process group (a PTY child leads its own session), also after the leader exited.
    fn kill(&self) {
        if let Some(pid) = self.pid {
            // Pid reuse: as in `Client::stop`, an emptied group's id could name a new leader's group (narrow window).
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.killer.lock().map(|mut k| k.kill());
    }
}
impl Terminals {
    fn get(&self, params: &Value) -> Result<Arc<Terminal>, String> {
        let id = params["terminalId"].as_str().ok_or("missing terminalId")?;
        self.list
            .lock()
            .map_err(|_| "terminals unavailable")?
            .get(id)
            .cloned()
            .ok_or_else(|| "unknown terminal".into())
    }
    fn create(&self, params: &Value) -> Result<Value, String> {
        let command = params["command"].as_str().ok_or("missing command")?;
        let cwd = match params["cwd"].as_str() {
            None => self.root.clone(),
            Some(cwd) => {
                let real = std::fs::canonicalize(cwd).map_err(|_| "cwd not found")?;
                if !real.starts_with(&self.root) {
                    return Err("cwd outside the session root".into());
                }
                real
            }
        };
        if self.list.lock().map_err(|_| "terminals unavailable")?.len() >= TERMINALS_MAX {
            return Err("too many terminals".into());
        }
        let mut cmd = portable_pty::CommandBuilder::new(command);
        cmd.env_clear();
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        for e in params["args"].as_array().into_iter().flatten() {
            cmd.arg(e.as_str().ok_or("args must be strings")?);
        }
        for e in params["env"].as_array().into_iter().flatten() {
            let (Some(name), Some(value)) = (e["name"].as_str(), e["value"].as_str()) else {
                return Err("env entries need name and value".into());
            };
            cmd.env(name, value);
        }
        cmd.cwd(&cwd);
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let limit = params["outputByteLimit"]
            .as_u64()
            .map_or(TERMINAL_OUTPUT_MAX, |l| {
                (l as usize).min(TERMINAL_OUTPUT_MAX)
            });
        let terminal = Arc::new(Terminal {
            pid: child.process_id(),
            killer: Mutex::new(child.clone_killer()),
            output: Mutex::new((vec![], false)),
            limit,
            exit: Mutex::new((None, vec![])),
            _master: Mutex::new(pair.master),
        });
        let (out, done, answer) = (terminal.clone(), terminal.clone(), self.out.clone());
        std::thread::Builder::new()
            .name("acp-term-read".into())
            .spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut o) = out.output.lock() {
                        o.0.extend_from_slice(&buf[..n]);
                        if o.0.len() > out.limit {
                            let cut = o.0.len() - out.limit;
                            o.0.drain(..cut);
                            o.1 = true;
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("acp-term-wait".into())
            .spawn(move || {
                let status = child.wait();
                let exit = match status {
                    Ok(s) => json!({"exitCode": s.exit_code(), "signal": Value::Null}),
                    Err(_) => json!({"exitCode": Value::Null, "signal": Value::Null}),
                };
                let waiting = match done.exit.lock() {
                    Ok(mut e) => {
                        e.0 = Some(exit.clone());
                        std::mem::take(&mut e.1)
                    }
                    Err(_) => vec![],
                };
                for rpc in waiting {
                    let _ = answer.send(json!({"jsonrpc":"2.0","id":rpc,"result":exit}));
                }
            })
            .map_err(|e| e.to_string())?;
        let id = crate::store::new_id()?;
        self.list
            .lock()
            .map_err(|_| "terminals unavailable")?
            .insert(id.clone(), terminal);
        Ok(json!({ "terminalId": id }))
    }
    fn output(&self, params: &Value) -> Result<Value, String> {
        let t = self.get(params)?;
        let (bytes, truncated) = t.output.lock().map_err(|_| "terminal unavailable")?.clone();
        let mut result = json!({
            "output": String::from_utf8_lossy(&bytes),
            "truncated": truncated,
        });
        if let Some(exit) = t.exit.lock().map_err(|_| "terminal unavailable")?.0.clone() {
            result["exitStatus"] = exit;
        }
        Ok(result)
    }
    /// The exit status when known; else `rpc` waits for the terminal's exit watcher (`None`).
    fn wait(&self, params: &Value, rpc: &Value) -> Result<Option<Value>, (i64, String)> {
        let t = self.get(params).map_err(|e| (-32602, e))?;
        let mut exit = t
            .exit
            .lock()
            .map_err(|_| (-32603, "terminal unavailable".to_string()))?;
        if let Some(status) = &exit.0 {
            return Ok(Some(status.clone()));
        }
        if exit.1.len() >= WAITERS_MAX {
            return Err((-32000, "too many waits on this terminal".into()));
        }
        exit.1.push(rpc.clone());
        Ok(None)
    }
    fn kill(&self, params: &Value, release: bool) -> Result<Value, String> {
        let t = self.get(params)?;
        t.kill();
        if release {
            let id = params["terminalId"].as_str().unwrap_or_default();
            self.list
                .lock()
                .map_err(|_| "terminals unavailable")?
                .remove(id);
        }
        Ok(Value::Null)
    }
    fn release_all(&self) {
        if let Ok(mut list) = self.list.lock() {
            for t in list.values() {
                t.kill();
            }
            list.clear();
        }
    }
}

/// Cuts `v` in place to QUEUED_MAX before it is queued: long strings, arrays and objects are shortened (a second, tighter
/// pass when the first is not enough) and a cut object is marked `truncated`. False when it still does not fit.
fn fit(v: &mut Value) -> bool {
    fn shrink(v: &mut Value, string: usize, items: usize, depth: usize) -> bool {
        match v {
            Value::String(s) if s.len() > string => {
                let mut end = string;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                true
            }
            _ if depth == 0 && (v.is_array() || v.is_object()) => {
                *v = Value::Null;
                true
            }
            Value::Array(a) => {
                let cut = a.len() > items;
                a.truncate(items);
                a.iter_mut()
                    .fold(cut, |cut, x| shrink(x, string, items, depth - 1) | cut)
            }
            Value::Object(o) => {
                let cut = o.len() > items;
                if cut {
                    let keep: Vec<String> = o.keys().take(items).cloned().collect();
                    o.retain(|k, _| keep.contains(k));
                }
                o.values_mut()
                    .fold(cut, |cut, x| shrink(x, string, items, depth - 1) | cut)
            }
            _ => false,
        }
    }
    if v.to_string().len() <= QUEUED_MAX {
        return true;
    }
    for (string, items, depth) in [(16 * 1024, 256, 32), (1024, 16, 8)] {
        shrink(v, string, items, depth);
        if let Some(o) = v.as_object_mut() {
            o.insert("truncated".into(), Value::Bool(true));
        }
        if v.to_string().len() <= QUEUED_MAX {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    type Race = Box<dyn FnOnce()>;

    thread_local! {
        /// Test seam: runs once in `write` between the open and the rename, on this thread only.
        pub(super) static BEFORE_RENAME: std::cell::Cell<Option<Race>> = std::cell::Cell::new(None);
    }

    /// Quality audit 1101 D1: a write that fails partway (here: the file size limit, as a full disk would) leaves the
    /// old file whole. The limit is set in a child run of this same test, so no other test feels it.
    #[test]
    fn acp_write_failing_midway_keeps_the_old_file() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("acp-write-{}", std::process::id()));
        if std::env::var_os("NUNCHIRO_ACP_FSIZE_CHILD").is_some() {
            let root = PathBuf::from(std::env::var_os("NUNCHIRO_ACP_FSIZE_CHILD").unwrap());
            unsafe {
                libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
                let limit = libc::rlimit {
                    rlim_cur: 4096,
                    rlim_max: 4096,
                };
                assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
            }
            let big = "n".repeat(64 * 1024);
            let result = write(
                &root,
                &[],
                &json!({"path": root.join("notes.txt"), "content": big}),
            );
            assert!(result.is_err(), "the write over the limit fails");
            return;
        }
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let old = "old line\n".repeat(100);
        std::fs::write(root.join("notes.txt"), &old).unwrap();
        // Output is captured: under the size limit, writing to an inherited stdout that is a large log file fails.
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "acp::client::tests::acp_write_failing_midway_keeps_the_old_file",
                "--test-threads=1",
            ])
            .env("NUNCHIRO_ACP_FSIZE_CHILD", &root)
            .output()
            .unwrap();
        let after = std::fs::read_to_string(root.join("notes.txt")).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            child.status.success(),
            "the child run failed: {}",
            String::from_utf8_lossy(&child.stdout)
        );
        assert_eq!(after, old, "the old file is whole");
        assert_eq!(leftovers.len(), 1, "no temp file left: {leftovers:?}");
    }

    /// A canonical scratch root for one test; the caller removes it.
    fn scratch(tag: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("acp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(&root).unwrap()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// V2.5-41 threat 1: a rewrite never carries setuid, setgid or sticky bits onto the new file. The files live
    /// under the system temp dir as a fixed place: the repo disk can be mounted nosuid/noowners, where the bits may
    /// not take effect. The precondition assert catches any storage that drops them.
    #[test]
    fn acp_write_drops_setuid_bits() {
        use std::os::unix::fs::PermissionsExt;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ns-acp-suid-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let mut modes = vec![];
        // Empty content too: with no byte written, the kernel's clear-on-write never runs.
        for (name, bits, content) in [
            ("u.sh", 0o4755, "new"),
            ("g.sh", 0o2755, "new"),
            ("t.sh", 0o1755, "new"),
            ("u0.sh", 0o4755, ""),
            ("g0.sh", 0o2755, ""),
        ] {
            std::fs::write(root.join(name), "old").unwrap();
            std::fs::set_permissions(root.join(name), PermissionsExt::from_mode(bits)).unwrap();
            let before = std::fs::metadata(root.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777;
            assert_eq!(
                before,
                bits,
                "{name}: the special bit did not stick before the write (storage that drops special bits?) in {}",
                root.display()
            );
            let r = write(
                &root,
                &[],
                &json!({"path": root.join(name), "content": content}),
            );
            let meta = std::fs::metadata(root.join(name)).unwrap();
            let text = std::fs::read_to_string(root.join(name)).unwrap();
            modes.push((name, r, meta.permissions().mode() & 0o7777, text, content));
        }
        for (name, r, mode, text, content) in &modes {
            eprintln!("{name}: mode {mode:o}");
            assert_eq!((r, text.as_str()), (&Ok(()), *content), "{name}");
        }
        for (name, _, mode, _, _) in modes {
            assert_eq!(mode, 0o755, "{name}: mode {mode:o}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// V2.5-41 threats 2 and 3: a file, or a link to a file outside the root, that appears at a new name between the
    /// open and the rename is never replaced or followed; the write fails and leaves no temp file.
    #[test]
    fn acp_write_new_name_race_keeps_intruder() {
        let root = scratch("race");
        let outside = scratch("race-outside");
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        let target = outside.join("secret.txt");
        let file = root.join("planted.txt");
        let link = root.join("linked.txt");
        let (f, l) = (file.clone(), link.clone());
        let cases: [(&Path, Race); 2] = [
            (
                &file,
                Box::new(move || std::fs::write(&f, "intruder").unwrap()),
            ),
            (
                &link,
                Box::new(move || std::os::unix::fs::symlink(&target, &l).unwrap()),
            ),
        ];
        let mut results = vec![];
        for (path, race) in cases {
            BEFORE_RENAME.set(Some(race));
            results.push(write(
                &root,
                &[],
                &json!({"path": path, "content": "agent"}),
            ));
        }
        assert!(BEFORE_RENAME.take().is_none(), "each race ran");
        let planted = std::fs::read_to_string(&file).unwrap();
        let link_kind = std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink();
        let link_to = std::fs::read_link(&link).ok();
        let secret = std::fs::read_to_string(outside.join("secret.txt")).unwrap();
        let left = names(&root);
        // The name is taken (EEXIST), not some other failure such as a filesystem without RENAME_EXCL.
        assert!(
            results
                .iter()
                .all(|r| r.as_ref().is_err_and(|e| e.contains("File exists"))),
            "the writes fail because the name is taken: {results:?}"
        );
        assert_eq!(planted, "intruder", "the planted file is unchanged");
        assert!(link_kind, "the link is still a link");
        assert_eq!(
            link_to,
            Some(outside.join("secret.txt")),
            "the link points where it did"
        );
        assert_eq!(secret, "outside", "the file outside the root is unchanged");
        assert_eq!(left, ["linked.txt", "planted.txt"], "no temp file left");
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// Runs `f` in a child run of `test` under a 4 KiB file size limit, so a 64 KiB write fails partway (as a full
    /// disk would) and no other test feels the limit. Returns whether the child passed, and its output.
    fn under_fsize_limit(test: &str, root: &Path, f: impl FnOnce(&Path)) -> Option<(bool, String)> {
        if let Some(child) = std::env::var_os("NUNCHIRO_ACP_FSIZE_CHILD") {
            unsafe {
                libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
                let limit = libc::rlimit {
                    rlim_cur: 4096,
                    rlim_max: 4096,
                };
                assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
            }
            f(Path::new(&child));
            return None;
        }
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--test-threads=1"])
            .env("NUNCHIRO_ACP_FSIZE_CHILD", root)
            .output()
            .unwrap();
        Some((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ))
    }

    /// V2.5-41 threat 2: a write to a new name that fails partway leaves no file of that name and no temp file.
    #[test]
    fn acp_failed_write_leaves_no_new_file() {
        let root = scratch("newfail");
        let Some((ok, out)) = under_fsize_limit(
            "acp::client::tests::acp_failed_write_leaves_no_new_file",
            &root,
            |root| {
                let big = "n".repeat(64 * 1024);
                let r = write(
                    root,
                    &[],
                    &json!({"path": root.join(".envrc"), "content": big}),
                );
                assert!(r.is_err(), "the write over the limit fails");
            },
        ) else {
            return;
        };
        let left = names(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert!(ok, "the child run failed: {out}");
        assert!(left.is_empty(), "nothing left behind: {left:?}");
    }

    /// V2.5-41 threat 3: the same failure on an existing file keeps its bytes and mode, and removes nothing.
    #[test]
    fn acp_failed_write_keeps_existing_file() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("oldfail");
        std::fs::write(root.join("hook.sh"), "old\n").unwrap();
        std::fs::set_permissions(root.join("hook.sh"), PermissionsExt::from_mode(0o750)).unwrap();
        let Some((ok, out)) = under_fsize_limit(
            "acp::client::tests::acp_failed_write_keeps_existing_file",
            &root,
            |root| {
                let big = "n".repeat(64 * 1024);
                let r = write(
                    root,
                    &[],
                    &json!({"path": root.join("hook.sh"), "content": big}),
                );
                assert!(r.is_err(), "the write over the limit fails");
            },
        ) else {
            return;
        };
        let text = std::fs::read_to_string(root.join("hook.sh"));
        let mode = std::fs::metadata(root.join("hook.sh")).map(|m| m.permissions().mode() & 0o7777);
        let left = names(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert!(ok, "the child run failed: {out}");
        assert_eq!(text.unwrap(), "old\n", "the old bytes stay");
        assert_eq!(mode.unwrap(), 0o750, "the old mode stays");
        assert_eq!(left, ["hook.sh"], "no temp file left");
    }

    /// V2.5-41 threat 4: a denied root is matched in any letter case, as the default macOS volume resolves it.
    #[test]
    fn acp_denied_path_ignores_case() {
        let root = scratch("case");
        for dir in [".claude", ".codex", ".nunchiro"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("settings.json"), "config").unwrap();
        }
        let denied: Vec<PathBuf> = [".claude", ".codex", ".nunchiro"]
            .iter()
            .map(|d| root.join(d))
            .collect();
        let mut seen = vec![];
        for path in [
            ".CLAUDE/settings.json",
            ".Claude/x",
            ".CODEX/settings.json",
            ".Codex/x",
            ".NUNCHIRO/settings.json",
            ".Nunchiro/x",
        ] {
            let p = root.join(path);
            if !path.ends_with("/x") {
                seen.push((
                    path,
                    "read",
                    read(&root, &denied, &json!({"path": p})).map(|_| ()),
                ));
            }
            seen.push((
                path,
                "write",
                write(&root, &denied, &json!({"path": p, "content": "pwned"})),
            ));
        }
        // Denied by its stand-in spelling too: a denied entry given in another case than the disk's.
        let upper = [root.join(".CLAUDE")];
        seen.push((
            ".claude/settings.json",
            "read, denied as .CLAUDE",
            read(
                &root,
                &upper,
                &json!({"path": root.join(".claude/settings.json")}),
            )
            .map(|_| ()),
        ));
        seen.push((
            ".claude/x",
            "write, denied as .CLAUDE",
            write(
                &root,
                &upper,
                &json!({"path": root.join(".claude/x"), "content": "pwned"}),
            ),
        ));
        let left: Vec<_> = [".claude", ".codex", ".nunchiro"]
            .iter()
            .map(|d| {
                (
                    names(&root.join(d)),
                    std::fs::read_to_string(root.join(d).join("settings.json")).unwrap(),
                )
            })
            .collect();
        let _ = std::fs::remove_dir_all(&root);
        for (path, op, r) in seen {
            assert_eq!(r, Err("path not allowed".into()), "{op} {path}");
        }
        for (names, text) in left {
            assert_eq!(
                (names, text.as_str()),
                (vec!["settings.json".to_string()], "config")
            );
        }
    }

    /// V2.5-41 threat 5: case folding keeps the component boundary, so a sibling that only starts with a denied name
    /// stays reachable.
    #[test]
    fn acp_denied_case_fold_keeps_component_boundary() {
        let root = scratch("boundary");
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        let denied = [root.join(".claude")];
        let mut seen = vec![];
        for dir in [".claudex", ".claude-notes", ".CLAUDEX"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            let p = root.join(dir).join("a");
            seen.push((
                dir,
                "write",
                write(&root, &denied, &json!({"path": p, "content": "ok"})),
            ));
            seen.push((
                dir,
                "read",
                read(&root, &denied, &json!({"path": p})).map(|_| ()),
            ));
        }
        let _ = std::fs::remove_dir_all(&root);
        for (dir, op, r) in seen {
            assert_eq!(r, Ok(()), "{op} {dir}");
        }
    }

    /// Round 3: the reader cuts an agent message before it is queued, so the bounded channel holds bounded bytes.
    #[test]
    fn acp_reader_cuts_before_queueing() {
        let (out, _outgoing) = mpsc::sync_channel(8);
        let (tell, events) = mpsc::sync_channel(8);
        let mut reader = Reader {
            root: PathBuf::from("/nonexistent"),
            denied: vec![],
            out: out.clone(),
            tell,
            resume: None,
            terminals: Arc::new(Terminals {
                root: PathBuf::from("/nonexistent"),
                env: vec![],
                out,
                list: Mutex::new(BTreeMap::new()),
            }),
            prompting: Arc::new(AtomicU64::new(0)),
            setting: Arc::new(AtomicU64::new(0)),
            session: Some("s".into()),
            load: false,
            initialized: true,
            opened: true,
        };
        let big = "z".repeat(900 * 1024);
        let wide: Vec<Value> = (0..5000)
            .map(|i| json!({"n": i, "pad": "p".repeat(200)}))
            .collect();
        for update in [
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":big}}),
            json!({"sessionUpdate":"tool_call","toolCallId":"t","rawInput":wide}),
        ] {
            assert!(
                reader.message(json!({"jsonrpc":"2.0","method":"session/update",
                "params":{"sessionId":"s","update":update}}))
            );
            let Ok(Event::Update(got)) = events.try_recv() else {
                panic!("no update queued");
            };
            assert!(
                got.to_string().len() <= QUEUED_MAX,
                "{}",
                got.to_string().len()
            );
            assert_eq!(got["truncated"], true);
            assert_eq!(got["sessionUpdate"], update["sessionUpdate"]);
        }
        // A request is cut too and still reaches the queue.
        let options: Vec<Value> = (0..2000)
            .map(|i| json!({"optionId": i.to_string(), "name": "n".repeat(1000), "kind": "allow_once"}))
            .collect();
        reader.message(
            json!({"jsonrpc":"2.0","id":"r","method":"session/request_permission",
            "params":{"sessionId":"s","toolCall":{"title":big},"options":options}}),
        );
        let Ok(Event::Ask { params, .. }) = events.try_recv() else {
            panic!("no ask queued");
        };
        assert!(params.to_string().len() <= QUEUED_MAX);
        // Small messages pass unchanged.
        let small =
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}});
        reader.message(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":small}}));
        let Ok(Event::Update(got)) = events.try_recv() else {
            panic!("no update queued");
        };
        assert_eq!(got, small);
    }
}
