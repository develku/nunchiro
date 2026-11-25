#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
#[path = "fixtures/hold.rs"]
mod hold;
struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        Self::with_screen("\x1b[2J\x1b[HDo you want to proceed?\r\n1. Yes\r\n2. No\r\n")
    }
    fn with_screen(screen: &str) -> Self {
        Self::configured(screen, false)
    }
    fn configured(screen: &str, disable: bool) -> Self {
        Self::launched(screen, disable, None)
    }
    /// v1a-17: `shim` is a hold dylib the core loads, for a test that must hold it mid-call.
    fn launched(screen: &str, disable: bool, shim: Option<&std::path::Path>) -> Self {
        let home = home::short("wc");
        fs::write(home.join("screen.txt"), screen).unwrap();
        fs::write(home.join("claude"),"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nif [ -f hold-screen ]; then while [ -f hold-screen ]; do sleep 0.01; done; fi\nif [ -f bridge ]; then core_home=$NUNCHIRO_HOME; NUNCHIRO_HOME=\"$core_home/h\" \"$core_home/bridge-cli\" hook PermissionRequest <<'PAYLOAD'\n{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"touch never\"}}\nPAYLOAD\nfi\ncat screen.txt\nread x\nprintf '\\033[2J\\033[HDone %s' \"$x\"\nsleep 30\n").unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::copy(home.join("claude"), home.join("codex")).unwrap();
        let codex = fs::read_to_string(home.join("codex"))
            .unwrap()
            .replace("2.1.310 (Claude Code)", "codex-cli 0.161.0")
            .replace(
                "cat screen.txt",
                "printf '%s\\n' \"$@\" > argv.txt\ncat screen.txt",
            );
        fs::write(home.join("codex"), home::codex_fake(&codex)).unwrap();
        fs::write(
            home.join("settings.json"),
            serde_json::json!({"disable_hook_injection":disable}).to_string(),
        )
        .unwrap();
        let bin = cli::path();
        let mut command = home::git_env::scrubbed(bin);
        if let Some(shim) = shim {
            command.env("DYLD_INSERT_LIBRARIES", shim);
        }
        let process = command
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
        core.wait_ready();
        core
    }
    fn wait_ready(&self) {
        let until = Instant::now() + Duration::from_secs(30);
        while !matches!(self.request(Request::Snapshot), Ok(Reply::Snapshot { .. })) {
            assert!(Instant::now() < until, "core protocol did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn request(&self, r: Request) -> Response {
        call(&self.home, r)
    }
    fn start(&self) -> Session {
        self.start_kind(AgentKind::Claude)
    }
    fn start_kind(&self, kind: AgentKind) -> Session {
        match self
            .request(Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: self.home.clone(),
                    worktree: false,
                    label: "test".into(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                },
            })
            .unwrap()
        {
            Reply::Started { session } => session,
            _ => panic!(),
        }
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
fn real_core_detects_screen_and_routes_explicit_once_answer() {
    let core = Core::new();
    let session = core.start();
    let item = core.pending(&session.id);
    assert!(item.sources.contains("screen"));
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    thread::sleep(Duration::from_millis(80));
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: session.id,
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(String::from_utf8_lossy(&data).contains("Done 1"));
}
impl Core {
    /// The session's first pending item, once there is one. W27: that it comes at all, not how soon: the agent's start
    /// and first draw took more than the 1 s this waited beside other builds.
    fn pending(&self, id: &str) -> nunchiro_core::queue::Decision {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let Reply::Snapshot { sessions, .. } = self.request(Request::Snapshot).unwrap() else {
                panic!()
            };
            if let Some(i) = sessions
                .iter()
                .find(|s| s.id == id)
                .unwrap()
                .pending
                .first()
            {
                return i.clone();
            }
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(10));
        }
    }
}
#[test]
fn permission_hook_returns_only_the_explicit_user_answer() {
    let core = Core::new();
    let s = core.start();
    core.request(Request::QueueConnect).unwrap();
    let home = core.home.clone();
    let id = s.id.clone();
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":"Bash","nunchiro_event_id":"event-1"}),
            },
        )
    });
    let end = Instant::now() + Duration::from_secs(1);
    let item = loop {
        let item = core.pending(&s.id);
        if item.hook_event_id.as_deref() == Some("event-1") {
            break item;
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(10));
    };
    assert!(!hook.is_finished());
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    let Reply::HookDecision {
        decision: Some(answer),
    } = hook.join().unwrap().unwrap()
    else {
        panic!("missing explicit answer")
    };
    assert_eq!(
        answer["hookSpecificOutput"]["decision"]["behavior"],
        "allow"
    );
}
// v1a-17: answered while the hook is still in flight, so a hook that waited for a window would take that answer.
#[test]
fn absent_window_returns_no_decision_immediately() {
    let core = Core::new();
    let s = core.start();
    let (home, id) = (core.home.clone(), s.id.clone());
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":"Bash","nunchiro_event_id":"event-2"}),
            },
        )
    });
    // Until the hook returns, answer its own item. A hook not waiting never takes it, and the answer then falls to
    // the screen, which refuses an item this screen does not show, so nothing is typed and the item stays.
    let until = Instant::now() + Duration::from_secs(30);
    while !hook.is_finished() {
        let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
            panic!()
        };
        let pending = &sessions.iter().find(|x| x.id == s.id).unwrap().pending;
        if let Some(i) = pending
            .iter()
            .find(|i| i.hook_event_id.as_deref() == Some("event-2"))
        {
            let _ = core.request(Request::Answer {
                item: i.id.clone(),
                answer: nunchiro_core::queue::Answer::AllowOnce,
                confirmed: true,
            });
            break;
        }
        assert!(Instant::now() < until, "the hook never reached the queue");
        thread::sleep(Duration::from_millis(10));
    }
    let reply = hook.join().unwrap().unwrap();
    assert!(
        matches!(reply, Reply::HookDecision { decision: None }),
        "{reply:?}"
    );
    assert_eq!(
        core.pending(&s.id).kind,
        nunchiro_core::queue::Kind::Permission
    );
}
#[test]
fn core_down_hook_is_silent_and_recovered_without_approval_on_restart() {
    let mut core = Core::new();
    let session = core.start();
    core.pending(&session.id);
    core.request(Request::Stop).unwrap();
    core.process.wait().unwrap();
    let bin = cli::path();
    let mut hook = home::git_env::scrubbed(&bin)
        .args(["hook", "PermissionRequest"])
        .env("NUNCHIRO_HOME", &core.home)
        .env("NUNCHIRO_SESSION", &session.id)
        .env("NUNCHIRO_TOKEN", "not-persisted")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    use std::io::Write;
    hook.stdin
        .take()
        .unwrap()
        .write_all(br#"{"tool_name":"Bash","tool_input":{"command":"touch never"}}"#)
        .unwrap();
    let out = hook.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    let events =
        nunchiro_core::queue::journal::read(&core.home, nunchiro_core::queue::now_ms()).unwrap();
    assert_eq!(events.len(), 1);
    assert!(
        !fs::read_to_string(&events[0].0)
            .unwrap()
            .contains("not-persisted")
    );
    core.process = home::git_env::scrubbed(bin)
        .arg("serve")
        .env("NUNCHIRO_HOME", &core.home)
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    core.wait_ready();
    // V2.5-87 (ticket 301): the session is gone, so its recovered item is kept (on disk) but no longer shown.
    assert!(pending_now(&core, &session).is_empty());
    let item = stored(&core, &session.id).remove(0);
    assert!(!item.actionable);
    assert!(item.reconciled);
    assert!(
        core.request(Request::Answer {
            item: item.id,
            answer: nunchiro_core::queue::Answer::AllowOnce,
            confirmed: true
        })
        .is_err()
    );
    assert!(!core.home.join("never").exists());
}
#[test]
fn hook_timeout_is_bounded_and_prints_no_approval() {
    let core = Core::new();
    core.request(Request::Stop).unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    while core.home.join("core.sock").exists() {
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(10));
    }
    let listener = std::os::unix::net::UnixListener::bind(core.home.join("core.sock")).unwrap();
    // v1a-17: the hung core holds the request until the test has seen the hook give up; the bound frees a broken test.
    let (release, held) = std::sync::mpsc::channel::<()>();
    let hanging = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let _ = held.recv_timeout(Duration::from_secs(60));
        drop(socket);
    });
    let bin = cli::path();
    let mut command = home::git_env::scrubbed(bin);
    command
        .args(["hook", "PermissionRequest"])
        .env("NUNCHIRO_HOME", &core.home)
        .env("NUNCHIRO_SESSION", "s")
        .env("NUNCHIRO_TOKEN", "not-persisted")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"tool_name":"Bash"}"#)
        .unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "the hook waited for the hung core");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !hanging.is_finished(),
        "the hung core must still hold the request"
    );
    release.send(()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    hanging.join().unwrap();
    fs::remove_file(core.home.join("core.sock")).unwrap();
}
#[test]
fn persistent_trust_needs_confirmation_and_is_never_sent() {
    let core = Core::with_screen(
        "\x1b[2J\x1b[HTrust this folder?\r\n1. Trust and continue\r\n2. Quit\r\n",
    );
    let s = core.start();
    let item = core.pending(&s.id);
    let first = core
        .request(Request::Answer {
            item: item.id.clone(),
            answer: nunchiro_core::queue::Answer::Choose { index: 0 },
            confirmed: false,
        })
        .unwrap_err();
    assert!(first.contains("terminal"));
    let second = core
        .request(Request::Answer {
            item: item.id.clone(),
            answer: nunchiro_core::queue::Answer::Choose { index: 0 },
            confirmed: true,
        })
        .unwrap_err();
    assert!(second.contains("terminal"));
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: s.id.clone(),
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(!String::from_utf8_lossy(&data).contains("Done"));
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::Deny,
        confirmed: false,
    })
    .unwrap();
}
#[test]
fn question_answer_uses_selected_keys() {
    let core = Core::with_screen("\x1b[2J\x1b[HQuestion 1/1\r\n1. red\r\n2. blue\r\n");
    let s = core.start();
    let item = core.pending(&s.id);
    assert_eq!(item.kind, nunchiro_core::queue::Kind::Question);
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::Choose { index: 1 },
        confirmed: false,
    })
    .unwrap();
    thread::sleep(Duration::from_millis(50));
    let Reply::Output { data, .. } = core.request(Request::Read { id: s.id, after: 0 }).unwrap()
    else {
        panic!()
    };
    assert!(String::from_utf8_lossy(&data).contains("Done 2"));
}
#[test]
fn bad_transcript_does_not_disable_screen_or_shutdown() {
    let core = Core::new();
    let s = core.start();
    let dir = core.home.join("claude-home/projects").join(
        core.home
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>(),
    );
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
    fs::write(&path, "{not-json}\n").unwrap();
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "SessionStart".into(),
        payload: serde_json::json!({"transcript_path":path}),
    })
    .unwrap();
    let item = core.pending(&s.id);
    assert!(item.sources.contains("screen"));
    core.request(Request::Stop).unwrap();
}
/// Ticket 1149: a Codex start with its own arguments (so none of Nunchiro's other hooks) still gets the outward hook,
/// and the hook itself (`nunchiro hook outward --codex`, as Codex runs it before a tool) holds for the card. Codex has
/// no "ask" and lets a tool run when a hook fails, so everything but the owner's allow is a deny: no window to ask,
/// a deny on the card. An outward card is never one "allow always" covers, and another call asks nothing.
#[test]
fn t1149_codex_outward_hook_asks_on_a_card_and_fails_closed() {
    let core = Core::new();
    std::os::unix::fs::symlink(
        cli::path().canonicalize().unwrap(),
        core.home.join("bridge-cli"),
    )
    .unwrap();
    // Runs the hook once per `call-N.json`, as Codex does before each tool call; what it printed is `out-N.txt`.
    fs::write(
        core.home.join("codex"),
        home::codex_fake("#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi\nprintf '%s\\n' \"$@\" > argv.txt\nn=0\nwhile :; do\n  if [ -f call-$n.json ]; then\n    \"$NUNCHIRO_HOME/bridge-cli\" hook outward --codex < call-$n.json > out-$n.tmp 2>> err.txt\n    mv out-$n.tmp out-$n.txt\n    n=$((n+1))\n  fi\n  sleep 0.05\ndone\n"),
    )
    .unwrap();
    let Reply::Started { session: s } = core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: core.home.clone(),
                worktree: false,
                label: "test".into(),
                args: vec!["-m".into(), "fixture".into()],
                model: None,
                effort: None,
                resume: None,
            },
        })
        .unwrap()
    else {
        panic!()
    };
    let wait_file = |name: &str| {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(text) = fs::read_to_string(core.home.join(name)) {
                break text;
            }
            assert!(Instant::now() < end, "{name} never appeared");
            thread::sleep(Duration::from_millis(20));
        }
    };
    let args = wait_file("argv.txt");
    // `|| exit 2`: a hook that cannot run refuses the call (Codex lets a tool run when its hook only fails).
    assert!(args.contains("hook outward --codex || exit 2"), "{args}");
    assert!(args.contains("trusted_hash="), "{args}");
    assert!(!args.contains("--dangerously-bypass-hook-trust"), "{args}");
    assert!(!args.contains("hook PermissionRequest"), "{args}");
    let call = |n: u32, tool: &str, input: serde_json::Value| {
        fs::write(
            core.home.join(format!("call-{n}.json")),
            serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input})
                .to_string(),
        )
        .unwrap();
    };
    let decision = |out: &str| -> (String, String) {
        let v: serde_json::Value = serde_json::from_str(out).unwrap();
        let inner = &v["hookSpecificOutput"];
        assert_eq!(inner["hookEventName"], "PreToolUse");
        (
            inner["permissionDecision"].as_str().unwrap().into(),
            inner["permissionDecisionReason"].as_str().unwrap().into(),
        )
    };
    let card = || {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(item) = pending_now(&core, &s)
                .into_iter()
                .find(|i| i.hook_event_id.is_some())
            {
                break item;
            }
            assert!(Instant::now() < end, "no card");
            core.request(Request::QueueConnect).unwrap();
            thread::sleep(Duration::from_millis(20));
        }
    };
    let answer = |item: &str, answer| {
        core.request(Request::Answer {
            item: item.into(),
            answer,
            confirmed: true,
        })
    };
    // No window to ask: the publish is refused at once, and no card is left that nothing could answer.
    call(0, "Bash", serde_json::json!({"command": "npm publish"}));
    let (verdict, why) = decision(&wait_file("out-0.txt"));
    assert_eq!(verdict, "deny");
    assert!(why.starts_with("Publish:"), "{why}");
    assert!(
        pending_now(&core, &s)
            .iter()
            .all(|i| i.hook_event_id.is_none())
    );
    // A window is there: the send waits on its card, which names the kind and offers no "allow always".
    core.request(Request::QueueConnect).unwrap();
    call(
        1,
        "mcp__fake__send_message",
        serde_json::json!({"body": "b"}),
    );
    let item = card();
    assert_eq!(item.kind, nunchiro_core::queue::Kind::Permission);
    assert_eq!(item.outward.as_deref(), Some("post"));
    assert!(item.risky);
    assert_eq!(item.allow_always, None);
    assert!(answer(&item.id, nunchiro_core::queue::Answer::AllowAlways).is_err());
    assert!(
        !core.home.join("out-1.txt").exists(),
        "the hook answered before its card"
    );
    // The owner's allow: the hook says nothing and Codex runs the tool.
    answer(&item.id, nunchiro_core::queue::Answer::AllowOnce).unwrap();
    assert_eq!(wait_file("out-1.txt"), "");
    // The owner's deny refuses the call.
    core.request(Request::QueueConnect).unwrap();
    call(
        2,
        "Bash",
        serde_json::json!({"command": "gh release create v1"}),
    );
    let item = card();
    assert_eq!(item.outward.as_deref(), Some("publish"));
    answer(&item.id, nunchiro_core::queue::Answer::Deny).unwrap();
    assert_eq!(decision(&wait_file("out-2.txt")).0, "deny");
    // Any other call asks nothing, and a call the hook cannot read is refused.
    call(
        3,
        "Bash",
        serde_json::json!({"command": "git push origin main"}),
    );
    assert_eq!(wait_file("out-3.txt"), "");
    fs::write(core.home.join("call-4.json"), "not json").unwrap();
    assert_eq!(decision(&wait_file("out-4.txt")).0, "deny");
    // Round 2: the owner never allows what the card does not show. A field the card would leave out (the journal
    // drops fields named like a secret) or a call too large for a card is refused, not asked.
    core.request(Request::QueueConnect).unwrap();
    call(
        5,
        "mcp__fake__send_message",
        serde_json::json!({"body": "b", "token": "hidden words"}),
    );
    let (verdict, why) = decision(&wait_file("out-5.txt"));
    assert_eq!(verdict, "deny");
    assert!(why.contains("cannot be shown whole"), "{why}");
    call(
        6,
        "Bash",
        serde_json::json!({"command": format!("echo {}; npm publish", "a".repeat(70_000))}),
    );
    let (verdict, why) = decision(&wait_file("out-6.txt"));
    assert_eq!(verdict, "deny");
    assert!(why.contains("cannot be shown whole"), "{why}");
    assert!(
        pending_now(&core, &s)
            .iter()
            .all(|i| i.hook_event_id.is_none())
    );
}
#[test]
fn codex_waiting_works_with_injected_hooks_enabled_and_disabled() {
    for disabled in [false, true] {
        let core = Core::configured(
            "\x1b[2J\x1b[HWould you like to run the following command\r\n1. Yes, proceed (y)\r\n2. No\r\n",
            disabled,
        );
        let s = core.start_kind(AgentKind::Codex);
        let item = core.pending(&s.id);
        assert_eq!(item.kind, nunchiro_core::queue::Kind::Permission);
        let args = fs::read_to_string(core.home.join("argv.txt")).unwrap();
        assert_eq!(args.contains("--dangerously-bypass-hook-trust"), !disabled);
        assert_eq!(args.contains("hook PermissionRequest"), !disabled);
        assert!(args.contains("hook outward --codex"), "{args}"); // ticket 1149: with or without the others
        core.request(Request::Answer {
            item: item.id,
            answer: nunchiro_core::queue::Answer::Deny,
            confirmed: false,
        })
        .unwrap();
    }
}
#[test]
fn hook_cannot_redirect_transcript_reader_to_arbitrary_user_data() {
    let core = Core::new();
    let s = core.start();
    let path = core.home.join("credentials.json");
    fs::write(&path, r#"{"token":"never-read"}"#).unwrap();
    let response = core.request(Request::Hook {
        id: s.id,
        event: "SessionStart".into(),
        payload: serde_json::json!({"transcript_path":path}),
    });
    assert!(response.is_err());
}
#[test]
fn vanished_prompt_cannot_receive_a_queued_answer() {
    let core = Core::new();
    let s = core.start();
    let item = core.pending(&s.id);
    // A later tool/agent output redraws a normal composer before the user answers.
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "\n".into(),
        composer: false,
        seen: vec![],
    })
    .unwrap();
    thread::sleep(Duration::from_millis(60));
    let response = core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    });
    assert!(response.is_err(), "stale prompt answer was accepted");
    let Reply::Output { data, .. } = core.request(Request::Read { id: s.id, after: 0 }).unwrap()
    else {
        panic!()
    };
    assert!(!String::from_utf8_lossy(&data).ends_with("1\r\n"));
}
#[test]
fn queue_write_failure_cannot_prevent_stopping_owned_agents() {
    let mut core = Core::new();
    let s = core.start();
    core.pending(&s.id);
    fs::remove_file(core.home.join("queue.json")).unwrap();
    fs::create_dir(core.home.join("queue.json")).unwrap();
    core.request(Request::Stop)
        .expect("stop must remain available when queue persistence fails");
    let end = Instant::now() + Duration::from_secs(2);
    while core.process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < end, "core did not stop");
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn explicit_resume_rebinds_pending_state_and_waits_for_a_new_user_answer() {
    let mut core = Core::new();
    let old = core.start();
    core.pending(&old.id);
    for event in ["UserPromptSubmit", "Stop", "PermissionRequest"] {
        core.request(Request::Hook {
            id: old.id.clone(),
            event: event.into(),
            payload: serde_json::json!({"prompt_id":"previous-turn","tool_name":"Bash"}),
        })
        .unwrap();
    }
    let old_item = core.pending(&old.id);
    core.request(Request::Stop).unwrap();
    core.process.wait().unwrap();
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let bin = cli::path();
    core.process = home::git_env::scrubbed(bin)
        .arg("serve")
        .env("NUNCHIRO_HOME", &core.home)
        .env("PATH", format!("{}:/usr/bin:/bin", core.home.display()))
        .env("CLAUDE_CONFIG_DIR", core.home.join("claude-home"))
        .env("CODEX_HOME", core.home.join("codex-home"))
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    core.wait_ready();
    let Reply::Started { session: new } = core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: core.home.clone(),
                worktree: false,
                label: "resumed".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: old.agent_session_id.clone(),
            },
        })
        .unwrap()
    else {
        panic!()
    };
    assert_ne!(new.id, old.id);
    assert_eq!(new.completion_seq, 1);
    assert_eq!(new.agent_session_id, old.agent_session_id);
    let restored = core.pending(&new.id);
    assert!(restored.reconciled);
    assert!(!restored.actionable);
    assert_ne!(restored.id, old_item.id);
    for item in [old_item.id, restored.id.clone()] {
        assert!(
            core.request(Request::Answer {
                item,
                answer: nunchiro_core::queue::Answer::AllowOnce,
                confirmed: true
            })
            .is_err()
        );
    }
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: new.id.clone(),
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    // v1a-40 (coordinator ruling on needs 32/57): the old run's output may be shown above the resume marker,
    // display only; nothing after the marker before a fresh prompt.
    let text = String::from_utf8_lossy(&data);
    let (_, after) = text
        .split_once("resumed; earlier output above")
        .expect("seed ends with the resume marker");
    assert_eq!(
        after, " —\x1b[0m\r\n",
        "resume replayed input or an approval after the resume marker before a fresh prompt"
    );
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let until = Instant::now() + Duration::from_secs(1);
    let fresh = loop {
        let i = core.pending(&new.id);
        if i.actionable && !i.reconciled {
            break i;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    };
    assert_ne!(fresh.id, restored.id);
    assert!(
        core.request(Request::Answer {
            item: restored.id,
            answer: nunchiro_core::queue::Answer::AllowOnce,
            confirmed: true,
        })
        .is_err()
    );
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: new.id.clone(),
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(!String::from_utf8_lossy(&data).contains("Done"));
    core.request(Request::Answer {
        item: fresh.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    thread::sleep(Duration::from_millis(50));
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: new.id,
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(String::from_utf8_lossy(&data).contains("Done 1"));
}
// v1a-40: a resumed session's replay starts with the old run's scrollback; a permission prompt in it is history,
// never the current screen, and gives no answerable item.
#[test]
fn a_permission_prompt_in_the_resume_seed_is_never_current_or_answerable() {
    let mut core = Core::new();
    let old = core.start();
    assert!(core.pending(&old.id).sources.contains("screen"));
    core.request(Request::Stop).unwrap();
    core.process.wait().unwrap();
    // The resumed agent prints nothing, so only the seed holds a prompt.
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let bin = cli::path();
    core.process = home::git_env::scrubbed(bin)
        .arg("serve")
        .env("NUNCHIRO_HOME", &core.home)
        .env("PATH", format!("{}:/usr/bin:/bin", core.home.display()))
        .env("CLAUDE_CONFIG_DIR", core.home.join("claude-home"))
        .env("CODEX_HOME", core.home.join("codex-home"))
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    core.wait_ready();
    let Reply::Started { session: new } = core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: core.home.clone(),
                worktree: false,
                label: "resumed".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: old.agent_session_id.clone(),
            },
        })
        .unwrap()
    else {
        panic!()
    };
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: new.id.clone(),
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    let text = String::from_utf8_lossy(&data);
    let marker = text
        .find("resumed; earlier output above")
        .expect("seed with marker");
    assert!(text[..marker].contains("Do you want to proceed?"));
    // Each request runs a screen observation pass first, so these snapshots have seen the whole replay.
    for _ in 0..3 {
        let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
            panic!()
        };
        let session = sessions.iter().find(|s| s.id == new.id).unwrap();
        for item in &session.pending {
            assert!(item.reconciled && !item.actionable, "{item:?}");
            assert!(
                core.request(Request::Answer {
                    item: item.id.clone(),
                    answer: nunchiro_core::queue::Answer::AllowOnce,
                    confirmed: true,
                })
                .is_err(),
                "an item from the seed was answerable"
            );
        }
    }
    fs::remove_file(core.home.join("hold-screen")).unwrap();
}
#[test]
fn hook_timeout_and_disconnect_expose_native_prompt_while_pty_owner_stays_alive() {
    for timeout in [false, true] {
        let mut core = Core::new();
        let bridge = core.home.join("h");
        fs::create_dir(&bridge).unwrap();
        fs::write(core.home.join("bridge"), "").unwrap();
        let bin = cli::path().canonicalize().unwrap();
        std::os::unix::fs::symlink(bin, core.home.join("bridge-cli")).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(bridge.join("core.sock")).unwrap();
        listener.set_nonblocking(true).unwrap();
        let receiver = thread::spawn(move || {
            use std::io::BufRead;
            let until = Instant::now() + Duration::from_secs(3);
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < until, "hook did not connect");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut line = String::new();
            std::io::BufReader::new(&mut socket)
                .read_line(&mut line)
                .unwrap();
            assert!(!line.is_empty());
            if timeout {
                thread::sleep(Duration::from_secs(3));
            }
        });
        let session = core.start();
        let began = Instant::now();
        let until = began + Duration::from_millis(2400);
        let data = loop {
            let Reply::Output { data, .. } = core
                .request(Request::Read {
                    id: session.id.clone(),
                    after: 0,
                })
                .unwrap()
            else {
                panic!()
            };
            if String::from_utf8_lossy(&data).contains("Do you want to proceed?") {
                break data;
            }
            assert!(Instant::now() < until, "hook did not fall back");
            thread::sleep(Duration::from_millis(10));
        };
        assert!(
            core.process.try_wait().unwrap().is_none(),
            "PTY owner exited"
        );
        assert!(!String::from_utf8_lossy(&data).contains("Done"));
        let item = core.pending(&session.id);
        assert!(item.sources.contains("screen"));
        assert_eq!(
            nunchiro_core::queue::journal::read(&bridge, nunchiro_core::queue::now_ms())
                .unwrap()
                .len(),
            1
        );
        core.request(Request::Answer {
            item: item.id,
            answer: nunchiro_core::queue::Answer::AllowOnce,
            confirmed: true,
        })
        .unwrap();
        thread::sleep(Duration::from_millis(50));
        let Reply::Output { data, .. } = core
            .request(Request::Read {
                id: session.id,
                after: 0,
            })
            .unwrap()
        else {
            panic!()
        };
        assert!(String::from_utf8_lossy(&data).contains("Done 1"));
        receiver.join().unwrap();
    }
}

