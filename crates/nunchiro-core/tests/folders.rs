//! The Assistant's folders (owner decision): a folder the owner names in a message typed in the window is the
//! Assistant's to read and write for that conversation. Through a real `serve`, a fake `claude` that draws Claude Code
//! 2.1.332's two `/add-dir` questions, and the seat's real lock hook.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
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

/// A fake Claude in raw mode: its input box, `/add-dir <folder>` with both questions (the cursor on "No, leave it out",
/// then on "1. Yes, for this session"), the "Added" line; any other line is echoed as "got: <line>".
const FAKE: &str = r#"#!/usr/bin/python3
import os, sys, tty
if sys.argv[1:2] == ["--version"]:
    print("2.1.332 (Claude Code)"); sys.exit(0)
tty.setraw(0)
out = lambda s: (os.write(1, s.encode()))
box = lambda: out("\r\n❯ \r\n")
out("\x1b[2J\x1b[H"); box()
line, state, folder, yes = "", None, "", False
def first():
    out("\x1b[2J\x1b[HAdding a new directory:\r\n " + folder + "\r\nThis session hasn't worked here before.\r\n\r\n"
        + ("  " if yes else "❯ ") + "No, leave it out\r\n" + ("❯ " if yes else "  ") + "Yes, add it\r\nEnter to confirm\r\n")
while True:
    data = os.read(0, 4096).decode(errors="replace")
    if not data: break
    if state == "first":
        if "\x1b[B" in data: yes = True; first()
        if "\r" in data and yes:
            state = "second"
            out("\x1b[2J\x1b[HAdd directory to workspace\r\n " + folder + "\r\n ❯ 1. Yes, for this session\r\n   2. Yes, and remember this directory\r\n   3. No\r\n")
        continue
    if state == "second":
        if "\r" in data:
            state = None
            out("\x1b[2J\x1b[H⎿ Added " + folder + " as a working directory for this session\r\n"); box()
        continue
    for c in data:
        if c == "\r":
            if line.startswith("/add-dir "):
                folder, state, yes = line[9:], "first", False; first()
            else:
                out("\x1b[2J\x1b[Hgot: " + line[:60] + "\r\n"); box()
            line = ""
            break
        line += c
"#;

