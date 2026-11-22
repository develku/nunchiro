//! CHAT-PERMCHIP: the composer's permission-mode chip presses Shift+Tab through the existing key path and reads
//! the mode back from Claude's footer. Fake agents only.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        Self::with("claude-mode")
    }
    /// CHAT-MODELIST: `claude-modes`, whose cycle follows the launch args.
    fn modes() -> Self {
        Self::with("claude-modes")
    }
    fn with(claude: &str) -> Self {
        let home = home::short("permchip");
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let other = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nunchiro/tests/fixtures");
        fs::copy(fixtures.join(claude), home.join("claude")).unwrap();
        fs::copy(other.join("codex-picker"), home.join("codex")).unwrap();
        for name in ["claude", "codex"] {
            fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::create_dir_all(home.join("codex-home")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CODEX_HOME", home.join("codex-home"))
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("PATH", format!("{}:/usr/bin:/bin", home.display()))
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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
    fn start(&self, kind: AgentKind) -> Session {
        self.start_with(kind, &[])
    }
    fn start_with(&self, kind: AgentKind, args: &[&str]) -> Session {
        self.start_resume(kind, args, None)
    }
    fn start_resume(&self, kind: AgentKind, args: &[&str], resume: Option<&str>) -> Session {
        match self.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind,
                project: self.home.clone(),
                worktree: false,
                label: "mode".into(),
                args: args.iter().map(|a| a.to_string()).collect(),
                model: None,
                effort: None,
                resume: resume.map(str::to_string),
            },
        }) {
            Ok(Reply::Started { session }) => session,
            other => panic!("start failed: {other:?}"),
        }
    }
    /// Ticket 362: a Start the way the app makes it, over the window's socket.
    fn window_start(&self) -> String {
        let info = serde_json::to_value(self.request(Request::WindowAuth).unwrap()).unwrap();
        let port = info["port"].as_u64().unwrap() as u16;
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        let protocol = format!(
            "nunchiro.v1, nunchiro.token.{}",
            info["token"].as_str().unwrap()
        );
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&protocol).unwrap(),
        );
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        let start = json!({"op":"start","session":{"kind":"claude","project":self.home,"label":"w","model":null,"effort":null,"resume":null}});
        ws.send(Message::Text(
            json!({"id":7,"request":start}).to_string().into(),
        ))
        .unwrap();
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 7 {
                    return v["response"]["Ok"]["session"]["id"]
                        .as_str()
                        .unwrap_or_else(|| panic!("{v}"))
                        .into();
                }
            }
        }
    }
    /// A request on a session's own token, as `nunchiro` run inside that session sends it.
    fn as_session(&self, id: &str, request: Request) -> Response {
        let token = fs::read_to_string(self.home.join(format!("token-{id}"))).unwrap();
        let mut stream = UnixStream::connect(self.home.join("core.sock")).unwrap();
        let mut line = serde_json::to_vec(&Envelope { token, request }).unwrap();
        line.push(b'\n');
        stream.write_all(&line).unwrap();
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply).unwrap();
        serde_json::from_str(&reply).unwrap()
    }
    fn session(&self, id: &str) -> Session {
        match self.request(Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
            _ => panic!(),
        }
    }
    fn wait(&self, what: &str, f: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !f() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn mode(&self, id: &str) -> Option<String> {
        self.session(id).permission_mode
    }
    /// The fake agent's footer has been drawn, so its composer is there. A new start's mode shows from launch, before it.
    fn at_composer(&self, id: &str) -> bool {
        match self.request(Request::Read {
            id: id.into(),
            after: 0,
        }) {
            Ok(Reply::Output { data, .. }) => {
                String::from_utf8_lossy(&data).contains("shift+tab to cycle")
            }
            other => panic!("{other:?}"),
        }
    }
    /// Every stdin read the fake agent saw, as hex.
    fn reads(&self, id: &str) -> Vec<String> {
        fs::read_to_string(self.home.join(format!("stdin-{id}.log")))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.strip_prefix("READ ").map(str::to_string))
            .collect()
    }
    fn set_mode(&self, id: &str, mode: &str) -> Response {
        self.request(Request::SetMode {
            id: id.into(),
            mode: mode.into(),
        })
    }
    fn mode_state(&self, id: &str) -> ModeState {
        self.session(id)
            .mode_state
            .expect("a Claude session has a mode state")
    }
    fn keys(&self, id: &str, keys: &[&str]) -> Response {
        self.request(Request::AgentKeys {
            id: id.into(),
            keys: keys.iter().map(|k| k.to_string()).collect(),
        })
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.request(Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn chip_click_sends_one_logged_key() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("the manual footer", || {
        core.mode(&id).as_deref() == Some("manual")
    });
    let Ok(Reply::Delivery { send }) = core.keys(&id, &["shift+tab"]) else {
        panic!("shift+tab refused")
    };
    core.wait("the key to land", || core.reads(&id) == ["1b5b5a"]);
    let log = core.session(&id).send_log;
    let rows: Vec<_> = log.iter().filter(|s| s.id == send.id).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].sender.as_str(), rows[0].keys.as_slice()),
        ("user", &["shift+tab".to_string()][..])
    );
    assert_eq!(log.len(), 1, "no other send: {log:?}");
}

