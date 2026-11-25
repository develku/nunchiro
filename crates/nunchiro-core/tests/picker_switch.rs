//! V1A-10: model and effort at launch and per running session, through fake agents only.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[path = "fixtures/aside.rs"]
mod aside;

const PICKER_KEYS: &[&str] = &["1b70", "1b5b42", "1b5b41", "1b5b43", "1b5b44", "73"];

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        Self::with(|_| {})
    }
    fn with(setup: impl FnOnce(&Path)) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let home = home::short(&format!("picker-{n}"));
        fs::create_dir_all(home.join("codex-home")).unwrap();
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nunchiro/tests/fixtures");
        fs::copy(fixtures.join("claude-picker"), home.join("claude")).unwrap();
        fs::copy(fixtures.join("codex-picker"), home.join("codex")).unwrap();
        for name in ["claude", "codex"] {
            fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        setup(&home);
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CODEX_HOME", home.join("codex-home"))
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            // Ticket 1100: `<home>-bin`, outside the home, holds a fake the canary may check (it skips fakes inside the home).
            .env(
                "PATH",
                format!("{}-bin:{}:/usr/bin:/bin", home.display(), home.display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(home.join("core.log")).unwrap())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !matches!(core.request(Request::Snapshot), Ok(Reply::Snapshot { .. })) {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn request(&self, r: Request) -> Response {
        call(&self.home, r)
    }
    fn start(
        &self,
        kind: AgentKind,
        model: Option<&str>,
        effort: Option<&str>,
        args: &[&str],
    ) -> Session {
        match self.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind,
                project: self.home.clone(),
                worktree: false,
                label: "picker".into(),
                args: args.iter().map(|a| a.to_string()).collect(),
                model: model.map(Into::into),
                effort: effort.map(Into::into),
                resume: None,
            },
        }) {
            Ok(Reply::Started { session }) => session,
            other => panic!("start failed: {other:?}"),
        }
    }
    fn session(&self, id: &str) -> Option<Session> {
        match self.request(Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id),
            _ => panic!(),
        }
    }
    fn screen(&self, id: &str) -> String {
        match self.request(Request::AgentRead {
            id: id.into(),
            source: "screen".into(),
            lines: 50,
        }) {
            Ok(Reply::Text { text }) => text,
            other => panic!("read failed: {other:?}"),
        }
    }
    fn wait(&self, what: &str, f: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !f() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn prompt(&self, id: &str) {
        self.wait("the prompt", || self.screen(id).contains('❯'));
    }
    /// Every stdin read the fake agent saw, as hex, one entry per read.
    fn reads(&self, id: &str) -> Vec<String> {
        fs::read_to_string(self.home.join(format!("stdin-{id}.log")))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.strip_prefix("READ ").map(str::to_string))
            .collect()
    }
    fn switch_lines(&self) -> Vec<String> {
        fs::read_to_string(self.home.join("core.log"))
            .unwrap()
            .lines()
            .filter(|l| l.starts_with("switch session="))
            .map(str::to_string)
            .collect()
    }
    fn switch(&self, id: &str, model: Option<&str>, effort: Option<&str>) -> Response {
        self.request(Request::SwitchModel {
            id: id.into(),
            model: model.map(Into::into),
            effort: effort.map(Into::into),
            fast: None,
            ultracode: None,
        })
    }
    fn send_status(&self, id: &str, send: &str) -> String {
        let s = self.session(id).unwrap();
        s.send_log
            .iter()
            .find(|r| r.id == send)
            .map(|r| r.status.clone())
            .unwrap_or_default()
    }
    fn settled(&self, id: &str, send: &str) -> String {
        self.wait("the switch to finish", || {
            matches!(self.send_status(id, send).as_str(), "delivered" | "failed")
        });
        self.send_status(id, send)
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.request(Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
        let _ = fs::remove_dir_all(format!("{}-bin", self.home.display()));
    }
}
/// The agent's argv once it is complete: under load `ps` can show "(python3.9)" right after exec, or a line cut short
/// mid-argv, so wait until the line holds `last` (the end of the argv the test launched) and stops changing.
fn args_of(pid: u32, last: &str) -> String {
    let until = Instant::now() + Duration::from_secs(10);
    let mut before = String::new();
    loop {
        let out = Command::new("/bin/ps")
            .args(["-o", "args=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let args = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if (args.ends_with(last) && args == before) || Instant::now() > until {
            return args;
        }
        before = args;
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn picker_launch_args() {
    let core = Core::new();
    let claude = core.start(AgentKind::Claude, Some("haiku"), Some("low"), &[]);
    assert_eq!(
        (claude.model.as_deref(), claude.effort.as_deref()),
        (Some("haiku"), Some("low"))
    );
    let claude_args = args_of(claude.pid.unwrap(), "--effort low");
    assert!(
        claude_args.contains("--model haiku --effort low"),
        "{claude_args}"
    );
    let codex = core.start(AgentKind::Codex, Some("gpt-6-luna"), Some("medium"), &[]);
    let args = args_of(codex.pid.unwrap(), "model_reasoning_effort=\"medium\"");
    assert!(
        args.contains("-m gpt-6-luna -c model_reasoning_effort=\"medium\""),
        "{args}"
    );
    let plain = core.start(AgentKind::Claude, None, None, &[]);
    assert_eq!((plain.model, plain.effort), (None, None));
    assert!(!args_of(plain.pid.unwrap(), "claude").contains("--model"));
    // Ticket 1100: fakes inside the core's home are never checked by the canary.
    assert!(!core.home.join("agent-canary.json").exists());
}

#[test]
fn picker_one_batch_per_click() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("haiku"), None, &[]);
    core.prompt(&s.id);
    // The window's menus never reach the core; nothing has been written to the agent yet.
    thread::sleep(Duration::from_millis(300));
    assert!(core.reads(&s.id).is_empty());
    let Reply::Delivery { send } = core.switch(&s.id, Some("sonnet"), Some("high")).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    assert!(
        core.screen(&s.id)
            .contains("Set model to Sonnet for this session only with high effort")
    );
    let session = core.session(&s.id).unwrap();
    assert_eq!(
        (session.model.as_deref(), session.effort.as_deref()),
        (Some("sonnet"), Some("high"))
    );
    let reads = core.reads(&s.id);
    assert_eq!(
        reads.first().map(String::as_str),
        Some("1b70"),
        "opened by meta+p: {reads:?}"
    );
    assert_eq!(
        reads.iter().filter(|r| *r == "73").count(),
        1,
        "one session-only confirm: {reads:?}"
    );
    assert!(
        reads.iter().all(|r| PICKER_KEYS.contains(&r.as_str())),
        "only picker keys, never /model or Enter: {reads:?}"
    );
    assert_eq!(core.switch_lines().len(), 1, "{:?}", core.switch_lines());
    assert!(core.switch_lines()[0].contains("model=sonnet effort=high result=switched"));
    let rows: Vec<_> = session
        .send_log
        .iter()
        .filter(|r| r.content.starts_with("model picker"))
        .collect();
    assert_eq!(rows.len(), 1);
    // Back to the cheaper model, with Default effort: still one batch, model first.
    let Reply::Delivery { send } = core.switch(&s.id, Some("haiku"), None).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    assert_eq!(core.session(&s.id).unwrap().model.as_deref(), Some("haiku"));
    assert_eq!(core.switch_lines().len(), 2);
}

#[test]
fn picker_waits_for_each_redraw_before_the_next_key() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("haiku"), None, &["--fixture-slow"]);
    core.prompt(&s.id);
    let Reply::Delivery { send } = core.switch(&s.id, Some("sonnet"), Some("high")).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    // Open, leave search, one row up, one effort step right, confirm: no key read a stale frame.
    assert_eq!(
        core.reads(&s.id),
        ["1b70", "1b5b42", "1b5b41", "1b5b43", "73"]
    );
    assert!(core.screen(&s.id).contains("MODEL:Sonnet EFFORT:high"));
}

