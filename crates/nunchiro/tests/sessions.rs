#[allow(dead_code)]
#[path = "../../nunchiro-core/tests/fixtures/hold.rs"]
mod hold;
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use std::{
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

struct Harness {
    home: PathBuf,
    core: Child,
}
impl Harness {
    fn new() -> Self {
        Self::configured(None)
    }
    fn configured(settings: Option<&str>) -> Self {
        let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        command.arg("serve");
        Self::with_command(settings, command)
    }
    fn with_command(settings: Option<&str>, mut command: Command) -> Self {
        home::git_env::scrub(&mut command);
        let home = home::short("t");
        if let Some(settings) = settings {
            std::fs::write(home.join("settings.json"), settings).unwrap();
        }
        if !command.get_envs().any(|(key, _)| key == "CODEX_HOME") {
            command.env("CODEX_HOME", home.join("codex-home"));
        }
        let path = format!(
            "{}/tests/fixtures:{}",
            env!("CARGO_MANIFEST_DIR"),
            std::env::var("PATH").unwrap()
        );
        if !command.get_envs().any(|(key, _)| key == "PATH") {
            command.env("PATH", path); // a test with its own fakes puts them first
        }
        if !command.get_envs().any(|(key, _)| key == "HOME") {
            // Ticket 1083: the default worktrees folder lies in the user's home; never the real one.
            std::fs::create_dir_all(home.join("user")).unwrap();
            command.env("HOME", home.join("user"));
        }
        let core = command
            .env("NUNCHIRO_HOME", &home)
            .env("SHELL", "/bin/sh") // ticket 286: the shell an ended agent leaves
            .spawn()
            .unwrap();
        let h = Self { home, core };
        let until = Instant::now() + Duration::from_secs(30);
        while call(&h.home, Request::Snapshot).is_err() {
            assert!(Instant::now() < until, "core did not start");
            thread::sleep(Duration::from_millis(20));
        }
        h
    }
    fn request(&self, r: Request) -> Reply {
        call(&self.home, r).unwrap()
    }
    fn start(&self, args: &[&str]) -> Session {
        match self.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: self.home.clone(),
                worktree: false,
                label: "fixture".into(),
                args: args.iter().map(|s| s.to_string()).collect(),
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Reply::Started { session } => session,
            _ => panic!("wrong reply"),
        }
    }
    fn read(&self, id: &str) -> String {
        match self.request(Request::Read {
            id: id.into(),
            after: 0,
        }) {
            Reply::Output { data, .. } => String::from_utf8_lossy(&data).into(),
            _ => panic!("wrong reply"),
        }
    }
    fn wait_text(&self, id: &str, text: &str) {
        let until = Instant::now() + Duration::from_secs(5);
        while !self.read(id).contains(text) {
            assert!(Instant::now() < until, "missing {text}");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.core.try_wait().ok().flatten().is_none() {
            if Instant::now() >= deadline {
                let _ = self.core.kill();
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.core.wait();
        std::fs::remove_dir_all(&self.home).unwrap();
    }
}

#[test]
fn three_working_agents_survive_twenty_client_reattachments() {
    let h = Harness::new();
    let sessions: Vec<_> = (0..3)
        .map(|_| {
            h.start(&[
                "/bin/sh",
                "-c",
                "printf 'ORIGINAL\\n'; while read line; do printf 'ACK:%s\\n' \"$line\"; done",
            ])
        })
        .collect();
    for s in &sessions {
        h.wait_text(&s.id, "ORIGINAL");
    }
    for i in 0..20 {
        for s in &sessions {
            h.request(Request::SendText {
                id: s.id.clone(),
                text: format!("round-{i}\n"),
                composer: false,
                seen: vec![],
            });
            h.wait_text(&s.id, &format!("ACK:round-{i}"));
            assert!(h.read(&s.id).contains("ORIGINAL"));
        }
    }
    match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => {
            assert!(sessions.iter().all(|s| s.state == SessionState::Running))
        }
        _ => panic!(),
    }
}

#[test]
fn restart_retains_agent_ids_and_marks_unknown_versions_untested() {
    let mut h = Harness::new();
    for kind in [AgentKind::Claude, AgentKind::Codex] {
        let s = match h.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind,
                project: h.home.clone(),
                worktree: false,
                label: "persisted".into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Reply::Started { session } => session,
            _ => panic!(),
        };
        h.wait_text(&s.id, "READY");
        assert!(s.untested, "unknown version must be untested");
    }
    let before = match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => sessions,
        _ => panic!(),
    };
    assert!(before.iter().all(|s| s.agent_session_id.is_some()));
    // Simulate unexpected core loss, not just the graceful Stop path.
    h.core.kill().unwrap();
    h.core.wait().unwrap();
    h.core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .args(["serve"])
        .env("SHELL", "/bin/sh") // ticket 286
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    let after = loop {
        if let Ok(Reply::Snapshot { sessions, .. }) = call(&h.home, Request::Snapshot) {
            break sessions;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(after.len(), 2);
    for old in before {
        let new = after.iter().find(|s| s.id == old.id).unwrap();
        assert_eq!(new.agent_session_id, old.agent_session_id);
        // V2-1b (needs 76, reverses needs 32 provisionally): the agent outlived the core and is reattached.
        assert_eq!(new.state, SessionState::Running);
        assert_eq!(new.pid, old.pid);
    }
}

#[test]
fn sessions_start_in_project_or_isolated_worktree() {
    let h = Harness::new();
    let project = h.home.join("repo");
    std::fs::create_dir(&project).unwrap();
    for args in [
        vec!["init", "-q"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("git")
                .current_dir(&project)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
    let mut ids = vec![];
    for worktree in [false, true] {
        let s = match h.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: project.clone(),
                worktree,
                label: String::new(),
                args: vec!["/bin/sh".into(), "-c".into(), "pwd; exec /bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Reply::Started { session } => session,
            _ => panic!(),
        };
        let expected = if worktree {
            h.home.join("user/nunchiro/worktrees/repo").join(&s.id[..8]) // dogfood F4: an 8-character folder
        } else {
            project.clone()
        };
        assert_eq!(s.cwd, expected);
        h.wait_text(&s.id, expected.to_str().unwrap());
        ids.push(s.id);
    }
    for id in ids {
        h.request(Request::Close { id });
    }
}

#[test]
fn bounded_replay_preserves_bytes_and_reports_cursor_gaps() {
    let h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "head -c 1100000 /dev/zero; printf 'TAIL'; exec /bin/cat",
    ]);
    h.wait_text(&s.id, "TAIL");
    let end = match h.request(Request::Read {
        id: s.id.clone(),
        after: 0,
    }) {
        Reply::Output {
            data,
            start,
            end,
            truncated,
        } => {
            assert_eq!(data.len(), 1024 * 1024);
            assert!(truncated && start > 0);
            assert_eq!(&data[data.len() - 4..], b"TAIL");
            assert!(data.contains(&0));
            end
        }
        _ => panic!(),
    };
    match h.request(Request::Read {
        id: s.id.clone(),
        after: end,
    }) {
        Reply::Output {
            data, truncated, ..
        } => {
            assert!(data.is_empty());
            assert!(!truncated);
        }
        _ => panic!(),
    }
    assert!(
        call(
            &h.home,
            Request::Read {
                id: s.id.clone(),
                after: end + 1
            }
        )
        .is_err()
    );
}

#[test]
fn labels_keys_close_and_input_limits_are_checked_through_socket() {
    let h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "while read line; do printf 'ANSWER:%s\\n' \"$line\"; done",
    ]);
    h.request(Request::Label {
        id: s.id.clone(),
        label: "Renamed".into(),
    });
    h.request(Request::SendText {
        id: s.id.clone(),
        text: "눈치로".into(),
        composer: false,
        seen: vec![],
    });
    assert!(
        call(
            &h.home,
            Request::SendKeys {
                id: s.id.clone(),
                keys: vec!["enter".into(), "invalid".into()],
                seen: vec![],
                composer: false
            }
        )
        .is_err()
    );
    h.request(Request::SendKeys {
        id: s.id.clone(),
        keys: vec!["enter".into()],
        seen: vec![],
        composer: false,
    });
    h.wait_text(&s.id, "ANSWER:눈치로");
    assert!(
        call(
            &h.home,
            Request::SendText {
                id: s.id.clone(),
                text: "X".repeat(65537),
                composer: false,
                seen: vec![],
            }
        )
        .is_err()
    );
    assert!(
        call(
            &h.home,
            Request::Resize {
                id: s.id.clone(),
                cols: 0,
                rows: 24
            }
        )
        .is_err()
    );
    h.request(Request::Resize {
        id: s.id.clone(),
        cols: 80,
        rows: 24,
    });
    h.request(Request::Close { id: s.id.clone() });
    assert!(
        call(
            &h.home,
            Request::SendText {
                id: s.id.clone(),
                text: "x".into(),
                composer: false,
                seen: vec![],
            }
        )
        .is_err()
    );
    match h.request(Request::List) {
        Reply::Snapshot { sessions, .. } => {
            assert_eq!(sessions[0].state, SessionState::Closed);
            assert_eq!(sessions[0].label, "Renamed");
        }
        _ => panic!(),
    }
}

#[test]
fn socket_rejects_bad_token_and_singleton_preserves_live_core() {
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::{fs::PermissionsExt, net::UnixStream},
    };
    let h = Harness::new();
    let mut socket = UnixStream::connect(h.home.join("core.sock")).unwrap();
    socket
        .write_all(b"{\"token\":\"wrong\",\"request\":{\"op\":\"stop\"}}\n")
        .unwrap();
    let mut line = String::new();
    BufReader::new(socket).read_line(&mut line).unwrap();
    assert!(line.contains("unauthorized"));
    for (path, mode) in [
        (h.home.clone(), 0o700),
        (h.home.join("core.sock"), 0o600),
        (h.home.join("core.token"), 0o600),
    ] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
    let token = std::fs::read(h.home.join("core.token")).unwrap();
    let other = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .output()
        .unwrap();
    assert!(!other.status.success());
    assert_eq!(std::fs::read(h.home.join("core.token")).unwrap(), token);
    h.request(Request::Snapshot);
}

#[test]
fn corrupt_metadata_is_rejected_without_overwrite() {
    let mut h = Harness::new();
    let s = h.start(&["/bin/cat"]);
    let mut meta = serde_json::to_value(s).unwrap();
    meta["pid"] = serde_json::Value::Null;
    let mut duplicate = meta.clone();
    duplicate["state"] = "exited".into();
    h.request(Request::Stop);
    h.core.wait().unwrap();
    for bytes in [
        b"[]".to_vec(),
        br#"{"version":"bad","sessions":[]}"#.to_vec(),
        serde_json::to_vec(&serde_json::json!({"version":1,"sessions":[meta]})).unwrap(),
        serde_json::to_vec(
            &serde_json::json!({"version":1,"sessions":[duplicate.clone(),duplicate]}),
        )
        .unwrap(),
    ] {
        rejects_metadata(&h.home, &bytes);
    }
}

#[test]
fn detached_terminal_answers_split_cursor_queries_without_a_viewer() {
    let h = Harness::new();
    let s = h.start(&["/bin/sh", "-c", r"stty -icanon -echo; printf '\033['; sleep 0.05; printf '6n'; dd bs=1 count=6 2>/dev/null; printf QUERY_DONE; exec /bin/cat"]);
    h.wait_text(&s.id, "QUERY_DONE");
    assert!(h.read(&s.id).contains("\x1b[1;1R"));
}

#[test]
fn codex_hook_policy_and_injection_opt_out_preserve_user_config() {
    for disabled in [false, true] {
        let h = Harness::configured(if disabled {
            Some(r#"{"disable_hook_injection":true}"#)
        } else {
            None
        });
        for repo_hooks in [false, true] {
            if repo_hooks {
                std::fs::create_dir(h.home.join(".codex")).unwrap();
                std::fs::write(h.home.join(".codex/hooks.json"), "{}").unwrap();
            }
            let s = match h.request(Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Codex,
                    project: h.home.clone(),
                    worktree: false,
                    label: String::new(),
                    args: vec![],
                    model: Some("fixture-model".into()),
                    effort: Some("low".into()),
                    resume: None,
                },
            }) {
                Reply::Started { session } => session,
                _ => panic!(),
            };
            h.wait_text(&s.id, "READY");
            let output = h.read(&s.id);
            assert_eq!(
                output.contains("--dangerously-bypass-hook-trust"),
                !disabled && !repo_hooks
            );
            assert_eq!(
                output.contains("hooks.PermissionRequest"),
                !disabled && !repo_hooks
            );
            assert_eq!(
                output.contains("default_mode_request_user_input"),
                !disabled && !repo_hooks
            );
            assert!(output.contains("fixture-model"));
            // Ticket 1149: the outward hook rides on every Codex start, trusted by its own hash, with Nunchiro's other
            // hooks or without them.
            assert!(output.contains("hook outward --codex"), "{output}");
            assert!(output.contains("trusted_hash="), "{output}");
            // Ticket 692: never the update screen, whose preselected Enter runs `brew upgrade`.
            assert!(
                output.contains(r#""-c", "check_for_update_on_startup=false""#),
                "{output}"
            );
            h.request(Request::Close { id: s.id });
        }
    }
}

