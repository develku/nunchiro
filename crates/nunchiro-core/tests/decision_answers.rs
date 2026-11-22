// V2-8e (HIDEROWS): the answers the decision card adds (a deny with an instruction, session-only "don't ask again")
// and the risk flag the window shows, through a real core and a fake agent.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, queue::Answer, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    /// The fake agent prints `screen`, then whatever lands in `redraw.txt`, and logs every byte it is sent.
    fn new(tag: &str, screen: &str) -> Self {
        let home = home::short(tag);
        fs::write(home.join("screen.txt"), screen).unwrap();
        fs::write(
            home.join("claude"),
            format!(
"#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\n{}\nprintf %s \"$NUNCHIRO_TOKEN\" > own.token\nwhile [ -f hold-screen ]; do sleep 0.01; done\ncat screen.txt\n(n=0; while [ $n -lt 3000 ]; do if [ -f redraw.txt ]; then cat redraw.txt; rm redraw.txt; fi; sleep 0.01; n=$((n+1)); done) &\nstty raw -echo\ndd bs=1 of=typed.log 2>/dev/null\n",
home::FAKE_INPUT_RAW),
        )
        .unwrap();
        fs::set_permissions(home.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            home.join("settings.json"),
            json!({"disable_hook_injection":false}).to_string(),
        )
        .unwrap();
        let bin = cli::path();
        let process = home::git_env::scrubbed(bin)
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
            assert!(Instant::now() < until, "core protocol did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn request(&self, r: Request) -> Response {
        call(&self.home, r)
    }
    fn start(&self, kind: AgentKind, args: Vec<String>) -> Session {
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
                    args,
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
    fn session(&self, id: &str) -> Session {
        let Reply::Snapshot { sessions, .. } = self.request(Request::Snapshot).unwrap() else {
            panic!()
        };
        sessions.into_iter().find(|s| s.id == id).unwrap()
    }
    /// The first pending item that `ready` accepts, as the window's snapshot JSON shows it.
    fn item(&self, id: &str, ready: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(3);
        loop {
            let s = serde_json::to_value(self.session(id)).unwrap();
            if let Some(i) = s["pending"]
                .as_array()
                .and_then(|p| p.iter().find(|i| ready(i)))
            {
                return i.clone();
            }
            assert!(Instant::now() < end, "no such item: {s}");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn answer(&self, item: &Value, answer: Answer) -> Response {
        self.request(Request::Answer {
            item: item["id"].as_str().unwrap().into(),
            answer,
            confirmed: false,
        })
    }
    fn typed(&self) -> Vec<u8> {
        thread::sleep(Duration::from_millis(200));
        fs::read(self.home.join("typed.log")).unwrap_or_default()
    }
    fn draw(&self, text: &str) {
        fs::write(self.home.join("redraw.tmp"), text).unwrap();
        fs::rename(self.home.join("redraw.tmp"), self.home.join("redraw.txt")).unwrap();
    }
    fn hook(&self, s: &Session, tool: &str, input: Value) {
        self.request(Request::Hook {
            id: s.id.clone(),
            event: "PermissionRequest".into(),
            payload: json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":"ev-1"}),
        })
        .unwrap();
    }
    fn raw_as(&self, token: &str, request: Value) -> Value {
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all((json!({"token": token, "request": request}).to_string() + "\n").as_bytes())
            .unwrap();
        let mut reply = String::new();
        let _ = BufReader::new(s).read_line(&mut reply);
        serde_json::from_str(&reply).unwrap_or(Value::Null)
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

/// Claude's Bash prompt as waiting_core draws it (the dashed rules frame the body the hook's command is matched in).
fn prompt(body: &str, second: &str) -> String {
    let rule = "\u{2500}".repeat(60);
    let dash = "\u{254c}".repeat(60);
    format!(
        "\x1b[2J\x1b[H{rule}\r\n Bash command\r\n{dash}\r\n {body}\r\n{dash}\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   {second}\r\n   3. No\r\n\r\n Esc to cancel\r\n"
    )
}

/// Claude 2.1.310's edit prompt (waiting_core EDIT_PROMPT): option 2 is kept for this session only.
fn edit_prompt() -> String {
    let rule = "\u{2500}".repeat(24);
    let dash = "\u{254c}".repeat(24);
    format!(
        "\x1b[2J\x1b[H\u{23fa} Update(a.txt)\r\n\r\n{rule}\r\n Edit file\r\n a.txt\r\n{dash}\r\n 1 -original line\r\n 1 +edited by agent\r\n{dash}\r\n\r\n Do you want to make this edit to a.txt?\r\n \u{276f} 1. Yes\r\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\r\n   3. No\r\n\r\n Esc to cancel \u{b7} Tab to amend\r\n"
    )
}

#[test]
fn deny_instruction_waits_for_the_prompt_to_go_then_is_sent_once() {
    let core = Core::new(
        "dn",
        &prompt(
            "touch a",
            "2. Yes, and don't ask again for touch commands in /x",
        ),
    );
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    let reply = core.answer(
        &item,
        Answer::DenyWith {
            text: "  use cargo check\ninstead\u{7}  ".into(),
        },
    );
    let Ok(Reply::Delivery { send }) = reply else {
        panic!("{reply:?}")
    };
    // One line, queued: the prompt is still on screen, where typed text would pick its options.
    assert_eq!(send.content, "use cargo check instead");
    assert_eq!(send.status, "queued");
    assert_eq!(core.typed(), b"\x1b", "only Esc while the prompt shows");
    // A second answer for the same item finds nothing: one deny, one instruction.
    assert!(
        core.answer(
            &item,
            Answer::DenyWith {
                text: "again".into()
            }
        )
        .is_err()
    );
    core.draw("\x1b[2J\x1b[H\u{276f} \r\n");
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let typed = String::from_utf8_lossy(&core.typed()).to_string();
        if typed.contains("use cargo check instead") {
            assert!(typed.starts_with('\x1b'), "{typed:?}");
            assert_eq!(
                typed.matches("use cargo check instead").count(),
                1,
                "{typed:?}"
            );
            assert!(!typed.contains("again"));
            break;
        }
        assert!(
            Instant::now() < end,
            "the instruction never reached the agent: {typed:?}"
        );
    }
}

#[test]
fn a_deny_instruction_is_one_plain_line_and_never_a_command() {
    let core = Core::new("dnc", &prompt("touch a", "2. No"));
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    // A slash or shell command is refused whole: nothing typed, the item still waits.
    for text in [
        "/clear",
        "  !rm -rf src",
        "\u{200b}/compact",
        "# always use rm -rf",
    ] {
        let r = core.answer(&item, Answer::DenyWith { text: text.into() });
        assert!(r.unwrap_err().contains("cannot start with"), "{text}");
    }
    assert_eq!(core.typed(), b"");
    assert_eq!(
        core.item(&s.id, |i| i["kind"] == "permission")["id"],
        item["id"]
    );
    // Invisible and line-breaking characters become spaces; the text is capped at 500 characters.
    let long = format!("a\u{2028}b\u{202e}c{}", "x".repeat(600));
    let Ok(Reply::Delivery { send }) = core.answer(&item, Answer::DenyWith { text: long }) else {
        panic!()
    };
    assert!(send.content.starts_with("a b c"), "{}", send.content);
    assert_eq!(send.content.chars().count(), 500);
}

#[test]
fn an_empty_deny_instruction_is_a_plain_deny() {
    let core = Core::new("dn0", &prompt("touch a", "2. No"));
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    assert!(matches!(
        core.answer(
            &item,
            Answer::DenyWith {
                text: " \n\t ".into()
            }
        ),
        Ok(Reply::Ack)
    ));
    assert_eq!(core.typed(), b"\x1b");
    let s = core.session(&s.id);
    assert!(
        s.send_queue.iter().all(|x| x.sender != "user"),
        "{:?}",
        s.send_queue
    );
}

#[test]
/// Look 11-17 B13: Claude read a hook's deny message as tool output ("That text is not from you") and ran the command
/// again. A hooked Claude deny now stops the turn, and the instruction goes in as the user's own next message.
fn b13_a_hooked_claude_deny_stops_the_turn_and_the_instruction_follows_as_the_users_message() {
    let core = Core::new("dnh", &prompt("touch a", "2. No"));
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    // A window is present, so the core holds the hook for the user's answer.
    core.request(Request::QueueConnect).unwrap();
    let home = core.home.clone();
    let id = s.id.clone();
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: json!({"tool_name":"Bash","tool_input":{"command":"touch a"},"nunchiro_event_id":"ev-h"}),
            },
        )
    });
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    assert!(matches!(
        core.answer(
            &item,
            Answer::DenyWith {
                text: "run the tests first".into()
            }
        ),
        Ok(Reply::Delivery { .. })
    ));
    let Ok(Reply::HookDecision { decision: Some(d) }) = hook.join().unwrap() else {
        panic!("no hook decision")
    };
    assert_eq!(
        d["hookSpecificOutput"]["decision"],
        json!({"behavior":"deny","interrupt":true,"message":"The user denied this. Do not retry it; their instruction follows as their next message."})
    );
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    // Nothing is typed while the prompt shows; the instruction waits as the user's message.
    assert_eq!(core.typed(), b"");
    let queue = core.session(&s.id).send_queue;
    assert!(
        queue.iter().any(|x| x.sender == "user"
            && x.content == "run the tests first"
            && x.status == "queued"),
        "{queue:?}"
    );
}