#[test]
fn picker_owner_keys_wait_while_the_picker_is_open() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("haiku"), None, &["--fixture-slow"]);
    core.prompt(&s.id);
    let Reply::Delivery { send } = core.switch(&s.id, Some("sonnet"), Some("high")).unwrap() else {
        panic!()
    };
    // Enter in Claude's picker would save a default model; raw terminal input waits for the switch.
    let keys = Request::SendKeys {
        id: s.id.clone(),
        keys: vec!["enter".into()],
        seen: vec![],
        composer: false,
    };
    assert_eq!(core.request(keys).unwrap_err(), "model switch in progress");
    let text = Request::SendText {
        id: s.id.clone(),
        text: "x".into(),
        composer: false,
        seen: vec![],
    };
    assert_eq!(core.request(text).unwrap_err(), "model switch in progress");
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    assert!(!core.reads(&s.id).iter().any(|r| r == "0d" || r == "78"));
    // Default effort with the same model leaves Claude's effort, and the session says so.
    let Reply::Delivery { send } = core.switch(&s.id, Some("sonnet"), None).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    assert_eq!(core.session(&s.id).unwrap().effort.as_deref(), Some("high"));
}

#[test]
fn picker_unrecognised_screen_sends_esc_and_reports() {
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("haiku"),
        None,
        &["--fixture-picker=newer"],
    );
    core.prompt(&s.id);
    let Reply::Delivery { send } = core.switch(&s.id, Some("sonnet"), None).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "failed");
    let reads = core.reads(&s.id);
    assert_eq!(
        reads,
        ["1b70", "1b"],
        "open, then Esc, nothing typed: {reads:?}"
    );
    assert_eq!(core.session(&s.id).unwrap().model.as_deref(), Some("haiku"));
    assert!(core.switch_lines()[0].contains("result=failed"));
}

#[test]
fn picker_refuses_text_in_claude_input_box() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, None, None, &[]);
    core.prompt(&s.id);
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "half typed".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    core.wait("the typed text", || {
        core.screen(&s.id).contains("❯ half typed")
    });
    let err = core.switch(&s.id, Some("sonnet"), None).unwrap_err();
    assert!(err.contains("input box"), "{err}");
    assert!(!core.reads(&s.id).iter().any(|r| r.starts_with("1b70")));
    // Claude's own `Try "…"` placeholder is not text.
    let p = core.start(AgentKind::Claude, None, None, &["--fixture-placeholder"]);
    core.wait("the placeholder", || core.screen(&p.id).contains("Try \""));
    let Reply::Delivery { send } = core.switch(&p.id, Some("opus"), None).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&p.id, &send.id), "delivered");
}

#[test]
fn picker_refuses_unknown_model_before_any_byte() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, None, None, &[]);
    core.prompt(&s.id);
    assert_eq!(
        core.switch(&s.id, Some("claude-3-opus\r/model x"), None)
            .unwrap_err(),
        "unknown model"
    );
    assert_eq!(
        core.switch(&s.id, Some("sonnet"), Some("ultra"))
            .unwrap_err(),
        "unknown effort for this model"
    );
    thread::sleep(Duration::from_millis(200));
    assert!(core.reads(&s.id).is_empty());
    assert_eq!(
        core.switch_lines().len(),
        2,
        "each refused click is logged once"
    );
}

#[test]
fn picker_second_click_refused_while_first_runs() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, None, None, &[]);
    core.prompt(&s.id);
    let Reply::Delivery { send } = core.switch(&s.id, Some("sonnet"), None).unwrap() else {
        panic!()
    };
    let err = core.switch(&s.id, Some("opus"), None).unwrap_err();
    assert!(err.contains("already running"), "{err}");
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    assert_eq!(
        core.session(&s.id).unwrap().model.as_deref(),
        Some("sonnet")
    );
    assert_eq!(core.reads(&s.id).iter().filter(|r| *r == "1b70").count(), 1);
}

#[test]
fn picker_shell_has_no_picker() {
    let core = Core::new();
    let s = core.start(AgentKind::Shell, None, None, &["/bin/sh"]);
    assert_eq!(
        core.switch(&s.id, Some("sonnet"), None).unwrap_err(),
        "a shell session has no model picker"
    );
}

#[test]
fn picker_session_token_is_not_granted() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, None, None, &["--fixture-token"]);
    core.prompt(&s.id);
    let token = fs::read_to_string(core.home.join(format!("token-{}", s.id))).unwrap();
    let mut stream = UnixStream::connect(core.home.join("core.sock")).unwrap();
    let request = Request::SwitchModel {
        id: s.id.clone(),
        model: Some("sonnet".into()),
        effort: None,
        fast: None,
        ultracode: None,
    };
    let mut line = serde_json::to_vec(&Envelope { token, request }).unwrap();
    line.push(b'\n');
    stream.write_all(&line).unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).unwrap();
    let reply: Response = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply.unwrap_err(), "operation not granted");
    assert!(core.reads(&s.id).is_empty());
}

fn codex(core: &Core) -> Session {
    let s = core.start(AgentKind::Codex, Some("gpt-6-luna"), Some("medium"), &[]);
    core.wait("the Codex conversation id", || {
        core.session(&s.id).unwrap().agent_session_id.is_some()
    });
    // v1a-24: a switch is refused until the core sees Codex's input box.
    core.wait("the Codex input box", || {
        core.screen(&s.id).contains("gpt-fixture")
    });
    core.session(&s.id).unwrap()
}

// Ticket 358: a Codex switch restarts the agent, so a command that no longer verifies is refused before the agent stops.
#[test]
fn picker_codex_switch_with_a_tampered_command_leaves_the_agent_running() {
    let core = Core::new();
    let agent = AgentKind::Codex;
    let path = core.home.join("codex").display().to_string();
    let Reply::CommandCheck { check } = core
        .request(Request::AgentCommandCheck {
            agent,
            path,
            args: vec![],
            env: vec![],
        })
        .unwrap()
    else {
        panic!("not a check");
    };
    let hash = check.hash.unwrap_or_else(|| panic!("{:?}", check.error));
    core.request(Request::AgentCommandGrant { agent, hash })
        .unwrap();
    let old = codex(&core);

    let stored = core.home.join("agent-commands/codex.json");
    let text = fs::read_to_string(&stored).unwrap();
    fs::write(
        &stored,
        text.replace("\"args\": []", "\"args\": [\"--evil\"]"),
    )
    .unwrap();
    let refused = core
        .switch(&old.id, Some("gpt-5.6-luna"), Some("low"))
        .unwrap_err();
    assert!(refused.contains("changed since"), "{refused}");
    assert_eq!(core.session(&old.id).unwrap().state, SessionState::Running);

    fs::write(&stored, text).unwrap();
    assert!(matches!(
        core.switch(&old.id, Some("gpt-5.6-luna"), Some("low")),
        Ok(Reply::Started { .. })
    ));
}

#[test]
fn picker_codex_restarts_into_the_same_conversation() {
    let core = Core::new();
    let old = codex(&core);
    let Reply::Started { session } = core
        .switch(&old.id, Some("gpt-5.6-luna"), Some("low"))
        .unwrap()
    else {
        panic!()
    };
    assert_ne!(session.id, old.id);
    assert_eq!(session.agent_session_id, old.agent_session_id);
    assert_eq!(
        (session.model.as_deref(), session.effort.as_deref()),
        (Some("gpt-5.6-luna"), Some("low"))
    );
    assert_eq!(session.label, old.label);
    let args = args_of(session.pid.unwrap(), "model_reasoning_effort=\"low\"");
    assert!(
        args.contains("resume FAKE-CODEX-123 -m gpt-5.6-luna -c model_reasoning_effort=\"low\""),
        "{args}"
    );
    assert!(
        core.session(&old.id).is_none(),
        "the resumed session replaces the old one"
    );
    assert!(
        core.switch_lines()[0]
            .contains("agent=codex model=gpt-5.6-luna effort=low result=restarted")
    );
    // A restart that cannot spawn says the agent stopped, rather than looking unchanged. (The fixture is a
    // script: let the running one load before its file goes.)
    core.wait("the restarted Codex", || {
        core.screen(&session.id).contains('\u{203a}')
    });
    fs::remove_file(core.home.join("codex")).unwrap();
    let err = core
        .switch(&session.id, Some("gpt-6-luna"), None)
        .unwrap_err();
    assert!(err.contains("Codex stopped and did not restart"), "{err}");
}