#[test]
fn stalled_terminal_input_does_not_freeze_snapshot_or_stop() {
    use std::io::{BufRead, BufReader, Write};
    let h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "stty raw -echo; printf READY; exec sleep 30",
    ]);
    h.wait_text(&s.id, "READY");
    let home = h.home.clone();
    let id = s.id.clone();
    let sender = thread::spawn(move || {
        call(
            &home,
            Request::SendText {
                id,
                text: "x".repeat(65536),
                composer: false,
                seen: vec![],
            },
        )
    });
    thread::sleep(Duration::from_millis(50));
    let mut socket = std::os::unix::net::UnixStream::connect(h.home.join("core.sock")).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let envelope = Envelope {
        token: std::fs::read_to_string(h.home.join("core.token")).unwrap(),
        request: Request::Snapshot,
    };
    writeln!(socket, "{}", serde_json::to_string(&envelope).unwrap()).unwrap();
    let mut line = String::new();
    let result = BufReader::new(socket).read_line(&mut line);
    if result.is_err() {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &s.pid.unwrap().to_string()])
            .status();
    }
    assert!(result.is_ok(), "snapshot stalled behind terminal write");
    assert!(
        sender.join().unwrap().is_err(),
        "backpressure must be explicit, never an invisible retry"
    );
    h.request(Request::Stop);
}

/// v19-Q9-cx: a refused write marks the session as not reading input (the tree read it idle); a whole write clears it.
#[test]
fn refused_terminal_write_marks_session_until_a_whole_write() {
    let h = Harness::new();
    let go = h.home.join("go");
    let s = h.start(&[
        "/bin/sh",
        "-c",
        &format!(
            "stty raw -echo; printf READY; while [ ! -e '{}' ]; do sleep 0.05; done; exec cat >/dev/null",
            go.display()
        ),
    ]);
    h.wait_text(&s.id, "READY");
    let send = |text: String| {
        call(
            &h.home,
            Request::SendText {
                id: s.id.clone(),
                text,
                composer: false,
                seen: vec![],
            },
        )
    };
    let blocked = || match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => sessions[0].attention.input_blocked,
        _ => panic!(),
    };
    assert!(!blocked());
    let error = send("x".repeat(4000)).unwrap_err();
    assert!(error.contains("terminal input blocked"), "{error}");
    assert!(blocked(), "a refused write must show on the session");
    std::fs::write(&go, "").unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while send("y".into()).is_err() {
        assert!(Instant::now() < until, "the reader never drained its input");
        thread::sleep(Duration::from_millis(50));
    }
    assert!(!blocked(), "a whole write clears the mark");
    h.request(Request::Stop);
}

#[test]
fn malformed_metadata_shape_and_unlaunchable_agent_ids_remain_unchanged() {
    let mut h = Harness::new();
    let s = h.start(&["/bin/cat"]);
    h.request(Request::Stop);
    h.core.wait().unwrap();
    let mut meta = serde_json::to_value(s).unwrap();
    meta["kind"] = "codex".into();
    meta["state"] = "resumable".into();
    meta["pid"] = serde_json::Value::Null;
    meta["agent_session_id"] = "../../outside".into();
    for bytes in [
        b"[1,[]]".to_vec(),
        serde_json::to_vec(&serde_json::json!({"version":1,"sessions":[meta]})).unwrap(),
    ] {
        rejects_metadata(&h.home, &bytes);
    }
}

#[test]
fn codex_identity_survives_restart_with_hook_injection_disabled() {
    let mut h = Harness::configured(Some(r#"{"disable_hook_injection":true}"#));
    let s = match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Codex,
            project: h.home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    h.wait_text(&s.id, "READY");
    // None of Nunchiro's own hooks (the SessionStart one would report the id); ticket 1149: the outward hook, which
    // every Codex start gets, is the only one.
    let output = h.read(&s.id);
    assert!(!output.contains("hooks.SessionStart"), "{output}");
    assert_eq!(output.matches("hooks.").count(), 2, "{output}"); // hooks.PreToolUse, hooks.state
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let sessions = match h.request(Request::Snapshot) {
            Reply::Snapshot { sessions, .. } => sessions,
            _ => panic!(),
        };
        if sessions[0].agent_session_id.as_deref() == Some("FAKE-CODEX-123") {
            break;
        }
        assert!(
            Instant::now() < until,
            "Codex identity was not discovered from its owned rollout fd"
        );
        thread::sleep(Duration::from_millis(50));
    }
    h.request(Request::Stop);
    h.core.wait().unwrap();
    h.core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(Reply::Snapshot { sessions, .. }) = call(&h.home, Request::Snapshot) {
            assert_eq!(
                sessions[0].agent_session_id.as_deref(),
                Some("FAKE-CODEX-123")
            );
            assert_eq!(sessions[0].state, SessionState::Resumable);
            break;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(20));
    }
}

fn rejects_metadata(home: &std::path::Path, bytes: &[u8]) {
    let path = home.join("sessions.json");
    std::fs::write(&path, bytes).unwrap();
    let mut child = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", home)
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(
        status.is_some_and(|s| s.code() == Some(1)),
        "malformed metadata was accepted"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn harness_waits_for_protocol_readiness_after_socket_is_bound() {
    let command = Command::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/delayed-core"
    ));
    let h = Harness::with_command(None, command);
    match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => assert!(sessions.is_empty()),
        _ => panic!(),
    }
}