#[test]
fn chip_value_follows_screen_only() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    core.keys(&id, &["shift+tab"]).unwrap();
    core.wait("accept edits", || {
        core.mode(&id).as_deref() == Some("accept edits")
    });
    core.keys(&id, &["shift+tab"]).unwrap();
    core.wait("plan", || core.mode(&id).as_deref() == Some("plan"));
    // Nothing pressed since: the value stays whatever the screen shows.
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.mode(&id).as_deref(), Some("plan"));
    assert_eq!(core.reads(&id).len(), 2);
}

#[test]
fn chip_refused_while_decision_pending() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("the box", || core.mode(&id).is_some());
    core.request(Request::SendText {
        id: id.clone(),
        text: "D".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    core.wait("the dialog", || {
        core.session(&id)
            .pending
            .iter()
            .any(|p| !p.choices.is_empty())
    });
    assert_eq!(core.mode(&id), None, "a dialog on screen gives no mode");
    let error = core.keys(&id, &["shift+tab"]).unwrap_err();
    assert!(error.contains("agent_blocked"), "{error}");
    assert_eq!(core.reads(&id), ["44"], "only the D byte reached the agent");
}

#[test]
fn no_chip_for_codex() {
    let core = Core::new();
    let id = core.start(AgentKind::Codex).id;
    core.wait("codex up", || {
        core.session(&id).state == SessionState::Running
    });
    assert_eq!(core.mode(&id), None);
    let error = core.keys(&id, &["shift+tab"]).unwrap_err();
    assert!(error.contains("unsupported key"), "{error}");
    assert!(core.session(&id).send_log.is_empty());
}

fn hook(core: &Core, id: &str, event: &str) {
    core.request(Request::Hook {
        id: id.into(),
        event: event.into(),
        payload: serde_json::json!({}),
    })
    .unwrap();
}
fn send_rows(core: &Core, id: &str) -> usize {
    let s = core.session(id);
    s.send_log.len() + s.send_queue.len()
}

// Round 2 (1): a mode change must land where the owner clicked, never later.
#[test]
fn shift_tab_never_queued() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("the manual footer", || {
        core.mode(&id).as_deref() == Some("manual")
    });
    hook(&core, &id, "UserPromptSubmit"); // the agent is working
    for _ in 0..3 {
        let error = core.keys(&id, &["shift+tab"]).unwrap_err();
        assert!(error.contains("not at its composer"), "{error}");
    }
    assert_eq!(send_rows(&core, &id), 0, "nothing logged or queued");
    hook(&core, &id, "Stop"); // idle again: a queued key would run now
    thread::sleep(Duration::from_millis(600));
    assert_eq!(core.reads(&id), Vec::<String>::new());
    assert_eq!(send_rows(&core, &id), 0);
}

