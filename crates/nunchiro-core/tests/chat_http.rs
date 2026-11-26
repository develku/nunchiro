#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
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
    fn new(version: &str) -> Self {
        Self::with_setup(version, |_| {})
    }
    fn with_setup(version: &str, setup: impl FnOnce(&std::path::Path)) -> Self {
        let serial = {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        };
        let home = home::short(&format!("chat-http-{serial}"));
        fs::create_dir_all(home.join("bin")).unwrap();
        let fake = home.join("bin/claude");
        fs::write(&fake,b"#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"$FAKE_VERSION\"; exit; fi\nexec /bin/cat\n").unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("cwd")).unwrap();
        setup(&home);
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("agent"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env("FAKE_VERSION", version)
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !result.home.join("window.json").exists() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        result
    }
    fn session(&self) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Claude,
                    project: self.home.join("cwd"),
                    worktree: false,
                    label: "chat".into(),
                    args: vec![],
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
    fn hook(&self, session: &Session, event: &str, payload: Value) {
        call(
            &self.home,
            Request::Hook {
                id: session.id.clone(),
                event: event.into(),
                payload,
            },
        )
        .unwrap();
    }
    fn transcript(&self, s: &Session) -> PathBuf {
        let encoded = s
            .cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>();
        let dir = self.home.join("agent/projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
        fs::write(&path, b"").unwrap();
        self.hook(
            s,
            "SessionStart",
            json!({"session_id":s.agent_session_id,"transcript_path":path}),
        );
        path
    }
    fn dial(&self) -> tungstenite::WebSocket<TcpStream> {
        let info: Value =
            serde_json::to_value(call(&self.home, Request::WindowAuth).unwrap()).unwrap();
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
        // v1a-80c: failure detection, as `live`'s 30 s deadline; the first page of a transcript indexes it (240 to 340 ms
        // idle) and a 5 s socket read turned a loaded host's slow page into WouldBlock.
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        tungstenite::client(req, stream).unwrap().0
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
fn recv(ws: &mut tungstenite::WebSocket<TcpStream>, id: u64) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < until);
        if let Message::Text(t) = ws.read().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["id"] == id {
                return v["response"].clone();
            }
        }
    }
}
fn send(ws: &mut tungstenite::WebSocket<TcpStream>, v: Value) {
    ws.send(Message::Text(v.to_string().into())).unwrap();
}
fn live(ws: &mut tungstenite::WebSocket<TcpStream>) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < until, "no live chat event");
        if let Message::Text(t) = ws.read().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["event"] == "chat" {
                return v;
            }
        }
    }
}
#[test]
fn chat_http_authenticated_pages_and_live_tail_have_no_gaps_or_duplicates() {
    let core = Core::new("2.1.310 (Claude Code)");
    let s = core.session();
    let path = core.transcript(&s);
    let records = (0..405)
        .map(|i| {
            json!({"type":"user","message":{"content":format!("message-{i}")}}).to_string() + "\n"
        })
        .collect::<String>();
    fs::write(&path, &records).unwrap();
    let mut ws = core.dial();
    send(&mut ws, json!({"id":1,"chat":"missing"}));
    assert!(recv(&mut ws, 1)["Err"].is_string());
    send(&mut ws, json!({"id":2,"chat":s.id}));
    let newest = recv(&mut ws, 2)["Ok"]["page"].clone();
    assert_eq!(newest["events"].as_array().unwrap().len(), 200);
    assert_eq!(newest["events"][0]["data"]["text"], "message-205");
    send(
        &mut ws,
        json!({"id":3,"chat":s.id,"before":newest["before"]}),
    );
    let older = recv(&mut ws, 3)["Ok"]["page"].clone();
    assert_eq!(older["events"].as_array().unwrap().len(), 200);
    send(
        &mut ws,
        json!({"id":4,"chat":s.id,"before":older["before"]}),
    );
    let oldest = recv(&mut ws, 4)["Ok"]["page"].clone();
    assert_eq!(oldest["events"].as_array().unwrap().len(), 5);
    assert!(oldest["before"].is_null());
    let all = oldest["events"]
        .as_array()
        .unwrap()
        .iter()
        .chain(older["events"].as_array().unwrap())
        .chain(newest["events"].as_array().unwrap())
        .collect::<Vec<_>>();
    for (i, e) in all.iter().enumerate() {
        assert_eq!(e["cursor"], i + 1);
        assert_eq!(e["data"]["text"], format!("message-{i}"));
    }
    use std::io::Write;
    let mut transcript = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        transcript,
        "{}",
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"live"}]}})
    )
    .unwrap();
    let event = live(&mut ws);
    assert_eq!(event["page"]["events"][0]["cursor"], 406);
    assert_eq!(event["page"]["events"][0]["data"]["text"], "live");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        records
            + &json!({"type":"assistant","message":{"content":[{"type":"text","text":"live"}]}})
                .to_string()
            + "\n"
    );
}
#[test]
fn chat_http_unknown_version_stop_hook_finals_and_queue_survive() {
    let core = Core::new("untested-version");
    let s = core.session();
    assert!(s.untested);
    let mut ws = core.dial();
    for i in 1..=2 {
        core.hook(
            &s,
            "UserPromptSubmit",
            json!({"turn_id":format!("turn-{i}")}),
        );
        core.hook(
            &s,
            "Stop",
            json!({"turn_id":format!("turn-{i}"),"last_assistant_message":format!("final-{i}")}),
        );
    }
    core.hook(&s,"PreToolUse",json!({"tool_name":"AskUserQuestion","tool_use_id":"question-1","tool_input":{"questions":[{"question":"Keep working?"}]}}));
    let snapshot = call(&core.home, Request::Snapshot).unwrap();
    if let Reply::Snapshot { sessions, .. } = snapshot {
        assert!(!sessions[0].pending.is_empty());
    } else {
        panic!()
    }
    send(&mut ws, json!({"id":1,"chat":s.id}));
    let page = recv(&mut ws, 1)["Ok"]["page"].clone();
    assert_eq!(page["events"].as_array().unwrap().len(), 3);
    assert_eq!(page["events"][0]["data"]["kind"], "version_banner");
    assert_eq!(page["events"][2]["data"]["text"], "final-2");
    core.hook(&s, "UserPromptSubmit", json!({"turn_id":"turn-3"}));
    core.hook(
        &s,
        "Stop",
        json!({"turn_id":"turn-3","last_assistant_message":"final-3"}),
    );
    assert_eq!(
        live(&mut ws)["page"]["events"][0]["data"]["text"],
        "final-3"
    );
}

