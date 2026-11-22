//! Ticket 178 finding 20: browser sign-in for an added account, against a real `nunchiro serve` with fake `claude`,
//! `codex`, `open` and `security` on PATH (tests/fixtures/accounts/signin-fake-*.sh). No real agent, browser or login
//! runs here: the fake `open` records its argument, the fake `security` records any Keychain call.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const CODE: &str = "FAKE-CODE-91x#q";
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/accounts");

fn cli() -> PathBuf {
    cli::path()
}

struct Core {
    home: PathBuf,
    user: PathBuf,
    process: Child,
    own: BTreeMap<PathBuf, String>,
    envs: Vec<(String, String)>,
}
impl Core {
    fn new(envs: &[(&str, &str)]) -> Self {
        let home = home::short("si");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for (name, from) in [
            ("claude", "signin-fake-claude.sh"),
            ("codex", "signin-fake-codex.sh"),
        ] {
            fs::copy(Path::new(FIXTURES).join(from), bin.join(name)).unwrap();
        }
        let log = |name: &str| {
            format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NUNCHIRO_HOME/{name}.log\"\n")
        };
        fs::write(bin.join("security"), log("security")).unwrap();
        for name in ["claude", "codex", "security"] {
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        // "Your own" trees: never written by a browser sign-in.
        let user = home.join("u");
        for dir in [".claude", ".codex"] {
            fs::create_dir_all(user.join(dir)).unwrap();
            fs::write(user.join(dir).join("settings.json"), "{}").unwrap();
        }
        let own = tree(&user);
        let envs: Vec<(String, String)> = envs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let process = launch(&home, &user, &envs);
        let core = Self {
            home,
            user,
            process,
            own,
            envs,
        };
        core.ready();
        core
    }
    fn ready(&self) {
        let until = Instant::now() + Duration::from_secs(30);
        while !self.home.join("window.json").exists() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    /// The core has exited (by itself or by a signal) within `limit`.
    fn exited(&mut self, limit: Duration) {
        let until = Instant::now() + limit;
        while self.process.try_wait().unwrap().is_none() {
            assert!(Instant::now() < until, "core did not stop");
            thread::sleep(Duration::from_millis(50));
        }
    }
    /// A new core on the same home, after the last one ended.
    fn restart(&mut self) {
        let _ = fs::remove_file(self.home.join("window.json"));
        self.process = launch(&self.home, &self.user, &self.envs);
        self.ready();
    }
    fn mode(&self, mode: &str) {
        fs::write(self.home.join("mode"), mode).unwrap();
    }
    fn start(&self, agent: &str, label: &str) -> String {
        let r = self.owner(json!({"op":"account_sign_in","agent":agent,"label":label}));
        assert_eq!(r["Ok"]["type"], "account_sign_in_started", "{r}");
        r["Ok"]["attempt"].as_str().unwrap().to_string()
    }
    fn state(&self, attempt: &str) -> Value {
        let r = self.owner(json!({"op":"account_sign_in_state","attempt":attempt}));
        r["Ok"]["state"].clone()
    }
    fn until(&self, attempt: &str, phase: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            let s = self.state(attempt);
            if s["phase"] == phase {
                return s;
            }
            assert!(Instant::now() < until, "never {phase}: {s}");
            thread::sleep(Duration::from_millis(50));
        }
    }
    fn file(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.home.join(name)).ok()
    }
    /// Ticket 840: the sign-in links the core handed to `open`, one a line, from the ticket 800 record.
    fn opened(&self) -> Option<String> {
        let record = self.file("opened.argv")?;
        Some(
            record
                .lines()
                .filter(|l| *l != "open")
                .map(|l| format!("{l}\n"))
                .collect(),
        )
    }
    fn wait_opened(&self) -> String {
        self.wait_file("opened.argv");
        self.opened().unwrap()
    }
    fn wait_file(&self, name: &str) -> String {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            // Whole lines only: a file being appended to can exist empty for a moment.
            if let Some(t) = self.file(name)
                && t.ends_with('\n')
            {
                return t;
            }
            assert!(Instant::now() < until, "{name} never appeared");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn list(&self) -> Vec<Value> {
        let r = self.owner(json!({"op":"account_list"}));
        r["Ok"]["accounts"].as_array().unwrap().clone()
    }
    fn added(&self) -> Vec<Value> {
        self.list()
            .into_iter()
            .filter(|a| a["default"] == false)
            .collect()
    }
    fn sessions(&self) -> usize {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.len(),
            _ => panic!(),
        }
    }
    fn shell(&self, script: &str) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: self.home.clone(),
                    worktree: false,
                    label: "plain".into(),
                    args: vec!["/bin/sh".into(), "-c".into(), script.into()],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap()
        {
            Reply::Started { session } => session,
            _ => panic!(),
        }
    }
    fn session_token(&self) -> String {
        let s = self.shell("printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat");
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(Reply::Output { data, .. }) = call(
                &self.home,
                Request::Read {
                    id: s.id.clone(),
                    after: 0,
                },
            ) && let Some(l) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:"))
            {
                return l.1.trim().to_string();
            }
            assert!(Instant::now() < until, "session printed no token");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn raw(&self, token: &str, request: Value) -> Value {
        let mut sock =
            std::os::unix::net::UnixStream::connect(self.home.join("core.sock")).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
        let mut answer = String::new();
        BufReader::new(sock).read_line(&mut answer).unwrap();
        serde_json::from_str(&answer).unwrap()
    }
    fn owner(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap();
        self.raw(token.trim(), request)
    }
    fn window(&self, request: Value) -> Value {
        let info = serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/ws", info["port"])
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!(
                "nunchiro.v1, nunchiro.token.{}",
                info["token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let stream =
            TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
        }
    }
    fn pid_alive(&self) -> bool {
        let pid: i32 = self.wait_file("login.pid").trim().parse().unwrap();
        unsafe { libc::kill(pid, 0) == 0 }
    }
    fn log(&self) -> String {
        self.file("core.log").unwrap_or_default()
    }
    /// The checks every test ends with: "Your own" untouched, no Keychain call, no login left running.
    fn finish(&self) {
        assert_eq!(tree(&self.user), self.own, "the agent's own config changed");
        assert_eq!(self.file("security.log"), None, "Keychain was called");
        if self.home.join("login.pid").exists() {
            let until = Instant::now() + Duration::from_secs(5);
            while self.pid_alive() {
                assert!(Instant::now() < until, "a login is still running");
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn launch(home: &Path, user: &Path, envs: &[(String, String)]) -> Child {
    use std::os::unix::process::CommandExt;
    let bin = home.join("bin");
    let mut command = home::git_env::scrubbed(cli());
    // A gate run as a shell's `&` job (or under nohup) inherits SIGINT/SIGHUP ignored, and the core rightly keeps an
    // inherited ignore; the signal tests need a core started the way a terminal starts it.
    unsafe {
        command.pre_exec(|| {
            for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
                libc::signal(sig, libc::SIG_DFL); // async-signal-safe
            }
            Ok(())
        });
    }
    command
        .arg("serve")
        .env("NUNCHIRO_HOME", home)
        .env("HOME", user)
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("ANTHROPIC_API_KEY", "core-anthropic-key")
        .env("BROWSER", "/core/own/browser")
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .envs(envs.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(home.join("core.log"))
                .unwrap(),
        )
        .spawn()
        .unwrap()
}

fn tree(dir: &Path) -> BTreeMap<PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).unwrap().flatten() {
            let m = fs::symlink_metadata(entry.path()).unwrap();
            let rel = entry.path().strip_prefix(dir).unwrap().to_path_buf();
            let body = if m.is_file() {
                fs::read(entry.path()).unwrap_or_default()
            } else {
                vec![]
            };
            out.insert(
                rel,
                format!(
                    "{:o} {} {}.{} {body:?}",
                    m.mode(),
                    m.size(),
                    m.mtime(),
                    m.mtime_nsec()
                ),
            );
            if m.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    out
}
/// Every byte of every file under `dir` that the test can read.
fn all_bytes(dir: &Path) -> Vec<u8> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).unwrap().flatten() {
            let m = fs::symlink_metadata(entry.path()).unwrap();
            if m.is_dir() {
                stack.push(entry.path());
            } else if m.is_file() {
                out.extend(fs::read(entry.path()).unwrap_or_default());
            }
        }
    }
    out
}
fn contains(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}
const LINK: &str = "https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fake";

