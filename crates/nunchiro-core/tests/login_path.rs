//! Ticket 575: a core started with the launchd PATH (Finder) and a fake login shell that adds one folder finds the
//! `claude` that lives only there: first-run detection reports it and a started session runs it. The core logs the
//! PATH once and nothing else of the environment.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

fn script(path: &std::path::Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn core_started_with_a_minimal_path_finds_an_agent_the_login_shell_adds() {
    let home = home::short("loginpath");
    let login_bin = home.join("login-bin");
    fs::create_dir_all(&login_bin).unwrap();
    fs::create_dir_all(home.join("proj")).unwrap();
    script(
        &login_bin.join("claude"),
        &format!(
            "case \"$1\" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\ntouch {}/ran\nread line",
            home.display()
        ),
    );
    // The login shell: a banner, then PATH with its own folder first. A secret in its environment must not be logged.
    let shell = home.join("fake-shell");
    script(
        &shell,
        &format!(
            "echo 'rc banner'\nprintf %s __NUNCHIRO_LOGIN_PATH__{}:\"$PATH\"__NUNCHIRO_LOGIN_PATH__",
            login_bin.display()
        ),
    );
    let mut process = home::git_env::scrubbed(home::cli::path())
        .arg("serve")
        .env("NUNCHIRO_HOME", &home)
        .env("HOME", &home)
        .env("SHELL", &shell)
        .env_remove("NUNCHIRO_LOGIN_PATH")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("NUNCHIRO_TEST_SECRET", "hunter2-secret")
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    while call(&home, Request::Snapshot).is_err() {
        assert!(Instant::now() < until, "core did not become ready");
        thread::sleep(Duration::from_millis(20));
    }

    let token = fs::read_to_string(home.join("core.token")).unwrap();
    let mut stream = UnixStream::connect(home.join("core.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let line = json!({"token": token.trim(), "request": {"op": "first_run"}}).to_string() + "\n";
    stream.write_all(line.as_bytes()).unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    let claude = reply["Ok"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["agent"] == "claude")
        .unwrap();
    assert_eq!(claude["found"], true, "{reply}");
    assert_eq!(claude["version"], "2.1.311 (Claude Code)", "{reply}");

    let started = call(
        &home,
        Request::Start {
            env: Default::default(),
            folder: None,
            receipt: None,
            session: StartSession {
                kind: AgentKind::Claude,
                project: home.join("proj"),
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
    let until = Instant::now() + Duration::from_secs(15);
    while !home.join("ran").exists() {
        assert!(Instant::now() < until, "the session never ran the agent");
        thread::sleep(Duration::from_millis(20));
    }

    let log = fs::read_to_string(home.join("logs/core.log")).unwrap();
    let lines: Vec<_> = log.lines().filter(|l| l.contains("login PATH")).collect();
    assert_eq!(lines.len(), 1, "{log}");
    assert!(
        lines[0].contains("(login shell)") && lines[0].contains("login-bin"),
        "{log}"
    );
    assert!(!log.contains("hunter2"), "{log}");

    let _ = process.kill();
    let _ = process.wait();
    let _ = fs::remove_dir_all(&home);
}

/// `nunchiro <args>` with an isolated home, the launchd PATH and `shell` as `$SHELL`; the CLI starts the core itself
/// (the Finder and terminal case). The login-shell step is on (the fixture's `off` is removed).
fn cli(home: &std::path::Path, shell: &std::path::Path, args: &[&str]) -> std::process::Command {
    let mut c = home::git_env::scrubbed(home::cli::path());
    c.args(args)
        .env("NUNCHIRO_HOME", home)
        .env("HOME", home)
        .env("ZDOTDIR", home)
        .env("SHELL", shell)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env_remove("NUNCHIRO_LOGIN_PATH")
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .stdin(Stdio::null());
    c
}
fn stop(home: &std::path::Path, shell: &std::path::Path) {
    let _ = cli(home, shell, &["serve", "stop", "--yes"]).output();
    let _ = fs::remove_dir_all(home);
}
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Ticket 575 round 2 (security MUST 1): a core the CLI starts from a terminal has the terminal as its controlling tty.
/// A real interactive zsh in a process group the terminal does not front stops there (SIGTTIN) and never prints, so
/// the probe runs in a session of its own. `script` gives the CLI a pty, as a Terminal window or an agent session does.
#[cfg(target_os = "macos")]
#[test]
fn core_started_from_a_terminal_reads_the_login_path_of_a_real_interactive_zsh() {
    let zsh = std::path::Path::new("/bin/zsh");
    if !zsh.exists() {
        return;
    }
    let home = home::short("loginpty");
    let started = Instant::now();
    let mut script = std::process::Command::new("/usr/bin/script");
    let out = home::git_env::scrub(&mut script) // ticket 840: the core `snapshot` starts records `open`
        .args(["-q", "/dev/null"])
        .arg(home::cli::path())
        .args(["snapshot", "--json"])
        .env("NUNCHIRO_HOME", &home)
        .env("HOME", &home)
        .env("ZDOTDIR", &home)
        .env("SHELL", zsh)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env_remove("NUNCHIRO_LOGIN_PATH")
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let took = started.elapsed();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let log = fs::read_to_string(home.join("logs/core.log")).unwrap_or_default();
    stop(&home, zsh);
    assert!(text.contains("\"sessions\""), "{text} {log}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    assert!(log.contains("login PATH (login shell)"), "{log}");
}

/// Ticket 575 round 2 (security MUST 2): the CLI waits 5 s for the core. A login shell that takes 8 s must cost the
/// core 3 s at most, start it with the fallback PATH, and leave neither the shell nor its child behind.
#[test]
fn slow_login_shell_does_not_stop_the_core_starting_and_is_killed() {
    let home = home::short("loginslow");
    let pids = home.join("pids");
    let shell = home.join("slow-shell");
    script(
        &shell,
        &format!(
            "echo $$ > {p}\nsleep 8 &\necho $! >> {p}\nwait\nprintf %s __NUNCHIRO_LOGIN_PATH__/late/bin__NUNCHIRO_LOGIN_PATH__",
            p = pids.display()
        ),
    );
    let started = Instant::now();
    let out = cli(&home, &shell, &["snapshot", "--json"])
        .output()
        .unwrap();
    let took = started.elapsed();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let log = fs::read_to_string(home.join("logs/core.log")).unwrap_or_default();
    let recorded: Vec<i32> = fs::read_to_string(&pids)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    // The shell and its `sleep` are gone (the group got SIGKILL); allow a moment for the kernel to reap them.
    let until = Instant::now() + Duration::from_secs(3);
    while recorded.iter().any(|&p| alive(p)) && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    let left: Vec<_> = recorded.iter().filter(|&&p| alive(p)).collect();
    stop(&home, &shell);
    assert!(text.contains("\"sessions\""), "{text} {log}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    assert_eq!(recorded.len(), 2, "the shell and its sleep: {recorded:?}");
    assert!(left.is_empty(), "left behind: {left:?}");
    assert!(log.contains("login PATH (fallback ("), "{log}");
    assert!(!log.contains("/late/bin"), "{log}");
}

/// Ticket 575 round 3: the core's own PATH keeps its priority. A core started with a folder that holds one `claude`
/// first, and a login shell whose PATH puts another `claude` first, runs the first one; a folder only the login shell
/// has is still added (a third `codex` is found there).
#[test]
fn own_path_keeps_priority_and_login_only_folders_are_appended() {
    let home = home::short("loginorder");
    let (own_bin, login_bin) = (home.join("own-bin"), home.join("login-bin"));
    fs::create_dir_all(&own_bin).unwrap();
    fs::create_dir_all(&login_bin).unwrap();
    let version =
        |v: &str| format!("case \"$1\" in --version) echo '{v}'; exit 0;; esac\nread line");
    script(&own_bin.join("claude"), &version("1.0.0 (Claude Code)"));
    script(&login_bin.join("claude"), &version("9.9.9 (Claude Code)"));
    script(&login_bin.join("codex"), &version("codex-cli 0.1.0"));
    let shell = home.join("fake-shell");
    script(
        &shell,
        &format!(
            "printf %s __NUNCHIRO_LOGIN_PATH__{}:\"$PATH\"__NUNCHIRO_LOGIN_PATH__",
            login_bin.display()
        ),
    );
    let mut process = home::git_env::scrubbed(home::cli::path())
        .arg("serve")
        .env("NUNCHIRO_HOME", &home)
        .env("HOME", &home)
        .env("SHELL", &shell)
        .env_remove("NUNCHIRO_LOGIN_PATH")
        .env("PATH", format!("{}:/usr/bin:/bin", own_bin.display()))
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    while call(&home, Request::Snapshot).is_err() {
        assert!(Instant::now() < until, "core did not become ready");
        thread::sleep(Duration::from_millis(20));
    }
    let token = fs::read_to_string(home.join("core.token")).unwrap();
    let mut stream = UnixStream::connect(home.join("core.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let line = json!({"token": token.trim(), "request": {"op": "first_run"}}).to_string() + "\n";
    stream.write_all(line.as_bytes()).unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    let find = |name: &str| {
        reply["Ok"]["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["agent"] == name)
            .unwrap()
            .clone()
    };
    let (claude, codex) = (find("claude"), find("codex"));
    let _ = process.kill();
    let _ = process.wait();
    let _ = fs::remove_dir_all(&home);
    assert_eq!(claude["version"], "1.0.0 (Claude Code)", "{reply}");
    assert_eq!(codex["found"], true, "{reply}");
}