#[test]
fn risky_comes_from_the_request_and_fails_closed() {
    let core = Core::new("rk", &prompt("touch a", "2. No"));
    // Screen only: no tool to read, so risky (the field is absent; absent means risky).
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    assert!(item.get("risky").is_none(), "{item}");
    assert_eq!(item["deny_note"], true);
    drop(core);
    for (n, (tool, input, risky)) in [
        ("Bash", json!({"command":"touch a"}), false),
        ("Bash", json!({"command":"rm -rf build"}), true),
        ("Bash", json!({"command":"curl https://example.com"}), true),
        ("Read", json!({"file_path":"/etc/passwd"}), true),
        ("WebFetch", json!({"url":"https://example.com"}), true),
    ]
    .into_iter()
    .enumerate()
    {
        // The agent asks through its hook and has not drawn its prompt yet.
        let core = Core::new(&format!("rk{n}"), "");
        fs::write(core.home.join("hold-screen"), "").unwrap();
        let s = core.start(AgentKind::Claude, vec![]);
        core.hook(&s, tool, input.clone());
        let item = core.item(&s.id, |i| i["kind"] == "permission");
        assert_eq!(item.get("risky").is_none(), risky, "{tool} {input}: {item}");
    }
}

#[test]
fn allow_always_types_only_a_session_only_option_on_a_safe_request() {
    let core = Core::new("aa", &edit_prompt());
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    let file = core.home.join("a.txt");
    let input = json!({"file_path":file,"old_string":"original line","new_string":"edited by agent","replace_all":false});
    core.hook(&s, "Edit", input);
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let item = core.item(&s.id, |i| {
        i["sources"]
            .as_array()
            .is_some_and(|x| x.contains(&json!("screen")))
    });
    assert_eq!(item["risky"], false, "{item}");
    assert!(
        item["allow_always"]
            .as_str()
            .unwrap()
            .contains("for this session"),
        "{item}"
    );
    assert!(matches!(
        core.answer(&item, Answer::AllowAlways),
        Ok(Reply::Ack)
    ));
    assert_eq!(core.typed(), b"2\r");
}