/// Ticket 286: an agent that quits leaves its wrapper's shell, Running. Waits until that shell answers a line (typed
/// again until one does: keys sent before it starts are dropped), then quits it with `exit`.
fn quit_left_shell(h: &Harness, id: &str) {
    let until = Instant::now() + Duration::from_secs(20);
    for n in 1.. {
        // The shell does the arithmetic: the echoed line never holds the answer.
        type_text(h, id, &format!("echo shell-$(({n}*1000+42))\r"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if h.read(id).contains(&format!("shell-{}", n * 1000 + 42)) {
                type_text(h, id, "exit\r");
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            Instant::now() < until,
            "no shell answered after the agent quit"
        );
    }
}

/// The terminal's own text (`composer: false`), as the owner types it in the pane.
fn type_text(h: &Harness, id: &str, text: &str) {
    h.request(Request::SendText {
        id: id.into(),
        text: text.into(),
        composer: false,
        seen: vec![],
    });
}

fn process_running(pid: &str) -> bool {
    let out = Command::new("/bin/ps")
        .args(["-p", pid, "-o", "stat="])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&out.stdout);
    !state.trim().is_empty() && !state.trim().starts_with('Z')
}

#[test]
fn close_and_stop_kill_helpers_after_the_leader_exits() {
    for full_stop in [false, true] {
        let h = Harness::new();
        let s = h.start(&[concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/forked-agent"
        )]);
        h.wait_text(&s.id, "CHILD:");
        let text = h.read(&s.id);
        let pid = text
            .split("CHILD:")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot)
                && sessions[0].state == SessionState::Exited
            {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        // Exit observation now retires the helper group before reaping the leader.
        h.request(if full_stop {
            Request::Stop
        } else {
            Request::Close { id: s.id }
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while process_running(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let survived = process_running(pid);
        if survived {
            Command::new("/bin/kill")
                .args(["-KILL", pid])
                .status()
                .unwrap();
        }
        assert!(!survived, "reparented helper survived close/stop");
    }
}

#[test]
fn core_recovers_after_accept_runs_out_of_file_descriptors() {
    let mut command = Command::new("/usr/bin/python3");
    command.args(["-c", "import os,resource,sys; resource.setrlimit(resource.RLIMIT_NOFILE,(32,32)); os.execv(sys.argv[1],sys.argv[1:])", env!("CARGO_BIN_EXE_nunchiro"), "serve"]);
    let mut h = Harness::with_command(None, command);
    let mut sockets = vec![];
    for _ in 0..40 {
        if let Ok(socket) = std::os::unix::net::UnixStream::connect(h.home.join("core.sock")) {
            sockets.push(socket);
        }
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(100));
    let exited = h.core.try_wait().unwrap();
    drop(sockets);
    assert!(exited.is_none(), "accept EMFILE terminated the core");
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&h.home, Request::Snapshot).is_err() {
        assert!(
            Instant::now() < deadline,
            "core failed to recover after releasing clients"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn launch_preserves_user_config_locations_and_clears_parent_session_identity() {
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("CLAUDE_CONFIG_DIR", "/fixture/claude")
        .env("CODEX_HOME", "/fixture/codex")
        .env("CLAUDECODE", "outer")
        .env("CODEX_THREAD_ID", "outer");
    let h = Harness::with_command(None, command);
    let s = h.start(&["/bin/sh", "-c", "printf 'CONFIG:%s CODEX:%s NESTED:%s THREAD:%s\\n' \"$CLAUDE_CONFIG_DIR\" \"$CODEX_HOME\" \"${CLAUDECODE-unset}\" \"${CODEX_THREAD_ID-unset}\"; exec /bin/cat"]);
    h.wait_text(
        &s.id,
        "CONFIG:/fixture/claude CODEX:/fixture/codex NESTED:unset THREAD:unset",
    );
}

// Ticket 209 (strict): every variable a parent Claude Code or Codex session exports to its children (Facts of the
// brief) plus a future `CLAUDE_CODE_MESSAGING_*` one.
const PARENT_NAMES: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "TRACEPARENT",
    "TRACESTATE",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CLAUDE_CODE_MESSAGING_FUTURE",
];

/// A shell session whose command prints `NAME:${NAME-unset}` for each name, then waits.
fn print_env(h: &Harness, names: &[&str]) -> Session {
    let format: String = names.iter().map(|n| format!("{n}:%s\\n")).collect();
    let values: String = names
        .iter()
        .map(|n| format!(" \"${{{n}-unset}}\""))
        .collect();
    h.start(&[
        "/bin/sh",
        "-c",
        &format!("printf '{format}'{values}; exec /bin/cat"),
    ])
}

// Threats 1 and 2: nothing of the launching session's identity or messaging channel reaches a started child.
#[test]
fn spawned_agent_drops_parent_session_env() {
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command.arg("serve");
    for name in PARENT_NAMES {
        command.env(name, "parent-fixture");
    }
    let h = Harness::with_command(None, command);
    let s = print_env(&h, PARENT_NAMES);
    // The last name printed is the last one asserted: wait for the whole line set, then check each.
    h.wait_text(&s.id, "CLAUDE_CODE_MESSAGING_FUTURE:");
    let out = h.read(&s.id);
    for name in PARENT_NAMES {
        assert!(
            out.contains(&format!("{name}:unset")),
            "{name} reached the child"
        );
    }
    assert!(!out.contains("parent-fixture"));
}

// Threat 3: the user's own env survives and the per-session values replace any parent's.
#[test]
fn spawned_agent_keeps_user_env() {
    const KEPT: &[(&str, &str)] = &[
        ("LANG", "en_US.UTF-8"),
        ("CLAUDE_CONFIG_DIR", "/fixture/claude"),
        ("CODEX_HOME", "/fixture/codex"),
        ("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel.invalid"),
        ("SESSION_ID", "user-session-id"),
        ("MY_TOOL_KEY", "user-key"),
    ];
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("NUNCHIRO_SESSION", "parent-session")
        .env("NUNCHIRO_TOKEN", "parent-token")
        .env("CLAUDE_CODE_MESSAGING_TOKEN", "parent-fixture");
    for (name, value) in KEPT {
        command.env(name, value);
    }
    let h = Harness::with_command(None, command);
    let names: Vec<&str> = KEPT
        .iter()
        .map(|(n, _)| *n)
        .chain(["PATH", "NUNCHIRO_SESSION", "NUNCHIRO_TOKEN"])
        .collect();
    let s = print_env(&h, &names);
    h.wait_text(&s.id, "NUNCHIRO_TOKEN:");
    let out = h.read(&s.id);
    for (name, value) in KEPT {
        assert!(out.contains(&format!("{name}:{value}\r\n")), "{name} lost");
    }
    let value = |name: &str| {
        out.lines()
            .find_map(|l| l.trim_end().strip_prefix(&format!("{name}:")))
            .unwrap()
            .to_string()
    };
    assert!(value("PATH").contains("/tests/fixtures:"));
    assert_eq!(value("NUNCHIRO_SESSION"), s.id);
    assert_ne!(value("NUNCHIRO_TOKEN"), "parent-token");
    assert_ne!(value("NUNCHIRO_TOKEN"), "unset");
}

/// A core carrying the parent names and some core credentials, with a fake `claude` that records its env. Starts one
/// Claude agent session (on the account "work" when `account`) and returns the env that agent saw, plus the harness
/// and the account folder.
fn claude_env(account: bool) -> (Harness, Option<PathBuf>, String) {
    use std::os::unix::fs::PermissionsExt;
    let home = home::short("acenv");
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(
        bin.join("claude"),
        "#!/bin/sh\ncase \"$1\" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\nenv > \"$NUNCHIRO_HOME/env.tmp\" && mv \"$NUNCHIRO_HOME/env.tmp\" \"$NUNCHIRO_HOME/env-$NUNCHIRO_SESSION\"\nread line\n",
    )
    .unwrap();
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::create_dir_all(home.join("u")).unwrap();
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .env("NUNCHIRO_HOME", &home)
        .env("HOME", home.join("u"))
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("CLAUDE_CONFIG_DIR", "/core/own/claude")
        .env("CLAUDE_CODE_OAUTH_TOKEN", "core-oauth-token")
        .env("ANTHROPIC_API_KEY", "core-anthropic-key")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for name in PARENT_NAMES {
        command.env(name, "parent-fixture");
    }
    let core = command.spawn().unwrap();
    let h = Harness { home, core };
    let until = Instant::now() + Duration::from_secs(30);
    while call(&h.home, Request::Snapshot).is_err() {
        assert!(Instant::now() < until, "core did not start");
        thread::sleep(Duration::from_millis(20));
    }
    let folder = account.then(|| {
        match h.request(Request::AccountAdd {
            agent: nunchiro_core::accounts::Agent::Claude,
            label: "work".into(),
        }) {
            Reply::AccountAdded { account, .. } => account.folder,
            _ => panic!("wrong reply"),
        }
    });
    let session = match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: account.then(|| "work".into()),
            kind: AgentKind::Claude,
            project: h.home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!("wrong reply"),
    };
    let path = h.home.join(format!("env-{}", session.id));
    let until = Instant::now() + Duration::from_secs(15);
    while !path.exists() {
        assert!(Instant::now() < until, "agent never wrote its env");
        thread::sleep(Duration::from_millis(20));
    }
    let env = std::fs::read_to_string(path).unwrap();
    (h, folder, env)
}
fn has_var(env: &str, name: &str) -> bool {
    env.lines().any(|l| l.starts_with(&format!("{name}=")))
}

// Threat 3 (accounts): an agent (not a shell) session on an account, started by a core that carries the parent
// names, still gets its account folder and no core credential, and none of the parent names.
#[test]
fn account_env_still_set() {
    let (_h, folder, env) = claude_env(true);
    assert!(
        env.lines()
            .any(|l| l == format!("CLAUDE_CONFIG_DIR={}", folder.as_ref().unwrap().display()))
    );
    for name in ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] {
        assert!(!has_var(&env, name), "{name} reached the account session");
    }
    for name in PARENT_NAMES {
        assert!(!has_var(&env, name), "{name} reached the account session");
    }
    assert!(has_var(&env, "NUNCHIRO_TOKEN") && has_var(&env, "NUNCHIRO_SESSION"));
}

// Round 2 (review SHOULD 2): the same for a plain agent session, no account: parent names gone, the user's own
// config folder and credentials kept.
#[test]
fn spawned_plain_agent_drops_parent_session_env() {
    let (_h, _, env) = claude_env(false);
    for name in PARENT_NAMES {
        assert!(!has_var(&env, name), "{name} reached the plain agent");
    }
    assert!(
        env.lines()
            .any(|l| l == "CLAUDE_CONFIG_DIR=/core/own/claude")
    );
    assert!(
        env.lines()
            .any(|l| l == "CLAUDE_CODE_OAUTH_TOKEN=core-oauth-token")
    );
    assert!(has_var(&env, "NUNCHIRO_TOKEN") && has_var(&env, "NUNCHIRO_SESSION"));
}

// Round 2 (review SHOULD 1): `core.start.json` is 0600 but outlives the launching session and a child has
// NUNCHIRO_HOME, so it must not keep that session's messaging token or identity. User variables and PATH stay.
#[test]
fn core_start_record_omits_parent_session_env() {
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("FOO_USER", "1")
        .env("CLAUDE_CODE_MESSAGING_TOKEN", "parent-fixture")
        .env("CLAUDE_CODE_CHILD_SESSION", "parent-fixture");
    for name in PARENT_NAMES {
        command.env(name, "parent-fixture");
    }
    let h = Harness::with_command(None, command);
    let record = std::fs::read_to_string(h.home.join("core.start.json")).unwrap();
    let record: serde_json::Value = serde_json::from_str(&record).unwrap();
    let env = record["env"].as_object().expect("recorded env");
    for name in PARENT_NAMES {
        assert!(env.get(*name).is_none(), "{name} was recorded");
    }
    assert!(!record.to_string().contains("parent-fixture"));
    assert_eq!(env.get("FOO_USER").and_then(|v| v.as_str()), Some("1"));
    assert!(env.get("PATH").is_some_and(|v| v.is_string()));
}

#[test]
fn launch_preparation_does_not_hold_the_registry_lock() {
    use std::io::{BufRead, BufReader, Write};
    for gate in ["version", "worktree"] {
        let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
        command.arg("serve").env("FIXTURE_GATE", gate);
        let h = Harness::with_command(None, command);
        let project = h.home.join("repo");
        std::fs::create_dir(&project).unwrap();
        assert!(
            home::git_env::scrubbed("git")
                .current_dir(&project)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            home::git_env::scrubbed("git")
                .current_dir(&project)
                .args([
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "fixture"
                ])
                .status()
                .unwrap()
                .success()
        );
        let home = h.home.clone();
        let sender = thread::spawn(move || {
            call(
                &home,
                Request::Start {
                    receipt: None,
                    env: Default::default(),
                    folder: None,
                    session: StartSession {
                        account: None,
                        kind: if gate == "version" {
                            AgentKind::Claude
                        } else {
                            AgentKind::Shell
                        },
                        project,
                        worktree: gate == "worktree",
                        label: String::new(),
                        args: if gate == "worktree" {
                            vec!["/bin/cat".into()]
                        } else {
                            vec![]
                        },
                        model: None,
                        effort: None,
                        resume: None,
                    },
                },
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !h.home.join("probe-started").exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let mut socket = std::os::unix::net::UnixStream::connect(h.home.join("core.sock")).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let env = Envelope {
            token: std::fs::read_to_string(h.home.join("core.token")).unwrap(),
            request: Request::Snapshot,
        };
        writeln!(socket, "{}", serde_json::to_string(&env).unwrap()).unwrap();
        let mut line = String::new();
        let snapshot = BufReader::new(socket).read_line(&mut line);
        std::fs::write(h.home.join("probe-release"), "release").unwrap();
        sender.join().unwrap().unwrap();
        assert!(snapshot.is_ok(), "{gate} preparation blocked Snapshot");
        let response: Response = serde_json::from_str(&line).unwrap();
        match response.unwrap() {
            Reply::Snapshot { sessions, .. } => assert!(sessions.is_empty()),
            _ => panic!(),
        }
    }
}

#[test]
fn resume_replaces_the_old_row_and_preserves_identity_after_stop() {
    let mut h = Harness::new();
    let start = |h: &Harness, resume| match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: h.home.clone(),
            worktree: false,
            label: "conversation".into(),
            args: vec![],
            model: None,
            effort: None,
            resume,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    let first = start(&h, None);
    h.wait_text(&first.id, "READY");
    h.request(Request::Stop);
    h.core.wait().unwrap();
    h.core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .env(
            "PATH",
            format!(
                "{}/tests/fixtures:{}",
                env!("CARGO_MANIFEST_DIR"),
                std::env::var("PATH").unwrap()
            ),
        )
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&h.home, Request::Snapshot).is_err() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let resumed = start(&h, first.agent_session_id.clone());
    h.wait_text(&resumed.id, "READY");
    match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => {
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].agent_session_id, first.agent_session_id);
        }
        _ => panic!(),
    }
    h.request(Request::Stop);
    h.core.wait().unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(h.home.join("sessions.json")).unwrap()).unwrap();
    assert_eq!(
        saved["sessions"][0]["agent_session_id"],
        serde_json::to_value(first.agent_session_id).unwrap()
    );
}

#[test]
fn close_removes_only_its_own_hook_settings() {
    let h = Harness::new();
    let mut sessions = vec![];
    for _ in 0..2 {
        let session = match h.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Claude,
                project: h.home.clone(),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Reply::Started { session } => session,
            _ => panic!(),
        };
        h.wait_text(&session.id, "READY");
        sessions.push(session);
    }
    let first = h.home.join(format!("hooks-{}.json", sessions[0].id));
    let second = h.home.join(format!("hooks-{}.json", sessions[1].id));
    assert!(first.exists() && second.exists());
    h.request(Request::Close {
        id: sessions[0].id.clone(),
    });
    assert!(!first.exists());
    assert!(second.exists());
    h.request(Request::Stop);
    assert!(!second.exists());
}

