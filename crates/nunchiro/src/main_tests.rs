// Only a start from an SSH login where the session matters (macOS, no test home) goes through the login session; a
// restart from the old core's record keeps its place.
#[test]
fn a_core_for_an_ssh_login_starts_in_the_login_session() {
    use super::{CoreStart::*, core_start};
    assert_eq!(core_start(true, true, false), LoginSession);
    assert_eq!(core_start(true, false, false), Direct);
    assert_eq!(core_start(false, true, false), Direct);
    assert_eq!(core_start(true, true, true), Direct);
}
// The job runs this program's internal start once, with the home; paths are written as XML text.
#[test]
fn the_login_job_runs_the_start_once_with_the_home() {
    let job = super::login_job(
        "dev.nunchiro.core-start.7",
        "/opt/a&b/nunchiro",
        "/Users/me/<home>",
    );
    assert!(
        job.contains("<key>Label</key><string>dev.nunchiro.core-start.7</string>"),
        "{job}"
    );
    assert!(
            job.contains("<array><string>/opt/a&amp;b/nunchiro</string><string>serve</string><string>start</string><string>--here</string></array>"),
            "{job}"
        );
    assert!(
        job.contains("<key>NUNCHIRO_HOME</key><string>/Users/me/&lt;home&gt;</string>"),
        "{job}"
    );
    assert!(
        job.contains("<key>RunAtLoad</key><true/>") && !job.contains("KeepAlive"),
        "{job}"
    );
}
// Ticket 1154 round 2 (Codex P2): the group a detached start is asked and stopped by stays this start's own. The
// middle process is kept as a zombie (its pid, the group's id, cannot go to another process) while the program
// is not this process's child; it reads as gone only once the program ended, and is reaped when the handle goes.
#[test]
fn a_detached_start_holds_its_group_id_until_it_is_dropped() {
    // An exited child that is not reaped yet (WNOWAIT leaves it so); false once reaped (ECHILD).
    let unreaped = |pid: u32| {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
        // Safety: info is a valid, zeroed siginfo_t that waitid fills.
        let answer = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, flags) };
        answer == 0 && info.si_pid == pid as libc::pid_t
    };
    let wait = |what: &str, ok: &dyn Fn() -> bool| {
        let until = Instant::now() + Duration::from_secs(10);
        while !ok() {
            assert!(Instant::now() < until, "timed out: {what}");
            thread::sleep(Duration::from_millis(10));
        }
    };
    let mut cmd = Command::new("/bin/sleep");
    cmd.arg("30").stderr(Stdio::piped());
    let (sleep, startup) = spawn_detached(&mut cmd).unwrap();
    assert!(startup.is_some());
    let middle = sleep.0.id();
    wait("the middle process exits", &|| unreaped(middle));
    // The program runs in the middle's group, as launchd's child: `pgrep -g` lists it, `ps` names its parent.
    let members = || {
        let out = Command::new("/usr/bin/pgrep")
            .args(["-g", &middle.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let program = members();
    assert!(!program.is_empty() && !program.contains('\n'), "{program}");
    let parent = Command::new("/bin/ps")
        .args(["-o", "ppid=", "-p", &program])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&parent.stdout).trim(), "1");
    assert!(!sleep.gone());
    sleep.kill();
    wait("the program is gone", &|| sleep.gone());
    // Still held: the id is not free for another group while the handle lives.
    assert!(unreaped(middle));
    drop(sleep);
    assert!(!unreaped(middle), "the middle process is reaped");
}
#[test]
fn the_default_home_is_the_user_one_for_release_and_beside_the_binary_for_debug() {
    let exe = Path::new("/w/target/debug/nunchiro");
    let user = Some(std::ffi::OsString::from("/Users/u"));
    assert_eq!(
        default_home(false, exe, user.clone()).unwrap(),
        Path::new("/Users/u/.nunchiro")
    );
    assert_eq!(
        default_home(true, exe, user).unwrap(),
        Path::new("/w/target/debug/nunchiro-home")
    );
    assert!(default_home(false, exe, None).is_err());
}

