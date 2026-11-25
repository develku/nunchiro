//! V2-CF4: the `subagents` op is a window-only read of the session's own transcript or of its ACP agent's in-memory
//! `subagent_update`s. Nothing here sends, answers or writes: the fake agent logs every stdin read and the test
//! compares that log and the transcript bytes before and after each request.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
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

/// The fake Claude of `perm_chip`, so a request that reaches the PTY would be logged as hex.
fn claude() -> String {
    fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-mode"))
        .unwrap()
}

/// A child launch as Claude 2.1.310 writes it, and its sidechain's end.
fn launched(id: &str, label: &str) -> Value {
    json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Task",
        "input":{"description":label,"prompt":"look"}}]}})
}
fn ended(id: &str) -> Value {
    json!({"type":"assistant","isSidechain":true,"parentToolUseID":id,
        "message":{"stop_reason":"end_turn","content":[]}})
}

#[test]
fn subagent_fold_never_sends() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(
        &s,
        &format!("{}\n{}\n", launched("t1", "Explore: one"), ended("t1")),
    );
    let before = fs::read(core.transcript_path(&s)).unwrap();
    let reads = || core.reads(&s.id).len();
    let reads_before = reads();
    for _ in 0..5 {
        let reply = core.window(json!({"op":"subagents","id":s.id}));
        assert_eq!(reply["Ok"]["kids"].as_array().unwrap().len(), 1, "{reply}");
    }
    assert!(core.window(json!({"op":"subagents","id":"missing"}))["Err"].is_string());
    assert_eq!(reads(), reads_before, "the subagents read wrote to the PTY");
    assert_eq!(
        fs::read(core.transcript_path(&s)).unwrap(),
        before,
        "the transcript changed"
    );
    // No queue item was made by reading either.
    assert!(core.snapshot().pending_of(&s.id).is_empty());
}

/// The op is window-only: the owner socket answers only through the window dispatch, and it is not forwarded.
#[test]
fn subagents_is_window_only() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &format!("{}\n", launched("t1", "Explore: one")));
    let owner = call(
        &core.home,
        Request::Subagents {
            id: s.id.clone(),
            open: None,
        },
    );
    assert_eq!(
        owner.unwrap_err(),
        "subagents require unlocked transport dispatch"
    );
    let forwarded = call(
        &core.home,
        Request::Remote {
            machine: "nowhere".into(),
            request: Box::new(Request::Subagents {
                id: s.id,
                open: None,
            }),
        },
    );
    let err = forwarded.unwrap_err();
    assert!(err.contains("local owner-only"), "{err}");
}

/// A session token is not owner authority: the op is refused as an ungranted operation.
#[test]
fn subagents_refused_for_session_token() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &format!("{}\n", launched("t1", "Explore: one")));
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
        json!({"token":token,"request":{"op":"subagents","id":s.id}})
    )
    .unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap(),
        json!({"Err":"operation not granted"})
    );
    // Ticket 1059: nor may a session token type /context through the Context widget's refresh.
    let mut sock = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    writeln!(
        sock,
        "{}",
        json!({"token":token,"request":{"op":"session_context","id":s.id,"refresh":true}})
    )
    .unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap(),
        json!({"Err":"operation not granted"})
    );
    assert!(!core.reads(&s.id).concat().contains(CONTEXT_HEX));
    call(&core.home, Request::Close { id: agent.id }).unwrap();
}

/// "/context" as the fake Claude logs its stdin (hex).
const CONTEXT_HEX: &str = "2f636f6e74657874";

