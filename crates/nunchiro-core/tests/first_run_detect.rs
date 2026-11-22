//! V2-5a acceptance `first-run-detect`: the `first_run` op reports, read only, which agents are on the core's PATH, their
//! versions and how many session transcripts each agent's own folder lists. A real `nunchiro serve` runs with a fake
//! `claude` on PATH and no `codex`. The fake `~/.claude` holds a FIFO named like a credentials file: opening it for
//! reading blocks, so a core that opened anything but the transcript names would never answer.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

fn cli() -> PathBuf {
    cli::path()
}

struct Core {
    home: PathBuf,
    process: Child,
}
impl Core {
    fn new(tag: &str) -> Self {
        let home = home::short(tag);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        // The session records its token for the refusal check, then idles.
        fs::write(
            bin.join("claude"),
            format!(
                "#!/bin/sh\ncase \"$1\" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\nprintf %s \"$NUNCHIRO_TOKEN\" > {}/token\nread line\n",
                home.display()
            ),
        )
        .unwrap();
        fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(home.join("u")).unwrap();
        fs::create_dir_all(home.join("proj")).unwrap();
        let process = home::git_env::scrubbed(cli())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", home.join("u"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", home.join("bin").display()),
            )
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let core = Self { home, process };
        let until = Instant::now() + Duration::from_secs(30);
        while call(&core.home, Request::Snapshot).is_err() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    /// One request on the core's socket with `token`, as raw JSON (the owner token is `core.token`).
    fn ask(&self, token: &str, request: Value) -> Value {
        let mut stream = UnixStream::connect(self.home.join("core.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let line = json!({"token": token, "request": request}).to_string() + "\n";
        stream.write_all(line.as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(stream)
            .read_line(&mut reply)
            .expect("the core answered within 10 s");
        serde_json::from_str(&reply).unwrap()
    }
    fn owner(&self) -> String {
        fs::read_to_string(self.home.join("core.token"))
            .unwrap()
            .trim()
            .into()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &self.home)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn agent<'a>(reply: &'a Value, name: &str) -> &'a Value {
    reply["Ok"]["agents"]
        .as_array()
        .unwrap_or_else(|| panic!("no agents in {reply}"))
        .iter()
        .find(|a| a["agent"] == name)
        .unwrap_or_else(|| panic!("no {name} in {reply}"))
}
fn fifo(path: &Path) {
    let c = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
}

#[test]
fn first_run_detect_reports_found_missing_version_and_count() {
    let core = Core::new("frdet");
    // Three transcripts (one unreadable) and a FIFO a read would block on, under the fake ~/.claude.
    let claude = core.home.join("u/.claude");
    fs::create_dir_all(claude.join("projects/-p1")).unwrap();
    for name in ["a", "b"] {
        fs::write(claude.join(format!("projects/-p1/{name}.jsonl")), "{}\n").unwrap();
    }
    let sealed = claude.join("projects/-p1/c.jsonl");
    fs::write(&sealed, "{}\n").unwrap();
    fs::set_permissions(&sealed, fs::Permissions::from_mode(0o000)).unwrap();
    // A subagent transcript is not a session of its own: only `projects/<p>/*.jsonl` count.
    fs::create_dir_all(claude.join("projects/-p1/uuid-1/subagents")).unwrap();
    fs::write(
        claude.join("projects/-p1/uuid-1/subagents/agent-x.jsonl"),
        "{}\n",
    )
    .unwrap();
    fifo(&claude.join(".credentials.json"));
    fifo(&claude.join("projects/-p1/credentials.jsonl.keep"));
    let reply = core.ask(&core.owner(), json!({"op": "first_run"}));
    let claude_row = agent(&reply, "claude");
    assert_eq!(claude_row["found"], true, "{reply}");
    assert_eq!(claude_row["version"], "2.1.311 (Claude Code)", "{reply}");
    assert_eq!(claude_row["sessions"], 3, "{reply}");
    let codex_row = agent(&reply, "codex");
    assert_eq!(codex_row["found"], false, "{reply}");
    assert_eq!(codex_row["version"], Value::Null, "{reply}");
    assert_eq!(codex_row["sessions"], 0, "{reply}");
    // Read only: the folder is as it was left.
    assert!(claude.join("projects/-p1/a.jsonl").exists());
}

/// Q7 point 18: the preflight also reports git. A `git` that does not answer `--version` (macOS's stub without the
/// Command Line Tools) is no git; the machine's own /usr/bin/git is.
#[test]
fn first_run_detect_reports_git() {
    let core = Core::new("frgit");
    let reply = core.ask(&core.owner(), json!({"op": "first_run"}));
    assert_eq!(reply["Ok"]["git"], true, "{reply}");
    let git = core.home.join("bin/git");
    fs::write(
        &git,
        "#!/bin/sh
exit 1
",
    )
    .unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
    let reply = core.ask(&core.owner(), json!({"op": "first_run"}));
    assert_eq!(reply["Ok"]["git"], false, "{reply}");
}

#[test]
fn first_run_detect_refuses_a_session_token() {
    let core = Core::new("frtok");
    let started = call(
        &core.home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                kind: AgentKind::Claude,
                project: core.home.join("proj"),
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
                account: None,
            },
        },
    );
    assert!(matches!(started, Ok(Reply::Started { .. })), "{started:?}");
    let token_file = core.home.join("token");
    let until = Instant::now() + Duration::from_secs(15);
    while fs::read_to_string(&token_file).is_ok_and(|t| t.is_empty()) || !token_file.exists() {
        assert!(Instant::now() < until, "the session never wrote its token");
        thread::sleep(Duration::from_millis(20));
    }
    let session_token = fs::read_to_string(&token_file).unwrap();
    assert_ne!(session_token, core.owner());
    let refused = core.ask(&session_token, json!({"op": "first_run"}));
    assert_eq!(refused["Err"], "operation not granted", "{refused}");
    let allowed = core.ask(&core.owner(), json!({"op": "first_run"}));
    assert!(allowed["Ok"].is_object(), "{allowed}");
}