#[test]
fn recorded_link_to_this_binary_starts_this_binary() {
    let home = std::env::temp_dir().join(format!("nunchiro-w36-link-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let me = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let link = home.join("exe-link");
    std::os::unix::fs::symlink(&me, &link).unwrap();
    let record = serde_json::json!({"exe": link, "env": {}, "secrets": []});
    std::fs::write(home.join("core.start.json"), record.to_string()).unwrap();
    let start = super::recorded_start(&home).unwrap();
    assert_eq!(start.exe, me);
    let _ = std::fs::remove_dir_all(&home);
}
#[test]
fn loader_vars_never_reach_a_core() {
    for name in [
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
    ] {
        assert!(super::loader_var(name), "{name}");
    }
    for name in ["PATH", "LDFLAGS", "OLD_PWD", "HOME"] {
        assert!(!super::loader_var(name), "{name}");
    }
}

use super::*;
use std::io::{Error, ErrorKind};

// F24 r5: a stamped binary aimed at the owner's home is refused the two commands that swap a core; S7: and starting one.
#[test]
fn rc_cli_refuses_to_swap_the_owners_core() {
    let check = |build, home: &str, what: &str| {
        let args = ["serve".to_string(), what.to_string()];
        refuse_rc_on_owner_home(build, Path::new(home), None, &args)
    };
    // F24 r6: `$HOME/.nunchiro` is a link to a folder whose real path has no `.nunchiro` in it.
    let user_home = env::temp_dir().join(format!("nunchiro-f24-r6-{}", std::process::id()));
    let data = user_home.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let link = user_home.join(".nunchiro");
    std::os::unix::fs::symlink(&data, &link).unwrap();
    let restart = ["serve".to_string(), "restart".to_string()];
    let swap = |home: &Path, known: Option<&Path>| {
        refuse_rc_on_owner_home(Some("20"), home, known, &restart)
    };
    let known = Some(user_home.as_path());
    assert!(swap(&link, None).is_err()); // the default home, caught before the link is resolved
    assert!(swap(&data, known).is_err()); // NUNCHIRO_HOME naming the link's target
    assert!(swap(&data, None).is_ok()); // no other sign that this folder is the owner's
    assert!(swap(&user_home, known).is_ok());
    std::fs::remove_dir_all(&user_home).unwrap();

    let owner = "/Users/someone/.nunchiro";
    let refused = check(Some("20"), owner, "restart").unwrap_err();
    assert!(refused.contains(owner) && refused.contains("Nunchiro terminal"));
    assert!(check(Some("20"), owner, "update").is_err());
    assert!(check(Some("20"), "/Users/someone/.NUNCHIRO", "restart").is_err());
    assert!(check(None, owner, "restart").is_ok());
    assert!(check(Some("20"), "/Users/someone/.nunchiro-rc", "restart").is_ok());
    // S7: an RC build never starts a core on the owner's home; any other build or home may.
    assert!(
        refuse_rc_core_start(Some("20"), Path::new(owner), None)
            .unwrap_err()
            .contains("Nunchiro terminal")
    );
    assert!(refuse_rc_core_start(Some("20"), Path::new("/Users/someone/.NUNCHIRO"), None).is_err());
    assert!(refuse_rc_core_start(None, Path::new(owner), None).is_ok());
    assert!(
        refuse_rc_core_start(
            Some("20"),
            Path::new("/Users/someone/.nunchiro-dev.nunchiro.app.rc"),
            None
        )
        .is_ok()
    );
    assert!(check(Some("20"), owner, "status").is_ok());
}

// F24: an unstamped core (every core before this ticket) is older; an unstamped binary replaces nothing.
#[test]
fn core_is_older_compares_build_stamps() {
    let me = std::env::current_exe().unwrap();
    let older = |mine, started: &serde_json::Value| super::core_is_older(mine, None, started, &me);
    let core = |build: serde_json::Value| serde_json::json!({"exe": me, "build": build});
    assert!(older(Some("20"), &serde_json::json!({"exe": me})));
    assert!(older(Some("20"), &core(19.into())));
    assert!(!older(Some("20"), &core(20.into())));
    assert!(!older(Some("20"), &core(21.into())));
    assert!(!older(None, &core(19.into())));
    assert!(!older(Some("20"), &serde_json::Value::Null));
}

// Ticket 1082: a build swapped in place replaces a core of another commit of this same install, stamped or not; two
// stamps that make this binary the lower one are a downgrade and replace nothing.
#[test]
fn core_is_older_replaces_another_commit_of_this_install() {
    let me = std::env::current_exe().unwrap();
    let older =
        |mine, started: serde_json::Value| super::core_is_older(mine, Some("bbb"), &started, &me);
    assert!(older(None, serde_json::json!({"exe": me, "commit": "aaa"})));
    assert!(older(None, serde_json::json!({"exe": me})));
    assert!(!older(
        None,
        serde_json::json!({"exe": me, "commit": "bbb"})
    ));
    assert!(older(
        Some("20"),
        serde_json::json!({"exe": me, "build": 20, "commit": "aaa"})
    ));
    assert!(!older(
        Some("20"),
        serde_json::json!({"exe": me, "build": 21, "commit": "aaa"})
    ));
}

// F24 r2: an RC CLI run by hand reaches the owner's home; that unstamped core is not an older build of this install.
#[test]
fn core_is_older_leaves_another_install_alone() {
    let me = std::env::current_exe().unwrap();
    for exe in ["/bin/sh", "/no/such/nunchiro"] {
        let other = serde_json::json!({"exe": exe});
        assert!(
            !super::core_is_older(Some("20"), None, &other, &me),
            "{exe}"
        );
        assert!(
            !super::core_is_older(None, Some("abc"), &other, &me),
            "{exe}"
        );
    }
}

// Ticket 379: the update reads the store untyped, so a permission value this build no longer knows cannot stop it.
// Also a next core started by another process: the swap takes it instead of waiting out the 40 s stop limit.
#[test]
fn core_is_older_swap_survives_a_store_with_an_unknown_permission() {
    use std::io::{BufRead, BufReader, Write};
    let home = std::env::temp_dir().join(format!("nunchiro-379-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let me = std::env::current_exe().unwrap();
    let write = |name: &str, text: String| std::fs::write(home.join(name), text).unwrap();
    write("core.lock", String::new());
    write("core.token", "old".into());
    write(
        "core.start.json",
        serde_json::json!({"exe": me, "build": 19}).to_string(),
    );
    write(
            "sessions.json",
            serde_json::json!({"version": 2, "live": {}, "sessions": [
                {"kind": "claude", "state": "running", "mode_state": {"skip": "ask"}, "permission": "no-such-value"}
            ]})
            .to_string(),
        );
    let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    let core = listener.try_clone().unwrap();
    let token = home.join("core.token");
    let older_core = std::thread::spawn(move || {
        // Refuses `exit_if_idle` as a core from before it does, takes `exit`, and the next core is up.
        let mut replies = [
            r#"{"Err":"unknown variant `exit_if_idle`"}"#,
            r#"{"Ok":{"type":"ack"}}"#,
        ]
        .iter();
        let mut reply = replies.next();
        while let Some(text) = reply {
            let (mut peer, _) = core.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&peer).read_line(&mut line).unwrap();
            if !line.is_empty() {
                writeln!(peer, "{text}").unwrap();
                reply = replies.next();
            }
        }
        std::fs::write(token, "new").unwrap();
    });

    let word = super::update_core(&home, Some("20"), &me);

    older_core.join().unwrap();
    assert_eq!(word, Ok("replaced"));
    drop(listener);
    std::fs::remove_dir_all(&home).unwrap();
}

// Ticket 1110: two `serve update`s overlap (the app runs one at each page load). The second meets the old core
// winding down for the first's exit; it waits for the next core instead of failing the install.
#[test]
fn update_waits_out_a_core_already_winding_down() {
    use std::io::{BufRead, BufReader, Write};
    let home = std::env::temp_dir().join(format!("nunchiro-1110-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let me = std::env::current_exe().unwrap();
    let write = |name: &str, text: String| std::fs::write(home.join(name), text).unwrap();
    write("core.lock", String::new());
    write("core.token", "old".into());
    write(
        "core.start.json",
        serde_json::json!({"exe": me, "build": 19}).to_string(),
    );
    let sock = home.join("core.sock");
    let old_core = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let (dir, sock2) = (home.clone(), sock.clone());
    let cores = std::thread::spawn(move || {
        let mut line = String::new();
        while line.is_empty() {
            let (mut peer, _) = old_core.accept().unwrap();
            BufReader::new(&peer).read_line(&mut line).unwrap();
            if !line.is_empty() {
                writeln!(peer, r#"{{"Err":"{}"}}"#, server::NOT_SERVED).unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(200));
        drop(old_core);
        std::fs::remove_file(&sock2).unwrap();
        // The first update's next core comes up.
        std::fs::write(dir.join("core.token"), "new").unwrap();
        std::os::unix::net::UnixListener::bind(&sock2).unwrap()
    });

    let word = super::update_core(&home, Some("20"), &me);

    let next_core = cores.join().unwrap();
    assert_eq!(word, Ok("replaced"));
    drop(next_core);
    std::fs::remove_dir_all(&home).unwrap();
}

// Ticket 1024: `serve update` reads the record with the 1 MiB ceiling of every other read of it. A larger one is
// not read at all, so it names no older core and nothing is asked of the running one (here it would answer busy).
#[test]
fn update_reads_the_start_record_bounded() {
    use std::io::{BufRead, BufReader, Write};
    let home = std::env::temp_dir().join(format!("nunchiro-1024-upd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let me = std::env::current_exe().unwrap();
    std::fs::write(home.join("core.token"), "t").unwrap();
    let record = |pad: usize| {
        let text = serde_json::json!({"exe": me, "build": 19, "pad": " ".repeat(pad)});
        std::fs::write(home.join("core.start.json"), text.to_string()).unwrap();
    };
    let core = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
    std::thread::spawn(move || {
        for peer in core.incoming() {
            let mut peer = peer.unwrap();
            let mut line = String::new();
            BufReader::new(&peer).read_line(&mut line).unwrap();
            if !line.is_empty() {
                writeln!(peer, r#"{{"Err":"{}"}}"#, server::EXIT_BUSY).unwrap();
            }
        }
    });
    // In bounds: an older core of this install, asked to exit.
    record(0);
    assert_eq!(super::update_core(&home, Some("20"), &me), Ok("kept"));
    record(1 << 20);
    assert_eq!(super::update_core(&home, Some("20"), &me), Ok("current"));
    std::fs::remove_dir_all(&home).unwrap();
}

// F24: only what could not survive the swap keeps the old core.
#[test]
fn swap_blockers_counts_live_chats_and_unreachable_holders() {
    let floor = u64::from(nunchiro_core::holder::frame::MIN_COMPATIBLE);
    let store = |kind: &str, state: &str, protocol: u64| {
        serde_json::json!({
            "sessions": [{"kind": kind, "state": state}],
            "live": {"a": {"holder": {"protocol": protocol}}},
        })
    };
    assert_eq!(super::swap_blockers(&store("claude", "running", floor)), 0);
    assert_eq!(super::swap_blockers(&store("acp", "resumable", floor)), 0);
    assert_eq!(super::swap_blockers(&store("acp", "running", floor)), 1);
    assert_eq!(
        super::swap_blockers(&store("claude", "running", floor - 1)),
        1
    );
    assert_eq!(super::swap_blockers(&serde_json::Value::Null), 0);
    let queued = serde_json::json!({"sessions": [{"kind": "shell", "state": "running", "send_queue": [{"id": "s"}]}]});
    assert_eq!(super::swap_blockers(&queued), 1);
}

// Ticket 573: `--env KEY=VALUE` repeats and splits at the first `=`; the core checks the names.
#[test]
fn session_start_env_takes_key_value_pairs() {
    let parse_args = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let start = ["session", "start", "--project", "/tmp"];
    let Ok(Request::Start { env, .. }) = parse_args(
        &[
            &start[..],
            &["--env", "A=1", "--env", "B=x=y", "--env", "C="],
        ]
        .concat(),
    ) else {
        panic!("not a start");
    };
    let pairs: Vec<_> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(pairs, [("A", "1"), ("B", "x=y"), ("C", "")]);
    for bad in [
        &["--env", "NOEQUALS"][..],
        &["--env", "=v"],
        &["--env", "A=1", "--env", "A=2"],
        &["--env"],
    ] {
        assert!(parse_args(&[&start[..], bad].concat()).is_err(), "{bad:?}");
    }
}

// `--anyway` wraps the start, which the core lets past a memory-pressure hold for the owner only.
#[test]
fn session_start_anyway_wraps_the_start() {
    let parse_args = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let Ok(Request::StartAnyway { start }) =
        parse_args(&["session", "start", "--anyway", "--project", "/tmp"])
    else {
        panic!("not a start anyway");
    };
    assert!(matches!(*start, Request::Start { .. }));
    assert!(matches!(
        parse_args(&["session", "start", "--project", "/tmp"]),
        Ok(Request::Start { .. })
    ));
}

// V2-4a
#[test]
fn session_start_agent_acp_names_the_entry_and_takes_no_args() {
    let parse_args = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let Ok(Request::Start {
        session,
        folder: None,
        ..
    }) = parse_args(&[
        "session",
        "start",
        "--agent",
        "acp:gemini",
        "--project",
        "/tmp",
    ])
    else {
        panic!("not a start");
    };
    assert_eq!(session.kind, AgentKind::Acp);
    assert_eq!(session.args, ["gemini"]);
    for refused in [
        &["session", "start", "--agent", "gemini"][..],
        &["session", "start", "--agent", "acp:"],
        &["session", "start", "--agent", "acp:gemini", "--", "--yolo"],
    ] {
        assert!(parse_args(refused).is_err(), "{refused:?}");
    }
}

#[test]
fn lock_error_ends_the_wait_without_failing() {
    let began = Instant::now();
    let answered = wait_out_lock(
        || {
            Err(std::fs::TryLockError::Error(Error::from(
                ErrorKind::Unsupported,
            )))
        },
        || false,
        Duration::from_secs(5),
    );
    assert!(!answered);
    assert!(began.elapsed() < Duration::from_secs(1));
}

#[test]
fn held_lock_keeps_waiting_until_the_core_answers() {
    let mut tries = 0;
    let answered = wait_out_lock(
        || Err(std::fs::TryLockError::WouldBlock),
        || {
            tries += 1;
            tries > 3
        },
        Duration::from_secs(5),
    );
    assert!(answered);
}