/// Ticket 1059: the window's refresh types /context into an idle local Claude through the send queue, and is refused
/// for a shell and while the agent works (nothing typed then).
#[test]
fn t1059_context_refresh_only_into_idle_claude() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, "");
    let refresh = |id: &str| core.window(json!({"op":"session_context","id":id,"refresh":true}));
    let shell = core.start(
        AgentKind::Shell,
        vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
    );
    assert_eq!(
        refresh(&shell.id)["Err"],
        "context breakdown not sent: the breakdown is read from a local Claude session only"
    );
    let hook = |event: &str, payload: Value| {
        call(
            &core.home,
            Request::Hook {
                id: s.id.clone(),
                event: event.into(),
                payload,
            },
        )
        .unwrap()
    };
    hook("UserPromptSubmit", json!({"prompt":"work"}));
    assert_eq!(
        refresh(&s.id)["Err"],
        "context breakdown not sent: the agent is working"
    );
    assert!(!core.reads(&s.id).concat().contains(CONTEXT_HEX));
    hook("Stop", json!({}));
    let reply = refresh(&s.id);
    assert!(reply["Ok"].is_object(), "{reply}");
    let until = Instant::now() + Duration::from_secs(10);
    while !core.reads(&s.id).concat().contains(CONTEXT_HEX) {
        assert!(
            Instant::now() < until,
            "/context never reached the agent: {:?}",
            core.reads(&s.id)
        );
        thread::sleep(Duration::from_millis(50));
    }
    call(&core.home, Request::Close { id: shell.id }).unwrap();
}

/// A reporting ACP agent's children reach the tree through the same op, with its lifecycle states; its chat carries no
/// child rows, so `↳ N` is the only place they show.
#[test]
fn subagents_acp_kinds_reported() {
    let toml = "[[agent]]\nname = \"subs\"\n{fake}]\nenv = []\n";
    let core = Acp::new(toml);
    core.approve("subs");
    let id = core.start("subs");
    core.prompt(&id, "subagents");
    core.wait_done(&id);
    let kids = core.window(json!({"op":"subagents","id":id}))["Ok"]["kids"].clone();
    let rows: Vec<(String, String)> = kids
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            (
                k["label"].as_str().unwrap().to_string(),
                k["state"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("Test investigator".to_string(), "done".to_string()),
            ("Plan the page".to_string(), "failed".to_string()),
        ],
        "{kids}"
    );
    let chat = core.owner(json!({"op":"chat_page","id":id}))["page"]["events"].to_string();
    assert!(
        !chat.contains("Test investigator"),
        "a child became a chat row"
    );
}

// ---- needs 169: opening one sub-agent's own output --------------------------------------------------------------------

fn fixture(name: &str) -> String {
    fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat/subagents")
            .join(name),
    )
    .unwrap()
}

/// `open`ing a launch id, as the window asks.
fn open(home: &std::path::Path, session: &str, kid: &str) -> Value {
    window_at(home, json!({"op":"subagents","id":session,"open":kid}))
}

/// One line per projected event, from the reply's literal rows: `role: text`, `tool_use NAME`, `tool_result`.
fn rows(reply: &Value) -> Vec<String> {
    reply["Ok"]["opened"]["events"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|e| {
            let d = &e["data"];
            match d["kind"].as_str().unwrap() {
                "message" => format!(
                    "{}: {}",
                    d["role"].as_str().unwrap(),
                    d["text"].as_str().unwrap()
                ),
                "tool_use" => format!("tool_use {}", d["name"].as_str().unwrap()),
                other => other.to_string(),
            }
        })
        .collect()
}

impl Core {
    /// `<session-id>/subagents` beside the parent transcript, where Claude Code 2.1.312 writes children.
    fn children(&self, s: &Session) -> PathBuf {
        let dir = self.transcript_path(s).with_extension("").join("subagents");
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// Writes `agent-<agent>.meta.json` (toolUseId `kid`) and `agent-<agent>.jsonl`.
    fn child(&self, s: &Session, agent: &str, kid: &str, body: &str) {
        let dir = self.children(s);
        let mut meta: Value = serde_json::from_str(&fixture("claude-child.meta.json")).unwrap();
        meta["toolUseId"] = kid.into();
        fs::write(
            dir.join(format!("agent-{agent}.meta.json")),
            meta.to_string(),
        )
        .unwrap();
        fs::write(dir.join(format!("agent-{agent}.jsonl")), body).unwrap();
    }
}

const CLAUDE_CHILD_ROWS: [&str; 5] = [
    "user: Find the ssh callers.",
    "assistant: Looking in the child.",
    "tool_use Grep",
    "tool_result",
    "assistant: Found three callers.",
];

#[test]
fn claude_child_transcript_found_by_tool_use_id() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(
        &s,
        &format!(
            "{}\n{}\n",
            launched("t1", "Explore: one"),
            launched("t2", "Explore: two")
        ),
    );
    core.child(&s, "aX1", "t1", &fixture("claude-child.jsonl"));
    let reply = open(&core.home, &s.id, "t1");
    assert_eq!(reply["Ok"]["opened"]["source"], "child", "{reply}");
    assert_eq!(
        rows(&reply),
        CLAUDE_CHILD_ROWS,
        "the child's own rows, not dropped as sidechain"
    );
    assert_eq!(reply["Ok"]["opened"]["truncated"], false);
    assert_eq!(reply["Ok"]["kids"].as_array().unwrap().len(), 2);
    // t2 has no file: the parent's chat at the launch call. Its cursor is the launch event's own.
    let reply = open(&core.home, &s.id, "t2");
    assert_eq!(reply["Ok"]["opened"]["source"], "parent", "{reply}");
    assert_eq!(rows(&reply), Vec::<String>::new());
    let chat = core.window(json!({"op":"chat_page","id":s.id}));
    let launch = chat["Ok"]["page"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["data"]["kind"] == "tool_use" && e["data"]["tool_id"] == "t2")
        .unwrap_or_else(|| panic!("{chat}"));
    assert_eq!(reply["Ok"]["opened"]["cursor"], launch["cursor"]);
}