const PARENT: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_MESSAGING_FUTURE",
    "CODEX_SANDBOX",
    "TRACEPARENT",
];

// Ticket 209 `signin_drops_parent_session_env`: the claude login of a core launched from a Claude Code session.
#[test]
fn signin_drops_parent_session_env() {
    let envs: Vec<(&str, &str)> = PARENT.iter().map(|n| (*n, "parent-fixture")).collect();
    signin_claude_flow(&envs);
}

#[test]
fn signin_claude_browser_flow() {
    signin_claude_flow(&[]);
}

fn signin_claude_flow(extra: &[(&str, &str)]) {
    let core = Core::new(extra);
    let attempt = core.start("claude", "work");
    let waiting = core.until(&attempt, "waiting");
    assert_eq!(waiting["link"], LINK);
    assert_eq!(waiting["paste"], true);
    // Opened in the browser by `open` with the link as its one argument; the helper was 0700 and executable.
    assert_eq!(core.wait_opened(), format!("{LINK}\n"));
    assert_eq!(core.wait_file("helper-seen"), "helper\n");
    // Not listed while signing in: no session can start on a folder whose login is still running.
    assert!(core.added().is_empty());
    let r = core.owner(json!({"op":"account_sign_in_code","attempt":attempt,"code":CODE}));
    assert_eq!(r, json!({"Ok":{"type":"ack"}}));
    let done = core.until(&attempt, "signed_in");
    assert_eq!(done["account"]["label"], "work");
    assert_eq!(done["account"]["signed_in"], "yes");
    let added = core.added();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0]["signed_in"], "yes");
    let folder = PathBuf::from(added[0]["folder"].as_str().unwrap());
    // The login ran in the account folder with only that folder as its override, BROWSER the helper, no core key.
    let env: BTreeMap<_, _> = core
        .wait_file("login.env")
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    assert_eq!(env["CLAUDE_CONFIG_DIR"], folder.display().to_string());
    assert_eq!(
        env["BROWSER"],
        folder
            .join(".nunchiro-sign-in-browser")
            .display()
            .to_string()
    );
    assert!(!env.contains_key("ANTHROPIC_API_KEY") && !env.contains_key("CODEX_HOME"));
    assert!(!env.contains_key("NUNCHIRO_TOKEN"));
    // Ticket 209: nothing of a parent Claude Code session reaches the login; PATH stays.
    for name in PARENT {
        assert!(!env.contains_key(*name), "{name} reached the login");
    }
    assert!(env["PATH"].contains("/bin"));
    assert_eq!(
        core.wait_file("login.cwd").trim(),
        folder.display().to_string()
    );
    // The helper and its link file are gone.
    assert!(!folder.join(".nunchiro-sign-in-browser").exists());
    assert!(!folder.join(".nunchiro-sign-in-browser.link").exists());
    // No terminal tab.
    assert_eq!(core.sessions(), 0);
    core.finish();
}

