//! S9: the core's CPU while nothing happens: one idle shell session, one window connected over /ws (ticket 463: with the
//! window's periodic reads, and every git process the core starts listed).
//! Run: `cargo test -p nunchiro --release --features measure --test idle_cpu -- --nocapture` (prints the percentage; fails
//! over `NUNCHIRO_IDLE_CPU_MAX`, default 0.5).
#[path = "../../nunchiro-core/tests/fixtures/git_env.rs"]
mod git_env;
use nunchiro_core::{api::*, server::call};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    process::Command,
    thread,
    time::{Duration, Instant},
};

/// The core's CPU time so far (user + system), from `ps -o time=` ("[[D-]H:]M:SS.ss").
fn cpu_secs(pid: u32) -> f64 {
    let out = Command::new("/bin/ps")
        .args(["-o", "time=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim()
        .rsplit(['-', ':'])
        .zip([1.0, 60.0, 3600.0, 86400.0])
        .map(|(part, unit)| part.parse::<f64>().unwrap() * unit)
        .sum()
}

/// A client text frame (client frames must be masked; a zero mask leaves the bytes as they are).
fn frame(text: &str) -> Vec<u8> {
    let mut out = vec![0x81];
    match text.len() {
        n if n < 126 => out.push(0x80 | n as u8),
        n => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
    }
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(text.as_bytes());
    out
}

#[test]
fn idle_core_cpu() {
    measure("fresh", None, false, |home| {
        start(home, home, AgentKind::Shell, "idle")
    });
}

/// The fake `claude` of the real-sized home: answers `--version`, draws a page of work and Claude's input box with its
/// mode footer, then waits.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
case "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac
i=0
while [ $i -lt 40 ]; do echo "step $i: edited src/main.rs, ran cargo test, 212 passed, nothing left to do here"; i=$((i+1)); done
echo '────────────────────────────────────────────────────────────'
echo '❯ Try "fix the failing test"'
echo '────────────────────────────────────────────────────────────'
echo '  ⏸ manual mode on (shift+tab to cycle)'
exec sleep 100000
"#;

fn ok(home: &std::path::Path, request: Request) {
    let reply = call(home, request);
    assert!(reply.is_ok(), "{reply:?}");
}

/// S9 r2: a home the size of the owner's. Earlier runs left 14 Claude rows with turn and decision history (four closed,
/// the rest ended with their core) and a board that has seen them; this run has `LIVE_CLAUDE` live Claude sessions with
/// their input box drawn and a transcript on disk (r3), and one live shell that printed a full screen. The window watches
/// the shell.
#[test]
fn idle_core_cpu_real_home() {
    measure(
        "real home",
        Some(|home| {
            use std::os::unix::fs::PermissionsExt;
            let bin = home.join("bin");
            fs::create_dir_all(&bin).unwrap();
            fs::write(bin.join("claude"), FAKE_CLAUDE).unwrap();
            fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
            for n in 0..14 {
                let s = start(home, home, AgentKind::Claude, &format!("task {n}"));
                for (event, payload) in [
                    ("UserPromptSubmit", serde_json::json!({"turn_id": "t1"})),
                    ("Stop", serde_json::json!({"turn_id": "t1"})),
                    ("UserPromptSubmit", serde_json::json!({"turn_id": "t2"})),
                    (
                        "PermissionRequest",
                        serde_json::json!({"tool_name": "Bash", "tool_input": {"command": format!("cargo test -p n{n}")}}),
                    ),
                ] {
                    let event = event.into();
                    ok(
                        home,
                        Request::Hook {
                            id: s.id.clone(),
                            event,
                            payload,
                        },
                    );
                }
                if n < 4 {
                    ok(home, Request::Close { id: s.id });
                }
            }
            // The owner looked at each finished row on the board (its seen mark), as an owner's home records.
            let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::Snapshot) else {
                panic!("no snapshot");
            };
            for s in sessions {
                let completion_seq = s.completion_seq;
                ok(
                    home,
                    Request::BoardSeen {
                        id: s.id,
                        completion_seq,
                    },
                );
            }
            for title in [
                "Fix the login bug",
                "Ship the board",
                "Write the docs",
                "Idle CPU",
            ] {
                ok(
                    home,
                    Request::BoardAdd {
                        title: title.into(),
                        group: None,
                        reference: None,
                        waits_on: None,
                        attachments: None,
                    },
                );
            }
        }),
        false,
        |home| {
            // S9 r3: the owner's live Claude sessions each have a transcript on disk (the RC's gap to round 2's
            // fixture, whose one live agent had none): the observer finds and follows each.
            let mut live = vec![];
            for n in 0..LIVE_CLAUDE {
                let s = start(home, home, AgentKind::Claude, &format!("live agent {n}"));
                transcript(home, &s);
                ok(
                    home,
                    Request::Hook {
                        id: s.id.clone(),
                        event: "UserPromptSubmit".into(),
                        payload: serde_json::json!({"turn_id": "t1"}),
                    },
                );
                live.push(s.id);
            }
            // Ticket 463: the watched shell works in a repository with uncommitted changes, as the owner's do.
            let shell = start(home, &repo_with_changes(home), AgentKind::Shell, "shell");
            // As a window does: the terminals at a desktop window's size.
            for id in live.iter().chain([&shell.id]) {
                let (cols, rows) = (160, 48);
                ok(
                    home,
                    Request::Resize {
                        id: id.clone(),
                        cols,
                        rows,
                    },
                );
            }
            ok(
                home,
                Request::SendText {
                    id: shell.id.clone(),
                    text: "i=0; while [ $i -lt 60 ]; do echo \"line $i: total 48 drwxr-xr-x  12 owner staff 384 Nov 12 src\"; i=$((i+1)); done\r".into(),
                    seen: vec![],
                    composer: false,
                },
            );
            thread::sleep(Duration::from_secs(3));
            let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::Snapshot) else {
                panic!("no snapshot");
            };
            let states: Vec<_> = sessions.iter().map(|s| format!("{:?}", s.state)).collect();
            println!("S9 real home: {} rows: {states:?}", sessions.len());
            shell
        },
    );
}

