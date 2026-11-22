//! V2-8b: PR badge tier 1. `chat::pr::scan` is pure over projected events; `pr_chip` is a window-only op.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, chat::pr, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const URL: &str = "https://github.com/develku/nunchiro/pull/12";

fn events(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pr_chip");
    serde_json::from_str(&fs::read_to_string(path.join(name)).unwrap()).unwrap()
}
fn chip(ev: &[Value]) -> Option<(String, String, Option<String>)> {
    pr::scan(ev).map(|c| {
        let v = serde_json::to_value(&c).unwrap();
        (
            v["state"].as_str().unwrap().into(),
            v["url"].as_str().unwrap().into(),
            v["at"].as_str().map(Into::into),
        )
    })
}
fn run(tool: &str, key: &str, cmd: Value, output: &str, is_error: bool) -> Vec<Value> {
    vec![
        json!({"kind":"tool_use","tool_id":"t","name":tool,"input":{key:cmd}}),
        json!({"kind":"tool_result","tool_id":"t","output":output,"is_error":is_error,"at":"2026-10-27T00:00:00.000Z"}),
    ]
}

#[test]
fn pr_chip_from_transcript_fixture() {
    let claude = events("claude.events.json");
    let got = |ev: &[Value]| chip(ev).map(|c| (c.0, c.1));
    // An older create, then checks_fail; the failed `checks` result changes nothing; the newest view wins.
    assert_eq!(got(&claude[..2]), Some(("open".into(), URL.into())));
    assert_eq!(got(&claude[..4]), Some(("checks_fail".into(), URL.into())));
    assert_eq!(
        chip(&claude[..6]).unwrap().2.as_deref(),
        Some("2026-10-27T10:05:00.000Z")
    );
    assert_eq!(
        chip(&claude),
        Some((
            "merged".into(),
            URL.into(),
            Some("2026-10-27T11:00:00.000Z".into())
        ))
    );
    let codex = events("codex.events.json");
    assert_eq!(got(&codex[..2]), Some(("draft".into(), URL.into())));
    assert_eq!(
        chip(&codex),
        Some((
            "checks_pass".into(),
            URL.into(),
            Some("2026-10-27T09:10:00.000Z".into())
        ))
    );
    // A result from before the `at` field existed gives a chip with no age.
    let mut old = claude[..2].to_vec();
    old[1].as_object_mut().unwrap().remove("at");
    assert_eq!(chip(&old), Some(("open".into(), URL.into(), None)));
}

#[test]
fn pr_status_reads_current_branch_block() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pr_chip/status.txt");
    let status = fs::read_to_string(path).unwrap();
    let mut ev = run("Bash", "command", json!("gh pr create"), URL, false);
    ev.extend(
        run("Bash", "command", json!("gh pr status"), &status, false)
            .into_iter()
            .map(|mut e| {
                e["tool_id"] = json!("s");
                e
            }),
    );
    // Another PR is Approved; the current branch's is Checks failing.
    assert_eq!(chip(&ev).map(|c| c.0).as_deref(), Some("checks_fail"));
    // A status with no Current branch block says nothing about this PR: the earlier chip stays.
    let other = status.replace("Current branch", "Elsewhere");
    let mut ev = run("Bash", "command", json!("gh pr create"), URL, false);
    ev.extend(
        run("Bash", "command", json!("gh pr status"), &other, false)
            .into_iter()
            .map(|mut e| {
                e["tool_id"] = json!("s");
                e
            }),
    );
    assert_eq!(chip(&ev).map(|c| c.0).as_deref(), Some("open"));
}

#[test]
fn pr_status_block_for_another_pr_is_ignored() {
    let status = |n: u32| {
        format!(
            "Current branch\n  #{n}  Add the PR chip [x]\n   - Checks failing - Review required\n"
        )
    };
    let after = |status: &str| {
        let mut ev = run(
            "Bash",
            "command",
            json!("gh pr create"),
            "https://github.com/develku/nunchiro/pull/53",
            false,
        );
        ev.extend(
            run("Bash", "command", json!("gh pr status"), status, false)
                .into_iter()
                .map(|mut e| {
                    e["tool_id"] = json!("s");
                    e
                }),
        );
        chip(&ev).map(|c| c.0)
    };
    // A block for #52 is not the chip's PR: the earlier state stays.
    assert_eq!(after(&status(52)).as_deref(), Some("open"));
    assert_eq!(after(&status(53)).as_deref(), Some("checks_fail"));
}