#[test]
fn picker_codex_refused_while_working_or_waiting() {
    let core = Core::new();
    let s = codex(&core);
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "UserPromptSubmit".into(),
        payload: serde_json::json!({}),
    })
    .unwrap();
    let err = core.switch(&s.id, Some("gpt-5.6-luna"), None).unwrap_err();
    assert!(err.contains("working"), "{err}");
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "Stop".into(),
        payload: serde_json::json!({}),
    })
    .unwrap();
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "PermissionRequest".into(),
        payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"true"}}),
    })
    .unwrap();
    let err = core.switch(&s.id, Some("gpt-5.6-luna"), None).unwrap_err();
    assert!(err.contains("waiting decision"), "{err}");
    let now = core.session(&s.id).unwrap();
    assert_eq!(now.pid, s.pid, "no restart");
}

#[test]
fn picker_store_without_model_fields_loads() {
    let main_store = |home: &Path| {
        let project = home.display();
        fs::write(
            home.join("sessions.json"),
            format!(r#"{{"version":1,"sessions":[{{"id":"old-1","kind":"claude","project":"{project}","cwd":"{project}","label":"from main","state":"running","agent_session_id":"conv-1","agent_version":"2.1.310","untested":false,"pid":42}}]}}"#),
        )
        .unwrap();
    };
    let core = Core::with(main_store);
    let s = core.session("old-1").unwrap();
    assert_eq!(
        (s.state, s.model, s.effort),
        (SessionState::Resumable, None, None)
    );
}

// v1b-40: an older core no longer refuses a newer store; it keeps the bytes aside and starts empty.
#[test]
fn picker_newer_store_version_is_set_aside() {
    // V2-1a: this core reads 1, 2 and 3 (ticket 752 round 2), so 4 is the newer core's.
    let bytes = br#"{"version":4,"sessions":[],"model_defaults":{"claude":"sonnet"}}"#;
    let core = Core::with(|home| fs::write(home.join("sessions.json"), bytes).unwrap());
    match core.request(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => assert!(sessions.is_empty()),
        _ => panic!(),
    }
    let kept = aside::asides(&core.home);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].1, bytes);
    assert_ne!(
        fs::read(core.home.join("sessions.json")).ok().as_deref(),
        Some(&bytes[..])
    );
    assert!(
        fs::read_to_string(core.home.join("core.log"))
            .unwrap()
            .contains(".aside")
    );
}

/// One request with a session's own token (what an agent's CLI sends).
fn as_session(core: &Core, id: &str, request: Request) -> Response {
    let token = fs::read_to_string(core.home.join(format!("token-{id}"))).unwrap();
    let mut stream = UnixStream::connect(core.home.join("core.sock")).unwrap();
    let mut line = serde_json::to_vec(&Envelope { token, request }).unwrap();
    line.push(b'\n');
    stream.write_all(&line).unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).unwrap();
    serde_json::from_str(&reply).unwrap()
}

#[test]
fn picker_codex_refuses_a_draft_in_its_input_box() {
    let core = Core::new();
    let s = codex(&core);
    core.wait("the Codex composer", || {
        core.screen(&s.id).contains('\u{203a}')
    });
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "half a thought".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    core.wait("the draft", || {
        core.screen(&s.id).contains("\u{203a} half a thought")
    });
    let err = core.switch(&s.id, Some("gpt-5.6-luna"), None).unwrap_err();
    assert!(err.contains("input box"), "{err}");
    assert_eq!(
        core.session(&s.id).unwrap().pid,
        s.pid,
        "no restart: the draft lives"
    );
    // Codex's own placeholder is not a draft (the fixture reuses one conversation id: close the first).
    core.request(Request::Close { id: s.id.clone() }).unwrap();
    fs::write(core.home.join("codex-placeholder"), "").unwrap();
    let p = codex(&core);
    core.wait("the placeholder", || {
        core.screen(&p.id).contains("Ask Codex to do anything")
    });
    let reply = core.switch(&p.id, Some("gpt-5.6-luna"), None);
    assert!(matches!(reply, Ok(Reply::Started { .. })), "{reply:?}");
}

#[test]
fn picker_codex_refuses_when_its_input_box_is_not_found() {
    // v1a-24: a `›` row without Codex's footer is not a box the core knows; a draft there must not be lost.
    let core = Core::new();
    fs::write(core.home.join("codex-no-footer"), "").unwrap();
    let s = core.start(AgentKind::Codex, Some("gpt-6-luna"), Some("medium"), &[]);
    core.wait("the Codex row", || {
        core.screen(&s.id).contains("READY\n\u{203a}")
    });
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "half a thought".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    core.wait("the draft", || {
        core.screen(&s.id).contains("\u{203a} half a thought")
    });
    let err = core.switch(&s.id, Some("gpt-5.6-luna"), None).unwrap_err();
    assert!(err.contains("input box is not on the screen"), "{err}");
    assert_eq!(core.session(&s.id).unwrap().pid, s.pid, "no restart");
}

#[test]
fn picker_codex_restart_keeps_args_and_worktree() {
    let core = Core::new();
    let repo = core.home.join("repo");
    fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = home::git_env::scrubbed("/usr/bin/git")
            .arg("-C")
            .arg(&repo)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "base"]);
    let Reply::Started { session: old } = core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: repo.clone(),
                worktree: true,
                label: "wt".into(),
                args: vec![
                    "-s".into(),
                    "read-only".into(),
                    "-c".into(),
                    "fixture_marker=1".into(),
                ],
                model: Some("gpt-6-luna".into()),
                effort: None,
                resume: None,
            },
        })
        .unwrap()
    else {
        panic!()
    };
    assert_ne!(old.cwd, old.project, "runs in its worktree");
    core.wait("the Codex conversation id", || {
        core.session(&old.id).unwrap().agent_session_id.is_some()
    });
    let Reply::Started { session } = core.switch(&old.id, Some("gpt-5.6-luna"), None).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        session.cwd, old.cwd,
        "the restart keeps the worktree the session owns"
    );
    assert!(
        old.start_commit.is_some(),
        "v1b-11 records the start commit"
    );
    assert_eq!(
        session.start_commit, old.start_commit,
        "the Diff base survives the restart"
    );
    let args = args_of(session.pid.unwrap(), "fixture_marker=1");
    assert!(
        args.contains("-m gpt-5.6-luna") && args.contains("-s read-only -c fixture_marker=1"),
        "{args}"
    );
    // Still that worktree's running session: removing the worktree is refused.
    let remove = core.request(Request::Worktree {
        operation: "remove".into(),
        project: Some(repo.clone()),
        path: Some(old.cwd.clone()),
        branch: None,
        base: String::new(),
        label: String::new(),
        from: None,
        confirm: None,
    });
    assert!(remove.is_err(), "{remove:?}");
}

#[test]
fn picker_launch_refuses_flag_shaped_or_unlisted_models() {
    let core = Core::new();
    let start = |model: &str| Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: core.home.clone(),
            worktree: false,
            label: "x".into(),
            args: vec![],
            model: Some(model.into()),
            effort: None,
            resume: None,
        },
    };
    // Nobody can turn a model name into a flag.
    assert_eq!(
        core.request(start("--dangerously-skip-permissions"))
            .unwrap_err(),
        "invalid model or effort"
    );
    assert!(
        core.request(start("claude-opus-4-1")).is_ok(),
        "the owner may name any model id"
    );
    // A session token gets the window's catalog only.
    let parent = core.start(AgentKind::Claude, None, None, &["--fixture-token"]);
    core.prompt(&parent.id);
    let refused = as_session(&core, &parent.id, start("--dangerously-skip-permissions"));
    assert_eq!(refused.unwrap_err(), "unknown model");
    assert_eq!(
        as_session(&core, &parent.id, start("claude-opus-4-1")).unwrap_err(),
        "unknown model"
    );
    assert!(as_session(&core, &parent.id, start("sonnet")).is_ok());
}

fn codex_with_args(core: &Core, args: &[&str]) -> Session {
    let Reply::Started { session } = core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: core.home.clone(),
                worktree: false,
                label: "args".into(),
                args: args.iter().map(|a| a.to_string()).collect(),
                model: None,
                effort: None,
                resume: None,
            },
        })
        .unwrap()
    else {
        panic!()
    };
    core.wait("the Codex conversation id", || {
        core.session(&session.id)
            .unwrap()
            .agent_session_id
            .is_some()
    });
    session
}

