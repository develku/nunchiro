//! V2-7: the Sessions scope of Search, a window-only scan of the chat events of sessions Nunchiro started.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

struct Core {
    home: PathBuf,
    agents: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let home = home::short("srch");
        Self::at(home.clone(), &home)
    }
    /// `agents` holds the agents' data roots (the 500 MB fixture lives under `.scratch/`, the socket home stays short).
    fn at(home: PathBuf, agents: &Path) -> Self {
        for (name, version) in [
            ("claude", "2.1.310 (Claude Code)"),
            ("codex", "codex-cli 0.161.0"),
        ] {
            let path = home.join("bin").join(name);
            fs::create_dir_all(home.join("bin")).unwrap();
            fs::write(
                &path,
                home::codex_fake(&format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version}'; exit; fi\nexec sleep 600\n")),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::create_dir_all(home.join("cwd")).unwrap();
        // The perf run may point at a release build.
        let bin = std::env::var_os("NUNCHIRO_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(cli::path);
        let process = home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", agents.join("claude-home"))
            .env("CODEX_HOME", agents.join("codex-home"))
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
        let core = Self {
            home,
            agents: agents.into(),
            process,
        };
        let until = Instant::now() + Duration::from_secs(30);
        while !core.home.join("window.json").exists() {
            assert!(Instant::now() < until, "core did not start");
            thread::sleep(Duration::from_millis(10));
        }
        core
    }
    fn start(&self, kind: AgentKind) -> Session {
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
                    label: "search".into(),
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
            r => panic!("{r:?}"),
        }
    }
    fn hook(&self, id: &str, event: &str, payload: Value) -> Response {
        call(
            &self.home,
            Request::Hook {
                id: id.into(),
                event: event.into(),
                payload,
            },
        )
    }
    /// A session with its transcript holding `lines`; the returned session carries its conversation id.
    fn session(&self, kind: AgentKind, lines: &[Value]) -> (Session, PathBuf) {
        let mut s = self.start(kind);
        let path = match kind {
            AgentKind::Claude => {
                let encoded = s
                    .cwd
                    .to_string_lossy()
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect::<String>();
                let dir = self.agents.join("claude-home/projects").join(encoded);
                fs::create_dir_all(&dir).unwrap();
                dir.join(format!("{}.jsonl", s.agent_session_id.as_ref().unwrap()))
            }
            _ => {
                let thread = new_uuid();
                let dir = self.agents.join("codex-home/sessions/2026/10/27");
                fs::create_dir_all(&dir).unwrap();
                s.agent_session_id = Some(thread.clone());
                dir.join(format!("rollout-2026-10-27T10-00-00-{thread}.jsonl"))
            }
        };
        // A real rollout starts with its session_meta, which `transcript::locate` checks.
        let mut lines = lines.to_vec();
        if kind == AgentKind::Codex {
            lines.insert(
                0,
                json!({"type":"session_meta","payload":{"id":s.agent_session_id,"cwd":s.cwd}}),
            );
        }
        write_lines(&path, &lines);
        self.hook(
            &s.id,
            "SessionStart",
            json!({"session_id":s.agent_session_id,"thread_id":s.agent_session_id,"transcript_path":path}),
        )
        .unwrap();
        (s, path)
    }
    fn close(&self, s: &Session) {
        call(&self.home, Request::Close { id: s.id.clone() }).unwrap();
    }
    fn dial(&self) -> tungstenite::WebSocket<TcpStream> {
        self.try_dial().expect("window refused")
    }
    /// A window, or `None` when the core refuses one (all its connection places are taken).
    fn try_dial(&self) -> Option<tungstenite::WebSocket<TcpStream>> {
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
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .unwrap();
        Some(tungstenite::client(req, stream).ok()?.0)
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
fn new_uuid() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "0000aaaa-0000-4000-8000-{:012x}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}
fn write_lines(path: &Path, lines: &[Value]) {
    fs::write(
        path,
        lines
            .iter()
            .map(|l| l.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
}
fn claude_text(role: &str, text: &str) -> Value {
    json!({"type":role,"message":{"content":[{"type":"text","text":text}]}})
}
fn codex_text(role: &str, text: &str) -> Value {
    let block = if role == "user" {
        "input_text"
    } else {
        "output_text"
    };
    json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":block,"text":text}]}})
}
fn recv(ws: &mut tungstenite::WebSocket<TcpStream>, id: u64) -> Value {
    let until = Instant::now() + Duration::from_secs(120);
    loop {
        assert!(Instant::now() < until, "no reply {id}");
        if let Message::Text(t) = ws.read().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["id"] == id {
                return v["response"].clone();
            }
        }
    }
}
fn ask(ws: &mut tungstenite::WebSocket<TcpStream>, id: u64, frame: Value) -> Value {
    let mut frame = frame;
    frame["id"] = json!(id);
    ws.send(Message::Text(frame.to_string().into())).unwrap();
    recv(ws, id)
}
/// Every page until the given sessions are all scanned, as the window pages through them.
fn search(ws: &mut tungstenite::WebSocket<TcpStream>, query: &str, ids: &[&str]) -> Vec<Value> {
    let mut rest: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
    let mut out = vec![];
    let mut n = 1000;
    while !rest.is_empty() {
        n += 1;
        let reply = ask(
            ws,
            n,
            json!({"request":{"op":"sessions_search","query":query,"sessions":rest}}),
        );
        let ok = &reply["Ok"];
        assert!(ok.is_object(), "search refused: {reply}");
        let scanned = ok["scanned"].as_u64().unwrap() as usize;
        assert!(scanned > 0 && scanned <= rest.len(), "{reply}");
        rest.drain(..scanned);
        out.extend(ok["results"].as_array().unwrap().iter().cloned());
    }
    out
}
fn result_for<'a>(results: &'a [Value], id: &str) -> &'a Value {
    results
        .iter()
        .find(|r| r["session"] == id)
        .unwrap_or_else(|| panic!("no result for {id}: {results:?}"))
}
/// The chat cursor of hit `n`, as the window asks for it when the hit is opened.
fn resolve(ws: &mut tungstenite::WebSocket<TcpStream>, id: &str, query: &str, n: u64) -> Value {
    ask(
        ws,
        8,
        json!({"request":{"op":"sessions_hit","session":id,"query":query,"n":n}}),
    )
}
fn cursor_of(ws: &mut tungstenite::WebSocket<TcpStream>, id: &str, query: &str, n: u64) -> u64 {
    let reply = resolve(ws, id, query, n);
    reply["Ok"]["cursor"]
        .as_u64()
        .unwrap_or_else(|| panic!("no cursor: {reply}"))
}
/// The chat event a hit names, read the way the window opens a chat at it.
fn event_at(ws: &mut tungstenite::WebSocket<TcpStream>, id: &str, cursor: u64) -> Value {
    let page = ask(ws, 7, json!({"chat":id,"before":cursor + 1}));
    let events = page["Ok"]["page"]["events"].as_array().unwrap().clone();
    let last = events.last().unwrap().clone();
    assert_eq!(last["cursor"], cursor);
    last
}

#[test]
fn search_sessions_finds_claude_and_codex_phrase() {
    let core = Core::new();
    let phrase = "retire the process group";
    let filler = |i: usize| claude_text("user", &format!("unrelated line {i}"));
    let mut claude_lines: Vec<Value> = (0..5).map(filler).collect();
    claude_lines.push(claude_text(
        "assistant",
        "We must Retire The Process Group before reap.",
    ));
    claude_lines.push(filler(9));
    let (claude_live, _) = core.session(AgentKind::Claude, &claude_lines);
    let (claude_closed, _) = core.session(
        AgentKind::Claude,
        &[claude_text("user", &format!("please {phrase} first"))],
    );
    let codex_lines = vec![
        codex_text("user", "hello"),
        codex_text("assistant", &format!("I will {phrase} now, 그룹 정리")),
    ];
    let (codex_live, _) = core.session(AgentKind::Codex, &codex_lines);
    let (codex_closed, _) = core.session(AgentKind::Codex, &codex_lines);
    let (other, _) = core.session(AgentKind::Claude, &[claude_text("user", "no match here")]);
    core.close(&claude_closed);
    core.close(&codex_closed);
    let mut ws = core.dial();
    let ids = [
        claude_live.id.as_str(),
        claude_closed.id.as_str(),
        codex_live.id.as_str(),
        codex_closed.id.as_str(),
        other.id.as_str(),
    ];
    let results = search(&mut ws, phrase, &ids);
    for s in [&claude_live, &claude_closed, &codex_live, &codex_closed] {
        let r = result_for(&results, &s.id);
        assert_eq!(r["status"], "ok", "{r}");
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1, "{r}");
        assert_eq!(hits[0]["n"], 0, "{r}");
        let cursor = cursor_of(&mut ws, &s.id, phrase, 0);
        // Case-insensitive: the snippet keeps the transcript's own case.
        let snippet = hits[0]["text"].as_str().unwrap().to_lowercase();
        assert!(snippet.contains(phrase), "{r}");
        let event = event_at(&mut ws, &s.id, cursor);
        assert!(
            event["data"]["text"]
                .as_str()
                .unwrap()
                .to_lowercase()
                .contains(phrase),
            "{event}"
        );
    }
    // The Claude hit is the sixth record: its event id resolves to that chat cursor.
    assert_eq!(cursor_of(&mut ws, &claude_live.id, phrase, 0), 6);
    assert!(results.iter().all(|r| r["session"] != other.id.as_str()));
    // Hangul matches too.
    let results = search(&mut ws, "그룹 정리", &[codex_live.id.as_str()]);
    assert_eq!(result_for(&results, &codex_live.id)["hits"][0]["n"], 0);
    assert_eq!(cursor_of(&mut ws, &codex_live.id, "그룹 정리", 0), 2);
}

#[test]
fn search_closed_session_opens_read_only_with_resume() {
    let core = Core::new();
    let (s, _) = core.session(
        AgentKind::Claude,
        &[
            claude_text("user", "first"),
            claude_text("assistant", "the scrollback ring retires the oldest chunk"),
        ],
    );
    core.close(&s);
    let mut ws = core.dial();
    let results = search(&mut ws, "oldest chunk", &[s.id.as_str()]);
    let hit = &result_for(&results, &s.id)["hits"][0];
    assert_eq!(hit["role"], "assistant");
    assert_eq!(cursor_of(&mut ws, &s.id, "oldest chunk", 0), 2);
    // The window opens it from its snapshot row: closed, with the conversation id Resume needs, and its chat reads.
    let Reply::Snapshot { sessions, .. } = call(&core.home, Request::Snapshot).unwrap() else {
        panic!()
    };
    let row = sessions.iter().find(|r| r.id == s.id).unwrap();
    assert_eq!(row.state, SessionState::Closed);
    assert_eq!(row.agent_session_id, s.agent_session_id);
    assert!(row.pid.is_none());
    let event = event_at(&mut ws, &s.id, 2);
    assert_eq!(
        event["data"]["text"],
        "the scrollback ring retires the oldest chunk"
    );
}

#[test]
fn search_sessions_confined_to_own_sessions() {
    let core = Core::new();
    let secret = "outside secret phrase";
    // A file outside every agent data root, and a transcript replaced by a symlink to it.
    let outside = core.home.join("outside.jsonl");
    write_lines(&outside, &[claude_text("user", secret)]);
    let (linked, path) = core.session(AgentKind::Claude, &[claude_text("user", "own text")]);
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    // The same through a link to an outside file without the phrase: refused before any byte is read, not skipped.
    let plain = core.home.join("plain.jsonl");
    write_lines(&plain, &[claude_text("user", "nothing")]);
    let (linked_plain, path) = core.session(AgentKind::Claude, &[claude_text("user", "own")]);
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&plain, &path).unwrap();
    // A Codex rollout aliased by symlink to another conversation's rollout that holds the phrase.
    let (codex, codex_path) = core.session(AgentKind::Codex, &[codex_text("user", "own")]);
    let other =
        codex_path.with_file_name(format!("rollout-2026-10-27T11-00-00-{}.jsonl", new_uuid()));
    write_lines(&other, &[codex_text("user", secret)]);
    fs::remove_file(&codex_path).unwrap();
    std::os::unix::fs::symlink(&other, &codex_path).unwrap();
    let mut ws = core.dial();
    let crafted = [
        "..",
        "../outside",
        "/etc/passwd",
        outside.to_str().unwrap(),
        "claude-../../outside",
        "0000aaaa-0000-4000-8000-ffffffffffff",
    ];
    let mut ids: Vec<&str> = crafted.to_vec();
    ids.push(&linked.id);
    ids.push(&linked_plain.id);
    ids.push(&codex.id);
    let results = search(&mut ws, secret, &ids);
    for r in &results {
        assert!(r["hits"].as_array().is_none_or(|h| h.is_empty()), "{r}");
        assert!(!r.to_string().contains(secret), "{r}");
    }
    // Crafted ids are not sessions: nothing comes back for them.
    for id in crafted {
        assert!(results.iter().all(|r| r["session"] != id), "{results:?}");
    }
    assert_eq!(result_for(&results, &linked.id)["status"], "error");
    assert_eq!(result_for(&results, &linked_plain.id)["status"], "error");
    // Its rollout resolves to another conversation's file: refused by the path check or not found by locate.
    assert_ne!(result_for(&results, &codex.id)["status"], "ok");
    // Opening a hit is confined the same way: a crafted or linked session resolves to nothing.
    for id in crafted
        .iter()
        .copied()
        .chain([linked.id.as_str(), codex.id.as_str()])
    {
        let reply = resolve(&mut ws, id, secret, 0);
        assert!(reply["Err"].is_string(), "{id}: {reply}");
    }
    // Neither outside file became chat events.
    for s in [&linked, &codex] {
        let page = ask(&mut ws, 9, json!({"chat":s.id}));
        assert!(!page.to_string().contains(secret), "{page}");
    }
    // A query or session list over the limits is refused before anything is read.
    let long = "x".repeat(257);
    let reply = ask(
        &mut ws,
        10,
        json!({"request":{"op":"sessions_search","query":long,"sessions":[linked.id]}}),
    );
    assert!(reply["Err"].is_string(), "{reply}");
    let reply = ask(
        &mut ws,
        11,
        json!({"request":{"op":"sessions_search","query":"x","sessions":[]}}),
    );
    assert!(reply["Err"].is_string(), "{reply}");
}

