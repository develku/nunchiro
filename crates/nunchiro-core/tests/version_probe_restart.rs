//! V1A-91: a core killed while its `--version` probe is held leaves the session's version empty; the next core
//! probes again for the agent it reattached. A real `nunchiro serve` runs with a fake `claude` on PATH whose first
//! `--version` blocks on a fifo the test releases (no sleeps tuned to the host).
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
fn ready(home: &Path) {
    let until = Instant::now() + Duration::from_secs(30);
    while call(home, Request::Snapshot).is_err() {
        assert!(Instant::now() < until, "core did not become ready");
        thread::sleep(Duration::from_millis(20));
    }
}
fn session(home: &Path, id: &str) -> Session {
    match call(home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions.into_iter().find(|s| s.id == id).unwrap(),
        _ => panic!(),
    }
}
/// Lets every `--version` blocked on `fifo` go on: writer first (a reader blocked in open goes on), then unlink (a
/// later open fails instead of blocking), then data and close (each reader gets it or end of file).
fn release_all(fifo: &Path) {
    let writer = fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(fifo);
    let _ = fs::remove_file(fifo);
    if let Ok(mut writer) = writer {
        let _ = writer.write_all(b"go\n");
    }
}
/// Stops the core and, on every path a failing test takes too, releases the probe child the killed core left.
struct Stop(PathBuf, Child);
impl Drop for Stop {
    fn drop(&mut self) {
        release_all(&self.0.join("release"));
        let _ = home::git_env::scrubbed(cli())
            .args(["serve", "stop", "--yes"])
            .env("NUNCHIRO_HOME", &self.0)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_SESSION")
            .output();
        let _ = self.1.kill();
        let _ = self.1.wait();
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn agent_version_filled_after_restart_mid_probe() {
    let home = home::short("vprestart");
    let bin = home.join("bin");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(home.join("u")).unwrap();
    let project = home.join("proj");
    fs::create_dir_all(&project).unwrap();
    let fifo = home.join("release");
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    // Only the first `--version` (the killed core's) blocks; the next core's answers at once.
    let version = format!(
        "if mkdir '{}/first' 2>/dev/null; then read x < '{}'; fi; echo 'after 1.0'; exit 0",
        home.display(),
        fifo.display()
    );
    fs::write(
        bin.join("claude"),
        format!("#!/bin/sh\ncase \"$1\" in --version) {version};; esac\nread line\n"),
    )
    .unwrap();
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let mut core = Stop(home.clone(), serve(&home));
    ready(&home);
    let s = match call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                kind: AgentKind::Claude,
                project,
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
    };
    assert_eq!(s.agent_version, None, "Start waited for the probe");
    // `kill -9`: the holder keeps the agent, and the probe's answer has no core left to reach.
    core.1.kill().unwrap();
    let _ = core.1.wait();
    core.1 = serve(&home);
    ready(&home);
    // The old probe's child goes on once released; nothing waits for its answer.
    let until = Instant::now() + Duration::from_secs(60);
    while let Err(e) = fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo)
    {
        assert!(Instant::now() < until, "probe never opened the fifo: {e}");
        thread::sleep(Duration::from_millis(20));
    }
    release_all(&fifo);
    let until = Instant::now() + Duration::from_secs(60);
    let s = loop {
        let s = session(&home, &s.id);
        if s.agent_version.is_some() {
            break s;
        }
        assert!(Instant::now() < until, "the version never filled in");
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(
        s.state,
        SessionState::Running,
        "the agent was not reattached"
    );
    assert_eq!(s.agent_version.as_deref(), Some("after 1.0"));
}
