static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
#[path = "../../nunchiro-core/tests/fixtures/hold.rs"]
mod hold;

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        Self::configured(None)
    }
    fn configured(settings: Option<&str>) -> Self {
        Self::command(
            settings,
            home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro")),
        )
    }
    fn command(settings: Option<&str>, mut command: Command) -> Self {
        home::git_env::scrub(&mut command);
        let home = home::short("agent");
        if let Some(settings) = settings {
            fs::write(
                home.join("settings.json"),
                settings.replace("PROJECT", home.to_str().unwrap()),
            )
            .unwrap();
        }
        fs::create_dir_all(home.join("user")).unwrap();
        let core = command
            .arg("serve")
            .env("HOME", home.join("user")) // ticket 1083: the default worktrees folder lies in it
            .env("NUNCHIRO_HOME", &home)
            .env("CLAUDE_CONFIG_DIR", home.join("claude-data"))
            .env("CODEX_HOME", home.join("codex-data"))
            .env("ZDOTDIR", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .env(
                "PATH",
                format!(
                    "{}/tests/fixtures/agent-cli:{}",
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            )
            .spawn()
            .unwrap();
        let h = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while !h.home.join("core.token").exists()
            || UnixStream::connect(h.home.join("core.sock")).is_err()
        {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn call(&self, token: &str, request: Value) -> Result<Value, String> {
        // Only a missing reply fails here, so the fuse is generous: one start is several serial execs (git, --version),
        // which took over 10 s at load average 13 to 45. Tests that assert a timing keep their own clock.
        self.call_within(Duration::from_secs(60), token, request)
    }
    /// v1a-80c: `call` with its own read deadline, for the one request that waits behind a long registry-lock hold.
    fn call_within(
        &self,
        deadline: Duration,
        token: &str,
        request: Value,
    ) -> Result<Value, String> {
        let mut s = UnixStream::connect(self.home.join("core.sock")).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(deadline)).unwrap();
        let (op, began) = (request["op"].to_string(), Instant::now());
        // A write the core already closed (BrokenPipe, reset) is the same dead core as an empty reply, unless the
        // reply is already here: a stopping core waits 100 ms for a connect's request, then answers and closes
        // (server.rs `refuse_stopping`). Under load this side's write came after that close and failed, with the
        // answer unread (a_request_right_after_stop_is_answered_or_refused: once in a full gate run, 8 of 1440 runs
        // at 48 in parallel). So the reply is read first, and only a failed write with no reply is a dead core.
        let wrote = writeln!(s, "{}", json!({"token": token, "request":request}));
        let mut line = String::new();
        // A missing reply panics: Err stays what the core sent, so an `is_err()` refusal check cannot pass on a hang.
        // (macOS reports the read timeout as WouldBlock.)
        let read = BufReader::new(s).read_line(&mut line);
        if line.is_empty() {
            if let Err(e) = wrote {
                panic!("core closed the connection without a reply to {op} ({e})");
            }
            read.unwrap_or_else(|e| panic!("no reply to {op} within {:?} ({e})", began.elapsed()));
        }
        assert!(
            !line.is_empty(),
            "core closed the connection without a reply to {op}"
        );
        serde_json::from_str(&line).map_err(|e| e.to_string())?
    }
    fn owner(&self, request: Value) -> Result<Value, String> {
        self.call(
            &fs::read_to_string(self.home.join("core.token")).map_err(|e| e.to_string())?,
            request,
        )
    }
    fn start(&self) -> Value {
        self.owner(json!({"op":"start","session":{"kind":"shell","project":self.home,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]}})).unwrap()["session"].clone()
    }
    fn token(&self, id: &str) -> String {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let r = self.owner(json!({"op":"read","id":id})).unwrap();
            let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
            let text = String::from_utf8_lossy(&data);
            // Ticket 1142: only a finished line; the screen can hold the token's first bytes before its last (a PTY
            // read split under load), and that prefix was presented as the token: "unauthorized" on CI.
            if let Some(line) = text
                .split_inclusive('\n')
                .filter(|l| l.ends_with('\n'))
                .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            {
                return line.trim().into();
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
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
        let until = Instant::now() + Duration::from_secs(5);
        while self.home.join("core.sock").exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

/// A core that never answers, or closes without a reply, must panic the harness, never return Err: `is_err()` refusal
/// checks would pass on a hang or a dead core.
fn call_against_silent_core(close: bool) {
    let home = std::env::temp_dir().join(format!("ns-hang-{}-{close}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let sock = home.join("core.sock");
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    thread::spawn(move || {
        let held = listener.accept();
        let _ = fs::remove_file(sock); // so the Harness drop does not wait for the socket to vanish
        if !close {
            thread::sleep(Duration::from_secs(3));
        }
        drop(held);
    });
    let h = Harness {
        home,
        core: Command::new("true").spawn().unwrap(),
    };
    let r = h.call_within(Duration::from_millis(300), "t", json!({"op":"snapshot"}));
    let _ = r;
    panic!("call returned instead of panicking");
}
#[test]
#[should_panic(expected = "no reply to")]
fn call_to_a_core_that_never_answers_panics() {
    call_against_silent_core(false);
}
#[test]
#[should_panic(expected = "core closed the connection without a reply to")]
fn call_to_a_core_that_closes_without_a_reply_panics() {
    call_against_silent_core(true);
}
#[test]
fn session_token_cannot_send_to_unowned_sessions_or_forge_authority() {
    let h = Harness::new();
    let coordinator = h.start();
    let other = h.start();
    let token = h.token(coordinator["id"].as_str().unwrap());
    // v1a-23 flip (needs 47): a session token reaches every session, so none of these is a grant refusal any more
    // (was: every op refused). Forged tokens stay refused. Ticket 286 r6: `close` is checked last, on its own rule.
    let probe = |op: &str| {
        let r = json!({"op":op,"id":other["id"],"text":"INTRUSION","keys":["enter"],"label":"intrusion","source":"screen","lines":10,"send":"send-id"});
        let got = h.call(&token, r.clone());
        assert_ne!(got.err().as_deref(), Some("outside session grants"), "{op}");
        assert!(h.call("forged", r).is_err());
    };
    for op in [
        "send_text",
        "send_keys",
        "read",
        "label",
        "agent_prompt",
        "agent_send",
        "agent_keys",
        "agent_read",
        "agent_get",
        "cancel_send",
    ] {
        probe(op);
    }
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        let out = h.owner(json!({"op":"read","id":other["id"]})).unwrap();
        let data: Vec<u8> = serde_json::from_value(out["data"].clone()).unwrap();
        if String::from_utf8_lossy(&data).contains("INTRUSION") {
            break;
        }
        assert!(
            Instant::now() < until,
            "the session token's send did not arrive"
        );
        thread::sleep(Duration::from_millis(20));
    }
    // Token stripping is intentionally user authority in v1a; this records that limit.
    assert!(
        h.owner(json!({"op":"send_text","id":other["id"],"text":"user"}))
            .is_ok()
    );
    // Ticket 286 r6: close is the exception, refused for a session the token did not start (worker_closes_only_*).
    assert_eq!(
        h.call(&token, json!({"op":"close","id":other["id"]}))
            .err()
            .as_deref(),
        Some("a session closes only itself and the sessions it started")
    );
}

#[test]
fn coordinator_can_start_and_read_only_its_own_workers() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let r = h.call(
        &token,
        json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/cat"]}}),
    );
    assert!(r.is_ok(), "coordinator start refused: {r:?}");
    let worker = r.unwrap()["session"]["id"].clone();
    assert!(h.call(&token, json!({"op":"read","id":worker})).is_ok());
    let other = h.start();
    // v1a-23 flip: another session and another project are reachable now (were refused).
    assert!(
        h.call(&token, json!({"op":"read","id":other["id"]}))
            .is_ok()
    );
    assert!(h.call(&token,json!({"op":"start","session":{"kind":"shell","project":h.home.parent().unwrap(),"args":["/bin/cat"]}})).is_ok());
}

impl Harness {
    fn worker(&self, token: &str, args: &[&str]) -> String {
        self.call(
            token,
            json!({"op":"start","session":{"kind":"claude","project":self.home,"args":args}}),
        )
        .unwrap_or_else(|e| {
            // Ticket 1142: a refusal names what the token was read as and which sessions still run.
            let states = self.owner(json!({"op":"snapshot"})).map(|s| {
                s["sessions"].as_array().map_or(vec![], |all| {
                    all.iter()
                        .map(|s| format!("{} {}", s["kind"], s["state"]))
                        .collect()
                })
            });
            panic!(
                "start as a {}-character token: {e}; sessions: {states:?}",
                token.len()
            )
        })["session"]["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn snapshot(&self, token: &str, id: &str) -> Value {
        self.call(token, json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()
            .clone()
    }
    fn pending(&self, token: &str, id: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let s = self.snapshot(token, id);
            if let Some(p) = s["pending"].as_array().unwrap().first() {
                return p.clone();
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
    }
}
#[test]
fn permission_answers_require_project_setting_and_allow_once() {
    for enabled in [false, true] {
        let settings = if enabled {
            Some(r#"{"permission_answers":{"PROJECT":true}}"#)
        } else {
            None
        };
        let h = Harness::configured(settings);
        let c = h.start();
        let token = h.token(c["id"].as_str().unwrap());
        let id = h.worker(&token, &["--fixture-permission"]);
        let p = h.pending(&token, &id);
        assert!(h.call(&token,json!({"op":"answer","item":p["id"],"answer":{"type":"choose","index":1},"confirmed":true})).is_err());
        let r = h.call(
            &token,
            json!({"op":"answer","item":p["id"],"answer":{"type":"allow_once"}}),
        );
        // V2-8e: the fixture's prompt names no command (screen only: risky) and an agent never allows a risky request;
        // the setting still decides which refusal comes first.
        let e = r.unwrap_err();
        let expected = if enabled {
            "an agent cannot allow a risky request"
        } else {
            "permission_answers_disabled"
        };
        assert!(e.contains(expected), "{enabled}: {e}");
    }
}

impl Harness {
    fn cli(&self, token: Option<&str>, args: &[&str]) -> std::process::Output {
        self.cli_command(token, args).output().unwrap()
    }
    /// v1a-17: `cli` with a failure-detection deadline: a command still running after `deadline` is killed and fails.
    fn cli_within(
        &self,
        deadline: Duration,
        token: Option<&str>,
        args: &[&str],
    ) -> std::process::Output {
        let mut child = self
            .cli_command(token, args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let until = Instant::now() + deadline;
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                panic!("nunchiro {args:?} still running after {deadline:?}");
            }
            thread::sleep(Duration::from_millis(20));
        }
        child.wait_with_output().unwrap()
    }
    fn cli_command(&self, token: Option<&str>, args: &[&str]) -> Command {
        let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        c.args(args)
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN");
        c.env("CLAUDE_CONFIG_DIR", self.home.join("claude-data"))
            .env("CODEX_HOME", self.home.join("codex-data"))
            .env("ZDOTDIR", &self.home)
            .env(
                "PATH",
                format!(
                    "{}/tests/fixtures/agent-cli:{}",
                    env!("CARGO_MANIFEST_DIR"),
                    std::env::var("PATH").unwrap()
                ),
            );
        if let Some(t) = token {
            c.env("NUNCHIRO_TOKEN", t);
        }
        c
    }
    fn await_ready(&self, token: &str, id: &str) {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let s = self.snapshot(token, id);
            let r = self
                .call(
                    token,
                    json!({"op":"agent_read","id":id,"source":"screen","lines":50}),
                )
                .unwrap();
            if s["attention"]["working"] == false
                && r["text"].as_str().unwrap().contains(['❯', '›'])
            {
                return;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
    }
}
#[test]
fn cli_coordinator_prompts_waits_reads_and_gets_completion() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let start = h.cli(
        Some(&token),
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "claude",
            "--project",
            h.home.to_str().unwrap(),
        ],
    );
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let worker: Value = serde_json::from_slice(&start.stdout).unwrap();
    let id = worker["session"]["id"].as_str().unwrap();
    h.await_ready(&token, id);
    for args in [
        vec![
            "agent", "prompt", "worker", "hello", "--wait", "--until", "done", "--until", "blocked",
        ],
        vec![
            "agent",
            "wait",
            "worker",
            "--until",
            "idle",
            "--timeout",
            "500",
        ],
        vec![
            "agent", "read", "worker", "--lines", "20", "--source", "screen",
        ],
        vec!["agent", "get", "worker", "--json"],
    ] {
        let r = h.cli(Some(&token), &args);
        assert!(
            r.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&r.stderr)
        );
        if args[1] == "read" {
            assert!(String::from_utf8_lossy(&r.stdout).contains("ACK:hello"));
        }
    }
    let s = h.snapshot(&token, id);
    assert_eq!(s["send_log"][0]["content"], "hello");
    assert_eq!(s["send_log"][0]["status"], "delivered");
    for text in ["/model sonnet", "/effort high", "hello\n/model opus"] {
        assert!(
            !h.cli(Some(&token), &["agent", "prompt", "worker", text])
                .status
                .success()
        );
    }
}
#[test]
fn dialogs_refuse_prompt_and_persistent_keys_but_accept_logged_escape() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-dialog"]);
    h.pending(&token, &id);
    let r = h.cli(Some(&token), &["agent", "prompt", &id, "hello"]);
    assert!(!r.status.success());
    assert!(String::from_utf8_lossy(&r.stderr).contains("agent_blocked"));
    assert!(
        !h.cli(Some(&token), &["agent", "send-keys", &id, "1", "enter"])
            .status
            .success()
    );
    assert!(
        h.cli(Some(&token), &["agent", "send-keys", &id, "esc"])
            .status
            .success()
    );
    assert_eq!(
        h.snapshot(&token, &id)["send_log"][0]["status"],
        "delivered"
    );
}
#[test]
fn busy_send_is_visible_cancelable_and_delivered_once_when_ready() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-busy"]);
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, &id)["attention"]["working"] != true {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let a = h
        .call(
            &token,
            json!({"op":"agent_prompt","id":id,"text":"cancel me"}),
        )
        .unwrap();
    assert_eq!(a["send"]["status"], "queued");
    assert!(
        h.call(
            &token,
            json!({"op":"cancel_send","id":id,"send":a["send"]["id"]})
        )
        .is_ok()
    );
    let b = h
        .call(
            &token,
            json!({"op":"agent_prompt","id":id,"text":"deliver once"}),
        )
        .unwrap();
    assert_eq!(b["send"]["status"], "queued");
    h.owner(json!({"op":"hook","id":id,"event":"Stop","payload":{}}))
        .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        let s = h.snapshot(&token, &id);
        if s["send_log"][1]["status"] == "delivered" {
            break;
        }
        assert!(Instant::now() < until, "{s}");
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(h.snapshot(&token, &id)["send_log"][0]["status"], "canceled");
}
#[test]
fn silent_prompt_stalls_after_five_seconds() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-silent"]);
    h.await_ready(&token, &id);
    thread::sleep(Duration::from_millis(100));
    let start = Instant::now();
    // v1a-17: the 5 s floor is the contract. The stall must also beat the command's own 10 s wait, which would
    // end in agent_wait_timeout instead; both clocks run in the one command, so host load cannot reorder them.
    let r = h.cli(
        Some(&token),
        &["agent", "prompt", &id, "silence", "--timeout", "10000"],
    );
    assert!(!r.status.success(), "silent prompt succeeded");
    assert!(
        String::from_utf8_lossy(&r.stderr).contains("agent_prompt_stalled"),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert!(start.elapsed() >= Duration::from_secs(5));
}
#[test]
fn worktree_parity_creates_lists_opens_and_removes_without_force() {
    let h = Harness::new();
    let repo = h.home.join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let r = h.cli(
        None,
        &[
            "worktree",
            "create",
            "--project",
            repo.to_str().unwrap(),
            "--branch",
            "worker",
            "--base",
            "HEAD",
            "--label",
            "worker",
            "--no-focus",
        ],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let data: Value = serde_json::from_slice(&r.stdout).unwrap();
    let path = data["worktrees"][0]["path"].as_str().unwrap();
    assert!(std::path::Path::new(path).join(".git").exists());
    let list = h.cli(
        None,
        &["worktree", "list", "--project", repo.to_str().unwrap()],
    );
    assert!(list.status.success());
    assert!(String::from_utf8_lossy(&list.stdout).contains(path));
    let open = h.cli(
        None,
        &["worktree", "open", "--path", path, "--label", "opened"],
    );
    assert!(
        open.status.success(),
        "{}",
        String::from_utf8_lossy(&open.stderr)
    );
    let opened: Value = serde_json::from_slice(&open.stdout).unwrap();
    assert!(
        !h.cli(
            None,
            &[
                "worktree",
                "remove",
                "--path",
                &format!(
                    "{path}/../{}",
                    std::path::Path::new(path)
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                )
            ]
        )
        .status
        .success(),
        "aliased path removed a live worktree"
    );
    assert_eq!(opened["session"]["cwd"], path);
    assert!(
        !h.cli(None, &["worktree", "remove", "--path", path])
            .status
            .success()
    );
    assert!(
        h.cli(
            None,
            &[
                "session",
                "close",
                opened["session"]["id"].as_str().unwrap()
            ]
        )
        .status
        .success()
    );
    fs::write(std::path::Path::new(path).join("untracked"), "keep me").unwrap();
    assert!(
        !h.cli(None, &["worktree", "remove", "--path", path])
            .status
            .success()
    );
    fs::remove_file(std::path::Path::new(path).join("untracked")).unwrap();
    let removed = h.cli(None, &["worktree", "remove", "--path", path]);
    assert!(removed.status.success());
    assert!(!String::from_utf8_lossy(&removed.stderr).contains("git worktree prune"));
    assert!(!std::path::Path::new(path).exists());
}

#[test]
fn session_cli_and_serve_restart_preserve_logged_sends_without_replay() {
    let h = Harness::new();
    let r = h.cli(
        None,
        &[
            "session",
            "open",
            "--project",
            h.home.to_str().unwrap(),
            "--",
            "/bin/cat",
        ],
    );
    assert!(r.status.success());
    let session: Value = serde_json::from_slice(&r.stdout).unwrap();
    let id = session["session"]["id"].as_str().unwrap();
    for args in [
        vec!["session", "label", id, "pane"],
        vec!["session", "send-text", id, "hello"],
        vec!["session", "send-keys", id, "enter"],
        vec!["session", "read", id],
        vec!["session", "list"],
        vec!["snapshot", "--json"],
    ] {
        assert!(h.cli(None, &args).status.success(), "{args:?}");
    }
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let worker = h.worker(&token, &["--fixture-busy"]);
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, &worker)["attention"]["working"] != true {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    h.call(
        &token,
        json!({"op":"agent_prompt","id":worker,"text":"never replay"}),
    )
    .unwrap();
    assert!(h.cli(None, &["serve", "restart"]).status.success());
    let s = h.owner(json!({"op":"snapshot"})).unwrap();
    let worker = s["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == worker)
        .unwrap();
    assert_eq!(worker["send_log"][0]["status"], "canceled");
    // V2-1b (needs 76): the session survives the restart and its token still works; its send is still not replayed.
    assert!(h.call(&token, json!({"op":"snapshot"})).is_ok());
    assert!(h.cli(None, &["serve", "stop"]).status.success());
}
#[test]
fn malformed_send_logs_fail_closed_and_preserve_store_bytes() {
    let h = Harness::new();
    let _ = h.start();
    h.owner(json!({"op":"stop"})).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while h.home.join("core.sock").exists() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let path = h.home.join("sessions.json");
    let valid: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let row = json!({"id":"00000000000000000000000000000001","sender":"user","at":1,"content":"text","keys":[],"submit":false,"status":"queued"});
    for (log, queue) in [
        (json!({}), json!([])),
        (json!([{"id":123}]), json!([])),
        (
            json!([{"id":"same","sender":"user","at":1,"content":"text","keys":["enter"],"submit":false,"status":"delivered"}]),
            json!([]),
        ),
        (json!([]), json!({})),
        (json!([]), json!([row.clone(), row.clone()])),
        (json!([row.clone()]), json!([row.clone()])),
        (json!([]), {
            let mut finished = row.clone();
            finished["status"] = json!("delivered");
            json!([finished])
        }),
    ] {
        let mut broken = valid.clone();
        broken["sessions"][0]["send_log"] = log;
        broken["sessions"][0]["send_queue"] = queue;
        let bytes = serde_json::to_vec(&broken).unwrap();
        fs::write(&path, &bytes).unwrap();
        let out = h.cli(None, &["serve"]);
        assert!(!out.status.success());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn question_answers_and_transcript_reads_use_the_owned_worker() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-question", "--fixture-transcript"]);
    h.pending(&token, &id);
    assert!(
        h.cli(Some(&token), &["agent", "send-keys", &id, "2", "enter"])
            .status
            .success()
    );
    let r = h.cli(
        Some(&token),
        &[
            "agent",
            "read",
            &id,
            "--source",
            "transcript",
            "--lines",
            "1",
        ],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert!(String::from_utf8_lossy(&r.stdout).contains("transcript-only result"));
    assert_eq!(
        h.snapshot(&token, &id)["send_log"][0]["status"],
        "delivered"
    );
}
#[test]
fn inside_session_forgery_is_refused_and_stripping_is_the_documented_limit() {
    let h = Harness::new();
    let target = h.start();
    let id = target["id"].as_str().unwrap();
    let script = r#"NUNCHIRO_TOKEN=forged "$1" session send-text "$2" forbidden; printf 'FORGED:%s\n' "$?"; env -u NUNCHIRO_TOKEN "$1" session send-text "$2" known-limit; printf 'STRIPPED:%s\n' "$?""#;
    let caller=h.owner(json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c",script,"fixture",env!("CARGO_BIN_EXE_nunchiro"),id]}})).unwrap()["session"]["id"].as_str().unwrap().to_string();
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        let r = h.owner(json!({"op":"read","id":caller})).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        // v1a-13: the documented limit is closed. v1a-23 flip: a stripped token inside a session is that session's
        // caller, so its send now goes through (was STRIPPED:1); the forged token stays refused.
        if text.contains("STRIPPED:0") {
            assert!(text.contains("FORGED:1"));
            break;
        }
        assert!(Instant::now() < until, "{text}");
        thread::sleep(Duration::from_millis(20));
    }
    let until = Instant::now() + Duration::from_secs(3);
    let text = loop {
        let r = h.owner(json!({"op":"read","id":id})).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if text.contains("known-limit") || Instant::now() >= until {
            break text;
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert!(!text.contains("forbidden"));
    assert!(text.contains("known-limit")); // v1a-13; v1a-23 flip (was !contains)
}

/// Ticket 990: `nunchiro` typed in a session is the CLI of the core that runs the session, whatever else is on PATH
/// (an installed older build answered a newer core's replies with "unknown field" in a real run).
#[test]
fn a_sessions_nunchiro_is_its_own_cores_cli() {
    let h = Harness::new();
    let id = h.owner(json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c","printf 'CLI:%s\\n' \"$(command -v nunchiro)\"; exec cat"]}})).unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(5);
    let found = loop {
        let r = h.owner(json!({"op":"read","id":id})).unwrap();
        let data: Vec<u8> = serde_json::from_value(r["data"].clone()).unwrap();
        let text = String::from_utf8_lossy(&data).into_owned();
        if let Some(line) = text
            .lines()
            .find_map(|l| l.split_once("CLI:").map(|(_, t)| t))
        {
            break line.trim().to_string();
        }
        assert!(Instant::now() < until, "{text}");
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(
        fs::canonicalize(found).unwrap(),
        fs::canonicalize(env!("CARGO_BIN_EXE_nunchiro")).unwrap()
    );
}

/// Ticket 990: `agent start --project <worktree>` (the orchestration guide's way) used to make the worktree folder the
/// session's project, so the tree drew the worker as a project of its own. It is the worktree's project now, as a
/// start from the window is.
#[test]
fn a_start_in_a_recorded_worktree_belongs_to_the_worktrees_project() {
    let h = Harness::new();
    let repo = h.repo();
    let r = h.cli(
        None,
        &[
            "worktree",
            "create",
            "--project",
            repo.to_str().unwrap(),
            "--branch",
            "lane-a",
            "--base",
            "HEAD",
            "--no-focus",
        ],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let data: Value = serde_json::from_slice(&r.stdout).unwrap();
    let path = data["worktrees"][0]["path"].as_str().unwrap();
    let project = data["worktrees"][0]["project"].as_str().unwrap();
    let started = h.cli(
        None,
        &[
            "agent",
            "start",
            "lane-a",
            "--kind",
            "shell",
            "--project",
            path,
        ],
    );
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    let started: Value = serde_json::from_slice(&started.stdout).unwrap();
    assert_eq!(started["session"]["project"], project, "{started}");
    assert_eq!(started["session"]["cwd"], path, "{started}");
    // A folder that is no recorded worktree stays its own project.
    let plain = h.cli(
        None,
        &[
            "agent",
            "start",
            "plain",
            "--kind",
            "shell",
            "--project",
            project,
        ],
    );
    let plain: Value = serde_json::from_slice(&plain.stdout).unwrap();
    assert_eq!(plain["session"]["project"], project, "{plain}");
    assert_eq!(plain["session"]["cwd"], project, "{plain}");
}
#[test]
fn another_projects_sessions_and_worktrees_are_outside_the_token_grants() {
    let h = Harness::new();
    let other = h.home.join("other");
    fs::create_dir(&other).unwrap();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let target = h
        .owner(json!({"op":"start","session":{"kind":"shell","project":other,"args":["/bin/cat"]}}))
        .unwrap()["session"]["id"]
        .clone();
    for op in [
        "agent_prompt",
        "agent_send",
        "send_text",
        "send_keys",
        "agent_get",
        "read",
    ] {
        // v1a-23 flip: another project's sessions are reachable (was is_err for each op).
        assert_ne!(
            h.call(
                &token,
                json!({"op":op,"id":target,"text":"forbidden","keys":["enter"]})
            )
            .err()
            .as_deref(),
            Some("outside session grants"),
            "{op}"
        );
    }
    let snapshot = h.call(&token, json!({"op":"snapshot"})).unwrap();
    assert!(!snapshot["sessions"].as_array().unwrap().is_empty()); // v1a-23 flip (was empty)
    assert!(h.call(&token,json!({"op":"worktree","operation":"list","project":other,"path":null,"branch":null,"base":"HEAD","label":""})).is_ok()); // v1a-23 flip (was is_err)
}
#[test]
fn worktree_store_wrong_shape_type_version_and_duplicate_paths_are_preserved() {
    let h = Harness::new();
    let path = h.home.join("worktrees.json");
    let w = json!({"project":h.home,"path":h.home.join("worktrees/fixture"),"branch":"worker","label":"worker"});
    for broken in [
        json!([]),
        json!({"version":1,"worktrees":"bad"}),
        json!({"version":2,"worktrees":[]}),
        json!({"version":1,"worktrees":[w.clone(),w]}),
    ] {
        let bytes = serde_json::to_vec(&broken).unwrap();
        fs::write(&path, &bytes).unwrap();
        let r = h.cli(None, &["worktree", "list"]);
        assert!(!r.status.success());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn worktree_removal_reserves_its_path_against_concurrent_session_start() {
    let h = Harness::new();
    let repo = h.home.join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("/usr/bin/git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let create = h.cli(
        None,
        &[
            "worktree",
            "create",
            "--project",
            repo.to_str().unwrap(),
            "--branch",
            "worker",
            "--base",
            "HEAD",
            "--label",
            "worker",
            "--no-focus",
        ],
    );
    assert!(create.status.success());
    let row: Value = serde_json::from_slice(&create.stdout).unwrap();
    let path = row["worktrees"][0]["path"].as_str().unwrap();
    fs::write(h.home.join("pause-remove"), "").unwrap();
    let mut remove = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["worktree", "remove", "--path", path])
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while !h.home.join("remove-entered").exists() && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    let entered = h.home.join("remove-entered").exists();
    let start = h
        .owner(json!({"op":"start","session":{"kind":"shell","project":path,"args":["/bin/cat"]}}));
    fs::write(h.home.join("release-remove"), "").unwrap();
    let removed = remove.wait().unwrap();
    assert!(entered);
    assert!(removed.success());
    assert!(
        start.is_err(),
        "concurrent session started inside a reserved removal path: {start:?}"
    );
}
#[test]
fn escaped_worktree_paths_are_refused_without_rewriting_the_store() {
    let h = Harness::new();
    let root = h.home.join("worktrees");
    fs::create_dir(&root).unwrap();
    let outside = h.home.join("outside");
    fs::create_dir(&outside).unwrap();
    let path = h.home.join("worktrees.json");
    let bytes=serde_json::to_vec(&json!({"version":1,"worktrees":[{"project":h.home,"path":root.join("../outside"),"branch":"worker","label":"escaped"}]})).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(!h.cli(None, &["worktree", "list"]).status.success());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn configured_worktree_root_alias_writes_canonical_records_on_first_create() {
    let h = Harness::configured(Some(r#"{"worktrees_dir":"PROJECT/alias"}"#));
    let actual = h.home.join("actual");
    fs::create_dir(&actual).unwrap();
    std::os::unix::fs::symlink(&actual, h.home.join("alias")).unwrap();
    let repo = h.home.join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("/usr/bin/git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let r = h.cli(
        None,
        &[
            "worktree",
            "create",
            "--project",
            repo.to_str().unwrap(),
            "--branch",
            "worker",
            "--base",
            "HEAD",
            "--label",
            "worker",
            "--no-focus",
        ],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert!(
        h.cli(None, &["worktree", "list"]).status.success(),
        "freshly created worktree metadata was rejected"
    );
    let row: Value = serde_json::from_slice(&r.stdout).unwrap();
    assert!(
        std::path::Path::new(row["worktrees"][0]["path"].as_str().unwrap()).starts_with(&actual)
    );
}

#[test]
fn fresh_codex_composer_accepts_first_prompt_but_unknown_idle_stays_queued() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let r = h
        .call(
            &token,
            json!({"op":"start","session":{"kind":"codex","project":h.home}}),
        )
        .unwrap();
    let id = r["session"]["id"].as_str().unwrap();
    h.await_ready(&token, id);
    assert_eq!(h.snapshot(&token, id)["completion_seq"], 0);
    let send = h
        .call(&token, json!({"op":"agent_prompt","id":id,"text":"first"}))
        .unwrap();
    assert_eq!(send["send"]["status"], "delivered");
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, id)["completion_seq"] == 0 {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let unknown = h.worker(&token, &["--fixture-unknown"]);
    let send = h
        .call(
            &token,
            json!({"op":"agent_prompt","id":unknown,"text":"wait for evidence"}),
        )
        .unwrap();
    assert_eq!(send["send"]["status"], "queued");
}

#[test]
fn token_claude_submit_refuses_normalized_partial_and_disguised_slash_commands() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for text in [
        "/model haiku",
        "/MODEL",
        "/Model",
        "/mod",
        "/eff",
        "\u{200b}/model",
        "\u{feff} /MoDeL",
        "/help",
        "/clearer",
        "hello\n\u{2060}/eff",
    ] {
        let id = h.worker(&token, &[]);
        h.await_ready(&token, &id);
        assert!(
            h.call(&token, json!({"op":"agent_prompt","id":id,"text":text}))
                .is_err(),
            "submitted {text:?}"
        );
    }
}
#[test]
fn token_claude_enter_checks_composed_sends_and_embedded_newlines() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for op in ["agent_send", "send_text"] {
        let id = h.worker(&token, &[]);
        h.await_ready(&token, &id);
        for text in ["/mo", "del haiku"] {
            h.call(&token, json!({"op":op,"id":id,"text":text}))
                .unwrap();
        }
        assert!(
            h.call(&token, json!({"op":"send_keys","id":id,"keys":["enter"]}))
                .is_err(),
            "split {op} was submitted"
        );
        let id = h.worker(&token, &[]);
        h.await_ready(&token, &id);
        assert!(
            h.call(&token, json!({"op":op,"id":id,"text":"/mod\n"}))
                .is_err(),
            "newline submitted partial slash command"
        );
    }
}
#[test]
fn token_claude_submit_checks_existing_screen_composer_and_owner_is_unchanged() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-composer-model"]);
    h.await_ready(&token, &id);
    assert!(
        h.call(&token, json!({"op":"agent_keys","id":id,"keys":["enter"]}))
            .is_err(),
        "existing screen composer was submitted"
    );
    let id = h.worker(&token, &[]);
    h.await_ready(&token, &id);
    assert!(
        h.owner(json!({"op":"agent_prompt","id":id,"text":"/model haiku"}))
            .is_ok(),
        "owner authority was narrowed"
    );
}
#[test]
fn token_claude_submit_allows_exact_clear_and_compact_commands() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for text in ["/clear", "/compact summarize", " \u{200b}/ClEaR"] {
        let id = h.worker(&token, &[]);
        h.await_ready(&token, &id);
        assert!(
            h.call(&token, json!({"op":"agent_prompt","id":id,"text":text}))
                .is_ok(),
            "refused allowlisted {text:?}"
        );
    }
}

#[test]
fn quiet_idle_worker_is_not_stale_and_can_be_prompted() {
    let h = Harness::configured(Some(r#"{"stale_after_ms":50}"#));
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &[]);
    h.await_ready(&token, &id);
    // B14 (ticket 991): a worker idle at its prompt stays idle, however long past the stale time it is quiet.
    thread::sleep(Duration::from_millis(500));
    assert_ne!(h.snapshot(&token, &id)["attention"]["stale"], true);
    let get = h.cli(Some(&token), &["agent", "get", &id, "--json"]);
    let data: Value = serde_json::from_slice(&get.stdout).unwrap();
    assert_ne!(data["status"], "blocked");
    let send = h.call(
        &token,
        json!({"op":"agent_prompt","id":id,"text":"wake up"}),
    );
    assert!(send.is_ok(), "stale attention blocked prompt: {send:?}");
}
#[test]
fn background_attention_does_not_refuse_a_prompt_as_blocked() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &[]);
    h.await_ready(&token, &id);
    h.owner(json!({"op":"hook","id":id,"event":"Stop","payload":{"background_tasks":[{"id":"task","status":"running"}]}})).unwrap();
    assert_eq!(h.snapshot(&token, &id)["pending"][0]["kind"], "background");
    let r = h.call(&token, json!({"op":"agent_prompt","id":id,"text":"next"}));
    assert!(r.is_ok(), "background attention blocked prompt: {r:?}");
}

#[test]
fn queued_prompt_returns_its_cancelable_id_instead_of_stalled() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-busy"]);
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, &id)["attention"]["working"] != true {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    // v1a-17: the busy agent holds the prompt queued for good, so returning at all is returning while queued;
    // waiting for it would run into the command's 300 s wait, turned into a failure here.
    let out = h.cli_within(
        Duration::from_secs(30),
        Some(&token),
        &["agent", "prompt", &id, "queued"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(reply["send"]["status"], "queued");
    let send = reply["send"]["id"].as_str().unwrap();
    assert!(
        h.cli(Some(&token), &["agent", "cancel", &id, send])
            .status
            .success()
    );
    assert_eq!(h.snapshot(&token, &id)["send_log"][0]["status"], "canceled");
}
#[test]
fn wait_timeout_reports_still_queued_send_without_an_error() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-busy"]);
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, &id)["attention"]["working"] != true {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let out = h.cli(
        Some(&token),
        &[
            "agent",
            "prompt",
            &id,
            "queued",
            "--wait",
            "--until",
            "done",
            "--timeout",
            "100",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(reply["send"]["status"], "queued");
    assert!(reply["send"]["id"].is_string());
}
#[test]
fn waiting_queued_prompt_does_not_stall_before_delivery() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-busy"]);
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, &id)["attention"]["working"] != true {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    std::thread::scope(|scope| {
        let cli = scope.spawn(|| {
            h.cli(
                Some(&token),
                &[
                    "agent",
                    "prompt",
                    &id,
                    "queued",
                    "--wait",
                    "--until",
                    "working",
                    "--timeout",
                    "10000",
                ],
            )
        });
        thread::sleep(Duration::from_millis(5300));
        let was_waiting = !cli.is_finished();
        h.owner(json!({"op":"hook","id":id,"event":"Stop","payload":{}}))
            .unwrap();
        let out = cli.join().unwrap();
        assert!(was_waiting, "queued CLI stopped before delivery");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            h.snapshot(&token, &id)["send_log"][0]["status"],
            "delivered"
        );
    });
}

impl Harness {
    fn repo(&self) -> PathBuf {
        let repo = self.home.join("managed-repo");
        fs::create_dir(&repo).unwrap();
        for args in [
            vec!["init"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        ] {
            assert!(
                home::git_env::scrubbed("/usr/bin/git")
                    .arg("-C")
                    .arg(&repo)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        repo
    }
    fn create_worktree(&self, repo: &std::path::Path, branch: &str) -> Value {
        let r = self.cli(
            None,
            &[
                "worktree",
                "create",
                "--project",
                repo.to_str().unwrap(),
                "--branch",
                branch,
                "--base",
                "HEAD",
                "--label",
                branch,
                "--no-focus",
            ],
        );
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        let reply: Value = serde_json::from_slice(&r.stdout).unwrap();
        reply["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap()
            .clone()
    }
}
#[test]
fn missing_managed_worktree_removal_preserves_all_git_metadata() {
    let h = Harness::new();
    let repo = h.repo();
    let first = h.create_worktree(&repo, "first");
    let second = h.create_worktree(&repo, "second");
    let path = first["path"].as_str().unwrap();
    fs::remove_dir_all(path).unwrap();
    let r = h.cli(None, &["worktree", "list"]);
    assert!(
        r.status.success(),
        "missing record poisoned list: {}",
        String::from_utf8_lossy(&r.stderr)
    );
    let list: Value = serde_json::from_slice(&r.stdout).unwrap();
    let rows = list["worktrees"].as_array().unwrap();
    assert_eq!(
        rows.iter().find(|w| w["branch"] == "first").unwrap()["missing"],
        true
    );
    assert_eq!(
        rows.iter().find(|w| w["branch"] == "second").unwrap()["missing"],
        false
    );
    let third = h.create_worktree(&repo, "third");
    assert!(
        !h.cli(None, &["worktree", "open", "--path", path])
            .status
            .success()
    );
    let external = h.home.join("user-unmounted");
    assert!(
        home::git_env::scrubbed("/usr/bin/git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "add", "-b", "user-unmounted"])
            .arg(&external)
            .arg("HEAD")
            .output()
            .unwrap()
            .status
            .success()
    );
    fs::remove_dir_all(&external).unwrap();
    let before = home::git_env::scrubbed("/usr/bin/git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap();
    assert!(before.status.success());
    let removed = h.cli(None, &["worktree", "remove", "--path", path]);
    assert!(
        removed.status.success(),
        "missing record could not be removed"
    );
    let r = h.cli(None, &["worktree", "list"]);
    assert!(r.status.success());
    let list: Value = serde_json::from_slice(&r.stdout).unwrap();
    assert_eq!(list["worktrees"].as_array().unwrap().len(), 2);
    for row in [second, third] {
        assert!(
            std::path::Path::new(row["path"].as_str().unwrap())
                .join(".git")
                .exists()
        );
    }
    let git = home::git_env::scrubbed("/usr/bin/git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap();
    assert!(git.status.success());
    assert_eq!(
        git.stdout, before.stdout,
        "missing-path removal pruned Git metadata"
    );
    assert!(String::from_utf8_lossy(&git.stdout).contains(path));
    assert!(String::from_utf8_lossy(&git.stdout).contains(external.to_str().unwrap()));
    assert!(String::from_utf8_lossy(&removed.stderr).contains("git worktree prune"));
    assert!(
        home::git_env::scrubbed("/usr/bin/git")
            .arg("-C")
            .arg(repo)
            .args(["show-ref", "--verify", "refs/heads/first"])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn finished_send_log_rows_rotate_without_rejecting_new_sends() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let row = h
        .call(
            &token,
            json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/cat"]}}),
        )
        .unwrap();
    let id = row["session"]["id"].as_str().unwrap();
    for n in 0..260 {
        assert!(
            h.call(
                &token,
                json!({"op":"agent_send","id":id,"text":format!("message{n}\n")})
            )
            .is_ok(),
            "log refused send {n}"
        );
    }
    let s = h.snapshot(&token, id);
    assert_eq!(s["send_log"].as_array().unwrap().len(), 256);
    assert_eq!(s["send_log"][0]["content"], "message4\n");
    assert_eq!(s["send_log"][255]["content"], "message259\n");
}
#[test]
fn granted_interrupts_reach_working_agents_immediately_and_escape_denies_permission_off() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for key in ["esc", "ctrl+c"] {
        let id = h.worker(&token, &["--fixture-busy"]);
        let until = Instant::now() + Duration::from_secs(30);
        while h.snapshot(&token, &id)["attention"]["working"] != true {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        let send = h
            .call(&token, json!({"op":"agent_keys","id":id,"keys":[key]}))
            .unwrap();
        assert_eq!(send["send"]["status"], "delivered", "{key} was queued");
    }
    let id = h.worker(&token, &["--fixture-permission"]);
    h.pending(&token, &id);
    assert!(
        h.call(&token, json!({"op":"agent_keys","id":id,"keys":["esc"]}))
            .is_ok(),
        "permission-off Esc was refused"
    );
    assert_eq!(
        h.snapshot(&token, &id)["send_log"][0]["status"],
        "delivered"
    );
}

// v1a-17: held by the shim's gate rather than timed, so host load cannot fail it.
#[cfg(target_os = "macos")]
#[test]
fn slow_cli_transcript_read_does_not_hold_the_sessions_mutex() {
    let shim = hold::Shim::build(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/agent-cli/slow-transcript.c"),
    );
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command.env("DYLD_INSERT_LIBRARIES", &shim.dylib);
    let h = Harness::command(None, command);
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-transcript"]);
    h.await_ready(&token, &id);
    std::thread::scope(|scope| {
        let held = hold::Hold::new(h.home.join("pause-read"), "");
        let read = scope.spawn(|| {
            h.cli(
                Some(&token),
                &["agent", "read", &id, "--source", "transcript"],
            )
        });
        hold::reached(&h.home.join("read-entered"), "I/O barrier was not reached");
        // The read is parked in its transcript I/O; a sessions mutex it held would keep this waiting out the hold.
        let snapshot = h.owner(json!({"op":"snapshot"}));
        assert!(snapshot.is_ok(), "{snapshot:?}");
        assert!(
            !h.home.join("read-released").exists(),
            "the transcript read must still be held"
        );
        held.release();
        let result = read.join().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    });
}
#[test]
fn vanished_transcript_returns_the_promised_explicit_message() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-transcript"]);
    h.await_ready(&token, &id);
    let session = h.snapshot(&token, &id);
    let slug: String = h
        .home
        .to_str()
        .unwrap()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let path = h.home.join("claude-data/projects").join(slug).join(format!(
        "{}.jsonl",
        session["agent_session_id"].as_str().unwrap()
    ));
    fs::remove_file(path).unwrap();
    let out = h.cli(
        Some(&token),
        &["agent", "read", &id, "--source", "transcript"],
    );
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("transcript source unavailable"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn unreplayable_journal_quarantine_prunes_are_counted_in_recovery_warnings() {
    use nunchiro_core::queue::journal;
    let h = Harness::new();
    let _ = h.start();
    assert!(h.cli(None, &["serve", "stop"]).status.success());
    let until = Instant::now() + Duration::from_secs(3);
    while h.home.join("core.sock").exists() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let quarantine = h.home.join("hook-journal-quarantine");
    fs::create_dir(&quarantine).unwrap();
    for n in 0..journal::QUARANTINE_MAX_FILES {
        fs::write(quarantine.join(format!("old-{n}.json")), "old evidence").unwrap();
    }
    journal::write(
        &h.home,
        &journal::Event::new(
            "unknown-session".into(),
            "PermissionRequest".into(),
            json!({"tool_name":"Bash"}),
        )
        .unwrap(),
    )
    .unwrap();
    let out = h.cli(None, &["snapshot", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let data: Value = serde_json::from_slice(&out.stdout).unwrap();
    let warning = data["sessions"][0]["attention"]["observer_error"]
        .as_str()
        .unwrap();
    assert!(
        warning.contains("2 recovery events"),
        "prune omitted from recovery warnings: {warning}"
    );
    assert_eq!(
        fs::read_dir(quarantine).unwrap().count(),
        journal::QUARANTINE_MAX_FILES
    );
}

#[test]
fn cli_right_after_serve_stop_waits_for_the_old_core_lock() {
    let h = Harness::new();
    assert!(h.cli(None, &["serve", "stop"]).status.success());
    // v1a-66: a stopping core removes core.sock before it exits and frees core.lock; hold the lock for that gap.
    let lock = fs::File::open(h.home.join("core.lock")).unwrap();
    lock.lock().unwrap();
    assert!(!h.home.join("core.sock").exists());
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        drop(lock);
    });
    let out = h.cli(None, &["session", "list"]);
    release.join().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A request that connects while the core winds down after a stop is answered (NOT_SERVED_QUIT, a full stop) or
/// refused at connect, never accepted and closed without a reply (`call` panics on that). A silent peer the core
/// already serves holds the wind-down open for its 2 s read, so the NOT_SERVED_QUIT path runs.
#[test]
fn a_request_right_after_stop_is_answered_or_refused() {
    let h = Harness::new();
    let _served = UnixStream::connect(h.home.join("core.sock")).unwrap();
    thread::sleep(Duration::from_millis(200));
    h.owner(json!({"op":"stop"})).unwrap();
    let mut answered = 0;
    for _ in 0..20 {
        match h.owner(json!({"op":"list"})) {
            Err(e) if e == nunchiro_core::server::NOT_SERVED_QUIT => answered += 1,
            // The accept loop can take one more connect while the stop holds the registry lock; it is not served.
            // A connect queued on the registry lock behind the stop gets NOT_SERVED_QUIT too, never the bare
            // "core is stopping" (ticket 305).
            Err(e) => assert!(e.contains("refused") || e.contains("No such file"), "{e}"),
            Ok(r) => panic!("served after stop: {r}"),
        }
    }
    assert!(answered > 0, "no request reached the stopping core");
}

/// Refused connects never hold a stopping core open: it exits soon after `stop` while peers keep connecting and stay
/// silent. Harness::drop kills after 5 s, which would hide a hang, so the exit is asserted here.
#[test]
fn core_exits_soon_after_stop_while_peers_connect_and_stay_silent() {
    let mut h = Harness::new();
    let sock = h.home.join("core.sock");
    h.owner(json!({"op":"stop"})).unwrap();
    let flooding = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flood = {
        let flooding = flooding.clone();
        thread::spawn(move || {
            let (mut held, until) = (Vec::new(), Instant::now() + Duration::from_secs(15));
            while flooding.load(std::sync::atomic::Ordering::SeqCst) && Instant::now() < until {
                if let Ok(s) = UnixStream::connect(&sock) {
                    held.push(s);
                }
                thread::sleep(Duration::from_millis(20));
            }
        })
    };
    let (began, mut exited) = (Instant::now(), None);
    while exited.is_none() && began.elapsed() < Duration::from_secs(10) {
        exited = h.core.try_wait().unwrap();
        thread::sleep(Duration::from_millis(20));
    }
    flooding.store(false, std::sync::atomic::Ordering::SeqCst);
    flood.join().unwrap();
    assert!(
        exited.is_some(),
        "core still running {:?} after stop",
        began.elapsed()
    );
}

impl Harness {
    /// v1a-66 (ticket 305): winds the core down with `op` ("exit" or "stop") while a silent peer it already serves holds
    /// the wind-down open for its 2 s read, then runs `args`. The stopping core's log line shows the CLI's request
    /// reached the wind-down (a CLI that started after the old core was gone would pass the served checks on its own).
    fn cli_during_wind_down(&self, op: &str, args: &[&str]) -> std::process::Output {
        let log = self.home.join("logs").join("core.log");
        let refused = || {
            fs::read_to_string(&log)
                .unwrap_or_default()
                .matches(nunchiro_core::server::NOT_SERVED_LOG)
                .count()
        };
        let before = refused();
        let _served = UnixStream::connect(self.home.join("core.sock")).unwrap();
        thread::sleep(Duration::from_millis(200));
        self.owner(json!({ "op": op })).unwrap();
        let out = self.cli_within(Duration::from_secs(30), None, args);
        assert!(
            refused() > before,
            "{args:?}: the request never reached the {op} wind-down ({})",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }
    /// An `exit` (or signal) wind-down leaves the agents for a next core: the CLI does not fail with NOT_SERVED, it
    /// waits for the old core to go and the next core serves it. Returns the output for the surface's own checks.
    fn cli_during_exit_wind_down(&self, args: &[&str]) -> std::process::Output {
        let out = self.cli_during_wind_down("exit", args);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !stderr.contains(nunchiro_core::server::NOT_SERVED),
            "{args:?}: {stderr}"
        );
        assert!(
            UnixStream::connect(self.home.join("core.sock")).is_ok(),
            "{args:?}: no next core ({stderr})"
        );
        out
    }
    fn served_by_next_core(&self, args: &[&str]) {
        let out = self.cli_during_exit_wind_down(args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    /// No core runs in this home: the first one has exited and nothing holds core.lock.
    fn assert_no_core(&mut self, what: &str) {
        let until = Instant::now() + Duration::from_secs(10);
        while self.core.try_wait().unwrap().is_none() {
            assert!(Instant::now() < until, "{what}: the old core never exited");
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(500)); // a detached next core would have taken the lock by now
        let lock = fs::File::open(self.home.join("core.lock")).unwrap();
        assert!(
            lock.try_lock().is_ok(),
            "{what}: a next core holds core.lock"
        );
        assert!(UnixStream::connect(self.home.join("core.sock")).is_err());
    }
}
/// An owner's Stop sticks: a CLI request that lands in its wind-down fails at once with NOT_SERVED_QUIT and starts no
/// next core.
#[test]
fn cli_during_a_stop_wind_down_fails_and_starts_no_core() {
    let mut h = Harness::new();
    let out = h.cli_during_wind_down("stop", &["session", "list"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "served after stop");
    assert!(
        stderr.contains(nunchiro_core::server::NOT_SERVED_QUIT),
        "{stderr}"
    );
    h.assert_no_core("CLI after stop");
}
#[test]
fn cli_during_an_exit_wind_down_runs_on_the_next_core() {
    Harness::new().served_by_next_core(&["session", "list"]);
}
#[test]
fn agent_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    Harness::new().served_by_next_core(&["agent", "list"]);
}
#[test]
fn machine_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    Harness::new().served_by_next_core(&["machine", "status"]);
}
#[test]
fn widget_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    let h = Harness::new();
    assert!(h.cli(None, &["widget", "new", "w"]).status.success());
    h.served_by_next_core(&["widget", "allow", "w", "--read"]);
}
#[test]
fn board_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    Harness::new().served_by_next_core(&["board", "list"]);
}
#[test]
fn worktree_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    let h = Harness::new();
    let project = h.home.to_str().unwrap().to_string();
    h.served_by_next_core(&["worktree", "list", "--project", &project]);
}
/// Browser and layout need a session and an open window, which the harness has none of: the next core's own refusal
/// shows it got the request.
#[test]
fn browser_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    let out = Harness::new().cli_during_exit_wind_down(&["browser", "tabs"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("browser verbs run from inside an agent session"),
        "{stderr}"
    );
}
#[test]
fn layout_cli_during_an_exit_wind_down_runs_on_the_next_core() {
    let out = Harness::new().cli_during_exit_wind_down(&["layout", "reset"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no Nunchiro window is open"), "{stderr}");
}
/// The SSH relay makes one attempt: the calling core's SSH call gives up after 6 s (machines.rs), so a relay still
/// waiting for a next core would deliver the request after the caller has retried it, and it would run twice. The
/// NOT_SERVED reply goes back to the caller (whose own `call` retries), and the relay starts no core.
#[test]
fn relay_during_an_exit_wind_down_answers_not_served_once() {
    let mut h = Harness::new();
    let _served = UnixStream::connect(h.home.join("core.sock")).unwrap();
    thread::sleep(Duration::from_millis(200));
    h.owner(json!({"op":"exit"})).unwrap();
    let mut relay = h
        .cli_command(None, &["machine", "relay"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let request = json!({"protocol": nunchiro_core::machines::PROTOCOL, "request": {"op":"list"}});
    relay
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let out = relay.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains(nunchiro_core::server::NOT_SERVED),
        "{stdout} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    h.assert_no_core("relay during exit");
}
/// `agent wait` on a session that is no longer running (here a shell that exited; after a restart, a Resumable one)
/// ends at once with a clear error instead of polling to its 300 s timeout.
#[test]
fn agent_wait_on_an_ended_session_ends_at_once() {
    let h = Harness::new();
    let id = h.owner(json!({"op":"start","session":{"kind":"shell","project":h.home,"args":["/bin/sh","-c","exit 0"]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let r = h.owner(json!({"op":"snapshot"})).unwrap();
        let row = r["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .cloned();
        if row.is_some_and(|s| s["state"] != "running") {
            break;
        }
        assert!(Instant::now() < until, "shell never ended");
        thread::sleep(Duration::from_millis(50));
    }
    let out = h.cli_within(Duration::from_secs(10), None, &["agent", "wait", &id]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success());
    assert!(stderr.contains("agent_ended"), "{stderr}");
}

/// w73 (after ticket 1016): Claude exited with code 3 and left its shell. `agent get` and `agent list` say failed, as
/// `session list` does; a wait for done (or idle) ends at once with `agent_ended`, and a wait for failed returns it.
#[test]
fn a_failed_agent_reads_failed_in_agent_list_and_ends_a_done_wait() {
    let h = Harness::new();
    let id = h.owner(json!({"op":"start","session":{"kind":"claude","project":h.home,"args":["--fixture-fail"]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let get = || {
        let out = h.cli_within(
            Duration::from_secs(10),
            None,
            &["agent", "get", &id, "--json"],
        );
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    let until = Instant::now() + Duration::from_secs(10);
    while get()["status"] != "failed" {
        assert!(Instant::now() < until, "never failed: {}", get());
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(get()["state"], "running", "the shell it left still runs");
    let list = h.cli_within(Duration::from_secs(10), None, &["agent", "list"]);
    let list = String::from_utf8_lossy(&list.stdout);
    assert!(list.contains(&format!("{id}\t\tfailed\t-")), "{list}");
    let out = h.cli_within(
        Duration::from_secs(10),
        None,
        &["agent", "wait", &id, "--until", "done", "--until", "idle"],
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success());
    assert!(
        stderr.contains(&format!("agent_ended: {id} is failed, not running")),
        "{stderr}"
    );
    let out = h.cli_within(
        Duration::from_secs(10),
        None,
        &["agent", "wait", &id, "--until", "failed"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["status"],
        "failed"
    );
}

#[test]
fn active_send_queue_can_exceed_history_limit_and_still_admit_interrupts() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-busy"]);
    let until = Instant::now() + Duration::from_secs(3);
    while h.snapshot(&token, &id)["attention"]["working"] != true {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
    let mut first = String::new();
    for n in 0..260 {
        let send = h.call(
            &token,
            json!({"op":"agent_prompt","id":id,"text":format!("queued{n}")}),
        );
        assert!(send.is_ok(), "active queue refused send {n}: {send:?}");
        if n == 0 {
            first = send.unwrap()["send"]["id"].as_str().unwrap().into();
        }
    }
    let s = h.snapshot(&token, &id);
    assert!(s["send_log"].as_array().unwrap().len() <= 256);
    assert_eq!(s["send_queue"].as_array().unwrap().len(), 260);
    assert!(
        h.cli(Some(&token), &["agent", "cancel", &id, &first])
            .status
            .success()
    );
    let interrupt = h
        .call(&token, json!({"op":"agent_keys","id":id,"keys":["ctrl+c"]}))
        .unwrap();
    assert_eq!(interrupt["send"]["status"], "delivered");
    // v1a-80c: the exit cancels the 259 queued sends on a later tick, and a Stop that arrives mid-cleanup waits for it
    // under the registry lock (0.1 s to over 15 s with load, past the CLI's stop deadline, and it holds a snapshot just as long). Restart once it is done.
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        let all = h
            .call_within(Duration::from_secs(60), &token, json!({"op":"snapshot"}))
            .unwrap();
        let queued = all["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()["send_queue"]
            .as_array()
            .unwrap()
            .len();
        if queued == 0 {
            break;
        }
        assert!(Instant::now() < until, "exit did not cancel the queue");
        thread::sleep(Duration::from_millis(50));
    }
    let restarted = h.cli(None, &["serve", "restart"]);
    assert!(
        restarted.status.success(),
        "{}",
        String::from_utf8_lossy(&restarted.stderr)
    );
    let snapshot = h.owner(json!({"op":"snapshot"})).unwrap();
    let worker = snapshot["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap();
    assert!(worker["send_queue"].as_array().unwrap().is_empty());
    assert_eq!(worker["send_log"].as_array().unwrap().len(), 256);
    assert!(
        worker["send_log"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| !matches!(s["status"].as_str(), Some("queued" | "attempting")))
    );
}
#[test]
fn interrupts_cannot_erase_tracked_unsafe_text_when_composer_is_unreadable() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for key in ["esc", "ctrl+c"] {
        let id = h.worker(&token, &["--fixture-keep-composer"]);
        h.await_ready(&token, &id);
        h.call(&token, json!({"op":"agent_send","id":id,"text":"/mo"}))
            .unwrap();
        h.call(&token, json!({"op":"agent_keys","id":id,"keys":[key]}))
            .unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            let r = h
                .call(
                    &token,
                    json!({"op":"agent_read","id":id,"source":"screen","lines":50}),
                )
                .unwrap();
            if r["text"].as_str().unwrap().contains("Loading...") {
                break;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        for event in ["UserPromptSubmit", "Stop"] {
            h.owner(json!({"op":"hook","id":id,"event":event,"payload":{}}))
                .unwrap();
        }
        h.call(
            &token,
            json!({"op":"agent_send","id":id,"text":"del haiku"}),
        )
        .unwrap();
        assert!(
            h.call(&token, json!({"op":"agent_keys","id":id,"keys":["enter"]}))
                .is_err(),
            "{key} lost the tracked slash prefix"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn serve_restart_waits_for_the_old_core_lock_after_socket_removal() {
    // v1a-17: the shim's folder goes with its drop guard, also when the test fails.
    let shim = hold::Shim::build(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent-cli/slow-stop.c"),
    );
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command.env("DYLD_INSERT_LIBRARIES", &shim.dylib);
    let h = Harness::command(None, command);
    let old_token = fs::read(h.home.join("core.token")).unwrap();
    fs::write(h.home.join("pause-stop"), "").unwrap();
    thread::scope(|scope| {
        let restart = scope.spawn(|| h.cli(None, &["serve", "restart"]));
        let until = Instant::now() + Duration::from_secs(5);
        while !h.home.join("stop-entered").exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        let entered = h.home.join("stop-entered").exists();
        thread::sleep(Duration::from_millis(300));
        let waited = !restart.is_finished();
        fs::remove_file(h.home.join("pause-stop")).unwrap();
        let result = restart.join().unwrap();
        assert!(entered, "shutdown barrier not reached");
        assert!(
            waited,
            "restart finished while old core still held its lifetime lock: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    });
    assert_ne!(fs::read(h.home.join("core.token")).unwrap(), old_token);
    assert!(h.owner(json!({"op":"snapshot"})).is_ok());
}

#[test]
fn owner_raw_claude_writes_require_owner_reset_before_token_submission() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for raw in [
        json!({"op":"send_text","text":"/model haiku"}),
        json!({"op":"send_keys","keys":["up"]}),
    ] {
        let id = h.worker(&token, &[]);
        h.await_ready(&token, &id);
        let mut raw = raw;
        raw["id"] = json!(id);
        h.owner(raw).unwrap();
        let result = h.call(&token, json!({"op":"agent_keys","id":id,"keys":["enter"]}));
        assert!(
            result
                .as_ref()
                .is_err_and(|e| e.contains("cannot verify edited Claude composer")),
            "owner raw input escaped tracking: {result:?}"
        );
        h.owner(json!({"op":"agent_prompt","id":id,"text":"owner replacement"}))
            .unwrap();
    }
}

#[test]
fn ctrl_c_then_restart_repeatedly_reaps_the_exiting_pty_group() {
    let h = Harness::new();
    for round in 0..8 {
        let c = h.start();
        let token = h.token(c["id"].as_str().unwrap());
        let id = h.worker(&token, &[]);
        assert_eq!(h.snapshot(&token, &id)["agent_version"], "99.0.0 fixture");
        h.await_ready(&token, &id);
        h.call(&token, json!({"op":"agent_keys","id":id,"keys":["ctrl+c"]}))
            .unwrap();
        let restarted = h.cli(None, &["serve", "restart"]);
        assert!(
            restarted.status.success(),
            "round {round}: {}",
            String::from_utf8_lossy(&restarted.stderr)
        );
        assert!(h.owner(json!({"op":"snapshot"})).is_ok());
    }
}

#[test]
fn owner_window_keystroke_submission_reenables_token_prompts() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    for enter in [
        json!({"op":"send_text","text":"\r"}),
        json!({"op":"send_keys","keys":["enter"]}),
    ] {
        let id = h.worker(&token, &[]);
        h.await_ready(&token, &id);
        for text in ["h", "i"] {
            h.owner(json!({"op":"send_text","id":id,"text":text}))
                .unwrap();
        }
        let mut enter = enter;
        enter["id"] = json!(id);
        h.owner(enter).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        while h.snapshot(&token, &id)["completion_seq"].as_u64().unwrap() == 0 {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
        let sent = h.call(
            &token,
            json!({"op":"agent_prompt","id":id,"text":"next task"}),
        );
        assert!(
            sent.is_ok(),
            "submitted owner line kept token composer locked: {sent:?}"
        );
        assert_eq!(sent.unwrap()["send"]["status"], "delivered");
    }
}

#[test]
fn restart_reports_when_a_stopped_core_does_not_answer_stop() {
    let h = Harness::new();
    let pid = h.core.id().to_string();
    // v1a-17: a failing test resumes the core too, so the harness can still stop it.
    struct Resume<'a>(&'a str);
    impl Drop for Resume<'_> {
        fn drop(&mut self) {
            let _ = Command::new("/bin/kill").args(["-CONT", self.0]).status();
        }
    }
    let _resume = Resume(&pid);
    assert!(
        Command::new("/bin/kill")
            .args(["-STOP", &pid])
            .status()
            .unwrap()
            .success()
    );
    // v1a-17: the stopped core is the gate. The command gives up after its 15 s socket read; the deadline only
    // turns a restart that hangs on the core into a failure.
    let result = h.cli_within(Duration::from_secs(60), None, &["serve", "restart"]);
    assert!(
        Command::new("/bin/kill")
            .args(["-CONT", &pid])
            .status()
            .unwrap()
            .success()
    );
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("core did not answer stop"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

// v1a-07b: `nunchiro layout` is the owner's; a session token never reaches the window's layout.
#[test]
fn layout_commands_are_owner_only() {
    let h = Harness::new();
    let coordinator = h.start();
    let token = h.token(coordinator["id"].as_str().unwrap());
    let r = json!({"op":"layout","args":["remove","waiting"]});
    // v1a-23 flip: a session token reaches the layout forwarder like the owner (was "operation not granted").
    assert!(
        h.call(&token, r.clone())
            .unwrap_err()
            .contains("no Nunchiro window is open")
    );
    assert!(h.call("forged", r.clone()).is_err());
    // The owner gets through to the forwarder, which needs an open window.
    assert!(
        h.owner(r)
            .unwrap_err()
            .contains("no Nunchiro window is open")
    );
}

// v1a-16: a token coordinator may start workers in worktrees it created.
impl Harness {
    fn printing_token(project: &std::path::Path) -> Value {
        json!({"kind":"shell","project":project,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]})
    }
    fn coordinator_in(&self, project: &std::path::Path) -> (String, String) {
        let id = self
            .owner(json!({"op":"start","session":Self::printing_token(project)}))
            .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let token = self.token(&id);
        (id, token)
    }
    fn worktree_as(&self, token: Option<&str>, repo: &std::path::Path, branch: &str) -> PathBuf {
        let r = self.cli(
            token,
            &[
                "worktree",
                "create",
                "--project",
                repo.to_str().unwrap(),
                "--branch",
                branch,
                "--base",
                "HEAD",
                "--no-focus",
            ],
        );
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        let reply: Value = serde_json::from_slice(&r.stdout).unwrap();
        let w = reply["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["branch"] == branch)
            .unwrap();
        PathBuf::from(w["path"].as_str().unwrap())
    }
    fn start_at(&self, token: &str, project: &std::path::Path) -> Result<Value, String> {
        self.call(
            token,
            json!({"op":"start","session":Self::printing_token(project)}),
        )
        .map(|r| r["session"].clone())
    }
}
/// Ticket 991 A2, after one Codex look: a session that removes a worktree closes its own ended sessions there, as it
/// could with `close`; an ended session it did not start stays the owner's row.
#[test]
fn a_callers_remove_closes_only_the_ended_sessions_it_started() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let ended = |token: Option<&str>| {
        let request = json!({"op":"start","session":{"kind":"shell","project":path,"args":["/usr/bin/true"],"label":"done","worktree":false}});
        let r = match token {
            Some(t) => h.call(t, request),
            None => h.owner(request),
        }
        .unwrap();
        r["session"]["id"].as_str().unwrap().to_string()
    };
    let (mine, theirs) = (ended(Some(&token)), ended(None));
    let state = |id: &str| {
        h.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .map(|s| s["state"].as_str().unwrap().to_string())
    };
    let until = Instant::now() + Duration::from_secs(10);
    while [&mine, &theirs]
        .iter()
        .any(|id| state(id).as_deref() == Some("running"))
    {
        assert!(Instant::now() < until, "the shells never ended");
        thread::sleep(Duration::from_millis(50));
    }
    let removed = h.cli(
        Some(&token),
        &["worktree", "remove", "--path", path.to_str().unwrap()],
    );
    assert!(
        removed.status.success(),
        "{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    assert_eq!(
        state(&mine),
        None,
        "the caller's own ended session closed with the worktree"
    );
    assert!(
        state(&theirs).is_some(),
        "the owner's ended session is not the caller's to close"
    );
}
// v1a-23 flip: session callers start in any folder, so each former refusal is a start now (was
// `unwrap_err() == "outside session grants"`).
fn granted(r: Result<Value, String>) {
    assert!(r.is_ok(), "{r:?}");
}

#[test]
fn coordinator_creates_worktree_and_starts_worker_there() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let base = String::from_utf8(
        home::git_env::scrubbed("git")
            .arg("-C")
            .arg(&repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let r = h.cli(
        Some(&token),
        &[
            "worktree",
            "create",
            "--project",
            repo.to_str().unwrap(),
            "--branch",
            "b",
            "--base",
            base.trim(),
            "--no-focus",
        ],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let data: Value = serde_json::from_slice(&r.stdout).unwrap();
    let path = data["worktrees"][0]["path"].as_str().unwrap();
    let start = h.cli(
        Some(&token),
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "claude",
            "--project",
            path,
        ],
    );
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let worker: Value = serde_json::from_slice(&start.stdout).unwrap();
    // Ticket 990: the worker runs in the worktree and belongs to the worktree's project.
    assert_eq!(worker["session"]["cwd"], path);
    assert_eq!(
        worker["session"]["project"],
        data["worktrees"][0]["project"]
    );
    let id = worker["session"]["id"].as_str().unwrap();
    h.await_ready(&token, id);
    for args in [
        vec![
            "agent", "prompt", "worker", "hello", "--wait", "--until", "done",
        ],
        vec![
            "agent", "read", "worker", "--lines", "20", "--source", "screen",
        ],
        vec!["agent", "get", "worker", "--json"],
        vec![
            "agent",
            "wait",
            "worker",
            "--until",
            "idle",
            "--timeout",
            "500",
        ],
        vec!["session", "close", id],
    ] {
        let r = h.cli(Some(&token), &args);
        assert!(
            r.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&r.stderr)
        );
        if args[1] == "read" {
            assert!(String::from_utf8_lossy(&r.stdout).contains("ACK:hello"));
        }
    }
}

#[test]
fn created_worktree_is_on_branch_at_base_and_listed() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let git = |dir: &std::path::Path, args: &[&str]| {
        String::from_utf8(
            home::git_env::scrubbed("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string()
    };
    assert_eq!(git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]), "b");
    assert_eq!(
        git(&path, &["rev-parse", "HEAD"]),
        git(&repo, &["rev-parse", "HEAD"])
    );
    let list = h.cli(
        Some(&token),
        &["worktree", "list", "--project", repo.to_str().unwrap()],
    );
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    assert!(String::from_utf8_lossy(&list.stdout).contains(path.to_str().unwrap()));
}

#[test]
fn sibling_coordinator_cannot_start_in_anothers_worktree() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let (_, sibling) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    granted(h.start_at(&sibling, &path));
    assert!(h.start_at(&token, &path).is_ok());
}

#[test]
fn owner_created_worktree_is_not_granted_to_a_token_caller() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(None, &repo, "owner");
    granted(h.start_at(&token, &path));
}

#[test]
fn subfolder_of_granted_worktree_is_refused() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    fs::create_dir(path.join("sub")).unwrap();
    granted(h.start_at(&token, &path.join("sub")));
}

#[test]
fn symlink_to_ungranted_path_is_refused() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    h.worktree_as(Some(&token), &repo, "b");
    let other = h.worktree_as(None, &repo, "owner");
    let link = h.home.join("link");
    std::os::unix::fs::symlink(&other, &link).unwrap();
    granted(h.start_at(&token, &link));
}

#[test]
fn symlink_to_the_granted_path_resolves_to_it_only() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let link = h.home.join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    let worker = h.start_at(&token, &link).unwrap();
    assert_eq!(PathBuf::from(worker["cwd"].as_str().unwrap()), path); // ticket 990: its project is the repo
    granted(h.start_at(&token, &link.join("..")));
}

#[test]
fn removed_worktree_grant_is_gone() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let r = h.cli(
        Some(&token),
        &["worktree", "remove", "--path", path.to_str().unwrap()],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    fs::create_dir(&path).unwrap();
    granted(h.start_at(&token, &path));
}

// V2-1b: the coordinator session survives `serve restart` (its token keeps working) and its token is refused once the
// session is closed.
#[test]
fn coordinator_token_survives_serve_restart_and_lapses_on_close() {
    let h = Harness::new();
    let repo = h.repo();
    let (coordinator, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    assert!(h.cli(None, &["serve", "restart"]).status.success());
    // V2-1b (needs 76): the coordinator session survives the restart, so its token still starts (local session
    // callers are not held to grants, v1a-23); a closed session's token is refused (holder.rs core_kill9 test).
    granted(h.start_at(&token, &path));
    let (_, fresh) = h.coordinator_in(&repo);
    granted(h.start_at(&fresh, &path));
    let list = h.cli(
        None,
        &["worktree", "list", "--project", repo.to_str().unwrap()],
    );
    assert!(String::from_utf8_lossy(&list.stdout).contains(path.to_str().unwrap()));
    h.owner(json!({"op":"close","id":coordinator})).unwrap();
    assert_eq!(h.start_at(&token, &path).unwrap_err(), "unauthorized");
    assert!(h.cli(None, &["serve", "stop"]).status.success());
}

#[test]
fn worker_in_worktree_cannot_start_outside_it() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let sibling = h.worktree_as(Some(&token), &repo, "c");
    let worker = h.start_at(&token, &path).unwrap();
    let worker_token = h.token(worker["id"].as_str().unwrap());
    granted(h.start_at(&worker_token, &repo));
    granted(h.start_at(&worker_token, &sibling));
    let r = h.cli(
        Some(&worker_token),
        &[
            "worktree",
            "create",
            "--project",
            repo.to_str().unwrap(),
            "--branch",
            "d",
            "--no-focus",
        ],
    );
    // v1a-23 flip: worktrees on any project (was refused with "outside session grants").
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert!(!String::from_utf8_lossy(&r.stderr).contains("outside session grants"));
    assert!(h.start_at(&worker_token, &path).is_ok());
}

#[test]
fn worker_in_worktree_cannot_reach_coordinators_other_workers() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let first = h.worktree_as(Some(&token), &repo, "b");
    let second = h.worktree_as(Some(&token), &repo, "c");
    let w1 = h.start_at(&token, &first).unwrap();
    let w2 = h.start_at(&token, &second).unwrap();
    let w3 = h.start_at(&token, &repo).unwrap();
    let t1 = h.token(w1["id"].as_str().unwrap());
    for target in [&w2["id"], &w3["id"]] {
        for op in ["agent_prompt", "agent_get", "read"] {
            // v1a-23 flip: reachable now (was is_err for each op).
            assert_ne!(
                h.call(&t1, json!({"op":op,"id":target,"text":"x"}))
                    .err()
                    .as_deref(),
                Some("outside session grants"),
                "{op}"
            );
        }
        // Ticket 286 r6: a sibling worker is the coordinator's to close, not this worker's.
        assert_eq!(
            h.call(&t1, json!({"op":"close","id":target}))
                .err()
                .as_deref(),
            Some("a session closes only itself and the sessions it started")
        );
    }
    let snapshot = h.call(&t1, json!({"op":"snapshot"})).unwrap();
    // v1a-23 flip: every session is listed (was empty).
    assert!(!snapshot["sessions"].as_array().unwrap().is_empty());
    for w in [&w1, &w2, &w3] {
        assert!(
            h.call(&token, json!({"op":"agent_get","id":w["id"]}))
                .is_ok()
        );
    }
}

#[test]
fn missing_path_dir_is_refused() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    fs::remove_dir_all(&path).unwrap();
    assert!(h.start_at(&token, &path).is_err());
    let list = h.cli(
        Some(&token),
        &["worktree", "list", "--project", repo.to_str().unwrap()],
    );
    let list: Value = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(list["worktrees"][0]["missing"], true, "{list}");
}

#[test]
fn worktree_store_creator_field_loads_and_unknown_fields_are_refused() {
    let h = Harness::new();
    let file = h.home.join("worktrees.json");
    let w = json!({"project":h.home,"path":h.home.join("worktrees/fixture"),"branch":"worker","label":"worker"});
    let mut with_creator = w.clone();
    with_creator["creator"] = json!("session-1");
    let mut unknown = w.clone();
    unknown["owner"] = json!("session-1");
    for (store, ok) in [
        (json!({"version":1,"worktrees":[w]}), true),
        (json!({"version":1,"worktrees":[with_creator]}), true),
        (json!({"version":1,"worktrees":[unknown]}), false),
    ] {
        let bytes = serde_json::to_vec(&store).unwrap();
        fs::write(&file, &bytes).unwrap();
        let r = h.cli(None, &["worktree", "list"]);
        assert_eq!(
            r.status.success(),
            ok,
            "{store}: {}",
            String::from_utf8_lossy(&r.stderr)
        );
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
}

// v1a-21: the test holds the worktree flock itself; the socket read timeout only turns a hang into a failure.
#[test]
fn start_while_another_worktree_create_runs_waits_or_says_busy() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let gate = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(h.home.join("worktrees.lock"))
        .unwrap();
    gate.lock().unwrap();
    // v1a-23 flip: a local start no longer reads the worktree store, so the held lock does not stop it (was busy).
    let held = h.start_at(&token, &path);
    assert!(held.is_ok(), "{held:?}");
    let mut s = UnixStream::connect(h.home.join("core.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    writeln!(
        s,
        "{}",
        json!({"token": token, "request": {"op":"start","session":Harness::printing_token(&path)}})
    )
    .unwrap();
    gate.unlock().unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    let released: Result<Value, String> = serde_json::from_str(&line).unwrap();
    match released {
        Ok(_) => {}
        Err(e) => assert!(e.contains("worktree operation in progress"), "{e}"),
    }
    assert!(h.start_at(&token, &path).is_ok());
}

// v1a-22: the token start retries the busy flock for 500 ms without holding the session registry.
#[test]
fn owner_request_is_not_held_up_by_a_start_waiting_on_the_worktree_lock() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, token) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&token), &repo, "b");
    let gate = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(h.home.join("worktrees.lock"))
        .unwrap();
    // An owner snapshot sent 100 ms into a start: it waits for the start's own work under the registry (spawning the
    // agent, its save), so it is timed against the same start with the gate free, in the same rounds and so under the
    // same load. W27: idle medians made the bound (178 us), and a start's spawn under build load held the snapshot
    // 880 ms at best of 5 with nothing wrong. A start that waits on the held gate while it holds the registry (the
    // 500 ms retry v1a-22 removed) adds that wait to every gated attempt, and one that waits for good never answers
    // (the reply fuse panics). The smallest of five attempts each way drops a scheduler stall in one (v1a-88).
    let attempt = || {
        let mut s = UnixStream::connect(h.home.join("core.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(
            s,
            "{}",
            json!({"token": token, "request": {"op":"start","session":Harness::printing_token(&path)}})
        )
        .unwrap();
        thread::sleep(Duration::from_millis(100));
        let asked = Instant::now();
        assert!(h.owner(json!({"op":"snapshot"})).is_ok());
        let took = asked.elapsed();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        let started: Result<Value, String> = serde_json::from_str(&line).unwrap();
        // v1a-23 flip: the start does not wait on the worktree lock at all now (was the busy error after 500 ms).
        assert!(started.is_ok(), "{started:?}");
        took
    };
    let (mut free, mut held) = (Duration::MAX, Duration::MAX);
    for _ in 0..5 {
        free = free.min(attempt());
        gate.lock().unwrap();
        held = held.min(attempt());
        gate.unlock().unwrap();
    }
    // Under the 500 ms retry the snapshot waited 400 ms more than the start's own work.
    let bound = free + Duration::from_millis(250);
    assert!(
        held < bound,
        "owner snapshot took {held:?} at best of 5 with the worktree lock held, {free:?} with it free"
    );
}

#[test]
fn sibling_coordinator_cannot_remove_anothers_idle_worktree() {
    let h = Harness::new();
    let repo = h.repo();
    let (_, a) = h.coordinator_in(&repo);
    let (_, b) = h.coordinator_in(&repo);
    let path = h.worktree_as(Some(&a), &repo, "b");
    let owned = h.worktree_as(None, &repo, "owner");
    // v1a-23 flip (the v1a-21 creator rule is gone): a sibling opens and removes another's idle worktree and the
    // owner's (was: both refused "outside grants", store unchanged). The opened session is closed before the remove,
    // and both worktrees are created again for the rest of the test.
    for (token, target) in [(&b, &path), (&a, &owned)] {
        let store = fs::read(h.home.join("worktrees.json")).unwrap();
        for op in ["open", "remove"] {
            let r = h.cli(
                Some(token),
                &[
                    "worktree",
                    op,
                    "--path",
                    target.to_str().unwrap(),
                    "--no-focus",
                ],
            );
            assert!(
                r.status.success(),
                "{op}: {}",
                String::from_utf8_lossy(&r.stderr)
            );
            assert!(
                !String::from_utf8_lossy(&r.stderr).contains("outside grants"),
                "{op}: {}",
                String::from_utf8_lossy(&r.stderr)
            );
            if op == "open" {
                let opened: Value = serde_json::from_slice(&r.stdout).unwrap();
                let id = opened["session"]["id"].as_str().unwrap();
                assert!(
                    h.cli(Some(token), &["session", "close", id])
                        .status
                        .success()
                );
                assert_eq!(fs::read(h.home.join("worktrees.json")).unwrap(), store);
            } else {
                assert_ne!(fs::read(h.home.join("worktrees.json")).unwrap(), store);
            }
        }
    }
    let path = h.worktree_as(Some(&a), &repo, "b2");
    let owned = h.worktree_as(None, &repo, "owner2");
    let open = h.cli(
        Some(&a),
        &[
            "worktree",
            "open",
            "--path",
            path.to_str().unwrap(),
            "--no-focus",
        ],
    );
    assert!(
        open.status.success(),
        "{}",
        String::from_utf8_lossy(&open.stderr)
    );
    let opened: Value = serde_json::from_slice(&open.stdout).unwrap();
    let id = opened["session"]["id"].as_str().unwrap();
    assert!(h.cli(Some(&a), &["session", "close", id]).status.success());
    let removed = h.cli(
        Some(&a),
        &["worktree", "remove", "--path", path.to_str().unwrap()],
    );
    assert!(
        removed.status.success(),
        "{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    let other = h.worktree_as(Some(&b), &repo, "c");
    let open = h.cli(
        None,
        &[
            "worktree",
            "open",
            "--path",
            other.to_str().unwrap(),
            "--no-focus",
        ],
    );
    assert!(
        open.status.success(),
        "{}",
        String::from_utf8_lossy(&open.stderr)
    );
    let opened: Value = serde_json::from_slice(&open.stdout).unwrap();
    let id = opened["session"]["id"].as_str().unwrap();
    assert!(h.cli(None, &["session", "close", id]).status.success());
    for target in [&other, &owned] {
        let r = h.cli(
            None,
            &["worktree", "remove", "--path", target.to_str().unwrap()],
        );
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    }
}

// v1a-23 (needs 47, OWNERC = D'): session callers get owner reach minus the two human actions.
impl Harness {
    /// One raw socket request sent from inside a shell session with `core.token` (as an agent that read the file
    /// would), so the core sees an owner token from an inside peer. Returns the parsed reply.
    fn inside_owner(&self, request: Value) -> Value {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let out = self.home.join(format!("inside-{n}.out"));
        let script = r#"printf '{"token":"%s","request":%s}\n' "$(cat "$NUNCHIRO_HOME/core.token")" "$1" | /usr/bin/nc -U "$NUNCHIRO_HOME/core.sock" > "$2.tmp"; mv "$2.tmp" "$2"; exec sleep 30"#;
        self.owner(json!({"op":"start","session":{"kind":"shell","project":self.home,"args":["/bin/sh","-c",script,"inside",request.to_string(),out]}}))
            .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        while !out.exists() {
            assert!(Instant::now() < until, "inside request never answered");
            thread::sleep(Duration::from_millis(20));
        }
        serde_json::from_slice(&fs::read(&out).unwrap()).unwrap()
    }
    fn owner_items(&self) -> Vec<Value> {
        self.owner(json!({"op":"snapshot"})).unwrap()["owner_decisions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
    fn settings_file(&self) -> Value {
        fs::read(self.home.join("settings.json"))
            .map(|b| serde_json::from_slice(&b).unwrap())
            .unwrap_or(Value::Null)
    }
}

#[test]
// Ticket 286 r6 flip: a session it did not start is listed but not closed through the CLI (was: closed).
fn session_token_lists_but_cannot_close_a_session_it_did_not_start() {
    let h = Harness::new();
    let other = h.home.join("other");
    fs::create_dir(&other).unwrap();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let target = h
        .owner(json!({"op":"start","session":{"kind":"shell","project":other,"args":["/bin/cat"]}}))
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let list = h.cli(Some(&token), &["session", "list"]);
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    assert!(String::from_utf8_lossy(&list.stdout).contains(&target));
    let close = h.cli(Some(&token), &["session", "close", &target]);
    assert!(!close.status.success());
    assert!(
        String::from_utf8_lossy(&close.stderr)
            .contains("a session closes only itself and the sessions it started"),
        "{}",
        String::from_utf8_lossy(&close.stderr)
    );
    let state = h.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == target.as_str())
        .map(|s| s["state"].clone());
    assert_eq!(state, Some(json!("running")));
}

#[test]
fn permission_answers_on_from_session_waits_for_owner() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let project = h.home.to_str().unwrap();
    for _ in 0..2 {
        let r = h.cli(
            Some(&token),
            &["permission-answers", "on", "--project", project],
        );
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        assert!(
            String::from_utf8_lossy(&r.stdout)
                .contains("waiting for the owner in the Nunchiro window")
        );
    }
    assert_eq!(h.settings_file(), Value::Null, "settings.json changed");
    let items = h.owner_items();
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["owner"]["type"], "permission_answers");
    assert_eq!(items[0]["owner"]["project"], project);
    // The session cannot answer its own item.
    assert!(
        h.call(
            &token,
            json!({"op":"answer","item":items[0]["id"],"answer":{"type":"allow_once"}})
        )
        .is_err()
    );
    assert_eq!(h.owner_items().len(), 1);
}

#[test]
fn owner_click_turns_permission_answers_on() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let project = h.home.to_str().unwrap();
    let r = h.cli(
        Some(&token),
        &["permission-answers", "on", "--project", project],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let items = h.owner_items();
    assert_eq!(items.len(), 1, "{items:?}");
    h.owner(json!({"op":"answer","item":items[0]["id"],"answer":{"type":"allow_once"}}))
        .unwrap();
    assert_eq!(h.settings_file()["permission_answers"][project], true);
    assert!(h.owner_items().is_empty());
    // The running core follows the file: the setting no longer refuses the allow. V2-8e: this fixture's prompt is
    // screen only (risky), which no agent may allow, so the refusal past the setting is the risky one.
    let id = h.worker(&token, &["--fixture-permission"]);
    let p = h.pending(&token, &id);
    let r = h.call(
        &token,
        json!({"op":"answer","item":p["id"],"answer":{"type":"allow_once"}}),
    );
    assert!(r.is_err_and(|e| e.contains("an agent cannot allow a risky request")));
}

#[test]
fn permission_answers_off_from_session_applies() {
    let h = Harness::configured(Some(
        r#"{"permission_answers":{"PROJECT":true},"stale_after_ms":1200000}"#,
    ));
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let project = h.home.to_str().unwrap();
    let r = h.cli(
        Some(&token),
        &["permission-answers", "off", "--project", project],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let file = h.settings_file();
    assert_eq!(file["permission_answers"][project], false);
    assert_eq!(file["stale_after_ms"], 1200000, "other keys are kept");
    assert!(h.owner_items().is_empty());
}

#[test]
fn permission_answers_on_outside_session_applies() {
    let h = Harness::new();
    let project = h.home.to_str().unwrap();
    let r = h.cli(None, &["permission-answers", "on", "--project", project]);
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert_eq!(h.settings_file()["permission_answers"][project], true);
    assert!(h.owner_items().is_empty());
}

#[test]
fn inside_owner_token_cannot_answer_yes_without_switch() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &["--fixture-permission"]);
    let p = h.pending(&token, &id);
    let yes = h.inside_owner(json!({"op":"answer","item":p["id"],"answer":{"type":"allow_once"}}));
    assert_eq!(yes["Err"], "permission_answers_disabled", "{yes}");
    let keys = h.inside_owner(json!({"op":"agent_keys","id":id,"keys":["1"]}));
    assert!(keys["Err"].is_string(), "{keys}");
    let esc = h.inside_owner(json!({"op":"answer","item":p["id"],"answer":{"type":"deny"}}));
    assert!(esc.get("Ok").is_some(), "{esc}");
}

#[test]
fn inside_owner_token_window_auth_refused() {
    let h = Harness::new();
    let r = h.inside_owner(json!({"op":"window_auth"}));
    assert!(r["Err"].is_string(), "{r}");
    assert!(r.get("Ok").is_none());
}

#[test]
fn inside_owner_token_approval_grant_raises_item() {
    let h = Harness::new();
    assert!(h.cli(None, &["widget", "new", "w"]).status.success());
    let hash = h.owner(json!({"op":"approval_status","name":"w"})).unwrap()["view"]["hash"].clone();
    let r = h.inside_owner(json!({"op":"approval_grant","name":"w","level":"read","hash":hash}));
    assert_eq!(r["Ok"]["type"], "waiting", "{r}");
    let view = h.owner(json!({"op":"approval_status","name":"w"})).unwrap()["view"].clone();
    assert_eq!(view["state"], "unapproved");
    let items = h.owner_items();
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["owner"]["type"], "approval");
    assert_eq!(items[0]["owner"]["name"], "w");
    assert_eq!(items[0]["owner"]["hash"], hash);
}

#[test]
fn owner_item_survives_a_core_restart_and_is_answered_after_it() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let project = h.home.to_str().unwrap();
    let r = h.cli(
        Some(&token),
        &["permission-answers", "on", "--project", project],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert!(h.cli(None, &["serve", "restart"]).status.success());
    let items = h.owner_items();
    assert_eq!(items.len(), 1, "{items:?}");
    h.owner(json!({"op":"answer","item":items[0]["id"],"answer":{"type":"allow_once"}}))
        .unwrap();
    assert_eq!(h.settings_file()["permission_answers"][project], true);
    assert!(h.cli(None, &["serve", "stop"]).status.success());
}

/// v1a-23: the owner token from inside a session submits as that session (a token submit), so the Claude slash
/// rule holds; the owner outside is not limited.
#[test]
fn inside_owner_token_claude_submit_is_a_token_submit() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let id = h.worker(&token, &[]);
    h.await_ready(&token, &id);
    let inside = h.inside_owner(json!({"op":"agent_prompt","id":id,"text":"/help"}));
    assert!(inside["Err"].is_string(), "{inside}");
    let caller = inside["Err"].as_str().unwrap().to_string();
    assert!(!caller.contains("owner peer check"), "{caller}");
    let outside = h.owner(json!({"op":"agent_prompt","id":id,"text":"/help"}));
    assert!(outside.is_ok(), "{outside:?}");
}

// v1a-23 r2 (S1, security review): a remote caller's yes needs the flag its machine delegated, AND-ed with this
// machine's rule. Here machine B's owner turned verified yes on for the worktree W; the forwarding machine says off.
#[test]
fn remote_send_keys_use_the_delegated_flag_not_this_machines_setting() {
    let h = Harness::new();
    let repo = h.repo();
    let w = h.worktree_as(None, &repo, "w");
    // The record names the forwarded caller as W's creator, as a remote `worktree create` would.
    let store = h.home.join("worktrees.json");
    let mut disk: Value = serde_json::from_slice(&fs::read(&store).unwrap()).unwrap();
    for record in disk["worktrees"].as_array_mut().unwrap() {
        if record["path"] == w.to_str().unwrap() {
            record["creator"] = json!("remote-a");
        }
    }
    fs::write(&store, serde_json::to_vec_pretty(&disk).unwrap()).unwrap();
    let on = h.cli(
        None,
        &["permission-answers", "on", "--project", w.to_str().unwrap()],
    );
    assert!(
        on.status.success(),
        "{}",
        String::from_utf8_lossy(&on.stderr)
    );
    let forwarded = |flag: bool, request: Value| {
        h.owner(json!({"op":"forwarded","caller":{"id":"remote-a","project":repo,"permission_answers":flag},"request":request}))
    };
    let child = forwarded(
        false,
        json!({"op":"start","session":{"kind":"claude","project":w,"args":["--fixture-permission"]}}),
    )
    .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let until = Instant::now() + Duration::from_secs(5);
    while h.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["id"] != child.as_str() || s["pending"].as_array().unwrap().is_empty())
    {
        assert!(Instant::now() < until, "no permission prompt");
        thread::sleep(Duration::from_millis(20));
    }
    let keys = json!({"op":"agent_keys","id":child,"keys":["1","enter"]});
    let off = forwarded(false, keys.clone());
    assert!(
        off.as_ref()
            .is_err_and(|e| e.contains("permission_answers_disabled")),
        "{off:?}"
    );
    // Control: once the forwarding machine's flag is on too, the flag no longer refuses the keys. V2-8e: the fixture's
    // prompt is screen only (risky), which no agent may allow, so the refusal past the flag is the risky one.
    let both = forwarded(true, keys);
    assert!(
        both.as_ref()
            .is_err_and(|e| e.contains("an agent cannot allow a risky request")),
        "{both:?}"
    );
}

// v1a-23 r2 (N4): a session cannot dismiss an owner item either.
#[test]
fn session_deny_on_an_owner_item_is_refused() {
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let project = h.home.to_str().unwrap();
    let r = h.cli(
        Some(&token),
        &["permission-answers", "on", "--project", project],
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let items = h.owner_items();
    assert_eq!(items.len(), 1);
    let deny = h.call(
        &token,
        json!({"op":"answer","item":items[0]["id"],"answer":{"type":"deny"}}),
    );
    assert!(deny.is_err(), "{deny:?}");
    let inside =
        h.inside_owner(json!({"op":"answer","item":items[0]["id"],"answer":{"type":"deny"}}));
    assert!(inside["Err"].is_string(), "{inside}");
    assert_eq!(h.owner_items().len(), 1);
}

// v1a-23 r2 (N4, S2): `board_source_grant` from a session raises a source item; it is approved only through the
// sheet's request at the hash the sheet shows (a strip `allow_once` is refused), which clears the item.
#[test]
fn session_board_source_grant_raises_an_item_the_owner_approves_at_the_shown_hash() {
    let h = Harness::new();
    let dir = h.home.join("sources/demo");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("widget.toml"),
        "version=1\nkind='integration'\ncommand=['/bin/echo','{\"cards\":[]}']\ninterval=3600\n",
    )
    .unwrap();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let shown = h
        .owner(json!({"op":"board_source_status","name":"demo"}))
        .unwrap()["view"]
        .clone();
    let r = h.call(
        &token,
        json!({"op":"board_source_grant","name":"demo","level":"read","hash":shown["hash"]}),
    );
    assert_eq!(r.as_ref().unwrap()["type"], "waiting", "{r:?}");
    let items = h.owner_items();
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["owner"]["subject"], "source");
    assert_eq!(items[0]["owner"]["hash"], shown["hash"]);
    let unapproved = h
        .owner(json!({"op":"board_source_status","name":"demo"}))
        .unwrap();
    assert_eq!(unapproved["view"]["state"], "unapproved");
    let strip =
        h.owner(json!({"op":"answer","item":items[0]["id"],"answer":{"type":"allow_once"}}));
    assert!(strip.is_err(), "{strip:?}");
    let granted = h
        .owner(json!({"op":"board_source_grant","name":"demo","level":"read","hash":shown["hash"]}))
        .unwrap();
    assert_eq!(granted["view"]["state"], "approved");
    assert!(h.owner_items().is_empty());
}

// Ticket 286 r6 (Codex security review of 1a7025d4): a session caller closes only itself and its own workers. A worker
// that tries a user tab (no parent) or another parent's worker is refused and nothing closes; its own worker closes.
#[test]
fn worker_closes_only_itself_and_its_own_workers() {
    let h = Harness::new();
    let running = |id: &Value| {
        h.owner(json!({"op":"snapshot"})).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == *id && s["state"] == "running")
    };
    let shell = json!({"kind":"shell","project":h.home,"args":["/bin/sh","-c","printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat"]});
    let child_of = |token: &str| {
        h.call(token, json!({"op":"start","session":shell}))
            .unwrap()["session"]["id"]
            .clone()
    };
    let user_tab = h.start()["id"].clone();
    let parent = h.start()["id"].clone();
    let other_parent = h.start()["id"].clone();
    let worker = child_of(&h.token(parent.as_str().unwrap()));
    let foreign = child_of(&h.token(other_parent.as_str().unwrap()));
    let token = h.token(worker.as_str().unwrap());
    for target in [&user_tab, &foreign] {
        let refused = h.call(&token, json!({"op":"close","id":target}));
        assert_eq!(
            refused.err().as_deref(),
            Some("a session closes only itself and the sessions it started"),
            "{target}"
        );
        assert!(running(target), "{target} was closed");
    }
    let own = child_of(&token);
    h.call(&token, json!({"op":"close","id":own})).unwrap();
    assert!(!running(&own), "its own worker still runs");
    h.call(&token, json!({"op":"close","id":worker})).unwrap();
    assert!(!running(&worker), "the worker did not close itself");
}

/// Ticket 572: the commands the orchestration guide's "A blocked worker" section names are the ones the core accepts
/// (or, for `prompt`/`send`, refuses). The test runs the guide's own text, so the guide cannot drift from the core.
#[test]
fn orchestration_guide_blocked_worker_commands_match_the_core() {
    let guide = include_str!("../guides/orchestration/guide.md");
    let section = guide
        .split("## A blocked worker")
        .nth(1)
        .and_then(|s| s.split("\n## ").next())
        .expect("guide has an 'A blocked worker' section");
    // Every `nunchiro agent ...` span of the section, as the argument list after `nunchiro`, newlines folded.
    let commands: Vec<Vec<String>> = section
        .replace("\n   ", " ")
        .split('`')
        .skip(1)
        .step_by(2)
        .filter_map(|span| span.strip_prefix("nunchiro agent "))
        .map(|rest| {
            std::iter::once("agent")
                .chain(rest.split_whitespace())
                .map(String::from)
                .collect()
        })
        .collect();
    let named = |verb: &str| {
        commands
            .iter()
            .find(|c| c[1] == verb && c.contains(&"<lane>".to_string()))
            .unwrap_or_else(|| panic!("guide names no `agent {verb} <lane>` command"))
            .clone()
    };
    let fill = |command: &[String], id: &str, option: &str| -> Vec<String> {
        command
            .iter()
            .map(|a| match a.as_str() {
                "<lane>" => id.to_string(),
                "<option>" => option.to_string(),
                _ => a.clone(),
            })
            .collect()
    };
    let h = Harness::new();
    let c = h.start();
    let token = h.token(c["id"].as_str().unwrap());
    let question = h.worker(&token, &["--fixture-question"]);
    let dialog = h.worker(&token, &["--fixture-dialog"]);
    h.pending(&token, &question);
    h.pending(&token, &dialog);
    // The guide says these are refused while the worker is blocked.
    for verb in ["prompt", "send"] {
        assert!(guide.contains(&format!("`nunchiro agent {verb}`")));
        let r = h.cli(Some(&token), &["agent", verb, &dialog, "hello"]);
        assert!(String::from_utf8_lossy(&r.stderr).contains("agent_blocked"));
    }
    // The guide says a dialog is not answerable: its option keys are refused, only esc passes.
    let answer = named("send-keys");
    let args = fill(&answer, &dialog, "1");
    let r = h.cli(
        Some(&token),
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    assert!(
        !r.status.success(),
        "a dialog choice must be refused: {args:?}"
    );
    // The guide's read command and its option answer work on a question.
    for command in [named("read"), answer] {
        let args = fill(&command, &question, "2");
        let r = h.cli(
            Some(&token),
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        assert!(
            r.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&r.stderr)
        );
    }
    assert_eq!(
        h.snapshot(&token, &question)["send_log"][0]["status"],
        "delivered"
    );
}
