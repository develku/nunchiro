//! V2-2b: an agent session on an account, against a real `nunchiro serve` with fake `claude` and `codex` on PATH that
//! write their env to `NUNCHIRO_HOME/env-<session>` and then wait for one line. No real agent runs here.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{accounts::Agent, api::*, server::call};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

// The login tab's words exit at once; any other start records its env and waits for one line.
const FAKE: &str = r#"#!/bin/sh
case "$1" in --version) echo "$VERSION_TEXT"; exit 0;; esac
case "$*" in "auth login"|login) exit 0;; esac
env > "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" && mv "$NUNCHIRO_HOME/env.tmp-$NUNCHIRO_SESSION" "$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION"
read line
"#;

/// Ticket 1009 round 5: a copy of the CLI signed ad hoc with the hardened runtime, as the app's signing does; the core
/// keeps no keychain item without it. Made once per test process, next to the build.
fn cli() -> PathBuf {
    static HARDENED: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    extern "C" fn remove_copy() {
        if let Some(path) = HARDENED.get() {
            let _ = fs::remove_file(path);
        }
    }
    HARDENED
        .get_or_init(|| {
            let built = cli::path();
            // Ticket 1114: nextest runs each test in its own process. A shared destination lets another test
            // replace the executable between recording its path and restart, breaking the keychain identity.
            let copy =
                built.with_file_name(format!("nunchiro-hardened-test.{}", std::process::id()));
            fs::copy(&built, &copy).unwrap();
            let signed = std::process::Command::new("/usr/bin/codesign")
                .args(["--force", "--options", "runtime", "-s", "-"])
                .arg(&copy)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(signed.success(), "codesign of the test CLI failed");
            // Static values are not dropped at exit. Keep the copy through every Core's cleanup, then remove it
            // when the test process exits normally (including a caught test panic), so repeated runs do not fill disk.
            assert_eq!(unsafe { libc::atexit(remove_copy) }, 0);
            copy
        })
        .clone()
}

struct Core {
    home: PathBuf,
    project: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("acses");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for (name, version) in [
            ("claude", "2.1.311 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            let body = FAKE.replace("$VERSION_TEXT", version);
            fs::write(bin.join(name), home::codex_fake(&body)).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let project = home.join("proj");
        fs::create_dir_all(home.join("u")).unwrap();
        fs::create_dir_all(&project).unwrap();
        let mut core = Self {
            process: serve(&home),
            home,
            project,
        };
        core.ready();
        core
    }
    fn ready(&mut self) {
        let until = Instant::now() + Duration::from_secs(30);
        while call(&self.home, Request::Snapshot).is_err() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// `kill -9` of the core, then a new one over the same home (the holders keep the agents).
    fn crash_and_restart(&mut self) {
        self.process.kill().unwrap();
        let _ = self.process.wait();
        self.process = serve(&self.home);
        self.ready();
    }
    fn add(&self, agent: Agent, label: &str) -> PathBuf {
        match call(
            &self.home,
            Request::AccountAdd {
                agent,
                label: label.into(),
            },
        ) {
            Ok(Reply::AccountAdded { account, .. }) => account.folder,
            other => panic!("{other:?}"),
        }
    }
    fn start(
        &self,
        kind: AgentKind,
        account: Option<&str>,
        resume: Option<String>,
        args: &[&str],
    ) -> Response {
        call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind,
                    project: self.project.clone(),
                    worktree: false,
                    label: String::new(),
                    args: args.iter().map(|a| a.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume,
                    account: account.map(Into::into),
                },
            },
        )
    }
    fn started(&self, kind: AgentKind, account: Option<&str>) -> Session {
        match self.start(kind, account, None, &[]) {
            Ok(Reply::Started { session }) => session,
            other => panic!("{other:?}"),
        }
    }
    fn sessions(&self) -> Vec<Session> {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions,
            _ => panic!(),
        }
    }
    fn session(&self, id: &str) -> Session {
        self.sessions().into_iter().find(|s| s.id == id).unwrap()
    }
    fn env(&self, id: &str) -> BTreeMap<String, String> {
        let path = self.home.join(format!("env-{id}"));
        let until = Instant::now() + Duration::from_secs(15);
        while !path.exists() {
            assert!(Instant::now() < until, "session {id} never wrote its env");
            thread::sleep(Duration::from_millis(20));
        }
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.into(), v.into()))
            .collect()
    }
    /// Ends a fake agent (its one line) and waits until the core sees it exit.
    fn end(&self, id: &str) {
        call(
            &self.home,
            Request::SendText {
                id: id.into(),
                text: "\r".into(),
                composer: false,
                seen: vec![],
            },
        )
        .unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        while self.session(id).state == SessionState::Running {
            assert!(Instant::now() < until, "session {id} never exited");
            // Ticket 286: the agent's wrapper leaves a shell; quitting it ends the session.
            let _ = call(
                &self.home,
                Request::SendText {
                    id: id.into(),
                    text: "exit\r".into(),
                    composer: false,
                    seen: vec![],
                },
            );
            thread::sleep(Duration::from_millis(1500));
        }
    }
    /// The session token a fake agent was started with, from the env it recorded.
    fn token(&self, id: &str) -> String {
        self.env(id)["NUNCHIRO_TOKEN"].clone()
    }
    /// `nunchiro session start` as that session's agent runs it (its token, no owner socket access).
    fn agent_start(
        &self,
        caller: &Session,
        kind: &str,
        account: Option<&str>,
        resume: Option<&str>,
    ) -> std::process::Output {
        let mut cmd = home::git_env::scrubbed(cli());
        cmd.args(["session", "start", "--kind", kind, "--project"])
            .arg(&self.project);
        if let Some(a) = account {
            cmd.args(["--account", a]);
        }
        if let Some(r) = resume {
            cmd.args(["--resume", r]);
        }
        cmd.env("NUNCHIRO_HOME", &self.home)
            .env("NUNCHIRO_TOKEN", self.token(&caller.id))
            .env("NUNCHIRO_SESSION", &caller.id)
            .output()
            .unwrap()
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
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < until);
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"].clone();
                }
            }
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn serve(home: &Path) -> Child {
    serve_with(home, &[])
}
/// Ticket 457: a throwaway keychain file outside the home, for the start secrets' item (test processes get an empty
/// `NUNCHIRO_KEYCHAIN` from `.cargo/config.toml`, so no other core writes a keychain).
struct Keychain {
    dir: PathBuf,
    path: PathBuf,
}
impl Keychain {
    fn new() -> Self {
        let dir = home::short("kc");
        let path = dir.join("t.keychain-db");
        Self::create(dir, path)
    }
    /// Ticket 1033: a throwaway keychain at `user_home`'s login keychain path, for a core whose HOME is `user_home`.
    fn login(user_home: &Path) -> Self {
        let path = user_home.join("Library/Keychains/login.keychain-db");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        Self::create(user_home.to_path_buf(), path)
    }
    fn create(dir: PathBuf, path: PathBuf) -> Self {
        let kc = Self { dir, path };
        // HOME here: `security` keeps the keychain search list under HOME, and the owner's must stay as it is.
        assert!(kc.security(&["create-keychain", "-p", "t"]));
        assert!(kc.security(&["set-keychain-settings"]));
        kc
    }
    fn security(&self, args: &[&str]) -> bool {
        std::process::Command::new("/usr/bin/security")
            .args(args)
            .arg(&self.path)
            .env("HOME", &self.dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }
    /// Whether `home`'s item is in this keychain.
    fn has_item(&self, home: &Path) -> bool {
        let home = home.canonicalize().unwrap();
        let home = home.to_str().unwrap();
        self.security(&[
            "find-generic-password",
            "-a",
            home,
            "-s",
            "Nunchiro core start (core only)", // ticket 1009 round 6: the in-process item
        ])
    }
    fn var(&self) -> (&'static str, &str) {
        ("NUNCHIRO_KEYCHAIN", self.path.to_str().unwrap())
    }
}
impl Drop for Keychain {
    fn drop(&mut self) {
        self.security(&["delete-keychain"]);
        let _ = fs::remove_dir_all(&self.dir);
    }
}
/// Every file under `dir`, recursively (links not followed).
fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = vec![];
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => found.extend(files_under(&path)),
            Ok(t) if t.is_file() => found.push(path),
            _ => {}
        }
    }
    found
}
fn serve_with(home: &Path, env: &[(&str, &str)]) -> Child {
    serve_command(home, env).spawn().unwrap()
}
fn serve_command(home: &Path, env: &[(&str, &str)]) -> std::process::Command {
    let mut command = home::git_env::scrubbed(cli());
    command
        .arg("serve")
        .envs(env.iter().copied())
        .env("NUNCHIRO_HOME", home)
        .env("HOME", home.join("u"))
        .env("SHELL", "/bin/sh") // ticket 286: the shell an ended agent leaves
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", home.join("bin").display()),
        )
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CLAUDE_SECURESTORAGE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}
const VARS: [&str; 2] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];
fn vars(env: &BTreeMap<String, String>) -> Vec<(&str, Option<&str>)> {
    VARS.iter()
        .map(|v| (*v, env.get(*v).map(String::as_str)))
        .collect()
}

