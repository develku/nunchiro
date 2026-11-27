//! Ticket 1002 lane 1: the Home seat lock (prepare, start, inheritance, the locked caller, mode 4 reuse).
use super::*;

// Ticket 1002 lane 1: a Claude seat in the Home folder starts locked in the Settings > Assistants mode on every path;
// a project seat is unchanged.
#[test]
fn home_seat_starts_locked_in_the_chosen_mode() {
    use crate::home_lock::{MODE_KEY, locked};
    let home = scratch("home-lock");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &[]);
    fs::create_dir_all(home.join("team/home/notes")).unwrap();
    let seat = crate::team::Team::open(&home).home();
    let at = |dir: &Path, args: &[&str]| StartSession {
        project: dir.to_path_buf(),
        ..claude_start(&home, args)
    };
    let prepared = |core: &Sessions, owner: bool, ran: Option<&str>| {
        let mut launch = core.launch(at(&seat, &[]));
        launch.ran_mode = ran.map(String::from);
        let launch = if owner { launch.owner_start() } else { launch };
        let launch = launch.prepare().unwrap();
        (launch.permission.clone(), launch.home_mode)
    };
    use crate::home_lock::Mode;
    for (mode, owner, first, lock) in [
        (None, true, "manual", Mode::Ask),
        (Some("accept-edits"), true, "acceptEdits", Mode::AcceptEdits),
        (Some("full-access"), true, "acceptEdits", Mode::Full),
        (
            Some("full-access-shell"),
            true,
            "acceptEdits",
            Mode::FullShell,
        ),
        // Concept rule 6, Fable check M8: a schedule's or a lead's open never runs above Accept edits.
        (
            Some("full-access-shell"),
            false,
            "acceptEdits",
            Mode::AcceptEdits,
        ),
    ] {
        match mode {
            Some(m) => core.settings.features.insert(MODE_KEY.into(), m.into()),
            None => core.settings.features.remove(MODE_KEY),
        };
        let (permission, home_mode) = prepared(&core, owner, None);
        assert!(locked(&permission), "{mode:?}");
        assert_eq!(home_mode, Some(lock), "{mode:?}");
        // Fable check M3: never Skip permissions; always restricted.
        assert!(
            !permission.iter().any(|a| a.contains("dangerously")),
            "{permission:?}"
        );
        assert!(permission.contains(&"--restricted".to_string()));
        assert_eq!(permission[1], first, "{mode:?}: {permission:?}");
    }
    // A resume takes the chosen mode, not the footer's last one; a subfolder of Home is Home.
    core.settings.features.remove(MODE_KEY);
    let (resumed, _) = prepared(&core, true, Some("bypass permissions"));
    assert_eq!(resumed[..2], ["--permission-mode", "manual"]);
    let sub = core.launch(at(&seat.join("notes"), &[])).prepare().unwrap();
    assert!(locked(&sub.permission));
    // An argument that would widen or replace the lock is refused, typed or approved.
    let typed = core
        .launch(at(&seat, &["--dangerously-skip-permissions"]))
        .prepare();
    assert!(typed.err().unwrap().contains("Settings > Assistants"));
    approve_fake_claude(&home, &["--settings=/tmp/x.json"]);
    let approved = core.launch(at(&seat, &[])).owner_start().prepare();
    assert!(approved.err().unwrap().contains("Settings > Assistants"));
    approve_fake_claude(&home, &[]);
    // A start that lost its lock is refused under the start lock.
    let mut bare = core.launch(at(&seat, &[])).prepare().unwrap();
    bare.permission.clear();
    assert!(core.start(&bare).unwrap_err().contains("lock is missing"));
    // A project seat is unchanged: the owner's stored choice (none: Full access), no lock.
    let project = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    assert_eq!(project.permission, [START_IN_SKIP]);
    assert!(!locked(&project.permission));
    // Settings refuses a mode it does not know.
    let patch = LifetimePatch {
        features: Some([(MODE_KEY.to_string(), serde_json::json!("auto"))].into()),
        ..Default::default()
    };
    let refused = core.handle(Request::QuitSettings { patch }).unwrap_err();
    assert!(refused.contains(MODE_KEY), "{refused}");
    // Connectors off: the Home seat starts with the strict empty MCP config (no account connector loads); a project
    // seat never gets it.
    let strict = |a: &[String]| a.iter().any(|w| w == "--strict-mcp-config");
    assert!(!strict(&prepared(&core, true, None).0));
    let off = crate::home_lock::CONNECTORS_OFF_KEY;
    core.settings.features.insert(off.into(), true.into());
    let (cut, _) = prepared(&core, true, None);
    assert!(strict(&cut) && locked(&cut), "{cut:?}");
    let project_off = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    assert!(!strict(&project_off.permission));
    core.settings.features.remove(off);
    let patch = LifetimePatch {
        features: Some([(off.to_string(), serde_json::json!("yes"))].into()),
        ..Default::default()
    };
    assert!(
        core.handle(Request::QuitSettings { patch })
            .unwrap_err()
            .contains(off)
    );
    drop((bare, project, sub));
    fs::remove_dir_all(home).unwrap();
}