#[test]
fn allow_always_is_refused_for_a_persistent_option_or_a_risky_request() {
    // "don't ask again … in /x" persists to the agent's settings: never offered, never typed.
    let core = Core::new(
        "aap",
        &prompt(
            "touch a",
            "2. Yes, and don't ask again for touch commands in /x",
        ),
    );
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    core.hook(&s, "Bash", json!({"command":"touch a"}));
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let item = core.item(&s.id, |i| {
        i["sources"]
            .as_array()
            .is_some_and(|x| x.contains(&json!("screen")))
    });
    assert_eq!(item["risky"], false, "{item}");
    assert!(item.get("allow_always").is_none(), "{item}");
    assert!(core.answer(&item, Answer::AllowAlways).is_err());
    drop(core);
    // A session-only option on a risky request (an edit outside the folder) is not offered either.
    let core = Core::new("aar", &edit_prompt());
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    core.hook(&s, "Edit", json!({"file_path":"/p/a.txt","old_string":"original line","new_string":"edited by agent","replace_all":false}));
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let item = core.item(&s.id, |i| {
        i["sources"]
            .as_array()
            .is_some_and(|x| x.contains(&json!("screen")))
    });
    assert!(item.get("risky").is_none(), "{item}");
    assert!(item.get("allow_always").is_none(), "{item}");
    assert!(core.answer(&item, Answer::AllowAlways).is_err());
    assert_eq!(core.typed(), b"");
}

/// Ticket 1030: a held Claude hook for `command` carrying `suggestions`, with Claude's three-option prompt on screen.
/// Gives the core, the session, the item and the hook's thread.
fn session_allow_case(
    name: &str,
    command: &str,
    suggestions: impl FnOnce(&str) -> Value,
) -> (Core, Session, Value, thread::JoinHandle<Response>) {
    let core = Core::new(
        name,
        &prompt(
            command,
            "2. Yes, and always allow access to work/ from this project",
        ),
    );
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    core.request(Request::QueueConnect).unwrap();
    let (home, id) = (core.home.clone(), s.id.clone());
    let payload = json!({"tool_name":"Bash","tool_input":{"command":command},"nunchiro_event_id":"ev-s",
        "permission_suggestions": suggestions(s.cwd.to_str().unwrap())});
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload,
            },
        )
    });
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let item = core.item(&s.id, |i| {
        i["sources"]
            .as_array()
            .is_some_and(|x| x.contains(&json!("screen")) && x.contains(&json!("hook")))
    });
    assert_eq!(item["risky"], false, "{item}");
    (core, s, item, hook)
}