// V2-2b acceptance `account_session_env` (threats 2 and 3): an account session gets exactly its agent's variable, "Your
// own" neither; the record keeps `config_dir` across a core crash and restart (holder reattach) and a resume; a shell
// started after it has neither variable.
#[test]
fn account_session_env() {
    let mut core = Core::new();
    let claude_work = core.add(Agent::Claude, "work");
    let codex_work = core.add(Agent::Codex, "work");
    let claude = core.started(AgentKind::Claude, Some("work"));
    let codex = core.started(AgentKind::Codex, Some("work"));
    let own = core.started(AgentKind::Claude, None);
    assert_eq!(claude.config_dir.as_ref(), Some(&claude_work));
    assert_eq!(codex.config_dir.as_ref(), Some(&codex_work));
    assert_eq!(own.config_dir, None);
    assert_eq!(
        (
            claude.account.as_deref(),
            codex.account.as_deref(),
            own.account.as_deref()
        ),
        (Some("work"), Some("work"), None)
    );
    let claude_dir = claude_work.to_str().unwrap();
    let codex_dir = codex_work.to_str().unwrap();
    assert_eq!(
        vars(&core.env(&claude.id)),
        [
            ("CLAUDE_CONFIG_DIR", Some(claude_dir)),
            ("CODEX_HOME", None)
        ]
    );
    assert_eq!(
        vars(&core.env(&codex.id)),
        [("CLAUDE_CONFIG_DIR", None), ("CODEX_HOME", Some(codex_dir))]
    );
    assert_eq!(
        vars(&core.env(&own.id)),
        [("CLAUDE_CONFIG_DIR", None), ("CODEX_HOME", None)]
    );

    core.crash_and_restart();
    for (id, dir) in [
        (&claude.id, Some(&claude_work)),
        (&codex.id, Some(&codex_work)),
        (&own.id, None),
    ] {
        let restored = core.session(id);
        assert_eq!(restored.state, SessionState::Running, "{id} not reattached");
        assert_eq!(restored.config_dir.as_ref(), dir);
        assert_eq!(restored.account.as_deref(), dir.map(|_| "work"));
    }

    // A shell started after them inherits neither variable.
    let shell = match core.start(
        AgentKind::Shell,
        None,
        None,
        &[
            "/bin/sh",
            "-c",
            "env > \"$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION\"; exec cat",
        ],
    ) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!(shell.config_dir, None);
    assert_eq!(
        vars(&core.env(&shell.id)),
        [("CLAUDE_CONFIG_DIR", None), ("CODEX_HOME", None)]
    );

    // A resume without an account keeps the one the conversation ran on; an account the registry does not know is refused.
    core.end(&claude.id);
    let conversation = claude.agent_session_id.clone();
    let refused = core.start(AgentKind::Claude, Some("other"), conversation.clone(), &[]);
    assert!(refused.is_err(), "{refused:?}");
    core.add(Agent::Claude, "other");
    // Ticket 451 step 2: a resume that names another account continues the conversation there. The fake agent wrote no
    // record of the conversation, so there is nothing to continue and nothing starts.
    let missing = core.start(AgentKind::Claude, Some("other"), conversation.clone(), &[]);
    assert!(
        missing
            .as_ref()
            .is_err_and(|e| e.contains("record was not found")),
        "{missing:?}"
    );
    let resumed = match core.start(AgentKind::Claude, None, conversation.clone(), &[]) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!(resumed.config_dir.as_ref(), Some(&claude_work));
    assert_eq!(resumed.account.as_deref(), Some("work"));
    assert_eq!(
        vars(&core.env(&resumed.id)),
        [
            ("CLAUDE_CONFIG_DIR", Some(claude_dir)),
            ("CODEX_HOME", None)
        ]
    );

    // With the record on the account it ran on, the resume on "other" copies it to the same place there and starts on
    // "other"; the first account keeps its copy.
    core.end(&resumed.id);
    let id = conversation.clone().unwrap();
    let record = claude_work
        .join("projects/-some-folder")
        .join(format!("{id}.jsonl"));
    std::fs::create_dir_all(record.parent().unwrap()).unwrap();
    std::fs::write(&record, "{\"type\":\"user\"}\n").unwrap();
    let moved = match core.start(AgentKind::Claude, Some("other"), conversation.clone(), &[]) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!(moved.account.as_deref(), Some("other"));
    let other_dir = moved.config_dir.clone().unwrap();
    assert_ne!(other_dir, claude_work);
    assert_eq!(
        std::fs::read_to_string(
            other_dir
                .join("projects/-some-folder")
                .join(format!("{id}.jsonl"))
        )
        .unwrap(),
        "{\"type\":\"user\"}\n"
    );
    assert!(record.exists());
    // An empty label names "Your own": the conversation goes there the same way. Before the agent's own folder exists
    // there is nowhere to continue, said plainly.
    core.end(&moved.id);
    let nowhere = core.start(AgentKind::Claude, Some(""), conversation.clone(), &[]);
    assert!(
        nowhere
            .as_ref()
            .is_err_and(|e| e.contains("folder was not found")),
        "{nowhere:?}"
    );
    std::fs::create_dir_all(core.home.join("u/.claude")).unwrap();
    let own_again = match core.start(AgentKind::Claude, Some(""), conversation, &[]) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!(own_again.config_dir, None);
    assert_eq!(own_again.account, None);
    assert!(
        core.home
            .join("u/.claude/projects/-some-folder")
            .join(format!("{id}.jsonl"))
            .exists()
    );
}