#[test]
fn chat_http_unknown_finals_survive_explicit_resume() {
    let core = Core::new("untested-version");
    let first = core.session();
    core.hook(&first, "UserPromptSubmit", json!({"turn_id":"first"}));
    core.hook(
        &first,
        "Stop",
        json!({"turn_id":"first","last_assistant_message":"before resume"}),
    );
    call(
        &core.home,
        Request::Close {
            id: first.id.clone(),
        },
    )
    .unwrap();
    let resumed = match call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: core.home.join("cwd"),
                worktree: false,
                label: "resume".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: first.agent_session_id,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    let mut ws = core.dial();
    send(&mut ws, json!({"id":1,"chat":resumed.id}));
    assert_eq!(
        recv(&mut ws, 1)["Ok"]["page"]["events"][1]["data"]["text"],
        "before resume"
    );
}

#[test]
fn chat_empty_tested_version_list_keeps_hook_finals_and_snapshot_queue() {
    let core = Core::new("2.1.310 (Claude Code)");
    let s = core.session();
    core.hook(&s, "UserPromptSubmit", json!({"turn_id":"turn-1"}));
    core.hook(
        &s,
        "Stop",
        json!({"turn_id":"turn-1","last_assistant_message":"final"}),
    );
    core.hook(&s,"PreToolUse",json!({"tool_name":"AskUserQuestion","tool_use_id":"question-1","tool_input":{"questions":[{"question":"Continue?"}]}}));
    let feed = nunchiro_core::chat::Store::open(&core.home, &nunchiro_core::chat::session_key(&s))
        .unwrap();
    let page = feed
        .page(s.kind, s.agent_version.as_deref(), &[], None)
        .unwrap();
    assert_eq!(page.events[0].data["kind"], "version_banner");
    assert_eq!(page.events[1].data["text"], "final");
    if let Reply::Snapshot { sessions, .. } = call(&core.home, Request::Snapshot).unwrap() {
        assert!(!sessions[0].pending.is_empty());
    } else {
        panic!()
    }
}

#[test]
fn chat_http_stop_without_turn_id_survives_resume() {
    let core = Core::new("untested-version");
    let first = core.session();
    core.hook(&first, "UserPromptSubmit", json!({"prompt":"first"}));
    core.hook(&first, "Stop", json!({"last_assistant_message":"before"}));
    call(
        &core.home,
        Request::Close {
            id: first.id.clone(),
        },
    )
    .unwrap();
    let resumed = match call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: core.home.join("cwd"),
                worktree: false,
                label: "resume".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: first.agent_session_id,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    core.hook(&resumed, "UserPromptSubmit", json!({"prompt":"second"}));
    core.hook(&resumed, "Stop", json!({"last_assistant_message":"after"}));
    let mut ws = core.dial();
    send(&mut ws, json!({"id":1,"chat":resumed.id}));
    let page = recv(&mut ws, 1)["Ok"]["page"].clone();
    assert_eq!(page["events"].as_array().unwrap().len(), 3);
    assert_eq!(page["events"][1]["data"]["text"], "before");
    assert_eq!(page["events"][2]["data"]["text"], "after");
}