/// Ticket 501: the two idle costs 460 and 463 left. The window has the Diff dock open on a shell in a repository with
/// changes (its git facts every 30 s), and a live Codex session named its session id but has no transcript, while
/// `~/.codex/sessions` holds a year of other rollouts, so each search for it walks about 4000 entries.
#[test]
fn idle_core_cpu_diff_dock_and_codex() {
    measure("diff dock and codex", None, true, |home| {
        use std::os::unix::fs::PermissionsExt;
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        // Ticket 1150: asked before its start whether it runs the outward hook, the fake says yes, as every fake
        // `codex` of the tests does (nunchiro-core/tests/fixtures/codex-app-server).
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../nunchiro-core/tests/fixtures/codex-app-server"
        );
        let codex = format!(
            "#!/bin/sh\n[ \"$1\" != app-server ] || exec '{fixture}'\ncase \"$1\" in --version) echo 'codex-cli 0.50.0'; exit 0;; esac\nexec sleep 100000\n"
        );
        fs::write(bin.join("codex"), codex).unwrap();
        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o700)).unwrap();
        for day in 0..365 {
            let dir = home.join(format!(
                "u/.codex/sessions/2026/{:02}/{:02}",
                day / 31 + 1,
                day % 31 + 1
            ));
            fs::create_dir_all(&dir).unwrap();
            for n in 0..10 {
                fs::write(dir.join(format!("rollout-2026-x-{day}-{n}.jsonl")), "{}\n").unwrap();
            }
        }
        let s = start(home, home, AgentKind::Codex, "codex");
        ok(
            home,
            Request::Hook {
                id: s.id,
                event: "SessionStart".into(),
                payload: serde_json::json!({"session_id": "00000000-0000-4000-8000-0000000005a1"}),
            },
        );
        start(home, &repo_with_changes(home), AgentKind::Shell, "shell")
    });
}

/// Live Claude sessions in the real-sized home.
const LIVE_CLAUDE: usize = 4;

/// A Claude transcript where the observer looks for it (`$HOME/.claude/projects/<cwd>/<id>.jsonl`), with a few hundred
/// turns of history already in it.
fn transcript(home: &std::path::Path, s: &Session) {
    let cwd: String = s
        .cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = home.join("u/.claude/projects").join(cwd);
    fs::create_dir_all(&dir).unwrap();
    let id = s.agent_session_id.as_deref().expect("a Claude session id");
    let mut text = String::new();
    for t in 0..300 {
        text += &serde_json::json!({"type": "user", "sessionId": id, "message": {"role": "user", "content": format!("turn {t}: run the tests")}}).to_string();
        text += "\n";
        text += &serde_json::json!({"type": "assistant", "sessionId": id, "message": {"role": "assistant", "content": [{"type": "text", "text": "212 passed, nothing left to do here"}]}}).to_string();
        text += "\n";
    }
    fs::write(dir.join(format!("{id}.jsonl")), text).unwrap();
}

