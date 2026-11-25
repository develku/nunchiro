//! Follow-ups around the Home seat lock and the registry lock (S-m1, Q9 en-b-J7-2).
use super::*;

// S-m1 (ticket 1002): a real locked-seat start carries neither the login shell's variables nor the core's own
// inherited ones (a core started from a terminal has its exports), only `SEAT_KEEP` and Nunchiro's own; an unlocked
// shell keeps both. The held environment and the set variable are process-wide; no other unit test reads them.
#[test]
fn a_locked_seat_gets_no_login_shell_or_core_variable() {
    use std::os::unix::fs::PermissionsExt;
    crate::user_env::hold(Ok(vec![("W35_LOGIN_ONLY".into(), "secret".into())]));
    // SAFETY: a name no other code reads; set before this test's own starts.
    unsafe { std::env::set_var("W35_CORE_ONLY", "secret") };
    let home = scratch("lockedenv");
    let mut core = Sessions::open(&home).unwrap();
    // A fake Claude that writes the environment it started with (`ps -E` shows none on this macOS).
    let claude = home.join("claude");
    let script = "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit 0; fi\nenv > \"$0.env\"\nexec cat >/dev/null\n";
    fs::write(&claude, script).unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let path = claude.to_str().unwrap().to_string();
    let check =
        crate::approval::command_check(&home, AgentKind::Claude, path, vec![], vec![]).unwrap();
    crate::approval::command_grant(&home, AgentKind::Claude, check.hash.as_deref().unwrap())
        .unwrap();
    fs::create_dir_all(home.join("team/home")).unwrap();
    let seat = crate::team::Team::open(&home).home();
    let mut launch = core
        .launch(StartSession {
            project: seat,
            ..claude_start(&home, &[])
        })
        .owner_start()
        .prepare()
        .unwrap();
    let locked = core.start(&launch).unwrap().id;
    launch.committed = true;
    assert!(core.entries[&locked].meta.home_lock);
    let mut shell = core
        .launch(StartSession {
            kind: AgentKind::Shell,
            args: [
                "/bin/sh",
                "-c",
                "env | grep ^W35_ > \"$0\"; exec cat",
                home.join("shell.env").to_str().unwrap(),
            ]
            .map(String::from)
            .into(),
            ..claude_start(&home, &[])
        })
        .prepare()
        .unwrap();
    core.start(&shell).unwrap();
    shell.committed = true;
    let read = |file: &str| {
        let file = home.join(file);
        for _ in 0..100 {
            if let Ok(text) =
                fs::read_to_string(&file).map(|t| t.lines().map(String::from).collect::<Vec<_>>())
                && !text.is_empty()
            {
                return text;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("{file:?} was not written");
    };
    let (seat_env, shell_env) = (read("claude.env"), read("shell.env"));
    let has = |env: &[String], line: &str| env.iter().any(|l| l == line || l.starts_with(line));
    for line in ["W35_LOGIN_ONLY=secret", "W35_CORE_ONLY=secret"] {
        assert!(has(&shell_env, line), "an unlocked shell lost {line}");
        assert!(!has(&seat_env, line), "a locked seat got {line}");
    }
    for line in ["HOME=", "PATH=", "NUNCHIRO_HOME=", "TERM=xterm-256color"] {
        assert!(has(&seat_env, line), "a locked seat lost {line}");
    }
    // The agents' config folders the core has stay (the builder starts from the core's environment).
    let mut cmd = CommandBuilder::new("/bin/true");
    cmd.env("CLAUDE_CONFIG_DIR", "/own/claude");
    cmd.env("CODEX_HOME", "/own/codex");
    cmd.env("W35_DROPPED", "1");
    Sessions::seat_env(&core.settings, &mut cmd, true);
    assert_eq!(
        cmd.get_env("CLAUDE_CONFIG_DIR"),
        Some("/own/claude".as_ref())
    );
    assert_eq!(cmd.get_env("CODEX_HOME"), Some("/own/codex".as_ref()));
    assert_eq!(cmd.get_env("W35_DROPPED"), None);
    let _ = core.handle(Request::Stop);
    let _ = fs::remove_dir_all(&home);
}

// Q9 en-b-J7-2: a plain Codex start's hook check (stats of `.codex/hooks.json`, `plugins`, `config.toml` in every
// ancestor) is read while the launch is prepared, and `start`, under the registry lock, uses that answer.
#[test]
fn codex_hooks_check_is_read_with_the_launch_not_under_the_lock() {
    fake_agents();
    let home = scratch("codexhooks");
    let mut core = Sessions::open(&home).unwrap();
    let plain = |core: &Sessions| {
        let mut launch = core.launch(StartSession {
            account: None,
            kind: AgentKind::Codex,
            project: home.clone(),
            worktree: false,
            label: String::new(),
            args: vec![],
            model: None,
            effort: None,
            resume: None,
        });
        (launch.cwd, launch.project) = (home.clone(), home.clone());
        launch.id = store::new_id().unwrap();
        launch
    };
    // The prepare step: the check runs (answered by the hook, so no real ~/.codex is read) and its answer is kept.
    let mut prepared = plain(&core);
    let codex_home = home.join("codex-home");
    fs::create_dir_all(&codex_home).unwrap();
    prepared.config = Some(("CODEX_HOME", codex_home)); // the sandbox read stays in the scratch folder
    IN_HOOKS_CHECK.set(Some(Box::new(|| true)));
    prepared.read_codex_sandbox();
    prepared.committed = true;
    assert!(
        IN_HOOKS_CHECK.take().is_none(),
        "the prepare step ran the check"
    );
    assert_eq!(prepared.codex_hooks_clear, Some(true));
    // The start under the lock: a check there would panic.
    let mut launch = plain(&core);
    (launch.codex_read_only, launch.codex_hooks_clear) = (Some(false), Some(true));
    launch.ask_codex().unwrap(); // ticket 1150: asked off the lock too, as `prepare` does
    IN_HOOKS_CHECK.set(Some(Box::new(|| {
        panic!("the hook check ran under the registry lock")
    })));
    let started = core.start(&launch);
    launch.committed = true;
    assert!(started.is_ok(), "{started:?}");
    assert!(IN_HOOKS_CHECK.take().is_some(), "start ran the check");
    let _ = core.handle(Request::Stop);
    let _ = fs::remove_dir_all(&home);
}

// Q9 en-b-J7-2: the owner's Codex model switch reads the same hook check off the registry lock, and leaves no answer
// behind for a later switch.
#[test]
fn codex_switch_reads_the_hooks_check_off_the_lock() {
    fake_agents(); // ticket 1150: the switch asks its Codex before the restart; never the installed one
    let home = scratch("codexswitch");
    let mut core = Sessions::open(&home).unwrap();
    let id = cat_as(&mut core, &home, AgentKind::Codex);
    let registry = std::sync::Arc::new(std::sync::Mutex::new(core));
    let free = registry.clone();
    IN_HOOKS_CHECK.set(Some(Box::new(move || {
        assert!(
            free.try_lock().is_ok(),
            "the hook check ran under the registry lock"
        );
        true
    })));
    let request = Request::SwitchModel {
        id,
        model: Some("gpt-5".into()),
        effort: None,
        fast: None,
        ultracode: None,
    };
    let _ = crate::sessions::switch_model(&registry, request); // the cat agent is refused later; the read is what counts
    assert!(
        IN_HOOKS_CHECK.take().is_none(),
        "the switch never ran the check"
    );
    let mut core = registry.lock().unwrap();
    assert!(core.switch_hooks.is_none());
    let _ = core.handle(Request::Stop);
    drop(core);
    let _ = fs::remove_dir_all(&home);
}