#[test]
fn search_sessions_tolerates_partial_and_missing() {
    let core = Core::new();
    let (partial, path) = core.session(
        AgentKind::Claude,
        &[
            claude_text("user", "alpha marker one"),
            claude_text("assistant", "beta"),
            claude_text("assistant", "alpha marker two"),
        ],
    );
    // The agent is mid-write: the last line has no end yet.
    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    f.write_all(br#"{"type":"user","message":{"content":"alpha marker thr"#)
        .unwrap();
    drop(f);
    let (gone, gone_path) = core.session(AgentKind::Codex, &[codex_text("user", "alpha marker")]);
    fs::remove_file(&gone_path).unwrap();
    let (gone_claude, gone_path) =
        core.session(AgentKind::Claude, &[claude_text("user", "alpha marker")]);
    fs::remove_file(&gone_path).unwrap();
    let mut ws = core.dial();
    let results = search(
        &mut ws,
        "alpha marker",
        &[
            partial.id.as_str(),
            gone.id.as_str(),
            gone_claude.id.as_str(),
        ],
    );
    let r = result_for(&results, &partial.id);
    assert_eq!(r["status"], "ok", "{r}");
    let ns: Vec<u64> = r["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["n"].as_u64().unwrap())
        .collect();
    assert_eq!(ns, [0, 1]);
    assert_eq!(cursor_of(&mut ws, &partial.id, "alpha marker", 0), 1);
    assert_eq!(cursor_of(&mut ws, &partial.id, "alpha marker", 1), 3);
    // The half-written line is not an event yet, in the scan or the chat.
    assert!(resolve(&mut ws, &partial.id, "alpha marker", 2)["Ok"]["cursor"].is_null());
    for s in [&gone, &gone_claude] {
        let r = result_for(&results, &s.id);
        assert_eq!(r["status"], "missing", "{r}");
        assert!(r["hits"].as_array().unwrap().is_empty());
    }
}

/// A query of only quotes, backslashes and control characters has no raw prefilter, so every line would be parsed:
/// it is refused before any transcript is read.
#[test]
fn query_without_plain_character_is_refused() {
    let core = Core::new();
    let (s, _) = core.session(AgentKind::Claude, &[claude_text("user", "say a\"b here")]);
    let mut ws = core.dial();
    for (n, q) in ["\"", "\\", "\"\\\"", "\u{1}"].into_iter().enumerate() {
        let reply = ask(
            &mut ws,
            50 + n as u64,
            json!({"request":{"op":"sessions_search","query":q,"sessions":[s.id]}}),
        );
        assert_eq!(
            reply["Err"], "search text needs at least one plain character",
            "{q:?}: {reply}"
        );
        assert!(reply["Ok"]["scanned"].is_null(), "{q:?}: {reply}");
    }
    // Its longest plain run is `a`, so it still searches.
    let found = search(&mut ws, "a\"b", &[&s.id]);
    assert_eq!(
        result_for(&found, &s.id)["hits"].as_array().unwrap().len(),
        1
    );
}

/// Writes `lines` assistant lines holding `needle` into each transcript.
fn fill(paths: &[PathBuf], lines: usize) {
    use std::io::Write;
    for path in paths {
        let mut out = std::io::BufWriter::new(fs::File::create(path).unwrap());
        for i in 0..lines {
            let text = format!("{i} {} needle", "filler text ".repeat(80));
            writeln!(out, "{}", claude_text("assistant", &text)).unwrap();
        }
        out.flush().unwrap();
    }
}

/// Waiting detection is never starved: a permission raised while sessions are being scanned and projected reaches
/// the queue while that scan is still running. The corpus grows until one scan on this core takes 3 s, so the
/// permissions land mid-scan on any host. Ticket 129: the wait for the queue is a bounded poll of the queue state
/// (20 ms up to 30 s), not a wall-clock deadline, so a starved hook thread at load fails only past 30 s and reports
/// the queue it saw. The 500 MB run is `search_sessions_perf_500mb`.
#[test]
fn search_sessions_waiting_unaffected() {
    const MIN_SCAN: Duration = Duration::from_secs(3);
    const MAX_BYTES: u64 = 400_000_000;
    // Ticket 129: load starves the hook thread, so the wait on the queue state is generous and its failure prints it.
    const QUEUE_WAIT: Duration = Duration::from_secs(30);
    let core = Core::new();
    let (mut ids, mut paths) = (vec![], vec![]);
    for _ in 0..2 {
        let (s, path) = core.session(AgentKind::Claude, &[]);
        ids.push(s.id);
        paths.push(path);
    }
    let waiting: Vec<Session> = (0..4).map(|_| core.start(AgentKind::Claude)).collect();
    call(&core.home, Request::QueueConnect).unwrap();
    let mut ws = core.dial();
    let refs = |ids: &[String]| {
        ids.iter()
            .map(|s| s.as_str().to_owned())
            .collect::<Vec<_>>()
    };
    // Calibration: scan the same core until a scan is long enough, or fail with what was measured.
    let (built, mut lines) = (Instant::now(), 15_000usize);
    loop {
        fill(&paths, lines);
        let size: u64 = paths.iter().map(|p| fs::metadata(p).unwrap().len()).sum();
        let started = Instant::now();
        let refs = refs(&ids);
        let found = search(
            &mut ws,
            "needle",
            &refs.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        let took = started.elapsed();
        assert_eq!(found.len(), 2);
        eprintln!("calibration: {lines} lines x 2 ({size} bytes) scanned in {took:?}");
        if took >= MIN_SCAN {
            break;
        }
        let grown = (lines as f64
            * (MIN_SCAN.as_secs_f64() * 1.3 / took.as_secs_f64()).clamp(1.5, 8.0))
            as usize;
        assert!(
            size / lines as u64 * grown as u64 <= MAX_BYTES
                // 90 s, was 30: on a loaded machine (a pre-gate beside real-app looks, 2026-11-18) two scans near the
                // limit took 2.9 s and 2.7 s and the files' writing alone took 32 s.
                && built.elapsed() < Duration::from_secs(90),
            "scan stayed under {MIN_SCAN:?}: {took:?} for {size} bytes after {:?} of building",
            built.elapsed()
        );
        lines = grown;
    }
    let scan = thread::spawn(move || {
        let started = Instant::now();
        let refs = refs(&ids);
        let results = search(
            &mut ws,
            "needle",
            &refs.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        (started.elapsed(), results.len())
    });
    // One permission every 300 ms from 200 ms on, each on its own session; every one must queue within 1 s,
    // and the scan must still have been running when it did.
    let began = Instant::now();
    let mut landed = vec![];
    for (n, w) in waiting.iter().enumerate() {
        thread::sleep(
            (began + Duration::from_millis(200 + 300 * n as u64))
                .saturating_duration_since(Instant::now()),
        );
        let raised = Instant::now();
        let (home, id, event) = (core.home.clone(), w.id.clone(), format!("mid-scan-{n}"));
        thread::spawn(move || {
            let _ = call(
                &home,
                Request::Hook {
                    id,
                    event: "PermissionRequest".into(),
                    payload: json!({"tool_name":"Bash","tool_input":{"command":"touch x"},"nunchiro_event_id":event}),
                },
            );
        });
        let event = format!("mid-scan-{n}");
        landed.push(loop {
            let Reply::Snapshot { sessions, .. } = call(&core.home, Request::Snapshot).unwrap()
            else {
                panic!()
            };
            let row = sessions.iter().find(|s| s.id == w.id).unwrap();
            if row
                .pending
                .iter()
                .any(|p| p.hook_event_id.as_deref() == Some(&event))
            {
                break (raised.elapsed(), !scan.is_finished());
            }
            assert!(
                raised.elapsed() < QUEUE_WAIT,
                "permission never queued within {QUEUE_WAIT:?}: {event} raised {:?} ago; session has pending {pending:?}",
                raised.elapsed(),
                pending = row.pending,
            );
            thread::sleep(Duration::from_millis(20));
        });
    }
    let (scan_time, found) = scan.join().unwrap();
    eprintln!("permissions queued in {landed:?}; scan took {scan_time:?} for {found} sessions");
    assert_eq!(found, 2);
    assert!(
        landed.iter().all(|(_, scanning)| *scanning),
        "a permission landed after the scan ended: {landed:?}, scan {scan_time:?}"
    );
    assert!(
        landed.iter().all(|(t, _)| *t < Duration::from_secs(1)),
        "{landed:?}"
    );
}

#[cfg(feature = "measure")]
fn rss_kib(pid: u32) -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

/// Spec V2-7 acceptance 1 and 3 over a generated 500 MB fixture of 100 transcripts (Claude and Codex, 80 closed):
/// time to the first hit for 20 phrases (each in 3 sessions spread over the list), p95 under 1 s; core memory growth
/// during the scans under 50 MB; a permission raised mid-scan queued within 1 s. Also reported, with no bar: opening
/// the first hit of each phrase (`sessions_hit` on a never-opened session builds its chat cache). Opt in: `cargo test -p nunchiro-core --features measure --test search_sessions search_sessions_perf_500mb -- --nocapture`, with
/// NUNCHIRO_BIN pointing at a release build for the shipped figure. The fixture goes under `.scratch/` and is removed.
#[cfg(feature = "measure")]
#[test]
fn search_sessions_perf_500mb() {
    let agents = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("search-perf-{}", std::process::id()));
    fs::create_dir_all(&agents).unwrap();
    let agents = agents.canonicalize().unwrap();
    let core = Core::at(home::short("srchp"), &agents);
    const SESSIONS: usize = 100;
    const LINES: usize = 5_000; // about 1 KB each: 5 MB per transcript
    let filler = "the agent read the file, ran the tests and explained what changed in the module "
        .repeat(12);
    let mut ids = vec![];
    let mut total = 0u64;
    for n in 0..SESSIONS {
        let kind = if n % 4 == 3 {
            AgentKind::Codex
        } else {
            AgentKind::Claude
        };
        let (s, path) = core.session(kind, &[]);
        let mut body = String::with_capacity(LINES * 1100);
        if kind == AgentKind::Codex {
            body += &json!({"type":"session_meta","payload":{"id":s.agent_session_id,"cwd":s.cwd}})
                .to_string();
            body.push('\n');
        }
        for i in 0..LINES {
            // Phrase p lives in sessions p*5 % 100, (p*5+33) % 100 and (p*5+66) % 100, at a line deep in the file.
            let phrase = (0..20)
                .find(|p| {
                    [p * 5, (p * 5 + 33) % 100, (p * 5 + 66) % 100].contains(&n)
                        && i == LINES - 10 - p
                })
                .map(|p| format!(" quokka{p:02}zebra"))
                .unwrap_or_default();
            let text = format!("{i} {filler}{phrase}");
            let line = match kind {
                AgentKind::Codex => codex_text("assistant", &text),
                _ => claude_text("assistant", &text),
            };
            body += &line.to_string();
            body.push('\n');
        }
        total += body.len() as u64;
        fs::write(&path, body).unwrap();
        if n >= 20 {
            core.close(&s);
        }
        ids.push(s.id);
    }
    eprintln!("fixture: {SESSIONS} transcripts, {} MB", total / 1_000_000);
    assert!(total >= 500_000_000, "fixture is {total} bytes");
    let pid = core.process.id();
    let base = rss_kib(pid);
    let peak = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(base));
    let sampling = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let sampler = {
        let (peak, sampling) = (peak.clone(), sampling.clone());
        thread::spawn(move || {
            while sampling.load(std::sync::atomic::Ordering::Relaxed) {
                peak.fetch_max(rss_kib(pid), std::sync::atomic::Ordering::Relaxed);
                thread::sleep(Duration::from_millis(20));
            }
        })
    };
    let waiting = core.start(AgentKind::Claude);
    call(&core.home, Request::QueueConnect).unwrap();
    let mut ws = core.dial();
    let mut firsts = vec![];
    let mut opens = vec![];
    let mut n = 0;
    let mut permission = None;
    for p in 0..20 {
        let query = format!("quokka{p:02}zebra");
        let started = Instant::now();
        let mut rest: Vec<String> = ids.clone();
        let mut first = None;
        let mut hits = 0;
        while !rest.is_empty() {
            n += 1;
            let reply = ask(
                &mut ws,
                n,
                json!({"request":{"op":"sessions_search","query":query,"sessions":rest}}),
            );
            let ok = &reply["Ok"];
            let scanned = ok["scanned"].as_u64().unwrap() as usize;
            rest.drain(..scanned);
            let found = ok["results"].as_array().unwrap();
            hits += found.iter().filter(|r| r["status"] == "ok").count();
            if first.is_none()
                && let Some(r) = found.iter().find(|r| r["status"] == "ok")
            {
                first = Some(started.elapsed());
                let opened = Instant::now();
                let id = r["session"].as_str().unwrap().to_string();
                n += 1;
                let reply = ask(
                    &mut ws,
                    n,
                    json!({"request":{"op":"sessions_hit","session":id,"query":query,"n":0}}),
                );
                assert!(reply["Ok"]["cursor"].is_u64(), "{reply}");
                opens.push(opened.elapsed());
            }
            // Mid-scan of the first query: a permission must still reach the queue within 1 s.
            if p == 0 && permission.is_none() && rest.len() < SESSIONS / 2 {
                let raised = Instant::now();
                let (home, id) = (core.home.clone(), waiting.id.clone());
                thread::spawn(move || {
                    let _ = call(
                        &home,
                        Request::Hook {
                            id,
                            event: "PermissionRequest".into(),
                            payload: json!({"tool_name":"Bash","tool_input":{"command":"touch x"},"nunchiro_event_id":"perf"}),
                        },
                    );
                });
                permission = Some(loop {
                    let Reply::Snapshot { sessions, .. } =
                        call(&core.home, Request::Snapshot).unwrap()
                    else {
                        panic!()
                    };
                    if sessions
                        .iter()
                        .any(|s| s.id == waiting.id && !s.pending.is_empty())
                    {
                        break raised.elapsed();
                    }
                    assert!(raised.elapsed() < Duration::from_secs(10));
                    thread::sleep(Duration::from_millis(5));
                });
            }
        }
        let all = started.elapsed();
        assert_eq!(hits, 3, "{query}");
        eprintln!(
            "{query}: first hit {:?}, all {SESSIONS} sessions {all:?}",
            first.unwrap()
        );
        firsts.push(first.unwrap());
    }
    // A query that matches nothing: the raw prefilter alone, over every byte.
    let started = Instant::now();
    let mut rest = ids.clone();
    while !rest.is_empty() {
        n += 1;
        let reply = ask(
            &mut ws,
            n,
            json!({"request":{"op":"sessions_search","query":"no such phrase anywhere","sessions":rest}}),
        );
        rest.drain(..reply["Ok"]["scanned"].as_u64().unwrap() as usize);
    }
    let miss = started.elapsed();
    sampling.store(false, std::sync::atomic::Ordering::Relaxed);
    sampler.join().unwrap();
    firsts.sort();
    opens.sort();
    let p95 = firsts[(firsts.len() * 95).div_ceil(100) - 1];
    eprintln!(
        "opening a first hit (cold chat cache): p50 {:?} p95 {:?}",
        opens[opens.len() / 2],
        opens[(opens.len() * 95).div_ceil(100) - 1]
    );
    let growth = (peak.load(std::sync::atomic::Ordering::Relaxed) - base) / 1024;
    eprintln!(
        "first hit p50 {:?} p95 {p95:?} max {:?}; no-match full scan {miss:?}; core RSS {} MiB -> peak +{growth} MiB; permission mid-scan {:?}",
        firsts[firsts.len() / 2],
        firsts.last().unwrap(),
        base / 1024,
        permission.unwrap()
    );
    assert!(permission.unwrap() < Duration::from_secs(1));
    assert!(p95 < Duration::from_secs(1), "first results p95 {p95:?}");
    assert!(growth < 50, "core memory grew {growth} MiB");
    drop(core);
    fs::remove_dir_all(&agents).unwrap();
}

/// Review MUST-1: the scan's count of matching events can differ from the chat cache's (a Codex tool argument stored
/// as `\uXXXX` escapes is projected into the cache but missed by the raw prefilter). The hit's text still opens it.
#[test]
fn search_sessions_hit_opens_its_event_when_counts_differ() {
    let core = Core::new();
    let call = json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c1",
        "arguments":"{\"cmd\":\"echo \\uadf8\\ub8f9 \\uc815\\ub9ac\"}"}});
    let (s, _) = core.session(
        AgentKind::Codex,
        &[call, codex_text("assistant", "그룹 정리 끝났어요")],
    );
    let mut ws = core.dial();
    let results = search(&mut ws, "그룹 정리", &[s.id.as_str()]);
    let hit = &result_for(&results, &s.id)["hits"][0];
    assert_eq!(hit["n"], 0, "{results:?}");
    let reply = ask(
        &mut ws,
        12,
        json!({"request":{"op":"sessions_hit","session":s.id,"query":"그룹 정리","n":0,"text":hit["text"]}}),
    );
    let cursor = reply["Ok"]["cursor"].as_u64().unwrap();
    assert_eq!(
        event_at(&mut ws, &s.id, cursor)["data"]["text"],
        "그룹 정리 끝났어요"
    );
}