// Round 2 (2): no recognised composer on screen (an unknown dialog), even for the user.
#[test]
fn shift_tab_refused_without_composer() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("the manual footer", || {
        core.mode(&id).as_deref() == Some("manual")
    });
    fs::write(core.home.join("plain"), "").unwrap(); // the fake runs in the core home
    core.wait("the unknown screen", || core.mode(&id).is_none());
    let error = core.keys(&id, &["shift+tab"]).unwrap_err();
    assert!(error.contains("not at its composer"), "{error}");
    assert_eq!(send_rows(&core, &id), 0);
    assert_eq!(core.reads(&id), Vec::<String>::new());
}

// Round 2 (3): the owner's raw SendKeys takes the same gate for Shift+Tab.
#[test]
fn raw_send_keys_shift_tab_gated() {
    let core = Core::new();
    let id = core.start(AgentKind::Claude).id;
    core.wait("the manual footer", || {
        core.mode(&id).as_deref() == Some("manual")
    });
    let raw = |keys: &[&str]| {
        core.request(Request::SendKeys {
            id: id.clone(),
            keys: keys.iter().map(|k| k.to_string()).collect(),
            seen: vec![],
            composer: false,
        })
    };
    hook(&core, &id, "UserPromptSubmit");
    assert!(
        raw(&["shift+tab"])
            .unwrap_err()
            .contains("not at its composer")
    );
    hook(&core, &id, "Stop");
    assert!(
        raw(&["shift+tab", "enter"]).is_err(),
        "a lone Shift+Tab only"
    );
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.reads(&id), Vec::<String>::new());
    // At the composer it goes through the logged path, once.
    raw(&["shift+tab"]).unwrap();
    core.wait("the key to land", || core.reads(&id) == ["1b5b5a"]);
    assert_eq!(core.session(&id).send_log.len(), 1);
    // Other raw keys keep working.
    raw(&["tab"]).unwrap();
    core.wait("tab", || core.reads(&id).len() == 2);
}

// ---- CHAT-MODELIST (ticket 285): the mode list's pick walks Claude's cycle one logged key at a time ----

const ALLOW_SKIP: &str = "--allow-dangerously-skip-permissions";
const PRESS: &str = "1b5b5a";

#[test]
fn mode_walk_stops_at_target() {
    let core = Core::modes();
    let id = core.start(AgentKind::Claude).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    core.set_mode(&id, "plan").unwrap();
    core.wait("plan", || core.mode(&id).as_deref() == Some("plan"));
    core.wait("the walk to end", || core.mode_state(&id).walk.is_none());
    // Nothing pressed after the target: two presses, both logged as the user's.
    thread::sleep(Duration::from_millis(500));
    assert_eq!(core.reads(&id), [PRESS, PRESS]);
    let log = core.session(&id).send_log;
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(
        log.iter()
            .all(|s| s.sender == "user" && s.keys == ["shift+tab"])
    );
    // Already there: no key at all.
    core.set_mode(&id, "plan").unwrap();
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.reads(&id).len(), 2);
    // Backwards is forwards round the cycle: plan -> auto -> manual.
    core.set_mode(&id, "manual").unwrap();
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    thread::sleep(Duration::from_millis(500));
    assert_eq!(core.reads(&id).len(), 4);
}

#[test]
fn mode_walk_refuses_on_dialog() {
    let core = Core::modes();
    let id = core.start(AgentKind::Claude).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    fs::write(core.home.join("dialog"), "").unwrap();
    core.wait("the dialog", || core.mode(&id).is_none());
    let error = core.set_mode(&id, "plan").unwrap_err();
    assert!(error.contains("not at its composer"), "{error}");
    assert_eq!(
        core.reads(&id),
        Vec::<String>::new(),
        "no key into a dialog"
    );
    assert_eq!(send_rows(&core, &id), 0);
    assert_eq!(core.mode_state(&id).walk, None);
}