/// Ticket 463: a repository of 300 committed files, one of them since grown by 375 lines and cut by 16, and one
/// untracked file: the session head's change counts and the Artifacts panel's "Files changed" have something to list.
fn repo_with_changes(home: &std::path::Path) -> std::path::PathBuf {
    let repo = home.join("u/repo");
    fs::create_dir_all(repo.join("src")).unwrap();
    let git = |args: &[&str]| {
        let out = git_env::scrubbed("git")
            .current_dir(&repo)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    for n in 0..300 {
        let text: String = (0..40).map(|l| format!("fn f{n}_{l}() {{}}\n")).collect();
        fs::write(repo.join(format!("src/m{n}.rs")), text).unwrap();
    }
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "start"]);
    let grown: String = (16..40)
        .map(|l| format!("fn f0_{l}() {{}}\n"))
        .chain((0..375).map(|l| format!("fn new_{l}() {{}}\n")))
        .collect();
    fs::write(repo.join("src/m0.rs"), grown).unwrap();
    fs::write(repo.join("notes.md"), "draft\n").unwrap();
    repo
}

/// Ticket 463: a `git` first on the core's PATH that writes each run's arguments to `git.log` (in the test home), then
/// runs the real git, so the test counts every git process the idle core starts.
fn count_git(home: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let real = Command::new("/bin/sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let real = String::from_utf8(real.stdout).unwrap().trim().to_string();
    assert!(real.starts_with('/'), "no git on PATH");
    let bin = home.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let log = home.join("git.log");
    fs::write(
        bin.join("git"),
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexec '{real}' \"$@\"\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o700)).unwrap();
}

/// The git runs `count_git` logged so far, one line each.
fn git_runs(home: &std::path::Path) -> Vec<String> {
    fs::read_to_string(home.join("git.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

fn start(
    home: &std::path::Path,
    project: &std::path::Path,
    kind: AgentKind,
    label: &str,
) -> Session {
    match call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind,
                project: project.to_path_buf(),
                worktree: false,
                label: label.into(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session,
        r => panic!("wrong reply {r:?}"),
    }
}

fn spawn_core(home: &std::path::Path) -> std::process::Child {
    let core = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .arg("serve")
        .env("NUNCHIRO_HOME", home)
        .env("HOME", home.join("u"))
        .env("SHELL", "/bin/sh")
        .env("NUNCHIRO_WINDOW_ORIGINS", "http://localhost:1")
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", home.join("bin").display()),
        )
        .env_remove("NUNCHIRO_TOKEN")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    while call(home, Request::Snapshot).is_err() {
        assert!(Instant::now() < until, "core did not start");
        thread::sleep(Duration::from_millis(50));
    }
    core
}

/// Stops the core this test started, by its own handle.
fn stop_core(home: &std::path::Path, mut core: std::process::Child) {
    let _ = call(home, Request::Stop);
    let until = Instant::now() + Duration::from_secs(10);
    while core.try_wait().ok().flatten().is_none() && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    let _ = core.kill();
    let _ = core.wait();
}

/// On a fresh home: `history` (if any) runs on a first core, which then stops, as the owner's earlier runs did; a second
/// core starts on that home, `setup` fills it (returning the session the window watches), one window connects, and
/// the second core's CPU is measured over 60 s of nothing happening. `dock`: the window has the Diff dock open on the
/// watched session too (ticket 501), which asks for the list with its git facts every 30 s.
fn measure(
    name: &str,
    history: Option<fn(&std::path::Path)>,
    dock: bool,
    setup: impl FnOnce(&std::path::Path) -> Session + std::panic::UnwindSafe,
) {
    let home = std::env::temp_dir().join(format!("s9cpu{:x}{}", std::process::id(), name.len()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(home.join("u")).unwrap();
    let home = home.canonicalize().unwrap();
    count_git(&home);
    if let Some(history) = history {
        let core = spawn_core(&home);
        let done = std::panic::catch_unwind(|| history(&home));
        stop_core(&home, core);
        if let Err(e) = done {
            std::panic::resume_unwind(e);
        }
    }
    let core = spawn_core(&home);
    let pid = core.id();
    let result = std::panic::catch_unwind(|| {
        let session = setup(&home);
        // `NUNCHIRO_IDLE_WINDOW=0` leaves the window out, to tell its share from the core's own.
        let window = std::env::var("NUNCHIRO_IDLE_WINDOW").map_or(true, |v| v != "0");
        let received = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        if window {
            let Reply::WindowAuth { port, token } = call(&home, Request::WindowAuth).unwrap()
            else {
                panic!("no window auth");
            };
            let mut ws = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
            ws,
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://localhost:1\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Protocol: nunchiro.v1, nunchiro.token.{token}\r\n\r\n"
        )
        .unwrap();
            let mut head = [0; 12];
            ws.read_exact(&mut head).unwrap();
            assert_eq!(&head, b"HTTP/1.1 101", "window handshake refused");
            // As the window does: watch the session's terminal.
            ws.write_all(&frame(&format!(
                r#"{{"id":1,"watch":"{}","after":0}}"#,
                session.id
            )))
            .unwrap();
            // Ticket 463: as the window does while idle: its heartbeat every second, live PR status on (the owner's
            // setting), the status bar's change counts (`diff_list`, chrome/SessionFacts.tsx) at once and every 30 s,
            // its branch PR (`pr_branch`) every 60 s. Only this thread writes from here on.
            let mut writer = ws.try_clone().unwrap();
            let (id, cwd) = (session.id.clone(), session.cwd.display().to_string());
            thread::spawn(move || {
                let send = |w: &mut TcpStream, n: u64, request: serde_json::Value| {
                    let text = serde_json::json!({"id": n, "request": request}).to_string();
                    w.write_all(&frame(&text)).is_ok()
                };
                send(
                    &mut writer,
                    2,
                    serde_json::json!({"op": "pr_live_set", "on": true}),
                );
                for tick in 0u64.. {
                    let list = serde_json::json!({"op": "diff_list", "session": id});
                    if !send(&mut writer, 10 + tick * 2, list) {
                        break;
                    }
                    // Diff.tsx's timed read while the dock is open: the git button's facts too.
                    let facts = serde_json::json!({"op": "diff_list", "session": id, "git": true});
                    if dock && !send(&mut writer, 1_000_000 + tick, facts) {
                        break;
                    }
                    if tick % 2 == 0 {
                        send(
                            &mut writer,
                            11 + tick * 2,
                            serde_json::json!({"op": "pr_branch", "path": cwd}),
                        );
                    }
                    // The window's `queue_connect` heartbeat (queue/connect.ts), once a second between the reads.
                    for beat in 0..30 {
                        let frame = serde_json::json!({"op": "queue_connect"});
                        if !send(&mut writer, 2_000_000 + tick * 30 + beat, frame) {
                            return;
                        }
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            });
            // Drain what the core pushes so it never blocks on a full socket.
            let mut reader = ws.try_clone().unwrap();
            let counted = received.clone();
            thread::spawn(move || {
                let mut buf = [0; 65536];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    counted.fetch_add(n, std::sync::atomic::Ordering::SeqCst);
                }
            });
        }
        println!("S9 idle CPU ({name}): core pid {pid}, measuring in 10 s");
        thread::sleep(Duration::from_secs(10));
        let (before, at) = (cpu_secs(pid), Instant::now());
        let bytes = received.load(std::sync::atomic::Ordering::SeqCst);
        let gits = git_runs(&home).len();
        // Ticket 463: 60 s, so the window's 30 s and 60 s reads each land in the measure as often as in a minute.
        thread::sleep(Duration::from_secs(60));
        let used = cpu_secs(pid) - before;
        let percent = 100.0 * used / at.elapsed().as_secs_f64();
        let pushed = received.load(std::sync::atomic::Ordering::SeqCst) - bytes;
        let runs = git_runs(&home).split_off(gits);
        println!(
            "S9 idle CPU ({name}, window: {window}): core {used:.2} s over 60 s = {percent:.2}%; window got {pushed} bytes; {} git runs",
            runs.len()
        );
        // Counted by subcommand, after the `-C <dir> -c <key=value>` prefix every core read starts with.
        let mut by: std::collections::BTreeMap<String, usize> = Default::default();
        for run in &runs {
            let words: Vec<&str> = run.split(' ').collect();
            let mut at = 0;
            while matches!(words.get(at), Some(&"-C" | &"-c")) {
                at += 2;
            }
            *by.entry(
                words[at..]
                    .iter()
                    .take(2)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" "),
            )
            .or_default() += 1;
        }
        for (run, n) in by {
            println!("  {n:>3} git {run}");
        }
        // Ticket 463: nothing changed, so the window's reads are answered without git (the 5-minute fallback is later).
        assert!(runs.is_empty(), "the idle core ran git: {runs:?}");
        let max: f64 = std::env::var("NUNCHIRO_IDLE_CPU_MAX")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.5);
        assert!(
            percent < max,
            "idle core used {percent:.2}% CPU (max {max}%)"
        );
    });
    stop_core(&home, core);
    let _ = fs::remove_dir_all(&home);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}