#[test]
fn dialogs_never_type_choices_even_when_labels_look_temporary() {
    for screen in [
        "\x1b[2J\x1b[HAllow external CLAUDE.md file imports?\r\n1. Yes\r\n2. No\r\n",
        "\x1b[2J\x1b[HTrust this folder?\r\n1. Yes, proceed\r\n2. No, exit\r\n",
    ] {
        let core = Core::with_screen(screen);
        let s = core.start();
        let item = core.pending(&s.id);
        assert_eq!(item.kind, nunchiro_core::queue::Kind::Dialog);
        for confirmed in [false, true] {
            for index in [0, 1] {
                assert!(
                    core.request(Request::Answer {
                        item: item.id.clone(),
                        answer: nunchiro_core::queue::Answer::Choose { index },
                        confirmed
                    })
                    .is_err(),
                    "dialog option was typed"
                );
            }
        }
        let Reply::Output { data, .. } =
            core.request(Request::Read { id: s.id, after: 0 }).unwrap()
        else {
            panic!()
        };
        assert!(!String::from_utf8_lossy(&data).contains("Done"));
        core.request(Request::Answer {
            item: item.id,
            answer: nunchiro_core::queue::Answer::Deny,
            confirmed: false,
        })
        .unwrap();
    }
}

impl Core {
    fn boot_again(&mut self) {
        let bin = cli::path();
        self.process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &self.home)
            .env("PATH", format!("{}:/usr/bin:/bin", self.home.display()))
            .env("CLAUDE_CONFIG_DIR", self.home.join("claude-home"))
            .env("CODEX_HOME", self.home.join("codex-home"))
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(self.home.join("recovery.log")).unwrap())
            .spawn()
            .unwrap();
        self.wait_ready();
    }
}
#[test]
fn journal_unknown_and_malformed_events_are_quarantined_without_blocking_start() {
    use nunchiro_core::queue::journal::{self, Event};
    let mut core = Core::new();
    let session = core.start();
    core.request(Request::Stop).unwrap();
    core.process.wait().unwrap();
    let e = Event::new(
        "unknown-session".into(),
        "Stop".into(),
        serde_json::json!({}),
    )
    .unwrap();
    let path = journal::write(&core.home, &e).unwrap();
    let bytes = fs::read(&path).unwrap();
    fs::write(core.home.join("hook-journal/bad.json"), b"{broken").unwrap();
    core.boot_again();
    let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
        panic!()
    };
    assert!(
        sessions
            .iter()
            .find(|s| s.id == session.id)
            .unwrap()
            .attention
            .observer_error
            .as_ref()
            .unwrap()
            .contains("quarantin")
    );
    let dir = core.home.join("hook-journal-quarantine");
    assert_eq!(
        fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 2);
    assert!(files.iter().any(|p| fs::read(p).unwrap() == bytes));
    assert!(files.iter().any(|p| fs::read(p).unwrap() == b"{broken"));
    for p in files {
        assert_eq!(fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(
        fs::read_to_string(core.home.join("recovery.log"))
            .unwrap()
            .contains("quarantin")
    );
}
#[test]
fn journal_pending_overflow_is_quarantined_and_core_still_starts() {
    use nunchiro_core::queue::journal::{self, Event};
    let mut core = Core::with_screen("");
    let session = core.start();
    core.request(Request::Stop).unwrap();
    core.process.wait().unwrap();
    let dir = core.home.join("hook-journal");
    fs::create_dir_all(&dir).unwrap();
    for n in 0..137 {
        let e = Event::new(
            session.id.clone(),
            "PermissionRequest".into(),
            serde_json::json!({"agent_id":format!("worker-{n}"),"tool_name":"Bash"}),
        )
        .unwrap();
        fs::write(
            dir.join(format!("{}.json", e.event_id)),
            serde_json::to_vec(&e).unwrap(),
        )
        .unwrap();
    }
    core.boot_again();
    let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
        panic!()
    };
    let s = sessions.iter().find(|s| s.id == session.id).unwrap();
    // V2.5-87 (ticket 301): the session is gone, so its replayed items are kept (on disk) but no longer shown.
    assert!(s.pending.is_empty());
    let kept = stored(&core, &session.id);
    assert_eq!(kept.len(), 64);
    assert!(kept.iter().all(|i| !i.actionable));
    assert_eq!(
        fs::read_dir(core.home.join("hook-journal-quarantine"))
            .unwrap()
            .count(),
        nunchiro_core::queue::journal::QUARANTINE_MAX_FILES // 73 rejected, oldest 9 pruned
    );
    assert!(
        journal::read(&core.home, nunchiro_core::queue::now_ms())
            .unwrap()
            .is_empty()
    );
}