#[test]
fn chat_slow_stop_append_preserves_queue_order_without_blocking_requests() {
    use std::os::fd::AsRawFd;
    let core = Core::new("future");
    let session = core.session();
    core.hook(&session, "UserPromptSubmit", json!({"turn_id":"slow-turn"}));
    fs::create_dir_all(core.home.join("chat")).unwrap();
    let lock = fs::File::create(core.home.join("chat").join(format!(
        "{}.stops.lock",
        nunchiro_core::chat::session_key(&session)
    )))
    .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let home = core.home.clone();
    let id = session.id.clone();
    let append = thread::spawn(move || {
        call(
            &home,
            Request::Hook {
                id,
                event: "Stop".into(),
                payload: json!({"turn_id":"slow-turn","last_assistant_message":"durable final"}),
            },
        )
    });
    // v1a-17: the test's flock holds the append. A snapshot answering while it is held (checked below) shows the
    // append does not hold the registry; the deadline only turns a missing queue effect into a failure.
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let Reply::Snapshot { sessions, .. } = call(&core.home, Request::Snapshot).unwrap() else {
            panic!()
        };
        if sessions
            .iter()
            .find(|s| s.id == session.id)
            .unwrap()
            .completion_seq
            > 0
        {
            break;
        }
        assert!(
            Instant::now() < until,
            "Stop queue effect did not precede chat append"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        !append.is_finished(),
        "append acknowledged before durability"
    );
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) }, 0);
    assert!(matches!(append.join().unwrap().unwrap(), Reply::Ack));
    let Reply::ChatPage { page, .. } = call(
        &core.home,
        Request::ChatPage {
            id: session.id,
            before: None,
            after: None,
        },
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(page.events.last().unwrap().data["text"], "durable final");
}

#[test]
fn chat_http_rotation_resets_live_cursor_and_history() {
    let core = Core::new("2.1.310 (Claude Code)");
    let session = core.session();
    let path = core.transcript(&session);
    let line = |text: &str| json!({"type":"user","message":{"content":text}}).to_string() + "\n";
    fs::write(&path, line("old one") + &line("old two")).unwrap();
    let mut ws = core.dial();
    send(&mut ws, json!({"id":1,"chat":session.id}));
    let initial = recv(&mut ws, 1)["Ok"]["page"].clone();
    assert_eq!(initial["end"], 2);
    // Ticket 801: the rotation replaces the file in one step. A rename away then a write left a moment with no file,
    // and a chat poll in that moment answered `chat_error` (No such file) and ended the watch.
    let next = path.with_extension("next");
    fs::write(&next, line("new generation")).unwrap();
    fs::hard_link(&path, path.with_extension("previous")).unwrap();
    fs::rename(&next, &path).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(Instant::now() < deadline, "missing chat_reset");
        if let Message::Text(text) = ws.read().unwrap() {
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["event"] == "chat_reset" {
                assert_eq!(frame["page"]["events"].as_array().unwrap().len(), 1);
                assert_eq!(frame["page"]["events"][0]["data"]["text"], "new generation");
                assert!(
                    frame["page"]["generation"].as_u64().unwrap()
                        > initial["generation"].as_u64().unwrap()
                );
                break;
            }
            assert_ne!(frame["event"], "chat_error", "{frame}");
        }
    }
    fs::write(&path, b"").unwrap();
    loop {
        if let Message::Text(text) = ws.read().unwrap() {
            let frame: Value = serde_json::from_str(&text).unwrap();
            assert_ne!(frame["event"], "chat_error", "{frame}");
            if frame["event"] == "chat_reset" {
                assert_eq!(frame["page"]["end"], 0);
                break;
            }
        }
    }
    fs::write(&path, line("after empty reset")).unwrap();
    loop {
        if let Message::Text(text) = ws.read().unwrap() {
            let frame: Value = serde_json::from_str(&text).unwrap();
            assert_ne!(frame["event"], "chat_error", "{frame}");
            if frame["event"] == "chat" {
                assert_eq!(
                    frame["page"]["events"][0]["data"]["text"],
                    "after empty reset"
                );
                break;
            }
        }
    }
}