#[test]
fn signin_codex_browser_flow() {
    let core = Core::new(&[]);
    let attempt = core.start("codex", "team");
    let waiting = core.until(&attempt, "waiting");
    let link = "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fake";
    assert_eq!(
        waiting["link"], link,
        "the link split across writes is whole"
    );
    assert_eq!(waiting["paste"], false);
    assert_eq!(core.wait_opened(), format!("{link}\n"));
    // Codex reads no code.
    let r = core.owner(json!({"op":"account_sign_in_code","attempt":attempt,"code":CODE}));
    assert!(r["Err"].is_string(), "{r}");
    fs::write(core.home.join("codex-callback"), "").unwrap();
    let done = core.until(&attempt, "signed_in");
    assert_eq!(done["account"]["agent"], "codex");
    let added = core.added();
    assert_eq!((added.len(), &added[0]["signed_in"]), (1, &json!("yes")));
    let env = core.wait_file("login.env");
    assert!(env.contains(&format!(
        "CODEX_HOME={}\n",
        added[0]["folder"].as_str().unwrap()
    )));
    assert!(!env.contains("CLAUDE_CONFIG_DIR=") && !env.contains("BROWSER="));
    assert_eq!(core.sessions(), 0);
    core.finish();
}

#[test]
fn signin_failure_and_retry() {
    // A wrong code: Orca's "did not accept that code", the new folder deleted (signed out), nothing listed.
    let core = Core::new(&[("NUNCHIRO_SIGNIN_LINK_MS", "1500")]);
    let attempt = core.start("claude", "work");
    core.until(&attempt, "waiting");
    core.owner(json!({"op":"account_sign_in_code","attempt":attempt,"code":"WRONG-code"}));
    let failed = core.until(&attempt, "failed");
    assert_eq!(failed["reason"], "code_rejected");
    assert_eq!(failed["account"], Value::Null);
    assert!(core.added().is_empty());
    assert_eq!(
        fs::read_dir(core.home.join("accounts/claude"))
            .unwrap()
            .count(),
        0
    );
    // Retry is a new attempt with the same name, and it signs in.
    let again = core.start("claude", "work");
    core.until(&again, "waiting");
    core.owner(json!({"op":"account_sign_in_code","attempt":again,"code":CODE}));
    core.until(&again, "signed_in");
    assert_eq!(core.added().len(), 1);
    // A login that exits non-zero, and one that gives no link within the (shortened) link wait.
    core.mode("exit3");
    let a = core.start("claude", "exits");
    let s = core.until(&a, "failed");
    assert_eq!(
        (s["reason"].clone(), s["code"].clone()),
        (json!("exited"), json!(3))
    );
    core.mode("nolink");
    let a = core.start("claude", "silent");
    assert_eq!(core.until(&a, "failed")["reason"], "no_link");
    assert!(!core.pid_alive(), "the silent login was killed");
    assert_eq!(core.added().len(), 1);
    assert_eq!(core.sessions(), 0);
    core.finish();
}