// v1a-17: the transcript read is held by a gate rather than timed (a FIFO no longer blocks the non-blocking open).
#[cfg(target_os = "macos")]
#[test]
fn blocked_transcript_io_does_not_hold_the_registry_mutex() {
    let shim = hold::Shim::build(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hold-open.c"),
    );
    let core = Core::launched(
        "\x1b[2J\x1b[HDo you want to proceed?\r\n1. Yes\r\n2. No\r\n",
        false,
        Some(&shim.dylib),
    );
    let s = core.start();
    let dir = core.home.join("claude-home/projects").join(
        core.home
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>(),
    );
    fs::create_dir_all(&dir).unwrap();
    let name = format!("/{}.jsonl", s.agent_session_id.as_ref().unwrap());
    let path = PathBuf::from(format!("{}{name}", dir.display()));
    fs::write(&path, "").unwrap();
    let held = hold::Hold::new(core.home.join("hold-open"), "");
    fs::write(core.home.join("hold-suffix"), &name).unwrap();
    core.request(Request::Hook {
        id: s.id,
        event: "SessionStart".into(),
        payload: serde_json::json!({"transcript_path":path}),
    })
    .unwrap();
    hold::reached(
        &core.home.join("opened"),
        "the transcript observer never opened the transcript",
    );
    // The observer is parked opening the transcript; a registry it held would keep this waiting out the hold.
    core.request(Request::Snapshot).unwrap();
    assert!(
        !core.home.join("open-released").exists(),
        "the transcript read must still be held"
    );
    held.release();
    hold::reached(
        &core.home.join("open-released"),
        "the held transcript read never went on",
    );
}