/// The chip after `gh pr create` (so the URL is known) and then one `cmd` whose output is `out`.
fn after_create(cmd: &str, out: &str) -> Option<String> {
    let mut ev = run("Bash", "command", json!("gh pr create"), URL, false);
    ev.extend(
        run("Bash", "command", json!(cmd), out, false)
            .into_iter()
            .map(|mut e| {
                e["tool_id"] = json!("v");
                e
            }),
    );
    chip(&ev).map(|c| c.0)
}

#[test]
fn approved_in_body_is_not_approved_state() {
    let body = "Approved by the owner, approved design.";
    let plain = |state: &str, reviewers: &str| {
        format!(
            "title:\tMake the approved flow\nstate:\t{state}\nreviewers:\t{reviewers}\nurl:\t{URL}\n--\n{body}\nreviewers: owner (Approved)\n"
        )
    };
    let json_view = format!(
        r#"{{"title":"approved flow","body":"{body}","state":"OPEN","reviewDecision":"REVIEW_REQUIRED","url":"{URL}"}}"#
    );
    assert_eq!(
        after_create("gh pr view 12", &plain("OPEN", "")).as_deref(),
        Some("open")
    );
    assert_eq!(
        after_create("gh pr view 12", &plain("OPEN", "bob (Commented)")).as_deref(),
        Some("open")
    );
    assert_eq!(
        after_create("gh pr view 12 --json state", &json_view).as_deref(),
        Some("open")
    );
    // `gh pr status`: the title line is not the review state.
    let status = "Current branch\n  #12  Approved flow [x]\n   - Checks passing - Review required\n\nCreated by you\n  #9  Old [y]\n   - Approved\n";
    assert_eq!(
        after_create("gh pr status", status).as_deref(),
        Some("checks_pass")
    );
}

#[test]
fn review_decision_approved_is_approved() {
    let json_view = format!(r#"{{"state":"OPEN","reviewDecision":"APPROVED","url":"{URL}"}}"#);
    let spaced = json_view.replace("\":\"", "\": \"");
    for out in [json_view, spaced] {
        assert_eq!(
            after_create("gh pr view 12 --json state,reviewDecision", &out).as_deref(),
            Some("approved")
        );
    }
    let plain = |reviewers: &str| {
        format!("title:\tx\nstate:\tOPEN\nreviewers:\t{reviewers}\nurl:\t{URL}\n--\nbody\n")
    };
    assert_eq!(
        after_create("gh pr view 12", &plain("alice (Approved), bob (Commented)")).as_deref(),
        Some("approved")
    );
    assert_eq!(
        after_create(
            "gh pr view 12",
            &format!("state:\tOPEN\nReview decision: Approved\n{URL}\n")
        )
        .as_deref(),
        Some("approved")
    );
    // A change request keeps it out, as before.
    assert_eq!(
        after_create(
            "gh pr view 12",
            &plain("alice (Approved), bob (Changes requested)")
        )
        .as_deref(),
        Some("open")
    );
    // `gh pr status`: the current branch's summary item.
    let status = |item: &str| {
        format!(
            "Current branch\n  #12  Add the PR chip [x]\n   - {item}\n\nCreated by you\n  #9  Old [y]\n   - Checks failing\n"
        )
    };
    assert_eq!(
        after_create("gh pr status", &status("Checks passing - Approved")).as_deref(),
        Some("approved")
    );
    assert_eq!(
        after_create("gh pr status", &status("Approved")).as_deref(),
        Some("approved")
    );
}

#[test]
fn no_pr_in_transcript_no_chip() {
    let out = format!("{URL}\n");
    let cases = [
        run("Bash", "command", json!("gh pr list"), &out, false),
        run("Bash", "command", json!("ghx pr create"), &out, false),
        run("Bash", "command", json!("echo gh-pr-create"), &out, false),
        run("Bash", "command", json!("gh pr create"), &out, true),
        run("Read", "command", json!("gh pr create"), &out, false),
        // A message that mentions gh is not a tool run.
        vec![
            json!({"kind":"message","role":"assistant","text":format!("run gh pr create: {URL}")}),
        ],
        // The result text names another origin: no chip rather than an unsafe link.
        run(
            "Bash",
            "command",
            json!("gh pr create"),
            "javascript:alert(1)\nhttps://evil.example/o/r/pull/1",
            false,
        ),
        run(
            "Bash",
            "command",
            json!("gh pr create"),
            "https://github.com.evil.example/o/r/pull/1",
            false,
        ),
    ];
    for ev in &cases {
        assert_eq!(pr::scan(ev), None, "{ev:?}");
    }
    assert_eq!(pr::scan(&[]), None);
}

#[test]
fn tier1_spawns_nothing() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let http = fs::read_to_string(root.join("src/http/mod.rs")).unwrap();
    let start = http.find("fn read_pr_chip").expect("read_pr_chip");
    let body = &http[start..];
    let body = &body[..body.find("\nfn ").unwrap_or(body.len())];
    let pr_src = fs::read_to_string(root.join("src/chat/pr.rs")).unwrap();
    for banned in [
        "Command",
        "process::",
        "TcpStream",
        "UnixStream",
        "reqwest",
        "tokio",
        "std::net",
    ] {
        assert!(!pr_src.contains(banned), "pr.rs uses {banned}");
        assert!(!body.contains(banned), "read_pr_chip uses {banned}");
    }

    let core = Core::new();
    let marker = core.home.join("gh-ran");
    let shim = core.home.join("bin/gh");
    fs::write(&shim, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
    fs::set_permissions(shim, fs::Permissions::from_mode(0o700)).unwrap();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &pr_transcript("gh pr create"));
    let reply = core.window(json!({"op":"pr_chip","id":s.id}));
    assert_eq!(reply["Ok"]["chip"]["state"], "open", "{reply}");
    assert_eq!(reply["Ok"]["chip"]["url"], URL);
    assert_eq!(reply["Ok"]["chip"]["at"], "2026-10-27T10:00:00.000Z");
    thread::sleep(Duration::from_millis(200));
    assert!(!marker.exists(), "gh was spawned");
}

