//! v1a-66: a short core home for tests that start `serve`. macOS `sun_path` holds 103 bytes, and a home under the
//! worktree's `.scratch/` pushes `core.sock` past that once the worktree name is long enough.
#[path = "cli.rs"]
pub mod cli;
#[path = "git_env.rs"]
pub mod git_env;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

/// Shell line a fake agent runs BEFORE it prints anything: the PTY takes bytes unchanged (no CR->LF, no echo, no line
/// buffering) from the first moment. `stty raw` later would also drop OPOST and change how the screen renders, so the
/// fakes keep it where it was and only set the input side early.
#[allow(dead_code)]
pub const FAKE_INPUT_RAW: &str = "stty -icrnl -echo -icanon";

/// A fresh, canonical `ns-<tag>-<pid>-<n>` folder under the system temp dir. Panics when its `core.sock` would not
/// fit, so a long tag fails here instead of as a core that never becomes ready.
pub fn short(tag: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let home = std::env::temp_dir().join(format!(
        "ns-{tag}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let sock = home.join("core.sock");
    assert!(
        sock.as_os_str().len() <= nunchiro_core::server::SOCKET_PATH_MAX,
        "test home too long for core.sock: {}",
        sock.display()
    );
    reap_holders_after_exit(&home);
    home
}

/// A run stopped by a signal (Ctrl-C, a cancelled nextest run) never reaches a harness's Drop, and its core takes the
/// signal as `exit`: the session holders it started outlive it by design (own process group) and their home stays,
/// so they never end. One detached watcher per test process removes the holder sockets of this process's homes once
/// the process is gone; each holder then exits on its own (ticket 416: socket gone for 30 s). The homes stay.
fn reap_holders_after_exit(home: &Path) {
    use std::{io::Write, os::unix::process::CommandExt};
    static LIST: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    let list = LIST.get_or_init(|| {
        let pid = std::process::id().to_string();
        let list = std::env::temp_dir().join(format!("ns-reap-{pid}"));
        // create_new: never follows or truncates a file planted at the name (Codex w21 r1 MUST); none, no watcher.
        fs::OpenOptions::new().write(true).create_new(true).open(&list).ok()?;
        // Its own process group: the signal that ends the run's group does not end the watcher. A symlinked home or
        // holders folder is skipped (Codex w21 r2). shortcut: a swap between the check and rm is not caught; the
        // homes live in the user's private TMPDIR, upgrade to fd-relative unlinks if they ever move out of it.
        std::process::Command::new("/bin/sh")
            .args(["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 1; done; while IFS= read -r h; do [ -L \"$h\" ] || [ -L \"$h/holders\" ] || rm -f \"$h\"/holders/*.sock; done < \"$2\"; rm -f \"$2\""])
            .arg("sh")
            .arg(&pid)
            .arg(&list)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .ok()?;
        Some(list)
    });
    if let Some(list) = list
        && let Ok(mut f) = fs::OpenOptions::new().append(true).open(list)
    {
        let _ = writeln!(f, "{}", home.display());
    }
}

/// Ticket 1002: the core skips a run more than 2 h late. Tests make their entries at time 0 to mean "missed while no
/// core ran", so each such entry is moved to a second ago: the start then catches it up, as one missed just now.
/// `next_ms` is outside the MAC. A file that does not parse is left as it is (the tests of a broken file).
fn missed_just_now(home: &Path) {
    let path = home.join("schedules.json");
    let Ok(mut file) = fs::read(&path).map(|b| serde_json::from_slice::<serde_json::Value>(&b))
    else {
        return;
    };
    let Ok(file) = file.as_mut() else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let mut moved = false;
    for e in file["schedules"].as_array_mut().into_iter().flatten() {
        let due = e["paused"] != true
            && e["next_ms"]
                .as_u64()
                .is_some_and(|n| n + 2 * 3_600_000 < now);
        if due {
            e["next_ms"] = (now - 1000).into();
            moved = true;
        }
    }
    if moved {
        fs::write(&path, serde_json::to_vec_pretty(file).unwrap()).unwrap();
    }
}

/// A `nunchiro serve` a test started. Dropping it (pass, fail or panic) stops that one daemon by its own PID
/// and, on a pass, removes the home. Nothing here matches processes by name.
#[allow(dead_code)]
pub struct ServeGuard {
    pub child: Child,
    pub home: PathBuf,
    stopped: bool,
}

#[allow(dead_code)]
impl ServeGuard {
    /// Stops the daemon now. The home is handed on: a later `serve` on it (a restart) owns it, so this guard's Drop
    /// neither stops that core nor removes the folder.
    pub fn stop(&mut self) {
        self.stopped = true;
        let _ = nunchiro_core::server::call(&self.home, nunchiro_core::api::Request::Stop);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ServeGuard {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        self.stop();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
}

/// Starts `nunchiro serve` on `home` with no stdio and a bare PATH, plus `envs`; returns once the core answers.
#[allow(dead_code)]
pub fn spawn_serve(home: &Path, envs: &[(&str, &str)]) -> ServeGuard {
    missed_just_now(home);
    let bin = cli::path();
    let child = git_env::scrubbed(bin)
        .arg("serve")
        .env("NUNCHIRO_HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_WINDOW_ORIGINS")
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut guard = ServeGuard {
        child,
        home: home.to_path_buf(),
        stopped: false,
    };
    let until = Instant::now() + Duration::from_secs(5);
    while !matches!(
        nunchiro_core::server::call(home, nunchiro_core::api::Request::Snapshot),
        Ok(nunchiro_core::api::Reply::Snapshot { .. })
    ) {
        if Instant::now() >= until {
            guard.stop();
            panic!("core did not become ready");
        }
        thread::sleep(Duration::from_millis(10));
    }
    guard
}