// V2-2b acceptance `account_unknown_label_refused` (threat 1): the CLI and the window refuse an unknown label, a path
// included, with the documented message, and no session is created.
#[test]
fn account_unknown_label_refused() {
    let core = Core::new();
    core.add(Agent::Claude, "work");
    let before = core.sessions().len();
    let out = home::git_env::scrubbed(cli())
        .args(["session", "start", "--kind", "claude", "--project"])
        .arg(&core.project)
        .args(["--account", "../x"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr)
            .contains(r#"unknown account "../x" for claude; see nunchiro account list"#),
        "{out:?}"
    );
    // The folder of a real account, named as a path, is still only an unknown label.
    let folder = core.home.join("accounts/claude");
    let named = fs::read_dir(&folder)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let reply = core.window(json!({"op":"start","session":{
        "kind":"claude","project":core.project,"model":null,"effort":null,"resume":null,
        "account":named,
    }}));
    assert_eq!(
        reply["Err"],
        format!(
            "unknown account {:?} for claude; see nunchiro account list",
            named.to_str().unwrap()
        ),
        "{reply}"
    );
    // A Codex label is not a Claude account, and a control character is escaped in the message.
    let reply = core.window(json!({"op":"start","session":{
        "kind":"codex","project":core.project,"model":null,"effort":null,"resume":null,"account":"work\u{1b}[2J",
    }}));
    assert_eq!(
        reply["Err"],
        r#"unknown account "work\u{1b}[2J" for codex; see nunchiro account list"#
    );
    let reply = core.window(json!({"op":"start","session":{
        "kind":"shell","project":core.project,"model":null,"effort":null,"resume":null,"account":"work",
    }}));
    assert_eq!(
        reply["Err"],
        "an account is only for claude or codex sessions"
    );
    assert_eq!(core.sessions().len(), before);
    assert!(
        fs::read_dir(&core.home)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with("env-")),
        "an agent started"
    );
    // Security review S2: a name two accounts share is refused, never resolved to the first.
    core.add(Agent::Claude, "work");
    let refused = core.start(AgentKind::Claude, Some("work"), None, &[]);
    assert_eq!(
        refused.unwrap_err(),
        r#"two claude accounts are named "work"; remove one"#
    );
}

// V2-2b threat 2, the model-switch path: a Codex model switch restarts the agent into the same conversation and keeps
// the session's account.
#[test]
fn account_kept_across_codex_model_switch() {
    let core = Core::new();
    let work = core.add(Agent::Codex, "work");
    // The core probes `codex --version` under a 3 s budget before it starts; python3's own startup can eat that at
    // load, so the version answers from sh and only the session itself runs the python fixture.
    let picker = core.home.join("bin/codex-picker");
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nunchiro/tests/fixtures/codex-picker"),
        &picker,
    )
    .unwrap();
    fs::set_permissions(&picker, fs::Permissions::from_mode(0o700)).unwrap();
    let codex = core.home.join("bin/codex");
    fs::write(
        &codex,
        format!(
            "#!/bin/sh\ncase \"$1\" in --version) echo 'codex-cli 0.161.0'; exit 0;; esac\nexec {} \"$@\"\n",
            picker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
    let old = match call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                kind: AgentKind::Codex,
                project: core.project.clone(),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: Some("gpt-6-luna".into()),
                effort: Some("medium".into()),
                resume: None,
                account: Some("work".into()),
            },
        },
    ) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    let screen = |id: &str| match call(
        &core.home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    ) {
        Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
        other => panic!("{other:?}"),
    };
    let until = Instant::now() + Duration::from_secs(20);
    while core.session(&old.id).agent_session_id.is_none()
        || !screen(&old.id).contains("gpt-fixture")
    {
        assert!(Instant::now() < until, "Codex never showed its input box");
        thread::sleep(Duration::from_millis(20));
    }
    // Security review S1: an account no longer in the registry refuses the switch before the agent stops.
    let registry = core.home.join("accounts.toml");
    let kept = fs::read(&registry).unwrap();
    fs::write(&registry, "version = 1\n").unwrap();
    let refused = call(
        &core.home,
        Request::SwitchModel {
            id: old.id.clone(),
            model: Some("gpt-5.6-luna".into()),
            effort: Some("low".into()),
            fast: None,
            ultracode: None,
        },
    );
    assert_eq!(
        refused.unwrap_err(),
        "this conversation's account is no longer in the account list"
    );
    assert_eq!(core.session(&old.id).state, SessionState::Running);
    fs::write(&registry, kept).unwrap();
    let switched = match call(
        &core.home,
        Request::SwitchModel {
            id: old.id.clone(),
            model: Some("gpt-5.6-luna".into()),
            effort: Some("low".into()),
            fast: None,
            ultracode: None,
        },
    ) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_ne!(switched.id, old.id);
    assert_eq!(switched.config_dir.as_ref(), Some(&work));
    assert_eq!(switched.account.as_deref(), Some("work"));
}