#[test]
fn picker_codex_carries_only_listed_launch_args() {
    let refused: &[&[&str]] = &[
        &["--", "fix the bug"],
        &["--full-auto", "fix the bug"],
        &["fix the bug"],
        &["-s", "read-only", "fix the bug"],
        &["-m", "gpt-6-luna"],
        &["-mo3"],
        &["--model", "o3"],
        &["--model=o3"],
        &["-c", "model=\"o3\""],
        &["-c", "model_reasoning_effort=\"low\""],
        &["--config", "model=\"o3\""],
        &["--config=model_reasoning_effort=\"low\""],
        &["-s", "everything"],
        &["--some-new-flag"],
        &["-c", " model=x"],
        &["-c", "\"model\"=\"o3\""],
        &["-c", "profile=fast"],
        &["-c", "foo"],
        &["-p", "fast"],
        &["--profile", "fast"],
        &["-s"],
    ];
    for args in refused {
        let core = Core::new();
        let s = codex_with_args(&core, args);
        let err = core
            .switch(&s.id, Some("gpt-5.6-luna"), Some("low"))
            .unwrap_err();
        assert!(err.contains("launch arguments"), "{args:?}: {err}");
        assert_eq!(
            core.session(&s.id).unwrap().pid,
            s.pid,
            "{args:?}: not stopped"
        );
    }
    let core = Core::new();
    let s = codex_with_args(&core, &["-s", "read-only", "--search", "-a", "on-request"]);
    let Reply::Started { session } = core.switch(&s.id, Some("gpt-5.6-luna"), None).unwrap() else {
        panic!()
    };
    let args = args_of(session.pid.unwrap(), "on-request");
    assert!(
        args.contains("-s read-only --search -a on-request"),
        "{args}"
    );
}

#[test]
fn picker_codex_refuses_when_launch_args_are_unknown() {
    let core = Core::new();
    let first = codex(&core);
    core.request(Request::Close {
        id: first.id.clone(),
    })
    .unwrap();
    // A resume (the window's resume offer) does not know what the conversation was first launched with.
    let Reply::Started { session } = core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: core.home.clone(),
                worktree: false,
                label: "resumed".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: first.agent_session_id.clone(),
            },
        })
        .unwrap()
    else {
        panic!()
    };
    core.wait("the Codex input box", || {
        core.screen(&session.id).contains("gpt-fixture")
    }); // v1a-24
    let err = core
        .switch(&session.id, Some("gpt-5.6-luna"), None)
        .unwrap_err();
    assert!(err.contains("launch arguments are not known"), "{err}");
    assert_eq!(core.session(&session.id).unwrap().pid, session.pid);
}

#[test]
fn picker_codex_restored_from_disk_has_unknown_launch_args() {
    let first = Core::new();
    let s = codex_with_args(&first, &["-s", "read-only"]);
    // A second core on a fresh home loads the session from disk, as after a core restart.
    let store = fs::read(first.home.join("sessions.json")).unwrap();
    drop(first);
    let second = Core::with(|h| fs::write(h.join("sessions.json"), &store).unwrap());
    let restored = second.session(&s.id).unwrap();
    assert_eq!(restored.state, SessionState::Resumable);
    // Resumed from the window's offer, the conversation's first launch args (`-s read-only`) are gone.
    let Reply::Started { session } = second
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                // The first core's home (its project) is gone with it.
                project: second.home.clone(),
                worktree: false,
                label: "restored".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: restored.agent_session_id.clone(),
            },
        })
        .unwrap()
    else {
        panic!()
    };
    second.wait("the Codex input box", || {
        second.screen(&session.id).contains("gpt-fixture")
    }); // v1a-24
    let err = second
        .switch(&session.id, Some("gpt-5.6-luna"), None)
        .unwrap_err();
    assert!(err.contains("launch arguments are not known"), "{err}");
    assert_eq!(second.session(&session.id).unwrap().pid, session.pid);
}

/// W35 picker: the `--settings` file a fake Claude was started with, as JSON (`{}` when it got none).
fn start_settings(core: &Core, id: &str) -> serde_json::Value {
    let path = core.home.join(format!("stdin-{id}.log"));
    core.wait("the launch line", || {
        fs::read_to_string(&path).is_ok_and(|l| l.contains("LAUNCH "))
    });
    let args: Vec<String> = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix("LAUNCH "))
        .map(|l| serde_json::from_str(l).unwrap())
        .unwrap();
    args.iter()
        .position(|a| a == "--settings")
        .map(|i| serde_json::from_slice(&fs::read(&args[i + 1]).unwrap()).unwrap())
        .unwrap_or(serde_json::json!({}))
}
/// One finished turn as Claude's hooks report it (fast mode waits for the first reply).
fn finished_turn(core: &Core, id: &str) {
    for event in ["UserPromptSubmit", "Stop"] {
        call(
            &core.home,
            Request::Hook {
                id: id.into(),
                event: event.into(),
                payload: serde_json::json!({}),
            },
        )
        .unwrap();
    }
    core.wait("the finished turn", || {
        core.session(id).is_some_and(|s| s.completion_seq > 0)
    });
}
/// A mode toggle; a fast one after a first reply, as the window allows it (`fast_raw` sends it as it is).
fn toggle(core: &Core, id: &str, fast: Option<bool>, ultracode: Option<bool>) -> Response {
    if fast.is_some() && core.session(id).is_some_and(|s| s.completion_seq == 0) {
        finished_turn(core, id);
    }
    fast_raw(core, id, fast, ultracode)
}
fn fast_raw(core: &Core, id: &str, fast: Option<bool>, ultracode: Option<bool>) -> Response {
    core.request(Request::SwitchModel {
        id: id.into(),
        model: None,
        effort: None,
        fast,
        ultracode,
    })
}

/// Ticket 1010: the fake Claude draws 2.1.330's own notices under its box (a pause dims its ↯, a refusal turns fast mode
/// off, `claude_modes.rs` has the source); the session's modes follow each.
#[test]
fn picker_fast_pause_and_refusal_follow_claudes_footer() {
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        Some("high"),
        &["--fixture-footer"],
    );
    core.prompt(&s.id);
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    let modes = || {
        core.session(&session.id)
            .and_then(|s| s.modes)
            .unwrap_or_default()
    };
    let say = |notice: &str| {
        fs::write(core.home.join(format!("fast-{}", session.id)), notice).unwrap();
    };
    core.prompt(&session.id);
    core.wait("the ↯ read", || modes().fast == Some(true));
    assert_eq!((modes().fast_cooldown, modes().fast_note), (None, None));

    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    say("Fast limit reached, fast mode paused · resets in 4m 30s");
    core.wait("the pause", || {
        modes().fast_cooldown.is_some_and(|c| c.until.is_some())
    });
    let paused = modes();
    assert_eq!(paused.fast, Some(true), "paused is still on: {paused:?}");
    let cooldown = paused.fast_cooldown.unwrap();
    assert_eq!(
        cooldown.text.as_deref(),
        Some("Fast limit reached, fast mode paused")
    );
    let until = cooldown.until.unwrap();
    assert!(
        (before + 270..=before + 285).contains(&until),
        "4m 30s from the notice: {} s",
        until - before
    );

    say("Fast limit reset · now using fast mode");
    core.wait("the pause over", || modes().fast_cooldown.is_none());
    assert_eq!(modes().fast, Some(true));

    // A notice this build cannot read: Claude's faint ↯ alone says the pause, with no end.
    say("Fast mode is busy right now · resets in a while");
    core.wait("the faint ↯", || modes().fast_cooldown.is_some());
    assert_eq!(modes().fast_cooldown, Some(Default::default()));
    assert_eq!(modes().fast, Some(true));

    say("Fast mode disabled · Out of usage credits");
    core.wait("the refusal", || modes().fast == Some(false));
    assert_eq!(
        modes().fast_note.as_deref(),
        Some("Fast mode disabled · Out of usage credits")
    );
    // On again by a restart: Claude is asked again, so its last sentence goes.
    fs::remove_file(core.home.join(format!("fast-{}", session.id))).unwrap();
    let Reply::Started { session: again } = toggle(&core, &session.id, Some(true), None).unwrap()
    else {
        panic!()
    };
    assert_eq!(again.modes.unwrap_or_default().fast_note, None);
}

