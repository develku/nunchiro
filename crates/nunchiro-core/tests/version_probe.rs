//! V1A-89: the core's `<agent> --version` probe is off the Start critical path. A real `nunchiro serve` runs with a
//! fake `claude` on PATH whose `--version` answers at once, fails, or blocks on a fifo the test releases (no sleeps
//! tuned to the host).
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
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
    project: PathBuf,
    process: Child,
}
impl Core {
    /// `version` is the shell run for `claude --version`; any other start waits for one line.
    fn new(tag: &str, version: &str) -> Self {
        let home = home::short(tag);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(
            bin.join("claude"),
            format!("#!/bin/sh\ncase \"$1\" in --version) {version};; esac\nread line\n"),
        )
        .unwrap();
        fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        let project = home.join("proj");
        fs::create_dir_all(home.join("u")).unwrap();
        fs::create_dir_all(&project).unwrap();
        let core = Self {
            process: serve(&home),
            home,
            project,
        };
        let until = Instant::now() + Duration::from_secs(30);
        while call(&core.home, Request::Snapshot).is_err() {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(20));
        }
        core
    }
    fn fifo(&self) -> PathBuf {
        let fifo = self.home.join("release");
        let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        fifo
    }
    fn start(&self) -> Session {
        match call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    kind: AgentKind::Claude,
                    project: self.project.clone(),
                    worktree: false,
                    label: String::new(),
                    args: vec![],
                    model: None,
                    effort: None,
                    resume: None,
                    account: None,
                },
            },
        ) {
            Ok(Reply::Started { session }) => session,
            other => panic!("start failed: {other:?}"),
        }
    }
    fn session(&self, id: &str) -> Session {
        match call(&self.home, Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
            _ => panic!(),
        }
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
fn serve(home: &Path) -> Child {
    home::git_env::scrubbed(cli())
        .arg("serve")
        .env("NUNCHIRO_HOME", home)
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
        .unwrap()
}
/// Lets a `--version` blocked in `read < fifo` go on (its open for reading is already waiting).
fn release(fifo: &Path) {
    let until = Instant::now() + Duration::from_secs(15);
    let mut writer = loop {
        // O_NONBLOCK: ENXIO until the reader has opened the fifo, never a hang.
        match fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(fifo)
        {
            Ok(w) => break w,
            Err(e) => assert!(Instant::now() < until, "probe never opened the fifo: {e}"),
        }
        thread::sleep(Duration::from_millis(20));
    };
    writer.write_all(b"go\n").unwrap();
}

#[test]
fn slow_version_does_not_fail_start() {
    let core = Core::new("vpslow", "");
    let fifo = core.fifo();
    let body = format!("read x < '{}'; echo 'slow 1.0'; exit 0", fifo.display());
    fs::write(
        core.home.join("bin/claude"),
        format!("#!/bin/sh\ncase \"$1\" in --version) {body};; esac\nread line\n"),
    )
    .unwrap();
    // The fifo is released only after Start answers, so the probe outlives the old 3 s budget by construction.
    let s = core.start();
    assert_eq!(s.state, SessionState::Running);
    assert_eq!(s.agent_version, None, "Start waited for the probe");
    release(&fifo);
    let until = Instant::now() + Duration::from_secs(30);
    let s = loop {
        let s = core.session(&s.id);
        if s.agent_version.is_some() {
            break s;
        }
        assert!(Instant::now() < until, "the version never filled in");
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(s.agent_version.as_deref(), Some("slow 1.0"));
    assert!(s.untested, "slow 1.0 is not a tested version");
}

#[test]
fn wrong_version_handled_as_today() {
    let core = Core::new("vpwrong", "exit 1");
    let s = core.start();
    assert_eq!(s.agent_version.as_deref(), Some("unknown"));
    assert!(s.untested);
    let core = Core::new("vpright", "echo '2.1.311 (Claude Code)'; exit 0");
    let s = core.start();
    assert_eq!(s.agent_version.as_deref(), Some("2.1.311 (Claude Code)"));
}

#[test]
fn hung_binary_does_not_block_start() {
    let core = Core::new("vphung", "");
    let fifo = core.fifo();
    let body = format!("read x < '{}'; exit 0", fifo.display());
    fs::write(
        core.home.join("bin/claude"),
        format!("#!/bin/sh\ncase \"$1\" in --version) {body};; esac\nread line\n"),
    )
    .unwrap();
    let s = core.start();
    assert_eq!(s.state, SessionState::Running);
    assert_eq!(s.agent_version, None);
    // The ceiling's kill is proved by the unit test `version_probe_kills_a_hung_binary_at_the_ceiling`; here the
    // probe is let go so it never outlives the test.
    release(&fifo);
}
