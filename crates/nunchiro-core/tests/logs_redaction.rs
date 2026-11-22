//! V2-13a: the core's logs under `logs/` are redacted, rotated and owner-only. A real core runs in a child copy of
//! this test binary (stderr routing and the panic hook are process-wide), without agent processes or user config.
#[path = "fixtures/home.rs"]
mod home;
use home::cli;
use nunchiro_core::{api::*, logs, server};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

fn scratch(name: &str) -> PathBuf {
    home::short(&format!("logs-{name}"))
}
fn random() -> String {
    let mut bytes = [0u8; 16];
    use std::io::Read;
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(10));
    }
}
fn start_shell(home: &Path, script: &str) -> String {
    let Reply::Started { session } = server::call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.to_path_buf(),
                worktree: false,
                label: "logs".into(),
                args: vec!["/bin/sh".into(), "-c".into(), script.into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap() else {
        panic!("no session")
    };
    session.id
}
/// Every file under `dir`, recursively, with its contents.
fn files(dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = vec![];
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(files(&path));
        } else {
            let text = String::from_utf8_lossy(&fs::read(&path).unwrap()).into_owned();
            out.push((path, text));
        }
    }
    out
}

/// The child's side: a core in a thread, then each path a secret can take to a log.
#[test]
fn logs_fixture_child() {
    let Some(mode) = std::env::var_os("NUNCHIRO_LOGS_FIXTURE") else {
        return;
    };
    let home = PathBuf::from(std::env::var_os("NUNCHIRO_HOME").unwrap());
    let core = {
        let home = home.clone();
        thread::spawn(move || server::serve_recording(&home))
    };
    wait_for("core", || {
        home.join("window.json").exists()
            && matches!(
                server::call(&home, Request::Snapshot),
                Ok(Reply::Snapshot { .. })
            )
    });
    if mode == "sentinels" {
        let s = fs::read_to_string(home.join("sentinels.txt")).unwrap();
        let s: Vec<&str> = s.lines().collect();
        let (live_a, live_b, shapes) = (s[0], s[1], &s[2..]);
        logs::register(live_a, "session");
        logs::register(live_b, "session");
        // The real tokens: core, window and one session's, each read back the way a careless log line might.
        let core_token = fs::read_to_string(home.join("core.token")).unwrap();
        let window =
            serde_json::to_value(server::call(&home, Request::WindowAuth).unwrap()).unwrap();
        let window = window["token"].as_str().unwrap().to_string();
        let token_file = home.join("session.tok");
        let id = start_shell(
            &home,
            &format!(
                "printf %s \"$NUNCHIRO_TOKEN\" > '{}'; exec /bin/cat",
                token_file.display()
            ),
        );
        wait_for("session token", || {
            fs::read_to_string(&token_file).is_ok_and(|t| t.len() > 16)
        });
        let session_token = fs::read_to_string(&token_file).unwrap();
        fs::write(home.join("window.tok"), &window).unwrap();
        // A fake login output line, an ACP/provider error, a source-command stderr, a plain eprintln.
        eprintln!(
            "login pty: Paste code here if prompted > {live_a} {}",
            shapes.join(" ")
        );
        eprintln!(
            "acp provider error: {}",
            logs::excerpt(&format!(
                "401 Authorization: Bearer {live_b}\nkey={}",
                shapes[0]
            ))
        );
        eprintln!(
            "source command stderr: {}",
            logs::excerpt(&format!(
                "{}\n{live_a}\n{}",
                shapes.join("\n"),
                "x".repeat(4096)
            ))
        );
        eprintln!(
            "plain {live_a} {live_b} core={core_token} window={window} session={session_token}"
        );
        // One token split across two writes to fd 2.
        let (head, tail) = live_a.split_at(live_a.len() / 2);
        let raw = |b: &[u8]| unsafe { libc::write(2, b.as_ptr().cast(), b.len()) };
        raw(format!("split {head}").as_bytes());
        thread::sleep(Duration::from_millis(100));
        raw(format!("{tail} done\n").as_bytes());
        // A panic payload.
        let payload = format!("panic payload {live_b} {}", shapes[0]);
        assert!(thread::spawn(move || panic!("{payload}")).join().is_err());
        // An oversized one is cut like any line.
        let big = format!("big {} {live_b}", "p ".repeat(20_000));
        assert!(thread::spawn(move || panic!("{big}")).join().is_err());
        server::call(&home, Request::Close { id }).unwrap();
    }
    if mode == "rotate" {
        eprintln!("after rotation");
        assert!(thread::spawn(|| panic!("rotated panic")).join().is_err());
    }
    if mode != "serve" {
        server::call(&home, Request::Stop).unwrap();
        core.join().unwrap().unwrap();
        return;
    }
    // "serve": the parent drives the core and stops it.
    core.join().unwrap().unwrap();
}