#[test]
fn picker_fast_restarts_with_the_keys_in_its_own_settings_only() {
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        Some("high"),
        &["--fixture-footer"],
    );
    core.prompt(&s.id);
    assert!(start_settings(&core, &s.id).get("fastMode").is_none());
    // Fast mode never types Claude's `/fast` (it saves the user's default): it resumes the conversation.
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    assert!(
        core.reads(&s.id).is_empty(),
        "nothing typed: {:?}",
        core.reads(&s.id)
    );
    let settings = start_settings(&core, &session.id);
    assert_eq!(settings["fastMode"], true, "{settings}");
    assert_eq!(settings["fastModePerSessionOptIn"], true, "{settings}");
    assert_eq!(
        session.agent_session_id, s.agent_session_id,
        "the same conversation"
    );
    assert_eq!(
        (session.model.as_deref(), session.effort.as_deref()),
        (Some("opus"), Some("high"))
    );
    core.prompt(&session.id);
    core.wait("the ↯ read", || {
        core.session(&session.id)
            .and_then(|s| s.modes)
            .and_then(|m| m.fast)
            == Some(true)
    });
    // Another session starts without them.
    let other = core.start(AgentKind::Claude, Some("opus"), None, &[]);
    assert!(start_settings(&core, &other.id).get("fastMode").is_none());
    core.prompt(&other.id);
    core.wait("no ↯", || {
        core.session(&other.id)
            .and_then(|s| s.modes)
            .and_then(|m| m.fast)
            == Some(false)
    });
    // Off again: `fastMode: false` overrides a saved default for this run only.
    let Reply::Started { session: off } = toggle(&core, &session.id, Some(false), None).unwrap()
    else {
        panic!()
    };
    assert_eq!(start_settings(&core, &off.id)["fastMode"], false);
    // Not on Sonnet: Claude's own /fast would move it to Opus silently.
    let sonnet = core.start(AgentKind::Claude, Some("sonnet"), None, &[]);
    core.prompt(&sonnet.id);
    let err = toggle(&core, &sonnet.id, Some(true), None).unwrap_err();
    assert!(err.contains("Opus 5.5 or Fable 5.2"), "{err}");
}

#[test]
fn picker_ultracode_types_one_effort_command() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("opus"), None, &["--fixture-footer"]);
    core.prompt(&s.id);
    // Ticket 1018: known from the start, as Claude's settings start it (none here sets it: off).
    assert_eq!(
        core.session(&s.id).unwrap().modes.and_then(|m| m.ultracode),
        Some(false)
    );
    let Reply::Delivery { send } = toggle(&core, &s.id, None, Some(true)).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    core.wait("the submit", || {
        core.screen(&s.id).contains("SUBMIT:/effort ultracode on")
    });
    // Known from Claude's own answer ("Ultracode on (this session only)"), not from the send.
    core.wait("Claude's answer read", || {
        core.session(&s.id)
            .and_then(|s| s.modes)
            .and_then(|m| m.ultracode)
            == Some(true)
    });
    // A fast restart carries it into the new run's settings.
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    assert_eq!(start_settings(&core, &session.id)["ultracode"], true);
    assert_eq!(session.modes.and_then(|m| m.ultracode), Some(true));
    // Refused like a switch while text is in the box.
    core.prompt(&session.id);
    core.request(Request::SendText {
        id: session.id.clone(),
        text: "draft".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    core.wait("the draft", || core.screen(&session.id).contains("❯ draft"));
    let err = toggle(&core, &session.id, None, Some(false)).unwrap_err();
    assert!(err.contains("input box"), "{err}");
}

/// The fake agent's launch arguments, from its log.
fn launch_args(core: &Core, id: &str) -> Vec<String> {
    let path = core.home.join(format!("stdin-{id}.log"));
    core.wait("the launch line", || {
        fs::read_to_string(&path).is_ok_and(|l| l.contains("LAUNCH "))
    });
    let log = fs::read_to_string(&path).unwrap();
    serde_json::from_str(log.lines().find_map(|l| l.strip_prefix("LAUNCH ")).unwrap()).unwrap()
}

#[test]
fn picker_fast_restart_keeps_a_reviewer_seats_restrictions() {
    // Codex security MUST (w35 round 3): a seat started without the edit tools (ledger.rs, a role that does not write)
    // comes back with them off, and with the same permission arguments.
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &[
            "--disallowedTools",
            "Edit,Write,MultiEdit,NotebookEdit",
            "--fixture-footer",
        ],
    );
    core.prompt(&s.id);
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    let (old, new) = (launch_args(&core, &s.id), launch_args(&core, &session.id));
    let at = new
        .iter()
        .position(|a| a == "--disallowedTools")
        .expect("restrictions kept");
    assert_eq!(new[at + 1], "Edit,Write,MultiEdit,NotebookEdit");
    // Everything the first launch had, but its own session id and settings file, is in the restart's.
    let own = |args: &[String]| -> Vec<String> {
        let ours = |a: &String| ["--session-id", "--settings", "--add-dir"].contains(&a.as_str());
        (0..args.len())
            .filter(|&i| !ours(&args[i]) && !(i > 0 && ours(&args[i - 1])))
            .map(|i| args[i].clone())
            .collect()
    };
    for arg in own(&old) {
        assert!(new.contains(&arg), "{arg} lost: {old:?} -> {new:?}");
    }
    // And again from the restarted run: its launch is known.
    assert!(matches!(
        toggle(&core, &session.id, Some(false), None),
        Ok(Reply::Started { .. })
    ));
}

#[test]
fn picker_fast_refused_before_stopping_when_the_restart_cannot_be_prepared() {
    let core = Core::new();
    let agent = AgentKind::Claude;
    let path = core.home.join("claude").display().to_string();
    let Reply::CommandCheck { check } = core
        .request(Request::AgentCommandCheck {
            agent,
            path,
            args: vec![],
            env: vec![],
        })
        .unwrap()
    else {
        panic!("not a check");
    };
    let hash = check.hash.unwrap_or_else(|| panic!("{:?}", check.error));
    core.request(Request::AgentCommandGrant { agent, hash })
        .unwrap();
    let s = core.start(AgentKind::Claude, Some("opus"), None, &[]);
    core.prompt(&s.id);
    let stored = core.home.join("agent-commands/claude.json");
    let text = fs::read_to_string(&stored).unwrap();
    fs::write(
        &stored,
        text.replace("\"args\": []", "\"args\": [\"--evil\"]"),
    )
    .unwrap();
    let refused = toggle(&core, &s.id, Some(true), None).unwrap_err();
    assert!(refused.contains("changed since"), "{refused}");
    let still = core.session(&s.id).unwrap();
    assert_eq!(
        (still.state, still.pid),
        (SessionState::Running, s.pid),
        "the run was not stopped"
    );
    assert!(core.reads(&s.id).is_empty(), "nothing typed");
}

#[test]
fn picker_fast_waits_for_the_first_reply_then_resumes() {
    // Codex round-6 MUST: before Claude's first finished turn there is no conversation on disk to resume (the fixture
    // exits as Claude does with `--fixture-strict-resume`), and a fresh start would leave the row's seat behind: refused.
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--fixture-strict-resume", "--fixture-footer"],
    );
    core.prompt(&s.id);
    let refused = fast_raw(&core, &s.id, Some(true), None).unwrap_err();
    assert!(refused.contains("after Claude's first reply"), "{refused}");
    assert_eq!(core.session(&s.id).unwrap().state, SessionState::Running);
    // One finished turn later the conversation is on disk: the toggle resumes it.
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "hi".into(),
        seen: vec![],
        composer: false,
    })
    .unwrap();
    core.wait("typed", || core.screen(&s.id).contains("❯ hi"));
    core.request(Request::SendKeys {
        id: s.id.clone(),
        keys: vec!["enter".into()],
        seen: vec![],
        composer: false,
    })
    .unwrap();
    core.wait("the submit", || core.screen(&s.id).contains("SUBMIT:hi"));
    finished_turn(&core, &s.id);
    let Reply::Started { session } = fast_raw(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    let args = launch_args(&core, &session.id);
    let at = args.iter().position(|a| a == "--resume").expect("resumed");
    assert_eq!(Some(&args[at + 1]), s.agent_session_id.as_ref());
    assert_eq!(start_settings(&core, &session.id)["fastMode"], true);
    core.prompt(&session.id); // the resume found its conversation
}