#[test]
fn chat_recovery_keeps_distinct_journal_stop_texts_without_turn_ids() {
    use nunchiro_core::queue::{self, Queue, journal};
    let core = Core::with_setup("future", |home| {
        let session = Session {
            side_chat: false,
            stopped_sends: Vec::new(),
            send_waits: Default::default(),
            side_parent: None,
            teammate: None,
            resumed_from: vec![],
            owned_from: vec![],
            level: None,
            side_split: None,
            machine: None, // v1a-06: existing fixture is local.
            id: "recovery-session".into(),
            kind: AgentKind::Claude,
            project: home.join("cwd"),
            cwd: home.join("cwd"),
            label: "recovery".into(),
            auto_label: false,
            closed_by_command: false,
            state: SessionState::Resumable,
            agent_session_id: Some("recovery-conversation".into()),
            agent_version: Some("future".into()),
            untested: true,
            pid: None,
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            model: None,
            effort: None,
            start_commit: None,
            artifacts: None,     // v1b-07
            blocked: None,       // v1a-33
            holder_status: None, // V2-1b
            config_dir: None,    // V2-2b
            account: None,       // V2-2b
            conversation: None,  // V2-3b
            acp_agent: None,     // V2-4a
            problem: None,       // V2-5b
            without_hooks: false,
            no_history: false,
            account_tab: false,
            home_lock: false,
            home_mode: None,
            permission_mode: None,
            starting: false,
            at_box: false,
            ran_mode: None,
            mode_state: None, // CHAT-MODELIST
            parent: None,
            schedule: None,
            token_origin: None,
            closed_at: None,
            ended_at: None,
            started_at: None,
            agent_ended: false,
            limit: None,
            folder_gone: false,
            ended_ask: None,
            modes: None,
        };
        fs::write(
            home.join("sessions.json"),
            json!({"version":1,"sessions":[session]}).to_string(),
        )
        .unwrap();
        let mut q = Queue::open(home).unwrap();
        q.register("recovery-session", AgentKind::Claude, queue::now_ms())
            .unwrap();
        for text in ["first", "second"] {
            let prompt = journal::Event::new(
                "recovery-session".into(),
                "UserPromptSubmit".into(),
                json!({}),
            )
            .unwrap();
            q.replay(&prompt).unwrap();
            let stop = journal::Event::new(
                "recovery-session".into(),
                "Stop".into(),
                json!({"last_assistant_message":text}),
            )
            .unwrap();
            q.replay(&stop).unwrap();
            journal::write(home, &stop).unwrap();
            thread::sleep(Duration::from_millis(2));
        }
    });
    let Reply::ChatPage { page, .. } = call(
        &core.home,
        Request::ChatPage {
            id: "recovery-session".into(),
            before: None,
            after: None,
        },
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(
        page.events
            .iter()
            .skip(1)
            .map(|e| e.data["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    let pending = fs::read_dir(core.home.join("hook-journal"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
        .count();
    assert_eq!(pending, 0);
}

/// Look 11-17 v8 item 5: the window hears that the schedule list changed (`{"event":"schedules"}`) and need not poll
/// it; the core's event stream names the change `schedules_changed`, with no project and no data.
#[test]
fn the_window_hears_that_the_schedule_list_changed() {
    let core = Core::new("2.1.310 (Claude Code)");
    let project = core.session().project; // the core knows the project from a session in it
    let mut ws = core.dial();
    let since = match call(
        &core.home,
        Request::Events {
            project: None,
            since: None,
        },
    )
    .unwrap()
    {
        Reply::Events { latest, .. } => latest,
        _ => panic!(),
    };
    let run = json!({"kind":"claude","project":project,"label":"nightly"});
    let added: Value =
        serde_json::from_value(json!({"op":"schedule_add","run":run,"at":"03:30","daily":true}))
            .map(|request: Request| {
                serde_json::to_value(call(&core.home, request).unwrap()).unwrap()
            })
            .unwrap();
    assert_eq!(
        added["schedules"].as_array().map(Vec::len),
        Some(1),
        "{added}"
    );
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < until, "no schedules event");
        if let Message::Text(t) = ws.read().unwrap()
            && serde_json::from_str::<Value>(&t).unwrap() == json!({"event":"schedules"})
        {
            break;
        }
    }
    let events = match call(
        &core.home,
        Request::Events {
            project: None,
            since: Some(since),
        },
    )
    .unwrap()
    {
        Reply::Events { events, .. } => events,
        _ => panic!(),
    };
    let changed: Vec<Value> = events
        .iter()
        .filter(|e| e.kind == "schedules_changed")
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert_eq!(
        changed,
        [
            json!({"id":changed[0]["id"],"at":changed[0]["at"],"type":"schedules_changed","project":""})
        ]
    );
}