#[test]
/// Ticket 1030 (look v33 R1): Claude's option 2 writes to its settings, so it is never typed; "Allow for this session"
/// answers its hook with Claude's own suggested rules, each kept to this session. Codex look on d749b565b: only those
/// equal to the exact command on the card; `Bash(*)`, a "touch:*" prefix, every folder grant (`/`, even the session's
/// own folder) and a mode switch go (Codex looks on d749b565b, 6c5ea953f and 801803366).
fn allow_for_this_session_answers_the_hook_with_only_the_requests_own_rules() {
    let (core, _s, item, hook) = session_allow_case("aas", "touch b.txt", |cwd| {
        json!([
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"*"}],"destination":"localSettings"},
            {"type":"addDirectories","directories":["/"],"destination":"session"},
            {"type":"addDirectories","directories":[cwd],"destination":"localSettings"},
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"touch:*"}],"destination":"localSettings"},
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"touch b.txt"}],"destination":"localSettings"},
            {"type":"setMode","mode":"acceptEdits","destination":"session"}
        ])
    });
    assert_eq!(
        item["allow_always"], "Yes, and always allow access to work/ from this project",
        "{item}"
    );
    assert_eq!(item["allow_scope"], "touch b.txt", "{item}");
    assert!(matches!(
        core.answer(&item, Answer::AllowAlways),
        Ok(Reply::Ack)
    ));
    let Ok(Reply::HookDecision { decision: Some(d) }) = hook.join().unwrap() else {
        panic!("no hook decision")
    };
    assert_eq!(
        d["hookSpecificOutput"]["decision"],
        json!({"behavior":"allow","updatedPermissions":[
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"touch b.txt"}],"destination":"session"}
        ]})
    );
    assert_eq!(core.typed(), b"");
}

#[test]
/// Look v34 S2-1: real Claude suggests only wider rules (a prefix "npm *", `Bash(*)`, a folder): the core builds its own
/// rule for exactly the command on the card (replaces the 1030 round where such a request offered no button).
fn allow_for_this_session_forwards_its_own_exact_rule_when_every_suggestion_is_wider() {
    let (core, _s, item, hook) = session_allow_case("aab", "npm test", |_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/x".into());
        json!([
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"npm *"}],"destination":"localSettings"},
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"*"}],"destination":"session"},
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash"}],"destination":"session"},
            {"type":"addDirectories","directories":["/"],"destination":"session"},
            {"type":"addDirectories","directories":[home],"destination":"session"}
        ])
    });
    assert_eq!(item["allow_scope"], "npm test", "{item}");
    assert!(matches!(
        core.answer(&item, Answer::AllowAlways),
        Ok(Reply::Ack)
    ));
    let Ok(Reply::HookDecision { decision: Some(d) }) = hook.join().unwrap() else {
        panic!("no hook decision")
    };
    assert_eq!(
        d["hookSpecificOutput"]["decision"],
        json!({"behavior":"allow","updatedPermissions":[
            {"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"npm test"}],"destination":"session"}
        ]})
    );
    assert_eq!(core.typed(), b"");
}