// Ticket 1130 S1: a full-access project session (Claude's Skip permissions) carries the outward hook, with Nunchiro's own
// hooks turned off too; its run blocks the call when it fails.
#[test]
fn t1130_full_access_project_session_has_the_outward_hook() {
    let home = scratch("outward-hook");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &[]);
    core.settings.disable_hook_injection = true;
    let project = home.join("project");
    fs::create_dir_all(&project).unwrap();
    let mut launch = core
        .launch(StartSession {
            project: project.clone(),
            ..claude_start(&home, &[])
        })
        .owner_start()
        .prepare()
        .unwrap();
    assert_eq!(launch.home_mode, None);
    assert!(
        launch
            .permission
            .iter()
            .any(|a| a == crate::agent_permission::START_IN_SKIP),
        "{:?}",
        launch.permission
    );
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join(format!("hooks-{id}.json"))).unwrap()).unwrap();
    let pre = file["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 1, "{pre:?}");
    assert_eq!(pre[0]["matcher"], "Bash|mcp__.*");
    assert!(
        pre[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with(" hook outward")
    );
    assert_eq!(pre[0]["hooks"][0]["onFailure"], "block");
    fs::remove_dir_all(home).unwrap();
}

// Ticket 1130 round 2 (Codex 3): a project whose own settings turn every hook off still runs the outward hook. Claude
// reads its layers user < project < local < `--settings` (managed above all, not ours), so the effective
// `disableAllHooks` is the last layer's that sets it.
#[test]
fn t1130_project_cannot_disable_the_outward_hook() {
    let home = scratch("outward-nohooks");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &[]);
    let project = home.join("project");
    fs::create_dir_all(project.join(".claude")).unwrap();
    let off = serde_json::json!({"disableAllHooks": true});
    for name in ["settings.json", "settings.local.json"] {
        fs::write(project.join(".claude").join(name), off.to_string()).unwrap();
    }
    let mut launch = core
        .launch(StartSession {
            project: project.clone(),
            ..claude_start(&home, &[])
        })
        .owner_start()
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    let flag: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join(format!("hooks-{id}.json"))).unwrap()).unwrap();
    let layers = [off.clone(), off, flag.clone()];
    let effective = layers
        .iter()
        .rev()
        .find_map(|l| l["disableAllHooks"].as_bool());
    assert_eq!(effective, Some(false), "{flag}");
    assert!(
        flag["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["hooks"][0]["command"]
                .as_str()
                .is_some_and(|c| c.ends_with(" hook outward"))),
        "{flag}"
    );
    fs::remove_dir_all(home).unwrap();
}