// Threat 1: a session caller can neither start, feed, cancel nor read a sign-in, with its own token or the owner's
// token used from inside a session (the session's env carries only its own).
#[test]
fn signin_refused_for_session_caller() {
    let core = Core::new(&[]);
    let attempt = core.start("claude", "owner's");
    core.until(&attempt, "waiting");
    let token = core.session_token();
    for request in [
        json!({"op":"account_sign_in","agent":"claude","label":"agent-made"}),
        json!({"op":"account_sign_in","agent":"codex","label":"agent-made"}),
        json!({"op":"account_sign_in_code","attempt":attempt,"code":CODE}),
        json!({"op":"account_sign_in_cancel","attempt":attempt}),
        json!({"op":"account_sign_in_state","attempt":attempt}),
    ] {
        assert_eq!(
            core.raw(&token, request.clone()),
            json!({"Err":"operation not granted"}),
            "{request}"
        );
    }
    // The owner's attempt is untouched: still waiting, no code taken, one open only.
    assert_eq!(core.state(&attempt)["phase"], "waiting");
    assert_eq!(core.file("code-seen"), None);
    assert_eq!(core.wait_opened().lines().count(), 1);
    // The window works.
    let r = core.window(json!({"op":"account_sign_in_state","attempt":attempt}));
    assert_eq!(r["Ok"]["state"]["phase"], "waiting", "{r}");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":attempt}));
    core.until(&attempt, "cancelled");
    core.finish();
}

// Threat 2: a link outside the allowlist is never opened or offered; the attempt fails with one line.
#[test]
fn signin_link_allowlist() {
    let core = Core::new(&[]);
    for mode in ["badlink", "filelink"] {
        core.mode(mode);
        let a = core.start("claude", mode);
        let s = core.until(&a, "failed");
        assert_eq!(s["reason"], "bad_link", "{mode}");
        assert_eq!(s["link"], Value::Null);
    }
    assert_eq!(core.opened(), None);
    assert!(core.added().is_empty());
    core.finish();
}

// Threat 3: the code reaches the login's stdin and nothing else.
#[test]
fn signin_code_never_persisted() {
    let core = Core::new(&[]);
    let attempt = core.start("claude", "work");
    core.until(&attempt, "waiting");
    let mut replies =
        vec![core.owner(json!({"op":"account_sign_in_code","attempt":attempt,"code":CODE}))];
    replies.push(core.until(&attempt, "signed_in"));
    replies.push(json!(core.list()));
    assert_eq!(core.wait_file("code-seen"), "stdin\n");
    assert_eq!(
        core.file("code-leak"),
        None,
        "the code reached the login's argv or env"
    );
    for r in &replies {
        assert!(!r.to_string().contains(CODE), "{r}");
    }
    assert!(!core.log().contains(CODE));
    assert!(
        !contains(&all_bytes(&core.home), CODE),
        "the code is in a file of the test home"
    );
    core.finish();
}

// Threat 4: signed in comes from the status command; credential files the login wrote are mode 000 and unread, and
// no Keychain call is made.
#[test]
fn signin_reads_no_credentials() {
    let core = Core::new(&[]);
    let attempt = core.start("claude", "work");
    core.until(&attempt, "waiting");
    core.owner(json!({"op":"account_sign_in_code","attempt":attempt,"code":CODE}));
    let done = core.until(&attempt, "signed_in");
    let folder = PathBuf::from(done["account"]["folder"].as_str().unwrap());
    let cred = folder.join(".credentials.json");
    assert_eq!(fs::metadata(&cred).unwrap().permissions().mode() & 0o777, 0);
    // The status command alone: with its marker gone the same folder lists as signed out.
    fs::remove_file(folder.join(".logged-in")).unwrap();
    assert_eq!(core.added()[0]["signed_in"], "no");
    let codex = core.start("codex", "c");
    core.until(&codex, "waiting");
    fs::write(core.home.join("codex-callback"), "").unwrap();
    core.until(&codex, "signed_in");
    core.finish();
}