#[test]
fn claude_background_child_found() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    // A background launch: the parent's result is `async_launched` with the agent id, and the child's file is found by
    // the same `toolUseId` of its meta file, however the launch ended.
    let result = json!({"type":"user","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"aX1"},
        "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Async agent launched"}]}});
    core.transcript(
        &s,
        &format!("{}\n{result}\n", launched("t1", "Explore: bg")),
    );
    core.child(&s, "aX1", "t1", &fixture("claude-child.jsonl"));
    core.child(
        &s,
        "aY9",
        "t9",
        &fixture("claude-child.jsonl").replace("Found three callers.", "OTHER LAUNCH"),
    );
    let reply = open(&core.home, &s.id, "t1");
    assert_eq!(rows(&reply), CLAUDE_CHILD_ROWS, "{reply}");
    assert!(
        !reply.to_string().contains("OTHER LAUNCH"),
        "another launch's meta file was read for t1"
    );
    assert_eq!(
        rows(&open(&core.home, &s.id, "t9"))[4],
        "assistant: OTHER LAUNCH"
    );
}

#[test]
fn child_read_is_confined() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &format!("{}\n", launched("t1", "Explore: one")));
    // An id outside [A-Za-z0-9_-]{1,128} is refused before any path exists.
    for bad in ["../x", "a/b", "", "a\u{0}b", &"a".repeat(129)] {
        let reply = open(&core.home, &s.id, bad);
        assert_eq!(reply["Err"], "invalid sub-agent id", "{bad:?}: {reply}");
    }
    assert_eq!(
        rows(&open(&core.home, &s.id, &"a".repeat(128))).len(),
        0,
        "128 bytes is allowed"
    );
    // The request has no path field to carry one.
    let ask = serde_json::to_value(Request::Subagents {
        id: "x".into(),
        open: Some("y".into()),
    })
    .unwrap();
    assert_eq!(ask, json!({"op":"subagents","id":"x","open":"y"}));
    // A symlinked child file is never followed, even to a real file: parent fallback, nothing read.
    let outside = core.home.join("outside.jsonl");
    fs::write(
        &outside,
        fixture("claude-child.jsonl").replace("Found three callers.", "SECRET"),
    )
    .unwrap();
    let dir = core.children(&s);
    let mut meta: Value = serde_json::from_str(&fixture("claude-child.meta.json")).unwrap();
    meta["file"] = "../../../outside.jsonl".into(); // a path in the meta file is ignored
    meta["transcript"] = outside.to_string_lossy().into();
    fs::write(dir.join("agent-aX1.meta.json"), meta.to_string()).unwrap();
    let reply = open(&core.home, &s.id, "t1");
    assert_eq!(
        reply["Ok"]["opened"]["source"], "parent",
        "meta paths are ignored: {reply}"
    );
    std::os::unix::fs::symlink(&outside, dir.join("agent-aX1.jsonl")).unwrap();
    let reply = open(&core.home, &s.id, "t1");
    assert_eq!(reply["Ok"]["opened"]["source"], "parent", "{reply}");
    assert!(!reply.to_string().contains("SECRET"));
    // A `subagents` folder that is itself a link is refused too.
    fs::remove_file(dir.join("agent-aX1.jsonl")).unwrap();
    fs::remove_dir_all(&dir).unwrap();
    let elsewhere = core.home.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(
        elsewhere.join("agent-aX1.meta.json"),
        fixture("claude-child.meta.json"),
    )
    .unwrap();
    fs::write(
        elsewhere.join("agent-aX1.jsonl"),
        fixture("claude-child.jsonl").replace("Found three callers.", "SECRET"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
    let reply = open(&core.home, &s.id, "t1");
    assert_eq!(reply["Ok"]["opened"]["source"], "parent", "{reply}");
    assert!(!reply.to_string().contains("SECRET"));
}

#[test]
fn child_read_is_bounded_and_read_only() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &format!("{}\n", launched("t1", "Explore: one")));
    // 3 MiB of one-kilobyte messages: only the newest of the last 256 KiB are returned, at most 400.
    let line = |i: usize| {
        json!({"isSidechain":true,"agentId":"aX1","type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":format!("line {i:05} {}", "x".repeat(1000))}]}})
    };
    let n = 3 * 1024;
    let body: String = (0..n).map(|i| format!("{}\n", line(i))).collect();
    core.child(&s, "aX1", "t1", &body);
    let child = core.children(&s).join("agent-aX1.jsonl");
    let before = (
        fs::read(&child).unwrap(),
        fs::read(core.transcript_path(&s)).unwrap(),
        core.reads(&s.id).len(),
    );
    let reply = open(&core.home, &s.id, "t1");
    let got = rows(&reply);
    assert_eq!(reply["Ok"]["opened"]["truncated"], true);
    assert!(
        got.len() > 100 && got.len() < 400,
        "the 256 KiB tail holds about 250 of these"
    );
    assert!(
        got.last()
            .unwrap()
            .starts_with(&format!("assistant: line {:05} ", n - 1)),
        "the newest wins"
    );
    assert!(
        !got.iter().any(|r| r.starts_with("assistant: line 00000 ")),
        "the oldest is cut"
    );
    // Small records: the 256 KiB tail holds more than 400, and exactly the newest 400 come back.
    let small = |i: usize| {
        json!({"isSidechain":true,"agentId":"aX1","type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":format!("small {i:06}")}]}})
    };
    let many: String = (0..30_000).map(|i| format!("{}\n", small(i))).collect();
    assert!(many.len() > 1 << 20);
    fs::write(&child, &many).unwrap();
    let got = rows(&open(&core.home, &s.id, "t1"));
    assert_eq!(got.len(), 400);
    assert_eq!(got[0], "assistant: small 029600");
    assert_eq!(got[399], "assistant: small 029999");
    fs::write(&child, &body).unwrap();
    // A single record over RECORD_MAX is skipped, not parsed or returned (the tail only ever holds part of it).
    let huge = format!(
        "{}\n",
        line(0).to_string().replace("xxxx", &"x".repeat(1_500_000))
    );
    fs::write(&child, format!("{body}{huge}")).unwrap();
    let again = open(&core.home, &s.id, "t1");
    assert_eq!(again["Ok"]["opened"]["source"], "child");
    assert_eq!(
        rows(&again),
        Vec::<String>::new(),
        "{}",
        again.to_string().len()
    );
    assert_eq!(again["Ok"]["opened"]["truncated"], true);
    // Reading changes nothing and writes nothing to the agent.
    fs::write(&child, &before.0).unwrap();
    for _ in 0..3 {
        open(&core.home, &s.id, "t1");
    }
    assert_eq!(
        fs::read(&child).unwrap(),
        before.0,
        "the child file changed"
    );
    assert_eq!(
        fs::read(core.transcript_path(&s)).unwrap(),
        before.1,
        "the parent transcript changed"
    );
    assert_eq!(
        core.reads(&s.id).len(),
        before.2,
        "the open wrote to the PTY"
    );
    assert!(core.snapshot().pending_of(&s.id).is_empty());
}