// A footer that never moves ends the walk with a reason and leaves the session usable: one key, no loop.
#[test]
fn mode_walk_stops_when_the_footer_does_not_move() {
    let core = Core::modes();
    let id = core.start(AgentKind::Claude).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    fs::write(core.home.join("stuck"), "").unwrap();
    core.set_mode(&id, "plan").unwrap();
    core.wait("the walk to give up", || {
        core.mode_state(&id).walk.is_some_and(|w| w.error.is_some())
    });
    let walk = core.mode_state(&id).walk.unwrap();
    assert_eq!(walk.target, "plan");
    assert!(walk.error.unwrap().contains("did not change"));
    thread::sleep(Duration::from_millis(500));
    assert_eq!(core.reads(&id), [PRESS], "one key, then it stopped");
    fs::remove_file(core.home.join("stuck")).unwrap();
    core.set_mode(&id, "accept edits").unwrap(); // usable again, and the old error is gone
    core.wait("accept edits", || {
        core.mode(&id).as_deref() == Some("accept edits")
    });
    assert_eq!(core.mode_state(&id).walk, None);
}

// A cycle without the target (Claude drops `auto` for some accounts) comes back to the start: stop there, say why.
#[test]
fn mode_walk_stops_when_the_cycle_has_no_target() {
    let core = Core::modes();
    let id = core.start_with(AgentKind::Claude, &["--no-auto"]).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    core.set_mode(&id, "auto").unwrap();
    core.wait("the walk to give up", || {
        core.mode_state(&id).walk.is_some_and(|w| w.error.is_some())
    });
    assert!(
        core.mode_state(&id)
            .walk
            .unwrap()
            .error
            .unwrap()
            .contains("has no auto")
    );
    assert_eq!(core.mode(&id).as_deref(), Some("manual"));
    assert_eq!(core.reads(&id).len(), 3, "one full cycle, not more");
}

// Ticket 362 (owner 11-09): a session the owner starts from the app runs with the stored permission, full access unless
// changed. The fake Claude's footer follows its real argv. A session's child gets none of it.
#[test]
fn default_launch_carries_full_access_and_the_setting_changes_the_next_launch() {
    let core = Core::modes();
    let permissions = |claude, codex| Reply::AgentPermission {
        claude,
        codex,
        claude_bypass_disabled: false,
    };
    let get = || core.request(Request::AgentPermissionGet).unwrap();
    let set = |choice| {
        core.request(Request::AgentPermissionSet {
            agent: AgentKind::Claude,
            choice,
        })
        .unwrap()
    };
    use PermissionChoice::{AcceptEdits, Ask, FullAccess, Own};
    assert_eq!(
        format!("{:?}", get()),
        format!("{:?}", permissions(FullAccess, FullAccess))
    );
    let first = core.window_start();
    core.wait("bypass", || {
        core.mode(&first).as_deref() == Some("bypass permissions")
    });
    assert_eq!(
        format!("{:?}", set(Ask)),
        format!("{:?}", permissions(Ask, FullAccess))
    );
    let asking = core.window_start();
    core.wait("the manual footer", || {
        core.at_composer(&asking) && core.mode(&asking).as_deref() == Some("manual")
    });
    // Ask leaves the allow flag out: the row says what to do and a pick presses nothing.
    assert_eq!(core.mode_state(&asking).skip, SkipPermissions::NeedsSetting);
    let error = core.set_mode(&asking, "bypass permissions").unwrap_err();
    assert!(error.contains("change the permission setting"), "{error}");
    assert_eq!(core.reads(&asking), Vec::<String>::new());
    set(AcceptEdits);
    let editing = core.window_start();
    core.wait("the accept edits footer", || {
        core.at_composer(&editing) && core.mode(&editing).as_deref() == Some("accept edits")
    });
    assert_eq!(core.mode_state(&editing).skip, SkipPermissions::Available);
    // No confirm; switching in the session stays, and reaches it only because the flag was in the real argv.
    core.set_mode(&editing, "bypass permissions").unwrap();
    core.wait("bypass", || {
        core.mode(&editing).as_deref() == Some("bypass permissions")
    });
    set(Own);
    let own = core.window_start();
    core.wait("manual", || core.mode(&own).as_deref() == Some("manual"));
    assert_eq!(core.mode_state(&own).skip, SkipPermissions::Unavailable);
    // Back to the default: an agent's child still gets nothing.
    set(FullAccess);
    let parent = core.start_with(AgentKind::Claude, &["--fixture-token"]).id;
    core.wait("manual", || core.mode(&parent).as_deref() == Some("manual"));
    let child = match core.as_session(
        &parent,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: core.home.clone(),
                worktree: false,
                label: "child".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    ) {
        Ok(Reply::Started { session }) => session.id,
        other => panic!("{other:?}"),
    };
    core.wait("manual", || core.mode(&child).as_deref() == Some("manual"));
    assert_eq!(core.mode_state(&child).skip, SkipPermissions::Unavailable);
}