#[test]
/// Look v34 S2-1: a command with a pattern character ("*") would be read by Claude as a pattern: no button, the answer
/// is refused, nothing is typed, and Deny still answers the hook.
fn allow_for_this_session_is_not_offered_for_a_command_with_a_pattern_character() {
    let (core, _s, item, hook) = session_allow_case(
        "aap",
        "ls *.txt",
        |_| json!([{"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"ls *.txt"}],"destination":"session"}]),
    );
    assert!(item.get("allow_always").is_none(), "{item}");
    assert!(item.get("allow_scope").is_none(), "{item}");
    assert!(core.answer(&item, Answer::AllowAlways).is_err());
    assert_eq!(core.typed(), b"");
    assert!(core.answer(&item, Answer::Deny).is_ok());
    let Ok(Reply::HookDecision { decision: Some(d) }) = hook.join().unwrap() else {
        panic!("no hook decision")
    };
    assert_eq!(d["hookSpecificOutput"]["decision"]["behavior"], "deny");
}

#[test]
fn agent_tokens_cannot_answer_a_decision() {
    let core = Core::new("tok", &prompt("touch a", "2. No"));
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    // A shell session's own token, written where the test reads it.
    let path = core.home.join("session.token");
    let script = format!(
        "printf %s \"$NUNCHIRO_TOKEN\" > {}; exec sleep 60",
        path.display()
    );
    core.start(
        AgentKind::Shell,
        vec!["/bin/sh".into(), "-c".into(), script],
    );
    let end = Instant::now() + Duration::from_secs(10);
    let token = loop {
        if let Ok(t) = fs::read_to_string(&path)
            && t.len() > 20
        {
            break t;
        }
        assert!(Instant::now() < end, "no session token");
        thread::sleep(Duration::from_millis(10));
    };
    for (answer, refusal) in [
        (json!({"type":"allow_always"}), "window only"),
        (json!({"type":"deny_with","text":"stop"}), "window only"),
        (json!({"type":"allow_once"}), "permission_answers_disabled"),
    ] {
        let r = core.raw_as(
            &token,
            json!({"op":"answer","item":item["id"],"answer":answer}),
        );
        assert!(
            r["Err"].as_str().unwrap_or_default().contains(refusal),
            "{answer} -> {r}"
        );
    }
    // Its own session's token too (acceptance 15): the asking agent cannot answer for itself.
    let own = fs::read_to_string(core.home.join("own.token")).unwrap();
    assert!(own.len() > 20);
    for (answer, refusal) in [
        (json!({"type":"allow_always"}), "window only"),
        (json!({"type":"deny_with","text":"stop"}), "window only"),
        (json!({"type":"allow_once"}), "permission_answers_disabled"),
    ] {
        let r = core.raw_as(
            &own,
            json!({"op":"answer","item":item["id"],"answer":answer}),
        );
        assert!(
            r["Err"].as_str().unwrap_or_default().contains(refusal),
            "own {answer} -> {r}"
        );
    }
    assert_eq!(core.typed(), b"", "an agent's answer reached the prompt");
    // The item still waits for the window.
    assert_eq!(
        core.item(&s.id, |i| i["kind"] == "permission")["id"],
        item["id"]
    );
}

#[test]
fn a_risky_allow_needs_the_cards_confirmation() {
    // Screen only: risky. The strip, the chat card and the phone send `confirmed: false` and are refused.
    let core = Core::new("rc", &prompt("touch a", "2. No"));
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    assert!(item.get("risky").is_none());
    let r = core.answer(&item, Answer::AllowOnce);
    assert!(r.unwrap_err().contains("risky"), "unconfirmed risky allow");
    assert_eq!(core.typed(), b"");
    assert_eq!(
        core.item(&s.id, |i| i["kind"] == "permission")["id"],
        item["id"]
    );
    // The card's focus-then-Enter allow carries the confirmation.
    let r = core.request(Request::Answer {
        item: item["id"].as_str().unwrap().into(),
        answer: Answer::AllowOnce,
        confirmed: true,
    });
    assert!(matches!(r, Ok(Reply::Ack)), "{r:?}");
    assert_eq!(core.typed(), b"1\r");
}

#[test]
fn an_agent_never_allows_a_risky_request_even_with_answers_on() {
    let core = Core::new("ra", &prompt("touch a", "2. No"));
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    // Verified yes (needs 47) on: an agent may allow a plain request of its project, never a risky one.
    core.request(Request::PermissionAnswers {
        project: core.home.clone(),
        on: true,
    })
    .unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    let own = loop {
        if let Ok(t) = fs::read_to_string(core.home.join("own.token"))
            && t.len() > 20
        {
            break t;
        }
        assert!(Instant::now() < end, "no session token");
        thread::sleep(Duration::from_millis(10));
    };
    core.hook(&s, "Bash", json!({"command":"rm -rf build"}));
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    for confirmed in [false, true] {
        let r = core.raw_as(&own, json!({"op":"answer","item":item["id"],"answer":{"type":"allow_once"},"confirmed":confirmed}));
        assert!(
            r["Err"]
                .as_str()
                .unwrap_or_default()
                .contains("cannot allow a risky"),
            "{confirmed}: {r}"
        );
    }
    assert_eq!(
        core.item(&s.id, |i| i["kind"] == "permission")["id"],
        item["id"]
    );
}

#[test]
fn verified_yes_still_lets_an_agent_allow_a_safe_request() {
    // Needs 47 kept: with answers on, a request the core can judge (hook tool and input inside the folder) is the
    // agent's to allow; only risky ones are not.
    let core = Core::new("rs", &prompt("touch a", "2. No"));
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    core.request(Request::PermissionAnswers {
        project: core.home.clone(),
        on: true,
    })
    .unwrap();
    core.hook(&s, "Bash", json!({"command":"touch a"}));
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let item = core.item(&s.id, |i| {
        i["sources"]
            .as_array()
            .is_some_and(|x| x.contains(&json!("screen")))
    });
    assert_eq!(item["risky"], false, "{item}");
    let own = fs::read_to_string(core.home.join("own.token")).unwrap();
    let r = core.raw_as(
        &own,
        json!({"op":"answer","item":item["id"],"answer":{"type":"allow_once"}}),
    );
    assert!(r["Ok"].is_object() || r["Ok"].is_string(), "{r}");
    assert_eq!(core.typed(), b"1\r");
}

#[test]
fn choose_on_permission_refused() {
    // Security review r2: a raw `choose` on a permission typed that option's keys past the risky gate. A permission
    // takes allow once or deny only, for every caller, confirmed or not (the window never sends choose for one).
    let core = Core::new("ch", &prompt("rm -rf build/", "2. No"));
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    for (index, confirmed) in [(0, false), (0, true), (1, true)] {
        let r = core.request(Request::Answer {
            item: item["id"].as_str().unwrap().into(),
            answer: Answer::Choose { index },
            confirmed,
        });
        assert!(
            r.unwrap_err().contains("allow once or deny"),
            "{index} {confirmed}"
        );
    }
    assert_eq!(core.typed(), b"", "an option reached the prompt");
    assert_eq!(
        core.item(&s.id, |i| i["kind"] == "permission")["id"],
        item["id"]
    );
}

/// Ticket 396: a resize blanks the core's screen until the agent redraws. The fake agent draws `redraw` its delay
/// after the answer is sent (never, for `None`); the answer goes `wait` after the resize, as the window's answer
/// queued behind its own resize.
fn answer_after_resize(
    tag: &str,
    redraw: Option<(Duration, String)>,
    wait: Duration,
) -> (Response, Duration, Vec<u8>) {
    let core = Core::new(tag, &prompt("touch a", "2. No"));
    let s = core.start(AgentKind::Claude, vec![]);
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    core.request(Request::Resize {
        id: s.id.clone(),
        cols: 97,
        rows: 41,
    })
    .unwrap();
    thread::sleep(wait);
    let start = Instant::now();
    thread::scope(|scope| {
        if let Some((after, text)) = redraw {
            let core = &core;
            scope.spawn(move || {
                thread::sleep(after);
                core.draw(&text);
            });
        }
        let reply = core.request(Request::Answer {
            item: item["id"].as_str().unwrap().into(),
            answer: Answer::AllowOnce,
            confirmed: true,
        });
        (reply, start.elapsed(), core.typed())
    })
}

#[test]
fn an_answer_in_the_resize_redraw_gap_reaches_the_redrawn_prompt() {
    let after = Duration::from_millis(150);
    let (reply, took, typed) = answer_after_resize(
        "rz",
        Some((after, prompt("touch a", "2. No"))),
        Duration::ZERO,
    );
    assert!(matches!(reply, Ok(Reply::Ack)), "{reply:?}");
    assert!(took >= after, "answered before the redraw: {took:?}");
    assert_eq!(typed, b"1\r", "typed once, into the redrawn prompt");
}

#[test]
fn an_answer_after_the_redraw_gap_or_on_another_prompt_is_refused_untyped() {
    let now = Duration::ZERO;
    // No redraw: refused once the wait is over (500 ms, inside the 1500 ms grace), with the usual text.
    let (reply, took, typed) = answer_after_resize("rn", None, now);
    assert_eq!(reply.unwrap_err(), "decision is no longer on screen");
    assert!(took < Duration::from_millis(1400), "{took:?}");
    assert_eq!(typed, b"");
    // A different prompt redrawn: never typed into.
    let other = Some((Duration::from_millis(100), prompt("rm -rf /x", "2. No")));
    let (reply, _, typed) = answer_after_resize("ro", other, now);
    assert!(reply.is_err(), "{reply:?}");
    assert_eq!(typed, b"", "typed into a prompt the item never recorded");
}

/// Seventh look (B S1-1): an agent that draws nothing after a resize still shows its prompt. Once the redraw's time is
/// over the core reads the screen as the terminal shows it, so the answer reaches that prompt, whether or not a tick
/// ran since the grace ended (it was refused, and the card was lost with it).
#[test]
fn an_answer_after_the_grace_reaches_a_prompt_the_agent_never_redrew() {
    for wait in [1600, 2600] {
        let (reply, took, typed) =
            answer_after_resize(&format!("rl{wait}"), None, Duration::from_millis(wait));
        assert!(matches!(reply, Ok(Reply::Ack)), "{wait}: {reply:?}");
        assert!(took < Duration::from_millis(300), "{wait}: {took:?}");
        assert_eq!(
            typed, b"1\r",
            "{wait}: typed once, into the prompt still shown"
        );
    }
}

/// Claude 2.1.327's AskUserQuestion dialog, as the eighth look's screen showed it.
fn question_dialog() -> String {
    let rule = "\u{2500}".repeat(47);
    format!(
        "\x1b[2J\x1b[H{rule}\r\n \u{2610} Letter\r\n\r\nWhich letter should I write into x.txt?\r\n\r\n\u{276f} 1. A\r\n     Write the letter A into x.txt.\r\n  2. B\r\n     Write the letter B into x.txt.\r\n  3. Type something.\r\n{rule}\r\n  4. Chat about this\r\n\r\nEnter to select \u{b7} \u{2191}/\u{2193} to navigate \u{b7} Esc to cancel\r\n"
    )
}
const QUESTION_INPUT: &str = r#"{"questions":[{"header":"Letter","multiSelect":false,"options":[{"description":"Write the letter A into x.txt.","label":"A"},{"description":"Write the letter B into x.txt.","label":"B"}],"question":"Which letter should I write into x.txt?"}]}"#;

/// The question items of `session` in every snapshot the core pushes a window from now on, each with the moment it
/// arrived.
fn window_questions(
    core: &Core,
    session: &str,
) -> std::sync::mpsc::Receiver<(Instant, Vec<Value>)> {
    use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};
    let until = Instant::now() + Duration::from_secs(30);
    while !core.home.join("window.json").exists() {
        assert!(Instant::now() < until, "no window server");
        thread::sleep(Duration::from_millis(10));
    }
    let info = serde_json::to_value(core.request(Request::WindowAuth).unwrap()).unwrap();
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
        std::net::TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
    let mut ws = tungstenite::client(req, stream).unwrap().0;
    let (tx, rx) = std::sync::mpsc::channel();
    let session = session.to_string();
    // Ends with the core (the socket closes) or the test (the receiver is gone).
    thread::spawn(move || {
        while let Ok(message) = ws.read() {
            let Message::Text(text) = message else {
                continue;
            };
            let v: Value = serde_json::from_str(&text).unwrap();
            if v["event"] != "snapshot" {
                continue;
            }
            let questions = v["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| s["id"] == session.as_str())
                .flat_map(|s| s["pending"].as_array().cloned().unwrap_or_default())
                .filter(|i| i["kind"] == "question")
                .collect();
            if tx.send((Instant::now(), questions)).is_err() {
                break;
            }
        }
    });
    rx
}

/// Look 11-17 v8 (area B S2-1): a Claude AskUserQuestion card showed its question with no option buttons at first
/// (only Cancel); the buttons came later. The hooks make the item (the question's own words) and the screen brings
/// the choices (their keys are typed on Claude's dialog), and the core kept the hook waiting 1.4 s for an answer a
/// question's hook cannot carry, passing over the dialog's frames meanwhile. In the look's order (the hooks, then
/// the dialog): the window never sees the question without its choices, and sees it within a second of the dialog.
/// Other callers (`nunchiro agent wait`, the core's own gates) see the question from its first hook.
#[test]
fn a_claude_question_card_carries_its_choices_from_its_first_moment() {
    let core = Core::new("qch", &question_dialog());
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    let window = window_questions(&core, &s.id);
    core.request(Request::QueueConnect).unwrap(); // a window is present
    let input: Value = serde_json::from_str(QUESTION_INPUT).unwrap();
    let hook = |event: &str, id: Option<&str>| {
        let mut payload = json!({"tool_name":"AskUserQuestion","tool_input":input});
        if let Some(id) = id {
            payload["nunchiro_event_id"] = id.into();
        }
        Request::Hook {
            id: s.id.clone(),
            event: event.into(),
            payload,
        }
    };
    core.request(hook("PreToolUse", None)).unwrap();
    let (home, permission) = (core.home.clone(), hook("PermissionRequest", Some("ev-q")));
    let waiting = thread::spawn(move || call(&home, permission));
    // Claude draws its dialog a moment after its hooks.
    thread::sleep(Duration::from_millis(150));
    let own = core.session(&s.id).pending;
    assert_eq!(
        own.iter().map(|i| &i.kind).collect::<Vec<_>>(),
        [&nunchiro_core::queue::Kind::Question],
        "the owner socket's snapshot has it at once"
    );
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let drawn = Instant::now();
    thread::sleep(Duration::from_millis(2500));
    let mut first = None;
    for (at, questions) in window.try_iter() {
        for q in questions {
            let labels: Vec<&str> = q["choices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["label"].as_str().unwrap())
                .collect();
            assert_eq!(
                labels,
                ["A", "B", "Type something.", "Chat about this"],
                "the window was shown a question card without its choices: {q}"
            );
            assert_eq!(q["text"], QUESTION_INPUT, "the question's own words");
            first.get_or_insert(at);
        }
    }
    let first = first.expect("the question never became a card");
    assert!(
        first > drawn && first < drawn + Duration::from_millis(1000),
        "{:?}",
        first.checked_duration_since(drawn)
    );
    assert!(matches!(
        waiting.join().unwrap(),
        Ok(Reply::HookDecision { decision: None })
    ));
    // The card answers on the dialog: "2. B".
    let card = core.item(&s.id, |i| i["kind"] == "question");
    core.answer(&card, Answer::Choose { index: 1 }).unwrap();
    assert_eq!(core.typed(), b"2\r");
}

/// The hold is bounded: a question whose dialog the screen never shows (a build this core cannot read) is a card
/// after about a second, with Cancel only, as before.
#[test]
fn a_question_with_no_dialog_on_the_screen_is_a_card_after_a_second() {
    let core = Core::new("qnd", "working\r\n");
    let s = core.start(AgentKind::Claude, vec![]);
    let window = window_questions(&core, &s.id);
    let input: Value = serde_json::from_str(QUESTION_INPUT).unwrap();
    // The hold starts when the core reads the hook, somewhere between these two instants: "not before a second" counts
    // from the first and "not much later" from the second, so a hook reply slowed by load moves neither bound.
    let sent = Instant::now();
    core.request(Request::Hook {
        id: s.id.clone(),
        event: "PreToolUse".into(),
        payload: json!({"tool_name":"AskUserQuestion","tool_input":input}),
    })
    .unwrap();
    let asked = Instant::now();
    thread::sleep(Duration::from_millis(2500));
    let shown: Vec<(Instant, Value)> = window
        .try_iter()
        .flat_map(|(at, questions)| questions.into_iter().map(move |q| (at, q)))
        .collect();
    let (at, card) = shown.first().expect("the question never became a card");
    assert!(
        *at >= sent + Duration::from_millis(900) && *at < asked + Duration::from_millis(2000),
        "{:?} after the hook was sent, {:?} after its reply",
        at.checked_duration_since(sent),
        at.checked_duration_since(asked)
    );
    assert_eq!(card["choices"], json!([]));
}

#[test]
/// Look 1117 v12 N12-S2-3: Claude went on after the hook's deny (it did not honour `interrupt`), and the box it drew for a
/// frame between the dialog and its next step read as the end of the turn: the instruction was typed into the running
/// turn and lost (3 of 3). The instruction waits for the turn's real end and goes in once.
fn n12_s2_3_a_deny_instruction_waits_while_claude_goes_on_after_the_deny() {
    let core = Core::new("dnr", &prompt("touch a", "2. No"));
    fs::write(core.home.join("hold-screen"), "").unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    core.request(Request::QueueConnect).unwrap();
    let hook_event = |event: &str| {
        core.request(Request::Hook {
            id: s.id.clone(),
            event: event.into(),
            payload: json!({}),
        })
        .unwrap()
    };
    hook_event("UserPromptSubmit");
    let home = core.home.clone();
    let id = s.id.clone();
    let hook = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "PermissionRequest".into(),
                payload: json!({"tool_name":"Bash","tool_input":{"command":"touch a"},"nunchiro_event_id":"ev-h"}),
            },
        )
    });
    let item = core.item(&s.id, |i| i["kind"] == "permission");
    let reply = core.answer(
        &item,
        Answer::DenyWith {
            text: "run the tests first".into(),
        },
    );
    assert!(matches!(reply, Ok(Reply::Delivery { .. })), "{reply:?}");
    hook.join().unwrap().unwrap();
    fs::remove_file(core.home.join("hold-screen")).unwrap();
    let rule = "\u{2500}".repeat(60);
    let frame = |footer: &str| {
        format!(
            "\x1b[2J\x1b[H\u{23fa} Not run.\r\n\r\n{rule}\r\n\u{276f} \r\n{rule}\r\n  {footer}\r\n"
        )
    };
    thread::sleep(Duration::from_millis(300));
    // One frame of the bare box, then Claude works on.
    core.draw(&frame("? for shortcuts"));
    thread::sleep(Duration::from_millis(150));
    core.draw(&frame("\u{2733} Working\u{2026} \u{b7} esc to interrupt"));
    thread::sleep(Duration::from_millis(2500));
    assert_eq!(core.typed(), b"", "nothing typed into the running turn");
    assert!(core.session(&s.id).attention.working);
    core.draw(&frame("? for shortcuts"));
    hook_event("Stop");
    let end = Instant::now() + Duration::from_secs(8);
    loop {
        let typed = String::from_utf8_lossy(&core.typed()).to_string();
        if typed.contains("run the tests first") {
            assert_eq!(typed, "run the tests first\r");
            break;
        }
        assert!(Instant::now() < end, "never typed: {typed:?}");
    }
}