fn session_token(core: &Core) -> (Session, String) {
    let agent = core.start(
        AgentKind::Shell,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat".into(),
        ],
    );
    let until = Instant::now() + Duration::from_secs(5);
    loop {
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
            return (agent, l.trim().to_string());
        }
        assert!(Instant::now() < until, "session printed no token");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn subagent_open_is_window_only() {
    let core = Core::new();
    let s = core.start(AgentKind::Claude, vec![]);
    core.transcript(&s, &format!("{}\n", launched("t1", "Explore: one")));
    core.child(&s, "aX1", "t1", &fixture("claude-child.jsonl"));
    let ask = || Request::Subagents {
        id: s.id.clone(),
        open: Some("t1".into()),
    };
    assert_eq!(
        call(&core.home, ask()).unwrap_err(),
        "subagents require unlocked transport dispatch"
    );
    let forwarded = call(
        &core.home,
        Request::Remote {
            machine: "nowhere".into(),
            request: Box::new(ask()),
        },
    );
    assert!(forwarded.unwrap_err().contains("local owner-only"));
    let (agent, token) = session_token(&core);
    let mut sock = std::os::unix::net::UnixStream::connect(core.home.join("core.sock")).unwrap();
    writeln!(
        sock,
        "{}",
        json!({"token":token,"request":{"op":"subagents","id":s.id,"open":"t1"}})
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

/// Codex: a stored session whose rollouts the test lays out under `CODEX_HOME/sessions/2026/10/27/`.
struct Rollouts {
    serve: home::ServeGuard,
    day: PathBuf,
    cwd: PathBuf,
}
const PARENT: &str = "01a17a48-3755-7943-8016-6371dcb1467d";
const CHILD: &str = "01a17a49-412c-7212-b5dd-f80e6f8b357a";
impl Rollouts {
    fn new() -> Self {
        let h = home::short("rollouts");
        let cwd = h.join("cwd");
        let agent = h.join("agent");
        let day = agent.join("sessions/2026/10/27");
        fs::create_dir_all(&day).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let row = json!({"id":"abcd1234","kind":"codex","project":cwd,"cwd":cwd,"label":"rollouts","state":"exited",
            "agent_session_id":PARENT,"agent_version":null,"untested":false,"pid":null,"machine":null});
        fs::write(
            h.join("sessions.json"),
            json!({"version":2,"sessions":[row]}).to_string(),
        )
        .unwrap();
        let serve = home::spawn_serve(&h, &[("CODEX_HOME", agent.to_str().unwrap())]);
        let this = Self { serve, day, cwd };
        this.parent(&fixture("codex-parent.jsonl"));
        this
    }
    fn at(&self, text: &str) -> String {
        text.replace("/project", self.cwd.to_str().unwrap())
    }
    fn parent(&self, body: &str) {
        fs::write(
            self.day
                .join(format!("rollout-2026-10-27T08-15-15-{PARENT}.jsonl")),
            self.at(body),
        )
        .unwrap();
    }
    fn child(&self, body: &str) -> PathBuf {
        let path = self
            .day
            .join(format!("rollout-2026-10-27T08-16-26-{CHILD}.jsonl"));
        fs::write(&path, self.at(body)).unwrap();
        path
    }
    fn open(&self, kid: &str) -> Value {
        open(&self.serve.home, "abcd1234", kid)
    }
}

#[test]
fn codex_child_rollout_found_by_task_name() {
    let r = Rollouts::new();
    r.child(&fixture("codex-child.jsonl"));
    let reply = r.open("c1");
    assert_eq!(reply["Ok"]["opened"]["source"], "child", "{reply}");
    // The replay of the parent's history comes first and is tolerated; the child's own rows follow, newest last.
    assert_eq!(
        rows(&reply),
        [
            "user: Parent history line.",
            "user: Write the spec.",
            "tool_use exec_command",
            "tool_result",
            "assistant: Spec written.",
        ]
    );
    // The label comes from the task name, not the encrypted launch message.
    assert_eq!(reply["Ok"]["kids"][0]["label"], "spec");
}

#[test]
fn codex_child_of_another_parent_not_read() {
    let r = Rollouts::new();
    let swap = |from: &str, to: &str| fixture("codex-child.jsonl").replace(from, to);
    for (what, body) in [
        (
            "another parent",
            swap(
                &format!(r#""parent_thread_id":"{PARENT}""#),
                r#""parent_thread_id":"01a17a48-0000-7000-8000-000000000000""#,
            ),
        ),
        ("another agent_path", swap("/root/spec", "/root/other")),
        (
            "no subagent source",
            swap(
                r#""source":{"subagent":{"thread_spawn":"#,
                r#""source":{"cli":{"thread_spawn":"#,
            ),
        ),
    ] {
        r.child(&body);
        let reply = r.open("c1");
        assert_eq!(reply["Ok"]["opened"]["source"], "parent", "{what}: {reply}");
        assert_eq!(rows(&reply), Vec::<String>::new(), "{what}");
    }
    // A launch the parent has no output for finds nothing either.
    r.child(&fixture("codex-child.jsonl"));
    assert_eq!(r.open("c2")["Ok"]["opened"]["source"], "parent");
}

#[test]
fn codex_rollout_scan_is_bounded() {
    let r = Rollouts::new();
    // 4000 later rollouts sort before the real child: the scan stops at its bound and falls back to the parent.
    for i in 0..4000 {
        fs::write(
            r.day
                .join(format!("rollout-2026-10-27T08-15-16-{i:05}.jsonl")),
            "{}\n",
        )
        .unwrap();
    }
    let child = r.child(&fixture("codex-child.jsonl"));
    assert_eq!(r.open("c1")["Ok"]["opened"]["source"], "parent");
    for i in 0..4000 {
        fs::remove_file(
            r.day
                .join(format!("rollout-2026-10-27T08-15-16-{i:05}.jsonl")),
        )
        .unwrap();
    }
    assert_eq!(
        r.open("c1")["Ok"]["opened"]["source"],
        "child",
        "found again once the files are gone"
    );
    // Only the first line is read, at most 64 KiB: a longer one is skipped.
    let mut long: Value =
        serde_json::from_str(fixture("codex-child.jsonl").lines().next().unwrap()).unwrap();
    long["payload"]["base_instructions"] = "x".repeat(70_000).into();
    let rest: Vec<_> = fixture("codex-child.jsonl")
        .lines()
        .skip(1)
        .map(str::to_string)
        .collect();
    fs::write(&child, r.at(&format!("{long}\n{}\n", rest.join("\n")))).unwrap();
    assert_eq!(r.open("c1")["Ok"]["opened"]["source"], "parent");
}

/// A reporting ACP agent's child has no file: the row opens the parent's chat, at the launch call when the chat holds it.
#[test]
fn acp_child_opens_parent_call() {
    let toml = "[[agent]]\nname = \"subs\"\n{fake}]\nenv = []\n";
    let core = Acp::new(toml);
    core.approve("subs");
    let id = core.start("subs");
    core.prompt(&id, "flood:3:10");
    core.wait_done(&id);
    let chat = core.window(json!({"op":"chat_page","id":id}))["Ok"]["page"]["events"].clone();
    let launch = chat
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["data"]["kind"] == "tool_use" && e["data"]["tool_id"] == "f-1")
        .unwrap_or_else(|| panic!("{chat}"));
    let reply = core.window(json!({"op":"subagents","id":id,"open":"f-1"}));
    assert_eq!(reply["Ok"]["opened"]["source"], "parent", "{reply}");
    assert_eq!(reply["Ok"]["opened"]["cursor"], launch["cursor"]);
    assert_eq!(reply["Ok"]["opened"]["events"], json!([]));
    // A child the chat does not hold has no cursor at all.
    let reply = core.window(json!({"op":"subagents","id":id,"open":"child-9"}));
    assert_eq!(reply["Ok"]["opened"]["source"], "parent");
    assert!(reply["Ok"]["opened"].get("cursor").is_none(), "{reply}");
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("subagents");
        fs::create_dir_all(home.join("bin")).unwrap();
        let fake = home.join("bin/claude");
        fs::write(&fake, claude()).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
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
            assert!(Instant::now() < until, "core did not become ready");
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
                    label: "subagents".into(),
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
            other => panic!("start failed: {other:?}"),
        }
    }
    fn transcript_path(&self, s: &Session) -> PathBuf {
        self.encoded(&s.cwd)
            .join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()))
    }
    fn encoded(&self, cwd: &std::path::Path) -> PathBuf {
        let encoded: String = cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        self.home.join("agent/projects").join(encoded)
    }
    fn transcript(&self, s: &Session, body: &str) {
        let path = self.transcript_path(s);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
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
    /// Every hex read the fake Claude saw on its stdin.
    fn reads(&self, id: &str) -> Vec<String> {
        fs::read_to_string(self.home.join(format!("stdin-{id}.log")))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.strip_prefix("READ ").map(str::to_string))
            .collect()
    }
    fn snapshot(&self) -> Snapshot {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => Snapshot { sessions },
            _ => panic!(),
        }
    }
    fn window(&self, request: Value) -> Value {
        window_at(&self.home, request)
    }
}
/// One window request over the core's websocket, as the app sends it.
fn window_at(home: &std::path::Path, request: Value) -> Value {
    {
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

struct Snapshot {
    sessions: Vec<Session>,
}
impl Snapshot {
    fn pending_of(&self, id: &str) -> Vec<nunchiro_core::queue::Decision> {
        self.sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.pending.clone())
            .unwrap_or_default()
    }
}

/// The ACP half: a real `serve` with the fake agent in `agents.toml`.
struct Acp {
    home: PathBuf,
    process: Child,
}
impl Acp {
    fn new(toml: &str) -> Self {
        let home = home::short("subsacp");
        let log = home.join("agent.log");
        let fake = format!(
            "command = \"/usr/bin/python3\"\nargs = [{:?}, {:?}",
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/acp/fake_agent.py")
                .display()
                .to_string(),
            log.display().to_string()
        );
        fs::write(home.join("agents.toml"), toml.replace("{fake}", &fake)).unwrap();
        fs::create_dir_all(home.join("project")).unwrap();
        let process = home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-home"))
            .env("PATH", "/usr/bin:/bin")
            .env("NUNCHIRO_SSH", "/usr/bin/false")
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_WINDOW_ORIGINS")
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
        while self.owner(json!({"op":"snapshot"}))["Ok"]["type"] != "snapshot" {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// Null while the core is not listening yet, so a wait can poll it and Drop never panics.
    fn owner(&self, request: Value) -> Value {
        let token = fs::read_to_string(self.home.join("core.token")).unwrap_or_default();
        let Ok(mut s) = std::os::unix::net::UnixStream::connect(self.home.join("core.sock")) else {
            return Value::Null;
        };
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut reply = String::new();
        BufReader::new(s).read_line(&mut reply).unwrap();
        serde_json::from_str(&reply).unwrap()
    }
    fn approve(&self, name: &str) {
        let view = self.owner(json!({"op":"acp_agent_status","name":name}))["Ok"]["view"].clone();
        let hash = view["hash"].as_str().unwrap().to_string();
        self.owner(json!({"op":"acp_agent_grant","name":name,"hash":hash}));
    }
    fn start(&self, name: &str) -> String {
        let project = self.home.join("project");
        fs::create_dir_all(&project).unwrap();
        self.owner(
            json!({"op":"start","session":{"kind":"acp","project":project,"label":"subs",
            "args":[name],"model":null,"effort":null,"resume":null}}),
        )["Ok"]["session"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
    fn prompt(&self, id: &str, text: &str) {
        self.owner(json!({"op":"agent_prompt","id":id,"text":text}));
    }
    fn wait_done(&self, id: &str) {
        let until = Instant::now() + Duration::from_secs(20);
        while self.owner(json!({"op":"snapshot"}))["Ok"]["sessions"]
            .as_array()
            .and_then(|s| s.iter().find(|s| s["id"] == id))
            .is_none_or(|s| s["attention"]["completion_seq"].as_u64().unwrap_or(0) < 1)
        {
            assert!(Instant::now() < until, "the turn did not end");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn window(&self, request: Value) -> Value {
        let info = self.owner(json!({"op":"window_auth"}))["Ok"].clone();
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
            json!({"id":9,"request":request}).to_string().into(),
        ))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < until);
            if let Message::Text(t) = ws.read().unwrap() {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["id"] == 9 {
                    return v["response"].clone();
                }
            }
        }
    }
}
impl Drop for Acp {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op":"stop"}));
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}
