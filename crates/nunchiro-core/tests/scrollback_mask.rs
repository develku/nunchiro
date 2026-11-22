//! V1A-74 follow-ups: the scrollback mask and write run after the registry lock is released (the tick and the Stop
//! reply drain them), and turning masking on rewrites the plain files of rows that already ended.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const SECRET: &[u8] = b"sk-ant-TEST0000000000abcdef";
const VALUE: &[u8] = b"hunter2plainvalue";

fn scratch(tag: &str) -> PathBuf {
    home::short(&format!("sm-{tag}"))
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Lines with both secret shapes, `size` bytes in all.
fn payload(dir: &Path, size: usize) -> PathBuf {
    let line = [
        b"API_KEY=".as_slice(),
        VALUE,
        b" key ",
        SECRET,
        b" some plain text around them\n",
    ]
    .concat();
    let path = dir.join("payload");
    fs::write(&path, line.repeat(size / line.len() + 1)).unwrap();
    path
}

struct Core {
    home: PathBuf,
    user: PathBuf,
    process: Child,
}
impl Core {
    fn new() -> Self {
        let root = scratch("core");
        let (home, user) = (root.join("home"), root.join("user"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&user).unwrap();
        let process = Self::serve(&home, &user);
        let core = Self {
            home,
            user,
            process,
        };
        core.ready();
        core
    }
    fn serve(home: &Path, user: &Path) -> Child {
        let bin = cli::path();
        home::git_env::scrubbed(bin)
            .arg("serve")
            .env("NUNCHIRO_HOME", home)
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", user)
            .env("ZDOTDIR", user)
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    /// The same home with a fresh core; the Stop reply has already come back.
    fn restart(&mut self) {
        self.process.wait().unwrap();
        self.process = Self::serve(&self.home, &self.user);
        self.ready();
    }
    fn ready(&self) {
        let until = Instant::now() + Duration::from_secs(30);
        while !matches!(
            call(&self.home, Request::Snapshot),
            Ok(Reply::Snapshot { .. })
        ) {
            assert!(Instant::now() < until, "core did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn shell(&self, project: &Path, script: &str) -> Session {
        let Reply::Started { session } = call(
            &self.home,
            Request::Start {
                receipt: None,
                env: Default::default(),
                folder: None,
                session: StartSession {
                    account: None,
                    kind: AgentKind::Shell,
                    project: project.into(),
                    worktree: false,
                    label: "mask".into(),
                    args: vec!["/bin/sh".into(), "-c".into(), script.into()],
                    model: None,
                    effort: None,
                    resume: None,
                },
            },
        )
        .unwrap() else {
            panic!()
        };
        session
    }
    fn read(&self, id: &str) -> Vec<u8> {
        match call(
            &self.home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        ) {
            Ok(Reply::Output { data, .. }) => data,
            other => panic!("{other:?}"),
        }
    }
    fn wait_for(&self, id: &str, mark: &[u8]) {
        let until = Instant::now() + Duration::from_secs(30);
        while !has(&self.read(id), mark) {
            assert!(Instant::now() < until, "no {mark:?} in {id}");
            thread::sleep(Duration::from_millis(100));
        }
    }
    fn state(&self, id: &str) -> Option<SessionState> {
        let Ok(Reply::Snapshot { sessions, .. }) = call(&self.home, Request::Snapshot) else {
            panic!()
        };
        sessions.into_iter().find(|s| s.id == id).map(|s| s.state)
    }
    /// How many of `ids` still run, from one Snapshot.
    fn running(&self, ids: &[String]) -> usize {
        let Ok(Reply::Snapshot { sessions, .. }) = call(&self.home, Request::Snapshot) else {
            panic!()
        };
        sessions
            .iter()
            .filter(|s| ids.contains(&s.id) && s.state == SessionState::Running)
            .count()
    }
    fn mask(&self, on: bool) {
        let reply = call(
            &self.home,
            Request::QuitSettings {
                patch: LifetimePatch {
                    mask_history: Some(on),
                    ..Default::default()
                },
            },
        );
        assert!(matches!(reply, Ok(Reply::QuitSettings { .. })), "{reply:?}");
    }
    fn file(&self, id: &str) -> Option<Vec<u8>> {
        fs::read(self.home.join("scrollback").join(id)).ok()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = call(&self.home, Request::Stop);
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

/// A FIFO the shells of `held` wait on.
fn gate(project: &Path) -> PathBuf {
    let go = project.join("go");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&go)
            .status()
            .unwrap()
            .success()
    );
    go
}

/// V1A-85: the shell holds `go` open before it prints READY, so a `release` that comes before it reads still reaches
/// it. Opening `go` only to read once it was released left a late shell blocked in open (no writer) forever.
// The shell's `read` consumes exactly one line of `go`.
fn held(payload: &Path, go: &Path, before_read: &str) -> String {
    format!(
        "exec 3<>{}; cat {}; printf READY; {before_read}read x <&3",
        go.display(),
        payload.display()
    )
}

/// One line per shell in one write, so every held shell ends within one tick.
// Each held shell's `read` consumes exactly one line, hence one `\n` per shell.
fn release(go: &Path, shells: usize) {
    use std::io::Write;
    let mut gate = fs::OpenOptions::new().write(true).open(go).unwrap();
    gate.write_all(&b"\n".repeat(shells)).unwrap();
}

/// Waits on events, not a window: first every released shell has ended, then each one's file is written. Each bound
/// only breaks a hang, and the save's counts from the last exit, so a slow shell never eats into it (V1A-85: a save
/// takes under a second at load 15; the 60 s failures were shells that never ended).
fn wait_saved(core: &Core, ids: &[String], mut sample: impl FnMut()) {
    let released = Instant::now();
    let mut ended: Option<Instant> = None;
    while !ids.iter().all(|id| core.file(id).is_some()) {
        match (ended, core.running(ids)) {
            (None, 0) => ended = Some(Instant::now()),
            (None, n) => assert!(
                released.elapsed() < Duration::from_secs(60),
                "{n} released shells never left Running"
            ),
            (Some(at), _) => assert!(
                at.elapsed() < Duration::from_secs(60),
                "the exits were never saved"
            ),
        }
        sample();
        thread::sleep(Duration::from_millis(5));
    }
}

/// V1A-90: waits until the observer has read every released-to shell's output (each tick feeds at most 64 KiB per
/// session, so eight 1 MiB replays take a few dozen ticks), so its first big read cannot land inside the timed save.
/// Each feed advances the session's `last_activity` in the Snapshot, so the output is read once none of them has
/// moved for a second (20 ticks), however slow the host's Snapshots are. The 60 s only breaks a hang.
fn settle(core: &Core, ids: &[String]) {
    let (until, quiet) = (
        Instant::now() + Duration::from_secs(60),
        Duration::from_secs(1),
    );
    let (mut seen, mut since) = (Vec::new(), Instant::now());
    loop {
        let Ok(Reply::Snapshot { sessions, .. }) = call(&core.home, Request::Snapshot) else {
            panic!("no snapshot")
        };
        let now: Vec<u64> = sessions
            .iter()
            .filter(|s| ids.contains(&s.id))
            .map(|s| s.attention.last_activity)
            .collect();
        if now != seen {
            (seen, since) = (now, Instant::now());
        } else if since.elapsed() >= quiet {
            return;
        }
        assert!(
            Instant::now() < until,
            "the observer never finished reading"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

/// How long one call takes.
fn timed(f: impl FnOnce()) -> Duration {
    let start = Instant::now();
    f();
    start.elapsed()
}

// Acceptance 1 (threat 5): masking and writing eight 1 MiB replays (8 MiB of mask work, one session token each in the
// redactor) happens after the registry lock is released. Wall time under a loaded host says little, so the bound is
// relative: the longest Snapshot or hook call while the exits are saved stays well under the whole save, which all
// of it would be (one tick holds the lock for every exit) if masking ran under the lock again.
#[test]
fn mask_runs_outside_the_sessions_lock() {
    const SESSIONS: usize = 8;
    let core = Core::new();
    core.mask(true);
    let project = scratch("p1");
    let payload = payload(&project, 1024 * 1024 + 4096);
    // Every shell blocks reading the same FIFO; one write to it ends them all at once, within one tick.
    let go = gate(&project);
    let script = held(&payload, &go, "");
    let ids: Vec<String> = (0..SESSIONS)
        .map(|_| core.shell(&project, &script).id)
        .collect();
    for id in &ids {
        core.wait_for(id, b"READY");
    }
    settle(&core, &ids);
    release(&go, SESSIONS);
    let start = Instant::now();
    let (mut worst, mut samples) = (Duration::ZERO, 0);
    wait_saved(&core, &ids, || {
        worst = worst.max(timed(|| drop(call(&core.home, Request::Snapshot))));
        worst = worst.max(timed(|| {
            drop(call(
                &core.home,
                Request::Hook {
                    id: ids[0].clone(),
                    event: "Notification".into(),
                    payload: serde_json::json!({}),
                },
            ))
        }));
        samples += 1;
    });
    let save = start.elapsed();
    eprintln!("longest Snapshot or hook call {worst:?} of a {save:?} save ({samples} rounds)");
    assert!(
        samples > 0,
        "nothing was measured while the exits were saved"
    );
    for id in &ids {
        let file = core.file(id).unwrap();
        assert!(!has(&file, SECRET) && !has(&file, VALUE), "{id}");
        assert!(has(&file, b"[redacted:"), "{id}");
    }
    // Measured at load 4-5: masking under the lock gives about 0.99 (one round spans the whole save); off the lock
    // about 0.33, the part left under it being the eight 1 MiB snapshots taken on exit.
    assert!(worst * 3 < save * 2, "{worst:?} of {save:?}");
}

// V1A-85 acceptance 1: masked exits are all saved even when the shells are released before they read (the latch is
// held past the release), the shape that left late shells running and failed the 60 s window under load.
#[test]
fn exit_saves_do_not_wait_behind_masking() {
    const SESSIONS: usize = 4;
    let core = Core::new();
    core.mask(true);
    let project = scratch("p3");
    let payload = payload(&project, 256 * 1024);
    let go = gate(&project);
    let script = held(&payload, &go, "sleep 1; ");
    let ids: Vec<String> = (0..SESSIONS)
        .map(|_| core.shell(&project, &script).id)
        .collect();
    for id in &ids {
        core.wait_for(id, b"READY");
    }
    release(&go, SESSIONS);
    wait_saved(&core, &ids, || {});
    for id in &ids {
        let file = core.file(id).unwrap();
        assert!(!has(&file, SECRET) && !has(&file, VALUE), "{id}");
        assert!(has(&file, b"[redacted:") && has(&file, b"READY"), "{id}");
    }
}

// Acceptance 2 (threat 3, V1A-40): the Stop reply comes only after every stopped session's file is written, and the
// next core on the same home loads them.
#[test]
fn stop_reply_after_files_written() {
    let mut core = Core::new();
    core.mask(true);
    let project = scratch("p2");
    let payload = payload(&project, 1024 * 1024);
    let ids: Vec<String> = (0..4)
        .map(|i| {
            let script = format!("cat {}; printf 'TAIL-{i}\\n'; exec cat", payload.display());
            core.shell(&project, &script).id
        })
        .collect();
    for (i, id) in ids.iter().enumerate() {
        core.wait_for(id, format!("TAIL-{i}").as_bytes());
    }
    call(&core.home, Request::Stop).unwrap();
    for (i, id) in ids.iter().enumerate() {
        let file = core.file(id).expect("written before the Stop reply");
        assert!(has(&file, format!("TAIL-{i}").as_bytes()), "{id}");
        assert!(!has(&file, SECRET), "{id}");
    }
    core.restart();
    for (i, id) in ids.iter().enumerate() {
        let replay = core.read(id);
        assert!(has(&replay, format!("TAIL-{i}").as_bytes()), "{id}");
        assert!(has(&replay, b"[redacted:") && !has(&replay, SECRET), "{id}");
    }
}

// Acceptance 4 (threat 1): turning masking on rewrites the plain file of a session that has ended; a running
// session's file waits for its own save, and its screen keeps the real text.
#[test]
fn mask_on_rewrites_ended_rows() {
    let mut core = Core::new();
    let project = scratch("p4");
    let payload = payload(&project, 64 * 1024);
    let ended = core
        .shell(&project, &format!("cat {}; printf DONE", payload.display()))
        .id;
    let running = core
        .shell(
            &project,
            &format!("cat {}; printf DONE; exec cat", payload.display()),
        )
        .id;
    core.wait_for(&running, b"DONE");
    let until = Instant::now() + Duration::from_secs(30);
    while core.file(&ended).is_none() {
        assert!(Instant::now() < until, "the ended shell was never saved");
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(core.state(&ended), Some(SessionState::Exited));
    let plain = core.file(&ended).unwrap();
    assert!(has(&plain, SECRET) && has(&plain, VALUE));
    // As a previous core leaves it for a resumed session.
    let planted = [b"earlier run ".as_slice(), SECRET, b"\n"].concat();
    fs::write(core.home.join("scrollback").join(&running), &planted).unwrap();

    core.mask(true);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let file = core.file(&ended).unwrap();
        if !has(&file, SECRET) && !has(&file, VALUE) {
            assert!(has(&file, b"[redacted:") && has(&file, b"DONE"));
            break;
        }
        assert!(
            Instant::now() < until,
            "the ended row's file still holds a secret"
        );
        thread::sleep(Duration::from_millis(50));
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(core.file(&running).unwrap(), planted);
    assert!(has(&core.read(&running), SECRET));

    call(&core.home, Request::Stop).unwrap();
    core.restart();
    let replay = core.read(&ended);
    assert!(has(&replay, b"[redacted:") && has(&replay, b"DONE"));
    assert!(!has(&replay, SECRET) && !has(&replay, VALUE));
    let replay = core.read(&running);
    assert!(has(&replay, b"[redacted:") && !has(&replay, SECRET));
}
