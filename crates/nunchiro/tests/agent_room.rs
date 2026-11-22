// Ticket 571: the room verbs end to end through a real core: `ask --wait` gets the reply in the same call, a timeout
// exits 2 and leaves a timeout event, and the sender is the calling session whatever the command line says.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        let home = home::short("aroom");
        let core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .spawn()
            .unwrap();
        let h = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while !h.home.join("core.token").exists()
            || UnixStream::connect(h.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until, "core never came up");
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn call(&self, token: &str, request: Value) -> Value {
        let mut s = UnixStream::connect(self.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        serde_json::from_str::<Result<Value, String>>(&line)
            .unwrap()
            .unwrap()
    }
    fn owner(&self, request: Value) -> Value {
        self.call(
            &fs::read_to_string(self.home.join("core.token")).unwrap(),
            request,
        )
    }
    /// A shell session that prints its token; started by `token`'s session, or by the owner.
    fn start(&self, token: Option<&str>) -> (String, String) {
        let request = json!({"op":"start","session":{"kind":"shell","project":self.home,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}});
        let reply = match token {
            Some(token) => self.call(token, request),
            None => self.owner(request),
        };
        let id = reply["session"]["id"].as_str().unwrap().to_string();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let r = self.owner(json!({"op":"read","id":id}));
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
    fn command(&self, token: &str, args: &[&str]) -> Command {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env("NUNCHIRO_TOKEN", token);
        c
    }
    fn cli(&self, token: &str, args: &[&str]) -> Output {
        self.command(token, args).output().unwrap()
    }
    fn lines(&self, token: &str, args: &[&str]) -> Vec<Value> {
        let out = self.cli(token, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        if let (Ok(mut s), Ok(token)) = (
            UnixStream::connect(self.home.join("core.sock")),
            fs::read_to_string(self.home.join("core.token")),
        ) {
            let _ = writeln!(s, "{}", json!({"token": token, "request": {"op":"stop"}}));
            let _ = BufReader::new(s).read_line(&mut String::new());
        }
        let until = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.core.kill();
        let _ = self.core.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn ask_wait_gets_reply_in_same_call() {
    let h = Harness::new();
    let (_lead, lead_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&lead_token));
    let asking = h
        .command(
            &worker_token,
            &["agent", "ask", "which branch?", "--wait", "--timeout", "30"],
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // The lead is the worker's parent, so the unaddressed ask is in its inbox.
    let until = Instant::now() + Duration::from_secs(20);
    let ask = loop {
        if let Some(ask) = h.lines(&lead_token, &["agent", "check"]).pop() {
            break ask;
        }
        assert!(Instant::now() < until, "the ask never reached the lead");
        thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        (ask["kind"].as_str(), ask["from"].as_str()),
        (Some("ask"), Some(worker.as_str()))
    );
    h.lines(
        &lead_token,
        &["agent", "reply", ask["id"].as_str().unwrap(), "main"],
    );
    let out = asking.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        (reply["kind"].as_str(), reply["body"].as_str()),
        (Some("reply"), Some("main"))
    );
}

#[test]
fn ask_timeout_exits_2_and_logs_event() {
    let h = Harness::new();
    let (_lead, lead_token) = h.start(None);
    let (_worker, worker_token) = h.start(Some(&lead_token));
    let out = h.cli(
        &worker_token,
        &[
            "agent",
            "ask",
            "anyone?",
            "--thread",
            "t1",
            "--wait",
            "--timeout",
            "1",
        ],
    );
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("ask_timeout"));
    let thread = h.lines(&worker_token, &["agent", "thread", "read", "t1"]);
    let kinds: Vec<_> = thread.iter().map(|m| m["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["ask", "timeout"]);
}

#[test]
fn caller_cannot_set_from() {
    let h = Harness::new();
    let (lead, lead_token) = h.start(None);
    let (worker, worker_token) = h.start(Some(&lead_token));
    // No option names the sender.
    let out = h.cli(&worker_token, &["agent", "send", "--from", &lead, "hi"]);
    assert!(!out.status.success());
    // A raw request with a `from` field is stamped with the calling session all the same.
    let sent = h.call(
        &worker_token,
        json!({"op":"room_send","to":lead,"body":"hi","from":"person","created_by":"person"}),
    );
    let m = &sent["messages"][0];
    assert_eq!(
        (m["from"].as_str(), m["created_by"].as_str()),
        (Some(worker.as_str()), Some("agent"))
    );
    // The legacy two-word form still types into a terminal, not into the room.
    let typed = h.cli(&worker_token, &["agent", "send", &lead, "typed"]);
    assert!(
        typed.status.success(),
        "{}",
        String::from_utf8_lossy(&typed.stderr)
    );
    let inbox = h.lines(&lead_token, &["agent", "check"]);
    assert_eq!(inbox.len(), 1, "{inbox:?}");
    assert_eq!(inbox[0]["body"], "hi");
}

#[test]
fn printed_bodies_carry_no_control_characters() {
    let h = Harness::new();
    let (lead, lead_token) = h.start(None);
    let (_worker, worker_token) = h.start(Some(&lead_token));
    h.call(
        &worker_token,
        json!({"op":"room_send","to":lead,"body":"a\u{9b}31m\u{1b}[2J\u{7}b\nc\td"}),
    );
    let out = h.cli(&lead_token, &["agent", "check"]);
    assert!(out.status.success());
    assert!(
        !out.stdout.windows(2).any(|w| w == [0xC2, 0x9B]),
        "raw C1 printed"
    );
    let m: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(m["body"], "a31m[2Jb\nc\td");
}

#[test]
fn ask_timeout_exits_2_with_full_inbox() {
    let h = Harness::new();
    let (lead, lead_token) = h.start(None);
    let (_worker, worker_token) = h.start(Some(&lead_token));
    for i in 0..49 {
        h.call(
            &worker_token,
            json!({"op":"room_send","to":lead,"body":format!("n{i}")}),
        );
    }
    // The ask is the lead's 50th unread message; its timeout event is the 51st and must still land.
    let out = h.cli(
        &worker_token,
        &[
            "agent",
            "ask",
            "--to",
            &lead,
            "--thread",
            "tx",
            "anyone?",
            "--wait",
            "--timeout",
            "1",
        ],
    );
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let thread = h.lines(&worker_token, &["agent", "thread", "read", "tx"]);
    let kinds: Vec<_> = thread.iter().map(|m| m["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["ask", "timeout"]);
}

#[test]
fn agent_start_refuses_an_option_as_the_name() {
    let h = Harness::new();
    let (_, token) = h.start(None);
    let before = h.owner(json!({"op":"snapshot"}))["sessions"]
        .as_array()
        .unwrap()
        .len();
    let out = h.cli(&token, &["agent", "start", "-x"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage: agent start <name>"));
    // Look v10 Home S2-3: `--help` on any verb prints the usage (exit 0), which names the reply to an ask.
    for args in [
        &["agent", "start", "--help"][..],
        &["agent", "reply", "--help"],
        &["agent", "send", "--help"],
        &["agent"],
    ] {
        let out = h.cli(&token, args);
        assert!(out.status.success(), "{args:?}");
        let usage = String::from_utf8_lossy(&out.stdout);
        assert!(
            usage.contains("nunchiro agent reply <message-id> <body>")
                && usage.contains("nunchiro agent start <name>"),
            "{args:?}: {usage}"
        );
    }
    let after = h.owner(json!({"op":"snapshot"}))["sessions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(before, after, "no session was started");
}