#[test]
fn valid_hook_decision_is_printed_even_if_journal_cleanup_fails() {
    use std::io::{BufRead, Write};
    let core = Core::new();
    let home = core.home.join("h");
    fs::create_dir(&home).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    let server_home = home.clone();
    let receiver = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(&mut stream)
            .read_line(&mut line)
            .unwrap();
        let envelope: serde_json::Value = serde_json::from_str(&line).unwrap();
        let id = envelope["request"]["payload"]["nunchiro_event_id"]
            .as_str()
            .unwrap();
        let path = server_home.join("hook-journal").join(format!("{id}.json"));
        fs::remove_file(&path).unwrap();
        fs::create_dir(path).unwrap();
        let response: Response = Ok(Reply::HookDecision {
            decision: Some(serde_json::json!({"explicit_decision":"allow_once"})),
        });
        writeln!(stream, "{}", serde_json::to_string(&response).unwrap()).unwrap();
    });
    let bin = cli::path();
    let mut hook = home::git_env::scrubbed(bin)
        .args(["hook", "PermissionRequest"])
        .env("NUNCHIRO_HOME", home)
        .env("NUNCHIRO_SESSION", "s")
        .env("NUNCHIRO_TOKEN", "fixture-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    hook.stdin.take().unwrap().write_all(b"{}").unwrap();
    let out = hook.wait_with_output().unwrap();
    receiver.join().unwrap();
    assert!(out.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap(),
        serde_json::json!({"explicit_decision":"allow_once"})
    );
}

#[test]
fn nonregular_transcript_cannot_hold_shutdown_or_screen_observation() {
    use std::os::unix::ffi::OsStrExt;
    let mut core = Core::new();
    let s = core.start();
    let dir = core.home.join("claude-home/projects").join(
        core.home
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>(),
    );
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "SessionStart".into(),
        payload: serde_json::json!({"transcript_path":path}),
    })
    .unwrap();
    core.pending(&s.id);
    thread::sleep(Duration::from_millis(100));
    core.request(Request::Stop).unwrap();
    // A FIFO opened blocking holds the core forever; a plain stop takes 0.3-0.5 s on the MacBook at load 13 with a
    // FIFO or a regular file alike, and over 1 s under the gate's parallel tests (V2.5-41), so the bound sits well
    // past a slow stop and far short of a hold.
    let until = Instant::now() + Duration::from_secs(10);
    while core.process.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < until,
            "nonregular transcript prevented core shutdown"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

// v1b-12: Claude Code 2.1.310 edit prompts are permissions (screen text from the v1b-12 round-1 real run).
const EDIT_PROMPT: &str = "\x1b[2J\x1b[H\u{23fa} Update(a.txt)\r\n\r\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n Edit file\r\n a.txt\r\n\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\r\n 1 -original line\r\n 1 +edited by agent\r\n\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\u{254c}\r\n\r\n Do you want to make this edit to a.txt?\r\n \u{276f} 1. Yes\r\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\r\n   3. No\r\n\r\n Esc to cancel \u{b7} Tab to amend\r\n";

#[test]
fn claude_edit_create_and_overwrite_prompts_are_permissions_and_dialogs_stay_dialogs() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    let detect = |text: &str| {
        let mut screen = Screen::new(160, 50);
        screen.feed(text.as_bytes());
        screen
            .detect(AgentKind::Claude)
            .map(|d| (d.kind, d.choices))
    };
    for prompt in [
        EDIT_PROMPT.to_string(),
        EDIT_PROMPT.replace(
            "Do you want to make this edit to a.txt?",
            "Do you want to create new.txt?",
        ),
        EDIT_PROMPT.replace(
            "Do you want to make this edit to a.txt?",
            "Do you want to overwrite a.txt?",
        ),
    ] {
        let (kind, choices) = detect(&prompt).expect("prompt detected");
        assert_eq!(kind, Kind::Permission, "{prompt}");
        // Only "1. Yes" allows once; "Yes, and switch to accept edits" changes settings.
        assert_eq!(
            choices
                .iter()
                .map(|c| c.changes_settings)
                .collect::<Vec<_>>(),
            [false, true, false]
        );
    }
    for dialog in [
        "Trust this folder?\r\n1. Trust and continue\r\n2. Quit",
        "Is this a project you created or one you trust?\r\n\u{276f} 1. Yes, proceed\r\n  2. No, exit\r\nEnter to confirm",
        "Allow external CLAUDE.md file imports?\r\n1. Yes\r\n2. No",
        "Do you want to work in this directory?\r\n\u{276f} 1. Yes, continue\r\n  2. No, exit\r\nEnter to confirm",
        "Pick a theme\r\n> 1. Dark\r\n  2. Light\r\nEsc to cancel",
    ] {
        assert_eq!(
            detect(dialog).expect("dialog detected").0,
            Kind::Dialog,
            "{dialog}"
        );
    }
    // A question that happens to ask the same words stays a question (allow once must never answer it).
    let question = "Do you want to create a new component?\r\n\u{276f} 1. Yes, a page\r\n  2. No\r\nEnter to select \u{b7} Esc to cancel";
    assert_eq!(
        detect(question).expect("question detected").0,
        Kind::Question
    );
    // Agent prose at the idle prompt is no prompt: no choices, no "Esc to cancel".
    let prose = "\u{23fa} Done. Do you want to create a test for it next?\r\n\r\n\u{276f} \r\n  ? for shortcuts";
    assert!(detect(prose).is_none(), "prose became a prompt");
}

#[test]
fn hook_permission_keeps_its_tool_input_through_the_screen_edit_prompt() {
    let core = Core::with_screen(EDIT_PROMPT);
    // The agent asks through its hook before it draws the prompt, as Claude does.
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start();
    let input = serde_json::json!({"file_path":"/p/a.txt","old_string":"original line","new_string":"edited by agent","replace_all":false});
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "PermissionRequest".into(),
        payload: serde_json::json!({"tool_name":"Edit","tool_input":input,"nunchiro_event_id":"edit-1"}),
    })
    .unwrap();
    let hooked = core.pending(&s.id);
    assert_eq!(hooked.kind, nunchiro_core::queue::Kind::Permission);
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    let item = loop {
        let item = core.pending(&s.id);
        if item.sources.contains("screen") {
            break item;
        }
        assert!(Instant::now() < end, "screen never observed the prompt");
        thread::sleep(Duration::from_millis(10));
    };
    // Same item, same kind, the hook's tool input as its text, the screen's choices added.
    assert_eq!(item.id, hooked.id);
    assert_eq!(item.kind, nunchiro_core::queue::Kind::Permission);
    assert!(item.sources.contains("hook"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&item.text).unwrap(),
        input
    );
    assert_eq!(item.choices.len(), 3);
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        core.pending(&s.id).text,
        item.text,
        "a later screen poll replaced the hook text"
    );
    // Allow once types the "Yes" choice, never "Yes, and switch to accept edits".
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    thread::sleep(Duration::from_millis(80));
    let Reply::Output { data, .. } = core.request(Request::Read { id: s.id, after: 0 }).unwrap()
    else {
        panic!()
    };
    assert!(String::from_utf8_lossy(&data).contains("Done 1"));
}