// Ticket 1002 lane 1 (check MUST 1): a session a locked Home seat starts, in any folder, carries the lock; its hook
// file holds the lock's own hook, beside Nunchiro's.
#[test]
fn a_home_seats_child_inherits_the_lock() {
    use crate::home_lock::locked;
    let home = scratch("home-lock-child");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &[]);
    fs::create_dir_all(home.join("team/home")).unwrap();
    let seat = crate::team::Team::open(&home).home();
    let key = crate::home_lock::MODE_KEY;
    core.settings
        .features
        .insert(key.into(), "full-access-shell".into());
    // Fable check M2: the lock hook is there even with Nunchiro's own hooks turned off.
    core.settings.disable_hook_injection = true;
    let mut launch = core
        .launch(StartSession {
            project: seat.clone(),
            ..claude_start(&home, &[])
        })
        .owner_start()
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    assert!(core.entries[&id].meta.home_lock);
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join(format!("hooks-{id}.json"))).unwrap()).unwrap();
    let commands: Vec<&str> = file["hooks"]["PreToolUse"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|b| b["hooks"][0]["command"].as_str())
        .collect();
    // Decision B: the owner's "Full access, shell included" start; its run blocks the call when it fails (M1).
    // Ticket 1130 S1: the outward hook follows, leaving the seat's connector calls to the Outbox card.
    assert_eq!(commands.len(), 2, "{commands:?}");
    assert!(
        commands[0].ends_with(" hook home-lock --mode full-access-shell"),
        "{commands:?}"
    );
    assert!(
        commands[1].ends_with(" hook outward --home-lock"),
        "{commands:?}"
    );
    assert_eq!(
        file["hooks"]["PreToolUse"][0]["hooks"][0]["onFailure"],
        "block"
    );
    assert_eq!(file["disableAllHooks"], false);
    assert_eq!(file["disableSkillShellExecution"], true);
    let caller = crate::grants::Caller {
        id: id.clone(),
        project: seat.clone(),
    };
    let elsewhere = scratch("home-lock-elsewhere");
    // Fable review R1a: a child stays in the Home folder (a subfolder is Home); one elsewhere is refused.
    let work = seat.join("work");
    fs::create_dir_all(&work).unwrap();
    let outside = core
        .launch_as(Some(&caller), claude_start(&elsewhere, &[]), false)
        .unwrap()
        .prepare();
    assert!(outside.err().unwrap().contains("stays in the Home folder"));
    let child = core
        .launch_as(Some(&caller), claude_start(&work, &[]), false)
        .unwrap()
        .prepare()
        .unwrap();
    assert!(locked(&child.permission));
    // Rule 6: a child never runs above Accept edits, so its shell asks again.
    assert_eq!(child.home_mode, Some(crate::home_lock::Mode::AcceptEdits));
    // Fable check M5: the seat asks the core for its own work only.
    let refused = |request: Request| core.check_agent(&caller, &request).unwrap_err();
    let shell_start = StartSession {
        kind: AgentKind::Shell,
        args: vec!["/bin/cat".into()],
        ..claude_start(&elsewhere, &[])
    };
    for request in [
        Request::Start {
            session: shell_start.clone(),
            folder: None,
            env: Default::default(),
            receipt: None,
        },
        Request::Start {
            session: claude_start(&work, &["--bare"]),
            folder: None,
            env: Default::default(),
            receipt: None,
        },
        Request::Start {
            session: claude_start(&elsewhere, &[]),
            folder: None,
            env: Default::default(),
            receipt: None,
        },
        // Codex MUST: no worktree requests at all.
        serde_json::from_value(serde_json::json!({"op":"worktree","operation":"list","project":null,"path":null,"branch":null,"base":"","label":""})).unwrap(),
        Request::SendText {
            id: "someone-else".into(),
            text: "osascript".into(),
            seen: vec![],
            composer: false,
        },
        Request::AgentPrompt {
            id: "someone-else".into(),
            text: "send it".into(),
        },
        Request::Stop,
    ] {
        assert!(
            refused(request.clone()).contains("seat lock"),
            "{request:?}"
        );
    }
    assert_eq!(
        core.check_agent(&caller, &Request::AgentGet { id: id.clone() }),
        Ok(())
    );
    // Final review S6: a child starts in the Home folder itself; a subfolder (whose `.claude` the parent could write)
    // is refused.
    let start_in = |dir: &Path| Request::Start {
        session: claude_start(dir, &[]),
        folder: None,
        env: Default::default(),
        receipt: None,
    };
    assert!(core.check_agent(&caller, &start_in(&seat)).is_ok());
    assert!(refused(start_in(&work)).contains("seat lock"));
    // Fable round 3 review M1: a session the seat counts as started (an adopted worker from before the lock) is its
    // own only while locked.
    let mut free_child = core
        .launch_as(None, claude_start(&elsewhere, &[]), false)
        .unwrap()
        .prepare()
        .unwrap();
    let adopted = core.start(&free_child).unwrap().id;
    free_child.committed = true;
    core.entries.get_mut(&adopted).unwrap().meta.parent = Some(id.clone());
    let prompt = Request::AgentPrompt {
        id: adopted.clone(),
        text: "send it".into(),
    };
    assert!(
        core.check_agent(&caller, &prompt)
            .unwrap_err()
            .contains("seat lock")
    );
    core.entries.get_mut(&adopted).unwrap().meta.home_lock = true;
    assert_eq!(core.check_agent(&caller, &prompt), Ok(()));
    // M5d: agent-sent text never opens the seat's bash mode or a slash command.
    for text in ["!osascript -e x", " /schedule daily", "#remember", "&run"] {
        let e = core
            .send_inner("agent", &id, text.into(), vec![], true, false)
            .unwrap_err();
        assert!(e.contains("may not start"), "{text}: {e}");
    }
    let shell = core
        .launch_as(
            Some(&caller),
            StartSession {
                kind: AgentKind::Shell,
                args: vec!["/bin/cat".into()],
                ..claude_start(&work, &[])
            },
            false,
        )
        .unwrap()
        .prepare();
    assert!(shell.err().unwrap().contains("only Claude"));
    // Fable review R6: a Codex seat in the Home folder is refused, the owner's too.
    let codex = core
        .launch(StartSession {
            kind: AgentKind::Codex,
            ..claude_start(&work, &[])
        })
        .owner_start()
        .prepare();
    assert!(codex.err().unwrap().contains("Home seats are Claude"));
    // Fable review R4: no hand-off from a locked seat.
    let handoff = core.handoff_target(&id, AgentKind::Codex, None);
    assert!(handoff.err().unwrap().contains("not handed off"));
    // A session no locked one started stays as it was.
    let free = core
        .launch_as(None, claude_start(&elsewhere, &[]), false)
        .unwrap()
        .prepare()
        .unwrap();
    assert!(!locked(&free.permission));
    drop((child, free));
    let _ = core.handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(elsewhere).unwrap();
}