fn child(home: &Path, mode: &str) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "logs_fixture_child", "--nocapture"])
        .env("NUNCHIRO_LOGS_FIXTURE", mode)
        .env("NUNCHIRO_HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(fs::File::create(home.join("stderr.mirror")).unwrap())
        .spawn()
        .unwrap()
}

struct Run {
    home: PathBuf,
    secrets: Vec<String>,
}
/// The three readers of the shared run; the last to pass removes its home.
fn done(run: &Run) {
    static PASSED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    if PASSED.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 2 {
        let _ = fs::remove_dir_all(&run.home);
    }
}
/// One sentinel run shared by the tests that read its output.
fn sentinels() -> &'static Run {
    static RUN: OnceLock<Run> = OnceLock::new();
    RUN.get_or_init(|| {
        let home = scratch("sentinels");
        let r = random();
        let mut secrets = vec![random(), random()];
        secrets.extend([
            format!("sk-ant-api03-{r}"),
            format!("sk-proj-{r}"),
            format!("ghp_{r}"),
            format!("gho_{r}"),
            format!("xoxb-{r}"),
            format!("AKIA{}", r[..16].to_uppercase()),
            format!("eyJ{}.eyJ{}.{}", &r[..8], &r[8..16], &r[16..]),
        ]);
        fs::write(home.join("sentinels.txt"), secrets.join("\n")).unwrap();
        let status = child(&home, "sentinels").wait().unwrap();
        assert!(
            status.success(),
            "child failed: {}",
            fs::read_to_string(home.join("stderr.mirror")).unwrap()
        );
        for name in ["core.token", "window.tok", "session.tok"] {
            secrets.push(
                fs::read_to_string(home.join(name))
                    .unwrap()
                    .trim()
                    .to_string(),
            );
        }
        Run { home, secrets }
    })
}

#[test]
fn redact_sentinels_every_path() {
    let run = sentinels();
    let logs = files(&run.home.join("logs"));
    let core = &logs
        .iter()
        .find(|(p, _)| p.ends_with("core.log"))
        .unwrap()
        .1;
    for line in [
        "login pty:",
        "acp provider error:",
        "source command stderr:",
        "plain ",
        "split ",
    ] {
        assert!(core.contains(line), "{line} missing from core.log:\n{core}");
    }
    for kind in [
        "session",
        "core",
        "window",
        "anthropic",
        "openai",
        "github",
        "slack",
        "aws",
        "jwt",
        "authorization",
    ] {
        assert!(
            core.contains(&format!("[redacted:{kind}]")),
            "no {kind} marker:\n{core}"
        );
    }
    assert!(core.contains("split [redacted:session] done"), "{core}");
    assert!(
        core.contains(" [cut]"),
        "the long excerpt is capped:\n{core}"
    );
    let mirror = fs::read_to_string(run.home.join("stderr.mirror")).unwrap();
    for (path, text) in logs
        .iter()
        .chain([&(run.home.join("stderr.mirror"), mirror)])
    {
        for secret in &run.secrets {
            assert!(
                !text.contains(secret.as_str()),
                "{secret} in {}",
                path.display()
            );
        }
    }
    done(run);
}

#[test]
fn panic_log_local_redacted() {
    let run = sentinels();
    let panic = fs::read_to_string(run.home.join("logs/panic.log")).unwrap();
    assert!(panic.contains("logs_redaction.rs"), "{panic}");
    assert!(
        panic.contains("panic payload [redacted:session] [redacted:anthropic]"),
        "{panic}"
    );
    assert!(!panic.contains(&run.secrets[1]));
    let big = panic.lines().find(|l| l.contains(": big ")).unwrap();
    assert!(big.len() <= 16 * 1024 + 200, "{} bytes", big.len());
    done(run);
}