#[test]
fn a_late_answer_never_types_into_a_prompt_that_replaced_the_hook_request() {
    let core = Core::with_screen(EDIT_PROMPT);
    // This fake swaps to a Bash prompt (with "Read a.txt" in its scrollback) once `swap` exists, and echoes any input.
    fs::write(
        core.home.join("swap.txt"),
        "\x1b[2J\x1b[H\u{276f} Read a.txt, then edit it\r\n\r\n\u{23fa} Bash(rm -rf ~/important)\r\n\r\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n Bash command\r\n\r\n   rm -rf ~/important\r\n\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n",
    )
    .unwrap();
    fs::write(
        core.home.join("claude"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\ncat screen.txt\nwhile [ ! -f swap ]; do sleep 0.01; done\ncat swap.txt\nread x\nprintf 'TYPED %s' \"$x\"\nsleep 30\n",
    )
    .unwrap();
    let s = core.start();
    let input = serde_json::json!({"file_path":"/p/a.txt","old_string":"original line","new_string":"edited by agent","replace_all":false});
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "PermissionRequest".into(),
        payload: serde_json::json!({"tool_name":"Edit","tool_input":input,"nunchiro_event_id":"edit-1"}),
    })
    .unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    let held = loop {
        let item = core.pending(&s.id);
        if item.sources.contains("hook") && item.sources.contains("screen") {
            break item;
        }
        assert!(
            Instant::now() < end,
            "the edit prompt never joined the hook item"
        );
        thread::sleep(Duration::from_millis(10));
    };
    // The agent's prompt is replaced before the owner answers the edit's card (its hook has already returned).
    fs::write(core.home.join("swap"), "").unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    while core.pending(&s.id).id == held.id {
        assert!(
            Instant::now() < end,
            "the held edit item survived the Bash prompt"
        );
        thread::sleep(Duration::from_millis(10));
    }
    for answer in [
        nunchiro_core::queue::Answer::AllowOnce,
        nunchiro_core::queue::Answer::Deny,
    ] {
        assert!(
            core.request(Request::Answer {
                item: held.id.clone(),
                answer,
                confirmed: false
            })
            .is_err()
        );
    }
    thread::sleep(Duration::from_millis(150));
    let Reply::Output { data, .. } = core.request(Request::Read { id: s.id, after: 0 }).unwrap()
    else {
        panic!()
    };
    assert!(
        !String::from_utf8_lossy(&data).contains("TYPED"),
        "a key reached the replaced prompt"
    );
}

// v1b-27: the synthetic Codex 0.161.0 approval frame (its fixture header says how it was built), as the fake
// agent prints it.
fn codex_prompt() -> String {
    let raw = include_str!("fixtures/codex-approval/0.161.0-synthetic-frame.txt");
    let frame = raw.split_once("=== own\n").unwrap().1.trim_end();
    format!("\x1b[2J\x1b[H{}\r\n", frame.replace('\n', "\r\n"))
}

fn codex_hook(core: &Core, s: &Session, command: &str) {
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "PermissionRequest".into(),
        payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":command},"nunchiro_event_id":"codex-1"}),
    })
    .unwrap();
}

fn output(core: &Core, s: &Session) -> String {
    let Reply::Output { data, .. } = core
        .request(Request::Read {
            id: s.id.clone(),
            after: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    String::from_utf8_lossy(&data).into_owned()
}

#[test]
fn codex_approval_prompt_is_a_permission_and_a_late_answer_needs_its_own_request() {
    let core = Core::with_screen(&codex_prompt());
    let s = core.start_kind(AgentKind::Codex);
    codex_hook(&core, &s, "touch done");
    let end = Instant::now() + Duration::from_secs(2);
    let item = loop {
        let item = core.pending(&s.id);
        if item.sources.contains("hook") && item.sources.contains("screen") {
            break item;
        }
        assert!(
            Instant::now() < end,
            "the Codex prompt never joined its hook item"
        );
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(item.kind, nunchiro_core::queue::Kind::Permission);
    // Only "Yes, proceed" allows once; "don't ask again" changes settings.
    assert_eq!(
        item.choices
            .iter()
            .map(|c| (c.allows_once(), c.changes_settings))
            .collect::<Vec<_>>(),
        [(true, false), (false, true), (false, false)]
    );
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    thread::sleep(Duration::from_millis(80));
    assert!(output(&core, &s).contains("Done 1"));
}

#[test]
fn a_different_codex_approval_prompt_is_refused() {
    // The hook asks for one command while the prompt on screen runs another: the item never takes that screen.
    let core = Core::with_screen(&codex_prompt().replace("$ touch done", "$ rm -rf ~/important"));
    let s = core.start_kind(AgentKind::Codex);
    codex_hook(&core, &s, "touch done");
    thread::sleep(Duration::from_millis(300));
    let item = core.pending(&s.id);
    assert!(
        !(item.sources.contains("hook") && item.sources.contains("screen")),
        "a different command joined the hook item"
    );
    let hooked = item.sources.contains("hook").then_some(item.id);
    if let Some(id) = hooked {
        let _ = core.request(Request::Answer {
            item: id,
            answer: nunchiro_core::queue::Answer::AllowOnce,
            confirmed: true,
        });
    }
    thread::sleep(Duration::from_millis(150));
    assert!(
        !output(&core, &s).contains("Done"),
        "a key reached the other prompt"
    );
    drop(core);
    // Its own prompt joins, then is replaced by another command's prompt before the owner answers.
    let core = Core::with_screen(&codex_prompt());
    fs::write(
        core.home.join("swap.txt"),
        codex_prompt().replace("$ touch done", "$ rm -rf ~/important"),
    )
    .unwrap();
    fs::write(
        core.home.join("codex"),
        home::codex_fake("#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi\ncat screen.txt\nwhile [ ! -f swap ]; do sleep 0.01; done\ncat swap.txt\nread x\nprintf 'TYPED %s' \"$x\"\nsleep 30\n"),
    )
    .unwrap();
    let s = core.start_kind(AgentKind::Codex);
    codex_hook(&core, &s, "touch done");
    let end = Instant::now() + Duration::from_secs(2);
    let held = loop {
        let item = core.pending(&s.id);
        if item.sources.contains("hook") && item.sources.contains("screen") {
            break item;
        }
        assert!(Instant::now() < end, "the own Codex prompt never joined");
        thread::sleep(Duration::from_millis(10));
    };
    fs::write(core.home.join("swap"), "").unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    while core.pending(&s.id).id == held.id {
        assert!(
            Instant::now() < end,
            "the held Codex item survived another prompt"
        );
        thread::sleep(Duration::from_millis(10));
    }
    for answer in [
        nunchiro_core::queue::Answer::AllowOnce,
        nunchiro_core::queue::Answer::Deny,
    ] {
        assert!(
            core.request(Request::Answer {
                item: held.id.clone(),
                answer,
                confirmed: false
            })
            .is_err()
        );
    }
    thread::sleep(Duration::from_millis(150));
    assert!(
        !output(&core, &s).contains("TYPED"),
        "a key reached the replaced prompt"
    );
}

// v1b-30: a prompt frame with the 1-column indent Claude draws, as the fake agent prints it.
fn claude_prompt(head: &str, body: &str, question: &str) -> String {
    let rule = "\u{2500}".repeat(80);
    let dash = "\u{254c}".repeat(80);
    format!(
        "\x1b[2J\x1b[H{rule}\r\n {head}\r\n{dash}\r\n{}\r\n{dash}\r\n {question}\r\n \u{276f} 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n",
        body.replace('\n', "\r\n")
    )
}

#[test]
fn refusal_leaves_the_item_pending_and_never_types() {
    let core = Core::new();
    // Prints the prompt once released, then logs the first byte it is sent (raw mode: no Enter needed).
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\nwhile [ -f hold-screen ]; do sleep 0.01; done\ncat screen.txt\nstty raw -echo\ndd bs=1 count=1 of=typed.log 2>/dev/null\nsleep 30\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    let edit = claude_prompt(
        "Edit file\r\n a.txt",
        " 1 -x\n 1 +a",
        "Do you want to make this edit to a.txt?",
    );
    let write = claude_prompt(
        "Create file\r\n b.txt",
        " 1 +hello",
        "Do you want to create b.txt?",
    );
    let bash = |body: &str| claude_prompt("Bash command", body, "Do you want to proceed?");
    let bash_input = |c: &str| serde_json::json!({"command":c});
    let cases = vec![
        (
            "edit trailing",
            edit,
            vec![(
                "Edit",
                serde_json::json!({"file_path":"/p/a.txt","old_string":"x ","new_string":"a"}),
            )],
        ),
        (
            "write trailing",
            write,
            vec![(
                "Write",
                serde_json::json!({"file_path":"/p/b.txt","content":"hello\t\n"}),
            )],
        ),
        (
            "bash trailing",
            bash(" touch a"),
            vec![("Bash", bash_input("touch a  "))],
        ),
        (
            "bash multi-line",
            bash(" touch a\n touch b"),
            vec![("Bash", bash_input("touch a\ntouch b"))],
        ),
        (
            "parallel hooks",
            bash(" touch a"),
            vec![
                ("Bash", bash_input("touch a")),
                ("Bash", bash_input("touch a")),
            ],
        ),
    ];
    for (name, screen, hooks) in cases {
        fs::write(core.home.join("screen.txt"), &screen).unwrap();
        fs::write(core.home.join("hold-screen"), "").unwrap();
        let s = core.start();
        for (n, (tool, input)) in hooks.iter().enumerate() {
            core.request(Request::Hook {
                id: s.id.clone(),
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":format!("{name}-{n}")}),
            })
            .unwrap();
        }
        let card = core.pending(&s.id);
        fs::remove_file(core.home.join("hold-screen")).unwrap();
        // The screen poll sees the prompt within this window (other tests here wait 300 ms).
        thread::sleep(Duration::from_millis(400));
        for answer in [
            nunchiro_core::queue::Answer::AllowOnce,
            nunchiro_core::queue::Answer::Deny,
            nunchiro_core::queue::Answer::Choose { index: 0 },
        ] {
            let refused = core
                .request(Request::Answer {
                    item: card.id.clone(),
                    answer,
                    confirmed: true, // V2-8e: past the card's risky gate, to the refusal under test,
                })
                .unwrap_err();
            assert!(
                refused.contains("answer in the terminal"),
                "{name}: {refused}"
            );
        }
        let now = core.pending(&s.id);
        assert_eq!(
            (now.id, now.text, now.choices, now.sources),
            (card.id, card.text, card.choices, card.sources),
            "{name}: the refused item changed"
        );
        thread::sleep(Duration::from_millis(100));
        let typed = fs::read(core.home.join("typed.log")).unwrap_or_default();
        assert!(typed.is_empty(), "{name}: {typed:?} reached the prompt");
        core.request(Request::Close { id: s.id }).unwrap();
    }
    // The hook path is unchanged for such a request: a live hook answers it.
    fs::write(core.home.join("screen.txt"), bash(" touch a")).unwrap();
    let s = core.start();
    core.request(Request::QueueConnect).unwrap();
    let (home, id) = (core.home.clone(), s.id.clone());
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"touch a  "},"nunchiro_event_id":"live-1"}),
            },
        )
    });
    let end = Instant::now() + Duration::from_secs(1);
    let item = loop {
        let item = core.pending(&s.id);
        if item.hook_event_id.as_deref() == Some("live-1") {
            break item;
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(10));
    };
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    let Reply::HookDecision {
        decision: Some(answer),
    } = hook.join().unwrap().unwrap()
    else {
        panic!("missing explicit answer")
    };
    assert_eq!(
        answer["hookSpecificOutput"]["decision"]["behavior"],
        "allow"
    );
    assert!(
        fs::read(core.home.join("typed.log"))
            .unwrap_or_default()
            .is_empty()
    );
}