// Ticket 1002 lane 1 (Fable review R5): a Home lead the owner left open in "Full access, shell included" takes no
// scheduled task; the schedule gets the line the owner sees.
#[test]
fn a_mode_four_seat_takes_no_scheduled_task() {
    use crate::team::{Opener, Team, Teammate, open_seat};
    let (registry, home, _) = ended_core("home-lock-mode4");
    approve_fake_claude(&home, &[]);
    let team = Team::open(&home);
    let mate = team
        .save(
            None,
            Teammate {
                id: String::new(),
                name: "Chief".into(),
                job: "Keeps the house.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: None,
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .remove(0);
    registry.lock().unwrap().settings.features.insert(
        crate::home_lock::MODE_KEY.into(),
        "full-access-shell".into(),
    );
    let seat = open_seat(&registry, &mate.id, None, None, Opener::Window)
        .unwrap()
        .session;
    assert_eq!(seat.home_mode.as_deref(), Some("full-access-shell"));
    let refused = open_seat(
        &registry,
        &mate.id,
        Some("read the mail"),
        None,
        Opener::Schedule("brief", crate::pressure::Who::Session),
    )
    .err()
    .unwrap();
    assert!(refused.contains("Full access, shell included"), "{refused}");
    // The owner's own open of the same seat still reaches it.
    assert!(open_seat(&registry, &mate.id, None, None, Opener::Window).is_ok());
    let _ = registry.lock().unwrap().handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}

// Ticket 1002 lane 1 (Codex look, round 3): a Home seat whose record is from before the lock (no `home_lock`, no
// `home_mode`) is never reused: a scheduled task opens a locked seat, and the old one ends once the new one runs.
#[test]
fn a_seat_from_before_the_lock_is_replaced_not_reused() {
    use crate::team::{Opener, Team, Teammate, open_seat};
    let (registry, home, _) = ended_core("home-lock-old-record");
    approve_fake_claude(&home, &[]);
    let mate = Team::open(&home)
        .save(
            None,
            Teammate {
                id: String::new(),
                name: "Chief".into(),
                job: "Keeps the house.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: None,
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .remove(0);
    let old = open_seat(&registry, &mate.id, None, None, Opener::Window)
        .unwrap()
        .session;
    {
        // The record as a core from before the lock wrote it, read back by this one.
        let mut core = registry.lock().unwrap();
        let entry = core.entry(&old.id).unwrap();
        let mut stored = serde_json::to_value(&entry.meta).unwrap();
        let map = stored.as_object_mut().unwrap();
        assert!(map.remove("home_lock").is_some());
        map.remove("home_mode");
        entry.meta = serde_json::from_value(stored).unwrap();
        assert!(!entry.meta.home_lock && entry.meta.home_mode.is_none());
    }
    let new = open_seat(
        &registry,
        &mate.id,
        Some("read the mail"),
        None,
        Opener::Schedule("brief", crate::pressure::Who::Session),
    )
    .unwrap()
    .session;
    assert_ne!(new.id, old.id, "not reused");
    assert!(new.home_lock, "the new seat is locked");
    // The old run ends once the new one runs (closed now, or its row gone).
    let mut core = registry.lock().unwrap();
    let ended = core
        .session_of(&old.id)
        .map_or(true, |s| s.state != SessionState::Running);
    drop(core);
    assert!(ended, "the old seat ended");
    let _ = registry.lock().unwrap().handle(Request::Stop);
    fs::remove_dir_all(home).unwrap();
}

// Look v20 S2: a locked seat takes no input from another session (an unlocked project shell typed into the Home lead
// and its text went in as the user's prompt). Every op that writes to its terminal or queues a prompt is refused before
// anything is written, with the reason; the owner's own ops still reach it.
#[test]
fn a_locked_seat_takes_input_only_from_the_owner() {
    let mut f = flood_script(
        "locked-input",
        b"",
        &format!(
            "printf '{}'\ncat > got <&0 &\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    f.core.entries.get_mut(&f.id).unwrap().meta.home_lock = true;
    let peer = crate::grants::Caller {
        id: "project-shell".into(),
        project: f.home.clone(),
    };
    let id = f.id.clone();
    for request in [
        Request::SendText {
            id: id.clone(),
            text: "LOCKTEST".into(),
            seen: vec![],
            composer: false,
        },
        Request::SendKeys {
            id: id.clone(),
            keys: vec!["enter".into()],
            seen: vec![],
            composer: false,
        },
        Request::AgentSend {
            id: id.clone(),
            text: "LOCKTEST".into(),
        },
        Request::AgentPrompt {
            id: id.clone(),
            text: "LOCKTEST".into(),
        },
        Request::SteerNow {
            id: id.clone(),
            text: "LOCKTEST".into(),
            seen: vec![],
        },
        Request::AgentKeys {
            id: id.clone(),
            keys: vec!["enter".into()],
        },
        Request::CancelSend {
            id: id.clone(),
            send: "s1".into(),
        },
    ] {
        let e = f.core.handle_agent(&peer, request.clone()).unwrap_err();
        assert!(e.contains("seat is locked"), "{request:?}: {e}");
    }
    let meta = &f.core.entries[&id].meta;
    assert!(meta.send_queue.is_empty() && meta.send_log.is_empty());
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(
        fs::read_to_string(f.home.join("got")).unwrap_or_default(),
        ""
    );
    // The owner still reaches it.
    let owner = f.core.handle(Request::SendText {
        id: id.clone(),
        text: "owner".into(),
        seen: vec![],
        composer: false,
    });
    assert!(matches!(owner, Ok(Reply::Ack)), "{owner:?}");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while fs::read_to_string(f.home.join("got")).unwrap_or_default() != "owner" {
        assert!(
            std::time::Instant::now() < until,
            "the owner's text never arrived"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

// Look v20 S2 ("send failed" yet typed): a prompt for a box that holds words another send typed without Enter writes
// nothing; pasted behind them, its Enter was dropped and it went in with the next Enter. Gap rule: it waits in the
// queue (`terminal_text`) instead of being refused.
#[test]
fn a_prompt_behind_unsent_words_writes_nothing() {
    let mut f = flood_script(
        "unsent-words",
        b"",
        &format!(
            "printf '{}'\ncat > got <&0 &\n",
            PROMPT.replace('\x1b', "\\033").replace("\r\n", "\\r\\n")
        ),
    );
    wait_end(&f, PROMPT.len());
    f.core.observe().unwrap();
    let peer = crate::grants::Caller {
        id: "peer".into(),
        project: f.home.clone(),
    };
    let id = f.id.clone();
    let sent = f.core.handle_agent(
        &peer,
        Request::AgentSend {
            id: id.clone(),
            text: "typed".into(),
        },
    );
    assert!(
        matches!(&sent, Ok(Reply::Delivery { send }) if send.status == "delivered"),
        "{sent:?}"
    );
    let queued = f.core.handle_agent(
        &peer,
        Request::AgentPrompt {
            id: id.clone(),
            text: "next".into(),
        },
    );
    let Ok(Reply::Delivery { send }) = queued else {
        panic!("{queued:?}")
    };
    assert_eq!(send.status, "queued");
    f.core.flush_delivery().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(fs::read_to_string(f.home.join("got")).unwrap(), "typed");
}