#[test]
fn auto_started_core_log_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::new();
    h.request(Request::Stop);
    h.core.wait().unwrap();
    std::fs::write(h.home.join("core.log"), "previous log").unwrap();
    std::fs::set_permissions(
        h.home.join("core.log"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let output = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .args(["session", "list"])
        .output()
        .unwrap();
    assert!(output.status.success());
    // v2-13a: the core logs to logs/core.log; the pre-v2 core.log is left as it was.
    let mode = std::fs::metadata(h.home.join("logs/core.log"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    let dir_mode = std::fs::metadata(h.home.join("logs"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        std::fs::read_to_string(h.home.join("core.log")).unwrap(),
        "previous log"
    );
    h.request(Request::Stop);
    let deadline = Instant::now() + Duration::from_secs(5);
    while h.home.join("core.sock").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(mode, 0o600);
    assert_eq!(dir_mode, 0o700);
}

#[test]
fn stop_drains_in_flight_preparation_without_starting_an_agent() {
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command.arg("serve").env("FIXTURE_GATE", "version");
    let mut h = Harness::with_command(None, command);
    let home = h.home.clone();
    let sender = thread::spawn(move || {
        call(
            &home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Claude,
                    project: home.clone(),
                    worktree: false,
                    label: String::new(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !h.home.join("probe-started").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    h.request(Request::Stop);
    thread::sleep(Duration::from_millis(50));
    let prematurely_exited = h.core.try_wait().unwrap().is_some();
    std::fs::write(h.home.join("probe-release"), "release").unwrap();
    assert!(sender.join().unwrap().is_err());
    h.core.wait().unwrap();
    assert!(
        !prematurely_exited,
        "core exited before owned launch preparation finished"
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(h.home.join("sessions.json")).unwrap()).unwrap();
    assert_eq!(saved["sessions"].as_array().unwrap().len(), 0);
}

#[test]
fn naturally_exited_agent_can_resume_without_an_intervening_snapshot() {
    let h = Harness::configured(Some(r#"{"disable_hook_injection":true}"#));
    let start = |args, resume| match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: h.home.clone(),
            worktree: false,
            label: String::new(),
            args,
            model: None,
            effort: None,
            resume,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    let first = start(vec!["--fixture-exit".into()], None);
    let pid = first.pid.unwrap().to_string();
    quit_left_shell(&h, &first.id);
    let deadline = Instant::now() + Duration::from_secs(5);
    // Observe process exit outside the API so no status-refresh request can mask the defect.
    while process_running(&pid) {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let resumed = start(vec![], first.agent_session_id.clone());
    h.wait_text(&resumed.id, "READY");
    match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => {
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].agent_session_id, first.agent_session_id);
        }
        _ => panic!(),
    }
}

#[test]
fn gated_fixtures_exit_when_their_test_home_is_removed() {
    let h = Harness::new();
    for (fixture, gate, args) in [
        ("claude", "version", vec!["--version"]),
        ("git", "worktree", vec!["worktree", "add", "ignored"]),
    ] {
        let home = h.home.join(gate);
        std::fs::create_dir(&home).unwrap();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(fixture);
        let mut child = Command::new(path)
            .args(args)
            .env("NUNCHIRO_HOME", &home)
            .env("FIXTURE_GATE", gate)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !home.join("probe-started").exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        std::fs::remove_dir_all(home).unwrap();
        let deadline = Instant::now() + Duration::from_millis(500);
        let ended = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(10));
        };
        if !ended {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        assert!(ended, "{fixture} fixture survived removal of its test home");
    }
}

/// Ticket 690: what Codex 0.161 wrote to its home's `config.toml` at the first "Trust and continue" (ticket 589).
const TRUST_ONLY: &str = "model = \"gpt-6.1-sol\"\n\n[projects.\"/work/p\"]\ntrust_level = \"trusted\"\n\n[tui]\nshow_tooltips = false\n\n[notice]\nhide_full_access_warning = true\n";

/// Ticket 760: a person's own file as docs/cli.md asks for it (an MCP server), with a provider, the approval and sandbox
/// settings and the folder trust table Codex writes; ticket 760 r2: with nested keys Codex 0.161 defines (a list of tables,
/// a per-tool table).
const NORMAL: &str = "model = \"gpt-6.1-sol\"\nmodel_provider = \"fixture\"\napproval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n\n[sandbox_workspace_write]\nnetwork_access = true\n\n[model_providers.fixture]\nname = \"Fixture\"\nbase_url = \"http://127.0.0.1:9/v1\"\n\n[mcp_servers.nunchiro]\ncommand = \"nunchiro\"\nargs = [\"mcp\"]\n\n[mcp_servers.x]\ncommand = \"x\"\nenv = { X = \"1\" }\nenv_vars = [\"HOME\", { name = \"PATH\" }]\n\n[mcp_servers.x.tools.search]\napproval_mode = \"approve\"\n\n[projects.\"/work/p\"]\ntrust_level = \"trusted\"\n";

#[test]
fn codex_trust_only_config_keeps_injected_hooks() {
    for (repo, config) in [
        (false, TRUST_ONLY),
        (true, TRUST_ONLY),
        (false, NORMAL),
        (true, NORMAL),
    ] {
        let h = Harness::new();
        let dir = if repo {
            h.home.join(".codex")
        } else {
            h.home.join("codex-home")
        };
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), config).unwrap();
        let session = match h.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: h.home.clone(),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Reply::Started { session } => session,
            _ => panic!(),
        };
        h.wait_text(&session.id, "READY");
        let output = h.read(&session.id);
        for arg in [
            "--dangerously-bypass-hook-trust",
            "hooks.PermissionRequest",
            "default_mode_request_user_input",
        ] {
            assert!(
                output.contains(arg),
                "repo {repo}: {config}: {arg}: {output}"
            );
        }
        h.request(Request::Close { id: session.id });
    }
}

// Ticket 692 r2: a later `-c` wins in Codex, so no typed argument may turn the update screen back on.
#[test]
fn codex_args_cannot_turn_the_update_screen_back_on() {
    let h = Harness::new();
    for args in [
        vec!["-c", "check_for_update_on_startup=true"],
        vec!["--config=check_for_update_on_startup=true"],
        vec!["--config", "check_for_update_on_startup=true"],
        vec!["-c=check_for_update_on_startup=true"],
        vec!["-c", "\"check_for_update_on_startup\" = true"],
    ] {
        let reply = call(
            &h.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Codex,
                    project: h.home.clone(),
                    worktree: false,
                    label: String::new(),
                    args: args.iter().map(|a| a.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        );
        let error = reply.err().unwrap_or_else(|| panic!("{args:?} started"));
        assert!(
            error.contains("cannot set check_for_update_on_startup"),
            "{error}"
        );
    }
}

#[test]
fn codex_unapproved_sources_disable_injected_hooks_and_bypass() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    for source in [
        "hooks.json",
        "default-home",
        "config.toml",
        "plugin-config",
        "plain-config",
        "trust-and-hooks",
        "trust-extra-key",
        "normal-and-hooks",
        "normal-and-notify",
        "mcp-nested-unknown",
        "provider-nested-unknown",
        "sandbox-empty-unknown",
        "linked-config",
        "tui-unknown",
        "notice-unknown",
        "plugins",
        "repo-config",
        "malformed",
        "unreadable",
        "dangling",
        "args",
    ] {
        let fallback = (source == "default-home").then(Harness::new);
        let h = if let Some(fallback) = &fallback {
            let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
            command
                .arg("serve")
                .env_remove("CODEX_HOME")
                .env("HOME", &fallback.home);
            Harness::with_command(None, command)
        } else {
            Harness::new()
        };
        let codex = fallback
            .as_ref()
            .map_or_else(|| h.home.join("codex-home"), |h| h.home.join(".codex"));
        std::fs::create_dir(&codex).unwrap();
        let path = match source {
            "repo-config" => {
                let dir = h.home.join(".codex");
                std::fs::create_dir(&dir).unwrap();
                dir.join("config.toml")
            }
            "malformed"
            | "unreadable"
            | "plugin-config"
            | "plain-config"
            | "trust-and-hooks"
            | "trust-extra-key"
            | "tui-unknown"
            | "notice-unknown"
            | "normal-and-hooks"
            | "normal-and-notify"
            | "mcp-nested-unknown"
            | "provider-nested-unknown"
            | "sandbox-empty-unknown" => codex.join("config.toml"),
            "dangling" | "default-home" => codex.join("hooks.json"),
            _ => codex.join(source),
        };
        if source == "dangling" {
            symlink("absent", &path).unwrap();
        } else if source == "linked-config" {
            // Ticket 690: a trust-only file behind a link is not read; the link could change after the check.
            std::fs::write(h.home.join("trust.toml"), TRUST_ONLY).unwrap();
            symlink(h.home.join("trust.toml"), codex.join("config.toml")).unwrap();
        } else if source == "plugins" {
            std::fs::create_dir(&path).unwrap();
        } else if source != "args" {
            let normal_and_hooks = format!("{NORMAL}\n[hooks]\nSessionStart = []\n");
            let normal_and_notify = format!("notify = [\"x\"]\n{NORMAL}");
            let mcp_nested_unknown =
                format!("{NORMAL}\n[mcp_servers.x.hooks]\nSessionStart = []\n");
            let provider_nested_unknown =
                format!("{NORMAL}\n[model_providers.fixture.auth]\ncommand = \"t\"\nhooks = 1\n");
            let sandbox_empty_unknown = NORMAL.replace(
                "network_access = true\n",
                "network_access = true\nhooks = []\n",
            );
            std::fs::write(
                &path,
                match source {
                    "hooks.json" | "default-home" => r#"{"hooks":{"SessionStart":[]}}"#,
                    "malformed" => "[unparseable",
                    "plugin-config" => "[plugins.fixture]\nenabled = true",
                    // Ticket 690: a key Codex does not write itself, beside or inside its trust table.
                    "plain-config" => r#"profile = "fixture""#,
                    "trust-and-hooks" => {
                        "[projects.\"/p\"]\ntrust_level = \"trusted\"\n[hooks]\nSessionStart = []"
                    }
                    // Ticket 690 r2: a `[tui]` or `[notice]` key Codex 0.161 does not have.
                    "tui-unknown" => "[tui]\nshow_tooltips = false\nunknown_key = 1",
                    "notice-unknown" => "[notice]\nunknown_key = true",
                    "trust-extra-key" => "[projects.\"/p\"]\ntrust_level = \"trusted\"\nhooks = []",
                    // Ticket 760: the keys a person's own file holds hide no hook or other key beside them.
                    "normal-and-hooks" => &normal_and_hooks,
                    "normal-and-notify" => &normal_and_notify,
                    // Ticket 760 r2: a nested key Codex 0.161 does not define under the usual keys (a later Codex's
                    // field, or a typo), even an empty one.
                    "mcp-nested-unknown" => &mcp_nested_unknown,
                    "provider-nested-unknown" => &provider_nested_unknown,
                    "sandbox-empty-unknown" => &sandbox_empty_unknown,
                    _ => "[hooks]\nSessionStart = []\n[plugins.fixture]\nenabled = true",
                },
            )
            .unwrap();
            if source == "unreadable" {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o0)).unwrap();
            }
        }
        let session = match h.request(Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: h.home.clone(),
                worktree: false,
                label: source.into(),
                args: if source == "args" {
                    vec!["-c".into(), "plugins.fixture.enabled=true".into()]
                } else {
                    vec![]
                },
                model: None,
                effort: None,
                resume: None,
            },
        }) {
            Reply::Started { session } => session,
            _ => panic!(),
        };
        h.wait_text(&session.id, "READY");
        let output = h.read(&session.id);
        assert!(
            !output.contains("--dangerously-bypass-hook-trust"),
            "{source}: {output}"
        );
        assert!(
            !output.contains("hooks.PermissionRequest"),
            "{source}: {output}"
        );
        assert!(
            !output.contains("default_mode_request_user_input"),
            "{source}: {output}"
        );
        // Ticket 1149: a start that gets none of Nunchiro's other hooks (its own arguments, the person's own hooks
        // or config) still gets the outward hook, and no unreviewed hook of theirs is run for it.
        assert!(
            output.contains("hook outward --codex") && output.contains("trusted_hash="),
            "{source}: {output}"
        );
        if source == "unreadable" {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

/// Ticket 1149: a later `-c` wins in Codex, so a start whose arguments name hooks in a config or feature flag is
/// refused: it could take the outward hook away.
#[test]
fn t1149_codex_arguments_that_name_hooks_are_refused() {
    let h = Harness::new();
    for args in [
        vec!["-c", "hooks.state={}"],
        vec!["--disable", "hooks"],
        vec!["-c", "features.hooks=false"],
    ] {
        let refused = call(
            &h.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Codex,
                    project: h.home.clone(),
                    worktree: false,
                    label: String::new(),
                    args: args.iter().map(|a| a.to_string()).collect(),
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap_err();
        assert!(refused.contains("outward"), "{args:?}: {refused}");
    }
}

fn start_codex(h: &Harness) -> Result<Reply, String> {
    call(
        &h.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: h.home.clone(),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
}
/// What the `codex` fixture answers the core's question before a start (its `codex-app-server.json`).
fn codex_answers(h: &Harness, answers: serde_json::Value) {
    std::fs::write(h.home.join("codex-app-server.json"), answers.to_string()).unwrap();
}

/// Ticket 1150: before a Codex start the core asks that Codex which hooks it would run (`codex app-server`,
/// `hooks/list`). A Codex whose managed policy allows managed hooks only leaves Nunchiro's outward hook out (live Codex
/// 0.161.0: an empty list, `allowManagedHooksOnly` in its requirements) and would run outward actions with no card, so
/// its start is refused and the error names the policy; so is a hook that is listed but not trusted or off. Only the
/// hook listed, on and trusted starts.
#[test]
fn t1150_codex_that_will_not_run_the_outward_hook_is_not_started() {
    let h = Harness::new();
    let answers = |list: serde_json::Value, requirements: serde_json::Value| {
        let all = serde_json::json!({"initialize": {}, "hooks/list": list,
            "configRequirements/read": {"requirements": requirements}});
        codex_answers(&h, all);
    };
    let listed = |trust: &str, enabled: bool| {
        serde_json::json!({"data": [{"cwd": h.home, "warnings": [], "errors": [], "hooks": [{
            "key": "/<session-flags>/config.toml:pre_tool_use:0:0", "eventName": "preToolUse",
            "source": "sessionFlags", "enabled": enabled, "isManaged": false, "trustStatus": trust}]}]})
    };
    let none =
        serde_json::json!({"data": [{"cwd": h.home, "hooks": [], "warnings": [], "errors": []}]});
    // The managed policy, as live Codex 0.161.0 answers under it.
    answers(
        none.clone(),
        serde_json::json!({"allowManagedHooksOnly": true}),
    );
    let refused = start_codex(&h).unwrap_err();
    assert!(refused.contains("managed hooks only"), "{refused}");
    assert!(refused.contains("not started"), "{refused}");
    // No policy named, but the hook is not there, not trusted (a changed hash reads "modified") or off.
    for list in [none, listed("modified", true), listed("trusted", false)] {
        answers(list.clone(), serde_json::Value::Null);
        let refused = start_codex(&h).unwrap_err();
        assert!(
            refused.contains("outward-action check"),
            "{list}: {refused}"
        );
        assert!(!refused.contains("managed hooks only"), "{refused}");
    }
    let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot) else {
        panic!("no snapshot");
    };
    assert!(sessions.is_empty(), "a refused start left a session");
    // Listed, on and trusted: it starts, with the hook.
    answers(listed("trusted", true), serde_json::Value::Null);
    let Ok(Reply::Started { session }) = start_codex(&h) else {
        panic!("a Codex that runs the hook did not start");
    };
    h.wait_text(&session.id, "READY");
    assert!(h.read(&session.id).contains("hook outward --codex"));
    h.request(Request::Close { id: session.id });
}

/// Ticket 1150 round 2 (Codex look P1): a start needs Codex's yes. A Codex that cannot be asked is refused like one
/// that says no: a program that ends, one that prints something else, one that answers `initialize` but not the
/// question, and one that is slower than the bound (a real Codex under a managed policy that took over a second to
/// answer started unchecked before). Nothing is left behind, and the same Codex answering late but inside the deadline
/// starts.
#[test]
fn t1150_codex_that_does_not_answer_is_not_started() {
    let h = Harness::new();
    for answers in [
        serde_json::json!({"behave": "exit"}),
        serde_json::json!({"behave": "garbage"}),
        serde_json::json!({"initialize": {}}),
        serde_json::json!({"behave": 30}), // past the 10 s deadline (`CODEX_ASK_DEADLINE`)
    ] {
        codex_answers(&h, answers.clone());
        let refused = start_codex(&h)
            .err()
            .unwrap_or_else(|| panic!("{answers}: a Codex that was not heard started"));
        assert!(refused.contains("did not say"), "{answers}: {refused}");
        assert!(refused.contains("not started"), "{answers}: {refused}");
    }
    let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot) else {
        panic!("no snapshot");
    };
    assert!(sessions.is_empty(), "a refused start left a session");
    // The same Codex answering yes late (a loaded runner took over 5 s) still starts.
    codex_answers(
        &h,
        serde_json::json!({"behave": 5.5, "initialize": {}, "hooks/list": {"data": [{"hooks": [{
            "key": "/<session-flags>/config.toml:pre_tool_use:0:0", "enabled": true, "trustStatus": "trusted"}]}]}}),
    );
    let Ok(Reply::Started { session }) = start_codex(&h) else {
        panic!("a Codex that answers late did not start");
    };
    h.request(Request::Close { id: session.id });
}

/// Ticket 1150 round 2 (Codex look P2): Codex is asked off the registry lock. While the asked Codex is parked on a hold
/// file, a snapshot is served and the start is still waiting (before, the question ran under the lock, so the
/// snapshot came back only once the ask had ended); once released, the start goes through. Ticket 1155: held, not
/// timed, so a busy machine cannot fail it.
#[test]
fn t1150_asking_codex_does_not_hold_the_registry_lock() {
    let h = Harness::new();
    let parked = hold::Hold::new(h.home.join("codex-hold"), "");
    let all = serde_json::json!({"behave": "hold", "initialize": {}, "hooks/list": {"data": [{"hooks": [{
        "key": "/<session-flags>/config.toml:pre_tool_use:0:0", "enabled": true, "trustStatus": "trusted"}]}]}});
    codex_answers(&h, all);
    thread::scope(|scope| {
        let start = scope.spawn(|| start_codex(&h));
        hold::reached(&h.home.join("codex-asked"), "the start never asked Codex");
        let Reply::Snapshot { .. } = h.request(Request::Snapshot) else {
            panic!("no snapshot");
        };
        assert!(
            !start.is_finished(),
            "the snapshot came back only after the ask had ended"
        );
        parked.release();
        let Ok(Ok(Reply::Started { session })) = start.join() else {
            panic!("the held Codex did not start once released");
        };
        h.request(Request::Close { id: session.id });
    });
}

/// A slow start is answered to its caller, never given up on while the core goes on with it. A `--worktree` Codex
/// start whose `git worktree add` takes 5 s, whose `codex --version` outlasts its 3 s wait and whose Codex says yes
/// at 8 s takes the core over 15 s; the caller used to give up at 15 s ("Resource temporarily unavailable") and the
/// core then started the seat anyway, so a retry made a second one.
#[test]
fn a_slow_codex_worktree_start_is_answered_to_its_caller() {
    let bin = home::short("slowbin");
    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let script = |name: &str, text: String| {
        let path = bin.join(name);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
    };
    script(
        "git",
        "#!/bin/sh\ncase \" $* \" in *\" worktree add \"*) /bin/sleep 5;; esac\nexec /usr/bin/git \"$@\"\n".into(),
    );
    script(
        "codex",
        format!(
            "#!/bin/sh\ncase \"$1\" in --version) /bin/sleep 4;; app-server) /bin/sleep 8;; esac\nexec '{fixtures}/codex' \"$@\"\n"
        ),
    );
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command.arg("serve").env(
        "PATH",
        format!(
            "{}:{fixtures}:{}",
            bin.display(),
            std::env::var("PATH").unwrap()
        ),
    );
    let h = Harness::with_command(None, command);
    let project = h.home.join("repo");
    std::fs::create_dir(&project).unwrap();
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
            .current_dir(&project)
            .args(args)
            .status();
        assert!(ok.unwrap().success());
    }
    let started = Instant::now();
    let reply = call(
        &h.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: project.clone(),
                worktree: true,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    );
    let took = started.elapsed();
    let Ok(Reply::Started { session }) = reply else {
        panic!("after {took:?}: {reply:?}");
    };
    assert!(
        took > Duration::from_secs(15),
        "not slow enough to test: {took:?}"
    );
    h.request(Request::Close { id: session.id });
    let _ = std::fs::remove_dir_all(bin);
}

/// A core whose memory-pressure reading is faked (debug builds only) at `level`, or as a failed reading ("fail").
fn under_pressure(level: &str) -> Harness {
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("NUNCHIRO_TEST_MEMORY_PRESSURE", level);
    Harness::with_command(None, command)
}

/// When macOS reports memory pressure, a new agent seat is not started: one plain sentence names memory, and nothing
/// is left for it (no row, no holder). A plain terminal is not a seat and still opens.
#[test]
fn a_new_seat_is_held_under_memory_pressure() {
    for level in ["2", "4"] {
        let h = under_pressure(level);
        let refused = start_codex(&h).expect_err("a seat started under memory pressure");
        assert!(refused.contains("memory"), "{refused}");
        assert!(refused.contains("not started"), "{refused}");
        let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot) else {
            panic!("no snapshot");
        };
        assert!(sessions.is_empty(), "a held start left a session");
        assert!(
            nunchiro_core::holder::sockets(&h.home).is_empty(),
            "a held start left a holder"
        );
        let shell = h.start(&["/bin/cat"]);
        h.request(Request::Close { id: shell.id });
    }
    // Normal pressure, and a reading that failed, start it.
    for level in ["1", "fail"] {
        let h = under_pressure(level);
        let Ok(Reply::Started { session }) = start_codex(&h) else {
            panic!("level {level}: a seat was held");
        };
        h.request(Request::Close { id: session.id });
    }
}

/// The owner starts a held seat anyway; a session's own token cannot, even with the owner's word for it.
#[test]
fn only_the_owner_starts_a_held_seat_anyway() {
    let h = under_pressure("4");
    let start = |anyway: bool| {
        let start = Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: h.home.clone(),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        };
        match anyway {
            true => Request::StartAnyway {
                start: Box::new(start),
            },
            false => start,
        }
    };
    let Ok(Reply::Started { session }) = call(&h.home, start(true)) else {
        panic!("the owner's start anyway was held");
    };
    h.request(Request::Close { id: session.id });
    // A session's token (a plain terminal, which is no seat and opens under pressure).
    let s = print_env(&h, &["NUNCHIRO_TOKEN"]);
    h.wait_text(&s.id, "NUNCHIRO_TOKEN:");
    let out = h.read(&s.id);
    let token = out
        .split("NUNCHIRO_TOKEN:")
        .nth(1)
        .and_then(|t| t.lines().next())
        .map(|t| t.trim_end().to_string())
        .unwrap_or_else(|| panic!("no token in {out:?}"));
    let raw = |request: &Request| {
        use std::io::{BufRead, Write};
        let mut stream = std::os::unix::net::UnixStream::connect(h.home.join("core.sock")).unwrap();
        let line = serde_json::json!({"token": token, "request": request});
        writeln!(stream, "{line}").unwrap();
        let mut reply = String::new();
        std::io::BufReader::new(stream)
            .read_line(&mut reply)
            .unwrap();
        reply
    };
    let refused = raw(&start(true));
    assert!(
        refused.contains("Only you can start a session anyway"),
        "{refused}"
    );
    let refused = raw(&start(false));
    assert!(refused.contains("memory"), "{refused}");
    // A session cannot start anyway, so it is not told to.
    assert!(!refused.contains("--anyway"), "{refused}");
    let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot) else {
        panic!("no snapshot");
    };
    let open = sessions.iter().filter(|s| s.state != SessionState::Closed);
    assert_eq!(open.count(), 1, "only the terminal runs: {sessions:?}");
    h.request(Request::Close { id: s.id });
}