// V2-2b security review M1 (threat 3): the core crashed and an agent on an account runs `nunchiro`, which starts a
// new core. That core must not take the account folder as "Your own": a later "Your own" session gets neither
// variable, with the old core's recorded start and without one.
#[test]
fn core_started_from_account_session_keeps_your_own() {
    let mut core = Core::new();
    let work = core.add(Agent::Claude, "work");
    for recorded in [true, false] {
        // Round 1 kills our core; round 2 finds the one round 1's CLI started already stopped.
        let _ = core.process.kill();
        let _ = core.process.wait();
        let _ = fs::remove_file(core.home.join("core.sock"));
        if !recorded {
            fs::remove_file(core.home.join("core.start.json")).unwrap();
        }
        // The CLI as the account session's agent runs it: its env names the account folder and a session token.
        let _ = home::git_env::scrubbed(cli())
            .args(["session", "list"])
            .env("NUNCHIRO_HOME", &core.home)
            .env("HOME", core.home.join("u"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", core.home.join("bin").display()),
            )
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env("CLAUDE_CONFIG_DIR", &work)
            .env("NUNCHIRO_TOKEN", "0".repeat(64))
            .env("NUNCHIRO_SESSION", "s")
            .output()
            .unwrap();
        core.ready();
        let own = core.started(AgentKind::Claude, None);
        assert_eq!(
            vars(&core.env(&own.id)),
            [("CLAUDE_CONFIG_DIR", None), ("CODEX_HOME", None)],
            "recorded start: {recorded}"
        );
        // Stop that core (not our child) so the next round's CLI starts one again.
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &core.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
    }
}

fn new_sessions(core: &Core, before: &[Session]) -> Vec<Session> {
    core.sessions()
        .into_iter()
        .filter(|s| before.iter().all(|b| b.id != s.id))
        .collect()
}

// V2-2b-fu acceptance `agent_start_inherits_caller_account` (ACCOUNTPICK): a session token that starts a session with no
// account gets its own session's account, whatever the agent; a caller on "Your own" starts "Your own" sessions.
#[test]
fn agent_start_inherits_caller_account() {
    let core = Core::new();
    let claude_work = core.add(Agent::Claude, "work");
    let codex_work = core.add(Agent::Codex, "work");
    let parent = core.started(AgentKind::Claude, Some("work"));
    let before = core.sessions();
    for (kind, account, folder, variable, other) in [
        (
            "claude",
            None,
            &claude_work,
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
        ),
        (
            "codex",
            None,
            &codex_work,
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
        ),
        (
            "claude",
            Some("work"),
            &claude_work,
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
        ),
    ] {
        let known = core.sessions();
        let out = core.agent_start(&parent, kind, account, None);
        assert!(out.status.success(), "{kind} {account:?}: {out:?}");
        let [child] = &new_sessions(&core, &known)[..] else {
            panic!("{kind}: not exactly one new session");
        };
        assert_eq!(child.account.as_deref(), Some("work"), "{kind} {account:?}");
        assert_eq!(child.config_dir.as_ref(), Some(folder));
        let env = core.env(&child.id);
        assert_eq!(env.get(variable).map(Path::new), Some(folder.as_path()));
        assert_eq!(env.get(other), None);
    }
    assert_eq!(new_sessions(&core, &before).len(), 3);
    // A shell takes no account.
    let known = core.sessions();
    assert!(
        core.agent_start(&parent, "shell", None, None)
            .status
            .success()
    );
    assert_eq!(new_sessions(&core, &known)[0].account, None);
    // A caller on "Your own" starts "Your own" sessions.
    let own = core.started(AgentKind::Claude, None);
    let known = core.sessions();
    assert!(
        core.agent_start(&own, "claude", None, None)
            .status
            .success()
    );
    let [child] = &new_sessions(&core, &known)[..] else {
        panic!("not exactly one new session");
    };
    assert_eq!(
        (child.account.as_deref(), child.config_dir.as_ref()),
        (None, None)
    );
}

// V2-2b-fu acceptance `agent_cannot_pick_another_account`: a different label (or any label from "Your own") is refused
// with a clear error and nothing is created; so is resuming a conversation that ran on another account.
#[test]
fn agent_cannot_pick_another_account() {
    let core = Core::new();
    core.add(Agent::Claude, "work");
    core.add(Agent::Claude, "other");
    let parent = core.started(AgentKind::Claude, Some("work"));
    let own = core.started(AgentKind::Claude, None);
    let elsewhere = core.started(AgentKind::Claude, Some("other"));
    core.end(&elsewhere.id);
    let conversation = elsewhere.agent_session_id.clone().unwrap();
    let before = core.sessions();
    let refusal = "a session can start sessions only on its own account";
    for (caller, account, resume) in [
        (&parent, Some("other"), None),
        (&parent, None, Some(conversation.as_str())),
        // Ticket 451: its own label on a resume would carry the other account's conversation into its own.
        (&parent, Some("work"), Some(conversation.as_str())),
        (&own, Some("work"), None),
    ] {
        let out = core.agent_start(caller, "claude", account, resume);
        assert!(!out.status.success(), "{account:?} {resume:?}: {out:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(refusal),
            "{account:?} {resume:?}: {out:?}"
        );
    }
    assert_eq!(new_sessions(&core, &before).len(), 0);
}

// V2-2b-fu acceptance `owner_picks_any_account`: the owner's socket still picks any account or "Your own".
#[test]
fn owner_picks_any_account() {
    let core = Core::new();
    core.add(Agent::Claude, "work");
    core.add(Agent::Claude, "other");
    for label in [Some("work"), Some("other"), None] {
        let session = core.started(AgentKind::Claude, label);
        assert_eq!(session.account.as_deref(), label);
        assert_eq!(session.config_dir.is_some(), label.is_some());
    }
    // The same owner, now from a window, picks too.
    let reply = core.window(json!({"op":"start","session":{
        "kind":"claude","project":core.project,"model":null,"effort":null,"resume":null,"account":"other",
    }}));
    assert_eq!(reply["Ok"]["session"]["account"], "other", "{reply}");
}

// V2-2b-fu acceptance `store_load_refuses_unregistered_or_linked_folder`: a stored session whose account folder is no
// longer in the registry, or is now a link, loads as not resumable without the folder; a registered one is kept.
#[test]
fn store_load_refuses_unregistered_or_linked_folder() {
    let mut core = Core::new();
    let good = core.add(Agent::Claude, "good");
    let unregistered = core.add(Agent::Claude, "ghost");
    let linked = core.add(Agent::Claude, "linked");
    let ids: Vec<String> = ["good", "ghost", "linked"]
        .map(|l| {
            let s = core.started(AgentKind::Claude, Some(l));
            core.end(&s.id);
            assert!(core.session(&s.id).agent_session_id.is_some());
            s.id
        })
        .into();
    core.process.kill().unwrap();
    let _ = core.process.wait();
    // "ghost" leaves the registry (its folder stays); "linked" is swapped for a link to another folder.
    let registry = core.home.join("accounts.toml");
    let text = fs::read_to_string(&registry).unwrap();
    let id = unregistered.file_name().unwrap().to_str().unwrap();
    let kept: Vec<&str> = text.split("[[").filter(|b| !b.contains(id)).collect();
    fs::write(&registry, kept.join("[[")).unwrap();
    let target = core.home.join("elsewhere");
    fs::create_dir_all(&target).unwrap();
    fs::remove_dir_all(&linked).unwrap();
    std::os::unix::fs::symlink(&target, &linked).unwrap();
    core.process = serve(&core.home);
    core.ready();
    let kept = core.session(&ids[0]);
    assert_eq!(kept.state, SessionState::Resumable);
    assert_eq!(kept.config_dir.as_ref(), Some(&good));
    assert!(kept.agent_session_id.is_some());
    for id in &ids[1..] {
        let session = core.session(id);
        assert_eq!(session.state, SessionState::Exited, "{id}");
        assert_eq!((session.config_dir, session.account), (None, None), "{id}");
        assert_eq!(session.agent_session_id, None, "{id}");
    }
}

// V2-2b-fu r2 acceptance `remote_caller_never_inherits_a_local_account`: a paired peer picks the id it forwards as, so one
// that names a local account session still starts on "Your own" and cannot name that account.
#[test]
fn remote_caller_never_inherits_a_local_account() {
    let core = Core::new();
    core.add(Agent::Claude, "work");
    let parent = core.started(AgentKind::Claude, Some("work"));
    let forward = |account: Option<&str>| {
        call(
            &core.home,
            Request::Forwarded {
                caller: nunchiro_core::machines::Caller {
                    id: parent.id.clone(),
                    project: core.project.clone(),
                    permission_answers: false,
                },
                request: Box::new(Request::Start {
                    receipt: None,
                    env: Default::default(),
                    folder: None,
                    session: StartSession {
                        kind: AgentKind::Claude,
                        project: core.project.clone(),
                        worktree: false,
                        label: String::new(),
                        args: vec![],
                        model: None,
                        effort: None,
                        resume: None,
                        account: account.map(Into::into),
                    },
                }),
            },
        )
    };
    let before = core.sessions();
    let refused = forward(Some("work"));
    assert_eq!(
        refused.unwrap_err(),
        "a session can start sessions only on its own account"
    );
    assert_eq!(new_sessions(&core, &before).len(), 0);
    let child = match forward(None) {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!((child.account, child.config_dir), (None, None));
}

// V2-2b-fu r2 acceptance `cross_agent_inherit_without_matching_label_is_refused`: a Codex session on "work" starting Claude
// inherits the label "work", which Claude has no account for: refused, nothing created.
#[test]
fn cross_agent_inherit_without_matching_label_is_refused() {
    let core = Core::new();
    core.add(Agent::Codex, "work");
    let parent = core.started(AgentKind::Codex, Some("work"));
    let before = core.sessions();
    let out = core.agent_start(&parent, "claude", None, None);
    assert!(!out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stderr)
            .contains(r#"unknown account "work" for claude; see nunchiro account list"#),
        "{out:?}"
    );
    assert_eq!(new_sessions(&core, &before).len(), 0);
}

// Ticket 32 acceptance `restart_without_start_json_keeps_or_documents_api_keys` (decision: document). An account
// session's agent never holds the owner's API keys (`ACCOUNT_ENV`), so a core it starts can take them only from the
// old core's `core.start.json`: with the record a "Your own" session gets the owner's key again; without it the new
// core has nothing to take them from and that session starts without the key (no second copy of a key is kept). An
// account session gets no key either way.
//
// Ticket 457: the record holds the key's name only; its value comes back from the keychain the old core wrote.
#[test]
fn restart_without_start_json_keeps_or_documents_api_keys() {
    let keychain = Keychain::new();
    let mut core = Core::new();
    let _ = core.process.kill();
    let _ = core.process.wait();
    core.process = serve_with(
        &core.home,
        &[("ANTHROPIC_API_KEY", "sk-owner"), keychain.var()],
    );
    core.ready();
    // Ticket 1008: an agent session gets a secret-looking name only when the owner keeps it.
    call(
        &core.home,
        serde_json::from_value(json!({"op":"quit_settings","patch":{"features":{"env.keep_secrets":["ANTHROPIC_API_KEY"]}}}))
            .unwrap(),
    )
    .unwrap();
    // Ticket 1114: Snapshot readiness does not cover the asynchronous keychain write. A crash before that
    // write finishes loses the key by design; this test exercises restart with a successfully stored key.
    let until = Instant::now() + Duration::from_secs(10);
    while !keychain.has_item(&core.home) {
        assert!(Instant::now() < until, "the owner key was never stored");
        thread::sleep(Duration::from_millis(20));
    }
    let work = core.add(Agent::Claude, "work");
    let parent = core.started(AgentKind::Claude, Some("work"));
    assert_eq!(core.env(&parent.id).get("ANTHROPIC_API_KEY"), None);
    for recorded in [true, false] {
        let _ = core.process.kill();
        let _ = core.process.wait();
        let _ = fs::remove_file(core.home.join("core.sock"));
        if !recorded {
            fs::remove_file(core.home.join("core.start.json")).unwrap();
        }
        // The CLI as the account session's agent runs it: no owner key, its account folder and a session token.
        let _ = home::git_env::scrubbed(cli())
            .args(["session", "list"])
            .env("NUNCHIRO_HOME", &core.home)
            .env("HOME", core.home.join("u"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", core.home.join("bin").display()),
            )
            .env_remove("ANTHROPIC_API_KEY")
            .env("CLAUDE_CONFIG_DIR", &work)
            .env("NUNCHIRO_TOKEN", "0".repeat(64))
            .env("NUNCHIRO_SESSION", "s")
            .output()
            .unwrap();
        core.ready();
        let own = core.started(AgentKind::Claude, None);
        let on_work = core.started(AgentKind::Claude, Some("work"));
        assert_eq!(
            core.env(&own.id)
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            recorded.then_some("sk-owner"),
            "recorded start: {recorded}"
        );
        assert_eq!(core.env(&on_work.id).get("ANTHROPIC_API_KEY"), None);
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &core.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
    }
}

// Ticket 1024 (Codex round 9 NOTE, by design): a record from before generations restores no secret, so the first
// restart after that update starts without them. The core says so in its log, once per such start; a record that has
// a generation (its item only unread) gets no such line.
#[test]
fn restart_from_a_record_without_generation_says_so() {
    for (generation, lines) in [(None, 1), (Some("g1"), 0)] {
        let mut core = Core::new();
        let _ = core.process.kill();
        let _ = core.process.wait();
        let _ = fs::remove_file(core.home.join("core.sock"));
        let record = core.home.join("core.start.json");
        let mut v: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
        v["secrets"] = json!(["ANTHROPIC_API_KEY", "GH_TOKEN"]);
        v["secrets_gen"] = json!(generation);
        fs::write(&record, serde_json::to_vec(&v).unwrap()).unwrap();
        let _ = home::git_env::scrubbed(cli())
            .args(["session", "list"])
            .env("NUNCHIRO_HOME", &core.home)
            .env("HOME", core.home.join("u"))
            .env("NUNCHIRO_TOKEN", "0".repeat(64))
            .env("NUNCHIRO_SESSION", "s")
            .output()
            .unwrap();
        core.ready();
        let log = fs::read_to_string(core.home.join("logs/core.log")).unwrap();
        assert_eq!(
            log.matches("the restart record has no generation").count(),
            lines,
            "record generation {generation:?}: {log}"
        );
        if lines == 1 {
            assert!(log.contains("without 2 secret variable(s)"), "{log}");
        }
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &core.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
    }
}

// Ticket 457 (owner decision 11-12, option b): a core started with secret variables writes none of their values to a
// file under its home; `core.start.json` names them, the keychain item holds them, and a full stop removes the item.
#[test]
fn start_secrets_stay_out_of_the_home() {
    let keychain = Keychain::new();
    let mut core = Core::new();
    let _ = core.process.kill();
    let _ = core.process.wait();
    let secrets = [
        ("ANTHROPIC_API_KEY", "sk-457-anthropic"),
        ("gh_token", "ghp-457-github"),
        ("DB_PASSWORD", "pw-457-db"),
        ("APP_SECRET", "secret-457-app"),
        // Ticket 1024: more secret-shaped names, and a plain name whose URL carries a password.
        ("BW_SESSION", "bw-1024-session"),
        ("SIGNING_KEYS", "keys-1024-signing"),
        ("CACHE_1024_URL", "redis://u:pw-1024-cache@cache.invalid/0"),
    ];
    let mut env = secrets.to_vec();
    env.extend([keychain.var(), ("PLAIN_457", "plain-457")]);
    core.process = serve_with(&core.home, &env);
    core.ready();
    let until = Instant::now() + Duration::from_secs(10);
    while !keychain.has_item(&core.home) {
        assert!(Instant::now() < until, "no keychain item");
        thread::sleep(Duration::from_millis(50));
    }
    let files = files_under(&core.home);
    assert!(files.iter().any(|f| f.ends_with("core.start.json")));
    for file in &files {
        let bytes = fs::read(file).unwrap();
        for (name, value) in secrets {
            assert!(
                !bytes.windows(value.len()).any(|w| w == value.as_bytes()),
                "{name}'s value is in {}",
                file.display()
            );
        }
    }
    let record: Value =
        serde_json::from_slice(&fs::read(core.home.join("core.start.json")).unwrap()).unwrap();
    // The shell running the tests may add secret variables of its own.
    let names: Vec<&str> = record["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    for (name, _) in secrets {
        assert!(names.contains(&name), "{name} not named: {names:?}");
    }
    assert_eq!(record["env"]["PLAIN_457"], "plain-457");
    for (name, _) in secrets {
        assert!(record["env"].get(name).is_none(), "{name} in env");
    }
    let stopped = home::git_env::scrubbed(cli())
        .args(["serve", "stop", "--yes"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .output()
        .unwrap();
    assert!(stopped.status.success());
    assert!(!keychain.has_item(&core.home), "a full stop kept the item");
}

// Ticket 1033: a core on a temp (test) home started without `NUNCHIRO_KEYCHAIN` (a test binary run outside cargo, so
// without `.cargo/config.toml`'s empty one) writes no item to the login keychain under its HOME, and a killed core
// (no full stop to remove it) leaves none behind.
#[test]
fn temp_home_leaves_no_login_keychain_item() {
    let mut core = Core::new();
    let _ = core.process.kill();
    let _ = core.process.wait();
    let _ = fs::remove_file(core.home.join("core.sock"));
    let login = Keychain::login(&core.home.join("u"));
    assert!(!login.has_item(&core.home), "an item before the start");
    core.process = serve_command(&core.home, &[("ANTHROPIC_API_KEY", "sk-1033")])
        .env_remove("NUNCHIRO_KEYCHAIN")
        .spawn()
        .unwrap();
    core.ready();
    assert!(core.home.join("core.start.json").exists());
    // The item is written off the start path; give that thread time to run.
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        assert!(
            !login.has_item(&core.home),
            "a temp home wrote a login keychain item"
        );
        thread::sleep(Duration::from_millis(100));
    }
    let _ = core.process.kill();
    let _ = core.process.wait();
    assert!(!login.has_item(&core.home), "a killed core left an item");
}

// Ticket 457 round 2 (security S2): when a start's secrets cannot be stored (here too long for one item), the item of
// an earlier start goes, so a restart from a session cannot bring back a rotated key under the same name.
#[test]
fn failed_store_forgets_the_earlier_item() {
    let keychain = Keychain::new();
    let mut core = Core::new();
    for (value, kept) in [("sk-457-old".to_string(), true), ("x".repeat(5000), false)] {
        let _ = core.process.kill();
        let _ = core.process.wait();
        let _ = fs::remove_file(core.home.join("core.sock"));
        core.process = serve_with(&core.home, &[("ROTATED_KEY", &value), keychain.var()]);
        core.ready();
        let until = Instant::now() + Duration::from_secs(10);
        while keychain.has_item(&core.home) != kept {
            assert!(Instant::now() < until, "item kept: {}", !kept);
            thread::sleep(Duration::from_millis(50));
        }
    }
}

// Ticket 32 acceptance `remote_mark_is_per_request`: a paired peer that forwards as a local account session's id is
// marked for that request only (it starts on "Your own"); the session's own token call afterwards is not (its child
// inherits "work"), and the token caller is still refused another account.
#[test]
fn remote_mark_is_per_request() {
    let core = Core::new();
    core.add(Agent::Claude, "work");
    core.add(Agent::Claude, "other");
    let parent = core.started(AgentKind::Claude, Some("work"));
    let forwarded = call(
        &core.home,
        Request::Forwarded {
            caller: nunchiro_core::machines::Caller {
                id: parent.id.clone(),
                project: core.project.clone(),
                permission_answers: false,
            },
            request: Box::new(Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind: AgentKind::Claude,
                    project: core.project.clone(),
                    worktree: false,
                    label: String::new(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: None,
                },
            }),
        },
    );
    let remote = match forwarded {
        Ok(Reply::Started { session }) => session,
        other => panic!("{other:?}"),
    };
    assert_eq!((remote.account, remote.config_dir), (None, None));
    let before = core.sessions();
    let out = core.agent_start(&parent, "claude", None, None);
    assert!(out.status.success(), "{out:?}");
    let [child] = &new_sessions(&core, &before)[..] else {
        panic!("not exactly one new session");
    };
    assert_eq!(child.account.as_deref(), Some("work"));
    let before = core.sessions();
    let out = core.agent_start(&parent, "claude", Some("other"), None);
    assert!(
        String::from_utf8_lossy(&out.stderr)
            .contains("a session can start sessions only on its own account"),
        "{out:?}"
    );
    assert_eq!(new_sessions(&core, &before).len(), 0);
}

// Ticket 358: a crash between a rename's two saves leaves the registry on the new name and sessions on the old one, and
// such a session could then never start again. The next rename, even to the name it already has, or the next load
// puts it right, by folder.
#[test]
fn rename_heals_labels_a_crash_left_behind() {
    let mut core = Core::new();
    let folder = core.add(Agent::Claude, "old");
    let id = folder.file_name().unwrap().to_str().unwrap().to_string();
    let running = core.started(AgentKind::Claude, Some("old"));
    let registry = core.home.join("accounts.toml");
    let crash = |from: &str, to: &str| {
        let text = fs::read_to_string(&registry).unwrap();
        assert!(text.contains(from), "{text}");
        fs::write(&registry, text.replace(from, to)).unwrap();
    };
    let rename = |label: &str| {
        call(
            &core.home,
            Request::AccountRename {
                agent: Agent::Claude,
                id: id.clone(),
                label: label.into(),
            },
        )
        .unwrap()
    };

    crash("\"old\"", "\"crashed\"");
    rename("crashed");
    assert_eq!(
        core.session(&running.id).account.as_deref(),
        Some("crashed")
    );

    crash("\"crashed\"", "\"again\"");
    rename("next");
    assert_eq!(core.session(&running.id).account.as_deref(), Some("next"));
    let fresh = core.started(AgentKind::Claude, Some("next"));
    assert_eq!(fresh.config_dir.as_ref(), Some(&folder));

    crash("\"next\"", "\"loaded\"");
    core.crash_and_restart();
    assert_eq!(core.session(&running.id).account.as_deref(), Some("loaded"));
    assert_eq!(core.session(&fresh.id).account.as_deref(), Some("loaded"));
    let after = core.started(AgentKind::Claude, Some("loaded"));
    assert_eq!(after.config_dir.as_ref(), Some(&folder));
}

// Ticket 32 acceptance `resume_conversation_on_own_account`: a session on "work" resumes, by its token, a conversation
// that ran on "work"; the resumed agent runs with that account's folder, not the default config.
#[test]
fn resume_conversation_on_own_account() {
    let core = Core::new();
    let work = core.add(Agent::Claude, "work");
    let parent = core.started(AgentKind::Claude, Some("work"));
    let ended = core.started(AgentKind::Claude, Some("work"));
    core.end(&ended.id);
    let conversation = ended.agent_session_id.clone().unwrap();
    // A resume may keep the row's id: its env must be the resumed run's, not the first one's.
    fs::remove_file(core.home.join(format!("env-{}", ended.id))).unwrap();
    let before = core.sessions();
    let out = core.agent_start(&parent, "claude", None, Some(&conversation));
    assert!(out.status.success(), "{out:?}");
    let resumed = core
        .sessions()
        .into_iter()
        .find(|s| {
            s.agent_session_id.as_deref() == Some(conversation.as_str())
                && s.state == SessionState::Running
                && before
                    .iter()
                    .all(|b| b.id != s.id || b.state != SessionState::Running)
        })
        .expect("resumed session");
    assert_eq!(resumed.account.as_deref(), Some("work"));
    assert_eq!(resumed.config_dir.as_ref(), Some(&work));
    assert_eq!(
        vars(&core.env(&resumed.id)),
        [
            ("CLAUDE_CONFIG_DIR", Some(work.to_str().unwrap())),
            ("CODEX_HOME", None)
        ]
    );
}

// Ticket 1009 round 2 (Fable S2): the CLI hands the keychain's values only to its own executable. A `core.start.json`
// whose `exe` names another program (a same-user process can edit the file) starts it without them.
#[test]
fn restart_gives_secrets_only_to_this_executable() {
    let keychain = Keychain::new();
    let mut core = Core::new();
    let _ = core.process.kill();
    let _ = core.process.wait();
    core.process = serve_with(
        &core.home,
        &[
            ("W36_RESTART_SECRET", "sk-1009"),
            ("PLAIN_1009", "plain"),
            keychain.var(),
        ],
    );
    core.ready();
    let until = Instant::now() + Duration::from_secs(10);
    while !keychain.has_item(&core.home) {
        assert!(Instant::now() < until, "no keychain item");
        thread::sleep(Duration::from_millis(50));
    }
    let _ = core.process.kill();
    let _ = core.process.wait();
    let _ = fs::remove_file(core.home.join("core.sock"));
    let out = core.home.join("other.env");
    let other = core.home.join("other-exe");
    fs::write(
        &other,
        format!(
            "#!/bin/sh\nenv | cut -d= -f1 > {}.tmp && mv {0}.tmp {0}\n",
            out.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&other, fs::Permissions::from_mode(0o700)).unwrap();
    let file = core.home.join("core.start.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    record["exe"] = json!(other);
    // Round 3 (Codex MUST): loader variables written into the record never reach the started program. (`/bin/sh`
    // would drop DYLD_* itself under SIP; LD_PRELOAD shows the record's variables are filtered by the CLI.)
    record["env"]["DYLD_INSERT_LIBRARIES"] = json!("/tmp/w36-none.dylib");
    record["env"]["LD_PRELOAD"] = json!("/tmp/w36-none.so");
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    let _ = home::git_env::scrubbed(cli())
        .args(["session", "list"])
        .env("NUNCHIRO_HOME", &core.home)
        .env("HOME", core.home.join("u"))
        // As a session's agent runs it: a start asked from a session uses the record (ticket 32).
        .env("NUNCHIRO_TOKEN", "0".repeat(64))
        .env("NUNCHIRO_SESSION", "s")
        .env_remove("W36_RESTART_SECRET")
        .output()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(20);
    while !out.exists() {
        assert!(Instant::now() < until, "the recorded exe never ran");
        thread::sleep(Duration::from_millis(50));
    }
    let names = fs::read_to_string(&out).unwrap();
    assert!(names.lines().any(|n| n == "PLAIN_1009"), "{names}");
    assert!(!names.lines().any(|n| n == "W36_RESTART_SECRET"), "{names}");
    for loader in ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD"] {
        assert!(!names.lines().any(|n| n == loader), "{loader}: {names}");
    }
}

// Ticket 1009 round 5 (Codex MUST): a restart from a record whose SHELL names another program does not run it as the
// login probe (the account's own shell is used), so it never sees the restored keychain values.
#[test]
fn restart_probe_ignores_the_recorded_shell() {
    let keychain = Keychain::new();
    let mut core = Core::new();
    let _ = core.process.kill();
    let _ = core.process.wait();
    core.process = serve_with(
        &core.home,
        &[("W36_PROBE_SECRET", "sk-1009-probe"), keychain.var()],
    );
    core.ready();
    let until = Instant::now() + Duration::from_secs(10);
    while !keychain.has_item(&core.home) {
        assert!(Instant::now() < until, "no keychain item");
        thread::sleep(Duration::from_millis(50));
    }
    let _ = core.process.kill();
    let _ = core.process.wait();
    let _ = fs::remove_file(core.home.join("core.sock"));
    let out = core.home.join("probe.env");
    let shell = core.home.join("probe-shell");
    fs::write(
        &shell,
        format!("#!/bin/sh\nenv > {}\nexec /bin/sh \"$@\"\n", out.display()),
    )
    .unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
    let file = core.home.join("core.start.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    record["env"]["SHELL"] = json!(shell);
    // The probe runs in this start (test cores turn it off).
    record["env"]
        .as_object_mut()
        .unwrap()
        .remove("NUNCHIRO_LOGIN_PATH");
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    let _ = home::git_env::scrubbed(cli())
        .args(["session", "list"])
        .env("NUNCHIRO_HOME", &core.home)
        .env("HOME", core.home.join("u"))
        .env("NUNCHIRO_TOKEN", "0".repeat(64))
        .env("NUNCHIRO_SESSION", "s")
        .env_remove("W36_PROBE_SECRET")
        .output()
        .unwrap();
    core.ready();
    // The recorded shell never ran as the probe, so no file holds the restored value.
    let seen = fs::read_to_string(&out).unwrap_or_default();
    assert!(
        !seen.contains("sk-1009-probe"),
        "the probe got the restored secret"
    );
    assert!(!out.exists(), "the recorded SHELL ran as the probe");
    let _ = home::git_env::scrubbed(cli())
        .args(["serve", "stop", "--yes"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .output();
}

// Ticket 1009 round 5: a build without the hardened runtime keeps no keychain item (fail closed), and says why.
#[test]
fn unhardened_build_keeps_no_keychain_item() {
    let keychain = Keychain::new();
    let home = home::short("unhard");
    let log = home.join("core.err");
    let mut core = home::git_env::scrubbed(cli::path())
        .arg("serve")
        .env("NUNCHIRO_HOME", &home)
        .env("HOME", home.join("u"))
        .env("W36_UNHARD_SECRET", "sk-unhard")
        .env(keychain.var().0, keychain.var().1)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(fs::File::create(&log).unwrap())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(20);
    while !fs::read_to_string(&log)
        .unwrap_or_default()
        .contains("hardened runtime")
    {
        assert!(
            Instant::now() < until,
            "no refusal line: {}",
            fs::read_to_string(&log).unwrap_or_default()
        );
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !keychain.has_item(&home),
        "an unhardened core wrote the item"
    );
    // Round 8: bounded. The refusal line comes before the core answers, so a Stop sent too early is lost and an
    // unbounded wait would hang; ask until it stops, then end our own child by its handle.
    let until = Instant::now() + Duration::from_secs(20);
    while core.try_wait().unwrap().is_none() && Instant::now() < until {
        let _ = call(&home, Request::Stop);
        thread::sleep(Duration::from_millis(100));
    }
    let _ = core.kill();
    let _ = core.wait();
    assert!(!fs::read_to_string(&log).unwrap().contains("sk-unhard"));
    let _ = fs::remove_dir_all(&home);
}

// Ticket 1009 round 6 (Codex MUST): a restart that cannot restore the named secrets (here the record's exe is a copy
// of this build, so the CLI hands over nothing) keeps the item and the record's names for a later start.
#[test]
fn unread_restart_keeps_the_item_and_names() {
    let keychain = Keychain::new();
    let mut core = Core::new();
    let _ = core.process.kill();
    let _ = core.process.wait();
    core.process = serve_with(
        &core.home,
        &[("W36_KEEP_SECRET", "sk-1009-keep"), keychain.var()],
    );
    core.ready();
    let until = Instant::now() + Duration::from_secs(10);
    while !keychain.has_item(&core.home) {
        assert!(Instant::now() < until, "no keychain item");
        thread::sleep(Duration::from_millis(50));
    }
    let _ = core.process.kill();
    let _ = core.process.wait();
    let _ = fs::remove_file(core.home.join("core.sock"));
    let copy = core.home.join("nunchiro-copy");
    fs::copy(cli(), &copy).unwrap();
    let file = core.home.join("core.start.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    record["exe"] = json!(copy);
    fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
    let _ = home::git_env::scrubbed(cli())
        .args(["session", "list"])
        .env("NUNCHIRO_HOME", &core.home)
        .env("HOME", core.home.join("u"))
        .env("NUNCHIRO_TOKEN", "0".repeat(64))
        .env("NUNCHIRO_SESSION", "s")
        .env_remove("W36_KEEP_SECRET")
        .output()
        .unwrap();
    core.ready();
    // The new core wrote its record (its exe is the copy) and kept the earlier name and item.
    let until = Instant::now() + Duration::from_secs(10);
    let record = loop {
        let r: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        if r["exe"] == json!(copy.canonicalize().unwrap()) || r["exe"] == json!(copy) {
            break r;
        }
        assert!(
            Instant::now() < until,
            "the new core never wrote its record"
        );
        thread::sleep(Duration::from_millis(50));
    };
    // The runner's own secret names may be listed too; only names are asserted, never the record printed.
    let names = record["secrets"].clone();
    assert!(
        names
            .as_array()
            .is_some_and(|a| a.contains(&json!("W36_KEEP_SECRET"))),
        "{names}"
    );
    assert!(record["env"].get("NUNCHIRO_START_SECRETS_UNREAD").is_none());
    thread::sleep(Duration::from_millis(500)); // the keychain step runs off the start path
    assert!(
        keychain.has_item(&core.home),
        "the unread restart removed the item"
    );
    let _ = home::git_env::scrubbed(cli())
        .args(["serve", "stop", "--yes"])
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .output();
}

// Ticket 1009 round 9 (Codex MUST): an item a failed update left behind (a locked keychain) belongs to an earlier
// start. Its generation differs from the record's, so a restart applies none of its values instead of an old key.
#[test]
fn restart_applies_no_item_of_another_generation() {
    for (generation, expected) in [(None, Some("sk-old")), (Some("newer"), None)] {
        let keychain = Keychain::new();
        let mut core = Core::new();
        let _ = core.process.kill();
        let _ = core.process.wait();
        core.process = serve_with(
            &core.home,
            &[("ANTHROPIC_API_KEY", "sk-old"), keychain.var()],
        );
        core.ready();
        call(
            &core.home,
            serde_json::from_value(json!({"op":"quit_settings","patch":{"features":{"env.keep_secrets":["ANTHROPIC_API_KEY"]}}}))
                .unwrap(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !keychain.has_item(&core.home) {
            assert!(Instant::now() < deadline, "the start never wrote its item");
            thread::sleep(Duration::from_millis(100));
        }
        let _ = core.process.kill();
        let _ = core.process.wait();
        let _ = fs::remove_file(core.home.join("core.sock"));
        if let Some(g) = generation {
            let record = core.home.join("core.start.json");
            let mut v: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
            v["secrets_gen"] = json!(g);
            fs::write(&record, serde_json::to_vec(&v).unwrap()).unwrap();
        }
        let _ = home::git_env::scrubbed(cli())
            .args(["session", "list"])
            .env("NUNCHIRO_HOME", &core.home)
            .env("HOME", core.home.join("u"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", core.home.join("bin").display()),
            )
            .env_remove("ANTHROPIC_API_KEY")
            .env("NUNCHIRO_TOKEN", "0".repeat(64))
            .env("NUNCHIRO_SESSION", "s")
            .output()
            .unwrap();
        core.ready();
        let own = core.started(AgentKind::Claude, None);
        assert_eq!(
            core.env(&own.id)
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            expected,
            "record generation {generation:?}"
        );
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &core.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
    }
}