#[test]
fn picker_ultracode_refused_by_claude_never_reads_on() {
    // Fable review SHOULD 1: Claude 2.1.329 refuses without dynamic workflows; the toggle keeps "not read yet" and
    // carries Claude's sentence.
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--fixture-no-workflows"],
    );
    core.prompt(&s.id);
    let Reply::Delivery { send } = toggle(&core, &s.id, None, Some(true)).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    core.wait("the refusal read", || {
        core.session(&s.id)
            .and_then(|s| s.modes)
            .and_then(|m| m.note)
            .is_some_and(|n| n.starts_with("Ultracode needs dynamic workflows"))
    });
    assert_eq!(
        core.session(&s.id).unwrap().modes.and_then(|m| m.ultracode),
        Some(false) // ticket 1018: as it started, never on
    );
}

#[test]
fn picker_fast_restart_keeps_the_mode_the_session_is_in() {
    // Fable re-review MUST: a session started wide and moved to plan comes back in plan. (The stored Full access of an
    // owner start is the same rule through `claude_resume_args`: claude_modes.rs unit test.)
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--dangerously-skip-permissions"],
    );
    core.prompt(&s.id);
    let first = launch_args(&core, &s.id);
    assert!(
        first.iter().any(|a| a == "--dangerously-skip-permissions"),
        "started wide: {first:?}"
    );
    fs::write(core.home.join(format!("mode-{}", s.id)), "plan").unwrap();
    core.request(Request::Resize {
        id: s.id.clone(),
        cols: 150,
        rows: 40,
    })
    .unwrap(); // a redraw shows the footer
    core.wait("the footer read", || {
        core.session(&s.id)
            .and_then(|s| s.permission_mode)
            .as_deref()
            == Some("plan")
    });
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    let args = launch_args(&core, &session.id);
    let at = args
        .iter()
        .position(|a| a == "--permission-mode")
        .expect("a mode");
    assert_eq!(args[at + 1], "plan", "{args:?}");
    assert!(
        !args.iter().any(|a| a == "--dangerously-skip-permissions"),
        "never started in Skip: {args:?}"
    );
}

#[test]
fn picker_fast_refuses_a_launch_prompt_before_stopping() {
    // Fable re-review SHOULD a: `claude ... "do the task"` would submit the task again on every restart.
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("opus"), None, &["do the task"]);
    core.prompt(&s.id);
    let refused = toggle(&core, &s.id, Some(true), None).unwrap_err();
    assert!(refused.contains("prompt in its arguments"), "{refused}");
    assert_eq!(core.session(&s.id).unwrap().state, SessionState::Running);
}

#[test]
fn picker_fast_works_on_a_resumed_session_and_keeps_its_launch() {
    // Fable re-review SHOULD c: the owner's sessions are often resumed; the resumed run's own arguments are kept.
    let core = Core::new();
    let seat = [
        "--disallowedTools",
        "Edit,Write,MultiEdit,NotebookEdit",
        "--fixture-strict-resume",
        "--fixture-footer",
    ];
    let s = core.start(AgentKind::Claude, Some("opus"), None, &seat);
    core.prompt(&s.id);
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "hi".into(),
        seen: vec![],
        composer: false,
    })
    .unwrap();
    core.wait("typed", || core.screen(&s.id).contains("❯ hi"));
    core.request(Request::SendKeys {
        id: s.id.clone(),
        keys: vec!["enter".into()],
        seen: vec![],
        composer: false,
    })
    .unwrap();
    core.wait("the submit", || core.screen(&s.id).contains("SUBMIT:hi"));
    for event in ["UserPromptSubmit", "Stop"] {
        call(
            &core.home,
            Request::Hook {
                id: s.id.clone(),
                event: event.into(),
                payload: serde_json::json!({}),
            },
        )
        .unwrap();
    }
    core.wait("the finished turn", || {
        core.session(&s.id).is_some_and(|s| s.completion_seq > 0)
    });
    core.request(Request::Close { id: s.id.clone() }).unwrap();
    let Ok(Reply::Started { session: resumed }) = core.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: core.home.clone(),
            worktree: false,
            label: "picker".into(),
            args: seat.iter().map(|a| a.to_string()).collect(),
            model: Some("opus".into()),
            effort: None,
            resume: s.agent_session_id.clone(),
        },
    }) else {
        panic!("no resume")
    };
    core.prompt(&resumed.id);
    let Reply::Started { session } = toggle(&core, &resumed.id, Some(true), None).unwrap() else {
        panic!()
    };
    let args = launch_args(&core, &session.id);
    assert!(
        args.windows(2)
            .any(|w| w[0] == "--disallowedTools" && w[1] == "Edit,Write,MultiEdit,NotebookEdit"),
        "{args:?}"
    );
    let at = args.iter().position(|a| a == "--resume").expect("resumed");
    assert_eq!(Some(&args[at + 1]), s.agent_session_id.as_ref());
    core.prompt(&session.id);
}

#[test]
fn picker_fast_refuses_a_start_with_env() {
    // Fable review3 MUST 2, round 5: an --env start keeps no launch record (its values are never stored), so a restart
    // could not repeat it: refused, the run untouched.
    let core = Core::new();
    let Ok(Reply::Started { session: s }) = core.request(Request::Start {
        receipt: None,
        env: [("CLAUDE_CODE_EXPERIMENTAL_W35".to_string(), "1".to_string())].into(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: core.home.clone(),
            worktree: false,
            label: "picker".into(),
            args: ["--disallowedTools", "Edit,Write", "--fixture-footer"]
                .map(String::from)
                .to_vec(),
            model: Some("opus".into()),
            effort: None,
            resume: None,
        },
    }) else {
        panic!("no start")
    };
    core.prompt(&s.id);
    let refused = toggle(&core, &s.id, Some(true), None).unwrap_err();
    assert!(refused.contains("not on record"), "{refused}");
    let still = core.session(&s.id).unwrap();
    assert_eq!((still.state, still.pid), (SessionState::Running, s.pid));
}

#[test]
fn picker_fast_restart_keeps_every_restricting_flag_family() {
    // Round 5 item 3: tools, settings, folders, MCP servers and a role's prompt and agent survive a fast restart.
    let core = Core::new();
    let settings = core.home.join("user-settings.json");
    fs::write(&settings, "{}").unwrap();
    let settings = settings.display().to_string();
    let families: [&[&str]; 7] = [
        &["--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit"],
        &["--allowedTools", "Read"],
        &["--settings", &settings],
        &["--add-dir", "/tmp"],
        &["--mcp-config", "{\"mcpServers\":{}}"],
        &["--append-system-prompt", "review only"],
        &["--agent", "reviewer"],
    ];
    let mut args: Vec<&str> = families.concat();
    args.push("--fixture-footer");
    let s = core.start(AgentKind::Claude, Some("opus"), None, &args);
    core.prompt(&s.id);
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    let new = launch_args(&core, &session.id);
    for family in families {
        assert!(
            new.windows(2).any(|w| w == family),
            "{family:?} lost: {new:?}"
        );
    }
}

#[test]
fn picker_launch_record_stays_in_the_core() {
    // Fable review3 SHOULD 2, round 5 item 4: the launch arguments never reach a client that lists sessions. Round 7
    // (allow list): a Claude record of safe flags is stored beside the row; a prompt text is not; a Codex record never.
    let core = Core::new();
    let safe = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--disallowedTools", "Edit,W35Tool"],
    );
    let prompt = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--append-system-prompt", "w35-secret-ish"],
    );
    let codex = core.start(AgentKind::Codex, None, None, &["-c", "w35_codex_key=1"]);
    core.prompt(&safe.id);
    core.prompt(&prompt.id);
    for request in [
        Request::Snapshot,
        Request::List,
        Request::AgentGet {
            id: safe.id.clone(),
        },
    ] {
        let wire = serde_json::to_string(&core.request(request).unwrap()).unwrap();
        assert!(
            !wire.contains("W35Tool")
                && !wire.contains("w35-secret-ish")
                && !wire.contains("launch_args"),
            "{wire}"
        );
    }
    let stored = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    assert!(
        stored.contains("W35Tool"),
        "the safe record is kept: {stored}"
    );
    assert!(
        !stored.contains("w35-secret-ish") && !stored.contains("w35_codex_key"),
        "{stored}"
    );
    let _ = codex;
}