/// One request over the window's WebSocket (the owner's app): its `response`.
fn window_request(h: &Harness, request: serde_json::Value) -> serde_json::Value {
    use tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};
    let Ok(Reply::WindowAuth { port, token }) = call(&h.home, Request::WindowAuth) else {
        panic!("no window_auth reply");
    };
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    let headers = req.headers_mut();
    headers.insert("Origin", HeaderValue::from_static("tauri://localhost"));
    headers.insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
    );
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let (mut ws, _) = tungstenite::client(req, stream).unwrap();
    let frame = serde_json::json!({"id": 7, "request": request});
    ws.send(Message::Text(frame.to_string().into())).unwrap();
    loop {
        if let Message::Text(t) = ws.read().unwrap() {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["id"] == 7 {
                return v["response"].clone();
            }
        }
    }
}

/// The window's start is held at critical with its own words (no CLI command); its "Start anyway" starts it, as the
/// owner. At warning the window starts as before.
#[test]
fn the_window_starts_a_held_seat_anyway() {
    let h = under_pressure("4");
    let start = serde_json::json!({"op": "start", "session": {"kind": "codex", "project": h.home, "resume": null}});
    let held = window_request(&h, start.clone());
    let refused = held["Err"].as_str().unwrap_or_else(|| panic!("{held}"));
    assert!(refused.contains("memory"), "{refused}");
    assert!(refused.ends_with("or start it anyway"), "{refused}");
    let anyway = window_request(
        &h,
        serde_json::json!({"op": "start_anyway", "start": start}),
    );
    assert_eq!(anyway["Ok"]["type"], "started", "{anyway}");
    let id = anyway["Ok"]["session"]["id"].as_str().unwrap().to_string();
    h.request(Request::Close { id });
    let h = under_pressure("2");
    let started = window_request(&h, start);
    assert_eq!(started["Ok"]["type"], "started", "{started}");
    let id = started["Ok"]["session"]["id"].as_str().unwrap().to_string();
    h.request(Request::Close { id });
}

/// A teammate's seat the owner opens from the window is held at critical like the window's start, and its "Start
/// anyway" (`team_open` with `anyway`) opens it.
#[test]
fn the_window_opens_a_held_teammate_seat_anyway() {
    let h = under_pressure("4");
    let saved = window_request(
        &h,
        serde_json::json!({"op": "team_save", "name": "Bo", "job": "reviews", "kind": "codex", "project": h.home}),
    );
    let id = saved["Ok"]["teammates"]
        .as_array()
        .and_then(|all| all.iter().find(|m| m["name"] == "Bo"))
        .and_then(|m| m["id"].as_str())
        .unwrap_or_else(|| panic!("{saved}"))
        .to_string();
    let held = window_request(&h, serde_json::json!({"op": "team_open", "id": id}));
    let refused = held["Err"].as_str().unwrap_or_else(|| panic!("{held}"));
    assert!(refused.ends_with("or start it anyway"), "{refused}");
    let opened = window_request(
        &h,
        serde_json::json!({"op": "team_open", "id": id, "anyway": true}),
    );
    assert_eq!(opened["Ok"]["type"], "team_opened", "{opened}");
    let session = opened["Ok"]["session"]["id"].as_str().unwrap().to_string();
    h.request(Request::Close { id: session });
}

/// A teammate's "New conversation" (`team_open` with `fresh`) held at critical opens with the window's Start anyway.
#[test]
fn the_window_opens_a_held_new_conversation_anyway() {
    let h = under_pressure("4");
    let saved = window_request(
        &h,
        serde_json::json!({"op": "team_save", "name": "Bo", "job": "reviews", "kind": "codex", "project": h.home}),
    );
    let id = saved["Ok"]["teammates"]
        .as_array()
        .and_then(|all| all.iter().find(|m| m["name"] == "Bo"))
        .and_then(|m| m["id"].as_str())
        .unwrap_or_else(|| panic!("{saved}"))
        .to_string();
    let fresh = |anyway: bool| serde_json::json!({"op": "team_open", "id": id, "fresh": "now", "anyway": anyway});
    let held = window_request(&h, fresh(false));
    let refused = held["Err"].as_str().unwrap_or_else(|| panic!("{held}"));
    assert!(refused.ends_with("or start it anyway"), "{refused}");
    let opened = window_request(&h, fresh(true));
    assert_eq!(opened["Ok"]["type"], "team_opened", "{opened}");
    let session = opened["Ok"]["session"]["id"].as_str().unwrap().to_string();
    h.request(Request::Close { id: session });
}

/// A core whose memory reading is the file `level` (changed by the test), its waiting list read every 200 ms.
fn waiting_core(level: &std::path::Path) -> Harness {
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("NUNCHIRO_TEST_MEMORY_PRESSURE", level)
        .env("NUNCHIRO_TEST_MEMORY_WAIT", "200,1000,600000");
    Harness::with_command(None, command)
}

/// The window's own socket, kept open: its requests and the events it hears.
struct Window(tungstenite::WebSocket<std::net::TcpStream>, u64);
impl Window {
    fn open(h: &Harness) -> Window {
        use tungstenite::{client::IntoClientRequest, http::HeaderValue};
        let Ok(Reply::WindowAuth { port, token }) = call(&h.home, Request::WindowAuth) else {
            panic!("no window_auth reply");
        };
        let mut req = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .unwrap();
        let headers = req.headers_mut();
        headers.insert("Origin", HeaderValue::from_static("tauri://localhost"));
        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("nunchiro.v1, nunchiro.token.{token}")).unwrap(),
        );
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(60)))
            .unwrap();
        Window(tungstenite::client(req, stream).unwrap().0, 100)
    }
    fn request(&mut self, request: serde_json::Value) -> serde_json::Value {
        self.1 += 1;
        let id = self.1;
        let frame = serde_json::json!({"id": id, "request": request});
        self.0
            .send(tungstenite::Message::Text(frame.to_string().into()))
            .unwrap();
        loop {
            if let tungstenite::Message::Text(t) = self.0.read().unwrap() {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v["id"] == id {
                    return v["response"].clone();
                }
            }
        }
    }
    /// The next `memory_wait` event `until` takes.
    fn waiting(&mut self, mut until: impl FnMut(&serde_json::Value) -> bool) -> serde_json::Value {
        loop {
            if let tungstenite::Message::Text(t) = self.0.read().unwrap() {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v["event"] == "memory_wait" && until(&v) {
                    return v;
                }
            }
        }
    }
}