#[test]
fn a_card_for_a_later_prompt_never_answers_for_the_unprovable_request() {
    // v1b-32
    let core = Core::new();
    // Prints the held request's prompt, swaps to a Bash prompt once `swap` exists, then logs every byte it is sent.
    fs::write(
        core.home.join("screen.txt"),
        claude_prompt(
            "Edit file\r\n a.txt",
            " 1 -x\n 1 +a",
            "Do you want to make this edit to a.txt?",
        ),
    )
    .unwrap();
    fs::write(
        core.home.join("swap.txt"),
        claude_prompt("Bash command", " touch b", "Do you want to proceed?"),
    )
    .unwrap();
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\ncat screen.txt\nwhile [ ! -f swap ]; do sleep 0.01; done\ncat swap.txt\nstty raw -echo\ncat > typed.log\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    let s = core.start();
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "PermissionRequest".into(),
        payload: serde_json::json!({"tool_name":"Edit","tool_input":{"file_path":"/p/a.txt","old_string":"x ","new_string":"a"},"nunchiro_event_id":"u1"}),
    })
    .unwrap();
    let held = core.pending(&s.id);
    thread::sleep(Duration::from_millis(400));
    fs::write(core.home.join("swap"), "").unwrap();
    let pending = || {
        let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
            panic!()
        };
        sessions.into_iter().find(|x| x.id == s.id).unwrap().pending
    };
    let end = Instant::now() + Duration::from_secs(2);
    let card = loop {
        let items = pending();
        if let Some(card) = items.iter().find(|i| i.id != held.id) {
            break card.clone();
        }
        assert!(Instant::now() < end, "the Bash prompt got no card");
        thread::sleep(Duration::from_millis(10));
    };
    // The held request is still refused, whatever the answer.
    for answer in [
        nunchiro_core::queue::Answer::AllowOnce,
        nunchiro_core::queue::Answer::Deny,
        nunchiro_core::queue::Answer::Choose { index: 0 },
    ] {
        let refused = core
            .request(Request::Answer {
                item: held.id.clone(),
                answer,
                confirmed: true, // V2-8e: past the card's risky gate, to the refusal under test,
            })
            .unwrap_err();
        assert!(refused.contains("answer in the terminal"), "{refused}");
    }
    let now = pending();
    assert!(
        now.iter()
            .any(|i| (&i.id, &i.text, &i.hook_event_id)
                == (&held.id, &held.text, &held.hook_event_id)),
        "the held item changed"
    );
    // v1b-32 r5: the new card is view-only (the queue cannot know every pending request): every answer is refused
    // and no byte reaches the agent.
    assert!(!card.actionable && card.screen_text.is_none() && card.choices.is_empty());
    for answer in [
        nunchiro_core::queue::Answer::AllowOnce,
        nunchiro_core::queue::Answer::Deny,
        nunchiro_core::queue::Answer::Choose { index: 0 },
    ] {
        assert!(
            core.request(Request::Answer {
                item: card.id.clone(),
                answer,
                confirmed: false,
            })
            .is_err()
        );
    }
    thread::sleep(Duration::from_millis(200));
    assert_eq!(fs::read(core.home.join("typed.log")).unwrap(), b"");
}

// v1a-71: a fake agent that prints the prompt, logs every byte it is sent, and prints `redraw.txt` (then removes it)
// whenever the test drops one in, the way an agent redraws after a resize.
fn redraw_core() -> (Core, Session) {
    redraw_core_with(" touch a b")
}

fn redraw_core_with(body: &str) -> (Core, Session) {
    let core = Core::with_screen(&bash_prompt(80, body));
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\ncat screen.txt\n(n=0; while [ $n -lt 3000 ]; do if [ -f redraw.txt ]; then cat redraw.txt; rm redraw.txt; fi; sleep 0.01; n=$((n+1)); done) &\nstty raw -echo\ndd bs=1 of=typed.log 2>/dev/null\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    let s = core.start();
    (core, s)
}

fn bash_prompt(width: usize, body: &str) -> String {
    prompt_with(width, body, "2. No")
}

fn prompt_with(width: usize, body: &str, second: &str) -> String {
    let rule = "\u{2500}".repeat(width);
    let dash = "\u{254c}".repeat(width);
    format!(
        "\x1b[2J\x1b[H{rule}\r\n Bash command\r\n{dash}\r\n{body}\r\n{dash}\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   {second}\r\n\r\n Esc to cancel\r\n"
    )
}

/// Hands `text` to the fake agent and waits until it printed it and the core had a few ticks to observe it.
fn draw(core: &Core, text: &str) {
    let tmp = core.home.join("redraw.tmp");
    fs::write(&tmp, text).unwrap();
    fs::rename(&tmp, core.home.join("redraw.txt")).unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    while core.home.join("redraw.txt").exists() {
        assert!(Instant::now() < end, "the fake agent never redrew");
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(200));
}

fn resize(core: &Core, s: &Session) {
    core.request(Request::Resize {
        id: s.id.clone(),
        cols: 60,
        rows: 50,
    })
    .unwrap();
}

fn pending_now(core: &Core, s: &Session) -> Vec<nunchiro_core::queue::Decision> {
    let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
        panic!()
    };
    sessions.into_iter().find(|x| x.id == s.id).unwrap().pending
}

/// The items the queue file keeps for a session, shown or not.
fn stored(core: &Core, id: &str) -> Vec<nunchiro_core::queue::Decision> {
    let disk: serde_json::Value =
        serde_json::from_slice(&fs::read(core.home.join("queue.json")).unwrap()).unwrap();
    serde_json::from_value(disk["sessions"][id]["items"].clone()).unwrap()
}
fn allow(core: &Core, id: &str) -> Response {
    core.request(Request::Answer {
        item: id.into(),
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
}

fn typed(core: &Core) -> Vec<u8> {
    thread::sleep(Duration::from_millis(200));
    fs::read(core.home.join("typed.log")).unwrap_or_default()
}

/// Asserts the redraw on screen got a new id and the old one is refused without a key reaching the agent.
fn assert_new_id(core: &Core, s: &Session, old: &str) {
    let now = pending_now(core, s);
    assert_eq!(now.len(), 1, "{now:?}");
    assert_ne!(now[0].id, old, "a changed or unrelated redraw kept the id");
    assert!(allow(core, old).is_err());
    assert_eq!(typed(core), b"");
}

#[test]
fn resize_redraw_keeps_the_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    // A partial chunk of the redraw: the rule and the header, no prompt yet.
    draw(
        &core,
        &format!(
            "\x1b[2J\x1b[H{}\r\n Bash command\r\n",
            "\u{2500}".repeat(60)
        ),
    );
    assert_eq!(
        pending_now(&core, &s)
            .iter()
            .map(|i| &i.id)
            .collect::<Vec<_>>(),
        [&item.id],
        "a partial redraw within the grace removed the item"
    );
    // The same prompt at the new width: shorter rules, the command wrapped.
    draw(
        &core,
        &bash_prompt(60, " touch a\n b".replace('\n', "\r\n").as_str()),
    );
    let now = pending_now(&core, &s);
    assert_eq!(now.len(), 1, "{now:?}");
    assert_eq!(now[0].id, item.id, "the redrawn prompt got a new id");
    assert_ne!(
        now[0].screen_text, item.screen_text,
        "screen_text must be the redraw's"
    );
    allow(&core, &item.id).unwrap();
    // The choice's own keys (its number and Enter), once.
    assert_eq!(typed(&core), b"1\r");
}

// The core's PTY and screen start at 160x50; a client that re-sends its current size (a remounted xterm) gets no
// SIGWINCH redraw from the agent, so the screen model must survive it.
#[test]
fn same_size_resize_keeps_prompt_answerable() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    for _ in 0..2 {
        core.request(Request::Resize {
            id: s.id.clone(),
            cols: 160,
            rows: 50,
        })
        .unwrap();
    }
    thread::sleep(Duration::from_millis(200));
    allow(&core, &item.id).unwrap();
    assert_eq!(typed(&core), b"1\r");
}

/// `kill -9` of the core, then a new one over the same home: the holder keeps the agent and its PTY size.
fn restart_core(core: &mut Core) {
    core.process.kill().unwrap();
    let _ = core.process.wait();
    core.process = home::git_env::scrubbed(cli::path())
        .arg("serve")
        .env("NUNCHIRO_HOME", &core.home)
        .env("CODEX_HOME", core.home.join("codex-home"))
        .env("CLAUDE_CONFIG_DIR", core.home.join("claude-home"))
        .env("PATH", format!("{}:/usr/bin:/bin", core.home.display()))
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    core.wait_ready();
}

fn pty_size_seen_by_agent(core: &Core, want: &str) {
    let end = Instant::now() + Duration::from_secs(10);
    while fs::read_to_string(core.home.join("size.log"))
        .unwrap_or_default()
        .trim()
        != want
    {
        assert!(
            Instant::now() < end,
            "the agent's PTY never became {want}: {:?}",
            fs::read_to_string(core.home.join("size.log"))
        );
        thread::sleep(Duration::from_millis(20));
    }
}