// Ticket 362 (T3 Code's downgrade): Claude's settings turn bypass off: the launch uses auto instead of failing, the row
// says why, and a pick is refused before any key is pressed.
#[test]
fn claude_settings_that_disable_bypass_downgrade_the_launch_and_refuse_the_pick() {
    let core = Core::modes();
    let config = core.home.join("claude-home");
    fs::create_dir_all(&config).unwrap();
    let off = json!({"permissions":{"disableBypassPermissionsMode":"disable"}});
    fs::write(config.join("settings.json"), off.to_string()).unwrap();
    let id = core.window_start();
    core.wait("the auto footer", || {
        core.at_composer(&id) && core.mode(&id).as_deref() == Some("auto")
    });
    assert_eq!(core.mode_state(&id).skip, SkipPermissions::Disabled);
    let error = core.set_mode(&id, "bypass permissions").unwrap_err();
    assert!(error.contains("disableBypassPermissionsMode"), "{error}");
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        core.reads(&id),
        Vec::<String>::new(),
        "no key looking for it"
    );
}

// Ticket 362 threat: with the flag on, Shift+Tab can reach bypass. No session caller presses it, by key name or by its
// bytes, and none asks for the mode or starts a child that has it in reach.
#[test]
fn session_callers_cannot_reach_skip_permissions() {
    let core = Core::modes();
    let caller = core.start_with(AgentKind::Claude, &["--fixture-token"]).id;
    let target = core.start_with(AgentKind::Claude, &[ALLOW_SKIP]).id;
    for id in [&caller, &target] {
        core.wait("manual", || core.mode(id).as_deref() == Some("manual"));
    }
    let shift_tab = || vec!["shift+tab".to_string()];
    for request in [
        Request::AgentKeys {
            id: target.clone(),
            keys: shift_tab(),
        },
        Request::SendKeys {
            id: target.clone(),
            keys: shift_tab(),
            seen: vec![],
            composer: false,
        },
        Request::SendText {
            id: target.clone(),
            text: "\x1b[Z".into(),
            seen: vec![],
            composer: false,
        },
        Request::AgentSend {
            id: target.clone(),
            text: "\x1b[Z".into(),
        },
        Request::SetMode {
            id: target.clone(),
            mode: "bypass permissions".into(),
        },
        Request::AgentPermissionGet,
        Request::AgentPermissionSet {
            agent: AgentKind::Claude,
            choice: PermissionChoice::Own,
        },
    ] {
        let what = format!("{request:?}");
        assert!(core.as_session(&caller, request).is_err(), "{what}");
    }
    for (kind, args) in [
        (AgentKind::Claude, vec![ALLOW_SKIP]),
        (AgentKind::Claude, vec!["--dangerously-skip-permissions"]),
        (
            AgentKind::Claude,
            vec!["--permission-mode", "bypassPermissions"],
        ),
        (
            AgentKind::Claude,
            vec!["--permission-mode=bypassPermissions"],
        ),
        (
            AgentKind::Claude,
            vec![
                "--settings",
                "{\"permissions\":{\"defaultMode\":\"bypassPermissions\"}}",
            ],
        ),
        (
            AgentKind::Codex,
            vec!["--dangerously-bypass-approvals-and-sandbox"],
        ),
        (AgentKind::Codex, vec!["--yolo"]),
        (AgentKind::Codex, vec!["--full-auto"]),
        (AgentKind::Codex, vec!["-a", "never"]),
        (AgentKind::Codex, vec!["--ask-for-approval", "never"]),
        (AgentKind::Codex, vec!["--ask-for-approval=never"]),
        (AgentKind::Codex, vec!["-s", "danger-full-access"]),
        (AgentKind::Codex, vec!["--sandbox=danger-full-access"]),
        // Q9 tt-J5-1: the same through Codex's config overrides.
        (AgentKind::Codex, vec!["-c", "approval_policy=never"]),
        (
            AgentKind::Codex,
            vec!["-c", "sandbox_mode=\"danger-full-access\""],
        ),
        (
            AgentKind::Codex,
            vec!["--config", "approval_policy = 'never'"],
        ),
        (
            AgentKind::Codex,
            vec!["--config=sandbox_mode=danger-full-access"],
        ),
        (AgentKind::Codex, vec!["-capproval_policy=never"]),
        (
            AgentKind::Codex,
            vec!["-c", "profiles.x.approval_policy=never"],
        ),
        (AgentKind::Codex, vec!["-c=approval_policy=never"]),
        (
            AgentKind::Codex,
            vec!["-c", "\"approval\\u005fpolicy\"=\"never\""],
        ),
        (AgentKind::Codex, vec!["-c=sandbox_mode=danger-full-access"]),
        (
            AgentKind::Codex,
            vec!["-c", "approval_policy=\"\\u006eever\""],
        ),
        (
            AgentKind::Codex,
            vec!["-c", "profiles={x={approval_policy=\"never\"}}", "-p", "x"],
        ),
    ] {
        let reply = core.as_session(
            &caller,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: core.home.clone(),
                    worktree: false,
                    label: "child".into(),
                    args: args.iter().map(|a| a.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        );
        assert_eq!(reply.unwrap_err(), "operation not granted", "{args:?}");
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.reads(&target), Vec::<String>::new());
    assert_eq!(core.mode(&target).as_deref(), Some("manual"));
    assert!(
        matches!(
            core.request(Request::AgentPermissionGet),
            Ok(Reply::AgentPermission {
                claude: PermissionChoice::FullAccess,
                ..
            })
        ),
        "the setting did not move"
    );
}

// A walk that only passes through Bypass permissions must not stop there.
#[test]
fn walk_through_skip_permissions_reaches_the_pick() {
    let core = Core::modes();
    let id = core.start_with(AgentKind::Claude, &[ALLOW_SKIP]).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    core.set_mode(&id, "auto").unwrap(); // manual -> accept edits -> plan -> auto
    core.wait("auto", || core.mode(&id).as_deref() == Some("auto"));
    core.set_mode(&id, "accept edits").unwrap(); // auto -> bypass -> manual -> accept edits
    core.wait("accept edits", || {
        core.mode(&id).as_deref() == Some("accept edits")
    });
    assert_eq!(
        core.mode_state(&id).skip,
        SkipPermissions::Available,
        "still in the list"
    );
}

// Without Claude's own launch flag its cycle has no Skip permissions: refused with the reason, no key sent.
#[test]
fn skip_permissions_refused_without_user_gesture() {
    let core = Core::modes();
    // A plain start: what a scheduled run starts (no args), and the default for every session.
    let plain = core.start(AgentKind::Claude).id;
    // Two sessions that can reach it; the first one's confirm is not the second's.
    let first = core.start_with(AgentKind::Claude, &[ALLOW_SKIP]).id;
    let second = core.start_with(AgentKind::Claude, &[ALLOW_SKIP]).id;
    for id in [&plain, &first, &second] {
        core.wait("manual", || core.mode(id).as_deref() == Some("manual"));
    }
    assert_eq!(core.mode_state(&plain).skip, SkipPermissions::Unavailable);
    let error = core.set_mode(&plain, "bypass permissions").unwrap_err();
    assert!(
        error.contains("not in this session's mode cycle"),
        "{error}"
    );
    core.set_mode(&first, "bypass permissions").unwrap();
    core.wait("bypass", || {
        core.mode(&first).as_deref() == Some("bypass permissions")
    });
    assert_eq!(core.mode_state(&second).skip, SkipPermissions::Available);
    // The old key path never lands a mode change for anyone but the user (check_key), and an agent caller's
    // `SetMode` is refused in sessions.rs `mode_request_refused_to_session_callers`.
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.reads(&plain), Vec::<String>::new());
    assert_eq!(core.reads(&second), Vec::<String>::new());
}