/// The owner's held click waits: the window hears one waiting entry, and once memory is free the start goes by
/// itself, a note names it and the list is empty. At warning the window's start goes at once (held at critical only).
#[test]
fn the_windows_held_start_waits_and_starts_by_itself() {
    let level = home::short("lvl").join("level");
    std::fs::write(&level, "4").unwrap();
    let h = waiting_core(&level);
    let mut w = Window::open(&h);
    let start = serde_json::json!({"op": "start", "session": {"kind": "codex", "project": h.home, "resume": null}});
    let waits = w.request(serde_json::json!({"op": "start_or_wait", "start": start}));
    assert_eq!(waits["Ok"]["type"], "memory_waiting", "{waits}");
    let event = w.waiting(|v| v["entries"].as_array().is_some_and(|e| e.len() == 1));
    let entry = &event["entries"][0];
    assert_eq!(
        (&entry["agent"], &entry["asker"]),
        (&serde_json::json!("Codex"), &serde_json::json!("you")),
        "{event}"
    );
    std::fs::write(&level, "1").unwrap();
    let event = w.waiting(|v| {
        v["entries"].as_array().is_some_and(|e| e.is_empty())
            && v["notes"].as_array().is_some_and(|n| !n.is_empty())
    });
    let note = &event["notes"][0];
    assert_eq!(
        (&note["outcome"], &note["mine"]),
        (&serde_json::json!("started"), &serde_json::json!(true)),
        "{event}"
    );
    let id = note["session"].as_str().unwrap().to_string();
    let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot) else {
        panic!("no snapshot");
    };
    assert!(
        sessions
            .iter()
            .any(|s| s.id == id && s.state == SessionState::Running),
        "{sessions:?}"
    );
    h.request(Request::Close { id });
    std::fs::write(&level, "2").unwrap();
    let now = w.request(serde_json::json!({"op": "start_or_wait", "start": start}));
    assert_eq!(now["Ok"]["type"], "started", "{now}");
    h.request(Request::Close {
        id: now["Ok"]["session"]["id"].as_str().unwrap().to_string(),
    });
}

/// A session's held start waits with its own sentence; the window starts one anyway and cancels another, and the
/// session's own token can do neither.
#[test]
fn the_window_starts_anyway_or_cancels_a_sessions_waiting_start() {
    let level = home::short("lvl").join("level");
    std::fs::write(&level, "2").unwrap();
    let h = waiting_core(&level);
    let s = print_env(&h, &["NUNCHIRO_TOKEN"]);
    h.wait_text(&s.id, "NUNCHIRO_TOKEN:");
    let out = h.read(&s.id);
    let token = out
        .split("NUNCHIRO_TOKEN:")
        .nth(1)
        .and_then(|t| t.lines().next())
        .map(|t| t.trim_end().to_string())
        .unwrap();
    let raw = |request: serde_json::Value| {
        use std::io::{BufRead, Write};
        let mut stream = std::os::unix::net::UnixStream::connect(h.home.join("core.sock")).unwrap();
        writeln!(
            stream,
            "{}",
            serde_json::json!({"token": token, "request": request})
        )
        .unwrap();
        let mut reply = String::new();
        std::io::BufReader::new(stream)
            .read_line(&mut reply)
            .unwrap();
        serde_json::from_str::<serde_json::Value>(&reply).unwrap()
    };
    for label in ["first", "second"] {
        let held = raw(
            serde_json::json!({"op": "start", "session": {"account": null, "kind": "codex", "project": h.home, "worktree": false, "label": label, "args": [], "model": null, "effort": null, "resume": null}}),
        );
        let said = held["Err"].as_str().unwrap_or_else(|| panic!("{held}"));
        assert!(
            said.contains("is waiting") && said.ends_with("Do not start it again"),
            "{said}"
        );
    }
    let mut w = Window::open(&h);
    let list = w.request(serde_json::json!({"op": "memory_wait_list"}));
    let entries = list["Ok"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("{list}"))
        .clone();
    assert_eq!(entries.len(), 2, "{list}");
    let id = |label: &str| {
        entries.iter().find(|e| e["agent"] == label).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    for request in [
        serde_json::json!({"op": "memory_wait_go", "id": id("first")}),
        serde_json::json!({"op": "memory_wait_cancel", "id": id("second")}),
    ] {
        let refused = raw(request.clone());
        assert!(refused["Err"].is_string(), "{request}: {refused}");
    }
    let started = w.request(serde_json::json!({"op": "memory_wait_go", "id": id("first")}));
    assert_eq!(started["Ok"]["type"], "memory_wait_started", "{started}");
    let cancelled = w.request(serde_json::json!({"op": "memory_wait_cancel", "id": id("second")}));
    assert_eq!(cancelled["Ok"]["type"], "ack", "{cancelled}");
    let list = w.request(serde_json::json!({"op": "memory_wait_list"}));
    assert_eq!(list["Ok"]["entries"], serde_json::json!([]), "{list}");
    let Reply::Snapshot { sessions, .. } = h.request(Request::Snapshot) else {
        panic!("no snapshot");
    };
    let labels: Vec<_> = sessions
        .iter()
        .filter(|s| s.state == SessionState::Running)
        .map(|s| s.label.as_str())
        .collect();
    assert!(
        labels.contains(&"first") && !labels.contains(&"second"),
        "{labels:?}"
    );
    for s in sessions {
        h.request(Request::Close { id: s.id });
    }
}

/// Resuming a saved conversation is never held: after a full quit it is a plain start, and the window has no override.
#[test]
fn resuming_a_saved_session_is_not_held() {
    let h = under_pressure("4");
    let reply = call(
        &h.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Codex,
                project: h.home.clone(),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: Some("FAKE-CODEX-123".into()),
            },
        },
    );
    let Ok(Reply::Started { session }) = reply else {
        panic!("a resume was held: {reply:?}");
    };
    h.request(Request::Close { id: session.id });
}

/// A core that restarts while the Mac is low on memory brings back every saved session: only new seats are held.
#[test]
fn a_core_restart_under_memory_pressure_brings_every_session_back() {
    let mut h = under_pressure("1");
    let Ok(Reply::Started { session }) = start_codex(&h) else {
        panic!("no seat");
    };
    let _ = call(&h.home, Request::Exit);
    h.core.wait().unwrap();
    let mut command = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    command
        .arg("serve")
        .env("NUNCHIRO_TEST_MEMORY_PRESSURE", "4")
        .env("NUNCHIRO_HOME", &h.home)
        .env("CODEX_HOME", h.home.join("codex-home"))
        .env("HOME", h.home.join("user"))
        .env("SHELL", "/bin/sh")
        .env(
            "PATH",
            format!(
                "{}/tests/fixtures:{}",
                env!("CARGO_MANIFEST_DIR"),
                std::env::var("PATH").unwrap()
            ),
        );
    h.core = command.spawn().unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Reply::Snapshot { sessions, .. }) = call(&h.home, Request::Snapshot)
            && let Some(back) = sessions.iter().find(|s| s.id == session.id)
        {
            assert_eq!(back.state, SessionState::Running, "{back:?}");
            break;
        }
        assert!(Instant::now() < until, "the session did not come back");
        thread::sleep(Duration::from_millis(50));
    }
    // A new seat on the restarted core is held.
    assert!(start_codex(&h).unwrap_err().contains("memory"));
    h.request(Request::Close { id: session.id });
}

#[test]
fn gated_version_fixture_has_a_deadline_even_when_home_remains() {
    let h = Harness::new();
    let mut child =
        Command::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude"))
            .arg("--version")
            .env("NUNCHIRO_HOME", &h.home)
            .env("FIXTURE_GATE", "version")
            .spawn()
            .unwrap();
    let deadline = Instant::now() + Duration::from_secs(7);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert!(
        status.is_some_and(|status| !status.success()),
        "fixture lacked its five-second failure deadline"
    );
}

// v1a-09: `claude --resume <id>` finds its conversation by folder, so a worktree session resumes there.
#[test]
fn a_worktree_session_resumes_in_its_own_folder() {
    let mut h = Harness::new();
    let project = h.home.join("repo");
    std::fs::create_dir(&project).unwrap();
    for args in [
        vec!["init", "-q"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("git")
                .current_dir(&project)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
    let start = |h: &Harness, worktree, resume| match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: project.clone(),
            worktree,
            label: "conversation".into(),
            args: vec![],
            model: None,
            effort: None,
            resume,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    let first = start(&h, true, None);
    assert_ne!(first.cwd, project);
    h.wait_text(&first.id, &format!("CWD:{}", first.cwd.display()));
    h.request(Request::Stop);
    h.core.wait().unwrap();
    h.core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .env(
            "PATH",
            format!(
                "{}/tests/fixtures:{}",
                env!("CARGO_MANIFEST_DIR"),
                std::env::var("PATH").unwrap()
            ),
        )
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&h.home, Request::Snapshot).is_err() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    // The window's resume offer sends the project and no worktree flag.
    let resumed = start(&h, false, first.agent_session_id.clone());
    assert_eq!(resumed.cwd, first.cwd);
    assert_eq!(resumed.project, project);
    h.wait_text(&resumed.id, &format!("CWD:{}", first.cwd.display()));
    // A plain session of the same project is not moved into someone's worktree.
    let plain = start(&h, false, None);
    assert_eq!(plain.cwd, project);
}

// v1a-40: a graceful core stop and a fresh core on the same home, as `serve restart` does.
fn restart_core(h: &mut Harness) {
    h.request(Request::Stop);
    h.core.wait().unwrap();
    h.core = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .env("NUNCHIRO_HOME", &h.home)
        .env("CODEX_HOME", h.home.join("codex-home"))
        .env(
            "PATH",
            format!(
                "{}/tests/fixtures:{}",
                env!("CARGO_MANIFEST_DIR"),
                std::env::var("PATH").unwrap()
            ),
        )
        .arg("serve")
        .env("SHELL", "/bin/sh") // ticket 286
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&h.home, Request::Snapshot).is_err() {
        assert!(Instant::now() < deadline, "core did not restart");
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_from_zero(h: &Harness, id: &str) -> (Vec<u8>, bool) {
    match h.request(Request::Read {
        id: id.into(),
        after: 0,
    }) {
        Reply::Output {
            data, truncated, ..
        } => (data, truncated),
        _ => panic!("wrong reply"),
    }
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

// v1a-40
#[test]
fn scrollback_survives_a_core_restart_and_seeds_the_resumed_session() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::new();
    let project = h.home.join("proj");
    std::fs::create_dir(&project).unwrap();
    let start = |h: &Harness, resume| match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: project.clone(),
            worktree: false,
            label: "conversation".into(),
            args: vec![],
            model: None,
            effort: None,
            resume,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    let first = start(&h, None);
    h.wait_text(&first.id, "READY");
    h.request(Request::SendText {
        id: first.id.clone(),
        text: "MARK-1\n".into(),
        composer: false,
        seen: vec![],
    });
    h.wait_text(&first.id, "ACK:MARK-1");
    restart_core(&mut h);

    let folder = h.home.join("scrollback");
    let file = folder.join(&first.id);
    let saved = std::fs::read(&file).expect("scrollback file written on stop");
    assert!(find(&saved, b"ACK:MARK-1", 0).is_some());
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(!file.starts_with(&project));
    // Not in the folder the agent can write to either.
    for e in std::fs::read_dir(h.home.join("artifacts").join(&first.id)).unwrap() {
        assert!(find(&std::fs::read(e.unwrap().path()).unwrap(), b"MARK-1", 0).is_none());
    }

    let (data, truncated) = read_from_zero(&h, &first.id);
    assert!(find(&data, b"ACK:MARK-1", 0).is_some());
    assert!(!truncated);

    let resumed = start(&h, first.agent_session_id.clone());
    let marker = "resumed; earlier output above".as_bytes();
    let until = Instant::now() + Duration::from_secs(5);
    let data = loop {
        let (data, _) = read_from_zero(&h, &resumed.id);
        if find(&data, marker, 0).is_some_and(|m| find(&data, b"READY", m).is_some()) {
            break data;
        }
        assert!(
            Instant::now() < until,
            "resumed replay lacks seed, marker or READY"
        );
        thread::sleep(Duration::from_millis(20));
    };
    let mark = find(&data, b"ACK:MARK-1", 0).expect("seed in the resumed replay");
    assert!(mark < find(&data, marker, 0).unwrap());
    // The old row is gone, so its file goes too; the text lives on in the new session's replay.
    assert!(!file.exists());
}

// v1a-40
#[test]
fn saved_scrollback_is_the_last_replay_bytes_and_reports_truncation() {
    let mut h = Harness::new();
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "head -c 1100000 /dev/zero; printf 'TAIL'; exec /bin/cat",
    ]);
    h.wait_text(&s.id, "TAIL");
    let (live, _) = read_from_zero(&h, &s.id);
    restart_core(&mut h);
    let saved = std::fs::read(h.home.join("scrollback").join(&s.id)).unwrap();
    assert_eq!(saved.len(), 1024 * 1024);
    assert_eq!(saved, live);
    let (data, truncated) = read_from_zero(&h, &s.id);
    assert_eq!(data, saved);
    assert!(truncated);
}