// The holder keeps the last client size across a core restart, but the new core's screen model starts at 160x50: a
// resize to 160x50 is then a real one, and must reach the PTY.
#[test]
fn reattach_then_resize_is_a_real_resize() {
    let mut core = Core::with_screen(&bash_prompt(80, " touch a b"));
    // The agent logs `rows cols` of its PTY on every SIGWINCH (sleep is foreground, so the trap runs between sleeps),
    // and once when the trap is set: a resize sent before that is a signal nobody catches, and it never logs.
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\ntrap 'stty size > size.log' WINCH\nstty size > size.log\ncat screen.txt\nstty raw -echo\nwhile :; do sleep 0.05; done\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    let s2 = core.start();
    pty_size_seen_by_agent(&core, "50 160");
    let resize_to = |core: &Core, cols, rows| {
        core.request(Request::Resize {
            id: s2.id.clone(),
            cols,
            rows,
        })
        .unwrap();
    };
    resize_to(&core, 100, 30);
    pty_size_seen_by_agent(&core, "30 100");
    restart_core(&mut core);
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let Reply::Snapshot { sessions, .. } = core.request(Request::Snapshot).unwrap() else {
            panic!()
        };
        if sessions
            .iter()
            .any(|x| x.id == s2.id && x.state == SessionState::Running)
        {
            break;
        }
        assert!(Instant::now() < end, "the session never reattached");
        thread::sleep(Duration::from_millis(50));
    }
    resize_to(&core, 160, 50);
    pty_size_seen_by_agent(&core, "50 160");
}

// Verify look (ticket 991 A11): a new PTY opens at the size the window last gave one, so a shell's first prompt is drawn
// at the window's width; at 160 columns the window's first resize reflowed it and the shell's redraw left it twice.
#[test]
fn new_pty_opens_at_the_window_size() {
    let core = Core::with_screen(&bash_prompt(80, " touch a b"));
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\ntrap 'stty size > size.log' WINCH\nstty size > size.log\ncat screen.txt\nstty raw -echo\nwhile :; do sleep 0.05; done\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    let first = core.start();
    pty_size_seen_by_agent(&core, "50 160");
    core.request(Request::Resize {
        id: first.id.clone(),
        cols: 100,
        rows: 30,
    })
    .unwrap();
    pty_size_seen_by_agent(&core, "30 100");
    // An agent keeps 160 columns until a terminal view shows it (its prompts are read unwrapped behind the chat).
    fs::remove_file(core.home.join("size.log")).unwrap();
    core.start();
    pty_size_seen_by_agent(&core, "50 160");
    // A shell opens at the window's size, so its first prompt is drawn once.
    fs::remove_file(core.home.join("size.log")).unwrap();
    let shell = core.start_kind(AgentKind::Shell);
    core.request(Request::SendText {
        id: shell.id,
        text: "stty size > size.log\r".into(),
        seen: vec![],
        composer: false,
    })
    .unwrap();
    pty_size_seen_by_agent(&core, "30 100");
}

/// A resize the holder refuses (over 500 columns) leaves the recorded PTY size unknown.
fn failed_resize(core: &Core, s: &Session) -> Response {
    core.request(Request::Resize {
        id: s.id.clone(),
        cols: 501,
        rows: 50,
    })
}

#[test]
fn failed_resize_forgets_pty_size() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    draw(&core, &bash_prompt(60, " touch a b"));
    assert!(failed_resize(&core, &s).is_err());
    // The recorded 60x50 is forgotten, so the same size is a real resize again: it blanks the screen.
    resize(&core, &s);
    assert!(allow(&core, &item.id).is_err());
    draw(&core, &bash_prompt(60, " touch a b"));
    allow(&core, &item.id).unwrap();
    assert_eq!(typed(&core), b"1\r");
}

#[test]
fn resize_error_is_returned_unchanged() {
    let (core, s) = redraw_core();
    assert_eq!(
        failed_resize(&core, &s).unwrap_err(),
        "invalid terminal dimensions"
    );
}

#[test]
fn real_resize_still_resets_and_redraws() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    // Blank until the agent redraws: the answer is refused, then the redraw makes it answerable again.
    assert!(allow(&core, &item.id).is_err());
    draw(&core, &bash_prompt(60, " touch a b"));
    allow(&core, &item.id).unwrap();
    assert_eq!(typed(&core), b"1\r");
}

#[test]
fn resize_then_other_command_gets_a_new_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    draw(&core, &bash_prompt(60, " touch a c"));
    assert_new_id(&core, &s, &item.id);
}

#[test]
fn redraw_without_resize_still_gets_a_new_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    draw(&core, &bash_prompt(60, " touch a\r\n b"));
    assert_new_id(&core, &s, &item.id);
}

#[test]
fn redraw_after_the_grace_gets_a_new_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    thread::sleep(Duration::from_millis(1700));
    draw(&core, &bash_prompt(60, " touch a\r\n b"));
    assert_new_id(&core, &s, &item.id);
}

#[test]
fn resize_redraw_with_changed_choices_gets_a_new_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    draw(
        &core,
        &prompt_with(60, " touch a b", "2. No, and tell Claude"),
    );
    assert_new_id(&core, &s, &item.id);
}

#[test]
fn a_prompt_that_goes_away_after_the_grace_is_cleared() {
    let (core, s) = redraw_core();
    core.pending(&s.id);
    resize(&core, &s);
    thread::sleep(Duration::from_millis(1700));
    draw(&core, "\x1b[2J\x1b[HDone\r\n");
    assert_eq!(pending_now(&core, &s), vec![]);
    // Without a resize too.
    draw(&core, &bash_prompt(80, " touch a b"));
    core.pending(&s.id);
    draw(&core, "\x1b[2J\x1b[HDone\r\n");
    assert_eq!(pending_now(&core, &s), vec![]);
}

#[test]
fn resize_then_a_space_changed_inside_a_line_gets_a_new_id() {
    // Security review r1: only line breaks are layout; a space inside a line is part of the command.
    let (core, s) = redraw_core_with(" rm -rf ./build/");
    let item = core.pending(&s.id);
    resize(&core, &s);
    draw(&core, &bash_prompt(60, " rm -rf ./build /"));
    assert_new_id(&core, &s, &item.id);
}

#[test]
fn a_prompt_that_goes_away_in_the_grace_is_cleared_when_it_ends() {
    let (core, s) = redraw_core();
    core.pending(&s.id);
    resize(&core, &s);
    draw(&core, "\x1b[2J\x1b[HDone\r\n");
    assert_eq!(pending_now(&core, &s).len(), 1, "kept within the grace");
    // No further output: the grace's end alone clears it.
    thread::sleep(Duration::from_millis(1700));
    assert_eq!(pending_now(&core, &s), vec![]);
}

// v1a-75: a session-agent caller is a shell session running the real CLI with its own NUNCHIRO_TOKEN, the way an
// agent's `nunchiro session resize` reaches the core; the window caller is the test's own `core.request`.
fn shell(core: &Core, name: &str, script: &str) -> Session {
    let path = core.home.join(format!("{name}.sh"));
    fs::write(&path, script).unwrap();
    match core
        .request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: core.home.clone(),
                worktree: false,
                label: name.into(),
                args: vec!["/bin/sh".into(), path.display().to_string()],
                model: None,
                effort: None,
                resume: None,
            },
        })
        .unwrap()
    {
        Reply::Started { session } => session,
        _ => panic!(),
    }
}

/// An agent session that resizes `target` `times` times, `gap` seconds apart, then drops `<name>.done`.
fn agent_resizes(core: &Core, name: &str, target: &Session, times: u32, gap: &str) {
    agent_resizes_as(core, name, target, times, gap, "");
}

/// `prefix` goes before the CLI: `env -u NUNCHIRO_TOKEN ...` makes it the owner token used from inside a session.
fn agent_resizes_as(
    core: &Core,
    name: &str,
    target: &Session,
    times: u32,
    gap: &str,
    prefix: &str,
) {
    let cli = cli::path();
    shell(
        core,
        name,
        &format!(
            "n=0\nwhile [ $n -lt {times} ]; do {prefix} '{}' session resize {} 60 50 >> {name}.out 2>&1 < /dev/null; sleep {gap}; n=$((n+1)); done\ntouch {name}.done\nsleep 30\n",
            cli.display(),
            target.id
        ),
    );
}

/// How many resizes the CLI of agent session `name` has printed `ack` for.
fn acks(core: &Core, name: &str) -> usize {
    fs::read_to_string(core.home.join(format!("{name}.out")))
        .unwrap_or_default()
        .matches("ack")
        .count()
}

fn wait_for(core: &Core, file: &str) {
    let end = Instant::now() + Duration::from_secs(20);
    while !core.home.join(file).exists() {
        assert!(Instant::now() < end, "{file} never appeared");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn agent_resize_does_not_arm_the_grace() {
    // Agent token, then the owner token used from inside the session (the core demotes it via inside_token).
    for (name, prefix) in [
        ("a1", String::new()),
        (
            "a1o",
            "env -u NUNCHIRO_TOKEN NUNCHIRO_HOME=\"$NUNCHIRO_HOME\"".to_string(),
        ),
    ] {
        let (core, s) = redraw_core();
        core.pending(&s.id);
        agent_resizes_as(&core, name, &s, 1, "0", &prefix);
        wait_for(&core, &format!("{name}.done"));
        assert_eq!(acks(&core, name), 1, "{name}: the resize did not succeed");
        draw(&core, "\x1b[2J\x1b[HDone\r\n");
        assert_eq!(pending_now(&core, &s), vec![], "{name}: the card lingered");
    }
}

#[test]
fn agent_resize_spam_cannot_keep_a_gone_prompt() {
    let (core, s) = redraw_core();
    core.pending(&s.id);
    agent_resizes(&core, "a2", &s, 6, "0.5");
    let end = Instant::now() + Duration::from_secs(20);
    while acks(&core, "a2") == 0 {
        assert!(Instant::now() < end, "no resize was acknowledged");
        thread::sleep(Duration::from_millis(10));
    }
    draw(&core, "\x1b[2J\x1b[HDone\r\n");
    assert_eq!(pending_now(&core, &s), vec![]);
    wait_for(&core, "a2.done");
    assert_eq!(acks(&core, "a2"), 6, "a resize was not acknowledged");
    assert_eq!(pending_now(&core, &s), vec![], "the spam kept the card");
}

#[test]
fn window_resize_still_keeps_the_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    draw(
        &core,
        &bash_prompt(60, " touch a\n b".replace('\n', "\r\n").as_str()),
    );
    let now = pending_now(&core, &s);
    assert_eq!(now.len(), 1, "{now:?}");
    assert_eq!(now[0].id, item.id, "the window's resize lost the id");
}

#[test]
fn resize_spam_cannot_extend_a_grace() {
    let (core, s) = redraw_core();
    core.pending(&s.id);
    let t0 = Instant::now();
    resize(&core, &s);
    draw(&core, "\x1b[2J\x1b[HDone\r\n");
    while t0.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(500));
        resize(&core, &s);
        // RESIZE_GRACE_MS + 500 ms after the first Resize the card is gone, and the spam never brings it back.
        if t0.elapsed() >= Duration::from_millis(2100) {
            assert_eq!(pending_now(&core, &s), vec![], "the spam kept the card");
        }
    }
}

