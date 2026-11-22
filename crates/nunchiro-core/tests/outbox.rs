//! Ticket 1002 lane 2 (docs/design/home-chief-of-staff-1120.html frame 2, owner decision 11-20): through a real
//! `serve`, the Home lead stages one outward tool call per card, bound by its hash; nobody else stages. A yes not undone
//! within 10 s lets exactly that call through once (`outbox_spend`) within 10 minutes; Open by hand builds a new message
//! or event from the same arguments; Discard, 24 h unanswered and an unspent approval are No.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    approval::outward_call_hash,
    schedule::{Run, Schedules},
    server::call,
    team::{Team, Teammate},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn wait(what: &str, done: impl FnMut() -> bool) {
    wait_for(what, 15, done)
}
/// Past the card's 10 s undo time.
fn wait_long(what: &str, done: impl FnMut() -> bool) {
    wait_for(what, 30, done)
}
fn wait_for(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !done() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn raw(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}
/// One request as the owner's window sends it: over the window's WebSocket with the window token.
fn window(home: &Path, request: Value) -> Value {
    use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};
    let info = serde_json::to_value(call(home, Request::WindowAuth).unwrap()).unwrap();
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
fn rows(home: &Path) -> Vec<Session> {
    match call(home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions,
        other => panic!("{other:?}"),
    }
}
fn token_of(home: &Path, id: &str) -> String {
    let mut token = String::new();
    wait("the session printed no token", || {
        let out = match call(
            home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        ) {
            Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
            _ => String::new(),
        };
        out.split("TOKEN=")
            .nth(1)
            .and_then(|t| t.split('.').next())
            .filter(|t| !t.is_empty())
            .map(|t| token = t.to_string())
            .is_some()
    });
    token
}
fn mate(home: &Path, name: &str, project: Option<PathBuf>) -> Teammate {
    Team::open(home)
        .save(
            None,
            Teammate {
                id: String::new(),
                name: name.into(),
                job: format!("{name}'s job."),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project,
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .into_iter()
        .find(|t| t.name == name)
        .unwrap()
}

#[test]
fn outbox_card_stage_yes_no_and_expiry() {
    let home = home::short("outbox");
    fs::create_dir_all(home.join("bin")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    fs::create_dir_all(home.join("alpha")).unwrap();
    let alpha = fs::canonicalize(home.join("alpha")).unwrap();
    let serve = || {
        home::spawn_serve(
            &home,
            &[
                ("PATH", path.as_str()),
                (
                    "CLAUDE_CONFIG_DIR",
                    &home.join("claude-home").to_string_lossy(),
                ),
                ("NUNCHIRO_TEST_OPENER", "record"),
            ],
        )
    };
    let chief = mate(&home, "Chief", None);
    let main = mate(&home, "Main", Some(alpha.clone()));
    // Both seats open as a schedule opens them (a scheduled run of the Home lead may stage; it never answers).
    let mut s = Schedules::load(&home);
    for m in [&chief, &main] {
        s.add(
            Run {
                kind: AgentKind::Claude,
                project: alpha.clone(),
                label: "x".into(),
                model: None,
                effort: None,
                task: Some("start".into()),
                teammate: Some(m.id.clone()),
                level: None,
            },
            "21:00".into(),
            false,
            None,
            &BTreeSet::from([alpha.to_string_lossy().into_owned()]),
            0,
            &|_| 0,
        )
        .unwrap();
    }
    drop(s);
    let mut core = serve();
    wait("the seats did not open", || {
        let r = rows(&home);
        ["Chief", "Main"]
            .iter()
            .all(|n| r.iter().any(|s| s.label == *n))
    });
    let seat = |name: &str| rows(&home).into_iter().find(|r| r.label == name).unwrap();
    let chief_seat = seat("Chief");
    let (chief_t, main_t) = (
        token_of(&home, &chief_seat.id),
        token_of(&home, &seat("Main").id),
    );
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim().to_string();
    // The connector's real name, as the seat's lock hook gates it (ticket 1002 lane 1).
    const SEND: &str = "mcp__claude_ai_Gmail__send_message";
    let args =
        |body: &str| json!({"to":["mina.park@example.com"],"subject":"Re: Q4 roadmap","body":body});
    let stage = |token: &str, tool: &str, args: Value| {
        raw(
            &home,
            token,
            json!({"op":"outbox_stage","tool":tool,"args":args,"source":"Mina's mail of Nov 19"}),
        )
    };
    let spend = |token: &str, tool: &str, args: &Value| {
        raw(
            &home,
            token,
            json!({"op":"outbox_spend","tool":tool,"args_hash":outward_call_hash(tool, args)}),
        )
    };
    let cards = |home: &Path, owner: &str| -> Vec<Value> {
        raw(home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|c| c["owner"]["type"] == "outward")
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    let card_of = |body: &str| {
        cards(&home, &owner)
            .into_iter()
            .find(|c| c["owner"]["args"]["body"] == body)
            .unwrap_or_else(|| panic!("no card {body}"))
    };
    // The window's answer; the owner socket's (core.token, which a process outside the session tree can read) is refused.
    let answer = |_owner: &str, card: &Value, a: Value| {
        window(
            &home,
            json!({"op":"answer","item":card["id"],"answer":a,"confirmed":true}),
        )
    };
    let room = |owner: &str| {
        raw(
            &home,
            owner,
            json!({"op":"room_read","project":Team::open(&home).home()}),
        )["Ok"]["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let heard = |owner: &str, what: &str| room(owner).iter().any(|m| m["team"]["what"] == what);
    let opened = || fs::read_to_string(home.join("opened.argv")).unwrap_or_default();

    // Only the Home lead stages: a project's lead and the user's own token are refused.
    for token in [&main_t, &owner] {
        let refused = stage(token, SEND, args("Hi"));
        assert!(refused["Err"].is_string(), "{token}: {refused}");
    }
    // The body cap: a longer body is refused, never cut. A hidden bcc (a field the card does not show) is refused.
    let long = stage(&chief_t, SEND, args(&"x".repeat(8001)));
    assert!(
        long["Err"]
            .as_str()
            .is_some_and(|e| e.contains("at most 8000")),
        "{long}"
    );
    for sneaky in [
        json!({"to":["mina.park@example.com"],"subject":"s","Bcc":["x@evil.test"]}),
        json!({"to":["mina.park@example.com"],"subject":"s","draftId":"r-1"}),
        json!({"to":["mina.park@example.com?bcc=x@evil.test"],"subject":"s"}),
    ] {
        let refused = stage(&chief_t, SEND, sneaky.clone());
        assert!(refused["Err"].is_string(), "{sneaky}: {refused}");
    }
    // A reply or forward lets Gmail pick recipients and content the card never shows: not stageable.
    for tool in ["mcp__gmail__reply", "mcp__gmail__forward"] {
        let refused = stage(
            &chief_t,
            tool,
            json!({"messageId":"m1","to":["mina.park@example.com"],"body":"hi"}),
        );
        assert!(refused["Err"].is_string(), "{tool}: {refused}");
    }
    assert!(cards(&home, &owner).is_empty());

    // Hash binding: the same call is the same card; a changed word is a card of its own.
    let ready = args("Hi Mina,\n\nThe draft is ready.");
    let staged = stage(&chief_t, SEND, ready.clone());
    assert!(staged["Err"].is_null(), "{staged}");
    stage(&chief_t, SEND, ready.clone());
    stage(&chief_t, SEND, args("Hi Mina,\n\nThe draft is NOT ready."));
    let both = cards(&home, &owner);
    assert_eq!(both.len(), 2, "{both:?}");
    assert_ne!(both[0]["owner"]["hash"], both[1]["owner"]["hash"]);
    assert!(
        both.iter()
            .all(|c| c["owner"]["new_domains"] == json!(["example.com"]))
    );
    assert_eq!(both[0]["owner"]["from"], "Chief");
    let digest = raw(&home, &owner, json!({"op":"task","operation":"digest"}));
    assert_eq!(digest["Ok"]["outbox"], 2, "{digest}");
    // Ticket 1003: a third card, approved beside the first, whose send fails below.
    let late_mail = args("Hi Mina,\n\nThe draft is late.");
    stage(&chief_t, SEND, late_mail.clone());

    // Not approved: nothing to spend. A yes undone within its 10 s is never spendable.
    assert!(spend(&chief_t, SEND, &ready)["Err"].is_string());
    let first = card_of("Hi Mina,\n\nThe draft is ready.");
    let socket = raw(
        &home,
        &owner,
        json!({"op":"answer","item":first["id"],"answer":{"type":"allow_once"},"confirmed":true}),
    );
    assert!(
        socket["Err"]
            .as_str()
            .is_some_and(|e| e.contains("window only")),
        "{socket}"
    );
    assert!(card_of("Hi Mina,\n\nThe draft is ready.")["owner"]["yes_at"].is_null());
    assert!(answer(&owner, &first, json!({"type":"allow_once"}))["Err"].is_null());
    assert!(card_of("Hi Mina,\n\nThe draft is ready.")["owner"]["yes_at"].is_u64());
    assert!(
        answer(&owner, &first, json!({"type":"deny"}))["Err"].is_null(),
        "undo"
    );
    assert!(card_of("Hi Mina,\n\nThe draft is ready.")["owner"]["yes_at"].is_null());
    assert!(spend(&chief_t, SEND, &ready)["Err"].is_string());
    // A yes left alone: after 10 s the card is approved, and the Home lead's seat is told to send it.
    assert!(answer(&owner, &first, json!({"type":"allow_once"}))["Err"].is_null());
    let late_card = card_of("Hi Mina,\n\nThe draft is late.");
    assert!(answer(&owner, &late_card, json!({"type":"allow_once"}))["Err"].is_null());
    assert!(
        spend(&chief_t, SEND, &ready)["Err"].is_string(),
        "not before the undo time"
    );
    wait_long("the yes was not approved", || {
        cards(&home, &owner).len() == 1
    });
    // Look v20 S1: an Undo after the approval says so plainly.
    let late = answer(&owner, &first, json!({"type":"deny"}));
    assert!(
        late["Err"]
            .as_str()
            .is_some_and(|e| e.contains("too late to undo")),
        "{late}"
    );
    let id = first["id"].as_str().unwrap().to_string();
    wait("the Home lead was not told to send it", || {
        rows(&home).iter().any(|r| {
            r.id == chief_seat.id
                && r.send_log
                    .iter()
                    .chain(&r.send_queue)
                    .any(|s| s.content.contains(&id) && s.content.contains(SEND))
        })
    });
    assert!(heard(&owner, "outbox_yes"));
    // Spent once, by the Home lead's seat, for exactly the approved call.
    assert!(
        spend(&main_t, SEND, &ready)["Err"].is_string(),
        "another seat"
    );
    assert!(
        spend(&chief_t, SEND, &args("Hi Mina,\n\nThe draft is ready!"))["Err"].is_string(),
        "another call"
    );
    assert!(
        spend(&chief_t, "mcp__gmail__reply", &ready)["Err"].is_string(),
        "another tool"
    );
    assert!(
        spend(&owner, SEND, &ready)["Err"].is_string(),
        "the user's own token"
    );
    // Round 2 (Fable review M2, Codex MUST): spent through the seat's real PreToolUse hook, as Claude runs it: the
    // approved call is allowed once, the same call again is denied, another call or no token is denied.
    let hook = |token: Option<&str>, tool: &str, input: &Value| {
        let mut cmd = std::process::Command::new(home::cli::path());
        cmd.args(["hook", "home-lock", "--mode", "ask"])
            .env("NUNCHIRO_HOME", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if let Some(t) = token {
            cmd.env("NUNCHIRO_TOKEN", t);
        }
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"tool_name": tool, "tool_input": input})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{out:?}");
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        v["hookSpecificOutput"]["permissionDecision"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(hook(None, SEND, &ready), "deny", "no token");
    assert_eq!(
        hook(
            Some(&chief_t),
            SEND,
            &args("Hi Mina,\n\nThe draft is ready!")
        ),
        "deny",
        "another call"
    );
    // Ticket 1003 (Codex note on w79, Codex look on w85): the waiting-for row waits for that very send's own
    // PostToolUse, without an error. Two sends of one session spent in turn and ending in reverse order: the later one
    // fails, the earlier one succeeds, and exactly one row is made, for the one that went out.
    let post = |tool: &str, input: &Value, response: Value| {
        let r = raw(
            &home,
            &owner,
            json!({"op":"hook","id":chief_seat.id,"event":"PostToolUse",
                "payload":{"tool_name":tool,"tool_input":input,"tool_response":response}}),
        );
        assert!(r["Err"].is_null(), "{r}");
    };
    let loop_rows = || {
        raw(&home, &owner, json!({"op":"task","operation":"loops"}))["Ok"]["loops"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    assert_eq!(
        hook(Some(&chief_t), SEND, &ready),
        "allow",
        "the approved call"
    );
    assert_eq!(hook(Some(&chief_t), SEND, &ready), "deny", "spent once");
    assert_eq!(
        hook(Some(&chief_t), SEND, &late_mail),
        "allow",
        "the late card"
    );
    assert!(heard(&owner, "outbox_sent"));
    assert!(opened().is_empty(), "nothing opened in Mail");
    assert!(
        loop_rows().is_empty(),
        "no row before the connector answers"
    );
    post("Bash", &json!({"command":"ls"}), json!({}));
    post(
        SEND,
        &late_mail,
        json!({"isError":true,"content":[{"type":"text","text":"send failed"}]}),
    );
    assert!(
        loop_rows().is_empty(),
        "a failed send leaves no waiting row"
    );
    post(
        SEND,
        &ready,
        json!({"content":[{"type":"text","text":"sent"}]}),
    );

    // Ticket 1003: the yes that went out as a mail makes a waiting-for row, kept and counted by the core.
    let task = |token: &str, v: Value| raw(&home, token, v);
    let loops = |token: &str| task(token, json!({"op":"task","operation":"loops"}));
    let open = || {
        loops(&owner)["Ok"]["loops"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let counts = || task(&owner, json!({"op":"task","operation":"digest"}))["Ok"]["loops"].clone();
    let row = open()
        .first()
        .cloned()
        .unwrap_or_else(|| panic!("an Outbox yes made no waiting-for row"));
    assert_eq!(open().len(), 1);
    assert_eq!(
        (
            row["id"].as_str(),
            row["kind"].as_str(),
            row["who"].as_str(),
            row["what"].as_str()
        ),
        (
            Some("L1"),
            Some("waiting"),
            Some("mina.park@example.com"),
            Some("a reply to \"Re: Q4 roadmap\"")
        )
    );
    assert_eq!(row["source"], format!("Outbox card {id}"));
    assert_eq!(counts(), json!({"promises":0,"waiting":1,"overdue":0}));
    // The Home lead reads them; a project's lead does not.
    assert_eq!(loops(&chief_t)["Ok"]["loops"][0]["id"], "L1");
    assert!(loops(&main_t)["Err"].is_string());
    // A promise the Home lead heard is a card first: no row before the user's yes, and the same ask twice is one card.
    let loop_cards = |change: &str| -> Vec<Value> {
        raw(&home, &owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|c| c["owner"]["type"] == "loop" && c["owner"]["change"] == change)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    let promise = json!({"op":"task","operation":"promise","text":"the Q4 roadmap","who":"Mina Park","due":"2020-01-02"});
    assert!(
        task(&main_t, promise.clone())["Err"].is_string(),
        "a project's lead"
    );
    for _ in 0..2 {
        let asked = task(&chief_t, promise.clone());
        assert!(asked["Err"].is_null(), "{asked}");
    }
    let add = loop_cards("add");
    assert_eq!(add.len(), 1, "{add:?}");
    assert_eq!(
        (
            add[0]["owner"]["from"].as_str(),
            add[0]["owner"]["row"]["who"].as_str()
        ),
        (Some("Chief"), Some("Mina Park"))
    );
    assert_eq!(open().len(), 1, "nothing kept before the yes");
    assert!(answer(&owner, &add[0], json!({"type":"allow_once"}))["Err"].is_null());
    assert_eq!(open().len(), 2);
    assert!(heard(&owner, "loop_yes"));
    // Its due date has passed: one card of the core's own, counted. Dismissed, it stays overdue and never comes back.
    wait("the overdue loop raised no card", || {
        loop_cards("overdue").len() == 1
    });
    assert_eq!(loop_cards("overdue")[0]["owner"]["row"]["id"], "L2");
    assert_eq!(counts(), json!({"promises":1,"waiting":1,"overdue":1}));
    let digest = task(&owner, json!({"op":"task","operation":"digest"}));
    assert_eq!(
        digest["Ok"]["loop_cards"], 1,
        "the overdue card needs the user: {digest}"
    );
    assert!(answer(&owner, &loop_cards("overdue")[0], json!({"type":"deny"}))["Err"].is_null());
    // The user's own shell keeps a row at once; that one is overdue too, and only it gets a card.
    let own = task(
        &owner,
        json!({"op":"task","operation":"waiting","text":"the signed contract","who":"Alex","due":"2020-01-01"}),
    );
    assert!(own["Err"].is_null(), "{own}");
    wait("the second overdue loop raised no card", || {
        loop_cards("overdue").len() == 1
    });
    thread::sleep(Duration::from_millis(2500));
    let late = loop_cards("overdue");
    assert_eq!(
        late.iter()
            .map(|c| c["owner"]["row"]["id"].as_str())
            .collect::<Vec<_>>(),
        [Some("L3")]
    );
    assert_eq!(counts()["overdue"], 2);
    // The lead found the promise done: a close card (one per loop); the yes closes it. A yes on the overdue card closes too.
    for _ in 0..2 {
        let asked = task(
            &chief_t,
            json!({"op":"task","operation":"loop-close","id":"L2","text":"sent on Monday"}),
        );
        assert!(asked["Err"].is_null(), "{asked}");
    }
    let close = loop_cards("close");
    assert_eq!(close.len(), 1, "{close:?}");
    assert_eq!(close[0]["owner"]["why"], "sent on Monday");
    assert_eq!(open().len(), 3, "open until the yes");
    assert!(answer(&owner, &close[0], json!({"type":"allow_once"}))["Err"].is_null());
    assert!(heard(&owner, "loop_closed"));
    assert!(answer(&owner, &late[0], json!({"type":"allow_once"}))["Err"].is_null());
    assert_eq!(
        open().iter().map(|r| r["id"].as_str()).collect::<Vec<_>>(),
        [Some("L1")]
    );
    assert!(loop_cards("overdue").is_empty() && loop_cards("close").is_empty());
    // The user's own shell closes a row at once.
    assert!(
        task(
            &owner,
            json!({"op":"task","operation":"loop-close","id":"L1"})
        )["Err"]
            .is_null()
    );
    assert!(open().is_empty());
    assert!(counts().is_null(), "no open loop, no counts");

    // Open by hand: Mail gets a new message built from that card's arguments; it is not spendable.
    let not_ready = args("Hi Mina,\n\nThe draft is NOT ready.");
    let hand = card_of("Hi Mina,\n\nThe draft is NOT ready.");
    assert!(answer(&owner, &hand, json!({"type":"choose","index":1}))["Err"].is_null());
    assert!(
        opened().contains(
            "mailto:mina.park@example.com?subject=Re%3A%20Q4%20roadmap&body=Hi%20Mina%2C%0D%0A%0D%0AThe%20draft%20is%20NOT%20ready."
        ),
        "{}",
        opened()
    );
    assert!(spend(&chief_t, SEND, &not_ready)["Err"].is_string());
    assert!(heard(&owner, "outbox_hand"));
    // The recipient-domain tag: a yes to example.com makes its next card known; another domain is new.
    stage(&chief_t, SEND, args("A second note."));
    stage(
        &chief_t,
        SEND,
        json!({"to":["ops@example.net"],"subject":"s","body":"Hello"}),
    );
    assert_eq!(
        card_of("A second note.")["owner"]["new_domains"],
        Value::Null
    );
    assert_eq!(
        card_of("Hello")["owner"]["new_domains"],
        json!(["example.net"])
    );
    // Discard is No.
    assert!(answer(&owner, &card_of("Hello"), json!({"type":"deny"}))["Err"].is_null());
    assert!(heard(&owner, "outbox_no"));

    // An event: open by hand writes a new .ics built from the card.
    let event = stage(
        &chief_t,
        "mcp__calendar__create_event",
        json!({"summary":"Lunch, Mina","startTime":"2026-11-24T12:00:00","endTime":"2026-11-24T13:00:00"}),
    );
    assert!(event["Err"].is_null(), "{event}");
    let ev = cards(&home, &owner)
        .into_iter()
        .find(|c| c["owner"]["tool"] == "mcp__calendar__create_event")
        .unwrap();
    assert!(answer(&owner, &ev, json!({"type":"choose","index":1}))["Err"].is_null());
    let ics = home
        .join("outbox")
        .join(format!("{}.ics", ev["id"].as_str().unwrap()));
    assert!(opened().contains(&*ics.to_string_lossy()), "{}", opened());
    let text = fs::read_to_string(&ics).unwrap();
    assert!(
        text.contains("SUMMARY:Lunch\\, Mina\r\n") && text.contains("DTSTART:20261124T120000\r\n"),
        "{text}"
    );

    // Two waiting cards: one whose stored call no longer matches its hash, one asked 25 h ago; one approved but unspent;
    // one with a yes written into the store by hand. After a restart the approval is gone (memory only), the stored yes
    // approves nothing, the yes on the tampered card refuses and the old card expires as No.
    stage(&chief_t, SEND, args("Tampered."));
    stage(&chief_t, SEND, args("Old."));
    let lapses = args("Lapses.");
    stage(&chief_t, SEND, lapses.clone());
    assert!(answer(&owner, &card_of("Lapses."), json!({"type":"allow_once"}))["Err"].is_null());
    wait_long("the yes was not approved", || {
        !cards(&home, &owner)
            .iter()
            .any(|c| c["owner"]["args"]["body"] == "Lapses.")
    });
    stage(&chief_t, SEND, args("Forged yes."));
    core.stop();
    let file = home.join("queue.json");
    let mut disk: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert!(
        !disk.to_string().contains("Lapses."),
        "an approval is never on disk"
    );
    for item in disk["owner"].as_array_mut().unwrap() {
        match item["owner"]["args"]["body"].as_str() {
            Some("Tampered.") => item["owner"]["args"]["cc"] = json!(["x@evil.test"]),
            Some("Old.") => {
                item["observed_at"] =
                    json!(item["observed_at"].as_u64().unwrap() - 25 * 3600 * 1000)
            }
            Some("Forged yes.") => item["owner"]["yes_at"] = json!(1),
            _ => {}
        }
    }
    fs::write(&file, serde_json::to_vec(&disk).unwrap()).unwrap();
    let _core = serve();
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim().to_string();
    let find = |owner: &str, body: &str| {
        cards(&home, owner)
            .into_iter()
            .find(|c| c["owner"]["args"]["body"] == body)
            .unwrap_or_else(|| panic!("no card {body}"))
    };
    wait("the old card did not expire", || {
        !cards(&home, &owner)
            .iter()
            .any(|c| c["owner"]["args"]["body"] == "Old.")
    });
    assert!(
        spend(&chief_t, SEND, &lapses)["Err"].is_string(),
        "no approval survives a restart"
    );
    thread::sleep(Duration::from_secs(11));
    assert!(
        find(&owner, "Forged yes.")["owner"]["yes_at"].is_null(),
        "a stored yes is never read"
    );
    assert!(spend(&chief_t, SEND, &args("Forged yes."))["Err"].is_string());
    let refused = answer(
        &owner,
        &find(&owner, "Tampered."),
        json!({"type":"allow_once"}),
    );
    assert!(
        refused["Err"]
            .as_str()
            .is_some_and(|e| e.contains("does not match its hash")),
        "{refused}"
    );
    wait("the Home lead did not hear the expiry", || {
        heard(&owner, "outbox_expired")
    });
}