#[test]
fn picker_fast_restart_is_never_wider_than_the_mode_it_is_in() {
    // Round 5 item 5: every launch shape Fable's review3 listed. The new line holds no skip flag and exactly one
    // `--permission-mode`, the session's current mode, whatever the old arguments or the approved command said.
    let core = Core::new();
    // Shape (a): the approved command carries a skip flag.
    let path = core.home.join("claude").display().to_string();
    let Reply::CommandCheck { check } = core
        .request(Request::AgentCommandCheck {
            agent: AgentKind::Claude,
            path,
            args: vec!["--dangerously-skip-permissions".into()],
            env: vec![],
        })
        .unwrap()
    else {
        panic!("not a check");
    };
    let hash = check.hash.unwrap_or_else(|| panic!("{:?}", check.error));
    core.request(Request::AgentCommandGrant {
        agent: AgentKind::Claude,
        hash,
    })
    .unwrap();
    let shapes: [(&[&str], &str, &str); 6] = [
        (&[], "plan", "plan"), // (a) approved skip, moved to plan
        (&["--dangerously-skip-permissions"], "plan", "plan"), // a skip flag in its own arguments
        (&["--permission-mode=acceptEdits"], "manual", "manual"), // (b) the = form
        (
            &["--permission-mode", "bypassPermissions"],
            "accept edits",
            "acceptEdits",
        ), // (c) a wide named mode
        (
            &["--permission-mode", "auto"],
            "accept edits",
            "acceptEdits",
        ),
        (
            &[
                "--dangerously-skip-permissions",
                "--permission-mode",
                "acceptEdits",
            ],
            "plan",
            "plan",
        ), // (d) both
    ];
    for (launch, now, want) in shapes {
        let mut args = launch.to_vec();
        args.push("--fixture-footer");
        let s = core.start(AgentKind::Claude, Some("opus"), None, &args);
        core.prompt(&s.id);
        fs::write(core.home.join(format!("mode-{}", s.id)), now).unwrap();
        core.request(Request::Resize {
            id: s.id.clone(),
            cols: 150,
            rows: 40,
        })
        .unwrap();
        core.wait("the footer read", || {
            core.session(&s.id)
                .and_then(|s| s.permission_mode)
                .as_deref()
                == Some(now)
        });
        let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
            panic!("{launch:?}")
        };
        let new = launch_args(&core, &session.id);
        let skip = [
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
        ];
        assert!(
            !new.iter()
                .any(|a| skip.contains(&a.as_str()) || a.starts_with("--permission-mode=")),
            "{launch:?}: {new:?}"
        );
        let modes: Vec<_> = new
            .windows(2)
            .filter(|w| w[0] == "--permission-mode")
            .map(|w| w[1].clone())
            .collect();
        assert_eq!(modes, [want], "{launch:?}: {new:?}");
    }
}

#[test]
fn picker_launch_record_with_a_secret_stays_in_memory_only() {
    // Codex round-6 NOTE: inline MCP JSON (it can hold a token) is never written to sessions.json; the running core
    // still restarts with it.
    let core = Core::new();
    let mcp = "{\"mcpServers\":{\"w35\":{\"env\":{\"TOKEN\":\"w35-not-on-disk\"}}}}";
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--mcp-config", mcp, "--fixture-footer"],
    );
    core.prompt(&s.id);
    let stored = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    assert!(!stored.contains("w35-not-on-disk"), "{stored}");
    let Reply::Started { session } = toggle(&core, &s.id, Some(true), None).unwrap() else {
        panic!()
    };
    assert!(launch_args(&core, &session.id).iter().any(|a| a == mcp));
    let stored = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    assert!(!stored.contains("w35-not-on-disk"), "{stored}");
}

#[test]
fn picker_fast_restarts_in_skip_only_for_a_session_given_skip() {
    // Fable SHOULD 1 (round 6): the footer alone never grants Skip permissions.
    let core = Core::new();
    let given = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--dangerously-skip-permissions", "--fixture-footer"],
    );
    core.prompt(&given.id);
    core.wait("the footer read", || {
        core.session(&given.id)
            .and_then(|s| s.permission_mode)
            .as_deref()
            == Some("bypass permissions")
    });
    let Reply::Started { session } = toggle(&core, &given.id, Some(true), None).unwrap() else {
        panic!()
    };
    let args = launch_args(&core, &session.id);
    let at = args.iter().position(|a| a == "--permission-mode").unwrap();
    assert_eq!(args[at + 1], "bypassPermissions", "{args:?}");
    let never = core.start(AgentKind::Claude, Some("opus"), None, &["--fixture-footer"]);
    core.prompt(&never.id);
    fs::write(
        core.home.join(format!("mode-{}", never.id)),
        "bypass permissions",
    )
    .unwrap();
    core.request(Request::Resize {
        id: never.id.clone(),
        cols: 150,
        rows: 40,
    })
    .unwrap();
    core.wait("the footer read", || {
        core.session(&never.id)
            .and_then(|s| s.permission_mode)
            .as_deref()
            == Some("bypass permissions")
    });
    let refused = toggle(&core, &never.id, Some(true), None).unwrap_err();
    assert!(refused.contains("not given Skip permissions"), "{refused}");
    assert_eq!(
        core.session(&never.id).unwrap().state,
        SessionState::Running
    );
}

#[test]
fn picker_fast_refuses_when_the_mode_is_not_read() {
    // Fable SHOULD 4 (round 6): no footer read, no mode to keep: refused before anything stops.
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("opus"), None, &[]);
    core.prompt(&s.id);
    let refused = toggle(&core, &s.id, Some(true), None).unwrap_err();
    assert!(
        refused.contains("permission mode has not been read"),
        "{refused}"
    );
    let still = core.session(&s.id).unwrap();
    assert_eq!((still.state, still.pid), (SessionState::Running, s.pid));
}

#[test]
fn picker_ultracode_toggle_leaves_the_session_idle() {
    // W35 look v23 S2-1: after `/effort ultracode on|off` the session read "working" for minutes and every switch was
    // refused. The fake Claude writes its 2.1.329 records: the command line and its local answer, no model turn.
    let core = Core::new();
    let s = core.start(
        AgentKind::Claude,
        Some("opus"),
        None,
        &["--fixture-transcript", "--fixture-footer"],
    );
    core.prompt(&s.id);
    // Idle again means Claude's local answer was read from the transcript: that turn finished (`completion_seq` moved)
    // and the session is not working. The screen shows the answer earlier than the transcript is read, so the screen's
    // ultracode state alone is not enough (round 2: under load the next toggle came before the read).
    let finished = |id: &str| core.session(id).map(|s| s.completion_seq).unwrap_or(0);
    let idle_after = |id: &str, before: u64| {
        core.session(id)
            .is_some_and(|s| !s.attention.working && s.completion_seq > before)
    };
    for on in [true, false] {
        let before = finished(&s.id);
        let Reply::Delivery { send } = toggle(&core, &s.id, None, Some(on)).unwrap() else {
            panic!()
        };
        assert_eq!(core.settled(&s.id, &send.id), "delivered");
        core.wait("Claude's answer read", || {
            core.session(&s.id)
                .and_then(|s| s.modes)
                .and_then(|m| m.ultracode)
                == Some(on)
        });
        core.wait("idle again, the local answer read", || {
            idle_after(&s.id, before)
        });
    }
    // And a model switch is taken at once.
    assert!(matches!(
        core.switch(&s.id, Some("sonnet"), None),
        Ok(Reply::Delivery { .. })
    ));
}