// v1a-40
#[test]
fn close_deletes_scrollback_and_a_symlinked_folder_is_not_written_through() {
    let mut h = Harness::new();
    let s = h.start(&["/bin/sh", "-c", "printf 'MARK-1'; exec /bin/cat"]);
    h.wait_text(&s.id, "MARK-1");
    restart_core(&mut h);
    let file = h.home.join("scrollback").join(&s.id);
    assert!(file.exists());
    h.request(Request::Close { id: s.id.clone() });
    // needs 120: a stopped shell's close is undoable for 10 s; a core stop ends the window, then file, view and row go.
    restart_core(&mut h);
    assert!(!file.exists(), "Close keeps the scrollback file");
    assert!(no_view(&h, &s.id));
    assert!(!listed(&h, &s.id));

    let s = h.start(&["/bin/sh", "-c", "printf 'MARK-2'; exec /bin/cat"]);
    h.wait_text(&s.id, "MARK-2");
    let elsewhere = h.home.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::remove_dir_all(h.home.join("scrollback")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, h.home.join("scrollback")).unwrap();
    restart_core(&mut h);
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    assert!(
        std::fs::symlink_metadata(h.home.join("scrollback"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    // No file to read back: a stopped session without saved output keeps the old answer.
    assert!(
        call(
            &h.home,
            Request::Read {
                id: s.id.clone(),
                after: 0
            }
        )
        .is_err()
    );
}

fn listed(h: &Harness, id: &str) -> bool {
    match h.request(Request::Snapshot) {
        Reply::Snapshot { sessions, .. } => sessions.iter().any(|s| s.id == id),
        _ => panic!(),
    }
}
fn no_view(h: &Harness, id: &str) -> bool {
    call(
        &h.home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    )
    .is_err()
}

// v1a-68 r3 (needs 78): a closed shell's view lives in the core's memory only; nothing is written for it.
#[test]
fn close_keeps_shell_view_in_memory_only() {
    let mut h = Harness::new();
    let s = h.start(&["/bin/sh", "-c", "printf 'MARK-1'; exec /bin/cat"]);
    h.wait_text(&s.id, "MARK-1");
    h.request(Request::Close { id: s.id.clone() });
    let file = h.home.join("scrollback").join(&s.id);
    assert!(!file.exists(), "Close wrote the shell's scrollback");
    assert!(find(&read_from_zero(&h, &s.id).0, b"MARK-1", 0).is_some());
    restart_core(&mut h);
    assert!(!file.exists());
    assert!(
        no_view(&h, &s.id),
        "a closed shell's view outlived the core"
    );
}

// v1a-68 r3: only the newest 16 closed shells keep a view.
#[test]
fn closed_shell_views_are_bounded() {
    const KEPT: usize = 16;
    let h = Harness::new();
    let ids: Vec<String> = (0..=KEPT)
        .map(|i| {
            let s = h.start(&[
                "/bin/sh",
                "-c",
                &format!("printf 'MARK-{i}-'; exec /bin/cat"),
            ]);
            h.wait_text(&s.id, &format!("MARK-{i}-"));
            h.request(Request::Close { id: s.id.clone() });
            s.id
        })
        .collect();
    // needs 120: closing a closed shell again removes it (its row hides at once, gone after the window).
    h.request(Request::Close {
        id: ids[KEPT].clone(),
    });
    assert!(no_view(&h, &ids[KEPT]));
    assert!(
        no_view(&h, &ids[0]),
        "the oldest closed shell kept its view"
    );
    for (i, id) in ids.iter().enumerate().take(KEPT).skip(1) {
        let mark = format!("MARK-{i}-");
        assert!(
            find(&read_from_zero(&h, id).0, mark.as_bytes(), 0).is_some(),
            "{mark}"
        );
    }
    assert!(
        std::fs::read_dir(h.home.join("scrollback")).map_or(true, |d| d.count() == 0),
        "a closed shell left a file"
    );
}

// v1a-40, kept by v1a-68 r3: an agent's scrollback goes at Close and it keeps no view (its transcript is the view).
#[test]
fn close_deletes_agent_scrollback() {
    let mut h = Harness::new();
    let s = match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: h.home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    h.wait_text(&s.id, "READY");
    restart_core(&mut h);
    let file = h.home.join("scrollback").join(&s.id);
    assert!(file.exists());
    h.request(Request::Close { id: s.id.clone() });
    // needs 120: an ended agent's close is undoable for 10 s; a core stop ends the window, then file and row go.
    restart_core(&mut h);
    assert!(!file.exists());
    assert!(no_view(&h, &s.id));
    assert!(!listed(&h, &s.id));
}

// v1a-40 r3: a file whose id has no open session row is removed when a core starts; the others stay.
#[test]
fn core_start_removes_scrollback_without_a_session_record() {
    let mut h = Harness::new();
    let kept = h.start(&["/bin/sh", "-c", "printf 'MARK-1'; exec /bin/cat"]);
    h.wait_text(&kept.id, "MARK-1");
    let closed = h.start(&["/bin/sh", "-c", "printf 'MARK-2'; exec /bin/cat"]);
    h.wait_text(&closed.id, "MARK-2");
    h.request(Request::Close {
        id: closed.id.clone(),
    });
    let folder = h.home.join("scrollback");
    std::fs::create_dir_all(&folder).unwrap();
    // A closed row's file (as if Close's delete had failed) and one for an id no row has.
    std::fs::write(folder.join(&closed.id), b"old").unwrap();
    std::fs::write(folder.join("no-such-session"), b"old").unwrap();
    std::fs::write(h.home.join("outside"), b"keep").unwrap();
    // The sweep runs while the new core opens, before it answers.
    restart_core(&mut h);
    assert!(folder.join(&kept.id).exists());
    assert!(!folder.join(&closed.id).exists(), "closed row's file kept");
    assert!(!folder.join("no-such-session").exists(), "orphan kept");
    assert!(h.home.join("outside").exists());
}

// v1a-40 r3: a run that exited in this core seeds the resume from its in-memory replay, without a core restart.
#[test]
fn a_run_that_exited_in_this_core_seeds_its_resume() {
    let h = Harness::new();
    let start = |args, resume| match h.request(Request::Start {
        receipt: None,
        env: Default::default(),
        folder: None,
        session: StartSession {
            account: None,
            kind: AgentKind::Claude,
            project: h.home.clone(),
            worktree: false,
            label: String::new(),
            args,
            model: None,
            effort: None,
            resume,
        },
    }) {
        Reply::Started { session } => session,
        _ => panic!(),
    };
    let first = start(vec!["--fixture-exit".into()], None);
    h.wait_text(&first.id, "READY");
    quit_left_shell(&h, &first.id);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !matches!(
        h.request(Request::Snapshot),
        Reply::Snapshot { ref sessions, .. }
            if sessions.iter().any(|s| s.id == first.id && s.state != SessionState::Running)
    ) {
        assert!(Instant::now() < deadline, "first run did not exit");
        thread::sleep(Duration::from_millis(10));
    }
    let resumed = start(vec![], first.agent_session_id.clone());
    let marker = "resumed; earlier output above".as_bytes();
    let until = Instant::now() + Duration::from_secs(5);
    let data = loop {
        let (data, _) = read_from_zero(&h, &resumed.id);
        if find(&data, marker, 0).is_some_and(|m| find(&data, b"READY", m).is_some()) {
            break data;
        }
        assert!(
            Instant::now() < until,
            "resumed replay lacks seed, marker or READY"
        );
        thread::sleep(Duration::from_millis(20));
    };
    let first_ready = find(&data, b"READY", 0).unwrap();
    assert!(first_ready < find(&data, marker, 0).unwrap());
    assert!(find(&data, b"--fixture-exit", 0).is_some_and(|i| i < first_ready));
}

// v1a-74 (needs 79): the history setting and its mask, through the core's settings request.
fn history(h: &Harness, keep: Option<bool>, mask: Option<bool>) -> LifetimeSettings {
    match h.request(Request::QuitSettings {
        patch: LifetimePatch {
            keep_history: keep,
            mask_history: mask,
            ..Default::default()
        },
    }) {
        Reply::QuitSettings { settings } => settings,
        _ => panic!("wrong reply"),
    }
}

fn wait_exit(h: &Harness, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !matches!(
        h.request(Request::Snapshot),
        Reply::Snapshot { ref sessions, .. }
            if sessions.iter().any(|s| s.id == id && s.state != SessionState::Running)
    ) {
        assert!(Instant::now() < deadline, "session did not exit");
        thread::sleep(Duration::from_millis(10));
    }
}

// v1a-74
#[test]
fn history_off_writes_no_scrollback_and_removes_old_files() {
    let mut h = Harness::new();
    let folder = h.home.join("scrollback");
    let old = h.start(&["/bin/sh", "-c", "printf 'MARK-OLD'; exec /bin/cat"]);
    h.wait_text(&old.id, "MARK-OLD");
    restart_core(&mut h);
    assert!(folder.join(&old.id).exists());
    std::fs::write(folder.join("no-such-session"), b"old").unwrap();
    // Off: written first, then every file under scrollback/ goes, before the reply.
    assert!(!history(&h, Some(false), None).keep_history);
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);

    let exited = h.start(&["/bin/sh", "-c", "printf 'MARK-EXIT'"]);
    wait_exit(&h, &exited.id);
    let live = h.start(&["/bin/sh", "-c", "printf 'MARK-LIVE'; exec /bin/cat"]);
    h.wait_text(&live.id, "MARK-LIVE");
    // The live screen and this core's memory are unchanged.
    assert!(find(&read_from_zero(&h, &exited.id).0, b"MARK-EXIT", 0).is_some());
    std::fs::write(folder.join(&live.id), b"planted").unwrap();
    restart_core(&mut h);
    assert!(!folder.join(&exited.id).exists(), "exit wrote scrollback");
    assert!(!folder.join(&live.id).exists(), "stop or start kept a file");
    assert!(no_view(&h, &live.id), "a restarted core read stale bytes");

    // A symlinked folder is still not followed.
    let elsewhere = h.home.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::write(elsewhere.join(&live.id), b"keep").unwrap();
    std::fs::remove_dir_all(&folder).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &folder).unwrap();
    restart_core(&mut h);
    assert!(elsewhere.join(&live.id).exists());
}

// v1a-74: the default keeps V1A-40's raw bytes, a secret-shaped word included.
#[test]
fn history_on_unmasked_is_unchanged() {
    let mut h = Harness::new();
    let settings = history(&h, None, None);
    assert!(settings.keep_history && !settings.mask_history);
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'KEY sk-ant-TEST0000000000abcdef API_KEY=plainvalue42 END'; exec /bin/cat",
    ]);
    h.wait_text(&s.id, "END");
    let (live, _) = read_from_zero(&h, &s.id);
    restart_core(&mut h);
    assert_eq!(
        std::fs::read(h.home.join("scrollback").join(&s.id)).unwrap(),
        live
    );
}

// v1a-74
#[test]
fn masked_history_hides_a_token_on_disk_but_not_on_screen() {
    let mut h = Harness::new();
    assert!(history(&h, None, Some(true)).mask_history);
    let s = h.start(&[
        "/bin/sh",
        "-c",
        "printf 'KEY sk-ant-TEST0000000000abcdef\\nAPI_KEY=plainvalue42\\nEND'; exec /bin/cat",
    ]);
    h.wait_text(&s.id, "END");
    let live = h.read(&s.id);
    assert!(live.contains("sk-ant-TEST0000000000abcdef") && live.contains("plainvalue42"));
    restart_core(&mut h);
    let saved = std::fs::read(h.home.join("scrollback").join(&s.id)).unwrap();
    assert!(find(&saved, b"KEY [redacted:anthropic]", 0).is_some());
    assert!(find(&saved, b"API_KEY=[redacted:secret]", 0).is_some());
    assert!(find(&saved, b"TEST0000000000abcdef", 0).is_none());
    assert!(find(&saved, b"plainvalue42", 0).is_none());
    let restored = h.read(&s.id);
    assert!(restored.contains("[redacted:anthropic]") && !restored.contains("plainvalue42"));
}