// Threat 5: cancel and the timeout kill the login they started and remove the helper; nothing stays listed.
#[test]
fn signin_cancel_and_timeout_clean() {
    let core = Core::new(&[("NUNCHIRO_SIGNIN_TIMEOUT_MS", "2500")]);
    core.mode("hang");
    let a = core.start("claude", "cancelled");
    let s = core.until(&a, "waiting");
    let folder = PathBuf::from(s["account"]["folder"].as_str().unwrap());
    assert!(folder.join(".nunchiro-sign-in-browser").exists());
    assert!(core.pid_alive());
    assert_eq!(
        core.owner(json!({"op":"account_sign_in_cancel","attempt":a})),
        json!({"Ok":{"type":"ack"}})
    );
    core.until(&a, "cancelled");
    assert!(!core.pid_alive());
    let child: i32 = core.wait_file("child.pid").trim().parse().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(child, 0) } == 0 {
        assert!(
            Instant::now() < until,
            "the login's own child is still running"
        );
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !folder.exists(),
        "a signed-out folder this attempt made is deleted"
    );
    fs::remove_file(core.home.join("login.pid")).unwrap();
    let t = core.start("claude", "slow");
    core.until(&t, "waiting");
    let s = core.until(&t, "failed");
    assert_eq!(s["reason"], "timed_out");
    assert!(!core.pid_alive());
    assert!(core.added().is_empty());
    assert_eq!(
        fs::read_dir(core.home.join("accounts/claude"))
            .unwrap()
            .count(),
        0
    );
    core.finish();
}

// Threat 5 (Orca sta-4734): a cancelled login that had already signed in keeps its folder and is listed; one whose
// state cannot be read is kept too; an existing account's folder is never deleted.
#[test]
fn signin_rollback_keeps_signed_in_folder() {
    let core = Core::new(&[]);
    core.mode("signed-hang");
    let a = core.start("claude", "signed");
    core.until(&a, "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":a}));
    let s = core.until(&a, "signed_in");
    assert!(PathBuf::from(s["account"]["folder"].as_str().unwrap()).is_dir());
    core.mode("unknown-hang");
    let u = core.start("claude", "unknown");
    core.until(&u, "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":u}));
    let s = core.until(&u, "cancelled");
    let kept = PathBuf::from(s["account"]["folder"].as_str().unwrap());
    assert!(kept.is_dir());
    let added = core.added();
    assert_eq!(added.len(), 2);
    // Signing in again on an existing signed-out account (by id), then cancelling, keeps that folder.
    fs::remove_file(kept.join(".unknown")).unwrap();
    core.mode("hang");
    let id = added.iter().find(|a| a["label"] == "unknown").unwrap()["id"].clone();
    let r = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"ignored","id":id}));
    let e = r["Ok"]["attempt"].as_str().unwrap().to_string();
    core.until(&e, "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":e}));
    core.until(&e, "cancelled");
    assert!(kept.is_dir());
    assert_eq!(core.added().len(), 2);
    core.finish();
}

#[test]
fn signin_concurrent_refused() {
    let core = Core::new(&[]);
    core.mode("hang");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let again = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"work"}));
    assert!(
        again["Err"]
            .as_str()
            .unwrap()
            .contains("already signing in"),
        "{again}"
    );
    // On an existing account: the second start on the same id is refused while the first runs.
    core.owner(json!({"op":"account_sign_in_cancel","attempt":a}));
    core.until(&a, "cancelled");
    core.mode("unknown-hang");
    let k = core.start("claude", "kept");
    core.until(&k, "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":k}));
    let id = core.until(&k, "cancelled")["account"]["id"].clone();
    core.mode("hang");
    let first = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"","id":id}));
    let first = first["Ok"]["attempt"].as_str().unwrap().to_string();
    let second = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"","id":id}));
    assert!(
        second["Err"]
            .as_str()
            .unwrap()
            .contains("already signing in"),
        "{second}"
    );
    // A remove waits for the sign-in too.
    let rm = core.owner(json!({"op":"account_remove","agent":"claude","id":id,"step":"check"}));
    assert!(rm["Err"].as_str().unwrap().contains("signing in"), "{rm}");
    core.until(&first, "waiting");
    // `open` runs on its own thread after the link is shown: wait for its third line.
    let until = Instant::now() + Duration::from_secs(10);
    while core.opened().unwrap_or_default().lines().count() < 3 {
        assert!(Instant::now() < until, "the third open never ran");
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(core.opened().unwrap().lines().count(), 3);
    core.owner(json!({"op":"account_sign_in_cancel","attempt":first}));
    core.until(&first, "cancelled");
    core.finish();
}