#[test]
fn pr_chip_is_window_only() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n");
    let reply = core.window(json!({"op":"pr_chip","id":s.id}));
    assert_eq!(reply["Ok"]["chip"], Value::Null, "{reply}");
    assert!(core.window(json!({"op":"pr_chip","id":"missing"}))["Err"].is_string());
    // The owner socket answers only through the window dispatch.
    let owner = call(&core.home, Request::PrChip { id: s.id.clone() });
    assert!(owner.is_err(), "{owner:?}");
    // Not forwardable to another machine.
    let forwarded = call(
        &core.home,
        Request::Remote {
            machine: "nowhere".into(),
            request: Box::new(Request::PrChip { id: s.id }),
        },
    );
    assert!(forwarded.unwrap_err().contains("local owner-only"));
}

#[test]
fn pr_chip_refused_for_session_token() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &pr_transcript("gh pr create"));
    let agent = core.start(
        AgentKind::Shell,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
        ],
    );
    let until = Instant::now() + Duration::from_secs(5);
    let token = loop {
        let Reply::Output { data, .. } = call(
            &core.home,
            Request::Read {
                id: agent.id.clone(),
                after: 0,
            },
        )
        .unwrap() else {
            panic!()
        };
        let out = String::from_utf8_lossy(&data).into_owned();
        if let Some(l) = out
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
        {
            break l.trim().to_string();
        }
        assert!(Instant::now() < until, "session printed no token");
        thread::sleep(Duration::from_millis(20));
    };
    let mut sock = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    writeln!(
        sock,
        "{}",
        json!({"token":token,"request":{"op":"pr_chip","id":s.id}})
    )
    .unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap(),
        json!({"Err":"operation not granted"})
    );
    call(&core.home, Request::Close { id: agent.id }).unwrap();
}

fn pr_transcript(command: &str) -> String {
    let a = json!({"type":"assistant","timestamp":"2026-10-27T09:59:00.000Z","message":{"content":[{"type":"tool_use","id":"u1","name":"Bash","input":{"command":command}}]}});
    let r = json!({"type":"user","timestamp":"2026-10-27T10:00:00.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":URL}]}});
    format!("{a}\n{r}\n")
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("prchip");
        fs::create_dir_all(home.join("bin")).unwrap();
        let fake = home.join("bin/claude");
        fs::write(&fake, b"#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"2.1.310 (Claude Code)\"; exit; fi\nexec /bin/cat\n").unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("cwd")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("agent"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn start(&self, kind: AgentKind, args: Vec<String>) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind,
                    project: self.home.join("cwd"),
                    worktree: false,
                    label: "prchip".into(),
                    args,
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
    fn transcript(&self, s: &Session, body: &str) {
        let encoded: String = s
            .cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let dir = self.home.join("agent/projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()));
        fs::write(&path, body).unwrap();
        call(
            &self.home,
            Request::Hook {
                id: s.id.clone(),
                event: "SessionStart".into(),
                payload: json!({"session_id":s.agent_session_id,"transcript_path":path}),
            },
        )
        .unwrap();
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
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut ws = tungstenite::client(req, stream).unwrap().0;
        ws.send(Message::Text(
            json!({"id":7,"request":request}).to_string().into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
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
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
