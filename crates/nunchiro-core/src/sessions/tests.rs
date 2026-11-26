// Ticket 1061: with no setting, a new worktree goes beside the repository, while a record made before records kept
// their own root still resolves under the Nunchiro folder (no migration).
#[test]
fn unset_worktree_folder_splits_new_default_from_legacy_root() {
    let settings = super::Settings {
        user_home: "/u".into(),
        ..Default::default()
    };
    let (home, repo) = (Path::new("/h"), Path::new("/r/repo"));
    assert_eq!(
        settings.worktree_root_for(repo).unwrap(),
        Path::new("/u/nunchiro/worktrees")
    );
    assert_eq!(
        settings.legacy_worktree_root(home),
        Path::new("/h/worktrees")
    );
}

// Ticket 1083: Open in editor accepts the project's folder under each of the three roots (the new default, the 1061
// default `../.worktrees`, and `<home>/worktrees`) once it is a real folder.
#[test]
fn open_in_editor_accepts_a_folder_under_each_worktree_root() {
    let home = std::env::temp_dir().join(format!("wt-editor-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let repo = home.join("repo");
    let user = home.join("user");
    let mut core = Sessions::open(&home).unwrap().with_user_home(&user);
    core.tree
        .as_mut()
        .unwrap()
        .added
        .push(repo.to_str().unwrap().into());
    for under in ["user/nunchiro/worktrees", ".worktrees", "worktrees"] {
        std::fs::create_dir_all(home.join(under).join("repo")).unwrap();
    }
    let roots = core.editor_roots();
    for under in ["user/nunchiro/worktrees", ".worktrees", "worktrees"] {
        let at = home.join(under).join("repo");
        assert!(roots.contains(at.to_str().unwrap()), "{under}: {roots:?}");
    }
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn worktree_folder_is_named_after_the_worktree_a13() {
    use super::worktree_folder_name as name;
    assert_eq!(
        name("feat-y", "nunchiro/feat-y", |_| true).unwrap(),
        "feat-y"
    );
    assert_eq!(
        name("", "nunchiro/fix login", |_| true).unwrap(),
        "fix-login"
    );
    assert_eq!(
        name("Fix: the login!", "b", |_| true).unwrap(),
        "Fix-the-login"
    );
    assert_eq!(name("../..", "b", |_| true).unwrap(), "b");
    assert_eq!(name("로그인 수정", "b", |_| true).unwrap(), "로그인-수정");
    assert_eq!(name("feat-y", "b", |n| n != "feat-y").unwrap(), "feat-y-2");
    assert_eq!(name("", "", |_| true).unwrap().len(), 36); // nothing to name it by: an id, as before
}

// Ticket 595: only allow-list names pass (ticket 573's deny list missed names nobody thought of); a secret word is
// refused even inside the allowed prefixes; bad shapes are refused.
#[test]
fn start_env_takes_only_allow_list_names() {
    let one = |key: &str, value: &str| {
        super::check_start_env(&[(key.to_string(), value.to_string())].into())
    };
    for key in [
        "TASK_ID",
        "task_id",
        "LANE_NAME",
        "lane_name",
        "RUST_LOG",
        "RUST_BACKTRACE",
        "NO_COLOR",
        "FORCE_COLOR",
        "CI",
        "TZ",
        "LANG",
        "LC_ALL",
    ] {
        assert_eq!(one(key, "v=1 two"), Ok(()), "{key}");
    }
    for key in [
        "GITHUB_TOKEN",
        "TASK_TOKEN",
        "LANE_API_KEY",
        "task_secret",
        "TASK_PASSWORD",
        "LANE_AUTH",
        "PGPASSWORD",
        "DATABASE_URL",
    ] {
        assert!(one(key, "x").unwrap_err().contains("secret"), "{key}");
    }
    // Names no deny list named (ticket 595's reason) and the old identity families: all off the list.
    for key in [
        "FOO",
        "_X1",
        "PROXY_MODE",
        "NODEJS",
        "EMPTY",
        "TASK",
        "LANE",
        "PATH",
        "HOME",
        "SHELL",
        "NUNCHIRO_SESSION",
        "DYLD_INSERT_LIBRARIES",
        "LD_PRELOAD",
        "GIT_DIR",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
        "CODEX_HOME",
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "npm_config_registry",
        "HTTPS_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "PERL5OPT",
        "RUBYOPT",
        "GIT_SSH_COMMAND",
        "LC_CTYPE_X",
    ] {
        let err = one(key, "x").unwrap_err();
        assert!(
            err.contains("not on the allow list")
                && err.contains("TASK_")
                && err.contains("ask the owner"),
            "{key}: {err}"
        );
    }
    for (key, value) in [
        ("", "x"),
        ("1A", "x"),
        ("A-B", "x"),
        ("A B", "x"),
        ("A", "a\0b"),
    ] {
        assert!(one(key, value).unwrap_err().contains("invalid"), "{key:?}");
    }
    assert!(one("A", &"x".repeat(4097)).is_err());
    let many = (0..65).map(|i| (format!("V{i}"), String::new())).collect();
    assert!(super::check_start_env(&many).is_err());
}
#[test]
fn card_reads_only_the_output_before_the_end_mark() {
    let mut replay = b"Please run /login\r\n".to_vec();
    replay.extend_from_slice(ENDED_MARK);
    replay.extend_from_slice(&b"echo typed\r\n".repeat(30));
    assert_eq!(super::agent_output(&replay), b"Please run /login\r\n");
    assert_eq!(super::agent_output(b"no mark"), b"no mark");
    let card = crate::problems::ended(
        AgentKind::Claude,
        super::agent_output(&replay),
        Some(1),
        false,
    );
    assert_eq!(card.map(|p| p.case), Some(crate::problems::Case::LoggedOut));
}
/// Ticket 505 r2: a resumed session's seed ends with the earlier run's mark; this run prints its sign-in line and
/// exits, and its own mark is not in yet when the card is judged (the 300 ms wait ran out). The card reads this run
/// from `run_start`, as `card_judged` does; the whole replay cut at the old mark (r1) read the earlier run.
#[test]
fn resumed_card_reads_this_run_not_the_old_mark() {
    let mut seed = b"earlier run, all fine\r\n".to_vec();
    seed.extend_from_slice(ENDED_MARK);
    seed.extend_from_slice(b"sh-3.2$ exit\r\n");
    let mut replay = crate::pty::Replay::default();
    replay.push(&seed);
    let run_start = seed.len() as u64;
    replay.push(b"Please run /login\r\n");
    let read = |after| match replay.read_at_most(after, usize::MAX) {
        Ok(crate::api::Reply::Output { data, .. }) => data,
        other => panic!("{other:?}"),
    };
    let case = |bytes: &[u8]| {
        crate::problems::ended(
            AgentKind::Claude,
            super::agent_output(bytes),
            Some(1),
            false,
        )
        .map(|p| p.case)
    };
    assert_eq!(
        case(&read(run_start)),
        Some(crate::problems::Case::LoggedOut)
    );
    // r1's read: the old mark cut away this run's sign-in line.
    assert_ne!(case(&read(0)), Some(crate::problems::Case::LoggedOut));
    // `ended_mark_in`'s read: no mark after `run_start` yet, though the old one is in the last 4 KiB.
    let has_mark = |b: Vec<u8>| b.windows(ENDED_MARK.len()).any(|w| w == ENDED_MARK);
    assert!(!has_mark(read(run_start)) && has_mark(read(0)));
}
use super::*;
/// v37-store-nofollow: the end marker is answered only in a regular file at its path; a link there is refused and
/// its target neither cut, written nor created.
#[test]
fn answer_marker_never_writes_through_a_link() {
    let dir = std::env::temp_dir().join(format!("ns-marker-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("marker"), "1234567890\n").unwrap();
    fs::write(dir.join("target"), "keep me").unwrap();
    std::os::unix::fs::symlink(dir.join("target"), dir.join("link")).unwrap();
    std::os::unix::fs::symlink(dir.join("gone"), dir.join("dangling")).unwrap();
    let answered = answer_marker(&dir.join("marker"), "3");
    let linked = answer_marker(&dir.join("link"), "3");
    let dangling = answer_marker(&dir.join("dangling"), "3");
    let read_linked = read_marker(&dir.join("link"));
    let (marker, target) = (
        fs::read_to_string(dir.join("marker")).unwrap(),
        fs::read_to_string(dir.join("target")).unwrap(),
    );
    let gone = dir.join("gone").exists();
    fs::remove_dir_all(&dir).unwrap();
    answered.unwrap();
    assert_eq!(marker, "seen 3\n");
    assert!(linked.is_err() && dangling.is_err());
    assert_eq!(
        (target.as_str(), gone, read_linked),
        ("keep me", false, None)
    );
}
/// Follow-ups 1112: the worktree store is judged and read on one handle. A link, FIFO, folder or file over 1 MiB at
/// its path is refused, and so is one swapped in at any moment: a FIFO renamed over the store while it is read is
/// never waited on (the read runs under worktrees.lock), a link never followed.
#[test]
fn worktree_store_read_refuses_what_is_swapped_in() {
    use std::sync::{atomic::AtomicBool, atomic::Ordering::SeqCst, mpsc};
    let dir = std::env::temp_dir().join(format!("ns-wtstore-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let store = dir.join("worktrees.json");
    let mkfifo = |p: &Path| {
        let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    };
    assert_eq!(read_worktree_store(&store), Ok(None));
    fs::write(&store, "{}").unwrap();
    assert_eq!(read_worktree_store(&store), Ok(Some(b"{}".to_vec())));
    fs::write(dir.join("target"), "{}").unwrap();
    let bad = |what: &str, make: &dyn Fn(&Path)| {
        let p = dir.join(what);
        make(&p);
        assert_eq!(
            read_worktree_store(&p),
            Err("invalid worktree store".into()),
            "{what}"
        );
    };
    bad("link", &|p| {
        std::os::unix::fs::symlink(dir.join("target"), p).unwrap()
    });
    bad("fifo", &|p| mkfifo(p));
    bad("folder", &|p| fs::create_dir(p).unwrap());
    bad("big", &|p| fs::write(p, vec![b' '; (1 << 20) + 1]).unwrap());
    // The swap: a regular store and a FIFO renamed over it in turn, while reads run.
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let swapper = {
        let (dir, store, stop) = (dir.clone(), store.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut n = 0u32;
            while !stop.load(SeqCst) {
                let next = dir.join(format!("next-{n}"));
                if n.is_multiple_of(2) {
                    fs::write(&next, "{}").unwrap();
                } else {
                    mkfifo(&next);
                }
                fs::rename(&next, &store).unwrap();
                n += 1;
            }
        })
    };
    let (tx, rx) = mpsc::channel();
    let reader = {
        let store = store.clone();
        std::thread::spawn(move || {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            let mut seen = (0, 0);
            while std::time::Instant::now() < until {
                match read_worktree_store(&store) {
                    Ok(Some(b)) => {
                        assert_eq!(b, b"{}");
                        seen.0 += 1;
                    }
                    Err(e) => {
                        assert_eq!(e, "invalid worktree store");
                        seen.1 += 1;
                    }
                    Ok(None) => panic!("the store is always there"),
                }
            }
            tx.send(seen).unwrap();
        })
    };
    let seen = rx.recv_timeout(std::time::Duration::from_secs(10));
    stop.store(true, SeqCst);
    swapper.join().unwrap();
    let seen = seen.expect("a read waited on a FIFO swapped in after its check");
    reader.join().unwrap();
    fs::remove_dir_all(&dir).unwrap();
    assert!(seen.0 > 0 && seen.1 > 0, "{seen:?}");
}
// Ticket 209 `parent_session_env_predicate`.
#[test]
fn parent_session_env_predicate() {
    use std::ffi::OsStr;
    for name in PARENT_SESSION_ENV {
        assert!(is_parent_session_env(OsStr::new(name)), "{name}");
    }
    for name in [
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_MESSAGING_FUTURE",
    ] {
        assert!(is_parent_session_env(OsStr::new(name)), "{name}");
    }
    for name in [
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_MESSAGING", // the prefix needs its trailing underscore
        "PATH",
        "SESSION_ID",
        "claudecode",
        "",
    ] {
        assert!(!is_parent_session_env(OsStr::new(name)), "{name}");
    }
}
// Q9 tt-J5-1: Codex config overrides that turn off approvals or the sandbox, in each spelling Codex reads.
#[test]
fn codex_config_overrides_reach_bypass() {
    let reaches = |args: &[&str]| {
        reaches_codex_bypass(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    };
    for args in [
        &["-c=approval_policy=never"][..],
        &["-c=sandbox_mode=danger-full-access"],
        &["-c", "approval_policy=\"\\u006eever\""],
        &["-c", "profiles={x={approval_policy=\"never\"}}"],
        &["-c", "\"approval_policy\"=never"],
        &["-c", "\"approval\\u005fpolicy\"=\"never\""],
        &["-c", "profiles.x.\"sandbox_mode\"='danger-full-access'"],
    ] {
        assert!(reaches(args), "{args:?}");
    }
    for args in [
        &["-c", "approval_policy=on-request"][..],
        &["-c=model=\"gpt-5\""],
        &["-c", "sandbox_mode=\"workspace-write\""],
    ] {
        assert!(!reaches(args), "{args:?}");
    }
}
// Q9 en-b-J7-1: the Codex sandbox is read while the launch is prepared (off the registry lock), for its folder.
#[test]
fn codex_sandbox_is_read_with_the_launch() {
    let home = scratch("codexro");
    let core = Sessions::open(&home).unwrap();
    let launch = |kind, args: &[&str]| {
        let mut launch = core.launch(StartSession {
            account: None,
            kind,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: args.iter().map(|a| a.to_string()).collect(),
            model: None,
            effort: None,
            resume: None,
        });
        launch.cwd = home.clone();
        launch.read_codex_sandbox();
        launch.committed = true;
        launch.codex_read_only
    };
    assert_eq!(launch(AgentKind::Codex, &["-s", "read-only"]), Some(true));
    assert_eq!(
        launch(AgentKind::Codex, &["-s", "workspace-write"]),
        Some(false)
    );
    assert_eq!(launch(AgentKind::Shell, &[]), None);
}
// v1a-33
fn probe_core(name: &str, probe: fn(&Path) -> std::io::Result<()>) -> (Sessions, Launch, Session) {
    let home = scratch(name);
    let mut core = Sessions::open(&home).unwrap();
    core.folder_probe = probe;
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    (core, launch, session)
}
// v25f F10: a shell with no project starts in the user's home; an agent still needs one.
#[test]
fn shell_with_empty_project_starts_in_home() {
    let core = Sessions::open(&scratch("shell-home")).unwrap();
    let start = |kind| StartSession {
        account: None,
        kind,
        project: PathBuf::new(),
        worktree: false,
        label: String::new(),
        args: vec!["/bin/cat".into()],
        model: None,
        effort: None,
        resume: None,
    };
    let launch = core.launch(start(AgentKind::Shell)).prepare().unwrap();
    let home = fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
    assert_eq!(
        (launch.project.as_path(), launch.cwd.as_path()),
        (home.as_path(), home.as_path())
    );
    assert!(core.launch(start(AgentKind::Claude)).prepare().is_err());
}
// F15 x F10: an empty-project shell start runs in $HOME, the probe sees $HOME (never the empty path), and a
// refusal there is not told apart as a missing folder.
#[test]
fn shell_with_empty_project_starts_in_home_with_the_probe_in_place() {
    let home = scratch("shell-home-probe");
    let mut core = Sessions::open(&home).unwrap();
    // Answers only for the user's home; any other folder (the empty path included) is refused.
    core.folder_probe = |p| {
        let home = fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
        if fs::canonicalize(p).is_ok_and(|p| p == home) {
            Ok(())
        } else {
            Err(std::io::ErrorKind::PermissionDenied.into())
        }
    };
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: PathBuf::new(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let user_home = fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
    let session = core
        .start(&launch)
        .map_err(|e| refused_start(core.folder_probe, AgentKind::Shell, &launch.cwd, e))
        .unwrap();
    launch.committed = true;
    assert_eq!(launch.cwd, user_home);
    assert_eq!(session.cwd, user_home);
    assert_eq!(session.project, user_home);
    // The probe answers for $HOME alone: a refusal there that is not a permission case keeps the start's own
    // reason, while the empty path would have read as file_access.
    assert_eq!(
        refused_start(
            core.folder_probe,
            AgentKind::Shell,
            &launch.cwd,
            "boom".into()
        ),
        "boom"
    );
    end(core, launch);
}
// F15: a folder the agent cannot enter refuses the start with the file_access reason and the folder; nothing runs.
#[test]
fn a_start_in_an_unreadable_folder_is_refused_as_file_access() {
    use std::os::unix::fs::PermissionsExt;
    let home = scratch("start-locked");
    let locked = home.join("locked");
    fs::create_dir(&locked).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: locked.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let refused = core
        .start(&launch)
        .map_err(|e| refused_start(probe_folder, AgentKind::Shell, &launch.cwd, e));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let e = refused.unwrap_err();
    // chmod is EACCES: the owner/mode words, not the System Settings steps.
    assert!(e.starts_with(FILE_MODE), "{e}");
    assert!(e.contains(&launch.cwd.display().to_string()), "{e}");
    assert!(core.entries.is_empty());
    core.handle(Request::Stop).unwrap();
    drop((core, launch));
    let _ = fs::remove_dir_all(home);
}
// F15 r2 (review MUST): a folder probe that never answers is bounded and read as macOS privacy; EPERM is privacy,
// EACCES the folder's mode; a readable folder keeps the start's own reason.
#[test]
fn a_refused_start_probes_its_folder_within_the_bound() {
    let begun = std::time::Instant::now();
    let e = refused_start(
        |_| {
            std::thread::sleep(std::time::Duration::from_secs(10));
            Ok(())
        },
        AgentKind::Claude,
        Path::new("/Volumes/x"),
        "spawn failed".into(),
    );
    assert!(begun.elapsed() < PROBE_BOUND + std::time::Duration::from_secs(1));
    assert_eq!(
        e,
        format!("{FILE_ACCESS} cannot read /Volumes/x: spawn failed")
    );
    let eperm = refused_start(
        |_| Err(std::io::Error::from_raw_os_error(libc::EPERM)),
        AgentKind::Claude,
        Path::new("/p"),
        "x".into(),
    );
    assert!(
        eperm.starts_with(FILE_ACCESS) && !eperm.starts_with(FILE_MODE),
        "{eperm}"
    );
    let eacces = refused_start(
        |_| Err(std::io::Error::from_raw_os_error(libc::EACCES)),
        AgentKind::Claude,
        Path::new("/p"),
        "x".into(),
    );
    assert!(eacces.starts_with(FILE_MODE), "{eacces}");
    assert_eq!(
        refused_start(|_| Ok(()), AgentKind::Claude, Path::new("/p"), "x".into()),
        "x"
    );
}
// F15 r4 (review MUST): refused starts share the starts' probe cap. A full cap spawns no thread and answers
// file_access within the bound; a probe that outlives its timeout keeps its slot until the thread really ends.
#[test]
fn refused_start_probes_share_the_cap() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    static RELEASE: AtomicBool = AtomicBool::new(false);
    let full = Probes::new(AtomicUsize::new(PROBES_MAX));
    let begun = std::time::Instant::now();
    let e = refused_start_capped(
        &full,
        |_| {
            CALLS.fetch_add(1, SeqCst);
            Ok(())
        },
        AgentKind::Claude,
        Path::new("/Volumes/x"),
        "spawn failed".into(),
    );
    assert!(begun.elapsed() < PROBE_BOUND);
    assert_eq!(
        e,
        format!("{FILE_ACCESS} cannot read /Volumes/x: spawn failed")
    );
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_eq!((CALLS.load(SeqCst), full.load(SeqCst)), (0, PROBES_MAX));
    // A hung probe holds one slot past the timeout and gives it back when its thread ends.
    let one = Probes::default();
    let e = refused_start_capped(
        &one,
        |_| {
            while !RELEASE.load(SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Ok(())
        },
        AgentKind::Claude,
        Path::new("/Volumes/y"),
        "x".into(),
    );
    assert!(e.starts_with(FILE_ACCESS), "{e}");
    assert_eq!(one.load(SeqCst), 1);
    RELEASE.store(true, SeqCst);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while one.load(SeqCst) != 0 && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(one.load(SeqCst), 0);
}
// F15 r4: the core.log refusal stays one line.
#[test]
fn a_refusal_log_line_escapes_newlines() {
    assert_eq!(escape_line("a\nb\r\\c"), "a\\nb\\r\\\\c");
}
// V2-1a acceptance: the hash of the session token is on disk before the holder launches the agent, and goes
// when the session closes.
#[test]
fn token_hash_written_before_launch() {
    let (mut core, launch, session) = probe_core("hash-launch", |_| Ok(()));
    let hash = store::token_sha256(core.entries[&session.id].token.as_ref().unwrap());
    let at_launch = fs::read_to_string(launch.home.join("sessions.at-launch.json")).unwrap();
    assert!(at_launch.contains(&hash), "{at_launch}");
    // Saved, and the row itself was not: only the hash came before the launch.
    assert!(!at_launch.contains(&format!("\"id\": \"{}\"", session.id)));
    core.handle(Request::Close {
        id: session.id.clone(),
    })
    .unwrap();
    assert!(
        !fs::read_to_string(launch.home.join("sessions.json"))
            .unwrap()
            .contains(&hash)
    );
    end(core, launch);
}
fn probed(core: &mut Sessions) -> Session {
    match core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { mut sessions, .. } => sessions.remove(0),
        _ => panic!(),
    }
}
fn end(mut core: Sessions, launch: Launch) {
    let home = launch.home.clone();
    core.handle(Request::Stop).unwrap();
    drop((core, launch));
    let _ = fs::remove_dir_all(home);
}
#[test]
fn a_folder_macos_refuses_marks_the_session_blocked_and_keeps_it_running() {
    let (mut core, launch, session) = probe_core("probe-eperm", |_| {
        Err(std::io::Error::from_raw_os_error(libc::EPERM))
    });
    std::thread::sleep(std::time::Duration::from_millis(200));
    let snap = probed(&mut core);
    let blocked = snap.blocked.expect("blocked");
    assert_eq!(blocked.reason, crate::api::BlockedReason::FileAccess);
    assert_eq!(blocked.path, session.cwd);
    assert_eq!(snap.state, SessionState::Running);
    assert_eq!(snap.pid, session.pid);
    let wire = serde_json::to_value(probed(&mut core)).unwrap();
    assert_eq!(wire["blocked"]["reason"], "file_access");
    end(core, launch);
}
#[test]
fn a_folder_probe_that_hangs_blocks_after_the_bound_without_stalling_start() {
    let begun = std::time::Instant::now();
    let (mut core, launch, session) = probe_core("probe-hang", |_| {
        std::thread::sleep(std::time::Duration::from_secs(10));
        Ok(())
    });
    assert!(begun.elapsed() < PROBE_BOUND, "start waited for the probe");
    assert!(
        probed(&mut core).blocked.is_none(),
        "blocked before the bound"
    );
    std::thread::sleep(PROBE_BOUND + std::time::Duration::from_millis(200));
    let snap = probed(&mut core);
    assert_eq!(snap.blocked.map(|b| b.path), Some(session.cwd));
    assert_eq!(snap.state, SessionState::Running);
    end(core, launch);
}
#[test]
fn starts_past_the_probe_cap_skip_the_probe_instead_of_parking_more_threads() {
    let home = scratch("probe-cap");
    let mut core = Sessions::open(&home).unwrap();
    core.folder_probe = |_| Err(std::io::Error::from_raw_os_error(libc::EPERM));
    core.probes = Probes::new(std::sync::atomic::AtomicUsize::new(PROBES_MAX));
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    core.start(&launch).unwrap();
    launch.committed = true;
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(probed(&mut core).blocked.is_none());
    assert_eq!(
        core.probes.load(std::sync::atomic::Ordering::SeqCst),
        PROBES_MAX
    );
    end(core, launch);
}
#[test]
fn a_folder_that_opens_leaves_the_session_unblocked() {
    let (mut core, launch, _) = probe_core("probe-ok", probe_folder);
    std::thread::sleep(PROBE_BOUND + std::time::Duration::from_millis(200));
    let snap = probed(&mut core);
    assert!(snap.blocked.is_none());
    assert!(!serde_json::to_string(&snap).unwrap().contains("blocked"));
    end(core, launch);
}
/// Ticket 286: `AGENT_WRAPPER` on a PTY with `exit 3` as the agent and `/bin/sh` as the user's shell, whose prompt
/// ends in `$ `; `(home, marker, core, launch, id)`.
fn wrapper_session(tag: &str) -> (PathBuf, PathBuf, Sessions, Launch, String) {
    wrapper_session_with(tag, "/bin/sh", "/bin/sh", 3, false)
}
/// `wrapper_session` with `sh` running the wrapper, `shell`, the agent's exit `code`, and with `core_marker` the
/// marker the core reads (`ended_marker`) rather than one only the test answers.
fn wrapper_session_with(
    tag: &str,
    sh: &str,
    shell: &str,
    code: i32,
    core_marker: bool,
) -> (PathBuf, PathBuf, Sessions, Launch, String) {
    let home = scratch(tag);
    let mut marker = home.join("marker");
    let mut core = Sessions::open(&home).unwrap();
    let shell = format!("SHELL={shell}");
    let exit = format!("exit {code}");
    let args = [
        "/usr/bin/env",
        &shell,
        sh,
        "-c",
        AGENT_WRAPPER,
        "nunchiro-agent",
    ]
    .map(String::from)
    .into_iter()
    .chain([marker.display().to_string()])
    .chain(["/bin/sh", "-c", &exit].map(String::from))
    .collect();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args,
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    if core_marker {
        marker = ended_marker(&home, &launch.id);
        let at = launch.start.args.len() - 4;
        launch.start.args[at] = marker.display().to_string();
    }
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    let id = session.id.clone();
    wait_for("the agent's end is marked", &mut || {
        fs::read_to_string(&marker).is_ok_and(|c| c.trim() == code.to_string())
    });
    (home, marker, core, launch, id)
}
fn wait_for(what: &str, done: &mut dyn FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
fn prompt(screen: &str) -> bool {
    screen.ends_with("$ ")
}
fn screen_of(core: &Sessions, id: &str) -> String {
    String::from_utf8_lossy(&core.entries[id].pty.as_ref().unwrap().snapshot()).into_owned()
}
/// Ticket 286 race: a send the core wrote to the dead agent before it read the marker is dropped, never run by
/// the shell the wrapper becomes; the shell starts only after the core's `seen` answer.
#[test]
fn agent_wrapper_drops_input_written_before_the_core_saw_the_end() {
    let (_, marker, mut core, launch, id) = wrapper_session("wrapdrain");
    // Still unanswered: the wrapper waits, the bytes sit in the terminal's input.
    std::thread::sleep(std::time::Duration::from_millis(300));
    core.live(&id)
        .unwrap()
        .write(b"echo leaked-$((40+2))\r")
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    fs::write(&marker, "seen 3\n").unwrap();
    // The drain ends after a quiet second; the user's line after it runs.
    std::thread::sleep(std::time::Duration::from_millis(2500));
    core.live(&id)
        .unwrap()
        .write(b"echo shell-$((1+1))\r")
        .unwrap();
    let mut seen = String::new();
    wait_for("the shell answers", &mut || {
        seen = screen_of(&core, &id);
        seen.contains("shell-2")
    });
    assert!(
        !seen.contains("leaked-42"),
        "a send to the dead agent ran in the shell: {seen:?}"
    );
    end(core, launch);
}
/// Ticket 507: a line typed into the ending agent shows at most once on the screen; the drain no longer reprints
/// the pending line for each byte it reads.
#[test]
fn a_line_typed_at_agent_end_shows_once() {
    let (_, marker, mut core, launch, id) = wrapper_session("wrapecho");
    std::thread::sleep(std::time::Duration::from_millis(300));
    core.live(&id)
        .unwrap()
        .write(b"echo typed-at-end\r")
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    fs::write(&marker, "seen 3\n").unwrap();
    let mut seen = String::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !prompt(&seen) {
        assert!(
            std::time::Instant::now() < deadline,
            "no shell prompt: {seen:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        seen = screen_of(&core, &id);
    }
    eprintln!("screen after the end: {seen:?}");
    assert!(
        seen.matches("at-end").count() <= 1,
        "the typed line was reprinted: {seen:?}"
    );
    end(core, launch);
}
/// Ticket 512 (488 review): a card already raised (a sign-in or start failure) is kept when the ended agent's
/// pending card is judged; the ended card fills only an empty slot.
#[test]
fn a_judged_card_keeps_an_earlier_problem() {
    let (_, marker, mut core, launch, id) = wrapper_session("cardkeep");
    let earlier =
        crate::problems::ended(AgentKind::Claude, b"Please run /login\r\n", Some(1), false);
    assert!(earlier.is_some());
    let entry = core.entries.get_mut(&id).unwrap();
    entry.meta.kind = AgentKind::Claude;
    entry.meta.problem = earlier.clone();
    entry.card_due = Some((std::time::Instant::now(), Some(3)));
    assert!(card_judged(entry, true));
    assert_eq!(entry.meta.problem, earlier);
    assert!(entry.card_due.is_none());
    // Without an earlier card, the judged one is the ended agent's.
    entry.meta.problem = None;
    entry.card_due = Some((std::time::Instant::now(), Some(3)));
    assert!(card_judged(entry, true));
    assert!(
        entry
            .meta
            .problem
            .as_ref()
            .is_some_and(|p| p.details.contains("code 3"))
    );
    fs::write(&marker, "seen 3\n").unwrap();
    end(core, launch);
}
/// Ticket 512 (488 review): a worker whose shell ends before the pass after the one that saw its agent end (a
/// late pass, within the card's `ENDED_MARK_WAIT`) is finished as one whose shell lives on, not left Exited.
#[test]
fn a_worker_whose_shell_ends_before_the_card_is_finished() {
    let (_, _, mut core, launch, id) =
        wrapper_session_with("wrapquick", "/bin/sh", "/usr/bin/true", 0, true);
    let entry = core.entries.get_mut(&id).unwrap();
    entry.meta.kind = AgentKind::Claude;
    entry.meta.parent = Some("lead".into());
    core.refresh().unwrap();
    assert!(core.entries[&id].agent_ended && core.entries[&id].card_due.is_some());
    // The drain's quiet second, then `true` as the shell ends at once.
    wait_for("the shell ends", &mut || {
        !core.entries[&id].pty.as_ref().unwrap().agent_running()
    });
    std::thread::sleep(std::time::Duration::from_millis(300));
    core.refresh().unwrap();
    assert_eq!(core.entries[&id].meta.state, SessionState::Closed);
    end(core, launch);
}
/// Ticket 512 r2: a Ctrl-C during the drain kills its `dd`, `wc` and `date` (the wrapper's INT trap does not
/// reach its children); their empty output prints no test error onto the shell's screen, under sh and dash.
#[test]
fn ctrl_c_during_the_drain_prints_nothing() {
    for sh in ["/bin/sh", "/bin/dash"] {
        if !Path::new(sh).exists() {
            continue;
        }
        let tag = format!("wrapint{}", sh.len());
        let (_, marker, mut core, launch, id) = wrapper_session_with(&tag, sh, "/bin/sh", 3, false);
        fs::write(&marker, "seen 3\n").unwrap();
        // Past the wrapper's 50 ms poll and into the drain's quiet second.
        std::thread::sleep(std::time::Duration::from_millis(400));
        core.live(&id).unwrap().write(b"\x03").unwrap();
        let mut seen = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !prompt(&seen) {
            assert!(
                std::time::Instant::now() < deadline,
                "{sh}: no shell prompt: {seen:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
            seen = screen_of(&core, &id);
        }
        assert!(
            !seen.contains("[:"),
            "{sh}: a test error on the screen: {seen:?}"
        );
        end(core, launch);
    }
}
/// Ticket 507: the drain is bounded; a key every 100 ms (more often than its quiet wait) still lets the shell start.
#[test]
fn the_drain_ends_while_keys_keep_coming() {
    let (_, marker, mut core, launch, id) = wrapper_session("wrapbound");
    fs::write(&marker, "seen 3\n").unwrap();
    let asked = std::time::Instant::now();
    // The prompt is drawn once; the keys that keep coming are echoed after it, so it never ends the screen again.
    while !screen_of(&core, &id).contains("$ ") {
        assert!(
            asked.elapsed() < std::time::Duration::from_secs(8),
            "the drain did not end while keys came"
        );
        core.live(&id).unwrap().write(b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    end(core, launch);
}
#[test]
fn a_spawned_shell_inherits_the_core_locale() {
    let home = scratch("locale");
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '<%s>' \"$LANG\"; exec cat".into(),
            ],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    let want = format!("<{}>", std::env::var("LANG").unwrap_or_default());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let seen = loop {
        let out = core.entries[&session.id].pty.as_ref().unwrap().snapshot();
        let out = String::from_utf8_lossy(&out).into_owned();
        if out.contains('>') || std::time::Instant::now() > deadline {
            break out;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(seen.contains(&want), "{seen:?} lacks {want:?}");
    end(core, launch);
}
// v1a-20
#[test]
fn holding_is_true_only_for_the_pasted_text() {
    let long = "Summarize the change in one line and stop. ".repeat(6);
    let wrapped = "first line\nsecond line\twith tab  ";
    for (row, paste) in [
        ("fix the bug", "fix the bug"),
        ("fix the bug", "fix the bug \t "),
        ("Summarize the change in one line…", long.as_str()),
        ("Summarize the change", long.as_str()),
        ("first line second line", wrapped),
        ("a ❯ b", "a ❯ b"),
    ] {
        assert!(holds_paste(row, paste), "{row:?} should hold {paste:?}");
    }
    for (row, paste) in [
        ("1. Yes", long.as_str()),
        ("some other draft", "fix the bug"),
        ("", "fix the bug"),
        ("", ""),
        ("…", "fix the bug"),
        // A tail match on a menu choice is a dialog cursor even when the paste ends with it.
        ("1. Yes", "then answer 1. Yes"),
        // v1a-24: the agents echo a paste's start, never its end; a tail is a menu cursor (`❯ Continue`).
        ("in one line and stop.", long.as_str()),
        ("second line with tab", wrapped),
        ("Continue", "Review the plan, then Continue"),
    ] {
        assert!(
            !holds_paste(row, paste),
            "{row:?} should not hold {paste:?}"
        );
    }
    // v1a-20 r2: Claude 2.1.310's collapsed-paste placeholder (over 800 UTF-16 units or 2 newlines).
    let sixty = vec!["a line"; 60].join("\n");
    let three = "a\nb\nc";
    let wide = "x".repeat(801);
    for (row, paste) in [
        ("[Pasted text #1 +59 lines]", sixty.as_str()),
        ("[Pasted text #3 +2 lines]", three),
        ("[Pasted text #2]", wide.as_str()),
        // v1a-24: Codex 0.161.0's placeholder counts chars, newlines included (60 lines of "a line": 419).
        ("[Pasted Content 419 chars]", sixty.as_str()),
        ("[Pasted Content 801 chars]", wide.as_str()),
    ] {
        assert!(holds_paste(row, paste), "{row:?} should hold the paste");
    }
    for (row, paste) in [
        ("[Pasted text #1]", "fix the bug"),
        ("[Pasted text #1]", "x".repeat(800).as_str()),
        ("[Pasted text #1 +58 lines]", sixty.as_str()),
        ("[Pasted text #1]", sixty.as_str()),
        ("[Pasted text #1 +0 lines]", wide.as_str()),
        ("[Pasted text # +59 lines]", sixty.as_str()),
        ("see [Pasted text #1 +59 lines]", sixty.as_str()),
        ("[Pasted text #1 +59 lines] and more", sixty.as_str()),
        ("[Pasted Content 418 chars]", sixty.as_str()),
        ("[Pasted Content chars]", sixty.as_str()),
        ("[Pasted Content 419 chars] more", sixty.as_str()),
    ] {
        assert!(
            !holds_paste(row, paste),
            "{row:?} should not hold the paste"
        );
    }
    // Ticket 1087: an image-only message (one saved image path) is drawn as "[Image #N]".
    let image = "/data/images/s1/a.png";
    assert!(holds_paste("[Image #1]", image));
    assert!(holds_paste("[Image #12]", image));
    assert!(same_words("[Image #1]", image));
    for (row, paste) in [
        ("[Image #1]", "fix the bug"),
        ("[Image #1]", "look\n/data/images/s1/a.png"),
        ("[Image #]", image),
        ("[Image #1] more", image),
    ] {
        assert!(
            !holds_paste(row, paste),
            "{row:?} should not hold {paste:?}"
        );
    }
    // Placeholder rows reach holds_paste as "" through composer().
    let placeholder = composer(
        "› Ask Codex to do anything\n\n  gpt-6.1-sol default · ~/p",
        AgentKind::Codex,
    )
    .unwrap();
    assert!(!holds_paste(&placeholder, "Ask Codex to do anything"));
}
// v1a-24
/// Ticket 991 (B1, C1): no input box and a choice in the last rows: a send waits, its Enter is never written.
#[test]
fn dialog_up_reads_a_question_without_an_input_box() {
    let rule = "─".repeat(40);
    let boxed = format!("answer\n{rule}\n❯\u{a0}\n{rule}\n  footer\n");
    assert!(!dialog_up(&boxed, AgentKind::Claude));
    let trust = " Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n";
    assert!(dialog_up(trust, AgentKind::Claude));
    assert!(dialog_up(
        "Switch model?\n❯ 1. Yes, switch to Sonnet\n  2. No\n",
        AgentKind::Claude
    ));
    // A numbered list in the agent's answer, with no box drawn yet, is no dialog; a shell never is.
    assert!(!dialog_up("Steps:\n1. build\n2. test\n", AgentKind::Claude));
    assert!(!dialog_up(trust, AgentKind::Shell));
}
#[test]
fn composer_is_the_ruled_input_box_only() {
    let rule = "─".repeat(120);
    let framed = |row: &str| format!("⏺ done\n\n{rule}\n{row}\n{rule}\n  ? for shortcuts\n\n");
    let codex = |rows: &str| {
        format!("• done\n\n{rows}\n\n  gpt-6.1-sol default · ~/p\n  ? for shortcuts\n\n")
    };
    let claude = |s: &str| composer(s, AgentKind::Claude);
    assert_eq!(
        claude(&framed("❯ fix the bug")).as_deref(),
        Some("fix the bug")
    );
    assert_eq!(
        claude(&framed("❯ Try \"fix lint errors\"")).as_deref(),
        Some("")
    );
    assert_eq!(claude(&framed("❯")).as_deref(), Some(""));
    // A row wrapped over several lines: the box is still the `❯` row's frame.
    let wrapped = format!("{rule}\n❯ a draft long enough\n  to wrap here\n{rule}\n");
    assert_eq!(claude(&wrapped).as_deref(), Some("a draft long enough"));
    // Two boxes: the last one.
    let two = format!("{}{}", framed("❯ old draft"), framed("❯ new draft"));
    assert_eq!(claude(&two).as_deref(), Some("new draft"));
    // A narrow terminal: rules shorter than the widest row still frame the box.
    let narrow = format!("{}\n{rule}\n─────\n❯ hi\n─────\n", "x".repeat(150));
    assert_eq!(claude(&narrow).as_deref(), Some("hi"));
    for screen in [
        // A dialog or picker cursor row, no rules.
        "Pick one\n❯ 1. Yes\n  2. No".to_string(),
        "Select model\n ❯ 1. Default (recommended)\n   2. Sonnet".into(),
        // Claude 2.1.310's permission dialog: one rule above, none below.
        format!("{rule}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"),
        format!("{rule}\n❯ 1. Yes\n  2. No\nEsc to cancel"),
        // A history row of an earlier prompt.
        "❯ fix the bug\n\n⏺ Fixed it.".into(),
        // A framed box above, a dialog cursor below it.
        format!(
            "{}Pick one\n❯ 1. Yes\n  2. No",
            framed("❯ 1. Yes, go ahead")
        ),
        // Dashed rules frame a diff, not the input box.
        format!("{}\n❯ 1. Yes\n{}", "╌".repeat(120), "╌".repeat(120)),
        // A rule below only, or text between the rule and the row.
        format!("❯ hi\n{rule}"),
        format!("{rule}\n title\n❯ hi\n{rule}"),
        String::new(),
    ] {
        assert_eq!(claude(&screen), None, "{screen:?}");
    }
    let codex_of = |s: &str| composer(s, AgentKind::Codex);
    assert_eq!(
        codex_of(&codex("› fix the bug")).as_deref(),
        Some("fix the bug")
    );
    assert_eq!(
        codex_of(&codex("› fix the bug\n  and the test")).as_deref(),
        Some("fix the bug")
    );
    for placeholder in ["› Ask Codex to do anything", "› Ask a follow-up question"] {
        assert_eq!(codex_of(&codex(placeholder)).as_deref(), Some(""));
    }
    for screen in [
        // Codex 0.161.0's daemon-settings dialog, as observed: the cursor row is the last row.
        "  1. Run without daemon this time\n  2. Restart with these settings\n› 3. Cancel\n\n"
            .to_string(),
        // A list under the cursor row is a menu, not a draft.
        codex("› 1. Yes\n  2. No"),
        "› fix the bug\n\n".into(),
        format!("› fix the bug\n{rule}\n❯ hi\n{rule}"),
    ] {
        assert_eq!(codex_of(&screen), None, "{screen:?}");
    }
}
// CHAT-PERMCHIP: Shift+Tab is the one new key; every other entry and the refusal stay.
#[test]
fn shift_tab_is_the_only_new_key() {
    assert_eq!(key_bytes("shift+tab"), Ok(b"\x1b[Z".to_vec()));
    assert_eq!(key_bytes("Shift+Tab"), Ok(b"\x1b[Z".to_vec()));
    for (key, bytes) in [
        ("enter", &b"\r"[..]),
        ("esc", &[27]),
        ("tab", &[9]),
        ("backspace", &[127]),
        ("up", b"\x1b[A"),
        ("down", b"\x1b[B"),
        ("right", b"\x1b[C"),
        ("left", b"\x1b[D"),
        ("ctrl+c", &[3]),
        ("ctrl+d", &[4]),
        ("ctrl+space", &[0]),
        ("shift+left", b"\x1b[1;2D"),
        ("shift+right", b"\x1b[1;2C"),
    ] {
        assert_eq!(key_bytes(key), Ok(bytes.to_vec()), "{key}");
    }
    for key in ["shift+up", "backtab", "alt+tab", "shift+tab ", ""] {
        assert!(key_bytes(key).is_err(), "{key:?}");
    }
}
// CHAT-PERMCHIP: only the user's own click presses Shift+Tab, and only into a Claude session.
#[test]
fn shift_tab_is_the_users_and_claude_only() {
    assert_eq!(check_key("user", AgentKind::Claude, "shift+tab"), Ok(()));
    for kind in [AgentKind::Codex, AgentKind::Shell] {
        assert!(check_key("user", kind, "shift+tab").is_err(), "{kind:?}");
        assert_eq!(check_key("user", kind, "enter"), Ok(()));
    }
    // Another session or a widget: refused, while its other keys keep working.
    for sender in ["s-1", "widget:x"] {
        assert!(
            check_key(sender, AgentKind::Claude, "shift+tab").is_err(),
            "{sender}"
        );
        assert_eq!(check_key(sender, AgentKind::Claude, "esc"), Ok(()));
    }
}
// CHAT-PERMCHIP: the mode comes from Claude's footer under the input box, never a guess.
#[test]
fn mode_read_from_screen_footers() {
    let rule = "─".repeat(60);
    let screen = |footer: &str| format!("● done\n{rule}\n❯ \n{rule}\n{footer}");
    for (footer, mode) in [
        ("  ⏸ manual mode on (shift+tab to cycle)", Some("manual")),
        ("  ⏸ manual mode on", Some("manual")),
        (
            "  ⏵⏵ accept edits on (shift+tab to cycle)",
            Some("accept edits"),
        ),
        ("  ⏸ plan mode on (shift+tab to cycle)", Some("plan")),
        (
            "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
            Some("auto"),
        ),
        (
            "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
            Some("bypass permissions"),
        ),
        ("  ? for shortcuts", None),
        ("  ⏵⏵ something new on (shift+tab to cycle)", None),
        ("", None),
    ] {
        assert_eq!(
            permission_mode(&screen(footer), AgentKind::Claude).as_deref(),
            mode,
            "{footer:?}"
        );
    }
    // Codex and a shell never show a mode, even with Claude's words on the screen.
    for kind in [AgentKind::Codex, AgentKind::Shell] {
        assert_eq!(permission_mode(&screen("  ⏸ plan mode on"), kind), None);
    }
    // A footer-looking line in the transcript above the box is not read.
    let old = format!("⏸ plan mode on\n{rule}\n❯ \n{rule}\n  ? for shortcuts");
    assert_eq!(permission_mode(&old, AgentKind::Claude), None);
    // A dialog on screen fails closed.
    let dialog = format!(
        "{rule}\n❯ \n{rule}\n  ⏸ plan mode on\n Do you want to proceed?\n ❯ 1. Yes\n   2. No"
    );
    assert_eq!(permission_mode(&dialog, AgentKind::Claude), None);
}
// v1a-24 r2 (review MUST-1): a box counts only when nothing below it, or inside it, looks like a choice.
#[test]
fn composer_fails_closed_on_a_choice_below_the_box() {
    let rule = "─".repeat(60);
    let boxed = |rest: &str| format!("{rule}\n❯ Refactor the parser\n{rule}\n{rest}");
    let claude = |s: &str| composer(s, AgentKind::Claude);
    // Footers Claude 2.1.310 draws under its box (mode symbols ⏸ and ⏵⏵, never a cursor).
    for footer in [
        "  ? for shortcuts",
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
        "  ⏸ manual mode on",
        "  🤖 Haiku 5.5 [🌿M] │ 📁 cwd\n  📊 ctx ○ 0%/1M │ 🟢 5h 10% ⏳3h55m\n  paste again to expand",
    ] {
        assert_eq!(
            claude(&boxed(footer)).as_deref(),
            Some("Refactor the parser"),
            "{footer:?}"
        );
    }
    for rest in [
        // The review's screens: a real box above an indented dialog cursor.
        format!(
            "  ? for shortcuts\n{rule}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
        ),
        " Pick one\n ❯ 1. Yes\n   2. No".into(),
        // A cursor at any indent, numbered or not; `>` as a cursor; numbered rows without a cursor.
        "   ❯ Continue".into(),
        " › Yes".into(),
        " > 1. Yes".into(),
        "  1. Yes\n  2) No".into(),
        // Something detect classifies as a decision, with no cursor or number.
        " Do you want to proceed?".into(),
        // v1a-24 r3 (review r2 SHOULD-1): every mark and number form detect's choice parser knows.
        " Pick one\n ● Yes\n ○ No".into(),
        " ● 1. Yes\n ○ 2. No\n Esc to cancel".into(),
        " 1.Yes\n 2.No".into(),
    ] {
        assert_eq!(claude(&boxed(&rest)), None, "{rest:?}");
    }
    // A cursor row inside the frame is not the box's own text.
    let inside = format!("{rule}\n❯ Refactor the parser\n  ❯ 1. Yes\n{rule}\n");
    assert_eq!(claude(&inside), None);
}
// v1a-24 r4 (review r3 SHOULD-2): a status row led by a number is no option; every r3 choice is still one.
#[test]
fn a_status_row_led_by_a_number_is_not_a_choice() {
    let rule = "─".repeat(60);
    for footer in [
        "  45.2% ctx · main",
        "  2.1.310 · main",
        "  3.5k tokens · 12.4s",
        "  45.2% ctx · 2.1.310 · 3.5k tokens\n  ⏵⏵ auto mode on",
    ] {
        let screen = format!("{rule}\n❯ fix the parser\n{rule}\n{footer}");
        assert_eq!(
            composer(&screen, AgentKind::Claude).as_deref(),
            Some("fix the parser"),
            "{footer:?}"
        );
    }
    for footer in [
        "  45.2% context left",
        "  100% context left",
        "  ? for shortcuts",
    ] {
        let screen = format!("› fix the parser\n\n  GPT-6.1-Sol default · ~/p\n{footer}");
        assert_eq!(
            composer(&screen, AgentKind::Codex).as_deref(),
            Some("fix the parser"),
            "{footer:?}"
        );
    }
    for row in [
        " 1. Yes",
        " 1.Yes",
        " 2) No",
        " ❯ 1. Yes",
        " ● 1.Ja",
        " 3.한국어",
    ] {
        assert!(waiting::screen::choice_row(row).is_some(), "{row:?}");
    }
    for row in [" 45.2% ctx", " 2.1.310", " 3.5k", " 4)%", " 12)3"] {
        assert!(waiting::screen::choice_row(row).is_none(), "{row:?}");
    }
}

/// v1a-30 (V1A-24 r4 NIT-1): the edge shapes are a choice on record. `N.` or `N)` followed by punctuation, a symbol
/// or nothing (a label wrapped onto the next row) is an option: missing one would let an Enter press a dialog's
/// default, so only a digit or `%` (a version, a size, a percentage) keeps a number-led row from being one.
/// Circled, bracketed and fullwidth numbers are no option: neither Claude Code nor Codex numbers its choices so.
/// `detect` and `composer` read every row the same way.
#[test]
fn number_led_edge_rows_are_options_by_rule_and_detect_and_composer_agree() {
    let rule = "─".repeat(60);
    for (row, option) in [
        ("1.(default)", true),
        ("1.\"main\"", true),
        ("1.✅ Yes", true),
        ("1.", true),
        ("1)", true),
        ("①", false),
        ("① Yes", false),
        ("[1] Yes", false),
        ("１. Yes", false),
        ("1．Yes", false),
        ("1.5x speed", false),
    ] {
        assert_eq!(
            waiting::screen::choice_row(&format!(" ❯ {row}")).is_some(),
            option,
            "{row:?}"
        );
        let dialog = format!(" Do you want to proceed?\n ❯ {row}\n   2. No\n\n Esc to cancel");
        let mut screen = waiting::screen::Screen::new(120, 10);
        screen.feed(dialog.replace('\n', "\r\n").as_bytes());
        let detected = screen.detect(AgentKind::Claude).expect("the dialog");
        assert_eq!(
            detected.choices.iter().any(|c| c.keys[0] == "1"),
            option,
            "detect: {row:?}"
        );
        let boxed = format!("{rule}\n❯ fix the parser\n{rule}\n  {row}");
        assert_eq!(
            composer(&boxed, AgentKind::Claude).is_none(),
            option,
            "composer: {row:?}"
        );
    }
}
// v1a-24 r2 (review SHOULD-1, SHOULD-2): the Codex box is the bottom block Codex 0.161.0 draws: the `›` row, one
// blank row, then one or two indented footer rows, the first `<model> <effort> · <cwd>`.
#[test]
fn codex_box_is_the_bottom_block_only() {
    let codex = |s: &str| composer(s, AgentKind::Codex);
    for (screen, text) in [
        (
            "› hi\n\n  GPT-6.1-Sol default · ~/p · GPT-6.1-Sol · default\n  ? for shortcuts",
            "hi",
        ),
        (
            "› [Pasted Content 2000 chars]\n\n  GPT-6.1-Sol default · ~/p · GPT-6.1-Sol · default",
            "[Pasted Content 2000 chars]",
        ),
        (
            "› hi\n\n  GPT-6.1-Sol medium · ~/p\n  ? for shortcuts         ⚠ 2 warnings · f2 to view",
            "hi",
        ),
    ] {
        assert_eq!(codex(screen).as_deref(), Some(text), "{screen:?}");
    }
    for screen in [
        // The cursor on a numbered option, a hint below.
        "  1. Yes, proceed\n  2. Yes, always\n› 3. No, tell Codex what to do\n\n  Press enter to confirm or esc to cancel",
        // A history row, then transcript and a dialog with no column-0 cursor.
        "› continue\n\n• Running cargo test\n\n  Allow command?\n    1. Yes\n    2. No\n\n  Press enter to confirm",
        // A footer that is not Codex's: no `·` row, or more than two rows, or two blank rows.
        "› hi\n\n  Press enter to confirm",
        "› hi\n\n  gpt · ~/p\n  ? for shortcuts\n  one more",
        "› hi\n\n\n  gpt · ~/p",
        // A choice in the footer.
        "› hi\n\n  gpt · ~/p\n  › 1. Yes",
    ] {
        assert_eq!(codex(screen), None, "{screen:?}");
    }
}
// v1b-21: stop cancels queued sends without finish_send; their act hashes go with them.
#[test]
fn stop_drops_act_hashes_of_canceled_sends() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("hashes-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let mut core = Sessions::open(&fs::canonicalize(&home).unwrap()).unwrap();
    core.widget_hashes.insert("gone".into(), "hash".into());
    core.stop().unwrap();
    assert!(core.widget_hashes.is_empty());
    let _ = fs::remove_dir_all(home);
}
// Ticket 1122 B: after the owner's Stop no start goes through (its holder would outlive the core).
#[test]
fn no_start_after_stop() {
    let home = scratch("start-after-stop");
    let mut core = Sessions::open(&home).unwrap();
    core.stop().unwrap();
    let launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    assert_eq!(
        core.start(&launch).unwrap_err(),
        "core is stopping; nothing starts"
    );
    assert!(core.entries.is_empty());
    let _ = fs::remove_dir_all(home);
}
/// Look v16 Home: the real order of a quit during a scheduled run. The run's session is seen, the app stops the
/// core, the server's loop ticks once more, and the next core starts: the run reads "interrupted when the app
/// closed", not "the session ended before the task was done".
#[test]
fn a_run_stopped_with_the_app_reads_interrupted_at_the_next_start() {
    use crate::schedule::{Last, Outcome, Run, When};
    let home = scratch("sched-quit");
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    let run = Run {
        kind: AgentKind::Claude,
        project: home.clone(),
        label: "nightly".into(),
        model: None,
        effort: None,
        task: None,
        teammate: None,
        level: None,
    };
    let when = When {
        at: "21:00".into(),
        daily: true,
        days: vec![],
    };
    let known = std::collections::BTreeSet::from([home.to_string_lossy().into_owned()]);
    let entry = core
        .schedules
        .add_on(run, when, None, &known, 0, &|_| 0)
        .unwrap();
    let last = Last {
        session: Some(session.id.clone()),
        at: 1,
        result: None,
        reason: None,
    };
    core.schedules.record(&entry, last);
    core.tick().unwrap(); // the run's session is seen, still on its task
    core.handle(Request::Stop).unwrap();
    core.tick().unwrap(); // the loop's tick that waited on the lock the Stop held
    assert_eq!(
        core.schedules.list().unwrap()[0]
            .last
            .as_ref()
            .unwrap()
            .result,
        None
    );
    drop((core, launch));
    let mut core = Sessions::open(&home).unwrap();
    core.tick().unwrap();
    let last = core.schedules.list().unwrap()[0].last.clone().unwrap();
    assert_eq!(
        (last.result, last.reason.as_deref()),
        (
            Some(Outcome::Failed),
            Some("interrupted when the app closed")
        )
    );
    core.handle(Request::Stop).unwrap();
    let _ = fs::remove_dir_all(home);
}
/// Ticket 1002 lane 4: a second failure in a row names the streak on the card (a first one, or one after a good
/// run, keeps ticket 993's card), and a slot skipped as too late neither drops the card nor breaks the streak.
#[test]
fn a_failed_runs_card_names_a_streak_and_survives_a_skip() {
    use crate::schedule::{Last, Outcome, Run, When};
    let home = scratch("sched-twice");
    let mut core = Sessions::open(&home).unwrap();
    let run = Run {
        kind: AgentKind::Claude,
        project: home.clone(),
        label: "nightly".into(),
        model: None,
        effort: None,
        task: None,
        teammate: None,
        level: None,
    };
    let when = When {
        at: "21:00".into(),
        daily: true,
        days: vec![],
    };
    let known = std::collections::BTreeSet::from([home.to_string_lossy().into_owned()]);
    let entry = core
        .schedules
        .add_on(run, when, None, &known, 0, &|_| 0)
        .unwrap();
    let done = |core: &mut Sessions, result: Outcome, at: u64| {
        let failed = result == Outcome::Failed;
        let last = Last {
            session: None,
            at,
            result: Some(result),
            reason: failed.then(|| "boom".to_string()),
        };
        core.schedules.record(&entry, last);
        if failed {
            core.failed_run_card(&entry.id, "boom");
        }
        core.schedules_changed();
    };
    let reasons = |core: &Sessions| -> Vec<String> {
        core.queue
            .owner_items()
            .into_iter()
            .filter_map(|d| match d.owner {
                Some(queue::OwnerAsk::Schedule { reason, .. }) => reason,
                _ => None,
            })
            .collect()
    };
    done(&mut core, Outcome::Failed, 1);
    assert_eq!(
        reasons(&core),
        ["boom"],
        "a first failure: ticket 993's card"
    );
    done(&mut core, Outcome::Failed, 2);
    assert_eq!(reasons(&core), ["boom · second time in a row"]);
    done(&mut core, Outcome::Finished, 3);
    assert!(reasons(&core).is_empty(), "a good run takes the card away");
    done(&mut core, Outcome::Failed, 4);
    assert_eq!(
        reasons(&core),
        ["boom"],
        "a good run between resets the streak"
    );
    // Ten days later at noon, more than 2 h past its 21:00 slot: skipped and logged, and the card stays.
    let fired = core
        .schedules
        .take_due(10 * 86_400_000 + 12 * 3_600_000, &|_| 0);
    assert!(fired.is_empty());
    let last = core.schedules.list().unwrap()[0].last.clone().unwrap();
    assert_eq!(last.result, Some(Outcome::Skipped));
    core.schedules_changed();
    assert_eq!(
        reasons(&core),
        ["boom"],
        "a skip keeps the failed run's card"
    );
    done(&mut core, Outcome::Failed, 5);
    assert_eq!(
        reasons(&core),
        ["boom · second time in a row"],
        "a skip is no run"
    );
    core.handle(Request::Stop).unwrap();
    let _ = fs::remove_dir_all(home);
}
#[test]
fn one_wait_error_does_not_disable_snapshot_close_or_stop() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("wait-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/usr/bin/true".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    // Reap at the OS seam, leaving the actual Child handle to encounter ECHILD.
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(session.pid.unwrap() as i32, &mut status, 0) },
        session.pid.unwrap() as i32
    );
    match core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => assert_eq!(sessions[0].state, SessionState::Failed),
        _ => panic!(),
    }
    core.handle(Request::Close { id: session.id }).unwrap();
    core.handle(Request::Stop).unwrap();
    drop(core);
    fs::remove_dir_all(home).unwrap();
}
// v1a-09
#[test]
fn lifetime_settings_default_persist_and_keep_other_keys() {
    let home = scratch("life");
    fs::write(
        home.join("settings.json"),
        r#"{"worktrees_dir":"/tmp/wt","stale_after_ms":5}"#,
    )
    .unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let first = settings(&mut core, LifetimePatch::default());
    assert_eq!(first.lifetime, Lifetime::KeepRunning);
    assert!(!first.start_at_login && !first.disable_hook_injection);
    let set = settings(
        &mut core,
        LifetimePatch {
            lifetime: Some(Lifetime::EndWithApp),
            disable_hook_injection: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(set.lifetime, Lifetime::EndWithApp);
    assert!(set.disable_hook_injection && !set.start_at_login);
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(settings(&mut core, LifetimePatch::default()), set);
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(file["worktrees_dir"], "/tmp/wt");
    assert_eq!(file["stale_after_ms"], 5);
    fs::remove_dir_all(home).unwrap();
}
// Ticket 250: the `features` map absorb tickets store core values in, by dotted key.
#[test]
fn core_feature_settings_round_trip_and_null_removes() {
    let home = scratch("feat");
    fs::write(home.join("settings.json"), r#"{"stale_after_ms":5}"#).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    // A file without `features` reads as an empty map.
    assert!(
        settings(&mut core, LifetimePatch::default())
            .features
            .is_empty()
    );
    let patch = |pairs: &[(&str, serde_json::Value)]| LifetimePatch {
        features: Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        ),
        ..Default::default()
    };
    let set = settings(
        &mut core,
        patch(&[
            ("terminal.scrollback_lines", 5000.into()),
            ("git.branch_prefix", "nunchiro/".into()),
        ]),
    );
    assert_eq!(set.features["terminal.scrollback_lines"], 5000);
    assert_eq!(
        core.settings.feature::<u32>("terminal.scrollback_lines"),
        Some(5000)
    );
    // Absent and wrong type both read as None (the reader's default).
    assert_eq!(core.settings.feature::<u32>("git.branch_prefix"), None);
    assert_eq!(core.settings.feature::<u32>("terminal.nothing"), None);
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(settings(&mut core, LifetimePatch::default()), set);
    assert_eq!(
        core.settings
            .feature::<String>("git.branch_prefix")
            .as_deref(),
        Some("nunchiro/")
    );
    // null removes the key, the other one stays, and so does every other file key.
    let after = settings(
        &mut core,
        patch(&[("terminal.scrollback_lines", serde_json::Value::Null)]),
    );
    assert!(!after.features.contains_key("terminal.scrollback_lines"));
    assert_eq!(after.features["git.branch_prefix"], "nunchiro/");
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        file["features"],
        serde_json::json!({"git.branch_prefix": "nunchiro/"})
    );
    assert_eq!(file["stale_after_ms"], 5);
    drop(core);
    fs::remove_dir_all(home).unwrap();
}
/// Ticket 456: a page that skips the dialog cannot turn on an item that can run commands; confirmed it goes on, and
/// turning items off or the shipped skill back on needs no confirmation.
#[test]
fn extension_on_needs_confirmation_456() {
    let home = scratch("extconfirm");
    let mut core = Sessions::open(&home).unwrap();
    let key = crate::extensions::ENABLED_KEY;
    let patch = |on: serde_json::Value, confirmed: Option<&[&str]>| LifetimePatch {
        features: Some([(key.to_string(), on)].into()),
        extensions_confirmed: confirmed.map(|c| c.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    };
    let both = serde_json::json!(["nunchiro", "custom:a", "custom:b"]);
    for confirmed in [None, Some(&["custom:b"][..]), Some(&["custom:a"][..])] {
        let e = core
            .handle(Request::QuitSettings {
                patch: patch(both.clone(), confirmed),
            })
            .unwrap_err();
        assert!(e.contains("can run commands"), "{confirmed:?}: {e}");
    }
    assert!(core.feature::<serde_json::Value>(key).is_none());
    let on = serde_json::json!(["nunchiro", "custom:a"]);
    let s = settings(&mut core, patch(on.clone(), Some(&["custom:a"])));
    assert_eq!(s.features[key], on);
    // Already on: another list keeping it needs no confirmation; off and the shipped skill never do.
    settings(&mut core, patch(serde_json::json!(["custom:a"]), None));
    settings(&mut core, patch(serde_json::json!([]), None));
    let s = settings(&mut core, patch(serde_json::json!(["nunchiro"]), None));
    assert_eq!(s.features[key], serde_json::json!(["nunchiro"]));
    drop(core);
    fs::remove_dir_all(home).unwrap();
}
/// Ticket 992: the level table is checked as a session start checks `--model` and `--effort`.
#[test]
fn level_table_refuses_what_a_start_refuses() {
    let home = scratch("levels");
    let mut core = Sessions::open(&home).unwrap();
    let patch = |v: serde_json::Value| LifetimePatch {
        features: Some([(crate::team::LEVELS_KEY.to_string(), v)].into()),
        ..Default::default()
    };
    for bad in [
        serde_json::json!({"claude": {"light": {"model": "gpt-6-sol"}}}),
        serde_json::json!({"codex": {"deep": {"effort": "ultra"}}}),
        serde_json::json!({"claude": {"huge": {}}}),
        serde_json::json!({"acp": {"light": {}}}),
        serde_json::json!({"claude": {"light": {"model": "haiku", "x": 1}}}),
    ] {
        let e = core
            .handle(Request::QuitSettings {
                patch: patch(bad.clone()),
            })
            .unwrap_err();
        assert!(e.contains("team.levels"), "{bad}: {e}");
    }
    // Ticket 994: an ACP agent's row by its name; the catalogue's newer Codex id.
    let good = serde_json::json!({"claude": {"light": {"model": "sonnet", "effort": "low"}}, "codex": {"deep": {"model": "gpt-6-sol", "effort": "ultra"}, "light": {"model": "gpt-6.1-terra"}}, "acp:gemini": {"deep": {"model": "gemini-4-carbon", "effort": "high"}}});
    let ok = settings(&mut core, patch(good.clone()));
    assert_eq!(ok.features[crate::team::LEVELS_KEY], good);
    let stored = core.feature::<serde_json::Value>(crate::team::LEVELS_KEY);
    let pick = |kind, level| {
        crate::team::level_pick(stored.as_ref(), &crate::team::agent_key(kind, None), level)
    };
    use crate::team::Level::*;
    assert_eq!(
        pick(AgentKind::Claude, Light).model.as_deref(),
        Some("sonnet")
    );
    // A cell the user did not set keeps the default.
    assert_eq!(pick(AgentKind::Claude, Deep).model.as_deref(), Some("opus"));
    assert_eq!(
        pick(AgentKind::Codex, Standard).effort.as_deref(),
        Some("medium")
    );
    assert_eq!(
        pick(AgentKind::Codex, Deep).effort.as_deref(),
        Some("ultra")
    );
    drop(core);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn core_feature_settings_refuse_bad_key_and_oversize() {
    let home = scratch("featbad");
    let mut core = Sessions::open(&home).unwrap();
    settings(
        &mut core,
        LifetimePatch {
            features: Some([("a.b".to_string(), 1.into())].into()),
            ..Default::default()
        },
    );
    let before = fs::read(home.join("settings.json")).unwrap();
    let refused = |core: &mut Sessions, k: &str, v: serde_json::Value| {
        // A good key beside the bad one: the whole patch is refused, nothing half-written.
        let features = Some([("x.ok".to_string(), true.into()), (k.to_string(), v)].into());
        core.handle(Request::QuitSettings {
            patch: LifetimePatch {
                features,
                keep_awake: Some(true),
                ..Default::default()
            },
        })
        .unwrap_err()
    };
    for bad in [
        "nodot", "Up.per", "a.", ".a", "a..b", "a.b-c", "a_b.c", "a.b/c", "",
    ] {
        let e = refused(&mut core, bad, 1.into());
        assert!(e.contains("feature key"), "{bad}: {e}");
    }
    let big = serde_json::Value::String("x".repeat(4096));
    assert!(refused(&mut core, "a.big", big).contains("4096"));
    // Exactly 4096 bytes serialised is allowed (4094 characters plus the two quotes).
    let edge = serde_json::Value::String("x".repeat(4094));
    let ok = settings(
        &mut core,
        LifetimePatch {
            features: Some([("a.edge".to_string(), edge)].into()),
            ..Default::default()
        },
    );
    assert!(ok.features.contains_key("a.edge"));
    assert!(!ok.features.contains_key("x.ok") && !ok.keep_awake);
    assert_ne!(fs::read(home.join("settings.json")).unwrap(), before);
    drop(core);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn a_toggle_keeps_edits_made_to_settings_json_since_the_core_started() {
    let home = scratch("lifeedit");
    fs::write(home.join("settings.json"), r#"{"stale_after_ms":5}"#).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    // Edited while the core runs: a changed known key and a key this build does not know.
    fs::write(
        home.join("settings.json"),
        r#"{"stale_after_ms":9,"worktrees_dir":"/tmp/wt","permission_answers":{"a":1}}"#,
    )
    .unwrap();
    settings(
        &mut core,
        LifetimePatch {
            start_at_login: Some(true),
            ..Default::default()
        },
    );
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(file["stale_after_ms"], 9);
    assert_eq!(file["worktrees_dir"], "/tmp/wt");
    assert_eq!(file["permission_answers"]["a"], 1);
    assert_eq!(file["start_at_login"], true);
    assert_eq!(file.as_object().unwrap().len(), 4);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn an_empty_patch_only_reads() {
    use std::os::unix::fs::MetadataExt;
    let home = scratch("liferead");
    let mut core = Sessions::open(&home).unwrap();
    // No file: reading must not create one.
    assert_eq!(
        settings(&mut core, LifetimePatch::default()).lifetime,
        Lifetime::KeepRunning
    );
    assert!(!home.join("settings.json").exists());
    fs::write(home.join("settings.json"), r#"{"stale_after_ms":5}"#).unwrap();
    let before = fs::metadata(home.join("settings.json")).unwrap();
    settings(&mut core, LifetimePatch::default());
    let after = fs::metadata(home.join("settings.json")).unwrap();
    // A rewrite renames a new file into place, so the inode would change.
    assert_eq!(before.ino(), after.ino());
    assert_eq!(
        fs::read(home.join("settings.json")).unwrap(),
        br#"{"stale_after_ms":5}"#
    );
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn a_toggle_refuses_a_settings_file_that_became_unreadable() {
    let home = scratch("lifebroken");
    let mut core = Sessions::open(&home).unwrap();
    fs::write(home.join("settings.json"), "{not json").unwrap();
    let err = core.handle(Request::QuitSettings {
        patch: LifetimePatch {
            start_at_login: Some(true),
            ..Default::default()
        },
    });
    assert!(err.is_err());
    assert_eq!(fs::read(home.join("settings.json")).unwrap(), b"{not json");
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn history_settings_refuse_unknown_keys_and_persist_before_deleting() {
    let home = scratch("history");
    fs::write(home.join("settings.json"), r#"{"keep_histroy":false}"#).unwrap();
    assert!(matches!(Sessions::open(&home), Err(e) if e.contains("invalid settings")));
    fs::remove_file(home.join("settings.json")).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let read = settings(&mut core, LifetimePatch::default());
    assert!(read.keep_history && !read.mask_history);
    crate::scrollback::save(&home, "s1", b"x", false).unwrap();
    // A refused write turns nothing off and deletes nothing.
    fs::create_dir(home.join("settings.json")).unwrap();
    let off = LifetimePatch {
        keep_history: Some(false),
        ..Default::default()
    };
    assert!(
        core.handle(Request::QuitSettings { patch: off.clone() })
            .is_err()
    );
    assert!(crate::scrollback::load(&home, "s1").unwrap().is_some());
    assert!(settings(&mut core, LifetimePatch::default()).keep_history);
    fs::remove_dir(home.join("settings.json")).unwrap();
    assert!(!settings(&mut core, off).keep_history);
    assert!(crate::scrollback::load(&home, "s1").unwrap().is_none());
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn a_failed_settings_write_changes_nothing() {
    let home = scratch("lifefail");
    let mut core = Sessions::open(&home).unwrap();
    // A directory where the file goes makes the atomic rename fail.
    fs::create_dir(home.join("settings.json")).unwrap();
    let err = core.handle(Request::QuitSettings {
        patch: LifetimePatch {
            lifetime: Some(Lifetime::EndWithApp),
            ..Default::default()
        },
    });
    assert!(err.is_err());
    fs::remove_dir(home.join("settings.json")).unwrap();
    assert_eq!(
        settings(&mut core, LifetimePatch::default()).lifetime,
        Lifetime::KeepRunning
    );
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn a_patch_with_an_unknown_field_is_refused() {
    let bad = r#"{"op":"quit_settings","patch":{"lifetime":"end_with_app","extra":1}}"#;
    assert!(serde_json::from_str::<Request>(bad).is_err());
    let wrong = r#"{"op":"quit_settings","patch":{"lifetime":"forever"}}"#;
    assert!(serde_json::from_str::<Request>(wrong).is_err());
}
// v1a-14
// F24: an automatic swap never cancels a queued send, and goes ahead once the queue is empty.
#[test]
fn exit_if_idle_waits_for_a_queued_send() {
    let home = scratch("exitidle");
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    let queued = crate::delivery::Send {
        id: "s1".into(),
        sender: "user".into(),
        at: 0,
        completion_seq: 0,
        last_activity: 0,
        content: "queued".into(),
        keys: vec![],
        submit: true,
        status: "queued".into(),
        settle: None,
        remote: None,
    };
    core.entry(&session.id).unwrap().meta.send_queue = vec![queued];
    let floor = crate::holder::frame::MIN_COMPATIBLE;
    assert_eq!(core.exit_blockers(floor), 1);
    assert_eq!(core.exit_blockers(u16::MAX), 1, "one session counts once");
    core.entry(&session.id).unwrap().meta.send_queue.clear();
    assert_eq!(core.exit_blockers(floor), 0);
    assert_eq!(core.exit_blockers(u16::MAX), 1, "a holder below the floor");
    // Ticket 1130 A-D3: the same count as a request, which leaves the core running
    let asked = core.handle(Request::ExitBlockers {
        holder_floor: u16::MAX,
    });
    assert!(
        matches!(asked, Ok(Reply::ExitBlockers { count: 1 })),
        "{asked:?}"
    );
    assert!(!core.left);
    core.launching = Some(("mid-launch".into(), "hash".into()));
    assert_eq!(core.exit_blockers(floor), 1, "a launch in progress");
    core.launching = None;
    core.handle(Request::Stop).unwrap();
    drop(core);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn stop_cancels_queued_sends_in_its_one_save() {
    let home = scratch("stopsends");
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    let row = |n: usize| crate::delivery::Send {
        id: format!("s{n}"),
        sender: "user".into(),
        at: 0,
        completion_seq: 0,
        last_activity: 0,
        content: format!("queued{n}"),
        keys: vec![],
        submit: true,
        status: "queued".into(),
        settle: None,
        remote: None,
    };
    let meta = &mut core.entry(&session.id).unwrap().meta;
    meta.send_log = (0..250).map(row).collect();
    meta.send_queue = (250..260).map(row).collect();
    core.handle(Request::Stop).unwrap();
    // Saved by stop itself, so the core's next tick has nothing left to cancel one save at a time.
    let saved = crate::store::load_live(&home).unwrap().0;
    let meta = saved.iter().find(|s| s.id == session.id).unwrap();
    assert!(meta.send_queue.is_empty());
    assert_eq!(meta.send_log.len(), 256);
    assert_eq!(meta.send_log[0].id, "s4");
    assert!(meta.send_log[250..].iter().all(|s| s.status == "canceled"));
    drop(core);
    fs::remove_dir_all(home).unwrap();
}
// v1a-10: Darwin's killpg can report EPERM after the agent is already dead and reaped.
#[test]
fn picker_codex_stop_error_after_the_agent_died_still_counts_as_stopped() {
    let mut dead = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let pid = dead.id();
    dead.kill().unwrap();
    dead.wait().unwrap();
    assert_eq!(
        super::agent_stopped(
            Err("Operation not permitted (os error 1)".into()),
            pid,
            None
        ),
        Ok(())
    );
    let mut live = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let err = super::agent_stopped(
        Err("Operation not permitted (os error 1)".into()),
        live.id(),
        None,
    )
    .unwrap_err();
    assert!(err.contains("Codex did not stop"), "{err}");
    live.kill().unwrap();
    live.wait().unwrap();
    // A killed child not yet reaped (a zombie) is dead too, and checking it does not reap it.
    let mut zombie = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    zombie.kill().unwrap();
    while !crate::process::exited(zombie.id()).unwrap() {
        std::thread::yield_now();
    }
    assert_eq!(
        super::agent_stopped(Err("EPERM".into()), zombie.id(), None),
        Ok(())
    );
    assert!(zombie.try_wait().unwrap().is_some(), "still ours to reap");
}
// V2-1a r2: under a holder the agent is not the core's child; a stop error while it lives still refuses.
#[test]
fn picker_codex_stop_error_refuses_while_a_held_agent_lives() {
    let out = std::process::Command::new("/bin/sh")
        .args(["-c", "/bin/sleep 30 >/dev/null 2>&1 & echo $!"])
        .output()
        .unwrap();
    let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
    let err = super::agent_stopped(Err("session holder did not answer".into()), pid, None);
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    assert!(err.unwrap_err().contains("Codex did not stop"));
}
// v1a-19: a Running session whose terminal holds `bytes` of output that no observer pass has read yet.
struct Flood {
    core: Sessions,
    id: String,
    home: PathBuf,
}
impl Drop for Flood {
    // Ends the session's script even when the test panics.
    fn drop(&mut self) {
        let _ = fs::write(self.home.join("stop"), "");
        let _ = self.core.handle(Request::Stop);
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn flood(name: &str, bytes: &[u8]) -> Flood {
    let f = flood_script(name, bytes, "cat burst\n");
    wait_end(&f, bytes.len());
    f
}
// v1a-19 r2: `body` runs after `stty raw -echo`, then the session idles; bounded: at most 300 s after `body` (outlasts wait_end's bound),
// less once the test writes the stop file.
fn flood_script(name: &str, bytes: &[u8], body: &str) -> Flood {
    let home = scratch(name);
    fs::write(home.join("burst"), bytes).unwrap();
    let script = home.join("flood.sh");
    fs::write(
            &script,
            format!("#!/bin/sh\nstty raw -echo\n{body}i=0; while [ ! -f stop ] && [ $i -lt 6000 ]; do sleep 0.05; i=$((i+1)); done\n"),
        )
        .unwrap();
    fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![script.to_str().unwrap().into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    let mut flood = Flood {
        core,
        id: session.id,
        home,
    };
    // Shell sessions never queue a screen decision; detect as Claude would.
    flood.core.entries.get_mut(&flood.id).unwrap().meta.kind = AgentKind::Claude;
    flood
}
// Ticket 995: the holder's start size mark comes before a session's first output.
const MARK: &[u8] = b"\x1b[8;50;160t";
// `bytes` counts the agent's output; the stream also holds the mark in front of it once there is any.
fn wait_end(f: &Flood, bytes: usize) {
    let pty = f.core.entries[&f.id].pty.as_ref().unwrap();
    let want = if bytes == 0 { 0 } else { MARK.len() + bytes };
    // Waits on the state; the bound only turns a hang into a failure, never a loaded host.
    let until = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while pty.end() < want as u64 {
        assert!(
            std::time::Instant::now() < until,
            "the burst never reached the replay"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}
fn behind(f: &Flood) -> bool {
    offset(f) < f.core.entries[&f.id].pty.as_ref().unwrap().end()
}
/// The delivery record's counts over every day it holds (a test may cross midnight).
fn recorded(home: &Path) -> crate::record::Day {
    let mut sum = crate::record::Day::default();
    for d in crate::record::read(home).days.values() {
        sum.delivered += d.delivered;
        sum.resent += d.resent;
        sum.person += d.person;
    }
    sum
}
fn send_row(f: &Flood, send: &str) -> crate::delivery::Send {
    let meta = &f.core.entries[&f.id].meta;
    meta.send_queue
        .iter()
        .chain(&meta.send_log)
        .find(|s| s.id == send)
        .unwrap()
        .clone()
}
const PROMPT: &str = "\x1b[?2004h\x1b[2J\x1b[H\u{276f} \r\n";
// v1a-24: one of the `─` rules Claude 2.1.310 frames its input box with.
const RULE: &str = "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}";
// A bracketed-paste agent that reads the paste, then floods 4 MiB of composer redraws showing the pasted text
// and draws a permission dialog; every later
// input byte lands in `got`.
fn pasted_then_flooded(name: &str, settle_ago: std::time::Duration) -> (Flood, String) {
    // The agent redraws its composer holding the pasted text, as Claude does while output streams.
    let redraw = format!("\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let mut burst = redraw.repeat(4 * 1024 * 1024 / redraw.len()).into_bytes();
    burst.extend(dialog_after(0));
    let mut f = flood_script(
        name,
        &burst,
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat burst\ncat > got <&0 &\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the paste waits for its Enter"
    );
    wait_end(&f, PROMPT.len() + burst.len());
    // `written` was stamped when the prompt went in; the flood above can take longer than ENTER_CATCH_UP on a
    // loaded host, so age it from now.
    f.core.pending_enter.get_mut(&f.id).unwrap().written = std::time::Instant::now() - settle_ago;
    (f, send.id)
}
// CHAT-MODELIST r2 (security review MUST 1): while a mode walk runs, nothing but the walk's own Shift+Tab is typed:
// a peer's send and the owner's prompt queue, the owner's raw text and a second mode key are refused, the delivery
// flush waits; when the walk ends the queue goes in. A turn must never start while the footer sits in a mode the
// owner only passes through (Skip permissions).
#[test]
fn a_mode_walk_holds_every_other_input_until_it_ends() {
    let mut f = flood_script(
        "walk-hold",
        b"",
        &format!(
            "printf '{}'\ncat > got <&0 &\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    f.core.entries.get_mut(&f.id).unwrap().walk = Some(Walk {
        target: "plan".into(),
        start: "manual".into(),
        before: "manual".into(),
        chosen: false,
        failure: None,
        sent: std::time::Instant::now(),
        keys: 1,
    });
    let peer = crate::grants::Caller {
        id: "peer".into(),
        project: f.home.clone(),
    };
    let queued = |r: Response| match r {
        Ok(Reply::Delivery { send }) => send.status,
        other => panic!("not taken: {other:?}"),
    };
    assert_eq!(
        queued(f.core.handle_agent(
            &peer,
            Request::AgentSend {
                id: f.id.clone(),
                text: "from-peer".into()
            }
        )),
        "queued"
    );
    assert_eq!(
        queued(f.core.handle(Request::AgentPrompt {
            id: f.id.clone(),
            text: "from-owner".into()
        })),
        "queued"
    );
    let raw = f
        .core
        .handle(Request::SendText {
            id: f.id.clone(),
            text: "typed".into(),
            seen: vec![],
            composer: false,
        })
        .unwrap_err();
    assert!(raw.contains("mode change in progress"), "{raw}");
    let key = f
        .core
        .handle(Request::AgentKeys {
            id: f.id.clone(),
            keys: vec!["shift+tab".into()],
        })
        .unwrap_err();
    assert!(key.contains("mode change in progress"), "{key}");
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), b"", "nothing typed while the walk runs");
    f.core.entries.get_mut(&f.id).unwrap().walk = None;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    // (The peer here is no live session, so its queued send is later cancelled by the ordinary flush rules.)
    while !String::from_utf8_lossy(&got(&f)).contains("from-owner") {
        let e = &f.core.entries[&f.id].meta;
        assert!(
            std::time::Instant::now() < until,
            "the queue goes in once the walk has ended: {:?} {:?}",
            e.send_queue
                .iter()
                .map(|s| (&s.content, &s.status))
                .collect::<Vec<_>>(),
            e.send_log
                .iter()
                .map(|s| (&s.content, &s.status))
                .collect::<Vec<_>>()
        );
        f.core.tick().unwrap();
    }
}
// CHAT-MODELIST r3 helpers: a Claude composer with Claude's footer under it, as the observer reads it.
fn footer_bytes(mode_line: &str) -> Vec<u8> {
    let rule = "\u{2500}".repeat(20);
    format!("\x1b[2J\x1b[H{rule}\r\n\u{276f} \r\n{rule}\r\n  {mode_line} (shift+tab to cycle)\r\n")
        .into_bytes()
}
fn footer_session(name: &str, mode_line: &str) -> Flood {
    let bytes = footer_bytes(mode_line);
    let mut f = flood_script(name, &bytes, "cat > got <&0 &\ncat burst\n");
    wait_end(&f, bytes.len());
    f.core.observe().unwrap();
    f
}
fn walk_to(target: &str, start: &str, chosen: bool) -> Walk {
    Walk {
        target: target.into(),
        start: start.into(),
        before: start.into(),
        chosen,
        failure: None,
        sent: std::time::Instant::now(),
        keys: 1,
    }
}
// Round 3 MUST 2: the walk and its confirm end in the observe pass that shows the target, so a request right after
// the footer reaches it sees no walk (a new pick is not refused as busy) and the confirm.
#[test]
fn a_walk_ends_in_the_observe_that_shows_its_target() {
    let mut f = footer_session("walk-settle", "\u{23f5}\u{23f5} bypass permissions on");
    let entry = f.core.entries.get_mut(&f.id).unwrap();
    entry.walk = Some(walk_to(BYPASS, "manual", true));
    f.core.observe().unwrap();
    let entry = &f.core.entries[&f.id];
    assert!(entry.walk.is_none(), "the walk is over");
    assert!(entry.skip_chosen, "the confirm came with it");
}
// Round 3 MUST 1: a model switch is refused while a walk runs (the mirror of `set_mode`'s check).
#[test]
fn a_model_switch_is_refused_while_a_walk_runs() {
    let mut f = footer_session("walk-switch", "\u{23f8} manual mode");
    f.core.entries.get_mut(&f.id).unwrap().walk = Some(walk_to("plan", "manual", false));
    let refused = switch(&mut f).unwrap_err();
    assert!(refused.contains("mode change in progress"), "{refused}");
    assert!(f.core.entries[&f.id].switch.is_none());
    assert_eq!(got(&f), b"", "no meta+p reached the agent");
}
// Look 11-17 v6r B6-S2-1: the mode key changes no word in the input box. Marked as an edit by hand, the box refused
// every later agent send (a worker's finish line, a room notice) until the user's next Enter.
#[test]
fn a_mode_key_leaves_the_input_box_open_to_agent_sends() {
    let mut f = footer_session("mode-key-box", "\u{23f8} manual mode on");
    f.core
        .handle(Request::SendKeys {
            id: f.id.clone(),
            keys: vec!["shift+tab".into()],
            seen: vec![],
            composer: false,
        })
        .unwrap();
    assert_eq!(got(&f), b"\x1b[Z");
    let caller = crate::grants::Caller {
        id: "peer".into(),
        project: f.home.clone(),
    };
    f.core
        .handle_agent(
            &caller,
            Request::AgentPrompt {
                id: f.id.clone(),
                text: "agent prompt".into(),
            },
        )
        .unwrap();
}
/// Codex's screen while a turn runs: its status row, and its input box holding `row`.
fn codex_working(row: &str) -> String {
    format!(
        "\x1b[?2004h\x1b[2J\x1b[H\u{2022} Working (7s \u{2022} esc to interrupt)\r\n\r\n\u{203a} {row}\r\n\r\n  gpt \u{b7} \
             /proj\r\n"
    )
}
/// A Codex turn that runs and asks alpha or beta with `request_user_input_async` (and, with `also`, has one more
/// request waiting); the card's answer is beta.
fn answer_async_beta(f: &mut Flood, also: Option<&str>) {
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Codex;
    hook(f, "UserPromptSubmit");
    let ask = serde_json::json!({
        "tool_name": "request_user_input_async", "tool_use_id": "call_1",
        "tool_input": {"questions": [{"title": "Which name?", "options": ["alpha", "beta"]}]},
    });
    let mut events = vec![("PreToolUse", ask)];
    if let Some(event) = also {
        let run = serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls"}});
        events.push((event, run));
    }
    for (event, payload) in events {
        f.core
            .handle(Request::Hook {
                id: f.id.clone(),
                event: event.into(),
                payload,
            })
            .unwrap();
    }
    f.core.tick().unwrap();
    let item = f.core.queue.items().into_iter();
    let item = item.filter(queue::answered_by_message).map(|p| p.id).next();
    f.core
        .handle(Request::Answer {
            item: item.unwrap(),
            answer: queue::Answer::Choose { index: 1 },
            confirmed: false,
        })
        .unwrap();
    assert_eq!(rows(f)[0].status, "queued", "never written by the answer");
}
// The same answer under a request that waits (a permission's hook is known before its dialog draws): nothing is
// typed, so no Enter of the core's can answer that request.
#[test]
fn a_codex_async_answer_is_not_typed_while_a_permission_waits() {
    let first = codex_working("Ask Codex to do anything");
    let mut f = flood_script(
        "steer-held",
        first.as_bytes(),
        "cat > got <&0 &\ncat burst\n",
    );
    wait_end(&f, first.len());
    answer_async_beta(&mut f, Some("PermissionRequest"));
    for _ in 0..5 {
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(got(&f), b"", "nothing reached the agent");
    assert_eq!(rows(&f)[0].status, "queued");
}
// Look 11-17 v6r B5-S2-3 (real Codex 0.161): after `request_user_input_async` Codex keeps its turn and sleeps a
// minute at a time for the answer. The card's answer was held for the turn's end as every send is, so it came 60 to
// 130 s late. It goes into the running turn: the paste now, its Enter once the input box showed it on two passes.
#[test]
fn a_codex_async_answer_goes_into_the_turn_that_waits_for_it() {
    let screen = codex_working;
    let first = screen("Ask Codex to do anything");
    // The agent draws its input box under a running turn, reads the paste (16 bytes), draws it, then keeps every
    // later byte in `got`.
    let mut f = flood_script(
        "steer",
        first.as_bytes(),
        "cat burst\nhead -c 16 >/dev/null\ncat echo\ncat > got <&0 &\n",
    );
    fs::write(f.home.join("echo"), screen("beta")).unwrap();
    wait_end(&f, first.len());
    answer_async_beta(&mut f, None);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while fs::read(f.home.join("got")).unwrap_or_default() != b"\r" {
        assert!(
            std::time::Instant::now() < until,
            "the answer never went in: {:?}",
            rows(&f)
        );
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(f.core.queue.attention(&f.id).working, "the turn still runs");
    let sent = rows(&f);
    assert_eq!(
        (
            sent[0].content.as_str(),
            sent[0].sender.as_str(),
            sent[0].status.as_str()
        ),
        ("beta", "user", "delivered")
    );
    assert!(f.core.pending_enter.is_empty());
    f.core.tick().unwrap();
    assert!(f.core.steers.is_empty(), "forgotten with its row");
}
fn skip_hold_now() -> Option<SkipHold> {
    Some(SkipHold {
        unreadable_since: None,
    })
}
// Round 3/4: after a failed walk the hold lasts until a mode other than Skip permissions is positively read (or the
// owner confirmed Skip permissions); the observe pass lifts it.
#[test]
fn the_hold_lifts_only_after_a_non_skip_mode_is_read() {
    let mut f = footer_session("hold-bypass", "\u{23f5}\u{23f5} bypass permissions on");
    f.core.entries.get_mut(&f.id).unwrap().skip_hold = skip_hold_now();
    f.core.observe().unwrap();
    assert!(
        f.core.walk_hold(&f.id),
        "still in unconfirmed Skip permissions"
    );
    let refused = f
        .core
        .handle(Request::SendText {
            id: f.id.clone(),
            text: "typed".into(),
            seen: vec![],
            composer: false,
        })
        .unwrap_err();
    assert!(refused.contains("mode change in progress"), "{refused}");
    f.core.entries.get_mut(&f.id).unwrap().skip_chosen = true;
    f.core.observe().unwrap();
    assert!(
        !f.core.walk_hold(&f.id),
        "confirmed Skip permissions is the owner's choice"
    );
    assert!(f.core.entries[&f.id].skip_hold.is_none());
    let mut g = footer_session("hold-manual", "\u{23f8} manual mode on");
    g.core.entries.get_mut(&g.id).unwrap().skip_hold = skip_hold_now();
    g.core.observe().unwrap();
    assert!(!g.core.walk_hold(&g.id), "a non-Skip mode was read");
    let h = footer_session("hold-none", "\u{23f5}\u{23f5} bypass permissions on");
    assert!(!h.core.walk_hold(&h.id), "no failed walk, no hold");
}
// Round 4 SHOULD 2: a footer that cannot be read for a tick (a notice over the mode row) keeps the hold; only a
// positive read of another mode, or the time limit on an unreadable footer, lifts it.
#[test]
fn an_unreadable_footer_keeps_the_hold_until_the_limit() {
    let rule = "\u{2500}".repeat(20);
    let bytes = format!("\x1b[2J\x1b[H{rule}\r\n\u{276f} \r\n{rule}\r\n  1 MCP server failed\r\n")
        .into_bytes();
    let mut f = flood_script("hold-unreadable", &bytes, "cat > got <&0 &\ncat burst\n");
    wait_end(&f, bytes.len());
    f.core.observe().unwrap();
    assert_eq!(
        permission_mode(
            &f.core.entries[&f.id].observer.screen.text(),
            AgentKind::Claude
        ),
        None,
        "the footer is not readable"
    );
    f.core.entries.get_mut(&f.id).unwrap().skip_hold = skip_hold_now();
    f.core.observe().unwrap();
    assert!(f.core.walk_hold(&f.id), "unreadable is not left");
    f.core.observe().unwrap();
    assert!(f.core.walk_hold(&f.id), "and stays held on the next pass");
    let old = std::time::Instant::now() - WALK_BEHIND - std::time::Duration::from_secs(1);
    f.core.entries.get_mut(&f.id).unwrap().skip_hold = Some(SkipHold {
        unreadable_since: Some(old),
    });
    f.core.observe().unwrap();
    assert!(
        !f.core.walk_hold(&f.id),
        "the limit on an unreadable footer releases it"
    );
}
// Round 4 SHOULD 1: an owner pick refused while the hold is on does not lift it (the hold no longer rides on the
// walk's error, which a pick used to clear before its first press).
#[test]
fn a_refused_pick_does_not_lift_the_hold() {
    let mut f = footer_session("hold-refused", "\u{23f5}\u{23f5} bypass permissions on");
    let entry = f.core.entries.get_mut(&f.id).unwrap();
    entry.skip_hold = skip_hold_now();
    entry.walk_error = Some(ModeWalk {
        target: "plan".into(),
        error: Some("failed".into()),
    });
    let now = std::time::Instant::now();
    // A pending Enter makes the press busy: refused after the old code had cleared the error.
    f.core.pending_enter.insert(
        f.id.clone(),
        PendingEnter {
            send: "s".into(),
            input: Default::default(),
            offset: 0,
            written: now,
            last: 0,
            quiet: now,
            held: false,
        },
    );
    let refused = f.core.set_mode("user", &f.id, "plan");
    assert!(refused.is_err(), "{refused:?}");
    assert!(f.core.walk_hold(&f.id), "the refused pick left the hold on");
    assert!(
        f.core.entries[&f.id].walk_error.is_some(),
        "and the failure still shows"
    );
}
// Ticket 362: picking Bypass permissions while the footer already shows it is the owner's choice and ends the hold.
#[test]
fn picking_bypass_while_held_there_ends_the_hold() {
    let mut f = footer_session("hold-pick-skip", "\u{23f5}\u{23f5} bypass permissions on");
    let entry = f.core.entries.get_mut(&f.id).unwrap();
    entry.skip_hold = skip_hold_now();
    entry.args = Some(vec![ALLOW_SKIP.into()]);
    assert!(matches!(
        f.core.set_mode("user", &f.id, BYPASS),
        Ok(Reply::Ack)
    ));
    assert!(f.core.entries[&f.id].skip_chosen);
    f.core.observe().unwrap();
    assert!(!f.core.walk_hold(&f.id));
}
// Round 3 SHOULD: a walk whose output viewer lags ends after a time limit and releases the hold.
#[test]
fn a_walk_whose_output_lags_ends_after_a_limit() {
    let mut f = footer_session("walk-lag", "\u{23f8} manual mode");
    let mut walk = walk_to("plan", "manual", false);
    walk.sent = std::time::Instant::now() - WALK_BEHIND - std::time::Duration::from_secs(1);
    let entry = f.core.entries.get_mut(&f.id).unwrap();
    entry.walk = Some(walk);
    entry.observer.behind = true;
    f.core.advance_walks();
    let entry = &f.core.entries[&f.id];
    assert!(entry.walk.is_none(), "the hold is released");
    let error = entry.walk_error.as_ref().unwrap().error.as_ref().unwrap();
    assert!(error.contains("behind"), "{error}");
}
// v1a-29: the reader holds after it publishes the prompt's end, so a send sees the end before the reader's
// later work. Paste mode must already be recorded: the send waits for its Enter instead of writing "hi\r".
#[test]
fn a_send_right_after_paste_mode_arrives_waits_for_its_enter() {
    let (release, hold) = std::sync::mpsc::channel();
    crate::pty::HOLD_AFTER_PUBLISH.set(Some(hold));
    let mut f = flood_script(
        "paste-order",
        b"",
        &format!(
            "printf '{}'\ncat > got <&0 &\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    // One printf write: the reader holds after its first read, which carries the whole prompt.
    wait_end(&f, PROMPT.len());
    let Ok(Reply::Delivery { .. }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    drop(release);
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the text and its Enter went in one write"
    );
}
// v1a-30 (V1A-29 NIT): the same guarantee for the switch off. Paste mode is on from the prompt, then a later read
// carries only `ESC[?2004l` and the reader holds after publishing it: a send then writes text and Enter at once.
#[test]
fn a_send_right_after_paste_mode_ends_writes_its_enter_at_once() {
    let (release, hold) = std::sync::mpsc::channel();
    crate::pty::HOLD_AFTER_PUBLISH.set(Some(hold));
    let mut f = flood_script(
        "paste-off-order",
        b"",
        &format!(
            "printf '{}'\nj=0; while [ ! -f go ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '\\033[?2004l'\ncat > got <&0 &\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    release.send(()).unwrap();
    fs::write(f.home.join("go"), "").unwrap();
    wait_end(&f, PROMPT.len() + "\x1b[?2004l".len());
    let Ok(Reply::Delivery { .. }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    drop(release);
    assert!(
        !f.core.pending_enter.contains_key(&f.id),
        "the send still waited for an Enter after paste mode ended"
    );
}
// v1a-24 r3 (review r2 MUST-1): the agent draws the box holding the paste, then a dialog under it in a later
// read. The Enter waits for a quiet screen, so the box alone never gets it.
#[test]
fn an_echoed_enter_waits_for_a_quiet_screen() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let mut f = flood_script(
        "enter-quiet",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the paste went as a bracketed paste"
    );
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    assert!(
        composer(
            &f.core.entries[&f.id].observer.screen.text(),
            AgentKind::Claude
        )
        .is_some()
    );
    // The box holds the paste, but the output only just changed: no Enter on this pass.
    f.core.flush_delivery().unwrap();
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the Enter went on a fresh frame"
    );
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    catch_up(&mut f);
    f.core.pending_enter.get_mut(&f.id).unwrap().written -= SETTLE;
    f.core.flush_delivery().unwrap();
    let row = send_row(&f, &send.id);
    // Ticket 1094: the user's own message waits in the queue again, never left failed with its words in the box.
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        !fs::read(f.home.join("got"))
            .unwrap_or_default()
            .contains(&b'\r')
    );
}
// v1a-24 r4 (review r3 SHOULD-1): output that lands after a pass read the screen, before its Enter, is read first.
#[test]
fn the_enter_waits_for_output_that_arrived_after_the_read() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let mut f = flood_script(
        "enter-unread",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the paste went as a bracketed paste"
    );
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // sees the box change: not quiet yet
    // The box has been quiet long enough; the dialog lands after this pass's read, before its write.
    f.core.pending_enter.get_mut(&f.id).unwrap().quiet -= SWITCH_SETTLE;
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    f.core.flush_enters().unwrap();
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the Enter went with output unread"
    );
    catch_up(&mut f);
    f.core.pending_enter.get_mut(&f.id).unwrap().written -= SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    // Ticket 1094: the user's own message waits in the queue again, never left failed with its words in the box.
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        !fs::read(f.home.join("got"))
            .unwrap_or_default()
            .contains(&b'\r')
    );
}
#[test]
fn a_pending_enter_waits_while_the_observer_is_behind_then_honors_the_dialog() {
    let (mut f, send) = pasted_then_flooded("enter-wait", std::time::Duration::ZERO);
    assert!(
        behind(&f),
        "the burst is unread while the echoed paste shows in the composer"
    );
    let mut passes = 0;
    while f.core.pending_enter.contains_key(&f.id) {
        f.core.flush_delivery().unwrap();
        passes += 1;
        assert!(passes <= 40, "the Enter never resolved");
    }
    assert!(!behind(&f));
    let row = send_row(&f, &send);
    // Ticket 1094: the user's own message waits again for every drop reason; the composer says why.
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_blocked"));
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
    assert!(
        !fs::read(f.home.join("got"))
            .unwrap_or_default()
            .contains(&b'\r')
    );
}
#[test]
fn a_pending_enter_that_cannot_catch_up_in_time_is_dropped() {
    let (mut f, send) = pasted_then_flooded(
        "enter-late",
        ENTER_CATCH_UP + std::time::Duration::from_secs(1),
    );
    assert!(behind(&f));
    f.core.flush_delivery().unwrap();
    assert!(!f.core.pending_enter.contains_key(&f.id));
    let row = send_row(&f, &send);
    // Ticket 1094: the user's own message waits again (here the screen was behind); the composer says why. The saved
    // mark is one every core loads (r3: "enter_dropped_behind" stopped the next start).
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    assert!(
        !fs::read(f.home.join("got"))
            .unwrap_or_default()
            .contains(&b'\r')
    );
}
// A dialog on screen, then the agent redraws the same dialog (no clear, so any cut shows the same screen) 4 MiB
// worth after the test writes `more`.
fn dialog_then_backlog(name: &str) -> (Flood, String) {
    let dialog = dialog_after(0);
    let redraw = &dialog[b"\x1b[2J".len()..];
    let mut burst = dialog.clone();
    burst.extend(redraw.repeat(4 * 1024 * 1024 / redraw.len()));
    let mut f = flood_script(
        name,
        &burst,
        &format!(
            "head -c {} burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\ntail -c +{} burst\n",
            dialog.len(),
            dialog.len() + 1
        ),
    );
    wait_end(&f, dialog.len());
    f.core.observe().unwrap();
    let item = match f.core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions[0].pending[0].id.clone(),
        _ => panic!(),
    };
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, burst.len());
    (f, item)
}
// v1a-19 r3: Claude idle at its prompt; after the test writes `more` it floods `bytes`; all input lands in `got`.
fn idle_then_backlog(name: &str, bytes: &[u8]) -> Flood {
    let mut f = flood_script(
        name,
        bytes,
        "cat > got <&0 &\nprintf '\\033[2J\\033[H\u{276f} \\r\\n'\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\ncat burst\n",
    );
    wait_end(&f, 13);
    f.core.observe().unwrap();
    assert!(
        f.core.entries[&f.id]
            .observer
            .screen
            .text()
            .starts_with('\u{276f}')
    );
    f
}
fn more(f: &Flood, bytes: usize) {
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(f, 13 + bytes);
}
fn switch(f: &mut Flood) -> Response {
    f.core.handle(Request::SwitchModel {
        id: f.id.clone(),
        model: Some("sonnet".into()),
        effort: None,
        fast: None,
        ultracode: None,
    })
}
#[test]
fn a_model_switch_during_a_backlog_with_a_dialog_behind_it_is_refused() {
    // Claude keeps redrawing its idle prompt, then a dialog: the stale screen looks ready.
    let mut burst = "\x1b[H\u{276f} \r\n"
        .repeat(4 * 1024 * 1024 / 8)
        .into_bytes();
    burst.extend(dialog_after(0));
    let mut f = idle_then_backlog("switch-lag", &burst);
    more(&f, burst.len());
    let refused = switch(&mut f).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    let entry = &f.core.entries[&f.id];
    assert!(entry.switch.is_none());
    assert!(
        entry.meta.send_queue.is_empty() && entry.meta.send_log.is_empty(),
        "nothing was sent"
    );
    catch_up(&mut f);
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
    assert_eq!(fs::read(f.home.join("got")).unwrap_or_default(), b"");
}
#[test]
fn a_failing_switch_writes_no_key_while_the_observer_is_behind() {
    let burst = b"line of output\r\n".repeat(4 * 1024 * 1024 / 16);
    let mut f = idle_then_backlog("switch-fail-lag", &burst);
    assert!(switch(&mut f).is_ok());
    more(&f, burst.len());
    // The picker never showed and the deadline has passed, but the screen is not current.
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .switch
        .as_mut()
        .unwrap()
        .sent -= std::time::Duration::from_secs(11);
    f.core.observe().unwrap();
    assert!(behind(&f));
    f.core.advance_switches().unwrap();
    assert!(
        f.core.entries[&f.id].switch.is_some(),
        "the failure waits for a current screen"
    );
    catch_up(&mut f);
    f.core.advance_switches().unwrap();
    let entry = &f.core.entries[&f.id];
    assert!(entry.switch.is_none());
    assert_eq!(entry.meta.send_log.last().unwrap().status, "failed");
}
// v1a-22: a switch whose picker never answered, past its deadline, after `burst` has been caught up.
fn overdue_switch(name: &str, burst: &[u8]) -> Flood {
    let mut f = idle_then_backlog(name, burst);
    assert!(switch(&mut f).is_ok());
    more(&f, burst.len());
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .switch
        .as_mut()
        .unwrap()
        .sent -= std::time::Duration::from_secs(11);
    catch_up(&mut f);
    f
}
// Everything the agent read after the picker key; `cat` gets a moment to copy a late byte.
fn written_after_open(f: &Flood) -> Vec<u8> {
    std::thread::sleep(std::time::Duration::from_millis(300));
    let got = fs::read(f.home.join("got")).unwrap_or_default();
    assert!(got.starts_with(PICKER_OPEN), "{got:?}");
    got[PICKER_OPEN.len()..].to_vec()
}
fn failed(f: &Flood) -> bool {
    let entry = &f.core.entries[&f.id];
    entry.switch.is_none() && entry.meta.send_log.last().unwrap().status == "failed"
}
#[test]
fn a_failed_switch_does_not_dismiss_a_dialog_that_arrived_during_the_backlog() {
    let mut burst = b"line of output\r\n".repeat(512 * 1024 / 16);
    burst.extend(dialog_after(0));
    let mut f = overdue_switch("switch-fail-dialog", &burst);
    // Look 11-17 v5 item 1 (rule a): a dialog that is not the switch's own picker is a card while the switch runs.
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
    f.core.advance_switches().unwrap();
    assert!(failed(&f));
    assert_eq!(written_after_open(&f), b"", "no key on the dialog");
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
}
// Ticket 287: the picker Claude 2.1.318 draws (recorded from the real binary): version-numbered rows with older
// versions below, no "s to use this session only" hint, a "Model set to ... for this session only" confirmation.
const PICKER_2_1_318: &str = include_str!("../../tests/fixtures/claude-2.1.318-model-picker.txt");
/// The recorded screen with the cursor on row `focus` and the effort line at `effort` (e.g. "High").
fn picker_at(focus: usize, effort: &str) -> String {
    let rows: Vec<String> = PICKER_2_1_318
        .lines()
        .map(|l| {
            let bare = l
                .trim_start()
                .trim_start_matches(['\u{276f}', '\u{2193}'])
                .trim_start();
            let n: usize = bare
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            if n > 0 && bare[n.to_string().len()..].starts_with('.') {
                format!("{}{bare}", if n == focus { "  \u{276f} " } else { "    " })
            } else {
                l.replace("Medium effort (default)", &format!("{effort} effort"))
            }
        })
        .collect();
    rows.join("\r\n")
}
#[test]
fn picker_step_drives_claude_2_1_318_picker() {
    let at = |focus, model: Option<&str>, effort: Option<&str>, shown| {
        picker_step(&picker_at(focus, shown), model, effort, false)
    };
    // Haiku 5.5 is focused; Sonnet 5.5 (row 4) is the newest Sonnet, so up.
    assert_eq!(at(5, Some("sonnet"), None, "Medium"), Step::Keys(b"\x1b[A"));
    // An older "Sonnet 5" (row 7) is not the model the alias names: keep going up.
    assert_eq!(at(7, Some("sonnet"), None, "Medium"), Step::Keys(b"\x1b[A"));
    assert_eq!(at(4, Some("haiku"), None, "Medium"), Step::Keys(b"\x1b[B"));
    assert_eq!(
        at(1, None, None, "Medium"),
        Step::Keys(b"s"),
        "Default row, no hint line needed"
    );
    assert_eq!(at(4, Some("sonnet"), None, "Medium"), Step::Keys(b"s"));
    assert_eq!(
        at(4, Some("sonnet"), Some("high"), "Medium"),
        Step::Keys(b"\x1b[C")
    );
    assert_eq!(
        at(4, Some("sonnet"), Some("high"), "High"),
        Step::Keys(b"s")
    );
    // A footer that names "set as default" without the session-only key is another picker: fail, never guess.
    let other = format!(
        "{}\r\n  Enter to set as default \u{b7} Esc to cancel",
        picker_at(4, "Medium")
    );
    assert!(matches!(
        picker_step(&other, Some("sonnet"), None, false),
        Step::Fail(_)
    ));
    let done = "  Haiku 5.5 \u{b7} Claude Ultra\r\n  Model set to haiku (claude-haiku-5-5) for this session only\r\n\u{276f} \r\n";
    assert_eq!(picker_step(done, Some("haiku"), None, true), Step::Done);
    // Ticket 991 B2: the same line wrapped by a narrow terminal; another model's line proves nothing.
    let wrapped = "  Haiku 5.5 \u{b7} Claude Ultra\r\n  Set model to Sonnet 5.5 (claude-sonnet-5-5) for this session\r\n  only\r\n\u{276f} \r\n";
    assert_eq!(picker_step(wrapped, Some("sonnet"), None, true), Step::Done);
    assert_eq!(picker_step(wrapped, Some("haiku"), None, true), Step::Wait);
    // Cut short by Claude at 62 columns, as seen in the real app; a permission option's words prove nothing.
    let cut = "  Model set to sonnet\r\n  (claude-sonnet-5-5) for this session\r\n  \u{2026}\r\n\u{276f} \r\n";
    assert_eq!(picker_step(cut, Some("sonnet"), None, true), Step::Done);
    // Look 11-17 N3: Claude 2.1.326 at 44 columns cuts the line before "for this session"; another model's proves nothing.
    let narrow = "  Model set to sonnet (claude-sonnet-5-5)\u{2026}\r\n\u{276f} \r\n";
    assert_eq!(picker_step(narrow, Some("sonnet"), None, true), Step::Done);
    assert_eq!(picker_step(narrow, Some("haiku"), None, true), Step::Wait);
    let option = "  2. Yes, and let sonnet edit\r\n  for this session (shift+tab)\r\n";
    assert_eq!(picker_step(option, Some("sonnet"), None, true), Step::Wait);
}
/// The keys `picker_step` sends on the recorded 2.1.318 picker (cursor on Haiku 5.5, effort Medium) until it
/// stops asking for keys, with the screen a tiny simulator of that picker draws after each one.
fn picker_keys_2_1_318(model: &str, effort: &str) -> Vec<&'static [u8]> {
    let (mut focus, mut shown) = (5usize, 1usize);
    let levels = ["Low", "Medium", "High", "XHigh", "Max"];
    let mut keys = vec![];
    for _ in 0..40 {
        match picker_step(
            &picker_at(focus, levels[shown]),
            Some(model),
            Some(effort),
            false,
        ) {
            Step::Keys(k) => {
                keys.push(k);
                match k {
                    b"\x1b[A" => focus -= 1,
                    b"\x1b[B" => focus += 1,
                    b"\x1b[C" => shown += 1,
                    b"\x1b[D" => shown -= 1,
                    _ => return keys,
                }
            }
            other => panic!("{other:?} after {keys:?}"),
        }
    }
    panic!("no choice after 40 keys: {keys:?}")
}
// Ticket 287 S4: the picker half only. The switch the owner saw fail was a Claude model pick; on 2.1.318 it reaches
// Sonnet 5.5 / high with Up, Right, `s`.
#[test]
fn picker_reaches_sonnet_high_on_2_1_318() {
    assert_eq!(
        picker_keys_2_1_318("sonnet", "high"),
        [&b"\x1b[A"[..], b"\x1b[C", b"s"]
    );
}
// Ticket 287 S4: the whole flow the owner used. A Claude model pick reaches its choice on the 2.1.318 picker, and the
// hand-off to Codex that follows starts a Codex session and queues the text. `handoff_send` never uses the picker;
// the pick is the only part that was broken, so the red of this test is `picker_reaches_sonnet_high_on_2_1_318`'s.
#[test]
fn picker_switch_to_codex_2_1_318() {
    assert_eq!(
        picker_keys_2_1_318("sonnet", "high").last(),
        Some(&&b"s"[..])
    );
    let (registry, home, from) = handoff_core("handoff-after-pick");
    let reply = handoff_send(
        &registry,
        None,
        &from,
        AgentKind::Codex,
        None,
        "over to you",
    );
    let target = match reply {
        Ok(Reply::Switched { session, .. }) => session.id,
        other => panic!("{other:?}"),
    };
    assert_eq!(handed(&registry, &target).len(), 1);
    end_handoff(registry, home);
}
// Ticket 287 S2: a "Select model" block left in view above the input box is not the live picker, so no key goes
// out for it, and neither does a block that shows no sign of being Claude's picker (no footer, no 2.1.318 line).
#[test]
fn n6_a_codex_session_is_titled_by_its_first_own_message() {
    let user = |text: &str| serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}});
    let records = [
        user("<environment_context>\n<cwd>/p</cwd>\n</environment_context>"),
        user("Reply with only the word pong."),
    ];
    assert_eq!(
        codex_title(&records).as_deref(),
        Some("Reply with only the word pong.")
    );
    assert_eq!(codex_title(&records[..1]), None);
}
#[test]
fn auto_title_cuts_at_a_word_and_skips_non_prompts() {
    assert_eq!(
        auto_title("  \nFix the login bug\nmore").as_deref(),
        Some("Fix the login bug")
    );
    assert_eq!(
        auto_title("Add a tax(rate) function to app.py with a test, then run the tests").as_deref(),
        Some("Add a tax(rate) function to app.py with…")
    );
    assert_eq!(auto_title("/model sonnet"), None);
    assert_eq!(auto_title("<side-chat-context>\nx"), None);
    assert_eq!(
        auto_title("Handoff from Claude (2 turns, session ab)"),
        None
    );
    assert_eq!(auto_title("   "), None);
    let secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let title = auto_title(&format!("use API_KEY={secret}")).unwrap();
    assert!(!title.contains("AAAAAAAA"), "{title}");
    assert_eq!(
        auto_title("\u{1b}[31mBearer abcdefgh12345678\u{1b}[0m and more"),
        None
    );
}

#[test]
fn stale_select_model_block_gets_no_keys() {
    let rule = "\u{2500}".repeat(60);
    let stale = format!(
        "{}\n\n{rule}\n\u{276f} \n{rule}\n  ? for shortcuts\n",
        picker_at(4, "Medium")
    );
    assert_eq!(picker_step(&stale, Some("sonnet"), None, false), Step::Wait);
    let lookalike =
        "Select model\n  1.  Default (recommended)\n\u{276f} 2.  Sonnet 5.5   Most efficient\n";
    assert!(!matches!(
        picker_step(lookalike, Some("sonnet"), None, false),
        Step::Keys(_)
    ));
}
// Ticket 287 S2: a switch that fails with `p`, `s` or `ps` typed in the input box (meta+p rebound, then `s`)
// takes back every key it typed and sends no Esc; the box is empty again.
#[test]
fn failed_switch_clears_typed_keys() {
    let rule = "\u{2500}".repeat(60);
    for (name, typed, keys) in [
        ("switch-clear-p", "p", &b"\x7f"[..]),
        ("switch-clear-s", "s", b"\x7f"),
        ("switch-clear-ps", "ps", b"\x7f\x7f"),
    ] {
        let screen = format!("\x1b[2J\x1b[H{rule}\r\n\u{276f} {typed}\r\n{rule}\r\n");
        let mut f = overdue_switch(name, screen.as_bytes());
        f.core.advance_switches().unwrap();
        assert!(failed(&f), "{name}");
        assert_eq!(written_after_open(&f), keys, "{name}");
    }
}
// Ticket 287 S3: on 2.1.318 the picker draws no "Enter to set as default" footer, so the picker's own block ends at
// the effort line. The bare picker is no decision; a dialog drawn beside it is one, and its text is the dialog's.
#[test]
fn dialog_beside_picker_2_1_318() {
    let picker = picker_at(5, "Medium");
    assert!(dialog_beside_picker(&picker).is_none());
    let dialog = "Do you want to proceed?\r\n\u{276f} 1. Yes\r\n  2. No\r\nEsc to cancel \u{b7} Tab to amend\r\n";
    let found = dialog_beside_picker(&format!("{picker}\r\n{dialog}")).unwrap();
    assert!(found.text.contains("Do you want to proceed?"), "{found:?}");
    assert!(!found.text.contains("Haiku"), "{found:?}");
}
// A picker that cannot finish (here: no effort line) is closed by one Esc and leaves the session running, with no
// switch pending, no card and no other key typed.
#[test]
fn failed_switch_leaves_session_usable() {
    let screen = picker_at(4, "High")
        .replace("  \u{25d0}", "")
        .replace("High effort \u{2190}/\u{2192} to adjust", "");
    let mut f = overdue_switch("switch-fail-usable", screen.as_bytes());
    f.core.advance_switches().unwrap();
    assert!(failed(&f));
    assert_eq!(written_after_open(&f), b"\x1b");
    let entry = &f.core.entries[&f.id];
    assert_eq!(entry.meta.state, SessionState::Running);
    assert!(entry.switch.is_none() && entry.pty.is_some());
    assert_eq!(pending_text(&mut f), None);
}
const PICKER: &str = "\x1b[2J\x1b[HSelect model\r\n  1. Default (recommended)\r\n \u{276f} 2. Sonnet   Sonnet description\r\n\r\nEnter to set as default \u{b7} s to use this session only \u{b7} Esc to cancel\r\n";
#[test]
fn a_failed_switch_still_closes_the_picker() {
    for (name, screen, key) in [
        ("switch-fail-picker", PICKER.to_string(), b"\x1b"),
        (
            "switch-fail-prompt",
            "\x1b[2J\x1b[H\u{276f} \r\n".into(),
            b"\x1b",
        ),
        (
            "switch-fail-stray",
            format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} p\r\n{RULE}\r\n"),
            b"\x7f",
        ),
    ] {
        let mut f = overdue_switch(name, screen.as_bytes());
        f.core.advance_switches().unwrap();
        assert!(failed(&f), "{name}");
        assert_eq!(written_after_open(&f), key, "{name}");
        assert_eq!(pending_text(&mut f), None, "{name}");
    }
}
#[test]
fn a_failed_switch_closes_the_picker_beside_a_background_line() {
    // V1A-22 review SHOULD-1: a running shell is no decision, so the picker must not stay open.
    let screen = format!("{PICKER}\r\n1 shell still running\r\n");
    let mut f = overdue_switch("switch-fail-background", screen.as_bytes());
    f.core.advance_switches().unwrap();
    assert!(failed(&f));
    assert_eq!(written_after_open(&f), b"\x1b");
}
#[test]
fn a_background_line_does_not_hide_a_dialog_beside_the_picker() {
    // v1a-24 r2 (review SHOULD-3): an unclassified dialog and a background line together are a dialog.
    let screen = format!(
        "{PICKER}Pick one\r\n\u{276f} 1. Yes\r\n  2. No\r\nEsc to cancel\r\n1 shell still running\r\n"
    );
    let mut f = overdue_switch("switch-fail-background-dialog", screen.as_bytes());
    f.core.advance_switches().unwrap();
    assert!(failed(&f));
    assert_eq!(written_after_open(&f), b"", "no key on the dialog");
    assert!(pending_text(&mut f).is_some(), "the dialog became a card");
}
#[test]
fn a_failed_switch_writes_nothing_on_a_dialog_below_the_picker() {
    let dialog = "Do you want to proceed?\r\n\u{276f} 1. Yes\r\n  2. No\r\nEsc to cancel \u{b7} Tab to amend\r\n";
    // r1 review: a leftover "Select model" row above a dialog whose own hint says "Esc to cancel".
    let leftover = format!("\x1b[2J\x1b[HSelect model\r\n{dialog}");
    for (name, screen) in [
        ("switch-fail-both", format!("{PICKER}{dialog}")),
        ("switch-fail-leftover", leftover),
    ] {
        let mut f = overdue_switch(name, screen.as_bytes());
        f.core.advance_switches().unwrap();
        assert!(failed(&f), "{name}");
        assert_eq!(written_after_open(&f), b"", "{name}");
        assert!(
            pending_text(&mut f)
                .unwrap()
                .contains("Do you want to proceed?"),
            "{name}"
        );
    }
}
#[test]
fn a_failed_switch_of_an_ended_session_writes_nothing() {
    let mut f = overdue_switch("switch-fail-ended", "\x1b[2J\x1b[H\u{276f} \r\n".as_bytes());
    f.core.entries.get_mut(&f.id).unwrap().meta.state = SessionState::Exited;
    f.core.advance_switches().unwrap();
    assert!(failed(&f));
    assert_eq!(written_after_open(&f), b"");
}
#[test]
fn switch_failure_checks_the_dialog_once_on_the_current_screen() {
    // The dialog shows while the switch runs, then the agent redraws its prompt before the deadline.
    let dialog = dialog_after(0);
    let mut f = flood_script(
        "switch-fail-current",
        &dialog,
        "cat > got <&0 &\nprintf '\\033[2J\\033[H\u{276f} \\r\\n'\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\ncat burst\nj=0; while [ ! -f again ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '\\033[2J\\033[H\u{276f} \\r\\n'\n",
    );
    wait_end(&f, 13);
    f.core.observe().unwrap();
    assert!(switch(&mut f).is_ok());
    more(&f, dialog.len());
    f.core.observe().unwrap();
    assert!(
        f.core.entries[&f.id]
            .observer
            .screen
            .text()
            .contains("Do you want to proceed?")
    );
    // Look 11-17 v5 item 1 (rule a): only the switch's own picker is hidden; this dialog is a card.
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
    fs::write(f.home.join("again"), "").unwrap();
    wait_end(&f, 13 + dialog.len() + 13);
    f.core.observe().unwrap();
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .switch
        .as_mut()
        .unwrap()
        .sent -= std::time::Duration::from_secs(11);
    f.core.advance_switches().unwrap();
    assert!(failed(&f));
    assert_eq!(
        written_after_open(&f),
        b"\x1b",
        "the current screen has no dialog"
    );
    assert_eq!(pending_text(&mut f), None);
}
fn catch_up(f: &mut Flood) {
    let mut passes = 0;
    while behind(f) {
        f.core.observe().unwrap();
        passes += 1;
        assert!(passes <= 40, "the backlog did not drain");
    }
}
#[test]
fn an_answer_during_a_backlog_is_refused_and_works_after_catch_up() {
    let (mut f, item) = dialog_then_backlog("answer-lag");
    let answer = |f: &mut Flood, item: &str| {
        f.core.handle(Request::Answer {
            item: item.into(),
            answer: queue::Answer::AllowOnce,
            confirmed: true,
        })
    };
    let refused = answer(&mut f, &item).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    let refused = f
        .core
        .handle(Request::AgentPrompt {
            id: f.id.clone(),
            text: "hi".into(),
        })
        .unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    catch_up(&mut f);
    let item = match f.core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions[0].pending[0].id.clone(),
        _ => panic!(),
    };
    let answered = answer(&mut f, &item);
    assert!(answered.is_ok(), "{answered:?}");
}
#[test]
fn agent_keys_during_a_backlog_are_refused_and_work_after_catch_up() {
    let (mut f, _) = dialog_then_backlog("keys-lag");
    let keys = |f: &mut Flood| {
        f.core.handle(Request::AgentKeys {
            id: f.id.clone(),
            keys: vec!["esc".into()],
        })
    };
    let refused = keys(&mut f).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    catch_up(&mut f);
    assert!(matches!(
        keys(&mut f),
        Ok(Reply::Ack | Reply::Delivery { .. })
    ));
}
fn offset(f: &Flood) -> u64 {
    f.core.entries[&f.id].observer.output_offset
}
fn dialog_after(filler: usize) -> Vec<u8> {
    let mut bytes = b"line of output\r\n".repeat(filler / 16);
    bytes.extend(b"\x1b[2J\x1b[HDo you want to proceed?\r\n1. Yes\r\n2. No\r\n");
    bytes
}
// ticket 115: a session whose terminal holds `bytes` no observer pass has read yet; input lands in `got`.
fn unobserved(name: &str, bytes: &[u8]) -> Flood {
    let mut f = flood_script(name, bytes, "cat > got <&0 &\ncat burst\n");
    wait_end(&f, bytes.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude; // a shell queues no decision
    f
}
fn stop_key(f: &mut Flood, seen: &[String]) -> Response {
    stop_keys(f, &["esc"], seen)
}
fn stop_keys(f: &mut Flood, keys: &[&str], seen: &[String]) -> Response {
    f.core.handle(Request::SendKeys {
        id: f.id.clone(),
        keys: keys.iter().map(|k| k.to_string()).collect(),
        seen: seen.to_vec(),
        composer: false,
    })
}
// ticket 123: the web composer's follow-up Enter, as the window sends it after `send_text`.
fn composer_keys(f: &mut Flood, keys: &[&str], seen: &[String]) -> Response {
    f.core.handle(Request::SendKeys {
        id: f.id.clone(),
        keys: keys.iter().map(|k| k.to_string()).collect(),
        seen: seen.to_vec(),
        composer: true,
    })
}
fn text_request(f: &Flood, text: &str, composer: bool, seen: &[String]) -> Request {
    serde_json::from_value(serde_json::json!({
        "op": "send_text", "id": f.id, "text": text, "composer": composer, "seen": seen,
    }))
    .unwrap()
}
/// Ticket 992 (Codex look, seven rounds): a seat is idle for a replacement only when a turn finished after the
/// last text or key went to its input box. A box the core has not seen (after a restart), a draft, a recalled
/// prompt, keys, a prompt just delivered and text typed during a turn all keep the seat.
#[test]
fn seat_is_idle_only_after_a_turn_finished_since_its_last_input() {
    let mut f = unobserved("seat-idle-typed", b"");
    let id = f.id.clone();
    let reset = |f: &mut Flood| {
        // `input` is Claude's own guard (any write makes it uncertain); reset to read the mark alone, which is all
        // a Codex seat has.
        f.core.entries.get_mut(&f.id.clone()).unwrap().input = Default::default();
    };
    let send = |f: &mut Flood, text: &str| {
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: text.into(),
                seen: vec![],
                composer: false,
            })
            .unwrap();
    };
    let turn = |f: &mut Flood| {
        hook(f, "UserPromptSubmit");
        hook(f, "Stop");
    };
    assert!(
        !f.core.seat_idle(&id),
        "a box the core has not seen (as after a core restart)"
    );
    send(&mut f, "dra");
    reset(&mut f);
    assert!(!f.core.seat_idle(&id), "a draft");
    send(&mut f, "\r");
    reset(&mut f);
    assert!(!f.core.seat_idle(&id), "entered, its turn not finished");
    turn(&mut f);
    assert!(
        f.core.seat_idle(&id),
        "a turn finished since the last input"
    );
    send(&mut f, "\x1b[I");
    reset(&mut f);
    assert!(f.core.seat_idle(&id), "a focus report is no input");
    send(&mut f, "\x1b[A");
    reset(&mut f);
    assert!(!f.core.seat_idle(&id), "Up may recall an old prompt");
    turn(&mut f);
    assert!(f.core.seat_idle(&id));
    // Text typed while a turn runs is still in the box when that turn ends.
    hook(&mut f, "UserPromptSubmit");
    send(&mut f, "next");
    reset(&mut f);
    hook(&mut f, "Stop");
    assert!(!f.core.seat_idle(&id), "typed during the turn");
    f.core.composed.insert(id.clone(), "half a sentence".into());
    turn(&mut f);
    turn(&mut f);
    assert!(!f.core.seat_idle(&id), "composer text not entered");
}
/// Look 1117 v13 N13-S2-3: the owner's composer text never answers a permission prompt, drawn by the window or not;
/// only its card does. The text is held (sent once the prompt is answered), and its Enter writes nothing.
#[test]
fn composer_text_held_while_a_permission_prompt_waits() {
    let mut f = unobserved("txt-unseen", &dialog_after(0));
    f.core.tick().unwrap();
    let ids = pending_ids(&f);
    assert_eq!(
        f.core.queue.items_of(&f.id)[0].kind,
        queue::Kind::Permission
    );
    for seen in [vec![], ids.clone()] {
        f.core.handle(text_request(&f, "1", true, &seen)).unwrap();
        composer_keys(&mut f, &["enter"], &seen).unwrap();
    }
    assert_eq!(got(&f), b"", "nothing typed into the prompt");
    assert_eq!(pending_ids(&f), ids, "the prompt still waits for its card");
    let queued: Vec<_> = f.core.entries[&f.id]
        .meta
        .send_queue
        .iter()
        .map(|s| (s.content.as_str(), s.status.as_str()))
        .collect();
    assert_eq!(queued, [("1", "queued"), ("1", "queued")]);
}
#[test]
fn composer_text_sent_when_no_new_dialog() {
    let mut f = unobserved("txt-plain", PROMPT.as_bytes());
    let request = text_request(&f, "hello 한글\nworld", true, &[]);
    f.core.handle(request).unwrap();
    assert_eq!(got(&f), "hello 한글\nworld".as_bytes());
}
#[test]
fn composer_text_refused_while_observer_behind() {
    let mut burst = "\x1b[H\u{276f} \r\n"
        .repeat(4 * 1024 * 1024 / 8)
        .into_bytes();
    burst.extend(dialog_after(0));
    let mut f = idle_then_backlog("txt-lag", &burst);
    more(&f, burst.len());
    let request = text_request(&f, "1", true, &[]);
    let refused = f.core.handle(request).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    assert_eq!(got(&f), b"");
}
#[test]
fn plain_send_text_unchanged() {
    let mut f = unobserved("txt-cli", &dialog_after(0));
    f.core.tick().unwrap();
    assert_eq!(pending_ids(&f).len(), 1);
    let request = serde_json::from_value(serde_json::json!({
        "op": "send_text", "id": f.id, "text": "1",
    }))
    .unwrap();
    f.core.handle(request).unwrap();
    assert_eq!(got(&f), b"1");
}
#[test]
fn first_prompt_titles_an_unnamed_session_and_never_a_named_one() {
    let mut f = unobserved("auto-title", PROMPT.as_bytes());
    let label = |f: &mut Flood, l: &str| {
        f.core.entries.get_mut(&f.id).unwrap().meta.label = l.into();
    };
    let prompt = |f: &mut Flood, text: &str| {
        f.core
            .handle(Request::Hook {
                id: f.id.clone(),
                event: "UserPromptSubmit".into(),
                payload: serde_json::json!({ "prompt": text }),
            })
            .unwrap();
        f.core.entries[&f.id].meta.label.clone()
    };
    label(&mut f, "");
    assert_eq!(
        prompt(&mut f, "Fix the login bug\nand more"),
        "Fix the login bug"
    );
    assert_eq!(
        prompt(&mut f, "Another task"),
        "Fix the login bug",
        "only the first prompt titles"
    );
    label(&mut f, "my name");
    assert_eq!(
        prompt(&mut f, "Later work"),
        "my name",
        "the user's name is never replaced"
    );
}
/// Ticket 1017: a first-message name is marked as one (the window numbers two equal ones); the user's rename unmarks it.
#[test]
fn first_prompt_title_is_marked_auto_and_a_rename_clears_the_mark() {
    let mut f = unobserved("auto-mark", PROMPT.as_bytes());
    f.core.entries.get_mut(&f.id).unwrap().meta.label.clear();
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "UserPromptSubmit".into(),
            payload: serde_json::json!({ "prompt": "ASK" }),
        })
        .unwrap();
    let meta = &f.core.entries[&f.id].meta;
    assert_eq!((meta.label.as_str(), meta.auto_label), ("ASK", true));
    f.core
        .handle(Request::Label {
            id: f.id.clone(),
            label: "ASK".into(),
        })
        .unwrap();
    assert!(
        !f.core.entries[&f.id].meta.auto_label,
        "a name the user set is never numbered"
    );
}
/// Ticket 1042: the transcript batch the observer reads, as `transcript_jobs` plans it.
fn read_transcript(f: &mut Flood, records: Vec<serde_json::Value>) {
    let entry = &f.core.entries[&f.id];
    let (key, offset) = f.core.queue.transcript_cursor(&f.id);
    let job = waiting::TranscriptJob {
        session: entry.meta.clone(),
        path: entry.observer.transcript.clone(),
        key,
        offset,
        discarding: f.core.queue.transcript_discarding(&f.id),
    };
    let path = job.path.clone();
    let batch = waiting::transcript::Batch {
        key: "fixture:1:1".into(),
        end: 1,
        records,
        skipped: 0,
        discarding: false,
    };
    f.core.apply_transcript(job, path, Ok(Some(batch))).unwrap();
}
/// Ticket 1042: Claude Code's own title (`ai-title` in its transcript, after the first reply) names an unnamed
/// session over its first-message name, still marked as a first-message name (1017 numbers two equal ones); a
/// hand-set name stays; with no title record (no call possible) the first-message name stays.
#[test]
fn claude_ai_title_names_an_unnamed_session_but_never_a_hand_set_one() {
    let mut f = unobserved("ai-title", PROMPT.as_bytes());
    f.core.entries.get_mut(&f.id).unwrap().meta.label.clear();
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "UserPromptSubmit".into(),
            payload: serde_json::json!({ "prompt": "why does login fail after the token refresh" }),
        })
        .unwrap();
    let reply = serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Looking."}]}});
    read_transcript(&mut f, vec![reply.clone()]);
    let meta = &f.core.entries[&f.id].meta;
    assert_eq!(
        (meta.label.as_str(), meta.auto_label),
        ("why does login fail after the token…", true),
        "no title record: the first-message name stays"
    );
    let title = |t: &str| serde_json::json!({"type":"ai-title","aiTitle":t,"sessionId":"s"});
    read_transcript(&mut f, vec![reply, title("Login token refresh")]);
    let meta = &f.core.entries[&f.id].meta;
    assert_eq!(
        (meta.label.as_str(), meta.auto_label),
        ("Login token refresh", true)
    );
    f.core
        .handle(Request::Label {
            id: f.id.clone(),
            label: "mine".into(),
        })
        .unwrap();
    read_transcript(&mut f, vec![title("Something else")]);
    assert_eq!(
        f.core.entries[&f.id].meta.label, "mine",
        "a hand-set name is never replaced"
    );
}
/// Ticket 1013 F6: a command's close (the owner socket, a session caller) marks the closed row, so the window drops its
/// tab; the window's own Close (http) leaves it unmarked and the done tab stays.
#[test]
fn a_command_close_marks_the_row_and_the_window_close_does_not() {
    let mut f = unobserved("close-by-command", PROMPT.as_bytes());
    f.core.handle(Request::Close { id: f.id.clone() }).unwrap();
    let meta = &f.core.entries[&f.id].meta;
    assert_eq!(
        (meta.state, meta.closed_by_command),
        (SessionState::Closed, true)
    );
    let mut g = unobserved("close-by-window", PROMPT.as_bytes());
    g.core.close(&g.id, true, true).unwrap();
    let meta = &g.core.entries[&g.id].meta;
    assert_eq!(
        (meta.state, meta.closed_by_command),
        (SessionState::Closed, false)
    );
}
#[test]
fn refused_enter_clears_leftover_line() {
    let mut f = unobserved("txt-clear", PROMPT.as_bytes());
    let request = text_request(&f, "leftover", true, &[]);
    f.core.handle(request).unwrap();
    // A hook queues the new request before its terminal dialog is drawn.
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "PermissionRequest".into(),
            payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"ls"}}),
        })
        .unwrap();
    f.core.tick().unwrap();
    assert_eq!(pending_ids(&f).len(), 1);
    let refused = composer_keys(&mut f, &["enter"], &[]).unwrap_err();
    assert!(refused.contains("not seen"), "{refused}");
    assert_eq!(got(&f), b"leftover\x15");
    assert!(refused.contains("current line cleared"), "{refused}");
}
#[test]
fn refused_multiline_enter_keeps_input_uncertain() {
    let mut f = unobserved("txt-multiline", PROMPT.as_bytes());
    let pasted = "\x1b[200~first line\nsecond line\x1b[201~";
    let request = text_request(&f, pasted, true, &[]);
    f.core.handle(request).unwrap();
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "PermissionRequest".into(),
            payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"ls"}}),
        })
        .unwrap();
    f.core.tick().unwrap();
    assert_eq!(pending_ids(&f).len(), 1);
    let refused = composer_keys(&mut f, &["enter"], &[]).unwrap_err();
    assert!(refused.contains("not seen"), "{refused}");
    let expected = [pasted.as_bytes(), b"\x15"].concat();
    assert_eq!(got(&f), expected);
    // The request ends; the earlier pasted line can still remain in Claude's composer.
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "Stop".into(),
            payload: serde_json::json!({}),
        })
        .unwrap();
    assert!(pending_ids(&f).is_empty());
    let caller = crate::grants::Caller {
        id: "peer".into(),
        project: f.home.clone(),
    };
    let refused = f
        .core
        .handle_agent(
            &caller,
            Request::AgentPrompt {
                id: f.id.clone(),
                text: "agent prompt".into(),
            },
        )
        .unwrap_err();
    assert!(
        refused.starts_with("cannot verify edited Claude composer"),
        "{refused}"
    );
    assert_eq!(got(&f), expected, "no agent text or Enter was written");
}
#[test]
fn refused_enter_no_clear_while_dialog_focused() {
    let dialog = dialog_after(0);
    let mut f = idle_then_backlog("txt-focused", &dialog);
    let request = text_request(&f, "leftover", true, &[]);
    f.core.handle(request).unwrap();
    more(&f, dialog.len());
    f.core.tick().unwrap();
    assert_eq!(pending_ids(&f).len(), 1);
    let refused = composer_keys(&mut f, &["enter"], &[]).unwrap_err();
    assert!(refused.contains("not seen"), "{refused}");
    assert_eq!(got(&f), b"leftover");
    assert!(refused.contains("not cleared"), "{refused}");
}
#[test]
fn codex_reset_asks_only_from_a_local_codex_session() {
    let mut f = unobserved("cxr-guard", &dialog_after(0)); // a Claude session
    assert_eq!(f.core.codex_reset_caller(&f.id), None);
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Codex;
    assert!(f.core.codex_reset_caller(&f.id).is_some());
    let caller = crate::grants::Caller {
        id: f.id.clone(),
        project: f.home.clone(),
    };
    let ask = Request::CodexResetUse {
        account: None,
        reason: "weekly is out".into(),
    };
    assert_eq!(f.core.check_agent(&caller, &ask), Ok(()));
    f.core.grants.remote.insert(caller.id.clone());
    assert_eq!(
        f.core.check_agent(&caller, &ask).unwrap_err(),
        "operation not granted"
    );
}
#[test]
fn agent_cannot_set_composer_on_send_text() {
    let mut f = unobserved("txt-agent", &dialog_after(0));
    f.core.tick().unwrap();
    let caller = crate::grants::Caller {
        id: "peer".into(),
        project: f.home.clone(),
    };
    f.core.grants.remote.insert(caller.id.clone());
    f.core
        .grants
        .parents
        .insert(f.id.clone(), caller.id.clone());
    // Even valid seen ids cannot turn a peer send into raw window input on a dialog.
    let request = text_request(&f, "1", true, &pending_ids(&f));
    assert_eq!(
        f.core.handle_agent(&caller, request).unwrap_err(),
        "agent_blocked"
    );
    assert_eq!(got(&f), b"");
}
#[test]
fn composer_enter_refused_when_dialog_queued_after_text() {
    // `seen` was taken before the text; the tick then queued a dialog the window never drew.
    let mut f = unobserved("cmp-tick", &dialog_after(0));
    f.core.tick().unwrap();
    let ids = pending_ids(&f);
    assert_eq!(ids.len(), 1, "the tick queued the dialog");
    let refused = composer_keys(&mut f, &["enter"], &[]).unwrap_err();
    assert!(refused.contains("not seen"), "{refused}");
    assert_eq!(got(&f), b"", "no Enter reached the agent");
    // Drawn by the window, it still takes no composer Enter (N13-S2-3: Enter picks the prompt's first option).
    let refused = composer_keys(&mut f, &["enter"], &ids).unwrap_err();
    assert!(refused.starts_with("agent_blocked"), "{refused}");
    assert_eq!(got(&f), b"", "no Enter reached the agent");
}
#[test]
fn composer_enter_sent_when_no_new_dialog() {
    let mut f = unobserved("cmp-plain", &b"line of output\r\n".repeat(8));
    composer_keys(&mut f, &["enter"], &[]).unwrap();
    assert_eq!(got(&f), b"\r");
}
#[test]
fn composer_enter_refused_while_observer_behind() {
    // A backlog the observe pass cannot finish hides a dialog at its end.
    let mut burst = "\x1b[H\u{276f} \r\n"
        .repeat(4 * 1024 * 1024 / 8)
        .into_bytes();
    burst.extend(dialog_after(0));
    let mut f = idle_then_backlog("cmp-lag", &burst);
    more(&f, burst.len());
    let refused = composer_keys(&mut f, &["enter"], &[]).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    assert_eq!(got(&f), b"", "no Enter reached the agent");
}
#[test]
fn composer_flag_only_widens_enter() {
    let mut f = unobserved("cmp-widen", &b"line of output\r\n".repeat(8));
    for keys in [
        &["esc"][..],
        &["enter", "enter"],
        &["down"],
        &["enter", "esc"],
    ] {
        let refused = composer_keys(&mut f, keys, &[]).unwrap_err();
        assert!(refused.contains("composer"), "{keys:?}: {refused}");
    }
    assert_eq!(got(&f), b"", "nothing reached the agent");
}
#[test]
fn cli_enter_unchanged() {
    let request: Request =
        serde_json::from_str(r#"{"op":"send_keys","id":"a","keys":["enter"]}"#).unwrap();
    assert!(matches!(
        request,
        Request::SendKeys {
            composer: false,
            ..
        }
    ));
    let mut f = unobserved("cli-enter", &dialog_after(0));
    f.core.tick().unwrap();
    assert_eq!(pending_ids(&f).len(), 1);
    stop_keys(&mut f, &["enter"], &[]).unwrap(); // the owner CLI answers a dialog on purpose
    assert_eq!(got(&f), b"\r");
}
fn pending_ids(f: &Flood) -> Vec<String> {
    f.core.queue.items().into_iter().map(|p| p.id).collect()
}
fn got(f: &Flood) -> Vec<u8> {
    std::thread::sleep(std::time::Duration::from_millis(300));
    fs::read(f.home.join("got")).unwrap_or_default()
}
#[test]
fn esc_not_sent_before_dialog_snapshot() {
    // The dialog is drawn on the terminal but no observer pass has read it: a Stop now would answer it.
    let mut f = unobserved("esc-gap", &dialog_after(0));
    assert!(offset(&f) == 0 && behind(&f));
    let refused = stop_key(&mut f, &[]).unwrap_err();
    assert!(refused.contains("not seen"), "{refused}");
    assert_eq!(got(&f), b"", "no Esc reached the agent");
    // The window has drawn it: the user's own Esc on a dialog they can see is the existing raw answer.
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
    let seen = pending_ids(&f);
    stop_key(&mut f, &seen).unwrap();
    assert_eq!(got(&f), b"\x1b");
}
#[test]
fn esc_refused_when_tick_queued_unseen_dialog() {
    // The 50 ms tick queues the dialog long before the window renders it; core's queue is not "seen".
    let mut f = unobserved("esc-tick", &dialog_after(0));
    f.core.tick().unwrap();
    let seen = pending_ids(&f);
    assert_eq!(seen.len(), 1, "the tick queued the dialog");
    let refused = stop_key(&mut f, &[]).unwrap_err();
    assert!(refused.contains("not seen"), "{refused}");
    assert_eq!(got(&f), b"", "no Esc reached the agent");
    stop_key(&mut f, &seen).unwrap(); // drawn by the window: the existing rule decides
    assert_eq!(got(&f), b"\x1b");
}
#[test]
fn esc_gate_matches_bytes_not_names() {
    let mut f = unobserved("esc-bytes", &dialog_after(0));
    f.core.tick().unwrap();
    for keys in [
        &["esc"][..],
        &["escape"],
        &["ESC"],
        &["esc", "esc"],
        &["esc", "enter"],
        &["down", "esc"],
    ] {
        let refused = stop_keys(&mut f, keys, &[]).unwrap_err();
        assert!(refused.contains("not seen"), "{keys:?}: {refused}");
    }
    assert_eq!(got(&f), b"", "nothing reached the agent");
    // An arrow only starts with the Esc byte; it is not a Stop.
    stop_keys(&mut f, &["down"], &[]).unwrap();
    assert_eq!(got(&f), b"\x1b[B");
}
#[test]
fn esc_gate_hook_permission_without_screen() {
    // The hook fired, the card is drawn in the window (seen), but the terminal has no dialog yet: an Esc now
    // would meet the dialog when it draws.
    let mut f = unobserved("esc-hook", &b"line of output\r\n".repeat(8));
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "PermissionRequest".into(),
            payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"ls"}}),
        })
        .unwrap();
    let seen = pending_ids(&f);
    assert_eq!(seen.len(), 1, "the hook queued a permission");
    let item = &f.core.queue.items()[0];
    assert!(item.kind == queue::Kind::Permission && item.screen_text.is_none());
    let refused = stop_key(&mut f, &seen).unwrap_err();
    assert!(refused.contains("not on the screen"), "{refused}");
    assert_eq!(got(&f), b"", "no Esc reached the agent");
}
#[test]
fn esc_refused_while_the_observer_is_behind() {
    // A backlog the observe pass cannot finish hides a dialog at its end: no Esc until the screen is current.
    let mut burst = "\x1b[H\u{276f} \r\n"
        .repeat(4 * 1024 * 1024 / 8)
        .into_bytes();
    burst.extend(dialog_after(0));
    let mut f = idle_then_backlog("esc-lag", &burst);
    more(&f, burst.len());
    let refused = stop_key(&mut f, &[]).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    assert_eq!(got(&f), b"", "no Esc reached the agent");
    catch_up(&mut f);
    let seen = pending_ids(&f);
    stop_key(&mut f, &seen).unwrap(); // the window has drawn it: the owner's own Esc
    assert_eq!(got(&f), b"\x1b");
}
#[test]
fn stop_still_stops_when_no_dialog() {
    let mut f = unobserved("esc-plain", &b"line of output\r\n".repeat(8));
    stop_key(&mut f, &[]).unwrap();
    assert_eq!(got(&f), b"\x1b");
    assert!(pending_text(&mut f).is_none());
}
// v25-sendkeys: the composer's Ctrl+Enter (core `steer_now`).
fn steer(f: &mut Flood, text: &str, seen: &[String]) -> Response {
    f.core.handle(Request::SteerNow {
        id: f.id.clone(),
        text: text.into(),
        seen: seen.to_vec(),
    })
}
fn hook(f: &mut Flood, event: &str) {
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: event.into(),
            payload: serde_json::json!({}),
        })
        .unwrap();
}
fn rows(f: &Flood) -> Vec<crate::delivery::Send> {
    let meta = &f.core.entries[&f.id].meta;
    meta.send_queue
        .iter()
        .chain(&meta.send_log)
        .cloned()
        .collect()
}
// Ticket 372: Resume at <time> arms one session; at the reset the session receives the fixed text once; Cancel
// disarms. Threat 1: arming twice, or after the reset passed, sends nothing extra.
#[test]
fn limit_resume_arms_fires_once_and_cancels() {
    let reset = claude_reset_ahead();
    let screen = format!(
        "\x1b[?2004l\x1b[2J\x1b[H You've hit your 5-hour limit \u{b7} resets {reset} (Asia/Seoul)\r\n\u{276f} \r\n"
    );
    let mut f = unobserved("limit-resume", screen.as_bytes());
    f.core.observe().unwrap();
    let limit = |f: &mut Flood| match f.core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions[0].limit.clone(),
        _ => panic!(),
    };
    let arm = |f: &mut Flood, on: bool| {
        f.core.handle(Request::LimitResume {
            id: f.id.clone(),
            on,
        })
    };
    let shown = limit(&mut f).expect("the row carries the limit");
    assert_eq!(
        (shown.resets.as_str(), shown.armed),
        (reset.as_str(), false)
    );
    arm(&mut f, true).unwrap();
    arm(&mut f, true).unwrap();
    assert!(limit(&mut f).unwrap().armed);
    f.core.fire_resumes(shown.until - 1);
    assert_eq!(got(&f), b"", "nothing before the reset");
    f.core.fire_resumes(shown.until);
    f.core.fire_resumes(shown.until + 1);
    let once = format!("{CONTINUE_TEXT}\r");
    assert_eq!(got(&f), once.as_bytes(), "the fixed text, once");
    assert!(!limit(&mut f).unwrap().armed, "fired, so no longer armed");
    // After the reset nothing arms again.
    assert!(
        f.core
            .limit_resume(&f.id.clone(), true, shown.until)
            .is_err()
    );
    // Cancel: armed, then cancelled, and the reset sends nothing.
    arm(&mut f, true).unwrap();
    arm(&mut f, false).unwrap();
    assert!(!limit(&mut f).unwrap().armed);
    f.core.fire_resumes(shown.until);
    assert_eq!(got(&f), once.as_bytes(), "nothing after a cancel");
}
// Ticket 372 round 2: the limit screen of session `f`, observed, and its row's limit.
fn limited(name: &str) -> (Flood, SessionLimit) {
    let reset = claude_reset_ahead();
    let screen = format!(
        "\x1b[?2004l\x1b[2J\x1b[H You've hit your 5-hour limit \u{b7} resets {reset} (Asia/Seoul)\r\n\u{276f} \r\n"
    );
    let mut f = unobserved(name, screen.as_bytes());
    f.core.observe().unwrap();
    let limit = f
        .core
        .session_limit(&f.id.clone(), true, queue::now_ms() as i64 / 1000)
        .unwrap();
    f.core
        .handle(Request::LimitResume {
            id: f.id.clone(),
            on: true,
        })
        .unwrap();
    (f, limit)
}
// Round 2 must-fix: another session observed in the reset's own tick drops this session's ended mark
// (`observe_limit`'s retain); the armed resume still sends, once.
#[test]
fn limit_resume_fires_when_another_session_is_observed_at_the_reset() {
    let (mut f, limit) = limited("limit-other");
    let home = f.core.home.clone();
    crate::usage::observe_limit(
        &home,
        "other",
        AgentKind::Claude,
        None,
        "",
        limit.until,
        &crate::usage::local_offset,
    );
    assert!(
        crate::usage::session_mark(&home, &f.id).is_none(),
        "the other session's pass dropped the ended mark"
    );
    f.core.fire_resumes(limit.until);
    f.core.fire_resumes(limit.until + 1);
    assert_eq!(got(&f), format!("{CONTINUE_TEXT}\r").as_bytes());
}
// A request waiting on the session at the reset: nothing is typed, and the resume is gone.
#[test]
fn limit_resume_pending_request_blocks_the_send() {
    let (mut f, limit) = limited("limit-pending");
    hook(&mut f, "PermissionRequest");
    assert!(!pending_ids(&f).is_empty());
    f.core.fire_resumes(limit.until);
    assert_eq!(got(&f), b"");
    assert!(f.core.limit_resumes.is_empty());
}
// The limit line leaves the screen before the reset (the person moved on): disarmed, and the reset sends nothing.
#[test]
fn limit_resume_line_leaving_before_the_reset_disarms() {
    let (mut f, limit) = limited("limit-left");
    let home = f.core.home.clone();
    let id = f.id.clone();
    crate::usage::observe_limit(
        &home,
        &id,
        AgentKind::Claude,
        None,
        "\u{276f} ",
        limit.until - 60,
        &crate::usage::local_offset,
    );
    f.core.fire_resumes(limit.until - 60);
    assert!(f.core.limit_resumes.is_empty());
    f.core.fire_resumes(limit.until);
    assert_eq!(got(&f), b"");
}
#[test]
fn steer_ctrl_enter_now() {
    // A prompt whose box does not grab a paste (the prompt, then paste mode off), so the agent receives each
    // send's bytes exactly as written.
    // Ticket 1056: Claude's whole input box (rules and footer), which the steer path looks for while a turn runs.
    let prompt = format!(
        "\x1b[?2004l\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n  \u{23f5}\u{23f5} auto mode on (shift+tab to cycle)\r\n"
    );
    let mut f = unobserved("steer-now", prompt.as_bytes());
    // Nothing is running: the text goes in at once, exactly as the composer's own Enter would.
    steer(&mut f, "first", &[]).unwrap();
    assert_eq!(got(&f), b"first\r");
    // Ticket 1056: a running Claude turn takes the text at its next step: no Esc, written by the tick while the
    // turn runs, once the input box shows.
    hook(&mut f, "UserPromptSubmit");
    let reply = steer(&mut f, "now", &[]).unwrap();
    let Reply::Delivery { send } = reply else {
        panic!("a delivery reply")
    };
    assert_eq!(send.content, "now");
    assert_eq!(send.status, "queued", "written by the tick");
    f.core.tick().unwrap();
    assert!(f.core.queue.attention(&f.id).working, "the turn still runs");
    assert_eq!(got(&f), b"first\rnow\r", "the text entered once, no Esc");
    hook(&mut f, "Stop");
    f.core.tick().unwrap();
    assert_eq!(
        rows(&f)
            .iter()
            .filter(|s| s.content == "now")
            .map(|s| s.status.as_str())
            .collect::<Vec<_>>(),
        vec!["delivered"]
    );
    // A message Enter already queued: Ctrl+Enter with an empty box breaks the turn and that message goes in once.
    hook(&mut f, "UserPromptSubmit");
    f.core
        .handle(Request::AgentPrompt {
            id: f.id.clone(),
            text: "queued".into(),
        })
        .unwrap();
    assert_eq!(got(&f), b"first\rnow\r", "Enter while working queues");
    steer(&mut f, "", &[]).unwrap();
    assert_eq!(got(&f), b"first\rnow\r\x1b", "the Esc only");
    hook(&mut f, "Stop");
    f.core.tick().unwrap();
    f.core.tick().unwrap();
    assert_eq!(got(&f), b"first\rnow\r\x1bqueued\r", "the queued text once");
    // Idle with nothing to break: an empty Ctrl+Enter writes nothing.
    assert_eq!(steer(&mut f, "", &[]).unwrap_err(), "nothing to send now");
}
/// Look 11-17 N0 (B1 again): Claude 2.1.326 ends an interrupted turn with no hook and maybe no record. After the
/// core's Esc its input box comes back with no "esc to interrupt" footer: the session is ready again at once.
/// Look 11-17 v11 N11-S2-2: also a named (resumed) session, whose name sits in the rule over the box, with the
/// stopped prompt put back in the box: it read as no box and stayed "Working" for minutes.
#[test]
fn n0_stop_ends_the_turn_once_claude_is_back_at_its_box() {
    let named = format!("{RULE} add-plan-txt-file \u{2500}");
    for (name, top, draft) in [
        ("n0-stop", RULE, ""),
        ("n11-stop-named", named.as_str(), "Write an essay"),
    ] {
        let screen = |footer: &str| {
            format!(
                "\x1b[?2004l\x1b[2J\x1b[H{top}\r\n\u{276f} {draft}\r\n{RULE}\r\n  \u{23f5}\u{23f5} auto mode on{footer}\r\n"
            )
        };
        let working = screen(" \u{b7} esc to interrupt");
        let mut f = flood_script(
            name,
            working.as_bytes(),
            "cat burst\nhead -c 1 >/dev/null\ncat idle\n",
        );
        fs::write(f.home.join("idle"), screen(" (shift+tab to cycle)")).unwrap();
        wait_end(&f, working.len());
        hook(&mut f, "UserPromptSubmit");
        f.core.tick().unwrap();
        assert!(
            f.core.queue.attention(&f.id).working,
            "the working footer is no end"
        );
        stop_key(&mut f, &[]).unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while f.core.queue.attention(&f.id).working {
            assert!(
                std::time::Instant::now() < until,
                "{name}: still working after Stop"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
            f.core.tick().unwrap();
        }
        // Without an interrupt the same idle box is no end: a turn that only shows its box keeps working.
        hook(&mut f, "UserPromptSubmit");
        for _ in 0..5 {
            f.core.tick().unwrap();
        }
        assert!(f.core.queue.attention(&f.id).working);
    }
}
/// aS2-1: the core writes nothing into a shell when a window attaches (a shell may sit at its own startup question,
/// where an Enter would answer it); the window's size is kept on disk, so a shell the CLI starts later, also after a
/// core restart, opens at it and builds its prompt at that width.
#[test]
fn as2_1_attach_writes_nothing_and_the_window_size_is_kept() {
    let mut f = unobserved("as2-1", b"$ ");
    let entry = f.core.entries.get_mut(&f.id).unwrap();
    entry.meta.kind = AgentKind::Shell;
    entry.args = Some(vec![]);
    f.core
        .handle(Request::Resize {
            id: f.id.clone(),
            cols: 120,
            rows: 40,
        })
        .unwrap();
    assert_eq!(got(&f), b"", "no key on attach");
    assert_eq!(saved_window_size(&f.home), Some((120, 40)));
    assert_eq!(saved_window_size(&f.home.join("nowhere")), None);
}
/// Look 11-17 v3 P2: Claude asks "Adding a new directory" for the session's own artifact folder only after the trust
/// question was answered, which can be minutes after the start. Drawn 5 minutes after the start, before any input
/// box, the core still starts its answer (Down to "Yes, add it"); the same question for another folder gets no key.
#[test]
fn p2_the_own_folder_question_is_answered_any_time_before_the_input_box() {
    for (name, own) in [("p2-own", true), ("p2-other", false)] {
        let mut f = flood_script(
            name,
            b"",
            "cat > got <&0 &\nwhile [ ! -f q ]; do sleep 0.05; done; cat q\n",
        );
        let id = f.id.clone();
        let folder = f.home.join("artifacts").join(&id);
        fs::create_dir_all(&folder).unwrap();
        let folder = fs::canonicalize(&folder).unwrap();
        let shown = if own {
            folder.display().to_string()
        } else {
            "/Users/me/Projects/other".into()
        };
        let entry = f.core.entries.get_mut(&id).unwrap();
        entry.observer.own_folder =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(300));
        fs::write(
                f.home.join("q"),
                format!(" Adding a new directory:\r\n {shown}\r\n\r\n This session hasn't worked here before. Is this a directory you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, add it\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n"),
            )
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !f.core.entries[&id]
            .observer
            .screen
            .text()
            .contains("Enter to confirm")
        {
            assert!(std::time::Instant::now() < until, "the question never drew");
            f.core.tick().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if own {
            assert_eq!(got(&f), b"\x1b[B", "Down to Yes, 5 minutes after the start");
        } else {
            assert_eq!(got(&f), b"", "another folder: no key");
        }
    }
}
/// Look 11-17 v3 P1 valve: `starting` always ends. A session at a trust question for 5 minutes stays starting; with
/// no question on its screen for `STARTUP_QUIET` it is not; the first hook of a turn ends it even with no box ever drawn.
#[test]
fn p1_starting_ends_at_a_hook_or_after_quiet_but_not_at_a_question() {
    let starting = |f: &Flood| {
        let meta = f.core.entries[&f.id].meta.clone();
        f.core.snapshot_session(&meta).starting
    };
    let trust = " Accessing workspace:\r\n\r\n /tmp/p\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n";
    let mut f = unobserved("p1-valve-q", trust.as_bytes());
    let five = std::time::Instant::now() - std::time::Duration::from_secs(300);
    let o = &mut f.core.entries.get_mut(&f.id).unwrap().observer;
    (o.before_box, o.quiet_since) = (true, Some(five));
    f.core.tick().unwrap();
    assert!(starting(&f), "a question on the screen keeps it starting");
    // No question and no box (a screen this build cannot read): quiet for 20 s ends it.
    let mut f = unobserved("p1-valve-quiet", b"something else\r\n");
    let o = &mut f.core.entries.get_mut(&f.id).unwrap().observer;
    (o.before_box, o.quiet_since) = (true, None);
    f.core.tick().unwrap();
    assert!(starting(&f), "quiet just began");
    f.core.entries.get_mut(&f.id).unwrap().observer.quiet_since =
        Some(std::time::Instant::now() - waiting::STARTUP_QUIET);
    assert!(!starting(&f), "20 s with no question");
    // The first hook of a turn ends it at once. Look 11-17 v8 N1: SessionStart does not: real Claude 2.1.327 fires
    // it before its input box is drawn, and the window's held first message went in at that moment.
    let o = &mut f.core.entries.get_mut(&f.id).unwrap().observer;
    (o.before_box, o.quiet_since) = (true, None);
    assert!(starting(&f));
    hook(&mut f, "SessionStart");
    assert!(starting(&f), "SessionStart comes before the input box");
    hook(&mut f, "UserPromptSubmit");
    assert!(!starting(&f), "the first hook of a turn");
}
/// Claude 2.1.326's folder-trust question about a project folder (not one the core answers), as Claude draws it.
const V5_TRUST: &str = "\x1b[2J\x1b[H\r\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n Accessing workspace:\r\n\r\n /tmp/harbor\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n Security guide\r\n\r\n \u{276f} No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n";
fn v5_switch() -> Switch {
    let now = std::time::Instant::now();
    Switch {
        send: String::new(),
        model: Some("haiku".into()),
        effort: None,
        confirming: false,
        keys: 0,
        sent: now,
        seen: 0,
        last: 0,
        quiet: now,
        before: String::new(),
    }
}
/// Look 11-17 v5 item 1, rule a: a start question while a model switch waits is a card; only the switch's own picker
/// is hidden.
#[test]
fn v5_a_start_question_is_a_card_while_a_switch_waits() {
    let mut f = unobserved("v5-switch-trust", V5_TRUST.as_bytes());
    f.core.entries.get_mut(&f.id).unwrap().switch = Some(v5_switch());
    f.core.observe().unwrap();
    let items = f.core.queue.items_of(&f.id);
    assert!(
        items.iter().any(|i| i.kind == queue::Kind::Dialog),
        "{items:?}"
    );
    // The picker the switch opened stays hidden.
    let picker = "\x1b[2J\x1b[HSelect model\r\n \u{276f} 1. Default (recommended)\r\n   2. Haiku\r\n\r\nEnter to set as default \u{b7} s to use this session only \u{b7} Esc to cancel\r\n";
    let mut f = unobserved("v5-switch-picker", picker.as_bytes());
    f.core.entries.get_mut(&f.id).unwrap().switch = Some(v5_switch());
    f.core.observe().unwrap();
    assert!(f.core.queue.items_of(&f.id).is_empty());
}
/// Look 11-17 v5 item 1, rule b: a question still on an unchanged screen whose card went is a card again within
/// seconds (the screen is fed only on new output, and a waiting dialog draws none).
#[test]
fn v5_b_a_question_on_a_still_screen_gets_its_card_back() {
    let mut f = unobserved("v5-reread", V5_TRUST.as_bytes());
    f.core.tick().unwrap();
    assert!(!f.core.queue.items_of(&f.id).is_empty(), "first card");
    f.core.queue.clear_screen(&f.id).unwrap(); // lost: an event or a half-drawn frame cleared it
    assert!(f.core.queue.items_of(&f.id).is_empty());
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while f.core.queue.items_of(&f.id).is_empty() {
        assert!(
            std::time::Instant::now() < until,
            "the card never came back"
        );
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
/// Look 11-17 v5 item 1, rule b: the composer's text and Enter are never typed into a start question on the screen,
/// even when the core holds no card for it (the window had nothing to hold the send for): the text is queued and
/// its Enter writes nothing.
#[test]
fn v5_b_a_composer_send_is_queued_behind_a_question_on_the_screen() {
    let mut f = unobserved("v5-send-gate", V5_TRUST.as_bytes());
    f.core.observe().unwrap();
    f.core.queue.clear_screen(&f.id).unwrap(); // no card, as in the look
    f.core
        .handle(Request::SendText {
            id: f.id.clone(),
            text: "\x1b[200~Say ready\x1b[201~".into(),
            seen: vec![],
            composer: true,
        })
        .unwrap();
    composer_keys(&mut f, &["enter"], &[]).unwrap();
    assert_eq!(got(&f), b"", "nothing typed into the question");
    let queued: Vec<_> = f.core.entries[&f.id]
        .meta
        .send_queue
        .iter()
        .map(|s| (s.content.clone(), s.status.clone()))
        .collect();
    assert_eq!(queued, [("Say ready".to_string(), "queued".to_string())]);
    // A text over the queue's size limit is refused, never stored (a stored one refuses the next core start).
    let big = f.core.handle(Request::SendText {
        id: f.id.clone(),
        text: "x".repeat(65537),
        seen: vec![],
        composer: true,
    });
    assert_eq!(big.unwrap_err(), "invalid send text");
    assert_eq!(f.core.entries[&f.id].meta.send_queue.len(), 1);
}
/// Look 11-17 v11 N11-S2-1: a composer send while a question card waits (Claude's AskUserQuestion), drawn by the
/// window, is held as behind a start question: nothing goes into the question's "Type something" row.
#[test]
fn n11_a_composer_send_is_held_behind_a_question_card() {
    let rule = "\u{2500}".repeat(60);
    let question = format!(
        "\x1b[2J\x1b[H{rule}\r\n \u{2610} Fruit\r\nWhich fruit do you want?\r\n\u{276f} 1. Apple\r\n  2. Pear\r\n  3. Type something.\r\n{rule}\r\n  4. Chat about this\r\nEnter to select \u{b7} \u{2191}/\u{2193} to navigate \u{b7} Esc to cancel\r\n"
    );
    let mut f = unobserved("n11-question-hold", question.as_bytes());
    w14_tick_until(&mut f, 10, "no question card", |f| {
        f.core
            .queue
            .items_of(&f.id)
            .iter()
            .any(|i| i.kind == queue::Kind::Question)
    });
    let seen = pending_ids(&f);
    let request = text_request(&f, "\x1b[200~Also a number\x1b[201~", true, &seen);
    f.core.handle(request).unwrap();
    composer_keys(&mut f, &["enter"], &seen).unwrap();
    assert_eq!(got(&f), b"", "nothing typed into the question");
    let queued: Vec<_> = f.core.entries[&f.id]
        .meta
        .send_queue
        .iter()
        .map(|s| (s.content.as_str(), s.status.as_str()))
        .collect();
    assert_eq!(queued, [("Also a number", "queued")]);
}
/// Look 1117 v13 N13-S2-3 (2 of 2): a composer message sent while Claude's Write card waited (its hook held) was
/// typed into the permission prompt and rejected the Write. It is held as behind a question card: nothing is typed
/// and the card stays for the owner's answer.
#[test]
fn n13_a_composer_send_is_held_behind_a_permission_card() {
    let mut f = unobserved("n13-perm-hold", PROMPT.as_bytes());
    f.core
            .handle(Request::Hook {
                id: f.id.clone(),
                event: "PermissionRequest".into(),
                payload: serde_json::json!({"tool_name":"Write","tool_input":{"file_path":"perm.txt","content":"hi"}}),
            })
            .unwrap();
    f.core.tick().unwrap();
    let seen = pending_ids(&f);
    assert_eq!(
        f.core.queue.items_of(&f.id)[0].kind,
        queue::Kind::Permission
    );
    let request = text_request(&f, "\x1b[200~Also say mango\x1b[201~", true, &seen);
    f.core.handle(request).unwrap();
    composer_keys(&mut f, &["enter"], &seen).unwrap();
    assert_eq!(got(&f), b"", "nothing typed into the permission prompt");
    assert_eq!(pending_ids(&f), seen, "only the card answers it");
    let queued: Vec<_> = f.core.entries[&f.id]
        .meta
        .send_queue
        .iter()
        .map(|s| (s.content.as_str(), s.status.as_str()))
        .collect();
    assert_eq!(queued, [("Also say mango", "queued")]);
}
/// Ticks until `done`, or fails after `secs`.
fn w14_tick_until(f: &mut Flood, secs: u64, why: &str, done: impl Fn(&Flood) -> bool) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while !done(f) {
        assert!(std::time::Instant::now() < until, "{why}");
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
/// Seventh look (B S2-1): a permission prompt on a still screen in the middle of a turn whose card an event took
/// (there: the transcript's result of the call before) is a card again within seconds. The re-read skipped every
/// working session, so the lead waited at its prompt unseen for minutes.
#[test]
fn w14_a_prompt_on_a_still_screen_gets_its_card_back_mid_turn() {
    let mut f = unobserved("w14-mid-turn", &dialog_after(0));
    f.core.tick().unwrap();
    assert!(!f.core.queue.items_of(&f.id).is_empty(), "first card");
    let id = f.id.clone();
    // A turn runs, and an event of it clears the card while the prompt stands.
    f.core
        .queue
        .observe(
            &id,
            "UserPromptSubmit",
            &serde_json::json!({"prompt_id": "t1"}),
            "hook",
            queue::now_ms(),
        )
        .unwrap();
    assert!(f.core.queue.attention(&id).working && f.core.queue.items_of(&id).is_empty());
    w14_tick_until(&mut f, 10, "the card never came back mid-turn", |f| {
        !f.core.queue.items_of(&f.id).is_empty()
    });
    // A working session whose screen shows no question gets none, and is still working.
    let mut f = unobserved("w14-mid-turn-none", b"\x1b[2J\x1b[HThinking\r\n");
    let id = f.id.clone();
    f.core
        .queue
        .observe(
            &id,
            "UserPromptSubmit",
            &serde_json::json!({"prompt_id": "t1"}),
            "hook",
            queue::now_ms(),
        )
        .unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_millis(2500);
    while std::time::Instant::now() < until {
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(f.core.queue.items_of(&id).is_empty() && f.core.queue.attention(&id).working);
}
/// Look 11-17 v5 item 1, rule c: a goal (a prompt as the user) sent to a lead stuck at a start question waits in its
/// queue, is not typed into the question, and goes once the input box is back.
#[test]
fn v5_c_a_goal_waits_behind_a_question_and_goes_after_it() {
    // Ticket 1142: the question is the fixture's `burst`, written before the session starts; written after it, a
    // loaded host ran `cat q` first and the question was never drawn ("no card"). `p` is read only after `go`.
    let mut f = flood_script(
        "v5-goal",
        V5_TRUST.as_bytes(),
        "cat > got <&0 &\ncat burst\nwhile [ ! -f go ]; do sleep 0.05; done; cat p\n",
    );
    fs::write(f.home.join("p"), PROMPT).unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while f.core.queue.items_of(&f.id).is_empty() {
        assert!(std::time::Instant::now() < until, "no card");
        f.core.tick().unwrap();
    }
    f.core
        .prompt_as_user(&f.id, "Ship the goal".into())
        .unwrap();
    for _ in 0..10 {
        f.core.tick().unwrap();
    }
    assert_eq!(got(&f), b"", "nothing typed into the question");
    fs::write(f.home.join("go"), "").unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !String::from_utf8_lossy(&got(&f)).contains("Ship the goal") {
        assert!(std::time::Instant::now() < until, "the goal never went");
        f.core.tick().unwrap();
    }
}
/// Seventh look (B S1-1): the terminal is resized and the agent draws nothing after it (the fake draws its question
/// once and never again, as an agent that saw no change of size). The question is still on the terminal. The few
/// bytes an agent prints for a focus report were then read on the blanked screen: the card went, the session read
/// idle, the re-read never found the question again and a composer message was typed into it.
#[test]
fn w14_a_question_survives_a_resize_the_agent_did_not_draw_after() {
    let mut f = flood_script(
        "w14-undrawn",
        V5_TRUST.as_bytes(),
        "cat > got <&0 &\ncat burst\nwhile [ ! -f go ]; do sleep 0.05; done; printf '\\033(B\\017\\033[?2004h'\n",
    );
    wait_end(&f, V5_TRUST.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude;
    f.core.tick().unwrap();
    assert!(!f.core.queue.items_of(&f.id).is_empty(), "first card");
    let resize = |f: &mut Flood, cols| {
        f.core
            .handle(Request::Resize {
                id: f.id.clone(),
                cols,
                rows: 40,
            })
            .unwrap();
    };
    // Two sizes at once, as two views of one session refit: the model is blank, the terminal is not.
    resize(&mut f, 100);
    resize(&mut f, 101);
    fs::write(f.home.join("go"), "").unwrap(); // the agent's answer to the terminal's focus report
    wait_end(&f, V5_TRUST.len() + 12);
    // Past the redraw's time the question has its card, and it stays.
    let until =
        std::time::Instant::now() + std::time::Duration::from_millis(queue::RESIZE_GRACE_MS + 1500);
    while std::time::Instant::now() < until {
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let items = f.core.queue.items_of(&f.id);
    assert!(
        matches!(&items[..], [i] if i.kind == queue::Kind::Dialog && i.text.contains("Yes, I trust this folder")),
        "the question on the terminal has no card: {items:?}"
    );
    // A composer message is held behind it, not typed into it.
    f.core
        .handle(Request::SendText {
            id: f.id.clone(),
            text: "\x1b[200~Say ready\x1b[201~".into(),
            seen: pending_ids(&f),
            composer: true,
        })
        .unwrap();
    let seen = pending_ids(&f);
    composer_keys(&mut f, &["enter"], &seen).unwrap();
    assert_eq!(got(&f), b"", "nothing typed into the question");
    let queued: Vec<_> = f.core.entries[&f.id]
        .meta
        .send_queue
        .iter()
        .map(|s| (s.content.clone(), s.status.clone()))
        .collect();
    assert_eq!(queued, [("Say ready".to_string(), "queued".to_string())]);
    // An agent that does draw after the resize is read from what it drew: nothing of the old screen comes back.
    let mut f = flood_script(
        "w14-redrawn",
        V5_TRUST.as_bytes(),
        "cat > got <&0 &\ncat burst\nwhile [ ! -f go ]; do sleep 0.05; done; printf '\\033[2J\\033[HWelcome back\\r\\n'\n",
    );
    wait_end(&f, V5_TRUST.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude;
    f.core.tick().unwrap();
    resize(&mut f, 100);
    fs::write(f.home.join("go"), "").unwrap();
    let until =
        std::time::Instant::now() + std::time::Duration::from_millis(queue::RESIZE_GRACE_MS + 1500);
    while std::time::Instant::now() < until {
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        f.core.queue.items_of(&f.id).is_empty(),
        "the answered question came back"
    );
    assert_eq!(
        f.core.entries[&f.id].observer.screen.text().trim(),
        "Welcome back"
    );
}
/// Lane w96 (queue.spec.ts answer_waits_on_settled_card): an agent's redraw after a resize is a clear and then its text,
/// in two writes. Read between them, the blank screen dropped the card, and the text filed it again under a new id: the
/// window lost the focus the user had put on it. A cleared screen holds the card through the redraw's time; one the
/// agent leaves blank past that time is read again, and the card goes.
const W96_PERMISSION: &str =
    "Bash command\r\n\r\n  touch out-a\r\n\r\nDo you want to proceed?\r\n> 1. Yes\r\n  2. No\r\n";
#[test]
fn w96_a_redraw_read_between_its_clear_and_its_text_keeps_the_card() {
    let mut f = flood_script(
        "w96-half-redraw",
        W96_PERMISSION.as_bytes(),
        "cat > got <&0 &\ncat burst\nfor n in 1 2; do\n\
         while [ ! -f go$n ]; do sleep 0.05; done; printf '\\033[2J\\033[H'\n\
         while [ ! -f text$n ]; do sleep 0.05; done; cat burst\ndone\n",
    );
    wait_end(&f, W96_PERMISSION.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude;
    f.core.tick().unwrap();
    assert!(!f.core.queue.items_of(&f.id).is_empty(), "first card");
    let resize = |f: &mut Flood, cols| {
        f.core
            .handle(Request::Resize {
                id: f.id.clone(),
                cols,
                rows: 40,
            })
            .unwrap();
    };
    // The first refit uses the prompt's one queue grace (v1a-77); the second has none, as the spec's viewport change.
    for (n, cols) in [(1, 100), (2, 101)] {
        resize(&mut f, cols);
        // The resize alone blanks the model, so the clear is waited for by its bytes: written, then read.
        let end = |f: &Flood| f.core.entries[&f.id].pty.as_ref().unwrap().end();
        let before = end(&f);
        fs::write(f.home.join(format!("go{n}")), "").unwrap(); // the clear, alone
        let until = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while end(&f) == before {
            assert!(
                std::time::Instant::now() < until,
                "refit {n}: the clear never came"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let mut after = 0;
        while after < 5 {
            assert!(
                std::time::Instant::now() < until,
                "refit {n}: the clear was never read"
            );
            f.core.tick().unwrap();
            assert!(
                !f.core.queue.items_of(&f.id).is_empty(),
                "refit {n}: the card went between the clear and the text"
            );
            after += usize::from(f.core.entries[&f.id].observer.output_offset >= end(&f));
        }
        let blank = |f: &Flood| {
            f.core.entries[&f.id]
                .observer
                .screen
                .text()
                .trim()
                .is_empty()
        };
        fs::write(f.home.join(format!("text{n}")), "").unwrap();
        while blank(&f) {
            assert!(
                std::time::Instant::now() < until,
                "refit {n}: the text never came"
            );
            f.core.tick().unwrap();
        }
        assert!(
            !f.core.queue.items_of(&f.id).is_empty(),
            "refit {n}: the redrawn card"
        );
    }
    // A redraw that clears and draws nothing more: past the redraw's time its card goes.
    let mut f = flood_script(
        "w96-blank-redraw",
        W96_PERMISSION.as_bytes(),
        "cat > got <&0 &\ncat burst\nwhile [ ! -f go ]; do sleep 0.05; done; printf '\\033[2J\\033[H'\n",
    );
    wait_end(&f, W96_PERMISSION.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude;
    f.core.tick().unwrap();
    resize(&mut f, 100);
    fs::write(f.home.join("go"), "").unwrap();
    wait_end(&f, W96_PERMISSION.len() + 7);
    let until =
        std::time::Instant::now() + std::time::Duration::from_millis(queue::RESIZE_GRACE_MS + 1500);
    while std::time::Instant::now() < until {
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        f.core.queue.items_of(&f.id).is_empty(),
        "a blank redraw kept the card"
    );
}
/// V2-1b (queue.spec.ts "restored ... checking"): after a core restart the window's first fit resizes a PTY whose size
/// the agent already had, so it draws nothing. The old screen `restore_undrawn` gives back is no fresh output: it must
/// not prove the restored item again (a new id, answerable) while the agent has drawn nothing since the reattach.
#[test]
fn v21b_an_undrawn_resize_never_proves_a_restored_item() {
    let mut f = flood_script(
        "v21b-undrawn",
        V5_TRUST.as_bytes(),
        "cat > got <&0 &\ncat burst\n",
    );
    wait_end(&f, V5_TRUST.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude;
    f.core.tick().unwrap();
    let before = f.core.queue.items_of(&f.id);
    assert_eq!(before.len(), 1, "first card");
    f.core.queue.checking(&f.id).unwrap(); // as `Sessions::open` marks a reattached session's items
    f.core
        .handle(Request::Resize {
            id: f.id.clone(),
            cols: 100,
            rows: 40,
        })
        .unwrap();
    let until =
        std::time::Instant::now() + std::time::Duration::from_millis(queue::RESIZE_GRACE_MS + 1500);
    while std::time::Instant::now() < until {
        f.core.tick().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let items = f.core.queue.items_of(&f.id);
    assert!(
        matches!(&items[..], [i] if i.id == before[0].id && i.reconciled && !i.actionable),
        "the restored item was proved again by the old screen: {items:?}"
    );
}
/// Look 11-17 v5 item 10: the user's folder-trust question may wait for minutes; the artifact folder's question after
/// it is still answered by the core (its give-up clock starts with that question, not with the trust question).
#[test]
fn v5_10_a_late_trust_answer_keeps_the_core_answering_the_artifact_question() {
    // The trust question is the script's `burst` file, written before the session starts: a file written after the
    // start could come after the script's one read of it, and then no card ever came.
    let mut f = flood_script(
        "v5-late-trust",
        V5_TRUST.as_bytes(),
        "cat > got <&0 &\ncat burst\nwhile [ ! -f go ]; do sleep 0.05; done; cat p\n",
    );
    let id = f.id.clone();
    let folder = f.home.join("artifacts").join(&id);
    fs::create_dir_all(&folder).unwrap();
    let folder = fs::canonicalize(&folder).unwrap();
    f.core.entries.get_mut(&id).unwrap().observer.own_folder = Some(std::time::Instant::now());
    fs::write(
            f.home.join("p"),
            format!("\x1b[2J\x1b[H Adding a new directory:\r\n {}\r\n\r\n This session hasn't worked here before. Is this a directory you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, add it\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n", folder.display()),
        )
        .unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while f.core.queue.items_of(&id).is_empty() {
        assert!(std::time::Instant::now() < until, "no trust card");
        f.core.tick().unwrap();
    }
    // Five minutes at the user's trust question.
    let five = std::time::Instant::now() - std::time::Duration::from_secs(300);
    let o = &mut f.core.entries.get_mut(&id).unwrap().observer;
    if o.own_folder_since.is_some() {
        o.own_folder_since = Some(five);
    }
    fs::write(f.home.join("go"), "").unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while got(&f).is_empty() {
        assert!(
            std::time::Instant::now() < until,
            "the core never pressed a key"
        );
        f.core.tick().unwrap();
    }
    assert_eq!(got(&f), b"\x1b[B", "the core moves to Yes itself");
    assert!(
        f.core.queue.items_of(&id).is_empty(),
        "no card about the core's own folder"
    );
}
/// Look 11-17 v5 item 3: a request waiting when the core stops is said to the place's lead in one room line; with no
/// lead nothing is written. Either way the ended row's snapshot names it (look 1117 v10 N10-S3-3).
#[test]
fn v5_3_a_request_ended_by_a_restart_is_said_to_the_lead() {
    for with_lead in [true, false] {
        let mut f = unobserved(&format!("v5-ask-ends-{with_lead}"), &dialog_after(0));
        f.core.entries.get_mut(&f.id).unwrap().meta.label = "Boatwright".into();
        let project = f.core.entries[&f.id].meta.project.clone();
        if with_lead {
            crate::team::Team::open(&f.home)
                .save(
                    None,
                    crate::team::Teammate {
                        id: String::new(),
                        name: "Lead".into(),
                        job: "Leads.".into(),
                        kind: AgentKind::Claude,
                        model: None,
                        effort: None,
                        project: Some(project.clone()),
                        lead: true,
                        level: None,
                        level_max: None,
                        next_level: None,
                        agent: None,
                    },
                )
                .unwrap();
        }
        f.core.observe().unwrap();
        assert!(!f.core.queue.items_of(&f.id).is_empty(), "the card");
        f.core.stop().unwrap();
        // Look 1117 v10 N10-S3-3: with a lead or not, the ended row's snapshot names the ask that ended with it.
        assert_eq!(
            f.core
                .snapshot_session(&f.core.entries[&f.id].meta)
                .ended_ask
                .as_deref(),
            Some("Do you want to proceed? 1. Yes 2. No")
        );
        let said: Vec<String> = crate::room::Log::open(&f.home, &project)
            .find(|m| m.body.contains("request ended when the core restarted"))
            .unwrap()
            .into_iter()
            .map(|m| m.body)
            .collect();
        if with_lead {
            assert_eq!(
                said,
                [
                    "Boatwright's request ended when the core restarted: Do you want to proceed? 1. Yes 2. No"
                ]
            );
        } else {
            assert!(said.is_empty(), "{said:?}");
        }
    }
}
/// w10 item 12: a start question the core answers but Claude does not take (the key lost, the screen not moving) is
/// pressed again with no new output, and after `OWN_GIVE_UP` it is a card, never an idle row with nothing to press.
#[test]
fn w10_own_question_retries_then_becomes_a_card() {
    let mut f = flood_script(
        "w10-own-giveup",
        b"",
        "cat > got <&0 &\nwhile [ ! -f q ]; do sleep 0.05; done; cat q\n",
    );
    let id = f.id.clone();
    let folder = f.home.join("artifacts").join(&id);
    fs::create_dir_all(&folder).unwrap();
    let folder = fs::canonicalize(&folder).unwrap();
    f.core.entries.get_mut(&id).unwrap().observer.own_folder = Some(std::time::Instant::now());
    fs::write(
            f.home.join("q"),
            format!(" Adding a new directory:\r\n {}\r\n\r\n This session hasn't worked here before. Is this a directory you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, add it\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n", folder.display()),
        )
        .unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while got(&f).is_empty() {
        assert!(std::time::Instant::now() < until, "no first key");
        f.core.tick().unwrap();
    }
    // Claude did not move: with no new output the Down is pressed again.
    std::thread::sleep(std::time::Duration::from_millis(1200));
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while got(&f) != b"\x1b[B\x1b[B" {
        assert!(std::time::Instant::now() < until, "{:?}", got(&f));
        f.core.tick().unwrap();
    }
    assert!(
        f.core.queue.items_of(&id).is_empty(),
        "no card while the core answers"
    );
    // Past the give-up time it is the user's: a card, and no more keys.
    f.core
        .entries
        .get_mut(&id)
        .unwrap()
        .observer
        .own_folder_since =
        Some(std::time::Instant::now() - waiting::OWN_GIVE_UP - std::time::Duration::from_secs(1));
    f.core.entries.get_mut(&id).unwrap().observer.recheck = true;
    f.core.tick().unwrap();
    assert!(
        !f.core.queue.items_of(&id).is_empty(),
        "the question is a card"
    );
    let keys = got(&f);
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    assert_eq!(got(&f), keys, "no key after the give-up");
}
/// w25-m: the session's own folder question cut off by a short window (Claude takes only "No" there) is a card at
/// once, with no key: never answered from a cut-off screen, never hidden while the start window runs.
#[test]
fn w25m_cut_off_own_question_is_a_card_at_once() {
    let mut f = flood_script(
        "w25m-cut-off",
        b"",
        "cat > got <&0 &\nwhile [ ! -f q ]; do sleep 0.05; done; cat q\n",
    );
    let id = f.id.clone();
    let folder = f.home.join("artifacts").join(&id);
    fs::create_dir_all(&folder).unwrap();
    let folder = fs::canonicalize(&folder).unwrap();
    f.core.entries.get_mut(&id).unwrap().observer.own_folder = Some(std::time::Instant::now());
    let screen = format!(
        " Adding a new directory:\r\n {}\r\n \u{2193} No, exit\r\n Esc to exit \u{b7} To add it, first make the window taller\r\n",
        folder.display()
    );
    fs::write(f.home.join("q"), &screen).unwrap();
    let until = std::time::Instant::now() + waiting::OWN_GIVE_UP / 2;
    while f.core.queue.items_of(&id).is_empty() {
        assert!(std::time::Instant::now() < until, "no card");
        f.core.tick().unwrap();
    }
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    assert!(got(&f).is_empty(), "{:?}", got(&f));
}
/// Look 1117 v17 B (w25-s): the window shrank while Claude's folder-trust question waited. The narrow side pane
/// wrapped the question past the terminal's rows and its heading scrolled off; the card went, the pane that the card
/// opened closed, and the PTY stayed narrow, so a taller window never brought the card back. The card stays through
/// the narrow redraw and through a screen it cannot read during the start, and goes only when Claude's input box
/// shows.
#[test]
fn w25s_a_start_question_keeps_its_card_through_a_narrow_window() {
    let narrow = "\x1b[2J\x1b[H trust? (Like your own code, a\r\n well-known open source project,\r\n or work from your team). If\r\n not, take a moment to review\r\n what's in this folder first.\r\n\r\n Claude Code'll be able to read,\r\n edit, and execute files here.\r\n\r\n Security guide\r\n\r\n \u{276f} No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm \u{b7}\r\n Esc to cancel";
    // Rows split narrower than the option labels: "No, exit" is there, read across rows only.
    let unreadable = "\x1b[2J\x1b[H \u{276f} No,\r\n exit\r\n Yes, I\r\n trust this\r\n folder\r\n Esc to cancel";
    let input_box =
        format!("\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} \r\n{RULE}{RULE}{RULE}\r\n");
    let mut f = flood_script(
        "w25s-narrow",
        V5_TRUST.as_bytes(),
        "cat > got <&0 &\ncat burst\nfor n in 1 2 3 4; do while [ ! -f go$n ]; do sleep 0.05; done; cat s$n; done\n",
    );
    for (n, screen) in [narrow, V5_TRUST, unreadable, &input_box]
        .iter()
        .enumerate()
    {
        fs::write(f.home.join(format!("s{}", n + 1)), screen).unwrap();
    }
    let id = f.id.clone();
    {
        let o = &mut f.core.entries.get_mut(&id).unwrap().observer;
        (o.own_folder, o.before_box) = (Some(std::time::Instant::now()), true);
    }
    let card = |f: &Flood| {
        f.core
            .queue
            .items_of(&f.id)
            .iter()
            .any(|i| i.kind == queue::Kind::Dialog)
    };
    wait_end(&f, V5_TRUST.len());
    f.core.tick().unwrap();
    assert!(card(&f), "first card");
    let mut sent = V5_TRUST.len();
    let mut step = |f: &mut Flood, n: usize, size: Option<(u16, u16)>, bytes: usize| {
        if let Some((cols, rows)) = size {
            f.core
                .handle(Request::Resize {
                    id: f.id.clone(),
                    cols,
                    rows,
                })
                .unwrap();
        }
        fs::write(f.home.join(format!("go{n}")), "").unwrap();
        sent += bytes;
        wait_end(f, sent);
        let until = std::time::Instant::now()
            + std::time::Duration::from_millis(queue::RESIZE_GRACE_MS + 500);
        while std::time::Instant::now() < until {
            f.core.tick().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    };
    step(&mut f, 1, Some((32, 16)), narrow.len());
    assert!(card(&f), "the card went at the narrow window");
    step(&mut f, 2, Some((100, 40)), V5_TRUST.len());
    let items = f.core.queue.items_of(&id);
    assert!(
        matches!(&items[..], [i] if i.text.contains("Quick safety check")),
        "{items:?}"
    );
    step(&mut f, 3, None, unreadable.len());
    assert!(card(&f), "the card went on a screen the core cannot read");
    step(&mut f, 4, None, input_box.len());
    assert!(!card(&f), "the card stayed after Claude's input box showed");
    assert!(got(&f).is_empty(), "{:?}", got(&f));
}
/// Look 11-17 v3 P3: an early Stop puts the stopped prompt back into Claude's box; the next send clears it first
/// (two Ctrl+U per row and one more), then types only the new message. Without an interrupt nothing is cleared.
#[test]
fn p3_the_send_after_an_interrupt_clears_the_restored_prompt_first() {
    let screen = format!(
        "\x1b[?2004l\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} Write an essay\r\n  about rivers\r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
    );
    let mut f = unobserved("p3-clear", screen.as_bytes());
    f.core.tick().unwrap();
    assert_eq!(box_rows(&f.core.entries[&f.id].observer.screen.text()), 2);
    let send = |f: &mut Flood| {
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: "pong".into(),
                seen: vec![],
                composer: true,
            })
            .unwrap();
    };
    f.core.entries.get_mut(&f.id).unwrap().observer.clear_box = true;
    send(&mut f);
    assert_eq!(got(&f), b"\x15\x15\x15\x15\x15pong");
    // The agent took it and drew its box empty (gap rule: nothing is typed behind words in the box).
    let empty = format!(
        "\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} \r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
    );
    let id = f.id.clone();
    f.core
        .entries
        .get_mut(&id)
        .unwrap()
        .observer
        .screen
        .feed(empty.as_bytes());
    send(&mut f);
    assert_eq!(
        got(&f),
        b"\x15\x15\x15\x15\x15pongpong",
        "once per interrupt"
    );
}
/// Look 11-17 v4 Home N4: a goal's prompt tells the project lead to ask the user with its question tool (a card).
#[test]
fn n4_a_goal_prompt_says_to_ask_with_the_question_tool() {
    assert!(GOAL_NEXT.contains("question tool") && GOAL_NEXT.contains("card"));
    assert!(GOAL_NEXT.contains("nunchiro task new"));
    assert!(GOAL_NEXT.starts_with("This goal is also posted as a message")); // N10: never "the line"
}
/// Look 11-17 v4 B S1-1: the sub-agent source never walks the agent's sessions folder under the registry lock; with
/// no transcript observed yet it hands back no path, and the caller locates it after the lock is released.
#[test]
fn b_s1_1_kids_source_takes_no_walk_under_the_lock() {
    let mut f = unobserved("kids-lock", b"$ ");
    let id = f.id.clone();
    let entry = f.core.entries.get_mut(&id).unwrap();
    entry.meta.kind = AgentKind::Codex;
    entry.meta.agent_session_id = Some("0123456789abcdef".into());
    entry.observer.transcript = None;
    let (_, fold) = f.core.kids_source(&id).unwrap();
    let (meta, path) = fold.unwrap();
    assert_eq!(meta.id, id);
    assert_eq!(path, None, "no locate under the lock");
}
/// Look 11-17 w10 item 1: a question's "Type something" answer writes its digit only; the words go once the screen
/// shows the text field (`❯ 3. …`), Enter once the field shows them. Before, the words followed a fixed 250 ms
/// after the digit, into the option list when Claude opened the field later.
#[test]
fn w10_typed_answer_waits_for_the_text_field() {
    let rule = "\u{2500}".repeat(60);
    let q = |cursor: usize, third: &str| {
        let mark = |n: usize| if n == cursor { "\u{276f}" } else { " " };
        format!(
            "\x1b[2J\x1b[H{rule}\r\n \u{2610} Fruit\r\nWhich fruit do you want?\r\n{} 1. Apple\r\n{} 2. Pear\r\n{} 3. {third}\r\n{rule}\r\n  4. Chat about this\r\nEnter to select \u{b7} \u{2191}/\u{2193} to navigate \u{b7} Esc to cancel\r\n",
            mark(1),
            mark(2),
            mark(3)
        )
    };
    let mut f = flood_script(
        "w10-typed",
        q(1, "Type something.").as_bytes(),
        "cat > got <&0 &\ncat burst\nwhile [ ! -f field ]; do sleep 0.05; done; cat field\nwhile [ ! -f words ]; do sleep 0.05; done; cat words\n",
    );
    let home = f.home.clone();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let item = loop {
        f.core.tick().unwrap();
        if let Some(i) = f
            .core
            .queue
            .items_of(&f.id)
            .into_iter()
            .find(|i| i.kind == queue::Kind::Question)
        {
            break i;
        }
        assert!(std::time::Instant::now() < until, "no question card");
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    f.core
        .answer(
            &item.id,
            queue::Answer::ChooseWith {
                index: 2,
                text: "kiwi".into(),
            },
            true,
        )
        .unwrap();
    for _ in 0..10 {
        f.core.tick().unwrap();
    }
    assert_eq!(got(&f), b"3", "no words while the field is not open");
    fs::write(home.join("field"), q(3, "Type something.")).unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while got(&f) != b"3kiwi" {
        assert!(
            std::time::Instant::now() < until,
            "{:?}",
            String::from_utf8_lossy(&got(&f))
        );
        f.core.tick().unwrap();
    }
    fs::write(home.join("words"), q(3, "kiwi")).unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while got(&f) != b"3kiwi\r" {
        assert!(
            std::time::Instant::now() < until,
            "{:?}",
            String::from_utf8_lossy(&got(&f))
        );
        f.core.tick().unwrap();
    }
}
/// w10 item 2: the quiet time that ends a start counts from the first output. A Claude that has drawn nothing 30 s
/// after its start (many seats starting under load) is still starting; one silent for `STARTUP_SILENT` is not.
#[test]
fn w10_start_quiet_counts_from_the_first_output() {
    let mut f = flood_script("w10-silent", b"", "cat > got <&0 &\n");
    let starting = |f: &Flood| {
        let meta = f.core.entries[&f.id].meta.clone();
        f.core.snapshot_session(&meta).starting
    };
    let o = &mut f.core.entries.get_mut(&f.id).unwrap().observer;
    (o.before_box, o.quiet_since) = (true, None);
    o.silent_since = Some(std::time::Instant::now() - std::time::Duration::from_secs(30));
    f.core.tick().unwrap();
    assert!(starting(&f), "nothing drawn yet: still starting after 30 s");
    f.core.entries.get_mut(&f.id).unwrap().observer.silent_since =
        Some(std::time::Instant::now() - waiting::STARTUP_SILENT);
    assert!(!starting(&f), "silent for the whole limit");
}
/// Look 11-17 v4f N-B: the Home digest counts only asks that exist now: an ended session's left-over item (after a
/// core restart its request is gone) is no "needs you".
#[test]
fn n_b_digest_counts_only_live_asks() {
    let mut f = unobserved("n-b-digest", b"$ ");
    let id = f.id.clone();
    f.core
        .queue
        .acp_ask(&id, queue::Kind::Permission, "write NOTE.txt".into())
        .unwrap();
    let project = f.core.entries[&id].meta.project.clone();
    assert_eq!(
        f.core.digest_facts().1[&project].pending.len(),
        1,
        "live: counted"
    );
    f.core.entries.get_mut(&id).unwrap().meta.state = SessionState::Resumable;
    assert!(
        f.core
            .digest_facts()
            .1
            .get(&project)
            .is_none_or(|p| p.pending.is_empty()),
        "ended: its old ask is not counted"
    );
}
/// w10 item 13: a plain shell started before any window ever gave a size (a new home) waits for the window's size
/// before it starts, so its first prompt is built at the window's width; nothing is typed into it.
/// V2.5-47: the shell's HOME is the test's own folder, so the machine's own start files (a heavy .zshrc on a
/// loaded gate can draw the first prompt past the 20 s below) are not part of the test.
#[test]
fn w10_plain_shell_waits_for_the_first_window_size() {
    plain_shell_starts_on_the_first_window_size("w10-shell-size", 100, 40, 20);
}
/// Ticket 1001: a first window size equal to the PTY's opening 160x50 changes nothing the wait can see, yet the
/// shell starts well before the 8 s fallback.
#[test]
fn w28_plain_shell_starts_on_a_first_window_size_of_160x50() {
    // The wait ends on the size file the first Resize writes (checked below), not on a draw deadline: on a loaded
    // gate the shell's first prompt alone took more than 3 s (11-20), so the draw gets the same 20 s as w10.
    plain_shell_starts_on_the_first_window_size("w28-shell-160x50", 160, 50, 20);
}
fn plain_shell_starts_on_the_first_window_size(name: &str, cols: u16, rows: u16, within_secs: u64) {
    let home = scratch(name);
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(core.window_size, None, "a new home has no stored size");
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    launch.env.insert("HOME".into(), home.display().to_string()); // past `--env`'s allow list: a test seam
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let end = |core: &Sessions| core.entries[&id].pty.as_ref().unwrap().end();
    assert_eq!(end(&core), 0, "the shell has not drawn at 160 columns");
    core.handle(Request::Resize {
        id: id.clone(),
        cols,
        rows,
    })
    .unwrap();
    assert!(
        home.join(WINDOW_SIZE).exists(),
        "the first Resize did not write the window size the wait reads"
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(within_secs);
    while end(&core) == 0 {
        assert!(std::time::Instant::now() < until, "the shell never started");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}
/// Ticket 1137: a prompt sent to a shell just started (still waiting for the window's size) runs once the shell starts,
/// with no second Enter, and runs once.
#[test]
fn t1137_a_shell_prompted_at_once_runs_the_line_once() {
    let home = scratch("t1137-shell-first-prompt");
    let mut core = Sessions::open(&home).unwrap();
    assert_eq!(
        core.window_size, None,
        "a new home has no stored size: the shell waits for one"
    );
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    launch.env.insert("HOME".into(), home.display().to_string()); // past `--env`'s allow list: a test seam
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    core.handle(Request::AgentPrompt {
        id: id.clone(),
        text: "echo x >> ran.log".into(),
    })
    .unwrap();
    // No window opens: the prompt ends the size wait, so the line runs well before its 8 s fallback.
    let ran = home.join("ran.log");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(6);
    while !ran.exists() {
        assert!(
            std::time::Instant::now() < until,
            "the prompt waited for the 8 s size fallback"
        );
        let _ = core.handle(Request::List);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    std::thread::sleep(std::time::Duration::from_secs(2));
    let _ = core.handle(Request::List);
    assert_eq!(
        fs::read_to_string(&ran).unwrap(),
        "x\n",
        "the line ran exactly once"
    );
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn steer_ctrl_enter_no_interrupt_kind_stays_queued() {
    // A shell has no turn to break: the refusal says so and nothing is written or queued.
    let mut f = flood("steer-shell", b"$ \r\n");
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Shell;
    let refused = steer(&mut f, "now", &[]).unwrap_err();
    assert!(refused.starts_with("no_interrupt:"), "{refused}");
    assert!(rows(&f).is_empty());
    assert_eq!(got(&f), b"");
}
#[test]
fn no_double_delivery() {
    // A request waiting while the agent works: the Esc would answer it, so the steer stops before both.
    let mut f = unobserved("steer-blocked", &b"line of output\r\n".repeat(8));
    hook(&mut f, "UserPromptSubmit");
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "PermissionRequest".into(),
            payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"ls"}}),
        })
        .unwrap();
    let seen = pending_ids(&f);
    assert_eq!(seen.len(), 1, "the hook queued a permission");
    let refused = steer(&mut f, "now", &seen).unwrap_err();
    assert_eq!(refused, "agent_blocked");
    assert!(rows(&f).is_empty() && got(&f).is_empty());
    // A screen the observe pass has not caught up with hides what the Esc would answer: refused too.
    let mut f = idle_then_backlog(
        "steer-lag",
        &b"line of output\r\n".repeat(4 * 1024 * 1024 / 16),
    );
    hook(&mut f, "UserPromptSubmit");
    more(&f, 4 * 1024 * 1024);
    let refused = steer(&mut f, "now", &[]).unwrap_err();
    assert!(refused.contains("screen not current"), "{refused}");
    assert!(rows(&f).is_empty() && got(&f).is_empty());
    // Once the screen is current the steer runs once, and no later tick writes the text again. Ticket 1056: no Esc
    // for Claude; this screen shows no input box, so the text waits for the turn's end.
    catch_up(&mut f);
    steer(&mut f, "now", &[]).unwrap();
    assert_eq!(got(&f), b"");
    hook(&mut f, "Stop");
    f.core.tick().unwrap();
    assert_eq!(got(&f), b"now\r", "one copy of the text");
    f.core.tick().unwrap();
    f.core.tick().unwrap();
    assert_eq!(got(&f), b"now\r", "nothing is resent");
    assert_eq!(rows(&f).iter().filter(|s| s.content == "now").count(), 1);
}
/// Ticket 1094: a turn whose Stop was held for a background agent whose end never came settles, and the message
/// queued behind it then goes in once. Was: the session read as working for good and the message stayed queued.
#[test]
fn t1094_a_settled_turn_takes_the_queued_message_once() {
    let mut f = unobserved("t1094-settle", &b"line of output\r\n".repeat(8));
    hook(&mut f, "UserPromptSubmit");
    // Claude's Stop hook names the background agent still running; its end is never heard.
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "Stop".into(),
            payload: serde_json::json!({"background_tasks":[{"id":"a1","status":"running"}]}),
        })
        .unwrap();
    assert!(
        f.core.queue.attention(&f.id).working,
        "held for the background agent"
    );
    let id = f.id.clone();
    f.core.prompt_as_user(&id, "next".into()).unwrap();
    f.core.tick().unwrap();
    assert_eq!(
        got(&f),
        b"",
        "held while the core reads the turn as running"
    );
    f.core.queue.age_held_stop(&id, queue::HELD_STOP_MS);
    w14_tick_until(&mut f, 20, "the queued message never went in", |f| {
        rows(f)
            .iter()
            .any(|s| s.content == "next" && s.status == "delivered")
    });
    assert!(!f.core.queue.attention(&id).working || got(&f).starts_with(b"next"));
    for _ in 0..3 {
        f.core.tick().unwrap();
    }
    assert_eq!(got(&f), b"next\r", "one copy");
}
/// Ticket 1094 (review r1 point 4): the model picker drew over the box between the paste and its Enter. The user's
/// message is not left failed: it waits in the queue, named by its drop.
#[test]
fn t1094_a_users_message_dropped_by_the_picker_waits_again() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let picker = "\x1b[2J\x1b[H Select model\r\n \u{276f} 1. Default\r\n";
    let mut f = flood_script(
        "t1094-picker",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            picker.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + picker.len());
    catch_up(&mut f);
    f.core.pending_enter.get_mut(&f.id).unwrap().written -= SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_picker"));
    // The delivery record: he cancels his dropped prompt; it needed a person.
    f.core
        .handle(Request::CancelSend {
            id: f.id.clone(),
            send: send.id.clone(),
        })
        .unwrap();
    assert_eq!(
        recorded(&f.home),
        crate::record::Day {
            delivered: 0,
            resent: 0,
            person: 1
        }
    );
}
/// Ticket 1094 (review r1 point 1): a delivery the agent took no turn from (its Enter dropped, a submit refused) is
/// in flight only until the idle agent shows its input box INFLIGHT_IDLE later: an idle agent never holds every
/// later send for ever.
#[test]
fn t1094_an_idle_agent_never_holds_a_delivery_for_ever() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = unobserved("t1094-inflight", boxed.as_bytes());
    catch_up(&mut f);
    let id = f.id.clone();
    // As after a second dropped Enter on main: in flight at completion_seq 0, idle, no turn will ever end.
    f.core.delivery_inflight.insert(id.clone(), 0);
    f.core
        .inflight_at
        .insert(id.clone(), std::time::Instant::now());
    f.core.prompt_as_user(&id, "next".into()).unwrap();
    f.core.tick().unwrap();
    assert_eq!(got(&f), b"", "held while the in-flight write is fresh");
    let past = std::time::Instant::now() - INFLIGHT_IDLE;
    f.core.inflight_at.insert(id.clone(), past);
    w14_tick_until(&mut f, 20, "the idle agent never took the message", |f| {
        rows(f)
            .iter()
            .any(|s| s.content == "next" && s.status == "delivered")
    });
    assert!(!f.core.queue.attention(&id).working);
}
/// Ticket 1094 r3 (review r2 MUST 1): a store holding every settle mark the core can save opens again after a
/// restart. The drop behind the screen ("enter_dropped_behind", logged only) once saved a mark the next start refused.
#[test]
fn t1094_every_saved_mark_opens_after_a_restart() {
    let (mut f, send) = pasted_then_flooded(
        "t1094-marks",
        ENTER_CATCH_UP + std::time::Duration::from_secs(1),
    );
    f.core.flush_delivery().unwrap();
    assert_eq!(send_row(&f, &send).status, "queued");
    assert_eq!(crate::delivery::saved_mark(BEHIND), None);
    // Every mark the core may save, on delivered and failed rows of the log.
    let base = send_row(&f, &send);
    for (n, mark) in crate::delivery::SETTLE_MARKS.iter().enumerate() {
        let mut row = base.clone();
        row.id = crate::store::new_id().unwrap();
        row.status = if n % 2 == 0 { "delivered" } else { "failed" }.into();
        row.settle = crate::delivery::saved_mark(mark);
        assert!(row.settle.is_some(), "{mark}");
        f.core
            .entries
            .get_mut(&f.id)
            .unwrap()
            .meta
            .send_log
            .push(row);
    }
    f.core.save().unwrap();
    let again = Sessions::open(&f.home).err();
    assert_eq!(again, None, "the saved store must open again");
}
/// Ticket 1094 r3 (review r2 SHOULD 1): the owner's message whose Enter was dropped is not pasted again while his own
/// hand-typed words sit in the box (the box is not cleared then, and the copies went in glued). It goes once his
/// words are gone (his own Enter).
#[test]
fn t1094_a_dropped_message_is_not_pasted_again_behind_hand_typed_words() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let own = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} my own words\r\n{RULE}\r\n");
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = flood_script(
        "t1094-hand",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f sent ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            own.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            empty.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + own.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the pass that sees the last frame starts its quiet time
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet -= SWITCH_SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    // The owner typed in the agent's box by hand (`SendText` marks it so).
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .input
        .mark_uncertain();
    // The script's first read may swallow the first paste; count the copies written after the drop.
    let copies = |f: &Flood| got(f).windows(2).filter(|w| w == b"hi").count();
    let first = copies(&f);
    for _ in 0..4 {
        f.core.flush_delivery().unwrap();
    }
    assert_eq!(
        copies(&f),
        first,
        "not pasted again while his words sit in the box"
    );
    assert_eq!(send_row(&f, &send.id).status, "queued");
    // His own Enter sent his words and the agent drew its box empty; the message goes now.
    f.core.entries.get_mut(&f.id).unwrap().input = Default::default();
    fs::write(f.home.join("sent"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + own.len() + empty.len());
    catch_up(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(
        copies(&f),
        first + 1,
        "the message goes once his words are gone"
    );
}
/// Ticket 1094 r4 (review r3 MUST 1), r6 (lead): the copy of a dropped message is still in Claude's box with only the
/// word he typed after it. His own Enter in the terminal sends the box; the row is delivered once his turn starts (the
/// proof), and the core never pastes it again.
#[test]
fn t1094_his_own_enter_sends_the_dropped_copy_once() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let typed_box = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi x\r\n{RULE}\r\n");
    let mut f = flood_script(
        "t1094-own-enter",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f again ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            typed_box.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the pass that sees the last frame starts its quiet time
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet -= SWITCH_SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    let copies = |f: &Flood| got(f).windows(2).filter(|w| w == b"hi").count();
    let first = copies(&f);
    let raw = |f: &mut Flood, text: &str| {
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: text.into(),
                seen: vec![],
                composer: false,
            })
            .unwrap();
    };
    // He types in the terminal; the dialog closes and the box shows the copy and his word.
    raw(&mut f, "x");
    fs::write(f.home.join("again"), "").unwrap();
    wait_end(
        &f,
        PROMPT.len() + boxed.len() + dialog.len() + typed_box.len(),
    );
    catch_up(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(copies(&f), first, "not pasted again behind his words");
    raw(&mut f, "\r");
    f.core.flush_delivery().unwrap();
    assert_eq!(
        send_row(&f, &send.id).status,
        "queued",
        "no turn yet: not delivered, and not pasted"
    );
    assert_eq!(copies(&f), first);
    hook(&mut f, "UserPromptSubmit");
    f.core.flush_delivery().unwrap();
    assert_eq!(send_row(&f, &send.id).status, "delivered");
    hook(&mut f, "Stop");
    for _ in 0..3 {
        f.core.tick().unwrap();
    }
    assert_eq!(copies(&f), first, "one copy: the one his Enter sent");
    assert_eq!(
        recorded(&f.home),
        crate::record::Day {
            delivered: 1,
            resent: 0,
            person: 1
        },
        "his Enter sent it: delivered once, needed a person, not resent"
    );
}
/// Ticket 1094 r6 (lead): the box proves the copy, but no turn starts after his Enter (Claude did not take it). The row
/// is never shown delivered: once the idle agent showed no turn for HAND_PROOF, it goes again.
#[test]
fn t1094_a_proven_box_without_a_turn_goes_again() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let typed_box = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi x\r\n{RULE}\r\n");
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = flood_script(
        "t1094-own-enter-no-turn",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f again ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f sent ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            typed_box.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            empty.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the pass that sees the last frame starts its quiet time
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet -= SWITCH_SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    let copies = |f: &Flood| got(f).windows(2).filter(|w| w == b"hi").count();
    let first = copies(&f);
    let raw = |f: &mut Flood, text: &str| {
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: text.into(),
                seen: vec![],
                composer: false,
            })
            .unwrap();
    };
    // He types in the terminal; the dialog closes and the box shows the copy and his word.
    raw(&mut f, "x");
    fs::write(f.home.join("again"), "").unwrap();
    wait_end(
        &f,
        PROMPT.len() + boxed.len() + dialog.len() + typed_box.len(),
    );
    catch_up(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(copies(&f), first, "not pasted again behind his words");
    raw(&mut f, "\r");
    // The agent drew its box empty after his Enter.
    fs::write(f.home.join("sent"), "").unwrap();
    wait_end(
        &f,
        PROMPT.len() + boxed.len() + dialog.len() + typed_box.len() + empty.len(),
    );
    catch_up(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(
        send_row(&f, &send.id).status,
        "queued",
        "no turn yet: not delivered, and not pasted"
    );
    assert_eq!(copies(&f), first);
    f.core.hand_sent.get_mut(&f.id).unwrap().4 -= HAND_PROOF;
    f.core.flush_delivery().unwrap();
    assert!(!f.core.hand_sent.contains_key(&f.id), "the proof failed");
    assert_ne!(send_row(&f, &send.id).status, "delivered");
    assert_eq!(copies(&f), first + 1, "it goes again");
}
/// Ticket 1094 r5 (review r4 MUST 1), r6: his box only looks like it holds the dropped message ("hi" inside "this
/// works"). His own Enter sends his words, not the message: the row stays queued, is never shown delivered, and goes
/// again after his turn.
#[test]
fn t1094_his_enter_on_words_that_only_look_like_the_message() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let own = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} this works\r\n{RULE}\r\n");
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = flood_script(
        "t1094-look-alike",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f again ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f sent ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            own.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            empty.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the pass that sees the last frame starts its quiet time
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet -= SWITCH_SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    let copies = |f: &Flood| got(f).windows(2).filter(|w| w == b"hi").count();
    let first = copies(&f);
    let raw = |f: &mut Flood, text: &str| {
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: text.into(),
                seen: vec![],
                composer: false,
            })
            .unwrap();
    };
    raw(&mut f, "x");
    fs::write(f.home.join("again"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len() + own.len());
    catch_up(&mut f);
    raw(&mut f, "\r");
    assert!(
        !f.core.hand_sent.contains_key(&f.id),
        "no proof from a look-alike box"
    );
    // The agent drew its box empty after his Enter.
    fs::write(f.home.join("sent"), "").unwrap();
    wait_end(
        &f,
        PROMPT.len() + boxed.len() + dialog.len() + own.len() + empty.len(),
    );
    catch_up(&mut f);
    hook(&mut f, "UserPromptSubmit");
    f.core.flush_delivery().unwrap();
    assert_eq!(send_row(&f, &send.id).status, "queued");
    hook(&mut f, "Stop");
    for _ in 0..3 {
        f.core.tick().unwrap();
    }
    assert_ne!(send_row(&f, &send.id).status, "queued");
    assert_eq!(copies(&f), first + 1, "it goes again after his turn");
}
/// Round 6 (security look): what he types after a drop is kept only up to the largest send row; past it the box is
/// unprovable (None), so the dropped row goes again (one extra copy at worst, never a loss) and the string stops growing.
#[test]
fn t1094_typed_words_past_the_send_limit_prove_nothing() {
    let mut f = unobserved("t1094-typed-cap", b"");
    let id = f.id.clone();
    f.core.copy_left.insert(id.clone(), "row".into());
    f.core.hand_typed.insert(id.clone(), Some(String::new()));
    // Ticket 1142 (CI "uncertain"): the first write could beat the fixture's `stty raw` and reader (`got` is made by
    // the reader's own redirect), and a plain 32 KiB write must pass the 1 KiB terminal queue within the holder's
    // 100 ms bound. So each write waits until the reader has every earlier byte, and a chunk goes as a bracketed paste
    // (1.5 s, then the background writer); the markers are stripped before counting, so the typed length is the same.
    let chunk = format!(
        "\x1b[200~{}\x1b[201~",
        "a".repeat(crate::delivery::SEND_LIMIT / 2)
    );
    let mut sent = 0;
    let mut raw = |f: &mut Flood, text: &str| {
        wait_for("the agent read every earlier byte", &mut || {
            fs::metadata(f.home.join("got")).is_ok_and(|m| m.len() as usize >= sent)
        });
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: text.into(),
                seen: vec![],
                composer: false,
            })
            .unwrap();
        sent += text.len();
    };
    raw(&mut f, &chunk);
    raw(&mut f, &chunk);
    assert_eq!(
        f.core.hand_typed[&id].as_ref().map(String::len),
        Some(crate::delivery::SEND_LIMIT),
        "kept up to the limit"
    );
    raw(&mut f, "b");
    assert_eq!(f.core.hand_typed[&id], None, "past the limit: unprovable");
    raw(&mut f, &chunk);
    assert_eq!(f.core.hand_typed[&id], None, "and it stays so");
}
/// Round 6: the in-flight time of a session that is gone does not stay for ever.
#[test]
fn t1094_inflight_times_of_gone_sessions_are_dropped() {
    let mut f = unobserved("t1094-inflight-gone", b"");
    f.core
        .inflight_at
        .insert("gone".into(), std::time::Instant::now());
    f.core
        .inflight_at
        .insert(f.id.clone(), std::time::Instant::now());
    f.core.flush_delivery().unwrap();
    assert!(!f.core.inflight_at.contains_key("gone"));
    assert!(f.core.inflight_at.contains_key(&f.id));
}
/// Ticket 1094 r6 (lead): what proves a dropped copy in the box, and what does not.
#[test]
fn t1094_what_proves_the_copy_in_the_box() {
    // Proven: the paste alone, with his words after or before it, or as Claude's placeholder for it.
    assert!(proven_copy("hi", "hi", ""));
    assert!(proven_copy("hi there now", "hi there", "now"));
    assert!(proven_copy("now hi there", "hi there", "now"));
    assert!(proven_copy("[Pasted text #1 +2 lines] ok", "a\nb\nc", "ok"));
    assert!(proven_copy("[Image #1]", "/tmp/a.png", ""));
    // Not proven: a look-alike, other words, a glued word, a placeholder of another shape, nothing typed known.
    assert!(!proven_copy("this works", "hi", "x"));
    assert!(!proven_copy("hi y", "hi", "x"));
    assert!(!proven_copy("hix", "hi", "x"));
    assert!(!proven_copy("hi", "hi", "x"));
    assert!(!proven_copy("[Pasted text #1 +1 lines]", "a\nb\nc", ""));
    assert!(!proven_copy("x", "hi", "x"));
    assert!(!proven_copy("", "hi", ""));
}
/// Ticket 1094 r5 (review r4 MUST 1): the window composer's own send clears the box first (Ctrl+U), so the dropped
/// copy is gone before its Enter. That Enter sends only his new message, even one with the old words in it; the
/// dropped row stays queued and the core sends it after his turn.
#[test]
fn t1094_the_window_enter_after_a_cleared_copy_takes_nothing() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let mut f = flood_script(
        "t1094-window-enter",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f again ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            boxed.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the pass that sees the last frame starts its quiet time
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet -= SWITCH_SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    fs::write(f.home.join("again"), "").unwrap();
    wait_end(&f, PROMPT.len() + 2 * boxed.len() + dialog.len());
    catch_up(&mut f);
    let copies = |f: &Flood| got(f).windows(2).filter(|w| w == b"hi").count();
    let first = copies(&f);
    // As useComposerSend: the text, then its Enter, both with the composer flag.
    let seen = pending_ids(&f);
    f.core
        .handle(Request::SendText {
            id: f.id.clone(),
            text: "say hi now".into(),
            seen: seen.clone(),
            composer: true,
        })
        .unwrap();
    f.core
        .handle(Request::SendKeys {
            id: f.id.clone(),
            keys: vec!["enter".into()],
            seen,
            composer: true,
        })
        .unwrap();
    assert_eq!(
        send_row(&f, &send.id).status,
        "queued",
        "not taken by his new message"
    );
    assert_eq!(copies(&f), first + 1, "his new message only");
    hook(&mut f, "UserPromptSubmit");
    hook(&mut f, "Stop");
    // Ticket 1121: after his turn the agent draws its box empty; the dropped row goes only into a box read so.
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .observer
        .screen
        .feed(empty.as_bytes());
    for _ in 0..3 {
        f.core.tick().unwrap();
    }
    assert_eq!(
        copies(&f),
        first + 2,
        "the dropped message goes after his turn"
    );
}
/// Ticket 1094 r4 (review r3 SHOULD 1): a raw key that types nothing into the box (a dialog's digit, an arrow) marks it
/// edited until an Enter. A dropped message waits only while the box holds words: on an empty box it goes.
#[test]
fn t1094_an_empty_box_releases_the_dropped_message() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n");
    let own = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} my own words\r\n{RULE}\r\n");
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = flood_script(
        "t1094-empty-box",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nj=0; while [ ! -f again ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            own.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            empty.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + own.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the pass that sees the last frame starts its quiet time
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet -= SWITCH_SETTLE;
    f.core.flush_enters().unwrap();
    let row = send_row(&f, &send.id);
    assert_eq!(row.status, "queued", "{row:?}");
    assert_eq!(row.settle.as_deref(), Some("enter_dropped_composer"));
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .input
        .mark_uncertain();
    let copies = |f: &Flood| got(f).windows(2).filter(|w| w == b"hi").count();
    let first = copies(&f);
    f.core.flush_delivery().unwrap();
    assert_eq!(copies(&f), first, "held while the box holds words");
    fs::write(f.home.join("again"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + own.len() + empty.len());
    catch_up(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(copies(&f), first + 1, "the empty box takes it");
}
/// A send that finds the agent ready while an earlier row still waits in the queue goes behind that row, never ahead
/// of it. A seat opened by a schedule queued its brief before the agent drew its box; the next scheduled task found
/// the box drawn, was typed at once, and the brief (with the first task in it) was never typed.
#[test]
fn a_ready_send_never_overtakes_a_queued_one() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = unobserved("queued-first", boxed.as_bytes());
    catch_up(&mut f);
    let id = f.id.clone();
    // Not ready yet: the brief waits in the queue.
    hook(&mut f, "UserPromptSubmit");
    f.core.prompt_as_user(&id, "the brief".into()).unwrap();
    assert_eq!(rows(&f)[0].status, "queued");
    // Ready now; the next task arrives before a delivery pass took the brief.
    hook(&mut f, "Stop");
    f.core.prompt_as_user(&id, "the task".into()).unwrap();
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    let got = got(&f);
    let at = |w: &[u8]| got.windows(w.len()).position(|x| x == w);
    assert!(at(b"the brief").is_some(), "the brief was never typed");
    assert!(
        at(b"the task").is_none_or(|t| t > at(b"the brief").unwrap()),
        "the task went ahead of the brief"
    );
}
/// Ticket 1094 r3 (review r2 NIT 1): the retry time of a message dropped again holds that message only; the owner's
/// newer message goes at once.
#[test]
fn t1094_a_retried_message_does_not_hold_a_new_one() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = unobserved("t1094-retry-row", boxed.as_bytes());
    catch_up(&mut f);
    let id = f.id.clone();
    hook(&mut f, "UserPromptSubmit");
    f.core.prompt_as_user(&id, "old".into()).unwrap();
    let old = rows(&f).into_iter().find(|s| s.content == "old").unwrap();
    assert_eq!(old.status, "queued");
    f.core.drops.insert(old.id.clone(), 2);
    f.core.retry_at.insert(
        old.id.clone(),
        std::time::Instant::now() + std::time::Duration::from_secs(60),
    );
    hook(&mut f, "Stop");
    f.core.prompt_as_user(&id, "new".into()).unwrap();
    w14_tick_until(&mut f, 20, "the new message was held", |f| {
        rows(f)
            .iter()
            .any(|s| s.content == "new" && s.status == "delivered")
    });
    // The new message's turn runs and ends: the old one still waits out its own retry time, then goes.
    hook(&mut f, "UserPromptSubmit");
    hook(&mut f, "Stop");
    for _ in 0..3 {
        f.core.tick().unwrap();
    }
    assert_eq!(send_row(&f, &old.id).status, "queued");
    assert!(
        !got(&f).windows(3).any(|w| w == b"old"),
        "the old message waits out its retry time"
    );
    f.core
        .retry_at
        .insert(old.id.clone(), std::time::Instant::now());
    w14_tick_until(&mut f, 20, "the old message never went", |f| {
        rows(f)
            .iter()
            .any(|s| s.content == "old" && s.status == "delivered")
    });
}
/// Ticket 1094 (review r1 point 2): a Claude the queue reads as working (a prompt replayed after a restart, a Stop
/// hook refused) whose screen shows its idle box and that drew nothing for IDLE_SETTLE_MS ends its turn.
#[test]
fn t1094_an_idle_screen_settles_a_lost_turn() {
    let boxed = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = unobserved("t1094-idle-screen", boxed.as_bytes());
    catch_up(&mut f);
    hook(&mut f, "UserPromptSubmit");
    let id = f.id.clone();
    f.core.tick().unwrap();
    assert!(
        f.core.queue.attention(&id).working,
        "not before IDLE_SETTLE_MS"
    );
    f.core.queue.age_activity(&id, IDLE_SETTLE_MS);
    f.core.tick().unwrap();
    let a = f.core.queue.attention(&id);
    assert_eq!((a.working, a.completion_seq), (false, 1));
}
/// Ticket 1056: Send now on a working Claude is refused while a Question waits; nothing is written or queued.
#[test]
fn steer_refused_while_a_question_waits() {
    let rule = "\u{2500}".repeat(60);
    let question = format!(
        "\x1b[2J\x1b[H{rule}\r\n \u{2610} Fruit\r\nWhich fruit do you want?\r\n\u{276f} 1. Apple\r\n  2. Pear\r\n  3. Type something.\r\n{rule}\r\n  4. Chat about this\r\nEnter to select \u{b7} \u{2191}/\u{2193} to navigate \u{b7} Esc to cancel\r\n"
    );
    let mut f = unobserved("steer-question", question.as_bytes());
    hook(&mut f, "UserPromptSubmit");
    w14_tick_until(&mut f, 10, "no question card", |f| {
        f.core
            .queue
            .items_of(&f.id)
            .iter()
            .any(|i| i.kind == queue::Kind::Question)
    });
    assert!(f.core.queue.attention(&f.id).working);
    let seen = pending_ids(&f);
    assert_eq!(steer(&mut f, "now", &seen).unwrap_err(), "agent_blocked");
    assert!(rows(&f).is_empty() && got(&f).is_empty());
}
/// Ticket 1056: every other agent kind keeps the Esc path: the turn is broken first, the text goes after it.
#[test]
fn steer_on_a_working_codex_presses_esc_first() {
    let mut f = unobserved(
        "steer-codex",
        "\x1b[?2004l\x1b[2J\x1b[H\u{203a} \r\n".as_bytes(),
    );
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Codex;
    hook(&mut f, "UserPromptSubmit");
    steer(&mut f, "now", &[]).unwrap();
    assert_eq!(got(&f), b"\x1b", "the Esc first; no text yet");
}
/// A seat's brief (or a schedule's task) sent while the agent shows a question waits in the queue; it is not
/// refused, and it is not typed into the question.
#[test]
fn prompt_as_user_waits_behind_a_question() {
    let mut f = unobserved("brief-blocked", &b"line of output\r\n".repeat(8));
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "PermissionRequest".into(),
            payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"ls"}}),
        })
        .unwrap();
    let id = f.id.clone();
    f.core.prompt_as_user(&id, "the brief".into()).unwrap();
    let queued: Vec<_> = rows(&f)
        .into_iter()
        .filter(|s| s.content == "the brief")
        .collect();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].status, "queued");
    assert_eq!(got(&f), b"", "nothing typed into the question");
}
#[test]
fn steer_refusal_before_a_write_stays_plain() {
    // A refusal the core makes before writing gives the text back to the window, so it is never `uncertain:` even
    // when the input still carries a mark from an earlier send: only a failed write may have landed.
    let mut f = unobserved("steer-partial", &b"line of output\r\n".repeat(8));
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .input
        .mark_uncertain();
    let refused = steer(&mut f, "bad \u{1} text", &[]).unwrap_err();
    assert_eq!(refused, "invalid send text");
    assert!(rows(&f).is_empty() && got(&f).is_empty());
    // A request waiting while the agent works: the Esc would answer it, so the steer refuses before any write.
    hook(&mut f, "UserPromptSubmit");
    f.core
        .handle(Request::Hook {
            id: f.id.clone(),
            event: "PermissionRequest".into(),
            payload: serde_json::json!({"tool_name":"Bash","tool_input":{"command":"ls"}}),
        })
        .unwrap();
    let seen = pending_ids(&f);
    assert_eq!(seen.len(), 1);
    let refused = steer(&mut f, "now", &seen).unwrap_err();
    assert_eq!(refused, "agent_blocked");
    assert!(got(&f).is_empty());
}
#[test]
fn failed_write_says_uncertain() {
    // A write that may have landed partway is said as `uncertain:` (the window keeps the text out of the box), and
    // a write to a session that is not running is not.
    assert_eq!(
        typed_error("broken pipe".into(), true),
        crate::delivery::UNCERTAIN
    );
    assert_eq!(typed_error("broken pipe".into(), false), "broken pipe");
}
fn pending_text(f: &mut Flood) -> Option<String> {
    match f.core.handle(Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions[0].pending.first().map(|d| d.text.clone()),
        _ => panic!(),
    }
}
// ticket-77: one observe pass builds the screen text once per session, and the queued item and the limit
// mark are what they were when `detect` and `observe_limit` each built it.
fn text_calls_for_one_pass(name: &str, kind: AgentKind, limit: &str, mark: &str) {
    let bytes =
        format!("\x1b[2J\x1b[H{limit}\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n");
    let mut f = flood(name, bytes.as_bytes());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = kind;
    waiting::screen::TEXT_CALLS.with(|c| c.set(0));
    f.core.observe().unwrap();
    assert_eq!(waiting::screen::TEXT_CALLS.with(|c| c.get()), 1);
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
    let home = fs::canonicalize(&f.home).unwrap();
    let rows = crate::usage::rows(
        &home,
        &|_| None,
        queue::now_ms() as i64 / 1000,
        &crate::usage::local_offset,
        &mut crate::usage::Budget::request(),
    )
    .unwrap();
    let marks: Vec<_> = rows.iter().filter_map(|r| r.limit_resets.clone()).collect();
    assert_eq!(marks, vec![mark.to_string()]);
}
// The resets are two hours ahead of this machine's clock: fixed "11pm" marks were already past from 23:00 local
// (V2.5-41), so the check failed one hour a day.
#[test]
fn screen_text_built_once_per_detect() {
    let claude = claude_reset_ahead();
    text_calls_for_one_pass(
        "text-once-claude",
        AgentKind::Claude,
        &format!("You've hit your 5-hour limit \u{b7} resets {claude} (Asia/Seoul)"),
        &claude,
    );
    let codex = codex_reset_ahead();
    text_calls_for_one_pass(
        "text-once-codex",
        AgentKind::Codex,
        &format!("You've hit your usage limit. try again at {codex}."),
        &codex,
    );
}
#[test]
fn observe_feeds_at_most_the_cap_per_pass_and_drains_the_backlog() {
    let bytes = dialog_after(4 * OBSERVE_BYTES);
    let mut f = flood("cap", &bytes);
    let stream = [MARK, &bytes].concat();
    let end = stream.len() as u64;
    f.core.observe().unwrap();
    assert_eq!(
        offset(&f),
        OBSERVE_BYTES as u64,
        "one pass feeds at most the cap"
    );
    let mut passes = 1;
    while offset(&f) < end {
        let before = offset(&f);
        f.core.observe().unwrap();
        assert!(offset(&f) - before <= OBSERVE_BYTES as u64);
        passes += 1;
        assert!(passes <= 5, "the backlog did not drain");
    }
    assert_eq!(passes, stream.len().div_ceil(OBSERVE_BYTES));
    assert_eq!(offset(&f), end);
    let mut whole = waiting::screen::Screen::new(160, 50);
    whole.feed(&stream);
    assert_eq!(f.core.entries[&f.id].observer.screen.text(), whole.text());
    assert_eq!(
        pending_text(&mut f),
        whole.detect(AgentKind::Claude).map(|d| d.text)
    );
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
}
#[test]
fn snapshot_completes_while_an_observer_pass_is_held_at_the_parse_step() {
    // Cap design: the registry lock is free between two bounded passes over one backlog.
    use std::sync::{Arc, Mutex, mpsc};
    let f = Arc::new(Mutex::new(flood("lock", &dialog_after(4 * OBSERVE_BYTES))));
    let (passed, after_pass) = mpsc::channel();
    let (release, gate) = mpsc::channel::<()>();
    let observer = {
        let f = f.clone();
        std::thread::spawn(move || {
            f.lock().unwrap().core.observe().unwrap();
            passed.send(()).unwrap();
            gate.recv_timeout(std::time::Duration::from_secs(10))
                .expect("the test never released the gate");
            f.lock().unwrap().core.observe().unwrap();
            passed.send(()).unwrap();
        })
    };
    let wait = |what: &str| {
        after_pass
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("{what}"))
    };
    wait("the first observer pass never finished");
    let seen = {
        let mut held = f.lock().unwrap();
        assert!(
            offset(&held) < held.core.entries[&held.id].pty.as_ref().unwrap().end(),
            "the first pass left backlog for the next one"
        );
        // A request runs one observer pass of its own, bounded by the same cap.
        assert!(matches!(
            held.core.handle(Request::Snapshot),
            Ok(Reply::Snapshot { .. })
        ));
        assert_eq!(offset(&held), 2 * OBSERVE_BYTES as u64);
        offset(&held)
    };
    release.send(()).unwrap();
    wait("the held pass never finished");
    observer.join().unwrap();
    assert_eq!(offset(&f.lock().unwrap()), seen + OBSERVE_BYTES as u64);
}
#[test]
fn observe_after_truncation_feeds_only_the_retained_tail() {
    let bytes = dialog_after(crate::pty::REPLAY_BYTES + 3 * OBSERVE_BYTES);
    let mut f = flood("trunc", &bytes);
    let stream = [MARK, &bytes].concat();
    let end = stream.len() as u64;
    let first = end - crate::pty::REPLAY_BYTES as u64;
    f.core
        .entries
        .get_mut(&f.id)
        .unwrap()
        .observer
        .screen
        .feed(b"STALE");
    f.core.observe().unwrap();
    assert_eq!(
        offset(&f),
        first + OBSERVE_BYTES as u64,
        "reset, then at most the cap of the tail"
    );
    assert!(
        !f.core.entries[&f.id]
            .observer
            .screen
            .text()
            .contains("STALE")
    );
    let mut passes = 1;
    while offset(&f) < end {
        f.core.observe().unwrap();
        passes += 1;
        assert!(passes <= 16, "the tail did not drain");
    }
    let mut tail = waiting::screen::Screen::new(160, 50);
    tail.feed(&stream[first as usize..]);
    assert_eq!(f.core.entries[&f.id].observer.screen.text(), tail.text());
    assert!(
        pending_text(&mut f)
            .unwrap()
            .contains("Do you want to proceed?")
    );
}
// V2-2c limit mark: a reset two hours from now in this machine's zone, as Claude Code 2.1.312 prints it ("4:05pm").
fn claude_reset_ahead() -> String {
    let now = queue::now_ms() as i64 / 1000 + 7200;
    let local = (now + crate::usage::local_offset(now)).rem_euclid(86_400);
    let (h, m) = (local / 3600, local % 3600 / 60);
    format!(
        "{}:{m:02}{}",
        (h + 11) % 12 + 1,
        if h < 12 { "am" } else { "pm" }
    )
}
// As Codex 0.161.0 prints a reset two hours ahead: "2:20 PM" the same day, else with its date
// ("Oct 30th, 2026 2:20 PM").
fn codex_reset_ahead() -> String {
    let now = queue::now_ms() as i64 / 1000;
    let at = now + 7200;
    let day = |t: i64| (t + crate::usage::local_offset(t)).div_euclid(86_400);
    let local = (at + crate::usage::local_offset(at)).rem_euclid(86_400);
    let (h, m) = (local / 3600, local % 3600 / 60);
    let clock = format!(
        "{}:{m:02} {}",
        (h + 11) % 12 + 1,
        if h < 12 { "AM" } else { "PM" }
    );
    if day(at) == day(now) {
        return clock;
    }
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are to live locals; localtime_r writes only `tm`.
    unsafe { libc::localtime_r(&(at as libc::time_t), &mut tm) };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let d = tm.tm_mday;
    let suffix = match (d % 10, d / 10 % 10) {
        (1, 1) | (2, 1) | (3, 1) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!(
        "{} {d}{suffix}, {} {clock}",
        MONTHS[tm.tm_mon as usize],
        tm.tm_year + 1900
    )
}
// V2-2c acceptance `screen_hook_never_changes_what_is_typed`: the same dialog with and without a limit line above
// it queues the same item, starts no delivery and writes no byte to the PTY (the script records its input); only
// the screen with the limit line marks the session's account ("Your own" here).
#[test]
fn screen_hook_never_changes_what_is_typed() {
    let resets = claude_reset_ahead();
    let dialog = b"\x1b[2J\x1b[HDo you want to proceed?\r\n1. Yes\r\n2. No\r\n".to_vec();
    let mut limited =
        format!("You've hit your 5-hour limit \u{b7} resets {resets} (Local)\r\n").into_bytes();
    limited.extend(b"\x1b[3;1H");
    limited.extend(b"Do you want to proceed?\r\n1. Yes\r\n2. No\r\n");
    let mut seen = vec![];
    for (name, bytes) in [("hook-plain", &dialog), ("hook-limit", &limited)] {
        let mut f = flood_script(name, bytes, "(cat > typed) 0<&0 &\ncat burst\n");
        wait_end(&f, bytes.len());
        for _ in 0..3 {
            f.core.observe().unwrap();
        }
        let pending = match f.core.handle(Request::Snapshot).unwrap() {
            Reply::Snapshot { sessions, .. } => sessions[0]
                .pending
                .iter()
                .map(|d| {
                    // The item quotes its screen, so the text differs by the limit line only.
                    assert!(d.text.contains("Do you want to proceed?\n1. Yes\n2. No"));
                    (d.kind.clone(), d.choices.clone(), d.actionable)
                })
                .collect::<Vec<_>>(),
            _ => panic!(),
        };
        assert!(f.core.delivery_inflight.is_empty());
        assert_eq!(fs::read(f.home.join("typed")).unwrap_or_default(), b"");
        let home = fs::canonicalize(&f.home).unwrap();
        let now = queue::now_ms() as i64 / 1000;
        let rows = crate::usage::rows(
            &home,
            &|_| None,
            now,
            &crate::usage::local_offset,
            &mut crate::usage::Budget::request(),
        )
        .unwrap();
        let marks: Vec<_> = rows
            .iter()
            .filter_map(|r| Some((r.agent, r.id.clone(), r.limit_resets.clone()?)))
            .collect();
        // The capture works: a byte the core sends does reach `typed`.
        f.core
            .handle(Request::SendText {
                id: f.id.clone(),
                text: "z".into(),
                composer: false,
                seen: vec![],
            })
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while fs::read(f.home.join("typed")).unwrap_or_default() != b"z" {
            assert!(
                std::time::Instant::now() < until,
                "the input capture never saw a sent byte"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        seen.push((pending, marks));
    }
    assert!(!seen[0].0.is_empty(), "the dialog queued an item");
    assert_eq!(seen[0].0, seen[1].0);
    assert_eq!(seen[0].1, vec![]);
    assert_eq!(
        seen[1].1,
        vec![(crate::accounts::Agent::Claude, "own".to_string(), resets)]
    );
}
// v1b-40 r2: rows of a set-aside sessions.json still own their saved scrollback and exports, on this start and
// every later one (the next start finds no sessions.json, or a new one without those rows).
#[test]
fn scrollback_and_exports_survive_a_set_aside_start() {
    let home = scratch("aside-sweep");
    for dir in ["scrollback", "exports/old-1"] {
        fs::create_dir_all(home.join(dir)).unwrap();
    }
    fs::write(home.join("scrollback/old-1"), b"saved").unwrap();
    fs::write(home.join("exports/old-1/scrollback.txt"), b"export").unwrap();
    fs::write(
        home.join("sessions.json"),
        // V2-1a: this core reads 1, 2 and 3 (ticket 752 round 2), so 4 is the newer core's.
        br#"{"version":4,"sessions":[{"id":"old-1"}]}"#,
    )
    .unwrap();
    for _ in 0..2 {
        let mut core = Sessions::open(&home).unwrap();
        core.stop().unwrap();
        assert_eq!(fs::read(home.join("scrollback/old-1")).unwrap(), b"saved");
        assert_eq!(
            fs::read(home.join("exports/old-1/scrollback.txt")).unwrap(),
            b"export"
        );
    }
    let _ = fs::remove_dir_all(home);
}
// V2-2a: an account login launch runs only as a plain shell in the very folder its override names.
#[test]
fn account_launch_refuses_a_moved_folder_or_another_kind() {
    let home = scratch("acct-launch");
    let core = Sessions::open(&home).unwrap();
    let folder = home.join("acct");
    fs::create_dir_all(&folder).unwrap();
    let start = |kind, project: &Path, worktree| StartSession {
        account: None,
        kind,
        project: project.to_path_buf(),
        worktree,
        label: String::new(),
        args: vec!["/bin/cat".into()],
        model: None,
        effort: None,
        resume: None,
    };
    let launch = |s| core.launch_account(s, "CLAUDE_CONFIG_DIR", folder.clone());
    assert!(
        launch(start(AgentKind::Shell, &folder, false))
            .prepare()
            .is_ok()
    );
    for refused in [
        start(AgentKind::Claude, &folder, false),
        start(AgentKind::Shell, &folder, true),
        start(AgentKind::Shell, &home, false),
    ] {
        let err = launch(refused).prepare().err();
        assert_eq!(err.as_deref(), Some("invalid account login launch"));
    }
    // A link swapped in at the folder resolves elsewhere: refused.
    fs::remove_dir(&folder).unwrap();
    fs::create_dir_all(home.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(home.join("elsewhere"), &folder).unwrap();
    let err = launch(start(AgentKind::Shell, &folder, false))
        .prepare()
        .err();
    assert_eq!(err.as_deref(), Some("invalid account login launch"));
    let _ = fs::remove_dir_all(home);
}
// V1A-89 `hung_binary_bounded`: the ceiling kills a `--version` that never exits; the error names the program.
#[test]
fn version_probe_kills_a_hung_binary_at_the_ceiling() {
    use std::os::unix::fs::PermissionsExt;
    let home = scratch("version-hung");
    let fifo = home.join("never");
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let program = home.join("agent");
    let body = format!(
        "#!/bin/sh\necho $$ > '{0}/pid.tmp' && mv '{0}/pid.tmp' '{0}/pid'\nread x < '{1}'\n",
        home.display(),
        fifo.display()
    );
    fs::write(&program, body).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let probe =
        version_probe(program.to_str().unwrap(), std::time::Duration::from_secs(2)).unwrap();
    let error = probe
        .recv_timeout(std::time::Duration::from_secs(60))
        .unwrap()
        .unwrap_err();
    let expected = format!("{} --version: command timed out", program.display());
    assert!(error.starts_with(&expected), "{error}");
    // No pid file: the probe was killed before its first line ran, which is bounded too.
    if let Ok(pid) = fs::read_to_string(home.join("pid")) {
        let pid: i32 = pid.trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "the probe outlived it");
    }
    let _ = fs::remove_dir_all(home);
}
/// A fake agent whose `--version` appends a line to `count`, then runs `rest`.
fn counting_agent(home: &Path, rest: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let program = home.join("agent");
    let body = format!("#!/bin/sh\necho x >> '{}/count'\n{rest}\n", home.display());
    fs::write(&program, body).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    program
}
/// A fifo a fake `--version` blocks on; dropping it, on every path a failing test takes too, lets each probe
/// child go on and exit, so none outlives the test.
struct Held(PathBuf);
impl Drop for Held {
    fn drop(&mut self) {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        // Writer first, so a reader blocked in open goes on; then unlink, so a later one fails its open instead
        // of blocking; the write and close give each reader data or end of file.
        let writer = fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&self.0);
        let _ = fs::remove_file(&self.0);
        if let Ok(mut writer) = writer {
            let _ = writer.write_all(b"go\n");
        }
    }
}
fn fifo(home: &Path) -> Held {
    let fifo = home.join("release");
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    Held(fifo)
}
/// Lets a probe blocked in `read < fifo` go on, once it has opened it; the bound only fails a stuck test loudly.
fn release(fifo: Held) {
    use std::os::unix::fs::OpenOptionsExt;
    let until = std::time::Instant::now() + WAIT;
    while let Err(e) = fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo.0)
    {
        // ENXIO: no reader has opened it yet.
        assert!(std::time::Instant::now() < until, "never opened: {e}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    drop(fifo);
}
fn count(home: &Path) -> usize {
    fs::read_to_string(home.join("count"))
        .map(|c| c.lines().count())
        .unwrap_or(0)
}
const WAIT: std::time::Duration = std::time::Duration::from_secs(60);
// V1A-91: N requests for one program while its probe is held share one child and one answer; another program,
// and a symlink to the held one (a multi-call binary answers by the name it was run as), answer meanwhile.
#[test]
fn version_probe_is_single_flight_per_program() {
    let home = scratch("version-flight");
    let fifo = fifo(&home);
    let rest = format!(
        "case \"$0\" in */alias) echo 'alias 3.0';; *) read x < '{}'; echo 'held 1.0';; esac",
        fifo.0.display()
    );
    let program = counting_agent(&home, &rest);
    let alias = home.join("alias");
    std::os::unix::fs::symlink(&program, &alias).unwrap();
    let probes: Vec<_> = (0..4)
        .map(|_| version_probe(program.to_str().unwrap(), WAIT).unwrap())
        .collect();
    let other = scratch("version-flight-other");
    let other_program = counting_agent(&other, "echo 'other 2.0'");
    let answer = version_probe(other_program.to_str().unwrap(), WAIT)
        .unwrap()
        .recv_timeout(WAIT)
        .unwrap();
    assert_eq!(
        answer.as_deref(),
        Ok("other 2.0"),
        "blocked by the held probe"
    );
    let answer = version_probe(alias.to_str().unwrap(), WAIT)
        .unwrap()
        .recv_timeout(WAIT)
        .unwrap();
    assert_eq!(
        answer.as_deref(),
        Ok("alias 3.0"),
        "the alias shared the held probe"
    );
    assert!(
        probes.iter().all(|p| p.try_recv().is_err()),
        "answered before release"
    );
    release(fifo);
    for probe in probes {
        assert_eq!(probe.recv_timeout(WAIT).unwrap().as_deref(), Ok("held 1.0"));
    }
    assert_eq!(
        count(&home),
        2,
        "one child for the held program, one for its alias"
    );
    let _ = fs::remove_dir_all(home);
    let _ = fs::remove_dir_all(other);
}
// V1A-91: a probe that hit its ceiling, or failed to spawn, frees its slot; the next request probes again. Each
// answer arrives only after its slot is freed (`Flight::finish`), so the steps are ordered by the answers alone;
// a slot left behind would make the next request wait on it and fail at `WAIT`.
#[test]
fn single_flight_slot_freed() {
    use std::os::unix::fs::PermissionsExt;
    let home = scratch("version-freed");
    // Nothing ever writes to it before the end: the ceiling always fires, however slow the host.
    let fifo = fifo(&home);
    let program = counting_agent(&home, &format!("read x < '{}'", fifo.0.display()));
    let name = program.to_str().unwrap();
    let ceiling = std::time::Duration::from_secs(1);
    let error = version_probe(name, ceiling)
        .unwrap()
        .recv_timeout(WAIT)
        .unwrap();
    assert!(error.unwrap_err().contains("timed out"));
    let answer_now = |version: &str| {
        fs::write(
            &program,
            format!(
                "#!/bin/sh\necho x >> '{}/count'\necho '{version}'\n",
                home.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    };
    answer_now("freed 1.0");
    let ran = count(&home);
    let answer = version_probe(name, WAIT)
        .unwrap()
        .recv_timeout(WAIT)
        .unwrap();
    assert_eq!(answer.as_deref(), Ok("freed 1.0"));
    assert_eq!(count(&home), ran + 1);
    // A spawn error (not executable) frees the slot too.
    fs::set_permissions(&program, fs::Permissions::from_mode(0o600)).unwrap();
    let error = version_probe(name, WAIT)
        .unwrap()
        .recv_timeout(WAIT)
        .unwrap();
    assert!(error.is_err(), "{error:?}");
    answer_now("fixed 2.0");
    let answer = version_probe(name, WAIT)
        .unwrap()
        .recv_timeout(WAIT)
        .unwrap();
    assert_eq!(answer.as_deref(), Ok("fixed 2.0"));
    assert_eq!(count(&home), ran + 2);
    drop(fifo);
    let _ = fs::remove_dir_all(home);
}
// V1A-91 r3: a row that was not running when the last core ended (no live record) reloads as stored: its empty
// version is not filled in and it is not marked untested.
#[test]
fn an_exited_row_reloads_with_its_stored_version() {
    let home = scratch("version-exited");
    let row: Session = serde_json::from_value(serde_json::json!({
            "id": "s", "kind": "claude", "project": home, "cwd": home, "label": "old", "state": "exited",
            "agent_session_id": null, "agent_version": null, "untested": false, "pid": null,
        }))
        .unwrap();
    store::save(&home, vec![row], BTreeMap::new()).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let entry = &core.entries["s"];
    assert!(
        entry.version_probe.is_none(),
        "probed a row that was not running"
    );
    let snap = probed(&mut core);
    assert_eq!(snap.agent_version, None);
    assert!(!snap.untested);
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}
// V1A-91: a probe error the refresh reads gives `unknown`; the session keeps running.
#[test]
fn refresh_turns_a_probe_error_into_unknown() {
    let (mut core, launch, session) = probe_core("version-err", |_| Ok(()));
    let (sender, receiver) = std::sync::mpsc::channel();
    sender
        .send(Err(
            "claude --version: command timed out after 60000 ms".into()
        ))
        .unwrap();
    core.entries.get_mut(&session.id).unwrap().version_probe = Some(receiver);
    let snap = probed(&mut core);
    assert_eq!(snap.agent_version.as_deref(), Some("unknown"));
    assert_eq!(snap.state, SessionState::Running);
    // A probe thread gone without an answer reads the same.
    let (sender, receiver) = std::sync::mpsc::channel::<Result<String, String>>();
    drop(sender);
    let entry = core.entries.get_mut(&session.id).unwrap();
    entry.meta.agent_version = None;
    entry.version_probe = Some(receiver);
    assert_eq!(probed(&mut core).agent_version.as_deref(), Some("unknown"));
    end(core, launch);
}
// ticket 76: two running shells in one home, `target` the receiver and `sender` a local session id.
#[test]
fn merge_card_not_yet_with_a_reason_is_answered() {
    let home = scratch("merge-why");
    let mut core = Sessions::open(&home).unwrap();
    let ask = queue::OwnerAsk::Merge {
        task: "t9".into(),
        title: "fig".into(),
        place: home.clone(),
        revision: "b688c42".into(),
        learned: vec![],
    };
    let id = core.queue.ask_owner("lead", ask).unwrap();
    let text = "later please".into();
    let r = core.answer(&id, queue::Answer::DenyWith { text }, false);
    assert!(matches!(r, Ok(Reply::Ack)), "{r:?}");
    assert!(core.queue.owner_decision(&id).is_none(), "the card is gone");
}
// Q9 tt-J4-1: a yes the ledger cannot record (here: no such task) keeps the card, so Yes can be pressed again.
#[test]
fn merge_card_yes_not_recorded_keeps_the_card() {
    let home = scratch("merge-unrecorded");
    let mut core = Sessions::open(&home).unwrap();
    let ask = queue::OwnerAsk::Merge {
        task: "t9".into(),
        title: "fig".into(),
        place: home.clone(),
        revision: "b688c42".into(),
        learned: vec![],
    };
    let id = core.queue.ask_owner("lead", ask).unwrap();
    let r = core.answer(&id, queue::Answer::AllowOnce, true);
    assert!(r.is_err(), "{r:?}");
    assert!(core.queue.owner_decision(&id).is_some(), "the card stays");
}
// Codex round 2: a yes recorded while the card could not be removed never outlives the owner's later no.
#[test]
fn merge_card_yes_with_card_kept_does_not_outlive_a_no() {
    let home = scratch("merge-yes-then-no");
    let mut core = Sessions::open(&home).unwrap();
    let ledger = crate::ledger::Ledger::open(&home);
    let (task, _) = ledger
        .make(&home, Some("lead"), "fig", &[], false, 1)
        .unwrap();
    let ask = queue::OwnerAsk::Merge {
        task: task.id.clone(),
        title: "fig".into(),
        place: home.clone(),
        revision: "b688c42".into(),
        learned: vec![],
    };
    let id = core.queue.ask_owner("lead", ask).unwrap();
    let merge = || {
        ledger
            .list()
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap()
            .merge
    };
    // The queue cannot save (a folder where its file goes): the yes is recorded, the card is not removed.
    fs::remove_file(home.join("queue.json")).unwrap();
    fs::create_dir(home.join("queue.json")).unwrap();
    let r = core.answer(&id, queue::Answer::AllowOnce, true);
    assert!(r.is_err(), "{r:?}");
    assert!(core.queue.owner_decision(&id).is_some(), "the card stays");
    assert!(merge().is_none(), "the yes goes with the card kept");
    fs::remove_dir(home.join("queue.json")).unwrap();
    // A yes the take-back could not clear: the owner's no clears it.
    ledger.merge_ok(&task.id, "b688c42", 2).unwrap();
    let r = core.answer(&id, queue::Answer::Deny, true);
    assert!(matches!(r, Ok(Reply::Ack)), "{r:?}");
    assert!(core.queue.owner_decision(&id).is_none(), "the card is gone");
    assert!(merge().is_none(), "no yes left for a resumed lead");
    let _ = fs::remove_dir_all(home);
}
fn two_shells(name: &str) -> (Sessions, PathBuf, String, String) {
    let home = scratch(name);
    let mut core = Sessions::open(&home).unwrap();
    let mut ids = vec![];
    for label in ["target", "sender"] {
        let mut launch = core
            .launch(StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.clone(),
                worktree: false,
                label: label.into(),
                args: vec!["/bin/cat".into()],
                model: None,
                effort: None,
                resume: None,
            })
            .prepare()
            .unwrap();
        ids.push(core.start(&launch).unwrap().id);
        launch.committed = true;
    }
    let sender = ids.pop().unwrap();
    (core, home, ids.pop().unwrap(), sender)
}
fn queued(core: &mut Sessions, sender: &str, target: &str) -> crate::delivery::Send {
    core.begin_send(sender, target, "hi".into(), vec![], false, "queued")
        .unwrap()
}
fn status_of(core: &Sessions, target: &str, send: &str) -> String {
    let meta = &core.entries[target].meta;
    meta.send_queue
        .iter()
        .chain(&meta.send_log)
        .find(|s| s.id == send)
        .unwrap()
        .status
        .clone()
}
fn finish(mut core: Sessions, home: PathBuf) {
    let _ = core.handle(Request::Stop);
    drop(core);
    let _ = fs::remove_dir_all(home);
}
#[test]
fn remote_flag_is_stamped_at_queue_time() {
    let (mut core, home, target, sender) = two_shells("stamp76");
    core.grants.remote.insert("peer".into());
    assert_eq!(queued(&mut core, "peer", &target).remote, Some(true));
    assert_eq!(queued(&mut core, &sender, &target).remote, Some(false));
    let user = queued(&mut core, "user", &target);
    assert_eq!(user.remote, None);
    assert!(!serde_json::to_string(&user).unwrap().contains("remote"));
    finish(core, home);
}
#[test]
fn queued_send_keeps_remote_flag_through_flush() {
    // (a) a local sender stays local although a peer later forwards under the same id.
    let (mut core, home, target, sender) = two_shells("sticky76a");
    let send = queued(&mut core, &sender, &target);
    core.grants.remote.insert(sender.clone());
    core.flush_delivery().unwrap();
    assert_ne!(status_of(&core, &target, &send.id), "canceled");
    // (b) a remote-stamped send is held to the V1A-04 rule although the lasting set is empty.
    core.grants.remote.clear();
    core.grants.remote.insert(sender.clone());
    let held = queued(&mut core, &sender, &target);
    core.grants.remote.clear();
    core.flush_delivery().unwrap();
    assert_eq!(status_of(&core, &target, &held.id), "canceled");
    finish(core, home);
}
#[test]
fn local_stamp_not_satisfied_by_peer_forward() {
    // A local sender queues and exits; a peer then forwards under the same id. As on base, the send is canceled.
    let (mut core, home, target, sender) = two_shells("peerfwd76");
    let send = queued(&mut core, &sender, &target);
    assert_eq!(send.remote, Some(false));
    core.handle(Request::Close { id: sender.clone() }).unwrap();
    core.remote.callers.insert(
        sender.clone(),
        crate::machines::Caller {
            id: sender.clone(),
            project: home.clone(),
            permission_answers: false,
        },
    );
    core.flush_delivery().unwrap();
    assert_eq!(status_of(&core, &target, &send.id), "canceled");
    finish(core, home);
}
#[test]
fn closed_logout_entry_pruned() {
    let (mut core, home, target, _) = two_shells("prune76");
    core.handle(Request::Close { id: target.clone() }).unwrap();
    let live = core.entries.keys().find(|k| **k != target).unwrap().clone();
    let file = serde_json::json!({"version": 1, "logouts": {
        "/closed": target, "/gone": "no-such-tab", "/live": live,
    }});
    fs::write(home.join("logouts.json"), file.to_string()).unwrap();
    drop(core);
    let core = Sessions::open(&home).unwrap();
    assert_eq!(
        core.logouts.keys().collect::<Vec<_>>(),
        vec![Path::new("/live")]
    );
    finish(core, home);
}
/// Ticket 1090: closing a seat takes away the owner cards that are its alone (a stall card on its check-in, a Codex
/// reset it asked for) and its questions leave Decisions; the task's merge card stays. Replacing the seat (close, then
/// another seat on the task) leaves no card of the old one, and the other seat's card stays until that seat ends.
#[test]
fn seat_close_withdraws_its_own_cards() {
    let (mut core, home, old, other) = two_shells("seat-cards-1090");
    let stall = |task: &str, seat: &str| queue::OwnerAsk::Stall {
        task: task.into(),
        title: "fig".into(),
        place: home.clone(),
        seat: seat.into(),
        error: None,
    };
    let reset = queue::OwnerAsk::CodexReset {
        folder: None,
        account: "Your own".into(),
        reason: "limit".into(),
    };
    let merge = queue::OwnerAsk::Merge {
        task: "t1".into(),
        title: "fig".into(),
        place: home.clone(),
        revision: "b688c42".into(),
        learned: vec![],
    };
    core.queue.ask_owner(&old, stall("t1", "Builder")).unwrap();
    core.queue.ask_owner(&old, reset).unwrap();
    core.queue.ask_owner("lead", merge).unwrap();
    core.queue
        .ask_owner(&other, stall("t2", "Reviewer"))
        .unwrap();
    core.queue
        .observe(
            &old,
            "PermissionRequest",
            &serde_json::json!({}),
            "hook",
            200,
        )
        .unwrap();
    let kinds = |core: &Sessions| {
        let mut k: Vec<_> = core
            .queue
            .owner_items()
            .into_iter()
            .map(|i| match i.owner {
                Some(queue::OwnerAsk::Stall { task, .. }) => format!("stall {task}"),
                Some(queue::OwnerAsk::CodexReset { .. }) => "reset".into(),
                Some(queue::OwnerAsk::Merge { task, .. }) => format!("merge {task}"),
                other => panic!("unexpected card {other:?}"),
            })
            .collect();
        k.sort();
        k
    };
    assert_eq!(kinds(&core), ["merge t1", "reset", "stall t1", "stall t2"]);
    assert!(
        !core.queue.items_of(&old).is_empty(),
        "the permission is asked"
    );
    core.handle(Request::Close { id: old.clone() }).unwrap();
    assert_eq!(kinds(&core), ["merge t1", "stall t2"], "closed seat");
    assert!(
        core.queue.items_of(&old).iter().all(|i| !i.actionable),
        "its permission leaves Decisions"
    );
    // The other seat ends (its process is gone): its stall card goes too; the task's merge card stays.
    let pid = core.entries[&other].meta.pid.unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while core.entries[&other].meta.state == SessionState::Running {
        assert!(std::time::Instant::now() < until, "seat did not end");
        std::thread::sleep(std::time::Duration::from_millis(20));
        core.refresh().unwrap();
    }
    assert_eq!(kinds(&core), ["merge t1"], "ended seat");
    finish(core, home);
}
#[test]
fn queued_send_without_flag_is_refused_at_flush() {
    let (mut core, home, target, sender) = two_shells("noflag76");
    let mut send = queued(&mut core, &sender, &target);
    send.remote = None;
    core.entry(&target)
        .unwrap()
        .meta
        .send_queue
        .last_mut()
        .unwrap()
        .remote = None;
    // A row written before the field existed has none either.
    let old = r#"{"id":"o","sender":"x","at":0,"content":"c","keys":[],"submit":false,"status":"queued"}"#;
    assert_eq!(
        serde_json::from_str::<crate::delivery::Send>(old)
            .unwrap()
            .remote,
        None
    );
    core.flush_delivery().unwrap();
    assert_eq!(status_of(&core, &target, &send.id), "canceled");
    let user = queued(&mut core, "user", &target);
    core.flush_delivery().unwrap();
    assert_ne!(status_of(&core, &target, &user.id), "canceled");
    finish(core, home);
}
// Ticket 300: `n` sends of 2 KB queued to `target` (alternately from `senders[0]` and `senders[1]`) under one save
// (a `begin_send` saves each, seconds for 500).
fn queue_many(
    core: &mut Sessions,
    target: &str,
    senders: [&str; 2],
    n: usize,
) -> Vec<crate::delivery::Send> {
    let rows = senders.map(|sender| {
        let mut row = queued(core, sender, target);
        row.content = "x".repeat(2048);
        core.entry(target).unwrap().meta.send_queue.pop();
        row
    });
    let sends: Vec<_> = (0..n)
        .map(|i| crate::delivery::Send {
            id: crate::store::new_id().unwrap(),
            at: rows[i % 2].at + i as u64,
            ..rows[i % 2].clone()
        })
        .collect();
    let meta = &mut core.entry(target).unwrap().meta;
    meta.send_queue.extend(sends.iter().cloned());
    core.save().unwrap();
    sends
}
// Ticket 300: two shells, `n` sends queued to `target` (from the user and from `sender`), and `target`'s agent has
// exited on its own: the refresh that saw it saved the row, so the next flush only has the queue to cancel.
fn exited_with_queue(
    name: &str,
    n: usize,
) -> (
    Sessions,
    PathBuf,
    String,
    String,
    Vec<crate::delivery::Send>,
) {
    let (mut core, home, target, sender) = two_shells(name);
    let sends = queue_many(&mut core, &target, ["user", &sender], n);
    let pid = core.entries[&target].meta.pid.unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while core.entries[&target].meta.state == SessionState::Running {
        assert!(std::time::Instant::now() < until, "agent did not exit");
        std::thread::sleep(std::time::Duration::from_millis(20));
        core.refresh().unwrap();
    }
    (core, home, target, sender, sends)
}
fn queue_of(core: &Sessions, id: &str) -> Vec<(String, String)> {
    core.entries[id]
        .meta
        .send_queue
        .iter()
        .map(|s| (s.id.clone(), s.status.clone()))
        .collect()
}
/// Saves, rows an exit cancel walked, and snapshots, so far.
fn lock_work(core: &Sessions) -> [usize; 3] {
    use std::sync::atomic::Ordering::SeqCst;
    [&core.saves, &core.exit_walked, &core.snapshots].map(|c| c.load(SeqCst))
}
fn since(before: [usize; 3], core: &Sessions) -> [usize; 3] {
    let after = lock_work(core);
    [0, 1, 2].map(|i| after[i] - before[i])
}
// Ticket 300 step 2: an ended session's cancel walks its own queue and no other session's (like herdr's pane input
// queue, closed by its own pane); another session's queued sends stay as they were.
#[test]
fn exit_walks_only_own_queue() {
    let (mut core, home, target, other, _) = exited_with_queue("walk300", 50);
    queue_many(&mut core, &other, ["user", "user"], 50);
    // The other agent is mid-turn, so nothing is typed into it this tick.
    core.delivery_inflight.insert(other.clone(), u64::MAX);
    let before = (queue_of(&core, &other), lock_work(&core));
    core.flush_delivery().unwrap();
    assert_eq!(since(before.1, &core)[1], 50);
    assert_eq!(queue_of(&core, &other), before.0);
    assert!(core.entries[&target].meta.send_queue.is_empty());
    finish(core, home);
}
/// Q9 psn-J4-1: a side chat whose close fails as its parent's agent ends (here its hooks file cannot be removed)
/// is logged; the refresh that saw the end, and so the request that ran it, still answers.
#[test]
fn a_side_chat_close_that_fails_does_not_fail_refresh() {
    let (mut core, home, side, parent) = two_shells("sidefail");
    let entry = core.entries.get_mut(&side).unwrap();
    entry.meta.side_chat = true;
    entry.meta.side_parent = Some(parent.clone());
    let hooks = home.join(format!("hooks-{side}.json"));
    let _ = fs::remove_file(&hooks);
    fs::create_dir(&hooks).unwrap(); // `remove_file` refuses a folder
    let pid = core.entries[&parent].meta.pid.unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while core.entries[&parent].meta.state == SessionState::Running {
        assert!(std::time::Instant::now() < until, "parent did not exit");
        std::thread::sleep(std::time::Duration::from_millis(20));
        core.refresh().unwrap();
    }
    assert_eq!(core.entries[&side].meta.state, SessionState::Closed);
    fs::remove_dir(&hooks).unwrap();
    finish(core, home);
}
// S9: with seen marks the board reads every row. Past the idle clock an unchanged board reads from the row cache
// and builds no row; each field the board (and its rights check) reads moves the key and rebuilds.
#[test]
fn idle_board_builds_rows_once() {
    let (mut core, home, target, other) = two_shells("s9board");
    for id in [&target, &other] {
        let id = id.clone();
        assert!(
            core.handle(Request::BoardSeen {
                id,
                completion_seq: 0
            })
            .is_ok()
        );
    }
    let snapshots = |core: &Sessions| core.snapshots.load(std::sync::atomic::Ordering::SeqCst);
    core.observe_board();
    let mut built = snapshots(&core);
    assert!(built >= 2, "the board did not read the rows");
    for _ in 0..5 {
        core.board_observed = None; // past the idle clock: the board reads, from the cache
        core.observe_board();
    }
    assert_eq!(
        snapshots(&core),
        built,
        "an unchanged board read built rows again"
    );
    let moves: [fn(&mut Session, &str); 4] = [
        |m, _| m.label = "moved".into(),
        |m, other| m.parent = Some(other.into()),
        |m, _| m.project = m.project.join("sub"),
        |m, _| m.state = SessionState::Exited,
    ];
    for (n, change) in moves.into_iter().enumerate() {
        change(&mut core.entry(&target).unwrap().meta, &other);
        core.board_observed = None;
        core.observe_board();
        assert_eq!(snapshots(&core), built + 2, "move {n} was not seen");
        built += 2;
    }
    finish(core, home);
}
fn send_clones(core: &Sessions) -> usize {
    core.send_clones.load(std::sync::atomic::Ordering::SeqCst)
}
// V2.5-85: a tick in which every agent with a queue is mid-turn delivers nothing and copies no queued row (the
// tick runs every 50 ms; it copied every session's whole queue).
#[test]
fn idle_tick_clones_no_sends() {
    let (mut core, home, target, sender) = two_shells("idle85");
    queue_many(&mut core, &target, ["user", &sender], 30);
    queue_many(&mut core, &sender, ["user", "user"], 30);
    for id in [&target, &sender] {
        core.delivery_inflight.insert(id.clone(), u64::MAX);
    }
    let before = [queue_of(&core, &target), queue_of(&core, &sender)];
    core.flush_delivery().unwrap();
    assert_eq!(send_clones(&core), 0);
    assert_eq!([queue_of(&core, &target), queue_of(&core, &sender)], before);
    finish(core, home);
}
// V2.5-85: a session held by a model switch or a mode walk is skipped before its rows are read; the ready session
// beside it still gets its one send, and only that row is copied (to write it).
#[test]
fn held_session_queue_not_cloned() {
    for hold in ["switch", "walk"] {
        let (mut core, home, target, sender) = two_shells(&format!("held85-{hold}"));
        queue_many(&mut core, &target, ["user", "user"], 30);
        let ready = queued(&mut core, "user", &sender);
        let now = std::time::Instant::now();
        let entry = core.entry(&target).unwrap();
        if hold == "switch" {
            entry.switch = Some(Switch {
                send: String::new(),
                model: None,
                effort: None,
                confirming: false,
                keys: 0,
                sent: now,
                seen: 0,
                last: 0,
                quiet: now,
                before: String::new(),
            });
        } else {
            entry.skip_hold = Some(SkipHold {
                unreadable_since: None,
            });
        }
        let before = queue_of(&core, &target);
        core.flush_delivery().unwrap();
        assert_eq!(status_of(&core, &sender, &ready.id), "delivered", "{hold}");
        assert_eq!(send_clones(&core), 1, "{hold}");
        assert_eq!(queue_of(&core, &target), before, "{hold}");
        finish(core, home);
    }
}
// V2-8e with V2.5-85: a deny note is kept while its send is queued (here behind a model switch) and dropped once
// the send left the queue.
#[test]
fn deny_note_dropped_when_send_left_queue() {
    let (mut core, home, target, _) = two_shells("note85");
    let held = queued(&mut core, "user", &target);
    let now = std::time::Instant::now();
    core.entry(&target).unwrap().switch = Some(Switch {
        send: String::new(),
        model: None,
        effort: None,
        confirming: false,
        keys: 0,
        sent: now,
        seen: 0,
        last: 0,
        quiet: now,
        before: String::new(),
    });
    core.deny_notes.extend([held.id.clone(), "gone".into()]);
    core.flush_delivery().unwrap();
    assert_eq!(core.deny_notes, [held.id.clone()].into());
    core.entry(&target).unwrap().switch = None;
    core.mark_send(&target, &held.id, "canceled").unwrap();
    core.flush_delivery().unwrap();
    assert!(core.deny_notes.is_empty());
    finish(core, home);
}
// V2.5-85: across ticks a session's sends go out one per tick in queue order; a row whose sender may not send is
// canceled where the walk meets it; an ended session's queue is canceled whole and never typed.
#[test]
fn flush_delivery_order_unchanged() {
    let (mut core, home, ended, live, ended_sends) = exited_with_queue("order85", 6);
    // A sender with no running session and a local stamp: refused at flush.
    let ghost = |core: &mut Sessions| {
        queued(core, "user", &live);
        let row = core
            .entry(&live)
            .unwrap()
            .meta
            .send_queue
            .last_mut()
            .unwrap();
        (row.sender, row.remote) = ("ghost".into(), Some(false));
        row.clone()
    };
    let rows = [
        queued(&mut core, "user", &live),
        ghost(&mut core),
        queued(&mut core, "user", &live),
        queued(&mut core, "user", &live),
        ghost(&mut core),
        queued(&mut core, "user", &live),
    ];
    for _ in 0..rows.len() {
        core.delivery_inflight.clear();
        core.flush_delivery().unwrap();
    }
    let log = |status: &str, id: &str| -> Vec<String> {
        core.entries[id]
            .meta
            .send_log
            .iter()
            .filter(|s| s.status == status)
            .map(|s| s.id.clone())
            .collect()
    };
    let ids = |idx: &[usize]| idx.iter().map(|&i| rows[i].id.clone()).collect::<Vec<_>>();
    assert_eq!(log("delivered", &live), ids(&[0, 2, 3, 5]));
    assert_eq!(log("canceled", &live), ids(&[1, 4]));
    assert!(core.entries[&live].meta.send_queue.is_empty());
    let ended_ids: Vec<_> = ended_sends.iter().map(|s| s.id.clone()).collect();
    assert_eq!(log("canceled", &ended), ended_ids);
    assert!(log("delivered", &ended).is_empty());
    assert!(core.entries[&ended].meta.send_queue.is_empty());
    finish(core, home);
}
fn as_json(sends: &[crate::delivery::Send]) -> Vec<serde_json::Value> {
    sends
        .iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect()
}
// Ticket 300 twin (V2.5-85): the step that retires a send has one definition, so a change to it cannot reach
// `mark_send` and miss the exit cancel.
#[test]
fn cancel_own_queue_uses_shared_retire() {
    let source = include_str!("../sessions.rs");
    // shortcut: a body ends at its first 4-space `}` line and a comment naming a step fails it; parse with syn if
    // these methods move into an impl block of their own.
    let body = |name: &str| {
        let start = source.find(&format!("fn {name}(")).unwrap();
        &source[start..start + source[start..].find("\n    }\n").unwrap()]
    };
    for name in ["cancel_own_queue", "mark_send"] {
        let body = body(name);
        assert!(body.contains("retire_send("), "{name}");
        for step in ["send_log", "widget_hashes.remove", "cap_log"] {
            assert!(!body.contains(step), "{name} repeats {step}");
        }
    }
    assert_eq!(source.matches(concat!("fn ", "retire_send(")).count(), 1);
}
// Ticket 300 twin: an exit cancels the queued rows in queue order and drops their widget hashes; a row still
// attempting stays with its hash; a row `mark_send` cancels is logged the same way.
#[test]
fn exit_cancel_rows_match_mark_send() {
    let (mut core, home, target, _, sends) = exited_with_queue("match300", 4);
    core.entry(&target).unwrap().meta.send_queue[1].status = "attempting".into();
    for send in &sends {
        core.widget_hashes.insert(send.id.clone(), "hash".into());
    }
    core.flush_delivery().unwrap();
    let mut want: Vec<_> = [0, 2, 3]
        .map(|i| crate::delivery::Send {
            status: "canceled".into(),
            ..sends[i].clone()
        })
        .into();
    let meta = &core.entries[&target].meta;
    assert_eq!(as_json(&meta.send_log), as_json(&want));
    assert_eq!(
        queue_of(&core, &target),
        [(sends[1].id.clone(), "attempting".into())]
    );
    assert_eq!(
        core.widget_hashes.keys().collect::<Vec<_>>(),
        [&sends[1].id]
    );
    core.mark_send(&target, &sends[1].id, "canceled").unwrap();
    want.push(crate::delivery::Send {
        status: "canceled".into(),
        ..sends[1].clone()
    });
    assert_eq!(
        as_json(&core.entries[&target].meta.send_log),
        as_json(&want)
    );
    assert!(core.widget_hashes.is_empty());
    finish(core, home);
}
// Ticket 300 twin, threat: a send retired under the wrong session. `mark_send` finds the row in the named
// session's queue only, and retiring it leaves the other session's queue, log and widget hash as they were.
#[test]
fn retire_step_never_crosses_sessions() {
    let (mut core, home, target, other) = two_shells("cross300");
    let send = queued(&mut core, "user", &target);
    let kept = queued(&mut core, "user", &other);
    for id in [&send.id, &kept.id] {
        core.widget_hashes.insert(id.clone(), "hash".into());
    }
    assert_eq!(
        core.mark_send(&other, &send.id, "canceled"),
        Err("send not found".into())
    );
    assert_eq!(status_of(&core, &target, &send.id), "queued");
    core.mark_send(&target, &send.id, "delivered").unwrap();
    assert_eq!(status_of(&core, &target, &send.id), "delivered");
    assert_eq!(
        queue_of(&core, &other),
        [(kept.id.clone(), "queued".into())]
    );
    assert!(core.entries[&other].meta.send_log.is_empty());
    assert_eq!(core.widget_hashes.keys().collect::<Vec<_>>(), [&kept.id]);
    finish(core, home);
}
// Ticket 300 twin, threat: an exit drops another session's queued answer. The other session's queue, log and
// widget hashes are untouched by the exited session's cancel.
#[test]
fn exit_retire_keeps_other_sessions_queue() {
    let (mut core, home, target, other, _) = exited_with_queue("keep300", 3);
    let theirs = queue_many(&mut core, &other, ["user", "user"], 3);
    core.widget_hashes
        .insert(theirs[1].id.clone(), "hash".into());
    core.delivery_inflight.insert(other.clone(), u64::MAX);
    let before = queue_of(&core, &other);
    core.flush_delivery().unwrap();
    assert_eq!(queue_of(&core, &other), before);
    assert!(core.entries[&other].meta.send_log.is_empty());
    assert_eq!(
        core.widget_hashes.keys().collect::<Vec<_>>(),
        [&theirs[1].id]
    );
    assert_eq!(core.entries[&target].meta.send_log.len(), 3);
    finish(core, home);
}
// Ticket 300: what the exit pass does under the registry lock, counted rather than timed (a 100 ms bound missed by
// 4 ms under gate load): one save, the exited session's own rows, one snapshot of the other session (its readiness).
// Then the lock is free: the other session's hook, a registry call and a cancel of its pending send are answered,
// and that send was neither dropped nor delivered.
#[test]
fn exit_does_not_block_other_sessions_lock_hold() {
    let (mut core, home, _, other, _) = exited_with_queue("exitlock300", 50);
    let pending = queued(&mut core, "user", &other);
    core.delivery_inflight.insert(other.clone(), u64::MAX);
    let registry = std::sync::Mutex::new(core);
    let (locked, held) = std::sync::mpsc::channel();
    let held_work = std::thread::scope(|scope| {
        let flush = scope.spawn(|| {
            let mut core = registry.lock().unwrap();
            locked.send(()).unwrap();
            let before = lock_work(&core);
            core.flush_delivery().unwrap();
            since(before, &core)
        });
        held.recv().unwrap();
        let hook = registry.lock().unwrap().handle(Request::Hook {
            id: other.clone(),
            event: "Notification".into(),
            payload: serde_json::json!({"message": "probe"}),
        });
        assert!(hook.is_ok(), "{hook:?}");
        let get = registry
            .lock()
            .unwrap()
            .handle(Request::AgentGet { id: other.clone() });
        assert!(matches!(get, Ok(Reply::Agent { .. })), "{get:?}");
        flush.join().unwrap()
    });
    assert_eq!(held_work, [1, 50, 1], "saves, rows walked, snapshots");
    let mut core = registry.into_inner().unwrap();
    assert_eq!(status_of(&core, &other, &pending.id), "queued");
    let cancel = core.handle(Request::CancelSend {
        id: other.clone(),
        send: pending.id.clone(),
    });
    assert!(matches!(cancel, Ok(Reply::Ack)), "{cancel:?}");
    finish(core, home);
}
// Ticket 300: the exit pass costs one row walked per pending send, one save and no snapshot, at 50 and at 500 (the
// step 1 measure was 16 ms and 89 ms under the lock; the time is printed, not bounded).
#[test]
fn exit_hold_scales_linearly() {
    for n in [50, 500] {
        let (mut core, home, target, _, _) = exited_with_queue(&format!("linear300-{n}"), n);
        let before = lock_work(&core);
        let t = std::time::Instant::now();
        core.flush_delivery().unwrap();
        eprintln!("exit pass with {n} pending sends: {:?}", t.elapsed());
        assert_eq!(since(before, &core), [1, n, 0], "n = {n}");
        assert!(core.entries[&target].meta.send_queue.is_empty());
        finish(core, home);
    }
}
// Ticket 300 step 2: session A exits with 500 queued sends while session B sends. All sessions share one registry
// lock, so B's send waits for A's exit pass; this bounds that wait, it does not remove it. Counted (load-proof): A's
// pass is one save and A's own 500 rows, and no snapshot (B has no queued row yet). Timed: what A's pass adds to B,
// the wait from B's request until B holds the lock, stays under 100 ms in the best of 3 attempts. B's whole delivery
// (that wait plus B's own send and delivery passes) is printed, not bounded tightly: under the sessions+queue run at
// load 10 it took 74-157 ms, mostly B's own saves. Core path only, debug build: the app adds up to one 50 ms tick.
#[test]
fn exit_with_500_sends_bounds_other_send_wait() {
    let mut best = std::time::Duration::MAX;
    for attempt in 0..3 {
        let (core, home, target, other, _) = exited_with_queue(&format!("bwait300-{attempt}"), 500);
        let registry = std::sync::Mutex::new(core);
        let (locked, held) = std::sync::mpsc::channel();
        let (go, start) = std::sync::mpsc::channel();
        let (waited, took, work) = std::thread::scope(|scope| {
            let registry = &registry;
            let exit = scope.spawn(move || {
                let mut core = registry.lock().unwrap();
                locked.send(()).unwrap();
                // A's pass starts only after B's clock does, so the whole pass is inside B's measure.
                start.recv().unwrap();
                let before = lock_work(&core);
                core.flush_delivery().unwrap();
                since(before, &core)
            });
            held.recv().unwrap();
            let t = std::time::Instant::now();
            go.send(()).unwrap();
            let mut core = registry.lock().unwrap();
            let waited = t.elapsed();
            let reply = core.handle(Request::AgentSend {
                id: other.clone(),
                text: "b".into(),
            });
            drop(core);
            let Ok(Reply::Delivery { send }) = reply else {
                panic!("{reply:?}")
            };
            loop {
                let mut core = registry.lock().unwrap();
                if status_of(&core, &other, &send.id) == "delivered" {
                    break;
                }
                assert!(
                    t.elapsed() < std::time::Duration::from_secs(5),
                    "B's send was never delivered"
                );
                core.flush_delivery().unwrap();
            }
            let took = t.elapsed();
            (waited, took, exit.join().unwrap())
        });
        eprintln!(
            "attempt {attempt}: B waited {waited:?} for the lock, delivered {took:?} after the request, A canceling 500"
        );
        assert_eq!(
            work,
            [1, 500, 0],
            "saves, rows walked, snapshots in A's exit pass"
        );
        let core = registry.into_inner().unwrap();
        assert!(core.entries[&target].meta.send_queue.is_empty());
        // The log keeps only its newest rows (`cap_log`).
        let log = &core.entries[&target].meta.send_log;
        assert!(!log.is_empty() && log.iter().all(|s| s.status == "canceled"));
        finish(core, home);
        best = best.min(waited);
    }
    assert!(
        best < std::time::Duration::from_millis(100),
        "B's wait behind A's exit pass, best of 3: {best:?}"
    );
}
// Ticket 300 (review SHOULD 1): a running session's queue is not copied once per queued send; its readiness is
// read once per pass, while each send's own check (here a row without the ticket 76 flag) still runs.
#[test]
fn delivery_loop_clones_only_used_fields() {
    let (mut core, home, target, sender) = two_shells("clones300");
    let sends = queue_many(&mut core, &target, ["user", &sender], 50);
    core.entry(&target).unwrap().meta.send_queue[25].remote = None;
    core.delivery_inflight.insert(target.clone(), u64::MAX);
    let before = lock_work(&core);
    core.flush_delivery().unwrap();
    assert_eq!(since(before, &core)[2], 1);
    for (n, send) in sends.iter().enumerate() {
        let want = if n == 25 { "canceled" } else { "queued" };
        assert_eq!(status_of(&core, &target, &send.id), want, "send {n}");
    }
    finish(core, home);
}
// Ticket 300: what step 1 kept, still so: a running session takes its queued sends one per tick in queue order,
// and an unauthorised row among them is canceled without moving the others.
#[test]
fn exit_lock_step1_behaviour_unchanged() {
    let (mut core, home, target, sender) = two_shells("order300");
    let mut sends: Vec<_> = (0..3).map(|_| queued(&mut core, "user", &target)).collect();
    let stray = queued(&mut core, &sender, &target);
    core.entry(&target).unwrap().meta.send_queue[3].remote = None;
    sends.push(queued(&mut core, "user", &target));
    let mut want: Vec<_> = sends
        .iter()
        .map(|s| (s.id.clone(), "delivered".to_string()))
        .collect();
    want.insert(3, (stray.id.clone(), "canceled".into()));
    // One send per tick; the fourth tick cancels the stray and delivers the send behind it.
    for logged in [1, 2, 3, 5] {
        core.flush_delivery().unwrap();
        let log: Vec<_> = core.entries[&target]
            .meta
            .send_log
            .iter()
            .map(|s| (s.id.clone(), s.status.clone()))
            .collect();
        assert_eq!(log, want[..logged]);
    }
    finish(core, home);
}
// Ticket 300: an exited agent's queue is canceled in one pass under one save (each save syncs the file twice;
// fifty of them held the registry lock long enough for hooks to time out).
#[test]
fn exit_cancels_all_pending_sends_with_one_save() {
    use std::sync::atomic::Ordering::SeqCst;
    let (mut core, home, target, _, sends) = exited_with_queue("exit300", 50);
    core.widget_hashes
        .insert(sends[7].id.clone(), "hash".into());
    let before = core.saves.load(SeqCst);
    core.flush_delivery().unwrap();
    assert_eq!(core.saves.load(SeqCst) - before, 1);
    assert!(core.widget_hashes.is_empty());
    let want: Vec<_> = sends.iter().map(|s| (s.id.clone(), "canceled")).collect();
    let saved = crate::store::load_live(&home).unwrap().0;
    for meta in [
        &saved.iter().find(|s| s.id == target).unwrap().clone(),
        &core.entries[&target].meta,
    ] {
        assert!(meta.send_queue.is_empty());
        let log: Vec<_> = meta
            .send_log
            .iter()
            .map(|s| (s.id.clone(), s.status.as_str()))
            .collect();
        assert_eq!(log, want);
    }
    // Threat: a canceled send left the queue for good; nothing can answer or deliver it, even if the agent runs again.
    core.entry(&target).unwrap().meta.state = SessionState::Running;
    core.flush_delivery().unwrap();
    let reply = core.handle(Request::CancelSend {
        id: target.clone(),
        send: sends[0].id.clone(),
    });
    assert!(reply.is_err(), "{reply:?}");
    assert!(
        core.entries[&target]
            .meta
            .send_log
            .iter()
            .all(|s| s.status == "canceled")
    );
    finish(core, home);
}
// Ticket 999: the tick that sees an agent exit with sends queued saves once (the exited row, the cancel and the
// second pass together): each save is two F_FULLFSYNCs under the registry lock, and every other request waits.
#[test]
fn exit_tick_saves_once() {
    use std::sync::atomic::Ordering::SeqCst;
    let (mut core, home, target, sender) = two_shells("exit999");
    let sends = queue_many(&mut core, &target, ["user", &sender], 20);
    core.delivery_inflight.insert(target.clone(), u64::MAX); // held while it runs: no tick delivers one
    let pid = core.entries[&target].meta.pid.unwrap();
    let before = core.saves.load(SeqCst);
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while core.entries[&target].meta.state == SessionState::Running {
        assert!(std::time::Instant::now() < until, "agent did not exit");
        std::thread::sleep(std::time::Duration::from_millis(20));
        core.tick().unwrap();
    }
    assert_eq!(core.saves.load(SeqCst) - before, 1);
    // On disk when the tick returns: the row has ended and every send is canceled, none left queued.
    let saved = crate::store::load_live(&home).unwrap().0;
    let meta = saved.iter().find(|s| s.id == target).unwrap();
    assert_ne!(meta.state, SessionState::Running);
    assert!(meta.send_queue.is_empty());
    assert_eq!(meta.send_log.len(), sends.len());
    assert!(meta.send_log.iter().all(|s| s.status == "canceled"));
    finish(core, home);
}
// Ticket 999 round 2: a pass whose one save failed keeps its changes marked unsaved; the next tick writes them.
#[test]
fn exit_tick_save_failure_is_retried() {
    let (mut core, home, target, sender) = two_shells("exit999r");
    let sends = queue_many(&mut core, &target, ["user", &sender], 5);
    core.delivery_inflight.insert(target.clone(), u64::MAX);
    // sessions.json cannot be written (a folder where its file goes).
    fs::remove_file(home.join("sessions.json")).unwrap();
    fs::create_dir(home.join("sessions.json")).unwrap();
    let pid = core.entries[&target].meta.pid.unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut ticked = Ok(());
    while core.entries[&target].meta.state == SessionState::Running {
        assert!(std::time::Instant::now() < until, "agent did not exit");
        std::thread::sleep(std::time::Duration::from_millis(20));
        ticked = core.tick();
    }
    assert!(ticked.is_err(), "the exit tick's save failed");
    assert!(core.unsaved.load(std::sync::atomic::Ordering::SeqCst));
    fs::remove_dir(home.join("sessions.json")).unwrap();
    core.tick().unwrap(); // nothing new changed: only the mark brings the save
    let saved = crate::store::load_live(&home).unwrap().0;
    let meta = saved.iter().find(|s| s.id == target).unwrap();
    assert_ne!(meta.state, SessionState::Running);
    assert!(meta.send_queue.is_empty());
    assert_eq!(meta.send_log.len(), sends.len());
    assert!(meta.send_log.iter().all(|s| s.status == "canceled"));
    finish(core, home);
}
#[test]
fn logouts_file_bad_is_empty_and_counted() {
    let home = scratch("logouts76");
    let open = |home: &Path| Sessions::open(home).unwrap();
    assert_eq!(open(&home).recovery_warnings, 0);
    for bad in ["{not json", r#"{"version":2,"logouts":{"/a":"t"}}"#] {
        fs::write(home.join("logouts.json"), bad).unwrap();
        let core = open(&home);
        assert!(core.logouts.is_empty(), "{bad}");
        assert_eq!(core.recovery_warnings, 1, "{bad}");
    }
    let mut core = open(&home);
    core.logout_mark(Path::new("/a"), "t");
    let file = fs::read_to_string(home.join("logouts.json")).unwrap();
    assert!(file.contains(r#""/a":"t""#), "{file}");
    core.logout_clear(Path::new("/a"));
    let file = fs::read_to_string(home.join("logouts.json")).unwrap();
    assert!(!file.contains("/a"), "{file}");
    let _ = fs::remove_dir_all(home);
}
fn scratch(name: &str) -> PathBuf {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("{name}-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    fs::canonicalize(home).unwrap()
}

// Ticket 276: settings with `extensions.enabled` set (None = absent).
fn ext_settings(on: Option<&[&str]>) -> Settings {
    let mut s = Settings::default();
    if let Some(on) = on {
        s.features
            .insert(crate::extensions::ENABLED_KEY.into(), serde_json::json!(on));
    }
    s
}
fn flag_strings(home: &Path, s: &Settings, kind: AgentKind) -> Vec<String> {
    extension_flags(home, s, kind, false, Path::new("/p"))
        .unwrap()
        .into_iter()
        .map(|o| o.into_string().unwrap())
        .collect()
}

#[test]
fn default_and_custom_skill_toggle_reaches_next_session_launch() {
    let home = scratch("ext-toggle");
    let _ = fs::remove_dir_all(home.join("extensions"));
    fs::create_dir_all(home.join("extensions/lint-hook/hooks")).unwrap();
    let custom = home
        .join("extensions/lint-hook")
        .to_string_lossy()
        .into_owned();
    // Absent: the shipped skill alone; a folder dropped in stays off (same-user threat).
    let flags = flag_strings(&home, &ext_settings(None), AgentKind::Claude);
    assert_eq!(
        flags.iter().filter(|f| *f == "--plugin-dir").count(),
        1,
        "{flags:?}"
    );
    assert!(
        !flags.contains(&custom),
        "a new folder is off until the owner turns it on"
    );
    // The owner turns the custom one on: the next launch carries it.
    let flags = flag_strings(
        &home,
        &ext_settings(Some(&["nunchiro", "custom:lint-hook"])),
        AgentKind::Claude,
    );
    assert_eq!(
        flags.iter().filter(|f| *f == "--plugin-dir").count(),
        2,
        "{flags:?}"
    );
    assert!(flags.contains(&custom));
    // The default switched off: no Nunchiro plugin for Claude, no guide pointer for Codex.
    let mut s = ext_settings(Some(&["custom:lint-hook"]));
    assert_eq!(
        flag_strings(&home, &s, AgentKind::Claude),
        ["--plugin-dir".to_string(), custom.clone()]
    );
    s.orchestration.enabled = true;
    assert!(flag_strings(&home, &s, AgentKind::Codex).is_empty());
    let on = ext_settings(Some(&["nunchiro"]));
    let mut on_orch = on.clone();
    on_orch.orchestration.enabled = true;
    assert_eq!(
        flag_strings(&home, &on_orch, AgentKind::Codex),
        ["-c".to_string(), skill::CODEX_INSTRUCTION.to_string()]
    );
    assert!(flag_strings(&home, &on, AgentKind::Shell).is_empty());
    let _ = fs::remove_dir_all(home);
}

#[test]
fn extensions_never_write_claude_or_codex_home() {
    let home = scratch("ext-nowrite");
    let user = scratch("ext-nowrite-user");
    for (file, body) in [
        (".claude/settings.json", "{\"a\":1}"),
        (".claude.json", "{\"mcpServers\":{}}"),
        (".codex/config.toml", "model = \"x\"\n"),
    ] {
        fs::create_dir_all(user.join(file).parent().unwrap()).unwrap();
        fs::write(user.join(file), body).unwrap();
    }
    let snapshot = |root: &Path| -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = vec![];
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p)
                } else {
                    out.push((p.clone(), fs::read(&p).unwrap()))
                }
            }
        }
        out.sort();
        out
    };
    let before = snapshot(&user);
    // Every item on: the shipped skill, a custom folder, an own MCP server, orchestration's Codex pointer.
    fs::create_dir_all(home.join("extensions/mine/skills")).unwrap();
    crate::extensions::mcp_add(&home, "files", &["files-mcp".into()], None).unwrap();
    let mut s = ext_settings(Some(&["nunchiro", "custom:mine"]));
    s.orchestration.enabled = true;
    for kind in [AgentKind::Claude, AgentKind::Codex] {
        for f in flag_strings(&home, &s, kind) {
            // Every path a flag names is inside Nunchiro's own folder.
            if f.starts_with('/') {
                assert!(Path::new(&f).starts_with(&home), "{f}");
            }
        }
    }
    assert!(crate::extensions::agent_servers(&user).0.is_empty());
    assert_eq!(
        snapshot(&user),
        before,
        "the agents' config under the test HOME changed"
    );
    let _ = fs::remove_dir_all(home);
    let _ = fs::remove_dir_all(user);
}
// Ticket 370 item 8: a location makes a folder anywhere the user can write; no session may ask for one.
#[test]
fn project_create_with_a_parent_refused_to_session_callers() {
    let home = scratch("create-agent");
    let core = Sessions::open(&home).unwrap();
    let caller = crate::grants::Caller {
        id: "another".into(),
        project: home.clone(),
    };
    let request = Request::ProjectCreate {
        name: "x".into(),
        parent: Some(home.to_string_lossy().into_owned()),
    };
    assert_eq!(
        core.check_agent(&caller, &request),
        Err("operation not granted".into())
    );
    assert!(!home.join("x").exists());
}

// Ticket 370: a clone takes a typed URL, does network I/O and deletes a folder; no session may ask for one.
#[test]
fn project_clone_ops_refused_to_session_callers() {
    let home = scratch("clone-agent");
    let core = Sessions::open(&home).unwrap();
    let caller = crate::grants::Caller {
        id: "another".into(),
        project: home.clone(),
    };
    for request in [
        Request::ProjectClone {
            url: "https://h/a".into(),
            parent: home.to_string_lossy().into_owned(),
        },
        Request::ProjectCloneState { job: "j".into() },
        Request::ProjectCloneCancel { job: "j".into() },
    ] {
        assert_eq!(
            core.check_agent(&caller, &request),
            Err("operation not granted".into()),
            "{request:?}"
        );
    }
}

// Ticket 276 (`extension_ops_refused_from_agent_remote_and_widget`, agent half): a session caller is refused at
// `check_agent`, and the locked dispatch never runs the ops (they go to the transport's off-lock path).
#[test]
fn extension_ops_refused_to_session_callers() {
    let home = scratch("ext-agent");
    let mut core = Sessions::open(&home).unwrap();
    let caller = crate::grants::Caller {
        id: "another".into(),
        project: home.clone(),
    };
    for request in [
        Request::ExtensionsList,
        Request::ExtensionsMcpAdd {
            name: "evil".into(),
            command: vec!["sh".into()],
            project: None,
        },
        Request::ExtensionsMcpRemove {
            name: "evil".into(),
        },
        Request::ExtensionsItemFiles {
            id: "nunchiro".into(),
        },
        Request::ExtensionsItemRead {
            id: "nunchiro".into(),
            path: "skills/nunchiro/SKILL.md".into(),
        },
        Request::ExtensionsItemSave {
            id: "custom:evil".into(),
            path: "x".into(),
            text: "x".into(),
            base: None,
        },
        Request::ExtensionsSkillNew {
            name: "evil".into(),
            description: "x".into(),
            hook: false,
        },
        Request::ExtensionsItemRemove {
            id: "custom:evil".into(),
        },
    ] {
        assert_eq!(
            core.check_agent(&caller, &request),
            Err("operation not granted".into()),
            "{request:?}"
        );
        assert!(core.handle(request).is_err());
    }
    assert!(!home.join("extensions").exists());
    let _ = core.handle(Request::Stop);
    let _ = fs::remove_dir_all(home);
}
fn settings(core: &mut Sessions, patch: LifetimePatch) -> LifetimeSettings {
    match core.handle(Request::QuitSettings { patch }).unwrap() {
        Reply::QuitSettings { settings } => settings,
        _ => panic!(),
    }
}
// V2-CF5: the read-only working query the keep-awake ticker uses. Two rows, one working.
#[test]
fn any_working_reads_only() {
    let (registry, home, id) = writes_core("cf5-anyworking", "exec cat");
    let mut core = registry.lock().unwrap();
    // Two rows: the shell above and a second one.
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let other = core.start(&launch).unwrap().id;
    launch.committed = true;
    drop(launch);
    // Neither works yet: a started shell has run no turn.
    assert!(!core.any_working());
    // The queue's own hook path sets it, exactly as the snapshot reports it.
    core.queue
        .observe(&id, "UserPromptSubmit", &serde_json::json!({}), "hook", 1)
        .unwrap();
    assert!(core.any_working());
    assert!(core.queue.attention(&id).working);
    assert!(!core.queue.attention(&other).working, "the other row");
    // Reading it changes nothing: the queue still reports the same working flag and the other row stays idle.
    assert!(core.any_working());
    assert!(core.queue.attention(&id).working);
    for sid in [&id, &other] {
        core.handle(Request::Close { id: sid.clone() }).unwrap();
    }
    assert!(!core.any_working());
    drop(core);
    end_writes(registry, home);
}
// V2-CF5: off by default, stored by the core, kept across a restart.
#[test]
fn keep_awake_setting_defaults_off_and_persists() {
    let home = scratch("cf5-setting");
    let mut core = Sessions::open(&home).unwrap();
    assert!(!settings(&mut core, LifetimePatch::default()).keep_awake);
    assert!(
        !home.join("settings.json").exists(),
        "a read writes nothing"
    );
    let set = settings(
        &mut core,
        LifetimePatch {
            keep_awake: Some(true),
            ..Default::default()
        },
    );
    assert!(set.keep_awake);
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    assert!(settings(&mut core, LifetimePatch::default()).keep_awake);
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(file["keep_awake"], true);
    drop(core);
    let _ = fs::remove_dir_all(home);
}
// v1b-38 (V1A-40 review): saved scrollback read at `open` stays under a total; rows past it seed nothing.
#[test]
fn open_preloads_scrollback_up_to_a_total() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("preload-cap-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    for id in ["a", "b", "c", "d"] {
        crate::scrollback::save(&home, id, &[b'x'; 10], false).unwrap();
    }
    let ids: Vec<String> = ["a", "missing", "b", "c", "d"].map(String::from).into();
    let loaded: Vec<bool> = preload(&home, &ids, 25)
        .iter()
        .map(Option::is_some)
        .collect();
    assert_eq!(loaded, [true, false, true, false, false]);
    assert_eq!(PRELOAD_BYTES, 64 * 1024 * 1024);
    let _ = fs::remove_dir_all(&home);
}
// v1b-38 (V1A-40 review): a scrollback thread that cannot start must not panic under the registry lock.
#[test]
fn stop_saves_scrollback_inline_when_a_thread_cannot_start() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("stop-nothread-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    // A stack no host can map: the spawn returns an error instead of a thread.
    let huge = || std::thread::Builder::new().stack_size(1 << 62);
    assert!(huge().spawn(|| ()).is_err());
    let rows = [
        ("s1".to_string(), b"one".to_vec()),
        ("s2".into(), b"two".to_vec()),
    ];
    let batch = rows
        .clone()
        .map(|(id, bytes)| (id, Write::Save { bytes, mask: false }));
    write_scrollback(&home, &batch, huge);
    for (id, bytes) in &rows {
        assert_eq!(
            crate::scrollback::load(&home, id).unwrap().as_ref(),
            Some(bytes)
        );
    }
    let _ = fs::remove_dir_all(&home);
}

// V1A-74 follow-up: an in-process registry, as the server holds it, with one shell that runs `script`.
fn writes_core(name: &str, script: &str) -> (std::sync::Mutex<Sessions>, PathBuf, String) {
    let home = scratch(name);
    let _ = fs::remove_dir_all(home.join("scrollback"));
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/sh".into(), "-c".into(), script.into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    drop(launch);
    (std::sync::Mutex::new(core), home, id)
}
/// Polls until the shell has exited and its save is queued.
fn exited(registry: &std::sync::Mutex<Sessions>, id: &str) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let mut core = registry.lock().unwrap();
        core.handle(Request::Snapshot).unwrap();
        if core.entries[id].meta.state != SessionState::Running {
            assert!(core.scrollback_pending());
            return;
        }
        drop(core);
        assert!(std::time::Instant::now() < until, "the shell never exited");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
fn end_writes(registry: std::sync::Mutex<Sessions>, home: PathBuf) {
    registry.lock().unwrap().handle(Request::Stop).unwrap();
    Sessions::drain_scrollback(&registry);
    drop(registry);
    let _ = fs::remove_dir_all(home);
}
/// Runs `during` under the registry lock while a drain on another thread writes `id` with the lock released.
fn while_writing(
    registry: &std::sync::Mutex<Sessions>,
    id: &str,
    during: impl FnOnce(&mut Sessions),
) {
    std::thread::scope(|scope| {
        let drain = scope.spawn(|| Sessions::drain_scrollback(registry));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let mut core = registry.lock().unwrap();
            if core.writes.writing.contains(id) {
                during(&mut core);
                break;
            }
            drop(core);
            assert!(
                std::time::Instant::now() < until,
                "the drain never took {id}"
            );
            std::thread::yield_now();
        }
        drain.join().unwrap();
    });
}
/// Lines with a secret shape, `n` bytes, so a masked save takes a while.
fn secret_lines(n: usize) -> Vec<u8> {
    b"API_KEY=hunter2plainvalue sk-ant-TEST0000000000abcdef\n".repeat(n / 54 + 1)
}

// V2-6d: an exited shell whose scrollback file is on disk, in an in-process registry.
fn ended_core(name: &str) -> (std::sync::Mutex<Sessions>, PathBuf, String) {
    let (registry, home, id) = writes_core(name, "printf hello");
    exited(&registry, &id);
    Sessions::drain_scrollback(&registry);
    assert!(crate::scrollback::load(&home, &id).unwrap().is_some());
    (registry, home, id)
}
// V2-4b round 2: an ACP agent that could not start leaves a failed row with its card, and the row holds no ACP
// client, no token and no process; an entry not approved (or changed) leaves nothing.
#[test]
fn failed_acp_session_has_no_token_or_process() {
    let home = scratch("acp-failed-row");
    let mut core = Sessions::open(&home).unwrap();
    let start = StartSession {
        account: None,
        kind: AgentKind::Acp,
        project: home.clone(),
        worktree: false,
        label: String::new(),
        args: vec!["gone".into()],
        model: None,
        effort: None,
        resume: None,
    };
    let Ok(Reply::Started { session }) = core.start_failed(
        &start,
        "acp agent /nonexistent/agent: No such file or directory (os error 2)".into(),
    ) else {
        panic!("no failed row")
    };
    assert_eq!(session.state, SessionState::Failed);
    assert_eq!(session.pid, None);
    assert_eq!(session.acp_agent.as_deref(), Some("gone"));
    assert_eq!(
        session.problem.as_ref().map(|p| p.case),
        Some(crate::problems::Case::NotInstalled)
    );
    let entry = core.entries.get(&session.id).unwrap();
    assert!(entry.acp.is_none() && entry.pty.is_none());
    assert!(entry.token.is_none() && entry.token_hash.is_none());
    let rows = core.entries.len();
    for error in [
        "agent is not approved",
        "agent changed since it was approved",
    ] {
        assert!(core.start_failed(&start, error.into()).is_err(), "{error}");
    }
    assert_eq!(core.entries.len(), rows, "an unapproved entry left a row");
    let _ = fs::remove_dir_all(home);
}
// Look 1117 v13 (Home S3-5): an ended row whose folder was removed says so in the snapshot, so the window names no
// checkout for it; while the folder is there it says nothing.
#[test]
fn snapshot_says_an_ended_rows_folder_is_gone() {
    let home = scratch("folder-gone");
    let dir = home.join("harbor");
    fs::create_dir_all(&dir).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let start = StartSession {
        account: None,
        kind: AgentKind::Acp,
        project: dir.clone(),
        worktree: false,
        label: String::new(),
        args: vec!["gone".into()],
        model: None,
        effort: None,
        resume: None,
    };
    let Ok(Reply::Started { session }) = core.start_failed(
        &start,
        "acp agent /nonexistent/agent: No such file or directory (os error 2)".into(),
    ) else {
        panic!("no failed row")
    };
    let gone = |core: &Sessions| {
        core.snapshot_session(&core.entries[&session.id].meta)
            .folder_gone
    };
    assert!(!gone(&core));
    fs::remove_dir_all(&dir).unwrap();
    assert!(gone(&core));
    let _ = fs::remove_dir_all(home);
}

fn listed(core: &mut Sessions, request: Request) -> Vec<String> {
    match core.handle(request).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions.into_iter().map(|s| s.id).collect(),
        _ => panic!(),
    }
}
fn undo(core: &mut Sessions, id: &str) -> Response {
    core.handle(Request::CloseUndo { id: id.into() })
}

// Ticket 991: the snapshot lists sessions in the order they were started, not by id (random). A window that first
// sees them together opens their tabs in this order; a core opened again on the same home keeps it.
#[test]
fn snapshot_lists_sessions_in_start_order() {
    fake_agents();
    let home = scratch("start-order");
    let mut core = Sessions::open(&home).unwrap();
    let started: Vec<String> = (0..6)
        .map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(3)); // the order's clock counts milliseconds
            cat_as(&mut core, &home, AgentKind::Shell)
        })
        .collect();
    let mut by_id = started.clone();
    by_id.sort();
    assert_ne!(started, by_id, "six random ids in id order: run again");
    assert_eq!(listed(&mut core, Request::Snapshot), started);
    assert_eq!(listed(&mut core, Request::List), started);
    // Stored with the queue: another core on the same home lists the same order.
    let again = Sessions::open(&home).unwrap();
    let Ok(Reply::Snapshot { sessions, .. }) = again.snapshot() else {
        panic!("snapshot");
    };
    let ids: Vec<String> = sessions.into_iter().map(|s| s.id).collect();
    assert_eq!(ids, started);
    drop(again);
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}

// V2-6d follow-up: the close path writes sessions.json once, and never with the id as Closed.
#[test]
fn finish_close_saves_once() {
    use std::sync::atomic::Ordering::SeqCst;
    let (registry, home, id) = ended_core("cu-once");
    {
        let mut core = registry.lock().unwrap();
        core.handle(Request::Close { id: id.clone() }).unwrap();
        let rows = || fs::read_to_string(home.join("sessions.json")).unwrap();
        assert!(
            !rows().contains(&id),
            "phase 1 already saved without the row"
        );
        let before = core.saves.load(SeqCst);
        core.finish_close(u64::MAX);
        assert_eq!(core.saves.load(SeqCst) - before, 1);
        assert!(!rows().contains(&id));
        assert!(!core.entries.contains_key(&id));
    }
    end_writes(registry, home);
}
#[test]
fn finish_close_failure_saves_once_and_keeps_row() {
    use std::sync::atomic::Ordering::SeqCst;
    let (registry, home, id) = ended_core("cu-once-fail");
    {
        let mut core = registry.lock().unwrap();
        core.handle(Request::Close { id: id.clone() }).unwrap();
        // A hooks path that is a non-empty folder makes `remove_hooks` fail after the row went Closed.
        let hooks = home.join(format!("hooks-{id}.json"));
        fs::create_dir_all(hooks.join("x")).unwrap();
        let before = core.saves.load(SeqCst);
        core.finish_close(u64::MAX);
        assert_eq!(core.saves.load(SeqCst) - before, 1);
        assert!(
            core.entries.contains_key(&id),
            "a failed close keeps the row"
        );
        assert!(core.closing.is_none());
    }
    end_writes(registry, home);
}

// Ticket 1073 round 3: a closed row leaves the store, but its conversation id stays in ran.json, so History never calls
// that conversation "started in a terminal".
#[test]
fn closed_row_conversation_stays_in_ran_json() {
    let (registry, home, id) = ended_core("ran-1073");
    let conversation = "1".repeat(8) + "-0000-4000-8000-000000001073";
    {
        let mut core = registry.lock().unwrap();
        core.entries.get_mut(&id).unwrap().meta.agent_session_id = Some(conversation.clone());
        core.handle(Request::Close { id: id.clone() }).unwrap();
        core.finish_close(u64::MAX);
        assert!(!core.entries.contains_key(&id), "the row is gone");
        assert!(
            !fs::read_to_string(home.join("sessions.json"))
                .unwrap()
                .contains(&conversation)
        );
        let ran: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join(crate::import::RAN)).unwrap()).unwrap();
        assert_eq!(ran["conversations"], serde_json::json!([conversation]));
    }
    end_writes(registry, home);
}

// Ticket 1073 round 4: a home from before ran.json (old chat records, no ran.json) is seeded at the first start; a
// second start changes nothing, also when another chat record appeared meanwhile.
#[test]
fn open_seeds_ran_json_once_from_old_chat_records() {
    let home = scratch("ran-seed-1073");
    let chat = home.join("chat");
    fs::create_dir_all(&chat).unwrap();
    let old = "2".repeat(8) + "-0000-4000-8000-000000001073";
    fs::write(chat.join(format!("claude-{old}.json")), "{}").unwrap();
    fs::write(chat.join("shell-0123.json"), "{}").unwrap();
    drop(Sessions::open(&home).unwrap());
    let first = fs::read(home.join(crate::import::RAN)).unwrap();
    let ran: serde_json::Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(ran["seeded"], true);
    assert_eq!(ran["conversations"], serde_json::json!([old]));
    fs::write(chat.join("claude-later.json"), "{}").unwrap();
    drop(Sessions::open(&home).unwrap());
    assert_eq!(
        fs::read(home.join(crate::import::RAN)).unwrap(),
        first,
        "a second start changes nothing"
    );
    let _ = fs::remove_dir_all(&home);
}

// V2-6d follow-up: a close-pending row still blocks its account's removal, and Undo brings it back on that account.
#[test]
fn account_remove_refused_while_close_pending() {
    let (registry, home, id) = ended_core("cu-acct");
    let folder = home.join("acct");
    {
        let mut core = registry.lock().unwrap();
        let meta = &mut core.entries.get_mut(&id).unwrap().meta;
        meta.kind = AgentKind::Claude;
        meta.agent_session_id = Some("0".repeat(8) + "-0000-4000-8000-000000000000");
        meta.state = SessionState::Resumable;
        meta.config_dir = Some(folder.clone());
        core.handle(Request::Close { id: id.clone() }).unwrap();
        assert!(!core.entries.contains_key(&id));
        let (blocking, others) = core.account_users(&folder);
        assert_eq!((blocking.len(), others), (1, 0), "the pending row blocks");
        assert!(matches!(undo(&mut core, &id), Ok(Reply::Ack)));
        assert_eq!(
            core.entries[&id].meta.config_dir.as_deref(),
            Some(folder.as_path())
        );
        // Forget the fake conversation so the end-of-test Stop has nothing odd to close.
        core.entries.get_mut(&id).unwrap().meta.state = SessionState::Exited;
    }
    end_writes(registry, home);
}

// ticket-105: a sleep plus a wall clock set back must not run the clock backwards (that gave a pending close its window back).
#[test]
fn sleep_then_wall_setback_does_not_lengthen_window() {
    let o = std::sync::atomic::AtomicU64::new(0);
    assert_eq!(clock_ms(&o, 1_000, 1_000), 1_000);
    assert_eq!(clock_ms(&o, 1_100, 6_100), 6_100);
    let setback = clock_ms(&o, 1_200, 1_200);
    assert!(setback >= 6_100, "went backwards: {setback}");
    let (registry, home, id) = ended_core("cu-setback");
    {
        let mut core = registry.lock().unwrap();
        let o = std::sync::atomic::AtomicU64::new(0);
        let t = close_clock();
        core.handle(Request::Close { id: id.clone() }).unwrap();
        let until = core.closing.as_ref().unwrap().until;
        assert_eq!(clock_ms(&o, t + 100, t + 100), t + 100);
        let after_sleep = clock_ms(&o, t + 200, t + 200 + CLOSE_UNDO_MS);
        let after_setback = clock_ms(&o, t + 300, t + 300);
        assert!(after_setback >= until, "{after_setback} < {until}");
        assert!(after_setback >= after_sleep);
        core.finish_close(after_setback);
        assert!(core.closing.is_none(), "the window stays ended");
        assert!(undo(&mut core, &id).is_err());
    }
    end_writes(registry, home);
}

#[test]
fn clock_never_goes_backwards() {
    let o = std::sync::atomic::AtomicU64::new(0);
    let steps = [
        (0, 0),
        (100, 0),
        (200, 90_000),
        (300, 300),
        (300, 0),
        (5_000, 4_000),
        (5_001, 200_000),
        (6_000, 1),
    ];
    let mut last = 0;
    for (mono, wall) in steps {
        let now = clock_ms(&o, mono, wall);
        assert!(now >= last, "({mono}, {wall}) gave {now} after {last}");
        assert!(now >= mono);
        last = now;
    }
}

// V2-6d follow-up: the window runs on `close_clock`; neither phase reads the wall clock.
#[test]
fn undo_window_ignores_wall_clock_going_back() {
    let (registry, home, id) = ended_core("cu-mono");
    {
        let mut core = registry.lock().unwrap();
        core.handle(Request::Close { id: id.clone() }).unwrap();
        // The deadline is read back: Close takes its own clock reading, which a loaded host can move past any
        // earlier one.
        let until = core.closing.as_ref().unwrap().until;
        core.finish_close(until - 1);
        assert!(core.closing.is_some(), "kept one ms before the deadline");
        core.finish_close(until);
        assert!(core.closing.is_none(), "ended at the deadline");
    }
    end_writes(registry, home);
    // A wall-clock change cannot be simulated in-process: the proof is that none of the three window sites reads it.
    let source = include_str!("../sessions.rs");
    let between = |from: &str, to: &str| {
        let start = source.find(from).unwrap();
        &source[start..start + source[start..].find(to).unwrap()]
    };
    let sites = [
        between("fn close_later", "fn close_unsaved"),
        between("Request::CloseUndo { id } =>", "\n"),
        between("self.finish_close(close_clock())", "\n"),
    ];
    for site in sites {
        assert!(
            !site.contains("now_ms") && !site.contains("SystemTime"),
            "{site}"
        );
    }
}

// ticket-103: a Mac sleep stops the monotonic clock, so the window also runs on wall time (the later of the two).
// A real sleep cannot be simulated in-process: the pure `clock_ms` and the `close_clock` source are the proof.
#[test]
fn undo_expires_across_simulated_sleep() {
    let fresh = std::sync::atomic::AtomicU64::new(0);
    assert!(clock_ms(&fresh, 1_000, 1_000 + CLOSE_UNDO_MS) >= 1_000 + CLOSE_UNDO_MS);
    let offset = std::sync::atomic::AtomicU64::new(0);
    let (registry, home, id) = ended_core("cu-sleep");
    {
        let mut core = registry.lock().unwrap();
        let t = close_clock();
        core.handle(Request::Close { id: id.clone() }).unwrap();
        let until = core.closing.as_ref().unwrap().until;
        // The wall clock set back changes nothing.
        core.finish_close(clock_ms(&offset, t + 100, 0));
        assert!(
            core.closing.is_some(),
            "kept when only the wall clock is behind"
        );
        // The monotonic clock stood still through a sleep; the wall clock moved past the deadline.
        let after_sleep = clock_ms(&offset, t + 100, until);
        core.finish_close(after_sleep);
        assert!(core.closing.is_none(), "the sleep ended the window");
        assert!(undo(&mut core, &id).is_err() && !core.entries.contains_key(&id));
    }
    end_writes(registry, home);
}

// ticket-103: the refusal to remove an account names the closing row, so the user knows why it is still in use.
#[test]
fn account_remove_refusal_names_closing_row() {
    use crate::{accounts::Agent, api::RemoveStep};
    let (registry, home, id) = ended_core("cu-name");
    let home = fs::canonicalize(home).unwrap();
    let account = "0".repeat(8) + "-0000-4000-8000-0000000000aa";
    let folder = crate::accounts::real_folder(&home, Agent::Claude, &account, true).unwrap();
    fs::write(
        home.join("accounts.toml"),
        format!(
            "version = 1\n[[accounts]]\nagent = \"claude\"\nid = \"{account}\"\nlabel = \"work\"\n"
        ),
    )
    .unwrap();
    let check = || {
        crate::accounts::handle(
            &home,
            &registry,
            None,
            Request::AccountRemove {
                agent: Agent::Claude,
                id: account.clone(),
                step: RemoveStep::Check,
                leftovers: false,
            },
        )
    };
    {
        let mut core = registry.lock().unwrap();
        let entry = core.entries.get_mut(&id).unwrap();
        entry.meta.kind = AgentKind::Claude;
        entry.meta.agent_session_id = Some("0".repeat(8) + "-0000-4000-8000-000000000000");
        entry.meta.state = SessionState::Resumable;
        entry.meta.config_dir = Some(folder.clone());
        entry.meta.label = "tab".into();
        assert_eq!(
            core.account_users(&folder).0,
            ["tab"],
            "not pending: no suffix"
        );
    }
    let plain = check().unwrap_err();
    assert!(
        plain.contains("\"tab\"") && !plain.contains("closing"),
        "{plain}"
    );
    {
        let mut core = registry.lock().unwrap();
        core.close_later(&id, true).unwrap();
        assert_eq!(
            core.account_users(&folder).0,
            ["tab (closing, Undo window)"]
        );
    }
    let error = check().unwrap_err();
    assert!(error.contains("(closing, Undo window)"), "{error}");
    {
        let mut core = registry.lock().unwrap();
        let entry = core.closing.take().unwrap().entry;
        core.entries.insert(id.clone(), entry);
        core.entries.get_mut(&id).unwrap().meta.state = SessionState::Exited;
    }
    end_writes(registry, home);
}

// V2-6d acceptance 1: a closed stopped or done row leaves the snapshot and the search list at once; its record and
// scrollback stay until 10 s of core time have passed, then go as a close always did.
#[test]
fn close_hides_row_keeps_data_for_10s() {
    let (registry, home, id) = ended_core("cu-hide");
    {
        let mut core = registry.lock().unwrap();
        core.handle(Request::Close { id: id.clone() }).unwrap();
        let closed = close_clock();
        assert!(!listed(&mut core, Request::Snapshot).contains(&id));
        assert!(!listed(&mut core, Request::List).contains(&id)); // what Search's Sessions scope reads
        assert!(core.closing.as_ref().is_some_and(|c| c.entry.meta.id == id));
        core.finish_close(closed + CLOSE_UNDO_MS - 1_000);
        assert!(crate::scrollback::load(&home, &id).unwrap().is_some());
        assert!(core.closing.is_some());
        core.finish_close(closed + CLOSE_UNDO_MS);
        assert!(core.closing.is_none());
        assert!(!core.entries.contains_key(&id));
        assert!(!listed(&mut core, Request::Snapshot).contains(&id));
    }
    Sessions::drain_scrollback(&registry);
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    let (rows, _) = store::load_live(&home).unwrap();
    assert!(rows.iter().all(|s| s.id != id), "the record went too");
    end_writes(registry, home);
}

// V2-6d acceptance 2: Undo inside the window brings back the row as it was (label, place, scrollback, board link);
// after the window it says so plainly.
#[test]
fn undo_restores_exactly() {
    let (registry, home, id) = ended_core("cu-undo");
    let mut core = registry.lock().unwrap();
    core.handle(Request::Label {
        id: id.clone(),
        label: "kept label".into(),
    })
    .unwrap();
    core.handle(Request::BoardPut {
        id: None,
        title: "linked".into(),
        note: String::new(),
        session_id: Some(id.clone()),
        column: None,
    })
    .unwrap();
    // The session's own card, dragged to another column: a drag holds while the session is unchanged.
    core.handle(Request::BoardMove {
        source: crate::board::Source::Session,
        id: id.clone(),
        column: "done".into(),
    })
    .unwrap();
    let board = || fs::read(home.join("board.json")).unwrap();
    let (board_before, rows_before) = (board(), fs::read(home.join("sessions.json")).unwrap());
    let order = listed(&mut core, Request::Snapshot);
    let row = |core: &mut Sessions| {
        let Reply::Snapshot { sessions, .. } = core.handle(Request::Snapshot).unwrap() else {
            panic!()
        };
        serde_json::to_string(sessions.iter().find(|s| s.id == id).unwrap()).unwrap()
    };
    let before = row(&mut core);
    let scrollback = crate::scrollback::load(&home, &id).unwrap();
    core.handle(Request::Close { id: id.clone() }).unwrap();
    core.tick().unwrap(); // the window's ticks run while it waits
    assert!(matches!(undo(&mut core, &id), Ok(Reply::Ack)));
    assert_eq!(row(&mut core), before);
    assert_eq!(listed(&mut core, Request::Snapshot), order);
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), scrollback);
    assert_eq!(board(), board_before);
    assert_eq!(fs::read(home.join("sessions.json")).unwrap(), rows_before);
    assert!(core.closing.is_none());
    // Undo again, or after the window: refused in plain words, nothing changes.
    assert_eq!(
        undo(&mut core, &id).unwrap_err(),
        "this close can no longer be undone"
    );
    core.handle(Request::Close { id: id.clone() }).unwrap();
    core.finish_close(close_clock() + CLOSE_UNDO_MS);
    assert_eq!(
        undo(&mut core, &id).unwrap_err(),
        "this close can no longer be undone"
    );
    assert!(!listed(&mut core, Request::Snapshot).contains(&id));
    drop(core);
    end_writes(registry, home);
}

// Ticket 750: a queue.json an older core filled past the 4096-session limit (4096 rowless states plus the kept
// row's) opens, a new session starts, and a resume of the kept row still finds its state.
#[test]
fn a_queue_over_4096_rowless_states_opens_and_starts_a_session() {
    let home = scratch("queue-4096");
    let shell = |label: &str| StartSession {
        account: None,
        kind: AgentKind::Shell,
        project: home.clone(),
        worktree: false,
        label: label.into(),
        args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
        model: None,
        effort: None,
        resume: None,
    };
    let start = |core: &mut Sessions, label: &str| {
        let mut launch = core.launch(shell(label)).prepare().unwrap();
        let id = core.start(&launch).unwrap().id;
        launch.committed = true;
        id
    };
    let kept = {
        let mut core = Sessions::open(&home).unwrap();
        let kept = start(&mut core, "kept");
        core.handle(Request::Close { id: kept.clone() }).unwrap();
        kept
    };
    let path = home.join("queue.json");
    let mut disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let state = disk["sessions"][&kept].clone();
    for i in 0..4096 {
        disk["sessions"][format!("gone{i:04}")] = state.clone();
    }
    fs::write(&path, serde_json::to_vec(&disk).unwrap()).unwrap();
    let mut core = Sessions::open(&home).expect("a queue over the limit still opens");
    let new = start(&mut core, "new");
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let ids: std::collections::BTreeSet<&String> =
        saved["sessions"].as_object().unwrap().keys().collect();
    assert_eq!(ids, [&kept, &new].into_iter().collect());
    core.queue.prepare_resume(&kept, "resumed750").unwrap();
    let _ = core.handle(Request::Close { id: new });
    let _ = fs::remove_dir_all(&home);
}
// Ticket 621: 200 sessions started and closed leave at most CLOSED_KEEP Closed rows in `entries`, sessions.json and
// the snapshot, and the snapshot stops growing; rows a live row, a filed project or a held view needs stay outside
// it. Round 2: the 200 run in 100 project folders (worktrees are projects) that tree.toml does not file, and the
// queue keeps no state of a dropped row (ticket 750).
#[test]
fn closed_rows_stay_bounded_after_200_closes() {
    let home = scratch("closed-keep");
    let other = home.join("other");
    fs::create_dir_all(&other).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let start = |core: &mut Sessions, project: &Path, label: String| {
        let mut launch = core
            .launch(StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: project.into(),
                worktree: false,
                label,
                args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
                model: None,
                effort: None,
                resume: None,
            })
            .prepare()
            .unwrap();
        let id = core.start(&launch).unwrap().id;
        launch.committed = true;
        id
    };
    let closed = |core: &Sessions| {
        core.entries
            .values()
            .filter(|e| e.meta.state == SessionState::Closed)
            .map(|e| e.meta.label.clone())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let live = start(&mut core, &home, "live".into());
    // The oldest closes: the live row's parent, its conversation's earlier session, another project's only row.
    let parent = start(&mut core, &home, "parent".into());
    let chain = start(&mut core, &home, "chain".into());
    let lone = start(&mut core, &other, "lone".into());
    let pin = crate::tree::TreeEdit::Pin {
        project: other.to_str().unwrap().into(),
        pinned: true,
    };
    core.handle(Request::TreeEdit { edit: pin }).unwrap();
    for id in [&parent, &chain, &lone] {
        core.handle(Request::Close { id: id.clone() }).unwrap();
    }
    core.entry(&live).unwrap().meta.parent = Some(parent.clone());
    core.entry(&live).unwrap().meta.conversation = Some("c-621".into());
    core.entry(&chain).unwrap().meta.conversation = Some("c-621".into());
    let size = |core: &mut Sessions| {
        let Reply::Snapshot { sessions, .. } = core.handle(Request::Snapshot).unwrap() else {
            panic!()
        };
        serde_json::to_vec(&sessions).unwrap().len()
    };
    let mut at_keep = 0;
    for i in 0..200 {
        let project = home.join(format!("p{}", i % 100));
        fs::create_dir_all(&project).unwrap();
        let id = start(&mut core, &project, format!("s{i:03}"));
        core.handle(Request::Close { id }).unwrap();
        if i + 1 == CLOSED_KEEP {
            at_keep = size(&mut core);
        }
    }
    let want: std::collections::BTreeSet<String> = (200 - CLOSED_KEEP..200)
        .map(|i| format!("s{i:03}"))
        .chain(["parent", "chain", "lone"].map(String::from))
        .collect();
    assert_eq!(closed(&core), want);
    assert_eq!(core.entries.len(), CLOSED_KEEP + 4);
    // Kept rows are the same in number at 50 closes and at 200, so the snapshot is the same size within a few bytes.
    let at_200 = size(&mut core);
    assert!(
        at_200 <= at_keep + 1024,
        "snapshot grew from {at_keep} to {at_200} bytes"
    );
    let stored = store::load_live(&home).unwrap().0;
    assert_eq!(stored.len(), CLOSED_KEEP + 4);
    let queued = || -> std::collections::BTreeSet<String> {
        let queue: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
        queue["sessions"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    assert_eq!(queued(), core.entries.keys().cloned().collect());
    // A store from before the limit (no close times, more rows) shrinks at the next start; the needed rows stay.
    let mut rows: Vec<Session> = core.entries.values().map(|e| e.meta.clone()).collect();
    for i in 0..100 {
        let mut row = core.entries[&core.entries.keys().find(|k| *k != &live).unwrap().clone()]
            .meta
            .clone();
        row.id = store::new_id().unwrap();
        row.label = format!("old{i}");
        row.project = home.clone();
        row.conversation = None;
        row.state = SessionState::Closed;
        rows.push(row);
    }
    for row in &mut rows {
        row.closed_at = None;
    }
    core.handle(Request::Stop).unwrap();
    drop(core);
    store::save(&home, rows, BTreeMap::new()).unwrap();
    let core = Sessions::open(&home).unwrap();
    let after = closed(&core);
    // Without close times the newest are taken in id order (random), so the needed rows may fall inside the 50 or
    // outside it, with the home project's newest row as a fourth.
    assert!(
        (CLOSED_KEEP..=CLOSED_KEEP + 4).contains(&after.len()),
        "{}",
        after.len()
    );
    for needed in ["parent", "chain", "lone"] {
        assert!(after.contains(needed), "{needed} dropped: {after:?}");
    }
    assert!(queued().iter().all(|id| core.entries.contains_key(id)));
    drop(core);
    let _ = fs::remove_dir_all(home);
}

/// Ticket 621 round 3: a closed row marked as a token session of conversation `conversation` (a shell standing in
/// for its Claude run: only the stored fields matter here).
fn as_token_row(core: &mut Sessions, id: &str, origin: &str, conversation: &str) {
    let meta = &mut core.entry(id).unwrap().meta;
    meta.kind = AgentKind::Claude;
    meta.agent_session_id = Some(conversation.into());
    meta.token_origin = Some(origin.into());
}
fn owner_resume(
    core: &mut Sessions,
    home: &Path,
    conversation: &str,
    origin: Option<&str>,
) -> Result<Session, String> {
    let start = StartSession {
        resume: Some(conversation.into()),
        ..claude_start(home, &[])
    };
    let mut launch = core.launch(start).owner_start();
    launch.origin = origin.map(String::from);
    let mut launch = launch.prepare()?;
    let session = core.start(&launch)?;
    launch.committed = true;
    Ok(session)
}

/// w11 item 3 (ticket 991): after a core restart a plain open of a Home teammate from the window continues its last
/// seat's conversation, still marked as its seat and not briefed again; an open that hands a task starts anew.
#[test]
fn w11_a_plain_open_resumes_the_teammates_last_seat() {
    use crate::team::{Level, Opener, Team, Teammate, open_seat};
    // Sixth look (Home): the last seat's level is the plain open's level (a Deep conversation is continued, not
    // left for a new Standard one); a seat from before levels has none.
    // Look 11-17 v9 (Home S2-2): a lead's scheduled task continues the lead's conversation too, as its open seat
    // takes the task.
    for (name, level, lead) in [
        ("w11-seat", None, false),
        ("w13-seat-deep", Some(Level::Deep), false),
        ("w16-lead-seat", None, true),
    ] {
        let (registry, home, id) = ended_core(name);
        approve_fake_claude(&home, &[]);
        let team = Team::open(&home);
        let mate = team
            .save(
                None,
                Teammate {
                    id: String::new(),
                    name: "Steward".into(),
                    job: "Keeps the house.".into(),
                    kind: AgentKind::Claude,
                    model: None,
                    effort: None,
                    project: None,
                    lead,
                    level: None,
                    level_max: None,
                    next_level: None,
                    agent: None,
                },
            )
            .unwrap()
            .remove(0);
        let conversation = store::new_id().unwrap();
        {
            // The seat as a restart leaves it: ended, Resumable, after one finished turn.
            let mut core = registry.lock().unwrap();
            let meta = &mut core.entry(&id).unwrap().meta;
            meta.kind = AgentKind::Claude;
            meta.agent_session_id = Some(conversation.clone());
            meta.teammate = Some(mate.id.clone());
            meta.level = level;
            meta.state = SessionState::Resumable;
            (meta.project, meta.cwd) = (team.home(), team.home());
            core.queue.acp_turn(&id, true).unwrap();
            core.queue.acp_turn(&id, false).unwrap();
        }
        // The lead goes straight to its scheduled task (its conversation must not run already).
        let seat = if lead {
            id.clone()
        } else {
            let opened = open_seat(&registry, &mate.id, None, None, Opener::Window).unwrap();
            let (seat, started) = (opened.session, opened.started);
            assert!(started);
            assert_eq!(
                seat.agent_session_id.as_deref(),
                Some(conversation.as_str()),
                "the same conversation"
            );
            assert_eq!(seat.level, level.or(Some(Level::Standard)));
            assert_eq!(
                seat.teammate.as_deref(),
                Some(mate.id.as_str()),
                "still the teammate's seat"
            );
            assert!(
                !seat
                    .send_queue
                    .iter()
                    .chain(&seat.send_log)
                    .any(|q| q.content.contains("standing role")),
                "not briefed again"
            );
            seat.id
        };
        // A task is new work: its seat is a new conversation. A lead's is not: the task goes into its conversation.
        {
            let mut core = registry.lock().unwrap();
            core.entry(&seat).unwrap().meta.state = SessionState::Resumable;
            core.queue.acp_turn(&seat, true).unwrap();
            core.queue.acp_turn(&seat, false).unwrap();
        }
        let task = open_seat(
            &registry,
            &mate.id,
            Some("sort the mail"),
            None,
            Opener::Schedule("sched1", crate::pressure::Who::Session),
        )
        .unwrap()
        .session;
        // Marked as a scheduled run when `open_seat` returns, so before anything of its task can ask for a schedule.
        assert_eq!(
            registry
                .lock()
                .unwrap()
                .entry(&task.id)
                .unwrap()
                .meta
                .schedule
                .as_deref(),
            Some("sched1")
        );
        if lead {
            assert_eq!(
                task.agent_session_id.as_deref(),
                Some(conversation.as_str()),
                "the lead's own conversation"
            );
            let now = registry.lock().unwrap().session_of(&task.id).unwrap();
            let queued: Vec<_> = now
                .send_queue
                .iter()
                .chain(&now.send_log)
                .map(|q| &q.content)
                .collect();
            assert!(
                queued.iter().any(|c| c.contains("sort the mail")),
                "{queued:?}"
            );
            assert!(
                !queued.iter().any(|c| c.contains("standing role")),
                "not briefed again"
            );
        } else {
            assert_ne!(
                task.agent_session_id.as_deref(),
                Some(conversation.as_str())
            );
        }
        registry.lock().unwrap().handle(Request::Stop).unwrap();
        let _ = fs::remove_dir_all(home);
    }
}

// Ticket 621 round 3 (MUST 2a): a stopped token session closed through the Undo close stays as a Closed row, in
// memory and in sessions.json from phase 1 on (a core that ends in the window keeps it), and the owner's resume of
// its conversation is a token session again.
#[test]
fn a_token_session_closed_through_undo_resumes_with_its_token_limits() {
    let (registry, home, id) = ended_core("undo-token");
    approve_fake_claude(&home, &[]);
    let conversation = store::new_id().unwrap();
    let mut core = registry.lock().unwrap();
    as_token_row(&mut core, &id, "token-t621", &conversation);
    core.handle(Request::Close { id: id.clone() }).unwrap();
    assert!(core.closing.is_some());
    let stored = store::load_live(&home).unwrap().0;
    let row = stored
        .iter()
        .find(|s| s.id == id)
        .expect("phase 1 keeps the token row on disk");
    assert_eq!(row.state, SessionState::Closed);
    assert_eq!(row.token_origin.as_deref(), Some("token-t621"));
    core.finish_close(u64::MAX);
    assert_eq!(core.entries[&id].meta.state, SessionState::Closed);
    let resumed = owner_resume(&mut core, &home, &conversation, None).unwrap();
    assert_eq!(resumed.token_origin.as_deref(), Some("token-t621"));
    drop(core);
    end_writes(registry, home);
}

// Ticket 621 round 4: the origin is found by conversation id in every project. A token session started in project
// P and resumed with project W (a worktree's folder, say) keeps the token's limits for the owner, and another
// token is refused there too.
#[test]
fn a_resume_from_another_project_keeps_the_token_origin() {
    let (registry, home, id) = ended_core("project-token");
    approve_fake_claude(&home, &[]);
    let other = home.join("w");
    fs::create_dir_all(&other).unwrap();
    let conversation = store::new_id().unwrap();
    let mut core = registry.lock().unwrap();
    as_token_row(&mut core, &id, "token-a", &conversation);
    core.handle(Request::Close { id: id.clone() }).unwrap();
    core.finish_close(u64::MAX);
    let refused = owner_resume(&mut core, &other, &conversation, Some("token-b")).unwrap_err();
    assert!(refused.contains("another token"), "{refused}");
    let resumed = owner_resume(&mut core, &other, &conversation, None).unwrap();
    assert_eq!(resumed.project, other);
    assert_eq!(resumed.token_origin.as_deref(), Some("token-a"));
    drop(core);
    end_writes(registry, home);
}

// Ticket 752 (was ticket 621 round 3 MUST 2b): Closed token rows are bounded with the rest, and each dropped one
// leaves its conversation and origin in sessions.json: after a restart the owner's resume of a dropped
// conversation is a token session again and another token's is refused. With the record full, token rows stay and
// do not count against CLOSED_KEEP (the round 3 rule), so no origin is lost.
#[test]
fn drop_closed_bounds_token_rows_and_keeps_their_origins() {
    let home = scratch("drop-tokens");
    approve_fake_claude(&home, &[]);
    let mut core = Sessions::open(&home).unwrap();
    let shell = |core: &mut Sessions| {
        let mut start = claude_start(&home, &["/bin/sh", "-c", "exec cat"]);
        start.kind = AgentKind::Shell;
        let mut launch = core.launch(start).prepare().unwrap();
        let id = core.start(&launch).unwrap().id;
        launch.committed = true;
        core.handle(Request::Close { id: id.clone() }).unwrap();
        id
    };
    let token_rows = |core: &mut Sessions, n: usize| {
        let mut made = vec![];
        for i in 0..n {
            let id = shell(core);
            let conversation = store::new_id().unwrap();
            as_token_row(core, &id, &format!("token-{i}"), &conversation);
            made.push((id, conversation));
        }
        made
    };
    let closed_tokens = |core: &Sessions| {
        core.entries
            .values()
            .filter(|e| e.meta.state == SessionState::Closed && e.meta.token_origin.is_some())
            .count()
    };
    let dropped = token_rows(&mut core, 60);
    for _ in 0..100 {
        shell(&mut core);
    }
    assert_eq!(
        closed_tokens(&core),
        0,
        "every token row was older than the newest 50"
    );
    assert_eq!(core.token_conversations.len(), 60);
    core.handle(Request::Stop).unwrap();
    drop(core);
    let mut core = Sessions::open(&home).unwrap();
    let (id, conversation) = &dropped[7];
    assert!(!core.entries.contains_key(id));
    let refused = owner_resume(&mut core, &home, conversation, Some("token-other")).unwrap_err();
    assert!(refused.contains("another token"), "{refused}");
    let resumed = owner_resume(&mut core, &home, conversation, None).unwrap();
    assert_eq!(resumed.token_origin.as_deref(), Some("token-7"));
    let _ = core.handle(Request::Close { id: resumed.id });
    // The record full: token rows are kept again and the others still bounded.
    let filler = store::TokenConversation {
        kind: AgentKind::Claude,
        conversation: store::new_id().unwrap(),
        origin: "token-filler".into(),
    };
    core.token_conversations
        .resize(store::TOKEN_CONVERSATIONS - 10, filler);
    let kept = token_rows(&mut core, 20);
    for _ in 0..60 {
        shell(&mut core);
    }
    assert!(kept.iter().all(|(id, _)| core.entries.contains_key(id)));
    let others = core
        .entries
        .values()
        .filter(|e| e.meta.state == SessionState::Closed && e.meta.token_origin.is_none())
        .count();
    assert_eq!(others, CLOSED_KEEP);
    assert!(core.token_conversations.len() <= store::TOKEN_CONVERSATIONS);
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// Ticket 752 round 3 (security r2 MUST): an older core set the version 3 store aside and left an empty version 2
// one. After an upgrade again the aside file's token records still decide a resume: another token's is refused and
// the owner's runs with the origin. The aside file's rows are never loaded.
#[test]
fn token_records_in_a_set_aside_store_survive_a_downgrade() {
    let home = scratch("aside-tokens");
    approve_fake_claude(&home, &[]);
    let conversation = store::new_id().unwrap();
    fs::write(
        home.join("sessions.json"),
        br#"{"version":2,"sessions":[]}"#,
    )
    .unwrap();
    let aside = serde_json::json!({
        "version": 3,
        "sessions": [{"id": "aside-row"}],
        "token_conversations": [{"kind": "claude", "conversation": conversation, "origin": "token-a"}],
    });
    fs::write(
        home.join("sessions.json.v3.1700000000.aside"),
        aside.to_string(),
    )
    .unwrap();
    let mut core = Sessions::open(&home).unwrap();
    assert!(core.entries.is_empty(), "no row comes from an aside file");
    let refused = owner_resume(&mut core, &home, &conversation, Some("token-b")).unwrap_err();
    assert!(refused.contains("another token"), "{refused}");
    let resumed = owner_resume(&mut core, &home, &conversation, None).unwrap();
    assert_eq!(resumed.token_origin.as_deref(), Some("token-a"));
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// Ticket 961: an aside file's rows are never loaded, but a token origin on one still decides a resume of its
// conversation (an older core set the store aside before the row was dropped into a record).
#[test]
fn a_token_origin_on_a_set_aside_row_survives_a_downgrade() {
    let home = scratch("aside-row-origin");
    approve_fake_claude(&home, &[]);
    let conversation = store::new_id().unwrap();
    fs::write(
        home.join("sessions.json"),
        br#"{"version":2,"sessions":[]}"#,
    )
    .unwrap();
    let aside = serde_json::json!({
        "version": 3,
        "sessions": [
            {"id": "aside-row", "kind": "claude", "agent_session_id": conversation, "token_origin": "token-a"},
            {"id": "owner-row", "kind": "future-kind"},
        ],
    });
    fs::write(
        home.join("sessions.json.v3.1700000000.aside"),
        aside.to_string(),
    )
    .unwrap();
    let mut core = Sessions::open(&home).unwrap();
    assert!(core.entries.is_empty(), "no row comes from an aside file");
    let refused = owner_resume(&mut core, &home, &conversation, Some("token-b")).unwrap_err();
    assert!(refused.contains("ran under another token"), "{refused}");
    let resumed = owner_resume(&mut core, &home, &conversation, None).unwrap();
    assert_eq!(resumed.token_origin.as_deref(), Some("token-a"));
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// Ticket 961 item 2: an aside file whose origins cannot be read may cover any conversation, so a token's resume of
// one with no known origin is refused; the owner's still runs, and a token resumes its own.
#[test]
fn an_unreadable_aside_file_refuses_token_resumes_of_unknown_conversations() {
    let home = scratch("aside-unread");
    approve_fake_claude(&home, &[]);
    let unknown = store::new_id().unwrap();
    fs::write(
        home.join("sessions.json"),
        br#"{"version":2,"sessions":[]}"#,
    )
    .unwrap();
    fs::write(home.join("sessions.json.v3.1700000000.aside"), "{").unwrap();
    let own = store::new_id().unwrap();
    let readable = serde_json::json!({
        "version": 3,
        "sessions": [],
        "token_conversations": [{"kind": "claude", "conversation": own, "origin": "token-b"}],
    });
    fs::write(
        home.join("sessions.json.v3.1700000001.aside"),
        readable.to_string(),
    )
    .unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let refused = owner_resume(&mut core, &home, &unknown, Some("token-b")).unwrap_err();
    assert!(refused.contains("could not be read"), "{refused}");
    let own = owner_resume(&mut core, &home, &own, Some("token-b")).unwrap();
    assert_eq!(own.token_origin.as_deref(), Some("token-b"));
    let resumed = owner_resume(&mut core, &home, &unknown, None).unwrap();
    assert_eq!(resumed.token_origin, None);
    core.handle(Request::Stop).unwrap();
    drop(core);
    let _ = fs::remove_dir_all(home);
}

// Ticket 621 round 3 (MUST 2c): a resume of a token session's conversation by a caller acting for another token
// is refused and leaves the original row and its origin as they were; the owner's resume keeps the origin.
#[test]
fn a_resume_by_another_token_keeps_the_original_origin() {
    let (registry, home, id) = ended_core("other-token");
    approve_fake_claude(&home, &[]);
    let conversation = store::new_id().unwrap();
    let mut core = registry.lock().unwrap();
    as_token_row(&mut core, &id, "token-a", &conversation);
    core.handle(Request::Close { id: id.clone() }).unwrap();
    core.finish_close(u64::MAX);
    let refused = owner_resume(&mut core, &home, &conversation, Some("token-b")).unwrap_err();
    assert!(refused.contains("another token"), "{refused}");
    assert_eq!(
        core.entries[&id].meta.token_origin.as_deref(),
        Some("token-a")
    );
    let resumed = owner_resume(&mut core, &home, &conversation, Some("token-a")).unwrap();
    assert_eq!(resumed.token_origin.as_deref(), Some("token-a"));
    drop(core);
    end_writes(registry, home);
}

// V2-6d acceptance 3: a working session closes at once as before (the window keeps its confirm); there is no
// Undo for it.
#[test]
fn working_session_close_not_undoable() {
    let (registry, home, id) = writes_core("cu-work", "printf hello; exec cat");
    let mut core = registry.lock().unwrap();
    assert_eq!(core.entries[&id].meta.state, SessionState::Running);
    core.handle(Request::Close { id: id.clone() }).unwrap();
    assert!(core.closing.is_none());
    assert_eq!(core.entries[&id].meta.state, SessionState::Closed);
    assert!(!core.scrollback_pending());
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    assert_eq!(
        undo(&mut core, &id).unwrap_err(),
        "this close can no longer be undone"
    );
    assert_eq!(core.entries[&id].meta.state, SessionState::Closed);
    drop(core);
    end_writes(registry, home);
}

// V2-6d acceptance 4 (unit side): a session caller never reaches the Undo; the owner and the window do.
#[test]
fn undo_op_refused_to_session_callers() {
    let (registry, home, id) = ended_core("cu-owner");
    let mut core = registry.lock().unwrap();
    core.handle(Request::Close { id: id.clone() }).unwrap();
    let caller = crate::grants::Caller {
        id: "another".into(),
        project: home.clone(),
    };
    assert_eq!(
        core.check_agent(&caller, &Request::CloseUndo { id: id.clone() }),
        Err("operation not granted".into())
    );
    assert!(core.closing.is_some());
    drop(core);
    end_writes(registry, home);
}

// CHAT-MODELIST `skip_permissions_refused_without_user_gesture` (agent side): a session caller's mode request is
// refused whatever the mode, on both gates (`check_agent`, and `set_mode` itself for any sender but "user").
#[test]
fn mode_request_refused_to_session_callers() {
    let (registry, home, id) = ended_core("cu-mode");
    let mut core = registry.lock().unwrap();
    let caller = crate::grants::Caller {
        id: "another".into(),
        project: home.clone(),
    };
    for mode in MODES {
        let request = Request::SetMode {
            id: id.clone(),
            mode: mode.into(),
        };
        assert_eq!(
            core.check_agent(&caller, &request),
            Err("operation not granted".into()),
            "{mode}"
        );
        assert_eq!(
            core.set_mode("another", &id, mode).unwrap_err(),
            "operation not granted",
            "{mode}"
        );
    }
    // Ticket 362: the stored permission is the owner's, from a session and from another machine alike.
    for request in [
        Request::AgentPermissionGet,
        Request::AgentPermissionSet {
            agent: AgentKind::Claude,
            choice: PermissionChoice::FullAccess,
        },
    ] {
        assert_eq!(
            core.check_agent(&caller, &request),
            Err("operation not granted".into())
        );
        core.grants.remote.insert(caller.id.clone());
        assert!(core.check_agent(&caller, &request).is_err());
        core.grants.remote.remove(&caller.id);
    }
    drop(core);
    end_writes(registry, home);
}

// V2-6d: a session caller's close whose phase 2 cannot end a stale holder keeps the row (shown again), as a
// refused close always did; it never runs with the owner's authority.
#[test]
fn failed_finish_keeps_the_row() {
    let (registry, home, id) = ended_core("cu-fail");
    let mut core = registry.lock().unwrap();
    let record = core.entries[&id].holder().unwrap().0.clone();
    // A holder that never answers, whose recorded agent (this test process) keeps running.
    core.entry(&id).unwrap().stale = Some(Stale {
        record,
        pid: std::process::id(),
        started: None,
        run_start: 0,
        retry: std::time::Instant::now(),
        busy: 0,
    });
    core.close(&id, false, false).unwrap();
    assert!(!core.entries.contains_key(&id));
    core.finish_close(u64::MAX);
    assert!(core.closing.is_none());
    assert!(listed(&mut core, Request::Snapshot).contains(&id));
    assert!(crate::scrollback::load(&home, &id).unwrap().is_some());
    core.entry(&id).unwrap().stale = None;
    drop(core);
    end_writes(registry, home);
}

// Ticket 385: a holder that answers busy for as long as it lives gets BUSY_TRIES attempts, one log line and one
// state change, then is left alone. Runs itself in a child so the log can be counted.
#[test]
fn a_holder_that_stays_busy_gives_up_once() {
    const CHILD: &str = "NUNCHIRO_TEST_BUSY_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "sessions::tests::a_holder_that_stays_busy_gives_up_once",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "{log}");
        assert_eq!(log.matches("holder not reattached").count(), 0, "{log}");
        assert_eq!(log.matches("holder stayed busy").count(), 1, "{log}");
        return;
    }
    use std::io::{Read, Write};
    let (registry, home, id) = ended_core("busy-once");
    let socket = std::env::temp_dir().join(format!("ns-busy-{}.sock", std::process::id()));
    let _ = fs::remove_file(&socket);
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = attempts.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = stream.write_all(b"\0\0\0\x10\x82peer check busy");
            let _ = stream.read(&mut [0; 1]); // open until the core hangs up, as a holder does
        }
    });
    let pid = std::process::id();
    let started = crate::peer::started(pid).unwrap();
    let mut core = registry.lock().unwrap();
    let entry = core.entry(&id).unwrap();
    entry.pty = None;
    entry.meta.state = SessionState::Running;
    entry.stale = Some(Stale {
        record: crate::holder::Record {
            socket: socket.clone(),
            protocol: crate::holder::frame::PROTOCOL,
            pid,
            started,
        },
        pid,
        started: Some(started),
        run_start: 0,
        retry: std::time::Instant::now(),
        busy: 0,
    });
    for _ in 0..BUSY_TRIES * 3 {
        core.entry(&id).unwrap().stale.as_mut().unwrap().retry = std::time::Instant::now();
        core.refresh().unwrap();
    }
    assert_eq!(
        attempts.load(std::sync::atomic::Ordering::SeqCst),
        BUSY_TRIES as usize
    );
    let entry = core.entry(&id).unwrap();
    assert!(matches!(
        entry.meta.holder_status,
        Some(HolderStatus::NeedsRestart)
    ));
    assert_eq!(entry.meta.state, SessionState::Running);
    entry.stale = None;
    drop(core);
    let _ = fs::remove_file(&socket);
    end_writes(registry, home);
}

// V2-6d: a full quit inside the window finishes the close then, files included.
#[test]
fn stop_inside_window_finishes_close() {
    let (registry, home, id) = ended_core("cu-stop");
    let mut core = registry.lock().unwrap();
    core.handle(Request::Close { id: id.clone() }).unwrap();
    core.handle(Request::Stop).unwrap();
    assert!(core.closing.is_none());
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    drop(core);
    Sessions::drain_scrollback(&registry);
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    drop(registry);
    let _ = fs::remove_dir_all(home);
}

// V2-6d acceptance 6: one pending close at a time. A second close ends the first now (record and files), so
// only the latest is undoable, and each ends deleted.
#[test]
fn close_twice_and_undo_after_new_close() {
    let (registry, home, first) = ended_core("cu-twice");
    let second = {
        let mut core = registry.lock().unwrap();
        let mut launch = core
            .launch(StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.clone(),
                worktree: false,
                label: String::new(),
                args: vec!["/bin/sh".into(), "-c".into(), "printf two".into()],
                model: None,
                effort: None,
                resume: None,
            })
            .prepare()
            .unwrap();
        let id = core.start(&launch).unwrap().id;
        launch.committed = true;
        id
    };
    exited(&registry, &second);
    Sessions::drain_scrollback(&registry);
    let mut core = registry.lock().unwrap();
    core.handle(Request::Close { id: first.clone() }).unwrap();
    core.handle(Request::Close { id: second.clone() }).unwrap();
    assert!(!core.entries.contains_key(&first));
    assert_eq!(crate::scrollback::load(&home, &first).unwrap(), None);
    assert_eq!(
        undo(&mut core, &first).unwrap_err(),
        "this close can no longer be undone"
    );
    assert!(matches!(undo(&mut core, &second), Ok(Reply::Ack)));
    core.handle(Request::Close { id: second.clone() }).unwrap();
    core.finish_close(close_clock() + CLOSE_UNDO_MS);
    let ids = listed(&mut core, Request::Snapshot);
    assert!(!ids.contains(&first) && !ids.contains(&second));
    assert_eq!(crate::scrollback::load(&home, &second).unwrap(), None);
    let (rows, _) = store::load_live(&home).unwrap();
    assert!(rows.iter().all(|s| s.id != first && s.id != second));
    drop(core);
    end_writes(registry, home);
}

// Round 3: a sign-in tab (`without_history`) leaves no scrollback file, on exit or on quit, history on globally.
#[test]
fn sign_in_tab_saves_no_scrollback() {
    let home = scratch("w-login");
    let _ = fs::remove_dir_all(home.join("scrollback"));
    let mut core = Sessions::open(&home).unwrap();
    assert!(core.settings.history().is_some());
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.clone(),
            worktree: false,
            label: "Login: gh".into(),
            args: vec!["/bin/sh".into(), "-c".into(), "printf code-1234".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .without_history()
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    drop(launch);
    assert!(core.entries[&id].meta.no_history);
    let registry = std::sync::Mutex::new(core);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while registry.lock().unwrap().entries[&id].meta.state == SessionState::Running {
        assert!(std::time::Instant::now() < until, "the shell never exited");
        registry.lock().unwrap().handle(Request::Snapshot).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!registry.lock().unwrap().scrollback_pending());
    Sessions::drain_scrollback(&registry);
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    end_writes(registry, home.clone());
}

// V1A-74 follow-up acceptance 3 (threat 2): Close of a row whose write is queued, or being written, leaves no file.
#[test]
fn close_with_pending_write_leaves_no_file() {
    let (registry, home, id) = writes_core("w-close", "printf hello");
    exited(&registry, &id);
    registry.lock().unwrap().close(&id, true, false).unwrap();
    registry.lock().unwrap().finish_close(u64::MAX); // V2-6d: an ended row's files go at the end of its window
    assert!(!registry.lock().unwrap().scrollback_pending());
    Sessions::drain_scrollback(&registry);
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    end_writes(registry, home);

    let (registry, home, id) = writes_core("w-close2", "printf hello");
    exited(&registry, &id);
    settings(
        &mut registry.lock().unwrap(),
        LifetimePatch {
            mask_history: Some(true),
            ..Default::default()
        },
    );
    // A long masked write, so the Close lands while it runs.
    registry
        .lock()
        .unwrap()
        .queue_save(id.clone(), secret_lines(crate::pty::REPLAY_BYTES));
    while_writing(&registry, &id, |core| {
        core.close(&id, true, false).map(drop).unwrap();
        core.finish_close(u64::MAX);
    });
    assert_eq!(crate::scrollback::load(&home, &id).unwrap(), None);
    end_writes(registry, home);
}

// V1A-74 follow-up acceptance 3 (threat 2): of two saves of one id, the newer bytes stay, whether the older is
// still queued or already being written.
#[test]
fn newer_save_wins_over_pending() {
    let (registry, home, id) = writes_core("w-newer", "printf hello");
    exited(&registry, &id);
    {
        let mut core = registry.lock().unwrap();
        core.queue_save(id.clone(), b"older".to_vec());
        core.queue_save(id.clone(), b"newer".to_vec());
        assert_eq!(core.writes.queued.len(), 1);
    }
    Sessions::drain_scrollback(&registry);
    assert_eq!(
        crate::scrollback::load(&home, &id).unwrap().as_deref(),
        Some(&b"newer"[..])
    );
    // Masked, so the older write runs long enough for the newer save to land while it does.
    settings(
        &mut registry.lock().unwrap(),
        LifetimePatch {
            mask_history: Some(true),
            ..Default::default()
        },
    );
    let mut older = secret_lines(crate::pty::REPLAY_BYTES);
    older.extend(b"older\n");
    registry.lock().unwrap().queue_save(id.clone(), older);
    while_writing(&registry, &id, |core| {
        core.queue_save(id.clone(), b"newest".to_vec())
    });
    Sessions::drain_scrollback(&registry);
    assert_eq!(
        crate::scrollback::load(&home, &id).unwrap().as_deref(),
        Some(&b"newest"[..])
    );
    end_writes(registry, home);
}

// V1A-74 follow-up acceptance 4 (threat 1), the failed row: its plain file is masked once masking is on.
#[test]
fn mask_on_rewrites_a_failed_row() {
    let (registry, home, id) = writes_core(
        "w-failed",
        "printf 'API_KEY=hunter2plainvalue\\n'; sleep 30",
    );
    let pid = registry.lock().unwrap().entries[&id].meta.pid.unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !registry.lock().unwrap().entries[&id]
        .pty
        .as_ref()
        .is_some_and(|p| p.snapshot().ends_with(b"value\r\n"))
    {
        assert!(std::time::Instant::now() < until, "no output");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // Reaped at the OS seam, so the core's own wait fails: the row is Failed.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, &mut status, 0) },
        pid as i32
    );
    exited(&registry, &id);
    assert_eq!(
        registry.lock().unwrap().entries[&id].meta.state,
        SessionState::Failed
    );
    Sessions::drain_scrollback(&registry);
    let plain = crate::scrollback::load(&home, &id).unwrap().unwrap();
    assert!(plain.windows(6).any(|w| w == b"hunter"));
    settings(
        &mut registry.lock().unwrap(),
        LifetimePatch {
            mask_history: Some(true),
            ..Default::default()
        },
    );
    Sessions::drain_scrollback(&registry);
    let masked = crate::scrollback::load(&home, &id).unwrap().unwrap();
    assert!(!masked.windows(6).any(|w| w == b"hunter"));
    assert!(masked.windows(10).any(|w| w == b"[redacted:"));
    end_writes(registry, home);
}

// Security review MUST: a plain save already taken by a drain (not yet on disk) when masking turns on is masked
// once it lands.
#[test]
fn mask_on_masks_a_save_being_written() {
    let (registry, home, id) = writes_core("w-inflight", "printf hello");
    exited(&registry, &id);
    let batch = {
        let mut core = registry.lock().unwrap();
        core.queue_save(id.clone(), b"API_KEY=hunter2plainvalue\n".to_vec());
        // As `drain_scrollback` takes it.
        let batch = std::mem::take(&mut core.writes.queued);
        core.writes.writing.insert(id.clone());
        batch
    };
    settings(
        &mut registry.lock().unwrap(),
        LifetimePatch {
            mask_history: Some(true),
            ..Default::default()
        },
    );
    write_scrollback(&home, &batch, std::thread::Builder::new);
    registry.lock().unwrap().writes.writing.clear();
    Sessions::drain_scrollback(&registry);
    let disk = crate::scrollback::load(&home, &id).unwrap().unwrap();
    assert_eq!(disk, b"API_KEY=[redacted:secret]\n");
    end_writes(registry, home);
}

// V1A-74 follow-up acceptance 6: turning masking off rewrites nothing.
#[test]
fn mask_off_changes_nothing_on_disk() {
    let (registry, home, id) = writes_core("w-maskoff", "printf hello");
    exited(&registry, &id);
    Sessions::drain_scrollback(&registry);
    crate::scrollback::save(&home, "other-row", b"API_KEY=hunter2plainvalue\n", false).unwrap();
    let on = LifetimePatch {
        mask_history: Some(true),
        ..Default::default()
    };
    settings(&mut registry.lock().unwrap(), on);
    Sessions::drain_scrollback(&registry);
    let before = [&id[..], "other-row"].map(|id| crate::scrollback::load(&home, id).unwrap());
    assert!(
        !before[1]
            .as_ref()
            .unwrap()
            .windows(6)
            .any(|w| w == b"hunter")
    );
    let off = LifetimePatch {
        mask_history: Some(false),
        ..Default::default()
    };
    settings(&mut registry.lock().unwrap(), off);
    assert!(!registry.lock().unwrap().scrollback_pending());
    Sessions::drain_scrollback(&registry);
    let after = [&id[..], "other-row"].map(|id| crate::scrollback::load(&home, id).unwrap());
    assert_eq!(before, after);
    end_writes(registry, home);
}

// V1A-74 follow-up acceptance 6: history off still leaves no file, a queued or in-flight write included.
#[test]
fn history_off_still_sweeps() {
    let off = || LifetimePatch {
        keep_history: Some(false),
        ..Default::default()
    };
    let (registry, home, id) = writes_core("w-histoff", "printf hello");
    exited(&registry, &id);
    crate::scrollback::save(&home, "other-row", b"x", false).unwrap();
    settings(&mut registry.lock().unwrap(), off());
    assert!(!registry.lock().unwrap().scrollback_pending());
    Sessions::drain_scrollback(&registry);
    assert!(crate::scrollback::saved_ids(&home).unwrap().is_empty());
    settings(
        &mut registry.lock().unwrap(),
        LifetimePatch {
            keep_history: Some(true),
            mask_history: Some(true),
            ..Default::default()
        },
    );
    registry
        .lock()
        .unwrap()
        .queue_save(id.clone(), secret_lines(crate::pty::REPLAY_BYTES));
    while_writing(&registry, &id, |core| {
        settings(core, off());
    });
    assert!(crate::scrollback::saved_ids(&home).unwrap().is_empty());
    end_writes(registry, home);
}

/// Ticket 39: fake `claude` and `codex` (named by argv0), set once and kept: no other unit test runs either by
/// name. Each answers `--version`, then reads its PTY until it closes. Ticket 32: named by path
/// (`FAKE_AGENTS`), so no test changes the process PATH.
pub(super) fn fake_agents() {
    FAKE_AGENTS.get_or_init(|| {
            use std::os::unix::fs::PermissionsExt;
            let bin = scratch("fake-agents");
            // Ticket 1150: asked before a Codex start whether it runs the outward hook, the fake says yes, as every
            // fake `codex` of the tests does (tests/fixtures/codex-app-server).
            let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/codex-app-server");
            let script = format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then\n  case \"$0\" in *codex) echo 'codex-cli 0.161.0';; *) echo '2.1.310 (Claude Code)';; esac\n  exit 0\nfi\n[ \"$1\" != app-server ] || exec '{fixture}'\nexec cat >/dev/null\n"
            );
            for name in ["claude", "codex"] {
                fs::write(bin.join(name), &script).unwrap();
                fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
            }
            let path = |name: &str| bin.join(name).to_str().unwrap().to_string();
            (path("claude"), path("codex"))
        });
}
/// Ticket 39: a registry with one running session to hand off from: a `/bin/cat` shell relabelled Claude.
fn handoff_core(name: &str) -> (std::sync::Mutex<Sessions>, PathBuf, String) {
    fake_agents();
    let home = scratch(name);
    let mut core = Sessions::open(&home).unwrap();
    let id = cat_as(&mut core, &home, AgentKind::Claude);
    (std::sync::Mutex::new(core), home, id)
}
fn cat_as(core: &mut Sessions, home: &Path, kind: AgentKind) -> String {
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.to_path_buf(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    core.entries.get_mut(&id).unwrap().meta.kind = kind;
    id
}
fn end_handoff(registry: std::sync::Mutex<Sessions>, home: PathBuf) {
    let _ = registry.into_inner().unwrap().handle(Request::Stop);
    let _ = fs::remove_dir_all(home);
}
/// What a hand-off could leave behind: the sessions, and the hook and artifact files on disk.
fn handoff_leftovers(registry: &std::sync::Mutex<Sessions>, home: &Path) -> Vec<String> {
    let mut found: Vec<String> = registry.lock().unwrap().entries.keys().cloned().collect();
    for dir in [home.to_path_buf(), home.join("artifacts")] {
        found.extend(
            fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("hooks-") || !n.contains('.')),
        );
    }
    found.sort();
    found
}
/// The texts queued or sent to `id` (the send log keeps a row from the moment it is queued).
fn handed(registry: &std::sync::Mutex<Sessions>, id: &str) -> Vec<String> {
    let core = registry.lock().unwrap();
    let meta = core.snapshot_session(&core.entries[id].meta.clone());
    meta.send_log.iter().map(|s| s.content.clone()).collect()
}

// Ticket 32 acceptance `registry_lock_released_before_prepare`: while a hand-off prepares its new target (version
// probe, worktree), another thread takes the registry and reads it; the hand-off still goes through.
#[test]
fn registry_lock_released_before_prepare() {
    let (registry, home, from) = handoff_core("handoff-prepare");
    let registry = std::sync::Arc::new(registry);
    let (seen, saw) = std::sync::mpsc::channel();
    let other = registry.clone();
    IN_PREPARE.set(Some(Box::new(move || {
        let free = std::thread::spawn(move || other.try_lock().map(|s| s.entries.len()).ok())
            .join()
            .unwrap();
        seen.send(free).unwrap();
    })));
    let reply = handoff_send(
        &registry,
        None,
        &from,
        AgentKind::Codex,
        None,
        "over to you",
    );
    assert_eq!(
        saw.try_recv(),
        Ok(Some(1)),
        "the registry was free during prepare"
    );
    assert!(matches!(reply, Ok(Reply::Switched { .. })), "{reply:?}");
    end_handoff(std::sync::Arc::into_inner(registry).unwrap(), home);
}

// Ticket 39 (V2-3b SHOULD): two Enters reach the lock after both decided and prepared a new target (forced by
// the hook); the decision under the lock starts one target and the second text joins it.
#[test]
fn switch_concurrent_enters_start_one_target() {
    let (registry, home, from) = handoff_core("handoff-race");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let replies = std::thread::scope(|s| {
        ["first text", "second text"]
            .map(|text| {
                let (registry, from, barrier) = (&registry, &from, barrier.clone());
                s.spawn(move || {
                    BEFORE_DECIDE.set(Some(Box::new(move |_| {
                        barrier.wait();
                    })));
                    handoff_send(registry, None, from, AgentKind::Codex, None, text)
                })
            })
            .map(|h| h.join().unwrap())
    });
    let targets: Vec<String> = replies
        .iter()
        .map(|r| match r {
            Ok(Reply::Switched { session, .. }) => session.id.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(targets[0], targets[1], "both texts go to one target");
    let codex: Vec<String> = {
        let core = registry.lock().unwrap();
        core.entries
            .values()
            .filter(|e| e.meta.kind == AgentKind::Codex)
            .map(|e| e.meta.id.clone())
            .collect()
    };
    assert_eq!(
        codex,
        vec![targets[0].clone()],
        "exactly one target session"
    );
    let mut texts = handed(&registry, &targets[0]);
    texts.sort();
    assert_eq!(texts, ["first text", "second text"]);
    end_handoff(registry, home);
}

// Ticket 39 (V2-3b SHOULD): a target's last-run model, effort or account, or the resumed conversation, changed
// between prepare and the lock: the prepared launch is dropped (rolled back) and nothing starts.
#[test]
fn prepared_launch_redecided_when_model_effort_or_account_changed() {
    type Change = fn(&mut Session, String);
    let cases: [(&str, Change); 4] = [
        ("model", |m, _| m.model = Some("gpt-new".into())),
        ("effort", |m, _| m.effort = Some("high".into())),
        ("account", |m, _| m.account = Some("work".into())),
        ("resume", |m, id| m.agent_session_id = Some(id)),
    ];
    for (name, change) in cases {
        let (registry, home, from) = handoff_core(&format!("handoff-redecide-{name}"));
        let earlier = {
            let mut core = registry.lock().unwrap();
            let id = cat_as(&mut core, &home, AgentKind::Codex);
            let meta = &mut core.entries.get_mut(&id).unwrap().meta;
            meta.model = Some("gpt-old".into());
            meta.effort = Some("low".into());
            if name == "resume" {
                // An ended Codex run of this conversation: the target is its resume.
                let conversation = store::new_id().unwrap();
                meta.conversation = Some(conversation.clone());
                meta.agent_session_id = Some(store::new_id().unwrap());
                meta.state = SessionState::Exited;
                core.entries.get_mut(&from).unwrap().meta.conversation = Some(conversation);
            }
            id
        };
        let before = handoff_leftovers(&registry, &home);
        let id = earlier.clone();
        BEFORE_DECIDE.set(Some(Box::new(move |registry| {
            let mut core = registry.lock().unwrap();
            change(
                &mut core.entries.get_mut(&id).unwrap().meta,
                store::new_id().unwrap(),
            );
        })));
        let reply = handoff_send(&registry, None, &from, AgentKind::Codex, None, "go on");
        assert_eq!(
            reply.err().as_deref(),
            Some("handoff target changed; try again"),
            "{name}"
        );
        assert_eq!(handoff_leftovers(&registry, &home), before, "{name}");
        assert!(handed(&registry, &earlier).is_empty(), "{name}");
        end_handoff(registry, home);
    }
}

// Ticket 358
fn approve_fake_claude(home: &Path, args: &[&str]) -> String {
    fake_agents();
    let path = FAKE_AGENTS.get().unwrap().0.clone();
    let args = args.iter().map(|s| s.to_string()).collect();
    let kind = AgentKind::Claude;
    let check = crate::approval::command_check(home, kind, path.clone(), args, vec![]).unwrap();
    crate::approval::command_grant(home, kind, check.hash.as_deref().unwrap()).unwrap();
    path
}
fn claude_start(home: &Path, args: &[&str]) -> StartSession {
    StartSession {
        account: None,
        kind: AgentKind::Claude,
        project: home.to_path_buf(),
        worktree: false,
        label: String::new(),
        args: args.iter().map(|s| s.to_string()).collect(),
        model: None,
        effort: None,
        resume: None,
    }
}

// Threat 1: the approval changes between the check off the lock and the start under it.
#[test]
fn a_start_is_refused_when_the_approval_changes_after_prepare() {
    let home = scratch("command-race");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &["--one"]);
    let launch = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    approve_fake_claude(&home, &["--two"]);
    let refused = core.start(&launch).unwrap_err();
    assert!(refused.contains("changed since"), "{refused}");
    drop(launch);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn an_owner_start_runs_the_approved_path_and_flag_and_stores_neither() {
    use std::os::unix::fs::PermissionsExt;
    let home = scratch("command-argv");
    let mut core = Sessions::open(&home).unwrap();
    let (path, log) = (home.join("my-claude"), home.join("argv.log"));
    let script = format!(
        "#!/bin/sh\n[ \"$1\" = --version ] && {{ echo '2.1.310 (Claude Code)'; exit 0; }}\nprintf '%s\\n' \"$0\" \"$@\" > '{0}.tmp' && mv '{0}.tmp' '{0}'\nexec cat >/dev/null\n",
        log.display()
    );
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let (kind, program) = (AgentKind::Claude, path.display().to_string());
    let args = vec!["--verbose".to_string()];
    let check = crate::approval::command_check(&home, kind, program.clone(), args, vec![]).unwrap();
    crate::approval::command_grant(&home, kind, check.hash.as_deref().unwrap()).unwrap();

    let mut launch = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    // argv.log appears only complete: the fake agent renames it into place, since printf writes in pieces.
    while !log.exists() {
        assert!(std::time::Instant::now() < until, "the agent never ran");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let argv = fs::read_to_string(&log).unwrap();
    assert!(argv.starts_with(&format!("{program}\n")), "{argv}");
    assert!(argv.lines().any(|a| a == "--verbose"), "{argv}");
    let stored = core.entries[&id].args.clone().unwrap();
    assert!(
        stored.is_empty(),
        "a stored copy would replay an argument no longer approved"
    );
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}

// Look 11-17 N2: a Claude session the owner set to Normal (manual) is resumed in manual, not in the stored choice
// for new sessions (Full access when none is stored).
#[test]
fn n2_an_owner_resume_starts_in_the_mode_the_session_ran_in() {
    let home = scratch("n2-resume-mode");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &[]);
    let mut launch = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    assert_eq!(
        launch.permission,
        [START_IN_SKIP],
        "a new start: the stored choice"
    );
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    // Look 1117 v9 N-S3-3: a new start names its mode before Claude draws any footer.
    let meta = core.entries[&id].meta.clone();
    assert_eq!(
        core.snapshot_session(&meta).permission_mode.as_deref(),
        Some("bypass permissions")
    );
    let conversation = core.entries[&id].meta.agent_session_id.clone().unwrap();
    core.entries.get_mut(&id).unwrap().meta.ran_mode = Some("manual".into());
    let mut resume = claude_start(&home, &[]);
    resume.resume = Some(conversation);
    let mut resumed = core.launch(resume).owner_start().prepare().unwrap();
    assert_eq!(
        resumed.permission,
        ["--permission-mode", "manual", ALLOW_SKIP],
        "the mode it ran in"
    );
    // Look 11-17 v3 P5: the chip reads that mode from the start, before Claude draws its footer.
    core.handle(Request::Close { id: id.clone() }).unwrap();
    let again = core.start(&resumed).unwrap();
    resumed.committed = true;
    let meta = core.entries[&again.id].meta.clone();
    assert_eq!(
        core.snapshot_session(&meta).permission_mode.as_deref(),
        Some("manual")
    );
    // Once this core read a footer, a screen without one (a dialog over it) gives none, as before.
    core.entries
        .get_mut(&again.id)
        .unwrap()
        .observer
        .footer_seen = true;
    assert_eq!(core.snapshot_session(&meta).permission_mode, None);
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}

// Ticket 991 (B6 chip): a Codex session the owner starts carries the mode the stored choice started it in, by the
// names Settings > Providers lists, in its start reply, every snapshot while it runs, and sessions.json. Arguments
// that state the permission, a start that is not the owner's, and a row from before this have none (no chip).
#[test]
fn b6_codex_snapshot_carries_the_mode_it_started_in() {
    use PermissionChoice::*;
    let home = scratch("b6-codex-mode");
    let mut core = Sessions::open(&home).unwrap();
    fake_agents();
    let codex = |args: &[&str]| StartSession {
        kind: AgentKind::Codex,
        ..claude_start(&home, args)
    };
    let stored = |home: &Path, id: &str| {
        let file: serde_json::Value =
            serde_json::from_slice(&fs::read(home.join("sessions.json")).unwrap()).unwrap();
        let rows = file["sessions"].as_array().unwrap().clone();
        let row = rows.into_iter().find(|r| r["id"] == id).unwrap();
        row["ran_mode"].as_str().map(String::from)
    };
    for (choice, mode) in [
        (None, "full-access"), // nothing stored: `stored_choice`
        (Some(Own), "own"),
        (Some(Ask), "ask"),
        (Some(AcceptEdits), "ask"), // Codex has no accept-edits: `codex_args`
        (Some(Auto), "auto"),
        (Some(FullAccess), "full-access"),
    ] {
        if let Some(choice) = choice {
            let agent = AgentKind::Codex;
            core.handle(Request::AgentPermissionSet { agent, choice })
                .unwrap();
        }
        let mut launch = core.launch(codex(&[])).owner_start().prepare().unwrap();
        let session = core.start(&launch).unwrap();
        launch.committed = true;
        assert_eq!(session.permission_mode.as_deref(), Some(mode), "{choice:?}");
        let meta = core.entries[&session.id].meta.clone();
        assert_eq!(
            core.snapshot_session(&meta).permission_mode.as_deref(),
            Some(mode),
            "{choice:?}: every snapshot"
        );
        assert_eq!(
            stored(&home, &session.id).as_deref(),
            Some(mode),
            "{choice:?}: stored"
        );
        // An ended session shows no chip.
        core.handle(Request::Close {
            id: session.id.clone(),
        })
        .unwrap();
        if let Some(entry) = core.entries.get(&session.id) {
            let meta = entry.meta.clone();
            assert_eq!(
                core.snapshot_session(&meta).permission_mode,
                None,
                "{choice:?}: closed"
            );
        }
    }
    // The stored choice is Full access here. Arguments that state the permission: the core chose nothing.
    let typed: [&[&str]; 3] = [
        &["-s", "read-only"],
        &["--ask-for-approval=never"],
        &["--approve-for-me"],
    ];
    for args in typed {
        let mut launch = core.launch(codex(args)).owner_start().prepare().unwrap();
        let session = core.start(&launch).unwrap();
        launch.committed = true;
        assert_eq!(session.permission_mode, None, "{args:?}");
        assert_eq!(stored(&home, &session.id), None, "{args:?}");
        core.handle(Request::Close { id: session.id }).unwrap();
    }
    // A start that is not the owner's gets no stored choice, so it has no mode to show.
    let mut launch = core.launch(codex(&[])).prepare().unwrap();
    let session = core.start(&launch).unwrap();
    launch.committed = true;
    assert_eq!(session.permission_mode, None, "not the owner's start");
    // A resume is a new start: it takes the choice stored then, not the earlier run's.
    let agent = AgentKind::Codex;
    core.handle(Request::AgentPermissionSet { agent, choice: Ask })
        .unwrap();
    let conversation = store::new_id().unwrap();
    let entry = core.entries.get_mut(&session.id).unwrap();
    entry.meta.agent_session_id = Some(conversation.clone());
    entry.meta.ran_mode = Some("full-access".into());
    let mut resume = codex(&[]);
    resume.resume = Some(conversation);
    let mut resumed = core.launch(resume).owner_start().prepare().unwrap();
    core.handle(Request::Close { id: session.id }).unwrap();
    let again = core.start(&resumed).unwrap();
    resumed.committed = true;
    assert_eq!(again.permission_mode.as_deref(), Some("ask"), "resumed");
    // Claude's chip is its footer's, as before: a Codex mode name never reaches a Claude row.
    let mut launch = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    let claude = core.start(&launch).unwrap();
    launch.committed = true;
    assert_eq!(claude.permission_mode, None);
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn approved_arguments_reach_owner_starts_only() {
    let home = scratch("command-owner");
    let core = Sessions::open(&home).unwrap();
    let path = approve_fake_claude(&home, &["--verbose"]);
    let prepared = |launch: Launch| {
        let launch = launch.prepare().unwrap();
        let program = launch.command.as_ref().unwrap().path().to_string();
        assert_eq!(program, path);
        launch.approved_args.clone()
    };
    let plain = claude_start(&home, &[]);
    assert_eq!(prepared(core.launch(plain).owner_start()), ["--verbose"]);
    assert!(prepared(core.launch(claude_start(&home, &[]))).is_empty());
    let side = claude_start(&home, &["--permission-mode", "plan", SIDE_CHAT_ARG]);
    assert!(prepared(core.launch(side).owner_start()).is_empty());
    fs::remove_dir_all(home).unwrap();
}

// Ticket 1002 lane 1: the Home seat lock's tests (kept apart: this file passed the publish scan's 1 MiB line).
mod advance_start_tests; // ticket 1081 part B security round
mod gap_tests; // the gap rule
mod home_lock_tests;
mod home_tests; // text left in the terminal comes home
mod lock_followups_tests; // S-m1, Q9 en-b-J7-2, ticket 1002
// Ticket 39: a core that starts stopping after the first decision (set by the hook) refuses the hand-off under
// the lock, before it starts a target or writes any text, both when the target would be reused and when it
// would start. (The check before the first decision: `http_handoff_refused_while_stopping`.)
#[test]
fn handoff_refused_while_stopping_on_reuse_and_start() {
    let stopping = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    for reuse in [true, false] {
        stopping.store(false, std::sync::atomic::Ordering::SeqCst);
        let (registry, home, from) = handoff_core(&format!("handoff-stopping-{reuse}"));
        let running = reuse.then(|| {
            let mut core = registry.lock().unwrap();
            let id = cat_as(&mut core, &home, AgentKind::Codex);
            let conversation = store::new_id().unwrap();
            core.entries.get_mut(&id).unwrap().meta.conversation = Some(conversation.clone());
            core.entries.get_mut(&from).unwrap().meta.conversation = Some(conversation);
            id
        });
        let before = handoff_leftovers(&registry, &home);
        let flag = stopping.clone();
        BEFORE_DECIDE.set(Some(Box::new(move |_| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        })));
        let reply = handoff_send(
            &registry,
            Some(&stopping),
            &from,
            AgentKind::Codex,
            None,
            "go on",
        );
        assert_eq!(
            reply.err().as_deref(),
            Some("core is stopping"),
            "reuse {reuse}"
        );
        assert_eq!(handoff_leftovers(&registry, &home), before, "reuse {reuse}");
        if let Some(id) = running {
            assert!(
                handed(&registry, &id).is_empty(),
                "text written while stopping"
            );
        }
        end_handoff(registry, home);
    }
}
// V2.5-30 (needs 145): the parent link is stored on the child's record; `agent list` only reads it, through the
// same grants as `session list`.
fn spawn(
    core: &mut Sessions,
    launches: &mut Vec<Launch>,
    caller: Option<&crate::grants::Caller>,
) -> crate::grants::Caller {
    let project = core.home.clone();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: project.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let session = match caller {
        Some(caller) => core.start_granted(caller, &launch, false).unwrap(),
        None => core.start(&launch).unwrap(),
    };
    launch.committed = true;
    launches.push(launch);
    crate::grants::Caller {
        id: session.id,
        project,
    }
}
fn ids(reply: Response) -> Vec<String> {
    let Reply::Snapshot { sessions, .. } = reply.unwrap() else {
        panic!("not a list")
    };
    let mut ids: Vec<_> = sessions.into_iter().map(|s| s.id).collect();
    ids.sort();
    ids
}
fn sorted(callers: &[&crate::grants::Caller]) -> Vec<String> {
    let mut ids: Vec<_> = callers.iter().map(|c| c.id.clone()).collect();
    ids.sort();
    ids
}
/// coordinator -> worker -> sub-worker, plus a session nobody started.
fn family(name: &str) -> (Sessions, Vec<Launch>, [crate::grants::Caller; 4]) {
    let mut core = Sessions::open(&scratch(name)).unwrap();
    let mut launches = vec![];
    let coordinator = spawn(&mut core, &mut launches, None);
    let worker = spawn(&mut core, &mut launches, Some(&coordinator));
    let sub = spawn(&mut core, &mut launches, Some(&worker));
    let other = spawn(&mut core, &mut launches, None);
    (core, launches, [coordinator, worker, sub, other])
}
fn end_family(mut core: Sessions, launches: Vec<Launch>) {
    let home = core.home.clone();
    core.handle(Request::Stop).unwrap();
    drop((core, launches));
    let _ = fs::remove_dir_all(home);
}
#[test]
fn parent_stored_on_the_child_record() {
    let (mut core, launches, [coordinator, worker, sub, other]) = family("parent-stored");
    let mut parent = |id: &str| {
        let Reply::Agent { session } = core.handle(Request::AgentGet { id: id.into() }).unwrap()
        else {
            panic!("not an agent")
        };
        session.parent
    };
    assert_eq!(parent(&worker.id), Some(coordinator.id.clone()));
    assert_eq!(parent(&sub.id), Some(worker.id.clone()));
    assert_eq!(parent(&coordinator.id), None);
    assert_eq!(parent(&other.id), None);
    // On disk, so a restarted core still has it (the grants map is memory only).
    let stored = fs::read_to_string(core.home.join("sessions.json")).unwrap();
    for (child, parent) in [(&worker, &coordinator), (&sub, &worker)] {
        let record: serde_json::Value = serde_json::from_str(&stored).unwrap();
        let found = record
            .pointer("/sessions")
            .and_then(|s| s.as_array())
            .into_iter()
            .flatten()
            .find(|s| s["id"] == child.id.as_str())
            .map(|s| s["parent"].clone());
        assert_eq!(found, Some(parent.id.as_str().into()), "{stored}");
    }
    end_family(core, launches);
}
#[test]
fn parent_kept_on_resume() {
    let (mut core, mut launches, [coordinator, worker, _, _]) = family("parent-resume");
    core.handle(Request::Close {
        id: worker.id.clone(),
    })
    .unwrap();
    let conversation = store::new_id().unwrap();
    // Ticket 640: the worker ran in a worktree, a project of its own, so only its parent puts it in the lead's room.
    let worktree = core.home.join("wt");
    fs::create_dir_all(&worktree).unwrap();
    let meta = &mut core.entries.get_mut(&worker.id).unwrap().meta;
    meta.agent_session_id = Some(conversation.clone());
    meta.project = worktree.clone();
    meta.cwd = worktree.clone();
    // The owner resumes the worker's conversation (its tab's Restart): the new run is still the coordinator's worker.
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: worktree.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: Some(conversation),
        })
        .prepare()
        .unwrap();
    let resumed = core.start(&launch).unwrap();
    launch.committed = true;
    launches.push(launch);
    assert_ne!(resumed.id, worker.id);
    assert_eq!(resumed.parent, Some(coordinator.id.clone()));
    // Look 1117 v10 N10-S2-3: the room still names the worker by its old id; the new run carries it.
    assert_eq!(resumed.resumed_from, vec![worker.id.clone()]);
    assert_eq!(
        core.room_project(&resumed.id),
        core.room_project(&coordinator.id),
        "the resumed worker stays in its lead's room"
    );
    // Ticket 640: a restart with no conversation to resume (the tab's fresh start) has no parent and so a room of
    // its own; the window's lost card says so.
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: worktree.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let fresh = core.start(&launch).unwrap();
    launch.committed = true;
    launches.push(launch);
    assert_eq!(fresh.parent, None);
    assert_eq!(core.room_project(&fresh.id), Some(worktree));
    end_family(core, launches);
}
/// Look 1117 v12 S2-B: the user answers yes on a merge card while the lead's seat is not running; the resumed
/// lead hears the yes as its next prompt.
#[test]
fn merge_yes_while_the_lead_is_down_reaches_its_resumed_seat() {
    let (mut core, mut launches, [lead, _, _, _]) = family("merge-yes-resume");
    let conversation = store::new_id().unwrap();
    let meta = &mut core.entries.get_mut(&lead.id).unwrap().meta;
    meta.teammate = Some("main".into());
    meta.agent_session_id = Some(conversation.clone());
    let ledger = crate::ledger::Ledger::open(&core.home);
    let (task, _) = ledger
        .make(&core.home, Some("main"), "Tax in cents", &[], false, 1)
        .unwrap();
    let card = core.ask_merge(&lead.id, &task, "abcdef0123").unwrap();
    core.handle(Request::Close {
        id: lead.id.clone(),
    })
    .unwrap();
    assert_eq!(core.seat_of("main"), None, "the lead is down");
    core.answer(&card, queue::Answer::AllowOnce, true).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: core.home.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: Some(conversation),
        })
        .prepare()
        .unwrap();
    let resumed = core.start(&launch).unwrap();
    launch.committed = true;
    launches.push(launch);
    let meta = &core.entries[&resumed.id].meta;
    assert_eq!(meta.teammate.as_deref(), Some("main"));
    let sent: Vec<_> = meta
        .send_queue
        .iter()
        .chain(&meta.send_log)
        .map(|s| s.content.clone())
        .collect();
    assert!(
        sent.iter().any(
            |c| c.starts_with("The user said yes: merge task t1 (Tax in cents)")
                && c.contains("`git merge abcdef0123`")
        ),
        "{sent:?}"
    );
    end_family(core, launches);
}
/// Look 1117 v13 B N13-S2-1: a task card its lead put in the needs-decision column while a seat waits for the lead
/// is not the person's: the board shows it in Working; the same card waits there once its merge card is open.
#[test]
fn a_task_card_needs_the_person_only_while_its_merge_card_waits() {
    let (mut core, launches, [lead, worker, _, _]) = family("board-task-needs");
    let ledger = crate::ledger::Ledger::open(&core.home);
    let (task, _) = ledger
        .make(
            &core.home,
            Some("main"),
            "q.txt holds one letter",
            &[],
            false,
            1,
        )
        .unwrap();
    let task = ledger
        .seat_on(&task.id, &worker.id, "Builder", None, 2, &|_| true)
        .unwrap();
    let column = |core: &mut Sessions| match core.handle(Request::BoardSnapshot).unwrap() {
        Reply::BoardSnapshot { board } => board
            .cards
            .iter()
            .find(|c| c["title"] == "Task C")
            .map(|c| c["column"].as_str().unwrap().to_string())
            .unwrap(),
        _ => unreachable!(),
    };
    core.handle(Request::BoardAdd {
        title: "Task C".into(),
        group: None,
        reference: None,
        waits_on: None,
        attachments: Some(vec![crate::board::Attachment {
            session_id: worker.id.clone(),
            role: "builder".into(),
        }]),
    })
    .unwrap();
    let id = match core.handle(Request::BoardSnapshot).unwrap() {
        Reply::BoardSnapshot { board } => {
            board.cards.iter().find(|c| c["title"] == "Task C").unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        }
        _ => unreachable!(),
    };
    core.handle(Request::BoardMove {
        source: crate::board::Source::Manual,
        id,
        column: "needs-decision".into(),
    })
    .unwrap();
    assert_eq!(
        column(&mut core),
        "working",
        "blocked on the lead: not the person's"
    );
    core.ask_merge(&lead.id, &task, "abcdef0123").unwrap();
    assert_eq!(column(&mut core), "needs-decision", "its merge card waits");
    end_family(core, launches);
}
/// Look 1117 v13 B N13-S2-2: after a quit and Resume the lead's seats still name its old id as their parent; the
/// resumed lead closes them (so it can clean up their worktrees), and still not another parent's session.
#[test]
fn a_resumed_lead_closes_a_seat_it_started_before_the_resume() {
    let (mut core, mut launches, [lead, worker, _, other]) = family("resumed-lead-close");
    core.handle(Request::Close {
        id: lead.id.clone(),
    })
    .unwrap();
    let conversation = store::new_id().unwrap();
    core.entries
        .get_mut(&lead.id)
        .unwrap()
        .meta
        .agent_session_id = Some(conversation.clone());
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: lead.project.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: Some(conversation),
        })
        .prepare()
        .unwrap();
    let resumed = core.start(&launch).unwrap();
    launch.committed = true;
    launches.push(launch);
    assert_eq!(resumed.resumed_from, vec![lead.id.clone()]);
    let caller = crate::grants::Caller {
        id: resumed.id.clone(),
        project: lead.project.clone(),
    };
    assert!(
        core.handle_agent(
            &caller,
            Request::Close {
                id: other.id.clone()
            }
        )
        .is_err(),
        "not its seat"
    );
    core.handle_agent(
        &caller,
        Request::Close {
            id: worker.id.clone(),
        },
    )
    .unwrap();
    end_family(core, launches);
}
/// Codex security MUST (w20-h): an agent that resumes another ended run's conversation with its own token gets that
/// run's history for the room's names, never its close rights or its `--mine` list.
#[test]
fn an_agent_resume_of_another_run_inherits_no_close_rights() {
    let (mut core, mut launches, [lead, worker, _, other]) = family("agent-resume-close");
    core.handle(Request::Close {
        id: lead.id.clone(),
    })
    .unwrap();
    let conversation = store::new_id().unwrap();
    core.entries
        .get_mut(&lead.id)
        .unwrap()
        .meta
        .agent_session_id = Some(conversation.clone());
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: lead.project.clone(),
            worktree: false,
            label: String::new(),
            args: vec!["/bin/cat".into()],
            model: None,
            effort: None,
            resume: Some(conversation),
        })
        .prepare()
        .unwrap();
    let taken = core.start_granted(&other, &launch, false).unwrap();
    launch.committed = true;
    launches.push(launch);
    assert_eq!(taken.resumed_from, vec![lead.id.clone()]);
    assert!(core.entries[&taken.id].meta.owned_from.is_empty());
    let caller = crate::grants::Caller {
        id: taken.id.clone(),
        project: lead.project.clone(),
    };
    assert!(
        !ids(core.handle_agent(&caller, Request::AgentList { mine: true })).contains(&worker.id),
        "not its seat"
    );
    assert!(
        core.handle_agent(
            &caller,
            Request::Close {
                id: worker.id.clone()
            }
        )
        .is_err(),
        "not its seat"
    );
    end_family(core, launches);
}
#[test]
fn list_respects_grants() {
    let (mut core, launches, [coordinator, worker, sub, other]) = family("parent-grants");
    let all = sorted(&[&coordinator, &worker, &sub, &other]);
    let list = |core: &mut Sessions, caller: &crate::grants::Caller, mine: bool| {
        ids(core.handle_agent(caller, Request::AgentList { mine }))
    };
    // A local session caller sees what its `session list` shows, and `--mine` only its direct children.
    assert_eq!(ids(core.handle_agent(&coordinator, Request::List)), all);
    assert_eq!(list(&mut core, &coordinator, false), all);
    assert_eq!(list(&mut core, &coordinator, true), sorted(&[&worker]));
    assert_eq!(list(&mut core, &worker, true), sorted(&[&sub]));
    assert_eq!(list(&mut core, &other, true), Vec::<String>::new());
    // A remote caller keeps the V1A-04 rule: its own workers only, never more than its `session list`.
    core.grants.remote.insert(coordinator.id.clone());
    assert_eq!(
        ids(core.handle_agent(&coordinator, Request::List)),
        sorted(&[&worker])
    );
    assert_eq!(list(&mut core, &coordinator, false), sorted(&[&worker]));
    assert_eq!(list(&mut core, &coordinator, true), sorted(&[&worker]));
    // The owner outside every session has no "mine".
    assert!(core.handle(Request::AgentList { mine: true }).is_err());
    assert_eq!(ids(core.handle(Request::AgentList { mine: false })), all);
    end_family(core, launches);
}
#[test]
fn list_does_not_mutate_grants() {
    let (mut core, launches, [coordinator, worker, _, _]) = family("parent-readonly");
    core.grants.remote.insert(worker.id.clone());
    let grants = |core: &Sessions| {
        (
            core.grants.parents.clone(),
            core.grants.worktrees.clone(),
            core.grants.remote.clone(),
        )
    };
    let before = grants(&core);
    let stored = fs::read(core.home.join("sessions.json")).unwrap();
    for mine in [false, true] {
        core.handle_agent(&coordinator, Request::AgentList { mine })
            .unwrap();
        core.handle_agent(&worker, Request::AgentList { mine })
            .unwrap();
        let _ = core.handle(Request::AgentList { mine });
    }
    assert_eq!(grants(&core), before);
    assert_eq!(fs::read(core.home.join("sessions.json")).unwrap(), stored);
    end_family(core, launches);
}

// Ticket 1081 (security look on 7f03e3307): the auto-advance resend runs the delivery tick's checks on the original
// row; it never types a copy for a sender the tick would refuse.
fn stuck(core: &mut Sessions, sender: &str, target: &str) -> crate::delivery::Send {
    core.begin_send(sender, target, "stuck line".into(), vec![], true, "queued")
        .unwrap()
}
fn sent_count(core: &Sessions, target: &str) -> usize {
    let meta = &core.entries[target].meta;
    meta.send_queue
        .iter()
        .chain(&meta.send_log)
        .filter(|s| s.content == "stuck line" && s.status != "canceled")
        .count()
}
#[test]
fn a_resend_cancels_a_stuck_row_of_a_revoked_token_sender() {
    let (mut core, home, target, sender) = two_shells("resend1081tok");
    // A token session whose token is gone (no tokens file): the tick refuses its rows.
    core.entry(&sender).unwrap().meta.token_origin = Some("token-revoked".into());
    let row = stuck(&mut core, &sender, &target);
    let _ = core.resend_queued(&target, &row.id);
    assert_eq!(status_of(&core, &target, &row.id), "canceled");
    assert_eq!(
        sent_count(&core, &target),
        0,
        "nothing typed for a revoked sender"
    );
    finish(core, home);
}
#[test]
fn a_resend_does_not_deliver_a_stuck_row_of_a_closed_sender() {
    let (mut core, home, target, sender) = two_shells("resend1081closed");
    let row = stuck(&mut core, &sender, &target);
    core.handle(Request::Close { id: sender.clone() }).unwrap();
    let _ = core.resend_queued(&target, &row.id);
    assert_eq!(status_of(&core, &target, &row.id), "canceled");
    assert_eq!(
        sent_count(&core, &target),
        0,
        "nothing typed for a closed sender"
    );
    finish(core, home);
}
#[test]
fn a_resend_delivers_a_valid_stuck_row_once_with_its_sender_and_stamp() {
    let (mut core, home, target, sender) = two_shells("resend1081ok");
    let row = stuck(&mut core, &sender, &target);
    assert_eq!(row.remote, Some(false));
    // A peer forwarding under the same id later must not restamp the row.
    core.grants.remote.insert(sender.clone());
    let _ = core.resend_queued(&target, &row.id);
    let meta = &core.entries[&target].meta;
    let rows: Vec<_> = meta
        .send_queue
        .iter()
        .chain(&meta.send_log)
        .filter(|s| s.content == "stuck line")
        .collect();
    assert_eq!(rows.len(), 1, "one row, not a copy: {rows:?}");
    assert_eq!(rows[0].id, row.id);
    assert_eq!(rows[0].sender, sender);
    assert_eq!(rows[0].remote, Some(false));
    assert!(
        matches!(rows[0].status.as_str(), "delivered" | "attempting"),
        "{rows:?}"
    );
    finish(core, home);
}

// Ticket 1081 (security look 2 on 668d1524e): auto-advance's nudge and heartbeat are the core's own lines. They are
// sent as the core, never under a seat's identity, and pass one check (core_may) before the write and before a queued
// row is delivered: a seat whose token was revoked gets nothing.
const CORE_LINE: &str = "core line 1081";
fn core_seats(name: &str) -> (Sessions, PathBuf, String, String) {
    let (mut core, home, builder, lead) = two_shells(name);
    core.entry(&lead).unwrap().meta.teammate = Some("lead-1081".into());
    let ledger = crate::ledger::Ledger::open(&home);
    let (task, _) = ledger
        .make(&home, Some("lead-1081"), "tax", &[], false, 1)
        .unwrap();
    ledger
        .seat_on(&task.id, &builder, "Builder · tax", None, 1, &|_| true)
        .unwrap();
    (core, home, builder, lead)
}
fn core_rows_of(core: &Sessions, target: &str) -> Vec<crate::delivery::Send> {
    let meta = &core.entries[target].meta;
    meta.send_queue
        .iter()
        .chain(&meta.send_log)
        .filter(|s| s.content == CORE_LINE)
        .cloned()
        .collect()
}
#[test]
fn core_line_to_a_ready_seat_with_a_revoked_token_is_not_written() {
    let (mut core, home, builder, lead) = core_seats("coreline1081ready");
    // The nudge goes to the builder, the heartbeat to the lead's own seat.
    for target in [builder.clone(), lead.clone()] {
        core.entry(&target).unwrap().meta.token_origin = Some("token-revoked".into());
        let sent = core.core_line(&target, CORE_LINE.into());
        assert!(sent.is_err(), "{target}: {sent:?}");
        assert!(
            core_rows_of(&core, &target).is_empty(),
            "{target}: nothing typed"
        );
    }
    finish(core, home);
}
#[test]
fn a_queued_core_line_to_a_seat_whose_token_was_revoked_is_not_delivered() {
    let (mut core, home, builder, lead) = core_seats("coreline1081queued");
    for target in [builder.clone(), lead.clone()] {
        // Not ready: a send on its way holds the queue.
        core.delivery_inflight.insert(target.clone(), u64::MAX);
        core.core_line(&target, CORE_LINE.into()).unwrap();
        let rows = core_rows_of(&core, &target);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "queued");
        core.entry(&target).unwrap().meta.token_origin = Some("token-revoked".into());
        core.delivery_inflight.remove(&target);
        core.flush_delivery().unwrap();
        assert_eq!(
            status_of(&core, &target, &rows[0].id),
            "canceled",
            "{target}"
        );
    }
    finish(core, home);
}
#[test]
fn a_core_line_to_a_valid_seat_is_delivered_as_the_core() {
    let (mut core, home, builder, lead) = core_seats("coreline1081ok");
    for target in [builder.clone(), lead.clone()] {
        core.core_line(&target, CORE_LINE.into()).unwrap();
        let rows = core_rows_of(&core, &target);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].sender, "core");
        assert!(
            matches!(rows[0].status.as_str(), "delivered" | "attempting"),
            "{rows:?}"
        );
    }
    // Auto-advance off in the place: the core types nothing more there.
    crate::ledger::Ledger::open(&home)
        .set_place(&home, None, None, Some(false))
        .unwrap();
    assert!(core.core_line(&builder, CORE_LINE.into()).is_err());
    assert_eq!(core_rows_of(&core, &builder).len(), 1);
    finish(core, home);
}

// Ticket 1085: an automatic line the core pastes into a lead's input box (a worker's wake line, the room's notice, the
// core's heartbeat) and the owner's next message are two submissions, never one. Before the fix the window composer's
// text was typed right behind a paste whose Enter waited, and a dropped Enter left the line in the box for the owner's
// words to join.
const OWNER_1085: &str = "owner words 1085";
fn automatic_1085() -> [(&'static str, String); 3] {
    [
        ("worker-1085", "worker w1 done".to_string()),
        ("", crate::room::notice(3)), // the seat itself sends its notice (room.rs)
        (CORE, crate::advance::beat_line(0, 2, 1).unwrap()),
    ]
}
/// A Claude seat with bracketed paste on, its box showing `shown`; the automatic line pasted, its Enter pending.
fn pasted_1085(name: &str, sender: &str, text: &str, shown: &str) -> Flood {
    let screen = format!(
        "\x1b[?2004h\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} {shown}\r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
    );
    let mut f = unobserved(name, screen.as_bytes());
    f.core.tick().unwrap();
    let id = f.id.clone();
    let sender = if sender.is_empty() {
        id.clone()
    } else {
        sender.to_string()
    };
    let row = f
        .core
        .begin_send(&sender, &id, text.into(), vec![], true, "attempting")
        .unwrap();
    if sender != id {
        f.core.wake_rows.insert(row.id.clone());
    }
    if sender == CORE {
        f.core.core_rows.insert(row.id.clone());
    }
    assert_eq!(
        f.core.write_send(&id, &row),
        Ok(true),
        "pasted, its Enter waits"
    );
    f
}
fn paste_1085(text: &str) -> Vec<u8> {
    [b"\x1b[200~", text.as_bytes(), b"\x1b[201~"].concat()
}
/// Writes the pending Enter now (as at its settle deadline).
fn enter_1085(f: &mut Flood) {
    let id = f.id.clone();
    f.core.pending_enter.get_mut(&id).unwrap().written -= SETTLE * (PASTE_WAIT + 1);
    f.core.flush_enters().unwrap();
    assert!(!f.core.pending_enter.contains_key(&id), "the Enter went");
}
fn owner_sends_1085(f: &mut Flood) {
    f.core
        .handle(text_request(f, OWNER_1085, true, &[]))
        .unwrap();
    composer_keys(f, &["enter"], &[]).unwrap();
}
#[test]
fn t1085_owner_words_wait_behind_a_pasted_automatic_line() {
    for (i, (sender, text)) in automatic_1085().into_iter().enumerate() {
        let mut f = pasted_1085(&format!("t1085-pending-{i}"), sender, &text, "");
        owner_sends_1085(&mut f);
        assert_eq!(
            got(&f),
            paste_1085(&text),
            "{text}: nothing typed behind the paste"
        );
        enter_1085(&mut f);
        hook(&mut f, "UserPromptSubmit");
        hook(&mut f, "Stop");
        f.core.deliver().unwrap();
        enter_1085(&mut f);
        let want = [
            paste_1085(&text),
            b"\r".to_vec(),
            paste_1085(OWNER_1085),
            b"\r".to_vec(),
        ]
        .concat();
        assert_eq!(
            String::from_utf8_lossy(&got(&f)),
            String::from_utf8_lossy(&want),
            "{text}: two submissions"
        );
        let owner: Vec<_> = rows(&f)
            .into_iter()
            .filter(|s| s.sender == "user")
            .collect();
        assert_eq!(owner.len(), 1);
        assert_eq!(
            (owner[0].content.as_str(), owner[0].status.as_str()),
            (OWNER_1085, "delivered")
        );
    }
}
#[test]
fn t1085_a_dropped_automatic_line_is_cleared_and_goes_after_the_owner() {
    for (i, (sender, text)) in automatic_1085().into_iter().enumerate() {
        let mut f = pasted_1085(&format!("t1085-dropped-{i}"), sender, &text, &text);
        let id = f.id.clone();
        // A permission request comes up before the Enter: the Enter is dropped, the line stays in the box.
        let now = queue::now_ms();
        let tool = serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls"}});
        f.core
            .queue
            .observe(&id, "PermissionRequest", &tool, "hook", now)
            .unwrap();
        f.core.flush_enters().unwrap();
        assert!(!f.core.pending_enter.contains_key(&id));
        let auto = rows(&f).into_iter().find(|s| s.content == text).unwrap();
        assert_eq!(
            auto.status, "queued",
            "{text}: it waits in the queue, not in the box"
        );
        f.core
            .queue
            .observe(&id, "PostToolUse", &serde_json::json!({}), "hook", now + 1)
            .unwrap();
        assert!(pending_ids(&f).is_empty());
        owner_sends_1085(&mut f);
        // Ctrl+U clears the line the core left (one box row: two Ctrl+U per row and one more), then the owner's words.
        let typed = [
            paste_1085(&text),
            b"\x15\x15\x15".to_vec(),
            OWNER_1085.as_bytes().to_vec(),
            b"\r".to_vec(),
        ]
        .concat();
        assert_eq!(
            String::from_utf8_lossy(&got(&f)),
            String::from_utf8_lossy(&typed),
            "{text}: the owner's words alone"
        );
        // The line goes again after the owner's turn, alone, through every delivery check once more: the room's notice
        // (the seat is its own sender) is written; the wake line's and the heartbeat's senders are no live worker and no
        // auto-advance task in this fixture, so those checks cancel them and nothing more is typed.
        hook(&mut f, "UserPromptSubmit");
        hook(&mut f, "Stop");
        // Ticket 1121: the agent took his message and drew its box empty; the line goes again only into a box read so.
        let empty = format!(
            "\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} \r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
        );
        f.core
            .entries
            .get_mut(&id)
            .unwrap()
            .observer
            .screen
            .feed(empty.as_bytes());
        f.core.deliver().unwrap();
        let auto = |f: &Flood| rows(f).into_iter().find(|s| s.content == text).unwrap();
        if sender.is_empty() {
            enter_1085(&mut f);
            let want = [typed, paste_1085(&text), b"\r".to_vec()].concat();
            assert_eq!(
                String::from_utf8_lossy(&got(&f)),
                String::from_utf8_lossy(&want),
                "{text}"
            );
            assert_eq!(auto(&f).status, "delivered", "{text}");
            assert_eq!(
                recorded(&f.home),
                crate::record::Day {
                    delivered: 1,
                    resent: 1,
                    person: 0
                },
                "{text}: the dropped line the core sent again (his words went as keys, not a queued row)"
            );
        } else {
            assert_eq!(
                String::from_utf8_lossy(&got(&f)),
                String::from_utf8_lossy(&typed),
                "{text}"
            );
            assert_eq!(auto(&f).status, "canceled", "{text}");
        }
    }
}
/// Ticket 1085: words typed by hand after the dropped line make the box the owner's: nothing in it is cleared.
#[test]
fn t1085_words_typed_by_hand_are_never_cleared() {
    let (sender, text) = automatic_1085()[1].clone();
    let mut f = pasted_1085("t1085-hand", sender, &text, &text);
    let id = f.id.clone();
    let now = queue::now_ms();
    let tool = serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls"}});
    f.core
        .queue
        .observe(&id, "PermissionRequest", &tool, "hook", now)
        .unwrap();
    f.core.flush_enters().unwrap();
    f.core
        .queue
        .observe(&id, "PostToolUse", &serde_json::json!({}), "hook", now + 1)
        .unwrap();
    f.core.handle(text_request(&f, "x", false, &[])).unwrap(); // a key typed in the terminal
    owner_sends_1085(&mut f);
    assert!(!got(&f).contains(&0x15), "no Ctrl+U");
}

// Ticket 1113: only the current lead may tidy a foreign session; owner answers never become session authority.
#[test]
fn lead_session_tidy_uses_owner_cards_and_preserves_builder_close_rules() {
    let (mut core, launches, [lead, builder, _, target]) = family("session-tidy");
    let mate: crate::team::Teammate = serde_json::from_value(serde_json::json!({
        "id":"", "name":"Lead", "job":"Lead this place", "kind":"claude",
        "project":lead.project, "lead":true
    }))
    .unwrap();
    let mate = crate::team::Team::open(&core.home)
        .save(None, mate)
        .unwrap()
        .remove(0);
    core.entries.get_mut(&lead.id).unwrap().meta.teammate = Some(mate.id);
    core.grants.remote.insert(lead.id.clone());
    assert!(
        core.tidy_session(&lead, &target.id, "Unused account", queue::now_ms())
            .is_err()
    );
    core.grants.remote.remove(&lead.id);
    core.entries.get_mut(&target.id).unwrap().meta.machine = Some("other-machine".into());
    assert!(
        core.tidy_session(&lead, &target.id, "Unused account", queue::now_ms())
            .is_err()
    );
    core.entries.get_mut(&target.id).unwrap().meta.machine = None;
    core.entries.get_mut(&target.id).unwrap().meta.project = lead.project.join("another-place");
    assert!(
        core.tidy_session(&lead, &target.id, "Unused account", queue::now_ms())
            .is_err()
    );
    core.entries.get_mut(&target.id).unwrap().meta.project = lead.project.clone();
    assert!(
        core.tidy_session(&lead, &target.id, "  ", queue::now_ms())
            .is_err()
    );
    assert!(
        core.tidy_session(&builder, &target.id, "Unused account", queue::now_ms())
            .is_err()
    );
    assert!(
        core.handle_agent(
            &builder,
            Request::Close {
                id: target.id.clone()
            }
        )
        .is_err()
    );
    core.handle_agent(
        &lead,
        Request::SessionTidy {
            id: target.id.clone(),
            why: "Unused account".into(),
        },
    )
    .unwrap();
    assert_eq!(core.entries[&target.id].meta.state, SessionState::Running);
    let card = core.queue.owner_items().remove(0);
    assert!(
        core.handle_agent(
            &lead,
            Request::Answer {
                item: card.id.clone(),
                answer: queue::Answer::AllowOnce,
                confirmed: true
            }
        )
        .is_err()
    );
    assert!(
        core.handle_agent(
            &target,
            Request::Answer {
                item: card.id.clone(),
                answer: queue::Answer::AllowOnce,
                confirmed: true
            }
        )
        .is_err()
    );
    core.handle(Request::Answer {
        item: card.id,
        answer: queue::Answer::Deny,
        confirmed: false,
    })
    .unwrap();
    assert!(core.queue.owner_items().is_empty());
    assert_eq!(core.entries[&target.id].meta.state, SessionState::Running);
    core.tidy_session(&lead, &target.id, "Unused account", queue::now_ms())
        .unwrap();
    let card = core.queue.owner_items().remove(0);
    core.handle(Request::Answer {
        item: card.id,
        answer: queue::Answer::AllowOnce,
        confirmed: true,
    })
    .unwrap();
    assert!(core.queue.owner_items().is_empty());
    assert_ne!(core.entries[&target.id].meta.state, SessionState::Running);
    end_family(core, launches);
}

// Ticket 1113: missing history alone never proves a session empty. A known untouched first-run picker does.
#[test]
fn lead_closes_only_a_proven_empty_first_run_directly() {
    let (mut core, launches, [lead, _, _, target]) = family("tidy-empty");
    let mate: crate::team::Teammate = serde_json::from_value(serde_json::json!({
        "id":"", "name":"Lead", "job":"Lead this place", "kind":"claude",
        "project":lead.project, "lead":true
    }))
    .unwrap();
    let mate = crate::team::Team::open(&core.home)
        .save(None, mate)
        .unwrap()
        .remove(0);
    core.entries.get_mut(&lead.id).unwrap().meta.teammate = Some(mate.id);
    let at = queue::now_ms() + 10 * 60_000 + 1000;
    assert!(
        !core.empty_session(&target.id, at),
        "a shell without a transcript is unknown"
    );
    let e = core.entries.get_mut(&target.id).unwrap();
    e.meta.kind = AgentKind::Claude;
    e.observer.before_box = true;
    e.observer.screen.feed(b"Choose the text style that looks best with your terminal\r\nTo change this later, run /theme\r\n1. Dark mode\r\n2. Light mode\r\n");
    assert!(
        !core.empty_session(&target.id, queue::now_ms()),
        "ten minutes must pass"
    );
    assert!(core.empty_session(&target.id, at));
    core.touch_input(&target.id);
    assert!(
        !core.empty_session(&target.id, at),
        "even unsubmitted keys or a draft need a card"
    );
    core.touched.remove(&target.id);
    core.entries
        .get_mut(&target.id)
        .unwrap()
        .observer
        .transcript = Some(core.home.join("conversation.jsonl"));
    assert!(!core.empty_session(&target.id, at));
    core.entries
        .get_mut(&target.id)
        .unwrap()
        .observer
        .transcript = None;
    core.entries
        .get_mut(&target.id)
        .unwrap()
        .observer
        .before_box = false;
    assert!(
        !core.empty_session(&target.id, at),
        "a restored session has uncertain history"
    );
    core.entries
        .get_mut(&target.id)
        .unwrap()
        .observer
        .before_box = true;
    core.tidy_session(&lead, &target.id, "No work in this account", at)
        .unwrap();
    assert!(core.queue.owner_items().is_empty());
    assert_ne!(core.entries[&target.id].meta.state, SessionState::Running);
    let room = crate::room::Log::open(&core.home, &lead.project)
        .read()
        .unwrap();
    assert!(format!("{room:?}").contains("Closed empty session"));
    assert!(room.iter().filter_map(|m| m.team.as_ref()).any(|n| {
        n.what == "session_empty_closed"
            && n.name
                .as_deref()
                .unwrap_or_default()
                .contains("No work in this account")
    }));
    end_family(core, launches);
}

// Plan checkpoint m1576: Home has no extra cross-project close authority in this round.
#[test]
fn home_lead_cannot_tidy_another_project() {
    let (mut core, launches, [lead, _, _, target]) = family("tidy-home-scope");
    let home = crate::team::Team::open(&core.home).home();
    fs::create_dir_all(&home).unwrap();
    let mate: crate::team::Teammate = serde_json::from_value(serde_json::json!({
        "id":"", "name":"Home lead", "job":"Lead Home", "kind":"claude", "lead":true
    }))
    .unwrap();
    let mate = crate::team::Team::open(&core.home)
        .save(None, mate)
        .unwrap()
        .remove(0);
    let meta = &mut core.entries.get_mut(&lead.id).unwrap().meta;
    meta.teammate = Some(mate.id);
    meta.project = home;
    assert!(
        core.tidy_session(&lead, &target.id, "Unused account", queue::now_ms())
            .is_err()
    );
    assert!(core.queue.owner_items().is_empty());
    assert_eq!(core.entries[&target.id].meta.state, SessionState::Running);
    end_family(core, launches);
}

#[test]
fn session_tidy_is_never_a_browser_request() {
    assert!(!crate::http::browser::request_allowed(
        &Request::SessionTidy {
            id: "target".into(),
            why: "Unused account".into(),
        }
    ));
}

/// Ticket 1121: Claude's footer rows under the box (the auto-mode line, a usage ring, the agents' dots) are no dialog;
/// read as one, no box showed and every Enter was dropped. Two marked rows there are a radio list, as before.
#[test]
fn t1121_status_rows_under_the_box_are_no_choice() {
    let rule = "─".repeat(120);
    let auto = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents";
    let boxed =
        |row: &str, footer: &str| format!("⏺ done\n\n{rule}\n{row}\n{rule}\n{auto}\n{footer}\n");
    let claude = |s: &str| composer(s, AgentKind::Claude);
    for footer in [
        "  ○ 6%",
        "  ● 100%",
        "  ◔ 26%",
        "  📊 ctx ○ 7%/1M │ 🔴 7d 92%",
    ] {
        assert_eq!(
            claude(&boxed("❯ ", footer)).as_deref(),
            Some(""),
            "{footer}"
        );
        assert_eq!(
            claude(&boxed("❯ 1 new message: run nunchiro agent check", footer)).as_deref(),
            Some("1 new message: run nunchiro agent check"),
            "{footer}"
        );
    }
    assert_eq!(
        claude(&boxed("❯ hi", "  ● Yes\n  ○ No")),
        None,
        "a radio list"
    );
    // The real screen of an idle 2.1.331 Builder (06055124, 11-25) as the core read it: the bottom rule lost, the footer
    // in pieces. Its Enter was dropped as "composer" and the message sat typed in the box.
    let real = format!(
        "✻ Churned for 25m 6s · done 9:32 AM\n\n{}\n❯\n\n\n         ◔ 30%             2      8\n                  (shift+tab to cycle) · ← 2 agents\n",
        "─".repeat(160)
    );
    assert_eq!(claude(&real).as_deref(), Some(""));
    let low = real.replace("◔ 30%", "○ 6%");
    assert_eq!(claude(&low).as_deref(), Some(""), "the ring below 12%");
    let typed = real.replace("❯\n", "❯ 1 new message: run nunchiro agent check\n");
    assert_eq!(
        claude(&typed).as_deref(),
        Some("1 new message: run nunchiro agent check")
    );
    // Review r2: a single marked choice under the box is a dialog, ring or not of the box.
    assert_eq!(
        claude(&boxed("❯ hi", "  ● Continue")),
        None,
        "one radio choice"
    );
    assert_eq!(claude(&boxed("❯ hi", "  ● main   ◯ worker-a")), None);
    // Review r2: with the bottom rule lost, only Claude's footer words make it the box.
    assert_eq!(
        claude(&format!("{rule}\n❯ hi\n\n  some other text\n")),
        None,
        "no footer words"
    );
    assert_eq!(
        claude(&format!(
            "{rule}\n❯ hi\n\n  ● Continue\n  (shift+tab to cycle)\n"
        )),
        None
    );
    // With the rule lost, an option under the row is still a dialog, and so is a numbered row.
    assert_eq!(claude(&format!("{rule}\n❯ hi\n  1. Yes\n  2. No")), None);
    assert_eq!(claude(&format!("{rule}\n❯ 1. Yes\n  2. No")), None);
    assert_eq!(claude(&format!("{rule}\n❯ hi\n   ❯ Yes")), None);
    assert_eq!(
        claude(&boxed("❯ hi", "  ❯ 1. Yes\n    2. No")),
        None,
        "a cursor list"
    );
}
/// Ticket 1121: a dropped row goes again only into a box the screen reads free of its earlier copy. While the box
/// shows that copy the core clears it (Ctrl+U) and pastes nothing; the box read empty takes it once. The owner's
/// message arrived as six glued copies.
#[test]
fn t1121_a_repaste_never_glues() {
    let footer = "\r\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents\r\n  ○ 6%\r\n";
    let copy = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi there\r\n{RULE}{footer}");
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}{footer}");
    let shell = |s: &str| {
        s.replace('\x1b', "\\033")
            .replace("\r\n", "\\r\\n")
            .replace('%', "%%")
    };
    let mut f = flood_script(
        "t1121-repaste",
        copy.as_bytes(),
        &format!(
            "cat > got <&0 &\ncat burst\nj=0; while [ ! -f empty ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\n",
            shell(&empty)
        ),
    );
    wait_end(&f, copy.len());
    f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Claude;
    catch_up(&mut f);
    let id = f.id.clone();
    hook(&mut f, "UserPromptSubmit");
    f.core.prompt_as_user(&id, "hi there".into()).unwrap();
    let row = rows(&f)
        .into_iter()
        .find(|s| s.content == "hi there")
        .unwrap();
    f.core.drops.insert(row.id.clone(), 1);
    f.core.left_typed.insert(id.clone());
    hook(&mut f, "Stop");
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    let copies = |f: &Flood| got(f).windows(8).filter(|w| w == b"hi there").count();
    assert_eq!(copies(&f), 0, "pasted behind its own copy");
    assert!(got(&f).contains(&0x15), "the copy is cleared first");
    fs::write(f.home.join("empty"), "").unwrap();
    wait_end(&f, copy.len() + empty.len());
    catch_up(&mut f);
    w14_tick_until(&mut f, 20, "the empty box never took it", |f| {
        copies(f) == 1
    });
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    assert_eq!(copies(&f), 1, "once");
}
/// Ticket 1121: past REPASTES drops a row waits in the queue and is never pasted again, even into an empty box.
#[test]
fn t1121_repastes_are_bounded() {
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    let mut f = unobserved("t1121-bound", empty.as_bytes());
    catch_up(&mut f);
    let id = f.id.clone();
    hook(&mut f, "UserPromptSubmit");
    f.core.prompt_as_user(&id, "hi there".into()).unwrap();
    let row = rows(&f)
        .into_iter()
        .find(|s| s.content == "hi there")
        .unwrap();
    f.core.drops.insert(row.id.clone(), REPASTES + 1);
    hook(&mut f, "Stop");
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    assert!(
        !got(&f).windows(8).any(|w| w == b"hi there"),
        "pasted past the bound"
    );
    assert_eq!(send_row(&f, &row.id).status, "queued");
    // The delivery record: the core gave up on his prompt, so it needs a person, once (his cancel counts no more).
    let person = crate::record::Day {
        delivered: 0,
        resent: 0,
        person: 1,
    };
    assert_eq!(recorded(&f.home), person, "given up: needs a person");
    for _ in 0..3 {
        f.core.tick().unwrap();
    }
    f.core
        .handle(Request::CancelSend {
            id: id.clone(),
            send: row.id.clone(),
        })
        .unwrap();
    assert_eq!(recorded(&f.home), person, "counted once");
}
/// A dropped row goes again only into an empty box. Codex's box held the owner's half-typed words with the row's copy
/// behind them (`› half typed reply ok #9`): read as free of the copy, the row was pasted behind it two more times. A
/// box whose first row is blank and whose words are below is not empty either (Codex look).
#[test]
fn a_dropped_row_is_never_pasted_again_behind_other_words() {
    for (name, frame) in [
        ("drop-glued", "\u{203a} half typed reply ok #9\r\n"),
        ("drop-below", "\u{203a} \r\n  half typed\r\n"),
    ] {
        let screen = format!("\x1b[2J\x1b[H{frame}\r\n  gpt-5-codex medium · /p\r\n");
        let mut f = unobserved(name, screen.as_bytes());
        f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Codex;
        catch_up(&mut f);
        let id = f.id.clone();
        hook(&mut f, "UserPromptSubmit");
        f.core.prompt_as_user(&id, "reply ok #9".into()).unwrap();
        let row = rows(&f)
            .into_iter()
            .find(|s| s.content == "reply ok #9")
            .unwrap();
        f.core.drops.insert(row.id.clone(), 1);
        f.core.left_typed.insert(id.clone());
        hook(&mut f, "Stop");
        for _ in 0..5 {
            f.core.tick().unwrap();
        }
        assert!(
            !got(&f).windows(11).any(|w| w == b"reply ok #9"),
            "{name}: pasted again behind other words"
        );
        assert_eq!(send_row(&f, &row.id).status, "queued", "{name}");
    }
}
/// Words typed by hand into Codex's box mark it edited, as Claude's, until the owner's Enter sends them or the box
/// reads empty (a Stop's Esc marks it too, and Codex's box is not cleared after a Stop).
#[test]
fn hand_typed_words_mark_a_codex_box_edited() {
    let codex = |name: &str, row: &str| {
        let screen = format!("\x1b[2J\x1b[H\u{203a} {row}\r\n\r\n  gpt-5-codex medium · /p\r\n");
        let mut f = unobserved(name, screen.as_bytes());
        f.core.entries.get_mut(&f.id).unwrap().meta.kind = AgentKind::Codex;
        catch_up(&mut f);
        f
    };
    let mut f = codex("codex-edited", "half typed");
    let id = f.id.clone();
    f.core
        .handle(text_request(&f, "half typed ", false, &[]))
        .unwrap();
    assert!(f.core.box_edited(&id), "typed text");
    f.core.handle(text_request(&f, "\r", false, &[])).unwrap();
    assert!(!f.core.box_edited(&id), "his Enter sent it");
    stop_keys(&mut f, &["backspace"], &[]).unwrap();
    assert!(f.core.box_edited(&id), "a key");
    stop_keys(&mut f, &["enter"], &[]).unwrap();
    assert!(!f.core.box_edited(&id), "his Enter key");
    let mut f = codex("codex-stopped", "");
    let id = f.id.clone();
    stop_keys(&mut f, &["esc"], &[]).unwrap();
    assert!(f.core.entries[&id].input.edited(), "the Stop marks it");
    assert!(!f.core.box_edited(&id), "an empty box holds no words");
}
/// Ticket 1121 (review r1): at exactly REPASTES drops the row still goes into an empty box, once; one drop more stops it
/// and the snapshot names it, so the composer can say it will not go again.
#[test]
fn t1121_the_repaste_bound_is_exact() {
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    for (n, pasted) in [(REPASTES, true), (REPASTES + 1, false)] {
        let mut f = unobserved(&format!("t1121-edge-{n}"), empty.as_bytes());
        catch_up(&mut f);
        let id = f.id.clone();
        hook(&mut f, "UserPromptSubmit");
        f.core.prompt_as_user(&id, "hi there".into()).unwrap();
        let row = rows(&f)
            .into_iter()
            .find(|s| s.content == "hi there")
            .unwrap();
        f.core.drops.insert(row.id.clone(), n);
        hook(&mut f, "Stop");
        for _ in 0..5 {
            f.core.tick().unwrap();
        }
        let copies = got(&f).windows(8).filter(|w| w == b"hi there").count();
        assert_eq!(copies, usize::from(pasted), "{n} drops");
        let snap = f.core.snapshot_session(&f.core.entries[&id].meta);
        assert_eq!(snap.stopped_sends.contains(&row.id), !pasted, "{n} drops");
        if !pasted {
            assert_eq!(send_row(&f, &row.id).status, "queued");
            let json = serde_json::to_value(&snap).unwrap();
            assert_eq!(json["stopped_sends"][0], row.id.as_str());
        }
    }
}
/// Ticket 1121 (review r1): while the box may hold the core's dropped copy, a later message is not pasted into a box the
/// screen does not read (the clear would write no Ctrl+U and glue it to the copy). A box read empty takes it once; with
/// none read for CLEAN_WAIT it stops and waits in the queue, named in the snapshot.
#[test]
fn t1121_a_later_row_waits_for_a_read_box() {
    let unread = "\x1b[2J\x1b[H  working on something\r\n";
    let mut f = unobserved("t1121-later", unread.as_bytes());
    catch_up(&mut f);
    let id = f.id.clone();
    // One finished turn: an idle agent is ready though its box does not read (the incident's seats).
    hook(&mut f, "UserPromptSubmit");
    hook(&mut f, "Stop");
    f.core.left_typed.insert(id.clone());
    f.core.prompt_as_user(&id, "new words".into()).unwrap();
    let row = rows(&f)
        .into_iter()
        .find(|s| s.content == "new words")
        .unwrap();
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    let copies = |f: &Flood| got(f).windows(9).filter(|w| w == b"new words").count();
    assert_eq!(copies(&f), 0, "pasted into an unread box");
    assert!(
        f.core.clean_wait.contains_key(&row.id),
        "the guard holds it"
    );
    // The wait ran out: stopped, still queued, never pasted, even into a box read later.
    let long_ago = std::time::Instant::now() - CLEAN_WAIT - std::time::Duration::from_secs(1);
    f.core
        .clean_wait
        .insert(row.id.clone(), (long_ago, std::time::Instant::now()));
    f.core.tick().unwrap();
    let snap = f.core.snapshot_session(&f.core.entries[&id].meta);
    assert_eq!(snap.stopped_sends, vec![row.id.clone()]);
    assert_eq!(send_row(&f, &row.id).status, "queued");
    // A new message goes once the box reads empty.
    let empty = format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} \r\n{RULE}\r\n");
    f.core
        .entries
        .get_mut(&id)
        .unwrap()
        .observer
        .screen
        .feed(empty.as_bytes());
    f.core.prompt_as_user(&id, "fresh one".into()).unwrap();
    w14_tick_until(&mut f, 20, "the read box never took the new message", |f| {
        got(f).windows(9).any(|w| w == b"fresh one")
    });
    assert!(
        !f.core.left_typed.contains(&id),
        "the fresh send cleared the copy tracking"
    );
    // Review r2: the stopped row stays stopped once nothing guards the box any more.
    // The fixture has no bracketed paste: the fresh message went with its Enter; its turn runs and ends.
    hook(&mut f, "UserPromptSubmit");
    hook(&mut f, "Stop");
    for _ in 0..5 {
        f.core.tick().unwrap();
    }
    assert_eq!(copies(&f), 0, "the stopped row never went");
    assert_eq!(send_row(&f, &row.id).status, "queued");
}
/// Ticket 1121 (review r1): an automatic line held with no clean box for CLEAN_WAIT fails, as its second drop does; it
/// never waits in the queue for ever.
#[test]
fn t1121_a_stopped_automatic_line_fails() {
    let unread = "\x1b[2J\x1b[H  working on something\r\n";
    let mut f = unobserved("t1121-auto", unread.as_bytes());
    catch_up(&mut f);
    let id = f.id.clone();
    hook(&mut f, "UserPromptSubmit");
    hook(&mut f, "Stop");
    let row = f
        .core
        .begin_send(&id, &id, "room notice".into(), vec![], true, "queued")
        .unwrap();
    f.core.retried.insert(row.id.clone());
    f.core.tick().unwrap();
    assert_eq!(send_row(&f, &row.id).status, "queued");
    let long_ago = std::time::Instant::now() - CLEAN_WAIT - std::time::Duration::from_secs(1);
    f.core
        .clean_wait
        .insert(row.id.clone(), (long_ago, std::time::Instant::now()));
    f.core.tick().unwrap();
    assert_eq!(send_row(&f, &row.id).status, "failed");
    assert!(!got(&f).windows(11).any(|w| w == b"room notice"));
    assert_eq!(
        recorded(&f.home),
        crate::record::Day {
            delivered: 0,
            resent: 0,
            person: 1
        },
        "an automatic line given up on needs a person, once"
    );
}
/// Ticket 1121 review r2: the box proof never writes the Enter past output not read yet. A dialog drawn after the box
/// showed the paste would take it.
#[test]
fn t1121_box_proof_waits_for_unread_output() {
    let boxed =
        format!("\x1b[2J\x1b[H{RULE}\r\n\u{276f} hi\r\n{RULE}\r\n  (shift+tab to cycle)\r\n");
    let dialog = " Pick one\r\n \u{276f} 1. Yes\r\n   2. No\r\n";
    let mut f = flood_script(
        "t1121-proof-unread",
        boxed.as_bytes(),
        &format!(
            "printf '{}'\nhead -c 1 >/dev/null\ncat > got <&0 &\ncat burst\nj=0; while [ ! -f more ] && [ $j -lt 3000 ]; do sleep 0.01; j=$((j+1)); done\nprintf '{}'\nsleep 30\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n"),
            dialog.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let Ok(Reply::Delivery { send }) = f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: "hi".into(),
    }) else {
        panic!("the prompt was not taken")
    };
    wait_end(&f, PROMPT.len() + boxed.len());
    catch_up(&mut f);
    f.core.flush_enters().unwrap(); // the box shows the paste: held
    assert!(f.core.pending_enter[&f.id].held);
    // The dialog is drawn and not read yet; the paste is late and the output is not quiet.
    fs::write(f.home.join("more"), "").unwrap();
    wait_end(&f, PROMPT.len() + boxed.len() + dialog.len());
    let enter = f.core.pending_enter.get_mut(&f.id).unwrap();
    enter.written -= SETTLE;
    enter.quiet = std::time::Instant::now();
    f.core.flush_enters().unwrap();
    assert!(
        f.core.pending_enter.contains_key(&f.id),
        "the Enter waits for the unread output"
    );
    assert!(!got(&f).contains(&b'\r'), "no Enter past unread output");
    assert_ne!(send_row(&f, &send.id).status, "delivered");
}

/// Ticket 1130 B-L3 round 2: a home with one session on a raw `cat`, read as a Claude seat (as the room tests do).
fn seat_1130(tag: &str) -> (PathBuf, Sessions, String) {
    let home = std::env::temp_dir().join(format!("ns-1130-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(home.join("p")).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let script = home.join("echo.sh");
    fs::write(&script, "#!/bin/sh\nstty raw -echo\nexec cat\n").unwrap();
    fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let mut core = Sessions::open(&home).unwrap();
    let mut launch = core
        .launch(StartSession {
            account: None,
            kind: AgentKind::Shell,
            project: home.join("p"),
            worktree: false,
            label: "seat".into(),
            args: vec![script.to_str().unwrap().into()],
            model: None,
            effort: None,
            resume: None,
        })
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    core.entries.get_mut(&id).unwrap().meta.kind = AgentKind::Claude;
    (home, core, id)
}

/// Ticket 1130 B-L3 round 2 (finding 5): the close a new conversation makes keeps the old seat's row, also when its
/// agent exited a moment before (the exit race): `close` would take the two-phase path for such a row and it would be
/// gone from History ten seconds later.
#[test]
fn end_seat_keeps_the_row_of_a_seat_whose_run_just_ended() {
    let (home, mut core, id) = seat_1130("endseat");
    // As the tick records an agent's exit.
    core.entries.get_mut(&id).unwrap().meta.state = SessionState::Exited;
    core.end_seat(&id).unwrap();
    core.finish_close(u64::MAX);
    assert!(core.entries.contains_key(&id), "its row stays in History");
    assert!(core.closing.is_none());
    // A running seat is closed, and its row stays as well.
    core.entries.get_mut(&id).unwrap().meta.state = SessionState::Running;
    core.end_seat(&id).unwrap();
    core.finish_close(u64::MAX);
    assert_eq!(core.entries[&id].meta.state, SessionState::Closed);
    core.stop().unwrap();
    fs::remove_dir_all(home).unwrap();
}

/// Ticket 1130 B-L3 round 5: History keeps the newest 50 closed rows. A row an Undo holds (`hold_row`) or a resumed
/// ACP run still loads from (`acp_loading`) is neither dropped nor counted, however old it is; let go, it is an
/// ordinary closed row again and the next close past the bound takes it.
#[test]
fn the_closed_row_bound_spares_held_and_loading_rows() {
    let (home, mut core, held) = seat_1130("held");
    let start = |core: &mut Sessions, label: &str| {
        let mut launch = core
            .launch(StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: home.join("p"),
                worktree: false,
                label: label.into(),
                args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
                model: None,
                effort: None,
                resume: None,
            })
            .prepare()
            .unwrap();
        let id = core.start(&launch).unwrap().id;
        launch.committed = true;
        id
    };
    let close = |core: &mut Sessions, id: &str| core.close(id, true, false).unwrap();
    let loading = start(&mut core, "loading");
    // The two oldest closed rows, then 60 newer ones.
    close(&mut core, &held);
    close(&mut core, &loading);
    core.hold_row(&held, true);
    core.acp_loading
        .insert("a-resumed-run".into(), vec![loading.clone()]);
    for n in 0..60 {
        let id = start(&mut core, &format!("s{n}"));
        close(&mut core, &id);
    }
    assert!(core.entries.contains_key(&held), "held for an Undo");
    assert!(
        core.entries.contains_key(&loading),
        "a resume loads from it"
    );
    let closed = |core: &Sessions| {
        core.entries
            .values()
            .filter(|e| e.meta.state == SessionState::Closed)
            .count()
    };
    assert_eq!(closed(&core), CLOSED_KEEP + 2, "and neither is counted");
    core.hold_row(&held, false);
    core.acp_loading.clear();
    let id = start(&mut core, "last");
    close(&mut core, &id);
    assert!(!core.entries.contains_key(&held) && !core.entries.contains_key(&loading));
    assert_eq!(closed(&core), CLOSED_KEEP);
    core.stop().unwrap();
    fs::remove_dir_all(home).unwrap();
}