#[test]
fn signin_refuses_your_own() {
    let core = Core::new(&[]);
    for agent in ["claude", "codex"] {
        let r =
            core.owner(json!({"op":"account_sign_in","agent":agent,"label":"Default","id":"own"}));
        assert!(r["Err"].as_str().unwrap().contains("own account"), "{r}");
    }
    assert_eq!(core.file("login.pid"), None, "no login ran");
    assert!(!core.home.join("accounts").exists());
    core.finish();
}

// Review r1 MUST: a code is written once per attempt; more pastes are refused and never block the core on a full pipe.
#[test]
fn signin_code_once() {
    let core = Core::new(&[]);
    core.mode("hang");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let big = "x".repeat(1024);
    let first = core.owner(json!({"op":"account_sign_in_code","attempt":a,"code":big}));
    assert_eq!(first, json!({"Ok":{"type":"ack"}}));
    for _ in 0..100 {
        let r = core.owner(json!({"op":"account_sign_in_code","attempt":a,"code":big}));
        assert!(r["Err"].as_str().unwrap().contains("already"), "{r}");
    }
    // Still answering, and Cancel still ends the login.
    assert_eq!(core.state(&a)["phase"], "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":a}));
    core.until(&a, "cancelled");
    core.finish();
}

// Review r1: a login that exits leaves no child of its own running; a sign-in on an account in use is refused.
#[test]
fn signin_exit_leaves_nothing_and_in_use_refused() {
    let core = Core::new(&[]);
    core.mode("child-exit");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    core.owner(json!({"op":"account_sign_in_code","attempt":a,"code":CODE}));
    let done = core.until(&a, "signed_in");
    let child: i32 = core.wait_file("child.pid").trim().parse().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(child, 0) } == 0 {
        assert!(Instant::now() < until, "the login's child outlived it");
        thread::sleep(Duration::from_millis(50));
    }
    // A live session in the account folder (a logout tab, say) blocks signing that account in again.
    let folder = done["account"]["folder"].as_str().unwrap().to_string();
    let id = done["account"]["id"].clone();
    let tab = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: PathBuf::from(&folder),
                worktree: false,
                label: "Logout: work".into(),
                args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    );
    assert!(tab.is_ok(), "{tab:?}");
    let r = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"","id":id}));
    assert!(r["Err"].as_str().unwrap().contains("in use"), "{r}");
    core.finish();
}

// Review r1 delta: a remove's logout that already exited still holds the account until its Move step.
#[test]
fn signin_refused_after_logout_until_move() {
    let core = Core::new(&[]);
    core.mode("unknown-hang");
    let k = core.start("claude", "kept");
    core.until(&k, "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":k}));
    let id = core.until(&k, "cancelled")["account"]["id"].clone();
    // The fake's `auth logout` exits at once; its tab ends, its mark stays.
    let r = core.owner(json!({"op":"account_remove","agent":"claude","id":id,"step":"logout"}));
    assert_eq!(r["Ok"]["type"], "account_logout", "{r}");
    let tab = r["Ok"]["session"]["id"].as_str().unwrap().to_string();
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let s = core.owner(json!({"op":"snapshot"}));
        let state = s["Ok"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == tab.as_str())
            .map(|x| x["state"].clone());
        if state != Some(json!("running")) {
            break;
        }
        assert!(Instant::now() < until, "logout tab never exited");
        thread::sleep(Duration::from_millis(50));
    }
    let r = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"","id":id}));
    assert!(r["Err"].as_str().unwrap().contains("in use"), "{r}");
    core.finish();
}

// Round 2 MUST: the owner's `remote` request never forwards a sign-in to another machine.
#[test]
fn signin_remote_refused() {
    let core = Core::new(&[]);
    for request in [
        json!({"op":"account_sign_in","agent":"claude","label":"remote"}),
        json!({"op":"account_sign_in_code","attempt":"x","code":CODE}),
        json!({"op":"account_sign_in_cancel","attempt":"x"}),
        json!({"op":"account_sign_in_state","attempt":"x"}),
    ] {
        let reply = core.owner(json!({"op":"remote","machine":"elsewhere","request":request}));
        assert_eq!(
            reply,
            json!({"Err":"operation is local owner-only; remote forwarding is not permitted"}),
            "{request}"
        );
    }
    assert_eq!(core.file("login.pid"), None);
    core.finish();
}