#[test]
fn a_folder_named_in_the_owners_window_message_is_the_assistants_for_the_conversation() {
    let home = home::short("folders");
    fs::create_dir_all(home.join("bin")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(&claude, FAKE).unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    // The task folders live outside the core's home, as an owner's would.
    let work = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("nunchiro-folders-run-{}", std::process::id()));
    let _ = fs::remove_dir_all(&work);
    let (run, other, quoted) = (work.join("run"), work.join("other"), work.join("quoted"));
    for d in [run.join("inbox"), other.clone(), quoted.clone()] {
        fs::create_dir_all(d).unwrap();
    }
    fs::write(run.join("inbox/a.eml"), "Subject: x\n").unwrap();
    fs::write(run.join("notes.txt"), "n\n").unwrap();
    let chief = mate(&home, "Chief", None);
    let alpha = fs::canonicalize(&home).unwrap();
    let mut s = Schedules::load(&home);
    s.add(
        Run {
            kind: AgentKind::Claude,
            project: alpha.clone(),
            label: "x".into(),
            model: None,
            effort: None,
            // A schedule's task names a folder: no grant from it.
            task: Some(format!("start in {}", other.display())),
            teammate: Some(chief.id.clone()),
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
    drop(s);
    let mut core = home::spawn_serve(
        &home,
        &[
            ("PATH", path.as_str()),
            ("CLAUDE_CONFIG_DIR", &home.join("claude-home").to_string_lossy()),
        ],
    );
    wait("the seat did not open", || rows(&home).iter().any(|s| s.label == "Chief"));
    let seat = rows(&home).into_iter().find(|r| r.label == "Chief").unwrap();
    let row = || rows(&home).into_iter().find(|r| r.id == seat.id).unwrap();
    let screen = || match call(&home, Request::Read { id: seat.id.clone(), after: 0 }) {
        Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
        _ => String::new(),
    };
    let owner = fs::read_to_string(home.join("core.token")).unwrap().trim().to_string();
    // Its turn ends (the fake sends no hook of its own).
    let stop = || {
        let r = raw(&home, &owner, json!({"op":"hook","id":seat.id,"event":"Stop","payload":{}}));
        eprintln!("stop: {r}");
    };
    wait("the brief with the schedule's task was typed", || screen().contains("got: "));
    stop();
    // The owner's own socket and a quoted line give none either; the window's message does.
    let said = raw(&home, &owner, json!({"op":"agent_prompt","id":seat.id,"text":format!("look at {}", other.display())}));
    assert!(said["Err"].is_null(), "{said}");
    wait_for("the socket's message was typed", 20, || screen().contains("look at") || {
        eprintln!("queue: {:?}\nscreen: {:?}", row().send_queue.iter().map(|q| q.status.clone()).collect::<Vec<_>>(), screen().chars().rev().take(300).collect::<String>().chars().rev().collect::<String>());
        thread::sleep(Duration::from_secs(2));
        false
    });
    stop();
    let text = format!(
        "Sort the mails in {}/inbox into {}/labels/Billing/, one label per mail.\n> forwarded from Jordan: see {}",
        run.display(),
        run.display(),
        quoted.display()
    );
    let sent = window(&home, json!({"op":"agent_prompt","id":seat.id,"text":text}));
    assert!(sent["Err"].is_null(), "{sent}");
    wait_for("both folders were added", 30, || row().folders == vec![run.join("inbox"), run.clone()]);
    wait("the owner's message went in after the folders", || screen().contains("Sort the mails"));
    // Exactly those two: nothing from the schedule's task, the owner socket's message or the quoted line.
    assert_eq!(row().folders, vec![run.join("inbox"), run.clone()]);
    // The seat's real lock hook: writes inside run unasked; outside, Claude's own mode decides; rm still asks.
    let hook = |tool: &str, input: Value| {
        let mut cmd = std::process::Command::new(home::cli::path());
        cmd.args(["hook", "home-lock", "--mode", "ask"])
            .env("NUNCHIRO_HOME", &home)
            .env("NUNCHIRO_SESSION", &seat.id)
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().unwrap();
        child.stdin.take().unwrap().write_all(json!({"tool_name": tool, "tool_input": input}).to_string().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{out:?}");
        serde_json::from_slice::<Value>(&out.stdout)
            .ok()
            .and_then(|v| v["hookSpecificOutput"]["permissionDecision"].as_str().map(String::from))
            .unwrap_or_else(|| "mode".into())
    };
    let r = run.display();
    assert_eq!(hook("Write", json!({"file_path": run.join("drafts/reply.eml")})), "allow");
    assert_eq!(hook("Edit", json!({"file_path": run.join("notes.txt")})), "allow");
    assert_eq!(hook("Write", json!({"file_path": other.join("x.txt")})), "mode", "outside: the mode asks");
    assert_eq!(
        hook("Bash", json!({"command": format!("mkdir -p {r}/labels/Billing && mv -n {r}/inbox/a.eml {r}/labels/Billing/")})),
        "allow"
    );
    assert_eq!(hook("Bash", json!({"command": format!("rm {r}/inbox/a.eml")})), "ask");
    assert_eq!(hook("Bash", json!({"command": format!("mv {r}/inbox/a.eml {r}/x")})), "ask");
    // Remove ends the grant: the hook refuses the file tools there; the socket cannot remove one.
    let refused = raw(&home, &owner, json!({"op":"folder_remove","id":seat.id,"folder":run}));
    assert!(refused["Err"].is_string(), "{refused}");
    let removed = window(&home, json!({"op":"folder_remove","id":seat.id,"folder":run}));
    assert!(removed["Err"].is_null(), "{removed}");
    assert_eq!(row().folders, vec![run.join("inbox")]);
    assert_eq!(hook("Write", json!({"file_path": run.join("drafts/reply.eml")})), "deny");
    assert_eq!(hook("Read", json!({"file_path": run.join("notes.txt")})), "deny");
    assert_eq!(hook("Edit", json!({"file_path": run.join("inbox/a.eml")})), "allow", "inbox is still given");
    core.stop();
    let _ = fs::remove_dir_all(&home);
    let _ = fs::remove_dir_all(&work);
}