#[test]
fn picker_ultracode_command_is_never_queued() {
    // W35-picker2 S2-2: a control command that cannot go in now is refused, not queued: a queued row goes in when a turn
    // ends, and `/effort ultracode on` reached Claude a second time that way. Here no turn ever ends (the fake writes no
    // transcript), so the second toggle would wait behind the first.
    let core = Core::new();
    let s = core.start(AgentKind::Claude, Some("opus"), None, &[]);
    core.prompt(&s.id);
    let Reply::Delivery { send } = toggle(&core, &s.id, None, Some(true)).unwrap() else {
        panic!()
    };
    assert_eq!(core.settled(&s.id, &send.id), "delivered");
    core.wait("Claude's answer", || {
        core.screen(&s.id)
            .contains("Ultracode on (this session only)")
    });
    let refused = toggle(&core, &s.id, None, Some(false)).unwrap_err();
    assert!(refused.contains("still answering"), "{refused}");
    let log = core.session(&s.id).unwrap().send_log;
    assert!(log.iter().all(|r| r.status != "queued"), "{log:?}");
    assert_eq!(
        log.iter()
            .filter(|r| r.content.starts_with("/effort"))
            .count(),
        2,
        "the refused one is canceled: {log:?}"
    );
}

/// Ticket 1100: Codex's own catalog (`$CODEX_HOME/models_cache.json`): the recorded 0.161.0 file with a new model on top.
fn cache_with_a_new_model(home: &Path) {
    let recorded = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/codex/models_cache-0.161.0.json");
    let mut cache: serde_json::Value =
        serde_json::from_slice(&fs::read(recorded).unwrap()).unwrap();
    let levels: Vec<_> = ["low", "medium", "high", "xhigh", "max", "ultra"]
        .iter()
        .map(|e| serde_json::json!({ "effort": e, "description": "d" }))
        .collect();
    cache["models"].as_array_mut().unwrap().insert(
        0,
        serde_json::json!({ "slug": "gpt-6.2-sol", "display_name": "GPT-6.2 Sol", "supported_reasoning_levels": levels,
            "visibility": "list", "priority": 0, "some_new_field": { "x": 1 } }),
    );
    fs::write(
        home.join("codex-home/models_cache.json"),
        serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();
}
fn codex_models(core: &Core) -> Vec<nunchiro_core::agent_models::Model> {
    let Ok(Reply::AgentModels { codex }) = core.request(Request::AgentModels) else {
        panic!("no model list")
    };
    codex
}

#[test]
fn picker_codex_model_from_its_own_catalog_starts_and_switches_as_before() {
    let core = Core::with(cache_with_a_new_model);
    let listed = codex_models(&core);
    assert_eq!(listed[0].value, "gpt-6.2-sol");
    assert_eq!(listed[0].label, "GPT-6.2 Sol");
    assert_eq!(
        listed[0].efforts,
        ["low", "medium", "high", "xhigh", "max", "ultra"]
    );
    // Codex hides these from its own picker.
    assert!(
        !listed
            .iter()
            .any(|m| m.value == "gpt-reserve" || m.value == "codex-auto-review")
    );
    // The fake Codex answers one conversation id: the switch (a resume) goes before the second start.
    let old = codex(&core);
    let Reply::Started { session } = core
        .switch(&old.id, Some("gpt-6.2-sol"), Some("high"))
        .unwrap()
    else {
        panic!()
    };
    let args = args_of(session.pid.unwrap(), "model_reasoning_effort=\"high\"");
    assert!(
        args.contains("-m gpt-6.2-sol -c model_reasoning_effort=\"high\""),
        "{args}"
    );
    // gpt-6-luna lists no ultra in Codex's catalog.
    assert_eq!(
        core.switch(&session.id, Some("gpt-6-luna"), Some("ultra"))
            .unwrap_err(),
        "unknown effort for this model"
    );
    let s = core.start(AgentKind::Codex, Some("gpt-6.2-sol"), Some("ultra"), &[]);
    let args = args_of(s.pid.unwrap(), "model_reasoning_effort=\"ultra\"");
    assert!(
        args.contains("-m gpt-6.2-sol -c model_reasoning_effort=\"ultra\""),
        "{args}"
    );
}

#[test]
fn picker_codex_without_a_readable_catalog_offers_the_fixed_list() {
    for bad in [None, Some(&b""[..]), Some(&b"{\"models\": 7"[..])] {
        let core = Core::with(|home| {
            if let Some(bytes) = bad {
                fs::write(home.join("codex-home/models_cache.json"), bytes).unwrap();
            }
        });
        let listed = codex_models(&core);
        assert_eq!(listed, nunchiro_core::agent_models::fallback());
        let s = core.start(AgentKind::Codex, None, None, &[]);
        assert!(
            core.switch(&s.id, Some("gpt-6.2-sol"), None)
                .is_err_and(|e| e == "unknown model")
        );
    }
}

/// Ticket 1100 (canary): the first session on a version the core has not seen is watched (its box and footer read),
/// then the agent starts once fresh in a temporary HOME with a cleared env. The fake Claude draws no welcome line there,
/// so the snapshot carries one card naming the version and what failed, and the temporary folder is gone.
#[test]
fn canary_watches_a_new_version_then_starts_it_fresh_once() {
    let core = Core::with(|home| {
        let bin = PathBuf::from(format!("{}-bin", home.display()));
        fs::create_dir_all(&bin).unwrap();
        fs::copy(home.join("claude"), bin.join("claude")).unwrap();
    });
    let s = core.start(AgentKind::Claude, None, None, &["--fixture-footer"]);
    core.prompt(&s.id);
    let file = core.home.join("agent-canary.json");
    let until = Instant::now() + Duration::from_secs(60);
    while !fs::read_to_string(&file).is_ok_and(|t| t.contains("\"started\": true")) {
        assert!(
            Instant::now() < until,
            "the canary did not finish: {:?}",
            fs::read_to_string(&file)
        );
        thread::sleep(Duration::from_millis(100));
    }
    let record: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let claude = &record["claude"];
    assert_eq!(claude["version"], "2.1.310 (Claude Code)");
    assert_eq!(
        (
            claude["watched"].as_bool(),
            claude["box_read"].as_bool(),
            claude["footer_read"].as_bool()
        ),
        (Some(true), Some(true), Some(true))
    );
    assert_eq!(
        claude["failed"],
        serde_json::json!(["its first screen does not show the version it reports"])
    );
    assert!(record.get("codex").is_none());
    let Ok(Reply::Snapshot {
        problem: Some(card),
        ..
    }) = core.request(Request::Snapshot)
    else {
        panic!("no card")
    };
    assert_eq!(card.case, nunchiro_core::problems::Case::AgentChanged);
    assert!(
        card.cause
            .starts_with("Claude Code 2.1.310 changed what Nunchiro reads"),
        "{}",
        card.cause
    );
    assert_eq!(
        fs::read_dir(core.home.join("canary"))
            .map(|d| d.count())
            .unwrap_or(0),
        0
    );
    // A second session on the same version checks nothing again.
    let before = fs::read_to_string(&file).unwrap();
    let again = core.start(AgentKind::Claude, None, None, &[]);
    core.prompt(&again.id);
    thread::sleep(Duration::from_millis(500));
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

/// Review r1 SHOULD 4: a model the fixed list has (saved by a schedule, role or team row) still starts after Codex's
/// own list stopped naming it; a model neither lists is refused.
#[test]
fn picker_codex_model_dropped_from_its_catalog_still_starts_from_the_fixed_list() {
    let core = Core::with(|home| {
        let levels: Vec<_> = ["low", "medium"]
            .iter()
            .map(|e| serde_json::json!({ "effort": e }))
            .collect();
        let cache = serde_json::json!({ "models": [{ "slug": "gpt-6.2-sol", "display_name": "GPT-6.2 Sol",
            "supported_reasoning_levels": levels, "visibility": "list", "priority": 0 }] });
        fs::write(
            home.join("codex-home/models_cache.json"),
            serde_json::to_vec(&cache).unwrap(),
        )
        .unwrap();
    });
    assert_eq!(codex_models(&core).len(), 1);
    let s = core.start(AgentKind::Codex, Some("gpt-6-luna"), Some("medium"), &[]);
    let args = args_of(s.pid.unwrap(), "model_reasoning_effort=\"medium\"");
    assert!(
        args.contains("-m gpt-6-luna -c model_reasoning_effort=\"medium\""),
        "{args}"
    );
    assert!(
        core.switch(&s.id, Some("gpt-9-unknown"), None)
            .is_err_and(|e| e == "unknown model")
    );
}