// Round 2: a normal core stop (Stop, and Exit) kills a running login and what it started (a Codex port-1455 server,
// say).
#[test]
fn signin_core_stop_kills_login() {
    for stop in [Request::Stop, Request::Exit] {
        core_stop_kills_login(stop);
    }
}
fn core_stop_kills_login(stop: Request) {
    let mut core = Core::new(&[]);
    core.mode("hang");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let leader: i32 = core.wait_file("login.pid").trim().parse().unwrap();
    let child: i32 = core.wait_file("child.pid").trim().parse().unwrap();
    let _ = call(&core.home, stop);
    let until = Instant::now() + Duration::from_secs(10);
    while core.process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "core did not stop");
        thread::sleep(Duration::from_millis(50));
    }
    let until = Instant::now() + Duration::from_secs(5);
    for pid in [leader, child] {
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < until,
                "login process {pid} outlived the core"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}

// Round 2: no session starts on an account while it is signing in.
#[test]
fn signin_busy_blocks_session_start() {
    let core = Core::new(&[]);
    core.mode("unknown-hang");
    let k = core.start("claude", "kept");
    core.until(&k, "waiting");
    core.owner(json!({"op":"account_sign_in_cancel","attempt":k}));
    let id = core.until(&k, "cancelled")["account"]["id"].clone();
    core.mode("hang");
    let r = core.owner(json!({"op":"account_sign_in","agent":"claude","label":"","id":id}));
    let a = r["Ok"]["attempt"].as_str().unwrap().to_string();
    core.until(&a, "waiting");
    let refused = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: Some("kept".into()),
                kind: AgentKind::Claude,
                project: core.home.clone(),
                worktree: false,
                label: "on kept".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    );
    assert!(
        matches!(&refused, Err(e) if e.contains("signing in")),
        "{refused:?}"
    );
    assert_eq!(core.sessions(), 0);
    core.owner(json!({"op":"account_sign_in_cancel","attempt":a}));
    core.until(&a, "cancelled");
    core.finish();
}

// Round 2 review: a login that signed in just before the core stops is still registered, never left as an unlisted
// folder holding its login.
#[test]
fn signin_core_stop_keeps_signed_in_account() {
    let mut core = Core::new(&[]);
    core.mode("signed-slow");
    let a = core.start("claude", "late");
    core.until(&a, "waiting");
    assert!(call(&core.home, Request::Stop).is_ok());
    let until = Instant::now() + Duration::from_secs(15);
    while core.process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "core did not stop");
        thread::sleep(Duration::from_millis(50));
    }
    let registry = fs::read_to_string(core.home.join("accounts.toml")).unwrap_or_default();
    assert!(registry.contains("label = \"late\""), "{registry}");
}

// V2.5-34i: a core ended by SIGTERM, SIGINT or SIGHUP takes its `exit` path, so the login group goes with it.
#[test]
fn signin_login_ends_on_sigterm() {
    core_signal_kills_login(libc::SIGTERM);
}
#[test]
fn signin_login_ends_on_sigint() {
    core_signal_kills_login(libc::SIGINT);
}
#[test]
fn signin_login_ends_on_sighup() {
    core_signal_kills_login(libc::SIGHUP);
}
fn core_signal_kills_login(signal: i32) {
    let mut core = Core::new(&[]);
    core.mode("hang");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let leader: i32 = core.wait_file("login.pid").trim().parse().unwrap();
    let child: i32 = core.wait_file("child.pid").trim().parse().unwrap();
    assert_eq!(unsafe { libc::kill(core.process.id() as i32, signal) }, 0);
    let until = Instant::now() + Duration::from_secs(10);
    core.exited(Duration::from_secs(10));
    for pid in [leader, child] {
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < until,
                "login process {pid} outlived the core (signal {signal})"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// A process that leads its own group, as a login does; killed by pid on drop.
struct Bystander(Child);
impl Bystander {
    fn new() -> Self {
        use std::os::unix::process::CommandExt;
        Self(
            Command::new("/bin/sleep")
                .arg("600")
                .process_group(0)
                .spawn()
                .unwrap(),
        )
    }
    fn pid(&self) -> i32 {
        self.0.id() as i32
    }
    fn alive(&mut self) -> bool {
        self.0.try_wait().unwrap().is_none()
    }
}
impl Drop for Bystander {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// V2.5-34i: a core killed outright (SIGKILL, abort) leaves its login running; the next core start ends that group.
#[test]
fn signin_login_swept_after_crash() {
    let mut core = Core::new(&[]);
    core.mode("hang");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let leader: i32 = core.wait_file("login.pid").trim().parse().unwrap();
    let child: i32 = core.wait_file("child.pid").trim().parse().unwrap();
    core.process.kill().unwrap();
    core.exited(Duration::from_secs(10));
    for pid in [leader, child] {
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "{pid} died with the core");
    }
    core.restart();
    let until = Instant::now() + Duration::from_secs(10);
    for pid in [leader, child] {
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < until, "{pid} outlived the next core start");
            thread::sleep(Duration::from_millis(50));
        }
    }
}