/// v37-store-nofollow: a closed window cancels its running scan even after eight later pages on other panels, so the
/// scan's job ends and frees the connection's place long before its 5 s bound. Before, the ninth panel pushed the
/// first flag out of the list unset and the scan read on to its bound, holding the place.
#[test]
fn closed_window_cancels_its_scan_after_many_panels() {
    const MAX_CONNECTIONS: usize = 8; // `http::MAX_CONNECTIONS`
    let core = Core::new();
    let (s, path) = core.session(AgentKind::Claude, &[claude_text("user", "hello")]);
    // Sparse: the scan reads zeros for its whole 5 s bound unless canceled.
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(64 << 30)
        .unwrap();
    let mut ws = core.dial();
    let scan = json!({"id":1,"request":{"op":"sessions_search","query":"needle","sessions":[s.id],"channel":"a"}});
    ws.send(Message::Text(scan.to_string().into())).unwrap();
    let started = Instant::now();
    for (n, channel) in ["b", "c", "d", "e", "f", "g", "h", "i"]
        .into_iter()
        .enumerate()
    {
        let id = 10 + n as u64;
        let frame = json!({"id":id,"request":{"op":"sessions_search","query":"needle","sessions":["nope"],"channel":channel}});
        ws.send(Message::Text(frame.to_string().into())).unwrap();
        loop {
            let Message::Text(t) = ws.read().unwrap() else {
                continue;
            };
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_ne!(v["id"], 1, "the scan ended before the window closed: {v}");
            if v["id"] == id {
                break;
            }
        }
    }
    drop(ws);
    let closed = started.elapsed();
    let until = started + Duration::from_secs(4);
    loop {
        let open: Vec<_> = (0..MAX_CONNECTIONS)
            .filter_map(|_| core.try_dial())
            .collect();
        if open.len() == MAX_CONNECTIONS {
            break;
        }
        assert!(
            Instant::now() < until,
            "only {} windows got in; closed at {closed:?}, the scan still holds its place",
            open.len()
        );
        drop(open);
        thread::sleep(Duration::from_millis(50));
    }
}