#[test]
fn two_resizes_before_the_redraw_keep_the_id() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    resize(&core, &s);
    resize(&core, &s);
    draw(
        &core,
        &bash_prompt(60, " touch a\n b".replace('\n', "\r\n").as_str()),
    );
    let now = pending_now(&core, &s);
    assert_eq!(now.len(), 1, "{now:?}");
    assert_eq!(now[0].id, item.id, "the second resize lost the id");
}

#[test]
fn agent_resize_still_resizes_the_pty() {
    let core = Core::new();
    let target = shell(
        &core,
        "t4",
        "while [ ! -f go ]; do sleep 0.05; done\nstty size > size.out\nsleep 30\n",
    );
    agent_resizes(&core, "a4", &target, 1, "0");
    wait_for(&core, "a4.done");
    assert!(
        fs::read_to_string(core.home.join("a4.out"))
            .unwrap_or_default()
            .contains("ack"),
        "the CLI resize was refused"
    );
    fs::write(core.home.join("go"), "").unwrap();
    wait_for(&core, "size.out");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        fs::read_to_string(core.home.join("size.out"))
            .unwrap()
            .trim(),
        "50 60"
    );
}

#[test]
fn gone_prompt_old_id_is_refused_without_a_key() {
    let (core, s) = redraw_core();
    let item = core.pending(&s.id);
    agent_resizes(&core, "a5", &s, 1, "0");
    wait_for(&core, "a5.done");
    assert_eq!(acks(&core, "a5"), 1, "the resize was not acknowledged");
    draw(&core, "\x1b[2J\x1b[HDone\r\n");
    assert!(allow(&core, &item.id).is_err());
    assert_eq!(typed(&core), b"");
}

/// Ticket 991 B3: a hook that can wait (`nunchiro hook --hold`) is held past the 1.4 s of any other hook, so the card
/// answers through it with no prompt on the screen; a key typed in the terminal ends the hold and is not typed.
#[test]
fn a_held_permission_hook_waits_for_the_card_and_a_terminal_key_releases_it() {
    let core = Core::new();
    // No prompt is ever drawn (the agent waits on its hook); the first byte it is sent is logged.
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\nstty raw -echo\ndd bs=1 count=1 of=typed.log 2>/dev/null\nsleep 30\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    let s = core.start();
    let held = |event: &'static str| {
        let (home, id) = (core.home.clone(), s.id.clone());
        thread::spawn(move || {
            call(
                &home,
                Request::Hook {
                    id,
                    event: "PermissionRequest".into(),
                    payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"touch a"},"nunchiro_event_id":event,"nunchiro_hold":true}),
                },
            )
        })
    };
    let item_of = |event: &str| {
        let end = Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(item) = pending_now(&core, &s)
                .into_iter()
                .find(|i| i.hook_event_id.as_deref() == Some(event))
            {
                break item;
            }
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(10));
        }
    };
    core.request(Request::QueueConnect).unwrap();
    let hook = held("hold-1");
    let item = item_of("hold-1");
    // A second request for the same event (a replay) waits its 1.4 s only and leaves the first one held: the long
    // holds are counted per waiter, so one event cannot take the server's connections.
    let replay = held("hold-1");
    thread::sleep(Duration::from_millis(1800)); // past any other hook's 1.4 s
    core.request(Request::QueueConnect).unwrap(); // the window's beat
    assert!(matches!(
        replay.join().unwrap().unwrap(),
        Reply::HookDecision { decision: None }
    ));
    assert!(
        !hook.is_finished(),
        "the hook returned before its card was answered"
    );
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    let Reply::HookDecision {
        decision: Some(answer),
    } = hook.join().unwrap().unwrap()
    else {
        panic!("missing explicit answer")
    };
    assert_eq!(
        answer["hookSpecificOutput"]["decision"]["behavior"],
        "allow"
    );
    // A key in the terminal is the person's own typing: it reaches the agent as always and the hold stays (Claude
    // draws its dialog while the hook runs; both ways answer).
    core.request(Request::QueueConnect).unwrap();
    let hook = held("hold-2");
    let item = item_of("hold-2");
    core.request(Request::SendText {
        id: s.id.clone(),
        text: "y".into(),
        seen: vec![],
        composer: false,
    })
    .unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    while fs::read(core.home.join("typed.log")).unwrap_or_default() != b"y" {
        assert!(
            Instant::now() < end,
            "the terminal key never reached the agent"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!hook.is_finished());
    core.request(Request::Answer {
        item: item.id,
        answer: nunchiro_core::queue::Answer::Deny,
        confirmed: true,
    })
    .unwrap();
    let Reply::HookDecision {
        decision: Some(answer),
    } = hook.join().unwrap().unwrap()
    else {
        panic!("missing explicit answer")
    };
    assert_eq!(answer["hookSpecificOutput"]["decision"]["behavior"], "deny");
    // Look 11-17 N18: a plain deny tells Claude the user refused (the chat then reads "Denied 1 command").
    assert_eq!(
        answer["hookSpecificOutput"]["decision"]["message"],
        nunchiro_core::queue::DENY_PLAIN
    );
    // The agent ended the hook's client (the person answered in the terminal, or interrupted): the wait ends, and
    // the card no longer answers through a hook nobody reads.
    core.request(Request::QueueConnect).unwrap();
    let mut gone = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    let envelope = serde_json::json!({
        "token": fs::read_to_string(core.home.join("core.token")).unwrap(),
        "request": {"op": "hook", "id": s.id, "event": "PermissionRequest",
            "payload": {"tool_name":"Bash","tool_input":{"command":"touch a"},"nunchiro_event_id":"hold-4","nunchiro_hold":true}},
    });
    std::io::Write::write_all(&mut gone, format!("{envelope}\n").as_bytes()).unwrap();
    let item = item_of("hold-4");
    drop(gone);
    thread::sleep(Duration::from_millis(300));
    let refused = core
        .request(Request::Answer {
            item: item.id,
            answer: nunchiro_core::queue::Answer::AllowOnce,
            confirmed: true,
        })
        .unwrap_err();
    assert!(refused.contains("answer in the terminal"), "{refused}");
    // A question is not held: its choice is typed on the agent's dialog, so its hook returns in the usual 1.4 s.
    core.request(Request::QueueConnect).unwrap();
    let (home, id) = (core.home.clone(), s.id.clone());
    let at = Instant::now();
    let question = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Red or blue?","header":"Colour","multiSelect":false,"options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}]}]},"nunchiro_event_id":"hold-q","nunchiro_hold":true}),
            },
        )
    });
    assert!(matches!(
        question.join().unwrap().unwrap(),
        Reply::HookDecision { decision: None }
    ));
    assert!(at.elapsed() < Duration::from_millis(2500));
    // The window left: the hold ends by itself once its lease is over (3 s after the last beat).
    core.request(Request::QueueConnect).unwrap();
    let hook = held("hold-3");
    item_of("hold-3");
    let at = Instant::now();
    assert!(matches!(
        hook.join().unwrap().unwrap(),
        Reply::HookDecision { decision: None }
    ));
    assert!(
        at.elapsed() > Duration::from_millis(1500) && at.elapsed() < Duration::from_millis(4500)
    );
}

/// Ticket 990 (fourth real-app look): the agent draws its dialog while its hook is still waiting and the screen then
/// stands still. Frames are passed over while the hook is live, so without one more read at the hook's end the card
/// stays without choices until the screen next changes.
#[test]
fn a_still_screen_is_read_once_more_when_its_hook_returns() {
    let core = Core::new();
    fs::write(
        core.home.join("claude"),
        format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\nwhile [ -f hold-screen ]; do sleep 0.01; done\ncat screen.txt\nstty raw -echo\nsleep 30\n",
home::FAKE_INPUT_RAW),
    )
    .unwrap();
    fs::write(
        core.home.join("screen.txt"),
        claude_prompt("Bash command", " touch b", "Do you want to proceed?"),
    )
    .unwrap();
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start();
    core.request(Request::QueueConnect).unwrap();
    let (home, id) = (core.home.clone(), s.id.clone());
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"touch a"},"nunchiro_event_id":"still-1"}),
            },
        )
    });
    let item = core.pending(&s.id);
    assert_eq!(item.hook_event_id.as_deref(), Some("still-1"));
    // The dialog is drawn inside the hook's 1.4 s and nothing is printed after.
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    assert!(matches!(
        hook.join().unwrap().unwrap(),
        Reply::HookDecision { decision: None }
    ));
    let end = Instant::now() + Duration::from_secs(1);
    loop {
        let now = pending_now(&core, &s);
        if now
            .iter()
            .any(|i| i.sources.contains("screen") && !i.choices.is_empty())
        {
            break;
        }
        assert!(
            Instant::now() < end,
            "the still screen was never read: {now:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

/// Ticket 1130 C6 (round 2): the composer's restart closes only an idle session. The check and the close are one
/// request, so a turn that started after the window looked is never ended by it.
#[test]
fn close_idle_refuses_a_busy_session_and_closes_an_idle_one() {
    let core = Core::with_screen("ready\r\n");
    let s = core.start();
    let hook = |event: &str| {
        core.request(Request::Hook {
            id: s.id.clone(),
            event: event.into(),
            payload: serde_json::json!({}),
        })
        .unwrap();
    };
    let state = || match core.request(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => {
            sessions.into_iter().find(|x| x.id == s.id).unwrap().state
        }
        other => panic!("{other:?}"),
    };
    hook("UserPromptSubmit");
    let refused = core
        .request(Request::CloseIdle { id: s.id.clone() })
        .unwrap_err();
    assert!(refused.contains("busy"), "{refused}");
    assert_eq!(state(), SessionState::Running);
    hook("Stop");
    core.request(Request::CloseIdle { id: s.id.clone() })
        .unwrap();
    assert_ne!(state(), SessionState::Running);
}