// V2.5-34i edge: a record whose pid now names another process (its start time differs) is dropped, never signalled.
#[test]
fn signin_sweep_skips_reused_pid() {
    let mut core = Core::new(&[]);
    core.process.kill().unwrap();
    core.exited(Duration::from_secs(10));
    let mut other = Bystander::new();
    let records = core.home.join(".signin-logins");
    fs::create_dir_all(&records).unwrap();
    let record = records.join(other.pid().to_string());
    fs::write(&record, "1.0").unwrap();
    core.restart();
    // The sweep runs before the core is ready; give a stray signal time to land anyway.
    thread::sleep(Duration::from_millis(300));
    assert!(other.alive(), "an unrelated process was signalled");
    assert!(!record.exists(), "the stale record was kept");
}

/// A record the current sweep would act on: `<pid>` holding the leader's real start time.
fn live_record(pid: i32) -> String {
    let (s, u) = nunchiro_core::sandbox::group_start(pid).expect("bystander leads its group");
    format!("{s}.{u}")
}

// V2.5-34i hardening: a `.signin-logins` that is a symlink is never followed; the target's files stay.
#[test]
fn signin_sweep_ignores_symlinked_dir() {
    let mut core = Core::new(&[]);
    core.process.kill().unwrap();
    core.exited(Duration::from_secs(10));
    let mut other = Bystander::new();
    let target = core.home.join("documents");
    fs::create_dir_all(&target).unwrap();
    let kept = target.join(other.pid().to_string());
    fs::write(&kept, live_record(other.pid())).unwrap();
    std::os::unix::fs::symlink(&target, core.home.join(".signin-logins")).unwrap();
    core.restart();
    thread::sleep(Duration::from_millis(300));
    assert!(
        other.alive(),
        "a process named through the link was signalled"
    );
    assert!(kept.exists(), "the link target's file was deleted");
}

// V2.5-34i hardening: a real login's record is a plain 0600 file. The planted links that need a known pid are covered by
// the unit test `record_replaces_planted_link_at_known_pgid` (V2.5-46).
#[test]
fn signin_record_is_plain_0600() {
    let core = Core::new(&[]);
    core.mode("hang");
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let leader = core.wait_file("login.pid").trim().to_string();
    let meta = fs::symlink_metadata(core.home.join(".signin-logins").join(&leader))
        .expect("login recorded");
    assert!(meta.file_type().is_file(), "record is not a regular file");
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
}

// V2.5-34i hardening: an oversized or non-UTF-8 record is dropped without a signal; the core still starts.
#[test]
fn signin_sweep_bounded_record() {
    let mut core = Core::new(&[]);
    core.process.kill().unwrap();
    core.exited(Duration::from_secs(10));
    let mut big = Bystander::new();
    let mut odd = Bystander::new();
    let records = core.home.join(".signin-logins");
    fs::create_dir_all(&records).unwrap();
    // A valid start time padded to 1 MiB: only a bounded read refuses it.
    let mut padded = live_record(big.pid()).into_bytes();
    padded.resize(1 << 20, b' ');
    fs::write(records.join(big.pid().to_string()), padded).unwrap();
    let mut bad = live_record(odd.pid()).into_bytes();
    bad.push(0xff);
    fs::write(records.join(odd.pid().to_string()), bad).unwrap();
    // A name that is not a pid is removed, never parsed (V2.5-46 threat 5).
    fs::write(records.join("notes.txt"), "1.0").unwrap();
    core.restart();
    thread::sleep(Duration::from_millis(300));
    assert!(big.alive(), "a 1 MiB record was acted on");
    assert!(odd.alive(), "a non-UTF-8 record was acted on");
    assert_eq!(fs::read_dir(&records).unwrap().count(), 0, "records kept");
}

// V2.5-34i hardening: a looser pre-existing records folder is tightened to 0700 when a login is recorded.
#[test]
fn signin_records_dir_mode() {
    let core = Core::new(&[]);
    core.mode("hang");
    let records = core.home.join(".signin-logins");
    fs::create_dir_all(&records).unwrap();
    fs::set_permissions(&records, fs::Permissions::from_mode(0o755)).unwrap();
    let a = core.start("claude", "work");
    core.until(&a, "waiting");
    let leader = core.wait_file("login.pid").trim().to_string();
    assert!(records.join(&leader).exists(), "login not recorded");
    assert_eq!(
        fs::metadata(&records).unwrap().permissions().mode() & 0o777,
        0o700
    );
}