#[test]
fn log_files_owner_only() {
    let run = sentinels();
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&run.home.join("logs")), 0o700);
    for (path, _) in files(&run.home.join("logs")) {
        assert_eq!(mode(&path), 0o600, "{}", path.display());
    }
    done(run);
    // The session folder too; its files go with their sessions.
    let home = scratch("modes");
    logs::session(&home, "s1").unwrap().write(b"x\n").unwrap();
    assert_eq!(mode(&home.join("logs/sessions")), 0o700);
    assert_eq!(mode(&home.join("logs/sessions/s1.log")), 0o600);
    // An existing loose file is tightened when opened.
    fs::set_permissions(
        home.join("logs/sessions/s1.log"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    logs::session(&home, "s1").unwrap();
    assert_eq!(mode(&home.join("logs/sessions/s1.log")), 0o600);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn redact_token_pattern_fixture() {
    let home = scratch("fixture");
    let dir = logs::dir(&home).unwrap();
    let fixture = include_str!("fixtures/logs/token-patterns.txt");
    let mut writer = logs::Writer::open(&dir, "fixture.log").unwrap();
    for line in fixture.lines() {
        writer
            .write(line.split_once(' ').unwrap().1.as_bytes())
            .unwrap();
        writer.write(b"\n").unwrap();
    }
    let out = fs::read_to_string(dir.join("fixture.log")).unwrap();
    for (line, (want, _)) in out
        .lines()
        .zip(fixture.lines().map(|l| l.split_once(' ').unwrap()))
    {
        assert!(line.contains(&format!("[redacted:{want}]")), "{line}");
        for fake in ["FAKE", "notreal", "IOSFODNN", "eyJ", "RkFLRT"] {
            assert!(!line.contains(fake), "{line}");
        }
    }
    assert_eq!(out.lines().count(), fixture.lines().count());
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn rotation_caps_core_log() {
    let home = scratch("rotation");
    let dir = logs::dir(&home).unwrap();
    let mut writer = logs::Writer::open(&dir, "core.log").unwrap();
    let line = format!("{}\n", "r".repeat(1023));
    let chunk = line.repeat(1024); // 1 MiB
    for _ in 0..60 {
        writer.write(chunk.as_bytes()).unwrap();
    }
    let mut names: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "core.log",
            "core.log.1",
            "core.log.2",
            "core.log.3",
            "core.log.4"
        ]
    );
    for name in &names {
        let size = fs::metadata(dir.join(name)).unwrap().len();
        assert!(size <= logs::ROTATE_BYTES, "{name} is {size} bytes");
        assert!(size > logs::ROTATE_BYTES - 2048, "{name} is {size} bytes");
    }
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn session_log_deleted_with_session() {
    let home = scratch("session");
    let mut core = child(&home, "serve");
    wait_for("core", || {
        home.join("window.json").exists()
            && matches!(
                server::call(&home, Request::Snapshot),
                Ok(Reply::Snapshot { .. })
            )
    });
    let id = start_shell(&home, "exec /bin/cat");
    let path = home.join(format!("logs/sessions/{id}.log"));
    logs::session(&home, &id)
        .unwrap()
        .write(b"held output\n")
        .unwrap();
    assert!(path.exists());
    server::call(&home, Request::Close { id }).unwrap();
    assert!(!path.exists(), "the session log outlived its session");
    server::call(&home, Request::Stop).unwrap();
    assert!(core.wait().unwrap().success());
    let _ = fs::remove_dir_all(&home);
}

/// v1a-69: a rotation that left `<id>.log.next` behind does not outlive the session.
#[test]
fn remove_session_deletes_the_rotation_leftover() {
    let home = scratch("leftover");
    let dir = home.join("logs/sessions");
    fs::create_dir_all(&dir).unwrap();
    let id = random();
    for name in [
        format!("{id}.log"),
        format!("{id}.log.1"),
        format!("{id}.log.next"),
    ] {
        fs::write(dir.join(name), "x").unwrap();
    }
    logs::remove_session(&home, &id).unwrap();
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    logs::remove_session(&home, &id).unwrap(); // nothing left: NotFound is fine
    let _ = fs::remove_dir_all(&home);
}

/// v1a-69: a probe that connects and closes at once (the CLI's `ensure_core`) leaves no error line in core.log.
#[test]
fn closed_probe_leaves_no_log_line() {
    let home = scratch("probe");
    let mut core = child(&home, "serve");
    wait_for("core", || {
        matches!(
            server::call(&home, Request::Snapshot),
            Ok(Reply::Snapshot { .. })
        )
    });
    for _ in 0..20 {
        drop(std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap());
    }
    // A request after the probes is served after their connection threads started; poll until they ran.
    thread::sleep(Duration::from_millis(500));
    server::call(&home, Request::Snapshot).unwrap();
    let log = fs::read_to_string(home.join("logs/core.log")).unwrap();
    assert!(!log.contains("socket request failed"), "{log}");
    server::call(&home, Request::Stop).unwrap();
    assert!(core.wait().unwrap().success());
    let _ = fs::remove_dir_all(&home);
}

/// v2-13a r2: a log whose next file cannot be opened keeps every older file and says what it dropped.
#[test]
fn rotation_failure_keeps_old_logs() {
    let home = scratch("rotfail");
    let dir = logs::dir(&home).unwrap();
    for i in 1..logs::KEEP {
        fs::write(dir.join(format!("core.log.{i}")), format!("old {i}\n")).unwrap();
    }
    let mut writer = logs::Writer::open(&dir, "core.log").unwrap();
    let line = format!("{}\n", "f".repeat(1023));
    writer.write(line.repeat(10 * 1024).as_bytes()).unwrap(); // exactly 10 MiB, no rotation yet
    // The fault: the next file's name is taken by a folder, so it cannot be opened.
    fs::create_dir(dir.join("core.log.next")).unwrap();
    for _ in 0..8 {
        assert!(writer.write(line.as_bytes()).is_err());
    }
    for i in 1..logs::KEEP {
        assert_eq!(
            fs::read_to_string(dir.join(format!("core.log.{i}"))).unwrap(),
            format!("old {i}\n")
        );
    }
    assert_eq!(
        fs::metadata(dir.join("core.log")).unwrap().len(),
        logs::ROTATE_BYTES
    );
    fs::remove_dir(dir.join("core.log.next")).unwrap();
    writer.write(b"recovered\n").unwrap();
    assert_eq!(
        fs::read_to_string(dir.join("core.log.2")).unwrap(),
        "old 1\n"
    );
    assert!(!dir.join("core.log.5").exists());
    let live = fs::read_to_string(dir.join("core.log")).unwrap();
    assert!(live.starts_with("[logs: 8 lines dropped:"), "{live}");
    assert!(live.ends_with("recovered\n"), "{live}");
    let _ = fs::remove_dir_all(&home);
}

/// A rename that fails mid-chain stops rotation: a rerun would shift the moved files again and wipe them.
#[test]
fn rotation_rename_failure_never_reruns_the_chain() {
    let home = scratch("rotstuck");
    let dir = logs::dir(&home).unwrap();
    for i in 1..logs::KEEP {
        fs::write(dir.join(format!("core.log.{i}")), format!("old {i}\n")).unwrap();
    }
    let mut writer = logs::Writer::open(&dir, "core.log").unwrap();
    let line = format!("{}\n", "g".repeat(1023));
    writer.write(line.repeat(10 * 1024).as_bytes()).unwrap();
    // The fault: the full file is immutable, so the chain shifts `.1`..`.4` and then `core.log -> .1` fails.
    let flags = |f: &str| {
        assert!(
            Command::new("chflags")
                .arg(f)
                .arg(dir.join("core.log"))
                .status()
                .unwrap()
                .success()
        )
    };
    flags("uchg");
    for _ in 0..8 {
        assert!(
            writer
                .write(line.as_bytes())
                .unwrap_err()
                .contains("rotation stopped")
        );
    }
    flags("nouchg");
    for i in 1..logs::KEEP - 1 {
        let shifted = fs::read_to_string(dir.join(format!("core.log.{}", i + 1))).unwrap();
        assert_eq!(shifted, format!("old {i}\n"), "shifted once, never again");
    }
    assert!(!dir.join("core.log.next").exists());
    assert_eq!(
        fs::metadata(dir.join("core.log")).unwrap().len(),
        logs::ROTATE_BYTES
    );
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn rotation_through_the_core_route() {
    let home = scratch("route");
    let dir = logs::dir(&home).unwrap();
    for name in ["core.log", "panic.log"] {
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))
            .unwrap();
        file.set_len(logs::ROTATE_BYTES - 8).unwrap();
        fs::write(dir.join(format!("{name}.1")), "older\n").unwrap();
    }
    let status = child(&home, "rotate").wait().unwrap();
    assert!(status.success());
    for (name, line) in [
        ("core.log", "after rotation"),
        ("panic.log", "rotated panic"),
    ] {
        assert!(
            fs::read_to_string(dir.join(name)).unwrap().contains(line),
            "{name}"
        );
        assert_eq!(
            fs::metadata(dir.join(format!("{name}.1"))).unwrap().len(),
            logs::ROTATE_BYTES - 8
        );
        assert_eq!(
            fs::read_to_string(dir.join(format!("{name}.2"))).unwrap(),
            "older\n"
        );
    }
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn redact_ansi_coloured_errors() {
    let r = random();
    let line = format!(
        "\x1b[1;31merror\x1b[0m: \x1b[31msk-ant-api03-{r}\x1b[0m \x1b]8;;x\x07ghp_{r}\x1b]8;;\x07 \x1b[33mAKIA{}\x1b[0m",
        r[..16].to_uppercase()
    );
    let out = String::from_utf8(logs::redact(line.as_bytes())).unwrap();
    assert!(
        !out.contains(&r) && !out.contains(&r[..16].to_uppercase()),
        "{out:?}"
    );
    for kind in ["anthropic", "github", "aws"] {
        assert!(out.contains(&format!("[redacted:{kind}]")), "{out:?}");
    }
    assert!(
        out.starts_with("\x1b[1;31merror\x1b[0m: \x1b[31m[redacted:anthropic]\x1b[0m"),
        "{out:?}"
    );
}

#[test]
fn redact_key_named_values() {
    let r = random();
    // Shaped like Codex's auth.json, a .env line, a cookie header and a URL query.
    let lines = [
        format!(
            r#"{{"OPENAI_API_KEY":null,"tokens":{{"id_token":"x{r}","access_token":"a{r}","refresh_token":"rt_{r}","account_id":"keep"}}}}"#
        ),
        format!("ANTHROPIC_API_KEY=k{r} DB_PASSWORD='p {r}' client_secret: s{r}"),
        format!("Cookie: session=c{r}; theme=dark"),
        format!("GET /cb?code=1&api_key=q{r}&next=/"),
        format!("x-api-key: h{r}"),
    ];
    let mut lines = lines.to_vec();
    // Colour around the key and the value (jq -C, a CLI's red error), and a JSON escaped quote.
    lines.push(format!(
        "{{\x1b[34;1m\"refresh_token\"\x1b[0m: \x1b[0;32m\"rt_{r}\"\x1b[0m}}"
    ));
    lines.push(format!("\x1b[31mpassword \x1b[0m: z{r}"));
    lines.push(format!(r#"{{"password":"a\"{r}"}}"#));
    for line in &lines {
        let out = String::from_utf8(logs::redact(line.as_bytes())).unwrap();
        assert!(!out.contains(&r), "{out}");
        assert!(out.contains("[redacted:secret]"), "{out}");
    }
    let json = String::from_utf8(logs::redact(lines[0].as_bytes())).unwrap();
    assert!(
        json.contains(r#""account_id":"keep""#) && json.contains(r#""tokens":{"#),
        "{json}"
    );
    // Ordinary words that only look like keys stay.
    let plain = "3.5k tokens; max_tokens=100; the password prompt closed";
    assert_eq!(
        String::from_utf8(logs::redact(plain.as_bytes())).unwrap(),
        plain
    );
}

/// v2-13a r2: a core that cannot start says why to the CLI that started it (its stderr is the CLI's during startup).
#[test]
fn startup_failure_reason_reaches_the_cli() {
    let home = scratch("startup");
    let elsewhere = scratch("startup-target");
    std::os::unix::fs::symlink(&elsewhere, home.join("logs")).unwrap();
    let out = home::git_env::scrubbed(cli::path())
        .args(["session", "list"])
        .env("NUNCHIRO_HOME", &home)
        .env("HOME", &home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success());
    assert!(err.contains("must not be a symlink"), "{err}");
    assert_eq!(
        fs::read_dir(&elsewhere).unwrap().count(),
        0,
        "nothing written through the link"
    );
    let _ = fs::remove_dir_all(&home);
    let _ = fs::remove_dir_all(&elsewhere);
}

/// v2-13a r3: header-like keys ending in `authorization` keep their whole value redacted, Basic included.
#[test]
fn redact_authorization_suffixed_headers() {
    let r = random();
    for line in [
        format!("HTTP_AUTHORIZATION=Basic {r}"),
        format!("X-Authorization: Basic {r} trailing"),
        format!("proxy_authorization= Basic {r}"),
    ] {
        let out = String::from_utf8(logs::redact(line.as_bytes())).unwrap();
        assert!(
            !out.contains(&r) && out.contains("[redacted:authorization]"),
            "{out}"
        );
    }
}

/// A core the test started: killed and reaped on every exit, a failed assertion included, so its pipes and sockets
/// never outlive the test.
struct Reaped(std::process::Child);
impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The descriptors this process holds now (the listing's own handle is the same each time).
fn open_fds() -> usize {
    fs::read_dir("/dev/fd").unwrap().count()
}

/// V1A-80: the scenario of the two tests below. The core's stderr is a pipe nobody reads, then its socket is moved
/// aside so its last step fails; it must exit with its own code.
fn closed_startup_pipe() {
    use std::io::{BufRead, BufReader, Write};
    let home = scratch("epipe");
    let mut core = Reaped(
        home::git_env::scrubbed(cli::path())
            .arg("serve")
            .env("NUNCHIRO_HOME", &home)
            .env("HOME", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    wait_for("core", || {
        home.join("core.sock").exists() && home.join("core.token").exists()
    });
    // The socket file exists from bind, a moment before the core listens on it: connect until it answers. The
    // connection stays up when the socket file moves aside.
    let mut stream = None;
    wait_for("the core to listen", || {
        stream = std::os::unix::net::UnixStream::connect(home.join("core.sock")).ok();
        stream.is_some()
    });
    let mut s = stream.unwrap();
    drop(core.0.stderr.take()); // what the CLI does once the socket answers
    // The core's last step, removing its socket, fails: the path is now a folder (the socket moved aside).
    fs::rename(home.join("core.sock"), home.join("aside.sock")).unwrap();
    fs::create_dir(home.join("core.sock")).unwrap();
    // A core that never answers fails the test after a bound instead of hanging it.
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let token = fs::read_to_string(home.join("core.token")).unwrap();
    let mut line = serde_json::to_vec(&Envelope {
        token,
        request: Request::Stop,
    })
    .unwrap();
    line.push(b'\n');
    s.write_all(&line).unwrap();
    let _ = BufReader::new(s).read_line(&mut String::new());
    // The core exits by itself; one that hangs fails the test after a bound (`Reaped` then kills it).
    let until = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = core.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < until, "the core did not exit");
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status.code(), Some(1), "{status}");
    assert!(
        fs::read_to_string(home.join("logs/core.log"))
            .unwrap()
            .contains("core stopped:")
    );
    let _ = fs::remove_dir_all(&home);
}

/// v2-13a r3: a core whose starting CLI has gone (its stderr a pipe nobody reads) still exits with its own code
/// when it reports an error after the logs route is gone, not 101 from a failed eprintln.
#[test]
fn closed_startup_pipe_does_not_turn_a_late_error_into_a_panic() {
    closed_startup_pipe();
}

/// The child's side of the next test: the scenario alone in a process, so its descriptor count is its own.
#[test]
fn closed_startup_pipe_fd_child() {
    if std::env::var_os("NUNCHIRO_FD_GUARD").is_none() {
        return;
    }
    let before = open_fds();
    closed_startup_pipe();
    assert_eq!(open_fds(), before, "the scenario left descriptors open");
}

/// V1A-80: the scenario returns every descriptor it opened (the core child, its stderr pipe, the socket to the core).
/// It runs in a copy of this binary because the tests of this binary share one process and open descriptors of their
/// own meanwhile.
#[test]
fn closed_startup_pipe_leaks_no_descriptors() {
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "closed_startup_pipe_fd_child", "--nocapture"])
        .env("NUNCHIRO_FD_GUARD", "1")
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    // A name that matches no test would run nothing and still exit 0.
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("1 passed"),
        "the child test did not run: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