#[test]
fn session_launched_in_skip_permissions_shows_it() {
    let core = Core::modes();
    let id = core
        .start_with(AgentKind::Claude, &["--dangerously-skip-permissions"])
        .id;
    core.wait("bypass", || {
        core.mode(&id).as_deref() == Some("bypass permissions")
    });
    assert_eq!(core.mode_state(&id).skip, SkipPermissions::Available);
}

#[test]
fn set_mode_refused_for_codex_and_unknown_mode() {
    let core = Core::modes();
    let id = core.start(AgentKind::Codex).id;
    core.wait("codex up", || {
        core.session(&id).state == SessionState::Running
    });
    assert!(
        core.set_mode(&id, "plan")
            .unwrap_err()
            .contains("only Claude")
    );
    assert_eq!(core.session(&id).mode_state, None);
    let claude = core.start(AgentKind::Claude).id;
    core.wait("manual", || core.mode(&claude).as_deref() == Some("manual"));
    assert!(
        core.set_mode(&claude, "yolo")
            .unwrap_err()
            .contains("unknown mode")
    );
}

// A walk that stops while the footer shows Skip permissions the owner never confirmed presses once more to leave it.
#[test]
fn failed_walk_does_not_leave_an_unconfirmed_skip_permissions() {
    let core = Core::modes();
    let id = core.start_with(AgentKind::Claude, &[ALLOW_SKIP]).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    core.set_mode(&id, "plan").unwrap();
    core.wait("plan", || core.mode(&id).as_deref() == Some("plan"));
    core.wait("the walk to end", || core.mode_state(&id).walk.is_none());
    fs::write(core.home.join("stick-at-bypass"), "").unwrap(); // the fake freezes once it lands in Skip permissions
    core.set_mode(&id, "accept edits").unwrap(); // plan -> auto -> bypass (frozen)
    core.wait("the walk to give up", || {
        core.mode_state(&id).walk.is_some_and(|w| w.error.is_some())
    });
    thread::sleep(Duration::from_millis(300));
    // 2 presses to plan, 2 into the frozen Skip permissions, 1 the walk goes on with and 1 more after it gave up (the
    // frozen fake ignores both, its log has them).
    assert_eq!(core.reads(&id).len(), 6);
    assert_eq!(
        core.mode_state(&id).skip,
        SkipPermissions::Available,
        "never confirmed"
    );
}