// v1a-74: only secret text becomes a marker; colour and cursor sequences stay byte for byte.
#[test]
fn masking_keeps_escape_sequences() {
    let mut h = Harness::new();
    history(&h, None, Some(true));
    let s = h.start(&[
        "/bin/sh",
        "-c",
        concat!(
            r"printf '\033[2J\033[1;1H\033[31msk-ant-TEST0000000000abcdef\033[0m\r\n",
            r"password=\033[1mhunter2secret\033[0m\r\n",
            r#"Authorization: Basic abc\033[32mdef\033[0m ghi\r\nEND'; exec /bin/cat"#
        ),
    ]);
    h.wait_text(&s.id, "END");
    let (live, _) = read_from_zero(&h, &s.id);
    restart_core(&mut h);
    let saved = std::fs::read(h.home.join("scrollback").join(&s.id)).unwrap();
    let escapes = |b: &[u8]| -> Vec<Vec<u8>> {
        let mut out = vec![];
        let mut i = 0;
        while let Some(at) = find(b, b"\x1b", i) {
            let end = at
                + 2
                + b[at + 2..]
                    .iter()
                    .position(|c| (0x40..=0x7e).contains(c))
                    .unwrap();
            out.push(b[at..=end].to_vec());
            i = end + 1;
        }
        out
    };
    assert_eq!(escapes(&saved), escapes(&live));
    // Each marker put back as the text it hides gives the live bytes.
    let mut unmasked = String::from_utf8(saved).unwrap();
    for (marker, text) in [
        ("[redacted:anthropic]", "sk-ant-TEST0000000000abcdef"),
        (
            "[redacted:authorization]\x1b[32m\x1b[0m",
            "Basic abc\x1b[32mdef\x1b[0m ghi",
        ),
    ] {
        assert!(unmasked.contains(marker), "{marker}");
        unmasked = unmasked.replacen(marker, text, 1);
    }
    let hunter = "\x1b[1mhunter2secret\x1b[0m";
    assert!(String::from_utf8_lossy(&live).contains(hunter));
    assert!(!unmasked.contains("hunter2secret"));
    assert_eq!(
        unmasked
            .replace(
                "password=\x1b[1m[redacted:secret]\x1b[0m",
                &format!("password={hunter}")
            )
            .into_bytes(),
        live
    );
}

// v1a-74: an older settings.json without the keys keeps history, unmasked.
#[test]
fn settings_round_trip_keeps_history_defaults() {
    let h = Harness::configured(Some(r#"{"start_at_login":false}"#));
    let read = history(&h, None, None);
    assert!(read.keep_history);
    assert!(!read.mask_history);
    let set = history(&h, None, Some(true));
    assert!(set.keep_history && set.mask_history);
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(h.home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(file["mask_history"], true);
    assert!(
        file.get("keep_history").is_none(),
        "an unpatched key was written"
    );
}

// v1a-74: turning history off deletes only entries of scrollback/, never through a link.
#[test]
fn history_off_delete_stays_inside_scrollback() {
    let h = Harness::new();
    let folder = h.home.join("scrollback");
    std::fs::create_dir_all(&folder).unwrap();
    let outside = h.home.join("outside");
    std::fs::write(&outside, b"keep").unwrap();
    std::os::unix::fs::symlink(&outside, folder.join("link")).unwrap();
    history(&h, Some(false), None);
    assert!(
        folder.join("link").symlink_metadata().is_err(),
        "the link stays"
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"keep");

    history(&h, Some(true), None);
    let elsewhere = h.home.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("x"), b"keep").unwrap();
    std::fs::remove_dir_all(&folder).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &folder).unwrap();
    history(&h, Some(false), None);
    assert!(elsewhere.join("x").exists());
    assert!(folder.symlink_metadata().unwrap().file_type().is_symlink());
}

// v1a-74: refresh (an exit), stop (save all) and Close each write nothing with history off.
#[test]
fn every_scrollback_save_path_honours_keep_history() {
    let mut h = Harness::configured(Some(r#"{"keep_history":false}"#));
    assert!(!history(&h, None, None).keep_history);
    let folder = h.home.join("scrollback");
    let exited = h.start(&["/bin/sh", "-c", "printf 'MARK-EXIT'"]);
    wait_exit(&h, &exited.id);
    assert!(!folder.join(&exited.id).exists(), "refresh wrote a file");
    let closed = h.start(&["/bin/sh", "-c", "printf 'MARK-CLOSE'; exec /bin/cat"]);
    h.wait_text(&closed.id, "MARK-CLOSE");
    h.request(Request::Close {
        id: closed.id.clone(),
    });
    assert!(!folder.join(&closed.id).exists(), "Close wrote a file");
    let stopped = h.start(&["/bin/sh", "-c", "printf 'MARK-STOP'; exec /bin/cat"]);
    h.wait_text(&stopped.id, "MARK-STOP");
    // Looked at before a new core starts: its start sweep would hide a file the stop wrote.
    h.request(Request::Stop);
    h.core.wait().unwrap();
    assert!(
        std::fs::read_dir(&folder).map_or(true, |d| d.count() == 0),
        "stop wrote a file"
    );
}

// Ticket 573: the `nunchiro` CLI as an outside script runs it (owner token, no session of its own).
fn cli(h: &Harness, args: &[&str]) -> std::process::Output {
    home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(args)
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .output()
        .unwrap()
}
fn git_repo(dir: &std::path::Path) {
    std::fs::create_dir(dir).unwrap();
    for args in [
        &["init", "-q"][..],
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("git")
                .current_dir(dir)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
}

// Ticket 1054: with no --base, a new branch starts at origin's default tip, not at a detached HEAD behind it; a repo
// with no remote starts it at HEAD.
#[test]
fn worktree_create_defaults_to_origins_default_branch() {
    let h = Harness::new();
    let git = |dir: &std::path::Path, args: &[&str]| -> String {
        let out = home::git_env::scrubbed("git")
            .current_dir(dir)
            .args(["-c", "user.name=F", "-c", "user.email=f@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let up = h.home.join("up");
    git_repo(&up);
    git(&up, &["commit", "--allow-empty", "-qm", "ahead"]);
    let tip = git(&up, &["rev-parse", "HEAD"]);
    git(&h.home, &["clone", "-q", up.to_str().unwrap(), "repo"]);
    let project = h.home.join("repo");
    git(&project, &["checkout", "-q", "--detach", "HEAD~1"]);
    let plain = h.home.join("plain");
    git_repo(&plain);
    git(&plain, &["commit", "--allow-empty", "-qm", "second"]);
    let head = git(&plain, &["rev-parse", "HEAD"]);
    for (repo, want) in [(&project, &tip), (&plain, &head)] {
        let out = cli(
            &h,
            &[
                "worktree",
                "create",
                "--json",
                "--project",
                repo.to_str().unwrap(),
                "--branch",
                "b-def",
            ],
        );
        assert!(out.status.success(), "{out:?}");
        assert_eq!(&git(repo, &["rev-parse", "b-def"]), want, "{out:?}");
    }
}

// Ticket 573 slice 1: `worktree create --path` makes the worktree there (CLI -> socket -> core); a path outside the
// project's worktree folder, nested, hidden, or already there is refused and nothing is made.
#[test]
fn worktree_create_honours_path_and_refuses_others() {
    let h = Harness::new();
    let project = h.home.join("repo");
    git_repo(&project);
    let project_arg = project.to_str().unwrap();
    let under = h.home.join("user/nunchiro/worktrees/repo");
    let create = |branch: &str, path: &std::path::Path| {
        cli(
            &h,
            &[
                "worktree",
                "create",
                "--project",
                project_arg,
                "--branch",
                branch,
                "--path",
                path.to_str().unwrap(),
            ],
        )
    };
    let named = under.join("named-one");
    let out = create("b-one", &named);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let named = std::fs::canonicalize(&named).unwrap();
    let branch = home::git_env::scrubbed("git")
        .current_dir(&named)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&branch.stdout).trim(), "b-one");
    assert!(String::from_utf8_lossy(&out.stdout).contains(named.to_str().unwrap()));

    std::fs::create_dir(h.home.join("elsewhere")).unwrap();
    std::fs::create_dir(under.join("plain-dir")).unwrap();
    // Ticket 1061: the old default root is there but no record of this project uses it.
    std::fs::create_dir_all(h.home.join("worktrees/repo")).unwrap();
    std::os::unix::fs::symlink(h.home.join("elsewhere"), under.join("link")).unwrap();
    for (n, path) in [
        under.join("link/x"),       // a symlinked parent that leads outside the root
        h.home.join("elsewhere/x"), // outside every worktree root
        h.home.join("user/nunchiro/worktrees/x"), // the root itself, not the project's folder
        h.home.join("worktrees/repo/x"), // the old default root, which no record of this project uses
        under.join("deep/x"),            // nested
        under.join(".hidden"),           // hidden name
        under.join("plain-dir"),         // a folder that is there
        under.join("named-one"),         // a recorded worktree
        under.join("x/.."),              // not a plain name
    ]
    .iter()
    .enumerate()
    {
        let branch = format!("refused-{n}");
        let out = create(&branch, path);
        assert!(!out.status.success(), "{path:?} was accepted");
        let exists = home::git_env::scrubbed("git")
            .current_dir(&project)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .status()
            .unwrap()
            .success();
        assert!(!exists, "{path:?} made a branch");
    }
    assert!(!h.home.join("elsewhere/x").exists() && !under.join("deep").exists());
    // A relative `--path` is the caller's: the CLI makes it absolute before the core sees it.
    let out = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["worktree", "create", "--project", project_arg])
        .args(["--branch", "b-rel", "--path", "../rel-one"])
        .current_dir(under.join("plain-dir"))
        .env("NUNCHIRO_HOME", &h.home)
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(under.join("rel-one/.git").exists());
    let Reply::Worktrees { worktrees, .. } = h.request(Request::Worktree {
        operation: "list".into(),
        project: None,
        path: None,
        branch: None,
        base: "HEAD".into(),
        label: String::new(),
        from: None,
        confirm: None,
    }) else {
        panic!("wrong reply");
    };
    assert_eq!(worktrees.len(), 2);

    // Round 2: a record under the old root (made while an absolute setting pointed there) keeps that root allowed
    // after the setting is unset, as for every worktree made before ticket 1061.
    let dir = |d: String| {
        h.request(Request::QuitSettings {
            patch: LifetimePatch {
                worktrees_dir: Some(d),
                ..Default::default()
            },
        })
    };
    dir(h.home.join("worktrees").to_str().unwrap().into());
    let out = cli(
        &h,
        &[
            "worktree",
            "create",
            "--project",
            project_arg,
            "--branch",
            "b-old",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    dir(String::new());
    let old = h.home.join("worktrees/repo/again");
    let out = create("b-again", &old);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(old.join(".git").exists());
}

// Ticket 573 slice 1: `agent start --env` reaches the agent process (a shell fake agent prints it); a refused name
// starts nothing. Ticket 595: only allow-list names pass.
#[test]
fn agent_start_env_reaches_the_agent_and_refused_keys_start_nothing() {
    let h = Harness::new();
    let project = h.home.to_str().unwrap();
    let out = cli(
        &h,
        &[
            "agent",
            "start",
            "env-fixture",
            "--kind",
            "shell",
            "--project",
            project,
            "--env",
            "LANE_TASK=five=5",
            "--env",
            "TASK_EMPTY=",
            "--",
            "/bin/sh",
            "-c",
            "printf 'TASK:%s EMPTY:%s.\\n' \"$LANE_TASK\" \"${TASK_EMPTY-unset}\"; exec /bin/cat",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let Reply::Started { session } = serde_json::from_slice(&out.stdout).unwrap() else {
        panic!("not started");
    };
    h.wait_text(&session.id, "TASK:five=5 EMPTY:.");
    let count = || match h.request(Request::List) {
        Reply::Snapshot { sessions, .. } => sessions.len(),
        _ => panic!("wrong reply"),
    };
    let before = count();
    for (pair, says) in [
        ("GITHUB_TOKEN=x", "secret"),
        ("my_api_key=x", "secret"),
        ("PATH=/tmp", "not on the allow list"),
        ("HOME=/tmp", "not on the allow list"),
        ("NUNCHIRO_SESSION=x", "not on the allow list"),
        ("SSL_CERT_FILE=/tmp/x", "not on the allow list"),
        ("1BAD=x", "invalid"),
    ] {
        let out = cli(
            &h,
            &[
                "agent",
                "start",
                "refused",
                "--kind",
                "shell",
                "--project",
                project,
                "--env",
                pair,
                "--",
                "/bin/cat",
            ],
        );
        assert!(!out.status.success(), "{pair} was accepted");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(says),
            "{pair}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    // Round 2: an ACP agent does not take `--env` yet; refused, not dropped.
    let out = cli(
        &h,
        &[
            "session",
            "start",
            "--agent",
            "acp:any",
            "--project",
            project,
            "--env",
            "LANE=1",
        ],
    );
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("ACP agent does not take --env"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(count(), before);
    h.request(Request::Close { id: session.id });
}
