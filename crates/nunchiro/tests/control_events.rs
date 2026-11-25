// Ticket 573 slice 2: `nunchiro events`, the agent verbs' exit codes and `agent start --receipt`.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        let home = home::short("cevents");
        let core = Self::serve(&home);
        Self { home, core }
    }
    fn serve(home: &Path) -> Child {
        let core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("serve")
            .env("NUNCHIRO_HOME", home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", home)
            .env_remove("NUNCHIRO_TOKEN")
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(30);
        while !home.join("core.token").exists()
            || UnixStream::connect(home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core never came up");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    /// As `serve restart`: this core exits (the agents stay) and a new one starts on the same home.
    fn restart(&mut self) {
        self.owner(json!({"op":"exit"})).unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        while self.core.try_wait().unwrap().is_none() {
            assert!(Instant::now() < until, "core never exited");
            thread::sleep(Duration::from_millis(20));
        }
        let _ = fs::remove_file(self.home.join("core.token"));
        self.core = Self::serve(&self.home);
    }
    fn call(&self, token: &str, request: Value) -> Result<Value, String> {
        let mut s = UnixStream::connect(self.home.join("core.sock")).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    fn owner(&self, request: Value) -> Result<Value, String> {
        self.call(
            &fs::read_to_string(self.home.join("core.token")).unwrap(),
            request,
        )
    }
    /// A shell session in `project` that prints its token.
    fn start(&self, project: &Path) -> (String, String) {
        let request = json!({"op":"start","session":{"kind":"shell","project":project,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}});
        let id = self.owner(request).unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let r = self.owner(json!({"op":"read","id":id})).unwrap();
            let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
            if let Some(line) = String::from_utf8_lossy(&data)
                .lines()
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return (id, line.trim().into());
            }
            assert!(Instant::now() < until, "no token from {id}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    /// The agent asks a question, as Claude's AskUserQuestion hook does.
    fn ask(&self, id: &str) {
        self.owner(json!({"op":"hook","id":id,"event":"PreToolUse",
            "payload":{"tool_name":"AskUserQuestion","tool_input":{"questions":[]}}}))
            .unwrap();
    }
    fn cursor(&self) -> u64 {
        self.owner(json!({"op":"events"})).unwrap()["latest"]
            .as_u64()
            .unwrap()
    }
    fn cli(&self, args: &[&str]) -> std::process::Command {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN");
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cli(args).output().unwrap()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.owner(json!({"op":"stop"}));
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

/// `nunchiro events` as a child; its lines arrive on the channel. Dropped, it stops the child by its own handle.
struct Stream {
    child: Child,
    lines: mpsc::Receiver<Value>,
}
impl Stream {
    fn open(h: &Harness, args: &[&str]) -> Self {
        let mut child = h.cli(args).stdout(Stdio::piped()).spawn().unwrap();
        let out = child.stdout.take().unwrap();
        let (send, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { return };
                if send.send(serde_json::from_str(&line).unwrap()).is_err() {
                    return;
                }
            }
        });
        Self { child, lines }
    }
    /// Lines until one matches `done`.
    fn until(&self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = vec![];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no matching event; saw {seen:?}"));
            let stop = done(&line);
            seen.push(line);
            if stop {
                return seen;
            }
        }
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn of<'a>(events: &'a [Value], id: &str) -> Vec<(&'a str, &'a str)> {
    events
        .iter()
        .filter(|e| e["session"] == id)
        .map(|e| {
            (
                e["type"].as_str().unwrap(),
                e["state"].as_str().unwrap_or(""),
            )
        })
        .collect()
}

/// Ticket 1130 C-C3: the journal keeps the events across a core restart and `--history` prints them, oldest first.
#[test]
fn events_history_keeps_events_across_a_core_restart() {
    let mut h = Harness::new();
    let (id, token) = h.start(&h.home);
    let until = Instant::now() + Duration::from_secs(10);
    while !of(
        &h.owner(json!({"op":"events","since":0})).unwrap()["events"]
            .as_array()
            .unwrap()
            .clone(),
        &id,
    )
    .contains(&("session_started", "waiting"))
    {
        assert!(Instant::now() < until, "no session_started");
        thread::sleep(Duration::from_millis(50));
    }
    h.restart();
    let out = h.run(&["events", "--history", "1"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let events: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let starts: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "core_started")
        .collect();
    assert_eq!(starts.len(), 2, "{events:?}");
    assert_eq!(
        starts[1]["data"],
        json!({"kept": 1, "lost": 0, "exited": 0})
    );
    let started = events
        .iter()
        .position(|e| e["type"] == "session_started" && e["session"] == id.as_str())
        .expect("the first core's session_started");
    assert!(
        started
            < events
                .iter()
                .rposition(|e| e["type"] == "core_started")
                .unwrap()
    );
    let ids: Vec<u64> = events.iter().map(|e| e["id"].as_u64().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
    // A session's token never reads every project's journal.
    let refused = h
        .cli(&["events", "--history", "1"])
        .env("NUNCHIRO_TOKEN", &token)
        .output()
        .unwrap();
    assert!(!refused.status.success());
}

#[test]
fn events_stream_in_order_and_resume_without_gaps_or_repeats() {
    let h = Harness::new();
    let since = h.cursor().to_string();
    let stream = Stream::open(&h, &["events", "--since", &since]);
    let (id, _) = h.start(&h.home);
    // The log reads states at the core's tick: a change faster than one tick shows as the newer state only.
    let mut first = stream.until(|e| e["session"] == id.as_str());
    h.ask(&id);
    first.extend(stream.until(|e| e["session"] == id.as_str() && e["state"] == "question"));
    assert_eq!(
        of(&first, &id),
        [("session_started", "waiting"), ("state", "question")]
    );
    let ids: Vec<u64> = first.iter().map(|e| e["id"].as_u64().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
    drop(stream);

    // Events while no reader is connected come once, in order, to a reader that passes the last id it saw.
    let last = *ids.last().unwrap();
    h.owner(json!({"op":"close","id":id})).unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let missed = loop {
        let r = h.owner(json!({"op":"events","since":last})).unwrap();
        assert_eq!(r["gap"], false);
        let events = r["events"].as_array().unwrap().clone();
        if of(&events, &id).contains(&("session_ended", "")) {
            break events;
        }
        assert!(Instant::now() < until, "no session_ended: {r}");
        thread::sleep(Duration::from_millis(50));
    };
    let stream = Stream::open(&h, &["events", "--since", &last.to_string()]);
    let resumed = stream.until(|e| e["session"] == id.as_str() && e["type"] == "session_ended");
    assert_eq!(resumed[..], missed[..resumed.len()]);
    assert!(resumed.iter().all(|e| e["id"].as_u64().unwrap() > last));

    // A cursor the core never gave (a previous core's) says the stream has a gap.
    let stream = Stream::open(&h, &["events", "--since", "1"]);
    assert_eq!(stream.until(|_| true)[0]["type"], "gap");
}

#[test]
fn a_session_token_sees_only_its_own_projects_events() {
    let h = Harness::new();
    let other = h.home.join("other");
    fs::create_dir(&other).unwrap();
    let since = h.cursor();
    let (mine, token) = h.start(&h.home);
    let (theirs, _) = h.start(&other);
    h.ask(&theirs);
    let owner_sees = |id: &str| {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let r = h.owner(json!({"op":"events","since":since})).unwrap();
            if r["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["session"] == id && e["state"] == "question")
            {
                return;
            }
            assert!(Instant::now() < until, "owner never saw {id}: {r}");
            thread::sleep(Duration::from_millis(50));
        }
    };
    owner_sees(&theirs);
    let r = h
        .call(&token, json!({"op":"events","since":since}))
        .unwrap();
    let events = r["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["session"] == mine.as_str()), "{r}");
    assert!(
        events.iter().all(|e| e["project"] == json!(h.home)),
        "a session saw another project's events: {r}"
    );
    // Naming the other project changes nothing for a session.
    let r = h
        .call(&token, json!({"op":"events","since":since,"project":other}))
        .unwrap();
    assert_eq!(r["events"], json!([]), "{r}");
    // The owner may narrow to one project.
    let r = h
        .owner(json!({"op":"events","since":since,"project":other}))
        .unwrap();
    assert!(
        r["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["session"] == theirs.as_str()),
        "{r}"
    );
}

// Ticket 573: a session reads the room events of its own room only (the room API's scope), not another project's.
#[test]
fn a_session_token_sees_only_its_own_rooms_messages() {
    let h = Harness::new();
    let other = h.home.join("other");
    fs::create_dir(&other).unwrap();
    let since = h.cursor();
    let (_, mine) = h.start(&h.home);
    let (_, theirs) = h.start(&other);
    for (token, body) in [(&mine, "mine-note"), (&theirs, "theirs-note")] {
        h.call(token, json!({"op":"room_send","to":"person","body":body}))
            .unwrap();
    }
    let seen = |token: &str| -> Vec<String> {
        let r = h.call(token, json!({"op":"events","since":since})).unwrap();
        r["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "room_message")
            .map(|e| e["data"]["body"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(seen(&mine), ["mine-note"]);
    assert_eq!(seen(&theirs), ["theirs-note"]);
    let owner = fs::read_to_string(h.home.join("core.token")).unwrap();
    assert_eq!(seen(&owner), ["mine-note", "theirs-note"]);
}

#[test]
fn agent_verbs_exit_2_while_the_agent_waits_on_a_question() {
    let h = Harness::new();
    let (id, _) = h.start(&h.home);
    // Not blocked: wait for the idle state ends 0.
    let out = h.run(&["agent", "wait", &id, "--until", "idle", "--timeout", "5000"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    h.ask(&id);
    let out = h.run(&[
        "agent",
        "wait",
        &id,
        "--until",
        "done",
        "--timeout",
        "10000",
    ]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let record: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(record["status"], "blocked");
    assert_eq!(record["pending"][0]["kind"], "question", "{record}");
    // Waiting for `blocked` itself is a success.
    let out = h.run(&[
        "agent",
        "wait",
        &id,
        "--until",
        "blocked",
        "--timeout",
        "5000",
    ]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    // A prompt into a blocked agent needs the answer first.
    let out = h.run(&["agent", "prompt", &id, "hello"]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    // The core refused it before delivery; the record is printed all the same.
    let record: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(record["status"], "blocked", "{record}");
    // A read stays a read: 0.
    assert_eq!(
        h.run(&["agent", "get", &id, "--json"]).status.code(),
        Some(0)
    );
    // Failures are 1.
    let out = h.run(&["agent", "wait", "no-such-agent", "--until", "done"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
}

#[test]
fn two_starts_with_one_receipt_make_one_session() {
    let h = Harness::new();
    let project = h.home.to_str().unwrap();
    let start = |receipt: Option<&str>| {
        let mut args = vec![
            "agent",
            "start",
            "w",
            "--kind",
            "shell",
            "--project",
            project,
        ];
        if let Some(r) = receipt {
            args.extend(["--receipt", r]);
        }
        args.extend(["--", "/bin/sh", "-c", "exec cat"]);
        let out = h.run(&args);
        assert!(out.status.success(), "{out:?}");
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    let first = start(None);
    let receipt = first["receipt"].as_str().unwrap().to_string();
    assert_eq!(receipt.len(), 24);
    let again = start(Some(&receipt));
    assert_eq!(again["session"]["id"], first["session"]["id"]);
    assert_eq!(again["receipt"], receipt.as_str());
    // Two at once with a fresh receipt: one session.
    let (a, b) = thread::scope(|s| {
        let a = s.spawn(|| start(Some("same-receipt")));
        let b = s.spawn(|| start(Some("same-receipt")));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(a["session"]["id"], b["session"]["id"]);
    let sessions = h.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(sessions, 2, "one session per receipt");
    // A receipt is 1-128 printable ASCII characters without spaces, at the CLI and at the core.
    for bad in ["", "has space", &"r".repeat(129), "é"] {
        let out = h.run(&[
            "agent",
            "start",
            "w",
            "--kind",
            "shell",
            "--project",
            project,
            "--receipt",
            bad,
        ]);
        assert_eq!(out.status.code(), Some(1), "{bad:?}: {out:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("start_receipt_invalid"),
            "{out:?}"
        );
    }
    let r = h.owner(json!({"op":"start","receipt":"r".repeat(400),
        "session":{"kind":"shell","project":project,"args":["/bin/sh","-c","exec cat"]}}));
    assert!(r.unwrap_err().contains("start_receipt_invalid"));
    assert!(start(Some(&"r".repeat(128)))["session"]["id"].is_string());
}

#[test]
fn worktree_create_and_remove_are_events() {
    let h = Harness::new();
    let repo = h.home.join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        &["init", "-q"][..],
        &[
            "-c",
            "user.name=F",
            "-c",
            "user.email=f@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "f",
        ],
    ] {
        let ok = home::git_env::scrubbed("git")
            .current_dir(&repo)
            .args(args)
            .status()
            .unwrap();
        assert!(ok.success());
    }
    let repo = fs::canonicalize(&repo).unwrap();
    let since = h.cursor().to_string();
    let stream = Stream::open(
        &h,
        &[
            "events",
            "--project",
            repo.to_str().unwrap(),
            "--since",
            &since,
        ],
    );
    let out = h.run(&[
        "worktree",
        "create",
        "--project",
        repo.to_str().unwrap(),
        "--branch",
        "ev",
        "--no-focus",
    ]);
    assert!(out.status.success(), "{out:?}");
    let created = stream.until(|e| e["type"] == "worktree_created");
    let path = created.last().unwrap()["path"]
        .as_str()
        .unwrap()
        .to_string();
    let out = h.run(&["worktree", "remove", "--path", &path]);
    assert!(out.status.success(), "{out:?}");
    let removed = stream.until(|e| e["type"] == "worktree_removed");
    assert_eq!(removed.last().unwrap()["path"], path.as_str());
    // A start with --worktree creates one too.
    let out = h.run(&[
        "agent",
        "start",
        "w",
        "--kind",
        "shell",
        "--project",
        repo.to_str().unwrap(),
        "--worktree",
        "--",
        "/bin/sh",
        "-c",
        "exec cat",
    ]);
    assert!(out.status.success(), "{out:?}");
    let started: Value = serde_json::from_slice(&out.stdout).unwrap();
    let created = stream.until(|e| e["type"] == "worktree_created");
    assert_eq!(created.last().unwrap()["path"], started["session"]["cwd"]);
}

#[test]
fn a_remote_flagged_caller_sees_only_the_sessions_it_owns() {
    let h = Harness::new();
    let since = h.cursor();
    let (x, token) = h.start(&h.home);
    let (y, _) = h.start(&h.home);
    // As a forwarded machine call does, this flags X's id as remote (V1A-04): it then owns only its own workers.
    let project = fs::canonicalize(&h.home).unwrap();
    h.owner(json!({"op":"forwarded","caller":{"id":x,"project":project},"request":{"op":"list"}}))
        .unwrap();
    let worker = h
        .call(&token, json!({"op":"start","session":{"kind":"shell","project":project,"args":["/bin/sh","-c","exec cat"]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(10);
    let seen = loop {
        let r = h
            .call(&token, json!({"op":"events","since":since}))
            .unwrap();
        let events = r["events"].as_array().unwrap().clone();
        if events.iter().any(|e| e["session"] == worker.as_str()) {
            break events;
        }
        assert!(Instant::now() < until, "no event of its own worker: {r}");
        thread::sleep(Duration::from_millis(50));
    };
    assert!(
        seen.iter().all(|e| e["session"] == worker.as_str()),
        "saw sessions it does not own ({x}, {y}): {seen:?}"
    );
}