// Round 2 (security review MUST 1): other input waits while a walk runs. The fake freezes in Skip permissions mid-walk
// (plan -> auto -> bypass); a queued prompt and the owner's raw text arrive there; nothing but Shift+Tab reaches the
// agent until the walk has ended, then the queued prompt goes in and the session is out of Skip permissions.
#[test]
fn walk_through_skip_permissions_holds_other_input() {
    let core = Core::modes();
    let id = core.start_with(AgentKind::Claude, &[ALLOW_SKIP]).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    core.set_mode(&id, "plan").unwrap();
    core.wait("plan", || core.mode(&id).as_deref() == Some("plan"));
    core.wait("the walk to end", || core.mode_state(&id).walk.is_none());
    fs::write(core.home.join("stick-at-bypass"), "").unwrap();
    core.set_mode(&id, "accept edits").unwrap(); // plan -> auto -> bypass (frozen)
    core.wait("the footer in Skip permissions", || {
        core.mode(&id).as_deref() == Some("bypass permissions")
    });
    // The footer sits in the mode the owner never confirmed: input arrives now.
    let queued = core.request(Request::AgentPrompt {
        id: id.clone(),
        text: "queued-hello".into(),
    });
    let raw = core.request(Request::SendText {
        id: id.clone(),
        text: "raw-hello".into(),
        seen: vec![],
        composer: false,
    });
    assert!(
        matches!(queued, Ok(Reply::Delivery { ref send }) if send.status == "queued"),
        "{queued:?}"
    );
    assert!(raw.unwrap_err().contains("mode change in progress"));
    // Round 3 MUST 1: a model switch (meta+p into the picker) is no way around the hold either.
    let switch = core.request(Request::SwitchModel {
        id: id.clone(),
        model: Some("sonnet".into()),
        effort: None,
        fast: None,
        ultracode: None,
    });
    assert!(switch.unwrap_err().contains("mode change in progress"));
    thread::sleep(Duration::from_millis(600)); // several ticks inside the walk's 3 s wait
    assert!(
        core.reads(&id).iter().all(|r| r == PRESS),
        "only Shift+Tab reached the agent: {:?}",
        core.reads(&id)
    );
    fs::remove_file(core.home.join("stuck")).unwrap(); // the walk gives up; its recovery press now moves on
    core.wait("the walk to end", || {
        core.mode_state(&id).walk.is_some_and(|w| w.error.is_some())
    });
    // Round 3: the failed walk brings the session back to where it started (plan), not one step past Skip permissions.
    core.wait("back at the start mode", || {
        core.mode(&id).as_deref() == Some("plan")
    });
    let error = core.mode_state(&id).walk.unwrap().error.unwrap();
    assert!(error.contains("back in plan"), "{error}");
    // Only now does the queued prompt go in, after the last Shift+Tab.
    core.wait("the queued prompt", || {
        core.reads(&id).iter().any(|r| r != PRESS)
    });
    let reads = core.reads(&id);
    let first_text = reads.iter().position(|r| r != PRESS).unwrap();
    assert!(reads[first_text..].iter().all(|r| r != PRESS), "{reads:?}");
    assert_eq!(
        core.mode_state(&id).skip,
        SkipPermissions::Available,
        "never confirmed"
    );
}

// Round 2 (review note): a resumed session has no launch args to read; its cycle may hold Skip permissions, so it is
// offered (confirm first) and the walk's footer reading decides. Here the fake has none: the walk stops with the reason.
#[test]
fn resumed_session_offers_skip_permissions_and_the_walk_decides() {
    let core = Core::modes();
    let id = core.start_resume(AgentKind::Claude, &[], Some("abc")).id;
    core.wait("manual", || core.mode(&id).as_deref() == Some("manual"));
    assert_eq!(core.mode_state(&id).skip, SkipPermissions::Available);
    core.set_mode(&id, "bypass permissions").unwrap();
    core.wait("the walk to give up", || {
        core.mode_state(&id).walk.is_some_and(|w| w.error.is_some())
    });
    assert!(
        core.mode_state(&id)
            .walk
            .unwrap()
            .error
            .unwrap()
            .contains("has no bypass permissions")
    );
    assert_eq!(core.mode(&id).as_deref(), Some("manual"));
    assert_eq!(core.mode_state(&id).skip, SkipPermissions::Available);
}
