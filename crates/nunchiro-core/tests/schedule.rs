//! V2.5-11 (needs 136): scheduled runs through a real `serve`. A schedule is a closed owner choice (Claude or Codex,
//! a known project, a name) with a local time; it is no row until it fires, survives a core restart, only the owner
//! makes one, and an entry the core did not write (no or wrong MAC, a shell, args) is refused.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    schedule::{Run, Schedules},
    server::call,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const UTC: &dyn Fn(i64) -> i64 = &|_| 0;
const HOUR: u64 = 3_600_000;

/// A home with a fake `claude` on PATH (prints a marker, then waits) and a project folder `proj`.
fn setup(tag: &str) -> (PathBuf, PathBuf, String) {
    let home = home::short(tag);
    fs::create_dir_all(home.join("bin")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\necho scheduled-ran\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let proj = home.join("proj");
    fs::create_dir_all(&proj).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    (home, proj, path)
}
fn serve(home: &Path, path: &str) -> home::ServeGuard {
    home::spawn_serve(
        home,
        &[
            ("PATH", path),
            (
                "CLAUDE_CONFIG_DIR",
                &home.join("claude-home").to_string_lossy(),
            ),
        ],
    )
}
fn run(proj: &Path, label: &str) -> Run {
    Run {
        kind: AgentKind::Claude,
        project: proj.to_path_buf(),
        label: label.into(),
        model: None,
        effort: None,
        task: None,
        teammate: None,
        level: None,
    }
}
fn known(proj: &Path) -> BTreeSet<String> {
    BTreeSet::from([proj.to_string_lossy().into_owned()])
}
/// A shell session in `proj`, so the core knows the project.
fn shell(home: &Path, proj: &Path, script: &str) -> Session {
    match call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: proj.to_path_buf(),
                worktree: false,
                label: "keeper".into(),
                args: vec!["/bin/sh".into(), "-c".into(), script.into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap()
    {
        Reply::Started { session } => session,
        other => panic!("{other:?}"),
    }
}
fn rows(home: &Path) -> Vec<Session> {
    match call(home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions,
        other => panic!("{other:?}"),
    }
}
fn schedules(home: &Path) -> Vec<nunchiro_core::schedule::Entry> {
    match call(home, Request::ScheduleList).unwrap() {
        Reply::Schedules { schedules } => schedules,
        other => panic!("{other:?}"),
    }
}
fn wait(what: &str, mut done: impl FnMut() -> bool) {
    // 30 s, not 10: a hosted CI runner ran this in over 10 s where a Mac takes 2 s; the wait is on a condition.
    let until = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn raw(home: &Path, token: &str, request: Value) -> Value {
    let mut sock = std::os::unix::net::UnixStream::connect(home.join("core.sock")).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    writeln!(sock, "{}", json!({"token":token,"request":request})).unwrap();
    let mut answer = String::new();
    BufReader::new(sock).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn output(home: &Path, id: &str) -> String {
    match call(
        home,
        Request::Read {
            id: id.into(),
            after: 0,
        },
    ) {
        Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
        _ => String::new(),
    }
}

// Fake clock: nothing is due a millisecond before 21:00, the entry is due at 21:00; a daily one moves to the next
// day and a once one is gone. Then a real core fires a due schedule: the session appears in the tree and runs.
#[test]
fn scheduled_session_runs_at_time() {
    let (home, proj, path) = setup("sch-at");
    let mut s = Schedules::load(&home);
    let daily = s
        .add(
            run(&proj, "d"),
            "21:00".into(),
            true,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    s.add(
        run(&proj, "o"),
        "21:00".into(),
        false,
        None,
        &known(&proj),
        0,
        UTC,
    )
    .unwrap();
    assert_eq!(daily.next_ms, 21 * HOUR);
    assert!(s.take_due(21 * HOUR - 1, UTC).is_empty());
    assert_eq!(s.take_due(21 * HOUR, UTC).len(), 2);
    let left = s.list().unwrap();
    assert_eq!(
        (left[0].id.as_str(), left[0].next_ms, left[0].paused),
        (daily.id.as_str(), 45 * HOUR, false)
    );
    // Look 11-17 v8 (Home S2-C): the once schedule stays, switched off.
    assert_eq!(
        (left.len(), left[1].daily, left[1].paused),
        (2, false, true)
    );
    // A fire is saved before the start: a reload sees it as fired, so a crash never runs it twice.
    assert!(Schedules::load(&home).take_due(21 * HOUR, UTC).is_empty());
    drop(s);
    fs::remove_file(home.join("schedules.json")).unwrap();

    // The core learns the project from a session in it, then a schedule made at fake time 0 is long due.
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let made = Schedules::load(&home)
        .add(
            run(&proj, "nightly"),
            "21:00".into(),
            true,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    let _core = serve(&home, &path);
    let mut id = String::new();
    wait("scheduled session never appeared", || {
        rows(&home)
            .into_iter()
            .find(|r| r.label == "nightly")
            .map(|r| id = r.id)
            .is_some()
    });
    wait("scheduled session never ran", || {
        output(&home, &id).contains("scheduled-ran")
    });
    let after = schedules(&home);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, made.id);
    assert!(
        after[0].next_ms > now_ms(),
        "a daily schedule moves to its next time"
    );
}

/// A schedule's run while the Mac is low on memory starts no seat and reads "held" in its run record, not failed, with
/// the reason. The timer holds from warning; Run now, the owner's press in the window with no override yet, only at
/// critical.
#[test]
fn a_schedule_run_is_held_under_memory_pressure() {
    let (home, proj, path) = setup("sch-mem");
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let made = Schedules::load(&home)
        .add(
            run(&proj, "nightly"),
            "21:00".into(),
            true,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    let pressured = |level: &str| {
        home::spawn_serve(
            &home,
            &[
                ("PATH", path.as_str()),
                (
                    "CLAUDE_CONFIG_DIR",
                    &home.join("claude-home").to_string_lossy(),
                ),
                ("NUNCHIRO_TEST_MEMORY_PRESSURE", level),
            ],
        )
    };
    let last = || schedules(&home)[0].last.clone();
    let mut core = pressured("2");
    wait("the due run left no record", || last().is_some());
    let held = serde_json::to_value(last().unwrap()).unwrap();
    assert_eq!(held["result"], "held", "{held}");
    assert!(
        held["reason"].as_str().unwrap().contains("memory"),
        "{held}"
    );
    assert!(
        rows(&home).iter().all(|r| r.label != "nightly"),
        "a held run started a seat"
    );
    // Run now at warning: the window's press is held at critical only.
    let now = Request::ScheduleRunNow {
        id: made.id.clone(),
    };
    call(&home, now.clone()).unwrap();
    wait("Run now did not start at warning", || {
        rows(&home).iter().any(|r| r.label == "nightly")
    });
    core.stop();
    let _core = pressured("4");
    let refused = call(&home, now).unwrap_err();
    assert!(refused.contains("memory"), "{refused}");
    assert_eq!(
        serde_json::to_value(last().unwrap()).unwrap()["result"],
        "held"
    );
}

// Added through the owner socket, the schedule is in schedules.json and the same after a core restart; until it
// fires it is no row in the tree.
#[test]
fn schedule_survives_restart() {
    let (home, proj, path) = setup("sch-rs");
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    let Reply::Schedules { schedules: added } = call(
        &home,
        Request::ScheduleAdd {
            run: run(&proj, "later"),
            at: "03:30".into(),
            daily: true,
            replace: None,
            days: vec![],
        },
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(added.len(), 1);
    assert!(added[0].next_ms > now_ms());
    assert!(
        rows(&home).iter().all(|r| r.label != "later"),
        "not in the tree before it runs"
    );
    core.stop();
    let _core = serve(&home, &path);
    let kept = schedules(&home);
    assert_eq!(kept.len(), 1);
    assert_eq!(
        (&kept[0].id, kept[0].next_ms, &kept[0].at),
        (&added[0].id, added[0].next_ms, &added[0].at)
    );
    call(
        &home,
        Request::ScheduleRemove {
            id: kept[0].id.clone(),
        },
    )
    .unwrap();
    assert!(schedules(&home).is_empty());
}

// Only the owner makes, lists or removes a schedule: a session token is refused, and Remote never forwards one.
// The fire runs the owner's own Start path with only the closed choice: a Claude row, no args. A shell, args or a
// project outside the known ones (or reached through a symlink) is refused on add. The browser role's refusal is the
// crate test `schedule::tests::browser_role_refuses_schedule`.
#[test]
fn scheduled_start_uses_existing_authority() {
    let (home, proj, path) = setup("sch-au");
    let mut core = serve(&home, &path);
    let agent = shell(
        &home,
        &proj,
        "printf 'TOKEN:%s\\n' \"$NUNCHIRO_TOKEN\"; exec cat",
    );
    let mut token = String::new();
    wait("session printed no token", || {
        output(&home, &agent.id)
            .lines()
            .find_map(|l| l.split_once("TOKEN:").map(|(_, t)| t))
            .map(|t| token = t.trim().to_string())
            .is_some()
    });
    let add = json!({"op":"schedule_add","run":run(&proj, "x"),"at":"21:00","daily":true});
    for request in [
        add.clone(),
        json!({"op":"schedule_list"}),
        json!({"op":"schedule_remove","id":"x"}),
        json!({"op":"schedule_run_now","id":"x"}), // ticket 993
        json!({"op":"schedule_pause","id":"x","paused":false}),
    ] {
        assert_eq!(
            raw(&home, &token, request.clone()),
            json!({"Err":"operation not granted"}),
            "{request}"
        );
    }
    assert!(
        !home.join("schedules.json").exists(),
        "a refused add writes nothing"
    );
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim();
    let remote = raw(
        &home,
        owner,
        json!({"op":"remote","machine":"m","request":add}),
    );
    assert!(
        remote["Err"]
            .as_str()
            .unwrap_or("")
            .contains("local owner-only"),
        "{remote}"
    );

    // The owner's add is a closed choice too.
    let shell_run = json!({"kind":"shell","project":proj,"label":"s"});
    let with_args = json!({"kind":"claude","project":proj,"label":"a","args":["--dangerously-skip-permissions"]});
    let outside = home.join("other");
    fs::create_dir_all(&outside).unwrap();
    let link = home.join("link");
    std::os::unix::fs::symlink(&proj, &link).unwrap();
    for bad in [
        shell_run,
        with_args,
        json!({"kind":"claude","project":outside,"label":"o"}),
        json!({"kind":"claude","project":proj,"label":"m","model":"not-a-model"}),
    ] {
        let reply = raw(
            &home,
            owner,
            json!({"op":"schedule_add","run":bad,"at":"21:00","daily":true}),
        );
        assert!(reply.get("Err").is_some(), "{bad} -> {reply}");
    }
    assert!(!home.join("schedules.json").exists());
    // Ticket 991 C4: a path through a link is saved resolved (as a session's project), not refused; the fire-time
    // check (schedule/mod.rs `known_project`) still refuses it once the stored path stops resolving to itself.
    let reply = raw(
        &home,
        owner,
        json!({"op":"schedule_add","run":{"kind":"claude","project":link,"label":"l"},"at":"21:00","daily":true}),
    );
    let saved = &reply["Ok"]["schedules"][0];
    assert_eq!(
        saved["run"]["project"],
        json!(proj.canonicalize().unwrap()),
        "{reply}"
    );
    raw(
        &home,
        owner,
        json!({"op":"schedule_remove","id":saved["id"]}),
    );

    // A due schedule starts as the owner's Start does, with nothing but the closed choice.
    core.stop();
    Schedules::load(&home)
        .add(
            run(&proj, "owned"),
            "21:00".into(),
            false,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    let _core = serve(&home, &path);
    let mut fired = None;
    wait("scheduled session never appeared", || {
        fired = rows(&home).into_iter().find(|r| r.label == "owned");
        fired.is_some()
    });
    let fired = fired.unwrap();
    assert_eq!((fired.kind, &fired.project), (AgentKind::Claude, &proj));
    wait("the run was not recorded", || {
        schedules(&home)[0].last.is_some()
    });
    let after = schedules(&home);
    assert_eq!(
        (
            after.len(),
            after[0].paused,
            after[0].last.clone().unwrap().session
        ),
        (1, true, Some(fired.id.clone())),
        "a once schedule that fired stays, switched off, with its run"
    );
}

// An entry the core did not write is refused on load: a shell or args added by hand, a missing or wrong MAC, as are
// a broken shape, duplicate ids, a bad time, a relative project and a symlinked file. Nothing fires, an add or remove
// is refused, and the bytes stay as they were.
#[test]
fn broken_schedules_file_never_fires_or_is_overwritten() {
    let (home, proj, _) = setup("sch-br");
    let e = Schedules::load(&home)
        .add(
            run(&proj, "a"),
            "21:00".into(),
            true,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    let good: Value =
        serde_json::from_slice(&fs::read(home.join("schedules.json")).unwrap()).unwrap();
    let entry = good["schedules"][0].clone();
    let with = |f: &dyn Fn(&mut Value)| {
        let mut v = entry.clone();
        f(&mut v);
        json!({"version":1,"schedules":[v]})
    };
    let cases = [
        json!([]),
        json!({"version":1,"schedules":[entry, entry]}),
        with(&|v| v["at"] = json!("99:99")),
        with(&|v| v["run"]["project"] = json!("rel")),
        with(&|v| v["run"]["kind"] = json!("shell")),
        with(&|v| v["run"]["args"] = json!(["-c", "id"])),
        with(&|v| v["run"]["label"] = json!("renamed")), // a changed field: the MAC no longer matches
        with(&|v| v["mac"] = json!("")),
        with(&|v| {
            v.as_object_mut().unwrap().remove("mac");
        }),
        with(&|v| v["mac"] = json!("0".repeat(64))),
    ];
    let path = home.join("schedules.json");
    for case in cases {
        let bytes = serde_json::to_vec(&case).unwrap();
        fs::write(&path, &bytes).unwrap();
        let mut s = Schedules::load(&home);
        assert!(s.list().is_err(), "{case}");
        assert!(s.take_due(u64::MAX / 2, UTC).is_empty(), "{case}");
        assert!(
            s.add(
                run(&proj, "b"),
                "01:00".into(),
                true,
                None,
                &known(&proj),
                0,
                UTC
            )
            .is_err()
        );
        assert!(s.remove(&e.id).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes, "{case}");
    }
    // The untouched entry still loads: the refusals above are the edits, not the format.
    fs::write(&path, serde_json::to_vec(&good).unwrap()).unwrap();
    assert_eq!(Schedules::load(&home).list().unwrap().len(), 1);
    fs::remove_file(&path).unwrap();
    let target = home.join("elsewhere.json");
    fs::write(&target, serde_json::to_vec(&good).unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let mut s = Schedules::load(&home);
    assert!(s.list().is_err());
    assert!(s.take_due(u64::MAX / 2, UTC).is_empty());
    assert!(
        fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_dir_all(&home).unwrap();
}

// Ticket 981: a schedule's task is the session's first message; a teammate's schedule starts the teammate's seat (its
// name, its folder) with its brief ending in the task, and a seat that is already open takes the next task alone:
// one seat, one session.
#[test]
fn scheduled_task_reaches_the_session_and_a_teammate_keeps_one_seat() {
    use nunchiro_core::team::{Team, Teammate};
    let (home, proj, path) = setup("sch-tk");
    // This fake draws a composer line, so the core delivers a queued prompt, and `cat` echoes it into the output.
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\nexec cat\n",
    )
    .unwrap();
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let team = Team::open(&home);
    let mate = team
        .save(
            None,
            Teammate {
                id: String::new(),
                name: "Inbox".into(),
                job: "Sort the mail.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: None,
                lead: false,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .remove(0);
    let for_mate = |task: &str| Run {
        task: Some(task.into()),
        teammate: Some(mate.id.clone()),
        level: None,
        // What the window sends is replaced by the teammate's own agent, folder and name.
        ..run(&proj, "ignored")
    };
    // A project teammate whose folder becomes a symlink after the schedule is made: it starts nothing.
    let real = home.join("real");
    fs::create_dir(&real).unwrap();
    let moved = team
        .save(
            None,
            Teammate {
                id: String::new(),
                name: "Moved".into(),
                job: "Anything.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: Some(real.clone()),
                lead: false,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .into_iter()
        .find(|t| t.name == "Moved")
        .unwrap();
    let mut s = Schedules::load(&home);
    let for_moved = Run {
        task: Some("never".into()),
        teammate: Some(moved.id.clone()),
        level: None,
        ..run(&proj, "x")
    };
    s.add(
        for_moved,
        "21:00".into(),
        false,
        None,
        &known(&proj),
        0,
        UTC,
    )
    .unwrap();
    fs::remove_dir(&real).unwrap();
    std::os::unix::fs::symlink(&proj, &real).unwrap();
    let plain = Run {
        task: Some("say the plain task".into()),
        ..run(&proj, "plain")
    };
    s.add(plain, "21:00".into(), false, None, &known(&proj), 0, UTC)
        .unwrap();
    let made = s
        .add(
            for_mate("first mail task"),
            "21:00".into(),
            false,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    assert_eq!(
        (made.run.label.as_str(), &made.run.project),
        ("Inbox", &team.home())
    );
    // A task with no words, a teammate with no task and a teammate that is gone are refused.
    for bad in [
        Run {
            task: Some("  ".into()),
            ..run(&proj, "x")
        },
        Run {
            teammate: Some(mate.id.clone()),
            level: None,
            ..run(&proj, "x")
        },
        Run {
            task: Some("t".into()),
            teammate: Some("0".repeat(32)),
            level: None,
            ..run(&proj, "x")
        },
    ] {
        assert!(
            s.add(bad, "21:00".into(), true, None, &known(&proj), 0, UTC)
                .is_err()
        );
    }
    // Due together: the first starts the seat, the second finds it open.
    s.add(
        for_mate("second mail task"),
        "21:00".into(),
        false,
        None,
        &known(&proj),
        0,
        UTC,
    )
    .unwrap();
    drop(s);

    let _core = serve(&home, &path);
    let seat = |home: &Path| -> Vec<Session> {
        rows(home)
            .into_iter()
            .filter(|r| r.label == "Inbox")
            .collect()
    };
    wait("the plain task never reached its session", || {
        rows(&home)
            .iter()
            .find(|r| r.label == "plain")
            .is_some_and(|r| output(&home, &r.id).contains("say the plain task"))
    });
    let last = std::cell::RefCell::new(String::new());
    let until = Instant::now() + Duration::from_secs(30);
    while !{
        let done = seat(&home).first().is_some_and(|r| {
            let out = output(&home, &r.id);
            // Ticket 1172: what the seat looked like at the last try, printed if the wait runs out (red on CI only).
            *last.borrow_mut() = format!(
                "project {:?} (team home {:?}); queue {:?}; log {:?}; screen tail {:?}",
                r.project,
                team.home(),
                r.send_queue.iter().map(|q| &q.content).collect::<Vec<_>>(),
                r.send_log.iter().map(|q| &q.content).collect::<Vec<_>>(),
                out.chars()
                    .rev()
                    .take(600)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            );
            // The fake never ends its turn, so the second task waits in the seat's queue, as any prompt to a busy agent.
            let queued = r.send_queue.iter().any(|q| {
                q.content.starts_with("Scheduled task from the user")
                    && q.content.ends_with("second mail task")
            });
            r.project == team.home()
                && out.contains("You are Inbox")
                && out.contains("first mail task")
                && queued
        });
        if !done && seat(&home).is_empty() {
            *last.borrow_mut() = format!(
                "no Inbox seat; rows {:?}",
                rows(&home)
                    .iter()
                    .map(|r| (&r.label, &r.state))
                    .collect::<Vec<_>>()
            );
        }
        done
    } {
        assert!(
            Instant::now() < until,
            "the teammate's seat never got its brief and both tasks: {}",
            last.borrow()
        );
        thread::sleep(Duration::from_millis(20));
    }
    // Entries fire in order, so the moved teammate's was tried before the seat got its tasks.
    assert!(rows(&home).iter().all(|r| r.label != "Moved"));
    let seats = seat(&home);
    assert_eq!(seats.len(), 1, "one seat, one session");
    let briefs = seats[0]
        .send_log
        .iter()
        .chain(&seats[0].send_queue)
        .filter(|q| q.content.contains("standing role"))
        .count();
    assert_eq!(briefs, 1, "the open seat is not briefed again");
}

/// Ticket 990: the lead of a place opens another teammate of that place from its own session
/// (`nunchiro team open`): the seat starts as the lead's worker, marked as that teammate's, with a brief that names
/// its lead. A teammate that is not the lead, and a teammate of another place, are refused.
#[test]
fn a_lead_opens_a_teammate_of_its_place_as_its_worker() {
    use nunchiro_core::team::{Team, Teammate};
    let (home, proj, path) = setup("sch-lead");
    // A composer line, the session's own token (so the test can call as that session), then an echo of what arrives.
    fs::write(
        home.join("bin/claude"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let team = Team::open(&home);
    let mate = |name: &str, project: Option<PathBuf>, lead: bool| Teammate {
        id: String::new(),
        name: name.into(),
        job: format!("{name}'s job."),
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project,
        lead,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    };
    team.save(None, mate("Chief", None, true)).unwrap();
    team.save(None, mate("Inbox", None, false)).unwrap();
    team.save(None, mate("Planner", None, false)).unwrap();
    let all = team
        .save(None, mate("Builder", Some(proj.clone()), false))
        .unwrap();
    let id = |name: &str| all.iter().find(|t| t.name == name).unwrap().id.clone();
    let mut s = Schedules::load(&home);
    s.add(
        Run {
            task: Some("morning report".into()),
            teammate: Some(id("Chief")),
            level: None,
            ..run(&proj, "x")
        },
        "21:00".into(),
        false,
        None,
        &known(&proj),
        0,
        UTC,
    )
    .unwrap();
    drop(s);
    let _core = serve(&home, &path);
    let row = |label: &str| rows(&home).into_iter().find(|r| r.label == label);
    let token_of = |label: &str| {
        let mut token = String::new();
        wait("the seat printed no token", || {
            row(label).is_some_and(|r| {
                output(&home, &r.id)
                    .split("TOKEN=")
                    .nth(1)
                    .and_then(|t| t.split('.').next())
                    .filter(|t| !t.is_empty())
                    .map(|t| token = t.to_string())
                    .is_some()
            })
        });
        token
    };
    let chief_token = token_of("Chief");
    let chief = row("Chief").unwrap();
    assert_eq!(
        chief.teammate,
        Some(id("Chief")),
        "the schedule opened the lead's seat"
    );
    let open = |token: &str, name: &str| raw(&home, token, json!({"op":"team_open","name":name}));
    let opened = open(&chief_token, "inbox"); // by name, whatever the case
    assert_eq!(opened["Ok"]["started"], true, "{opened}");
    let inbox = row("Inbox").unwrap();
    assert_eq!(
        (
            inbox.parent.as_ref(),
            inbox.teammate.clone(),
            &inbox.project
        ),
        (Some(&chief.id), Some(id("Inbox")), &team.home())
    );
    wait("the opened seat never got its brief", || {
        let out = output(&home, &inbox.id);
        out.contains("You are Inbox") && out.contains("Chief leads this place")
    });
    // One seat, one session: a second open finds it and sends nothing.
    assert_eq!(open(&chief_token, "Inbox")["Ok"]["started"], false);
    assert_eq!(rows(&home).iter().filter(|r| r.label == "Inbox").count(), 1);
    // Two opens at once make one seat (the seat is looked up again after the unlocked preparation).
    let both = std::thread::scope(|s| {
        let a = s.spawn(|| open(&chief_token, "Planner"));
        let b = s.spawn(|| open(&chief_token, "Planner"));
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(
        both.iter().filter(|r| r["Ok"]["started"] == true).count(),
        1,
        "{both:?}"
    );
    assert_eq!(
        rows(&home).iter().filter(|r| r.label == "Planner").count(),
        1
    );
    // Another place's teammate, a name nobody has, and a caller that is not the lead.
    for name in ["Builder", "Nobody"] {
        let refused = open(&chief_token, name);
        assert!(
            refused["Err"]
                .as_str()
                .is_some_and(|e| e.contains("no teammate named")),
            "{refused}"
        );
    }
    // A session's own start never takes a seat, also when it resumes the lead's conversation: no lead by resume.
    if let Some(conversation) = chief.agent_session_id.clone() {
        let copy = raw(
            &home,
            &token_of("Inbox"),
            json!({"op":"start","session":{"account":null,"kind":"claude","project":team.home(),"worktree":false,"label":"copy","args":[],"model":null,"effort":null,"resume":conversation}}),
        );
        if copy["Ok"].is_object() {
            assert!(copy["Ok"]["session"]["teammate"].is_null(), "{copy}");
            assert!(row("copy").is_some_and(|r| r.teammate.is_none()));
        }
    }
    let not_lead = open(&token_of("Inbox"), "Chief");
    assert!(
        not_lead["Err"]
            .as_str()
            .is_some_and(|e| e.contains("only the lead")),
        "{not_lead}"
    );
    assert!(row("Builder").is_none());
}

/// Ticket 990: a worktree the lead's seat makes joins its team, the owner takes it back and hands it over, and the
/// project's room gets one line for each team event; what the user says to a sub-bot reaches the lead as one line.
#[test]
fn a_leads_worktree_joins_its_team_and_the_room_hears_it() {
    use nunchiro_core::team::{Team, Teammate};
    let (home, proj, path) = setup("sch-team");
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec![
            "-c",
            "user.name=F",
            "-c",
            "user.email=f@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "first",
        ],
    ] {
        assert!(
            home::git_env::scrubbed("git")
                .arg("-C")
                .arg(&proj)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
    fs::write(
        home.join("bin/claude"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let main = Team::open(&home)
        .save(
            None,
            Teammate {
                id: String::new(),
                name: "Main".into(),
                job: "Runs this project.".into(),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project: Some(proj.clone()),
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .remove(0);
    let mut s = Schedules::load(&home);
    s.add(
        Run {
            task: Some("plan the day".into()),
            teammate: Some(main.id.clone()),
            level: None,
            ..run(&proj, "x")
        },
        "21:00".into(),
        false,
        None,
        &known(&proj),
        0,
        UTC,
    )
    .unwrap();
    drop(s);
    let _core = serve(&home, &path);
    let mut token = String::new();
    wait("the lead's seat printed no token", || {
        rows(&home)
            .iter()
            .find(|r| r.label == "Main")
            .is_some_and(|r| {
                output(&home, &r.id)
                    .split("TOKEN=")
                    .nth(1)
                    .and_then(|t| t.split('.').next())
                    .filter(|t| !t.is_empty())
                    .map(|t| token = t.to_string())
                    .is_some()
            })
    });
    let seat = rows(&home).into_iter().find(|r| r.label == "Main").unwrap();
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let worktree = |token: &str,
                    operation: &str,
                    at: Option<&str>,
                    branch: Option<&str>,
                    label: &str| {
        raw(
            &home,
            token.trim(),
            json!({"op":"worktree","operation":operation,"project":if at.is_none() { Some(&proj) } else { None },"path":at,"branch":branch,"base":"HEAD","label":label}),
        )
    };
    // The lead's seat makes two worktrees: both join its team.
    let made = |branch: &str| {
        let reply = worktree(&token, "create", None, Some(branch), "");
        let all = reply["Ok"]["worktrees"]
            .as_array()
            .unwrap_or_else(|| panic!("{reply}"))
            .clone();
        let w = all.iter().find(|w| w["branch"] == branch).unwrap().clone();
        assert_eq!(w["team"], main.id.as_str(), "{w}");
        w["path"].as_str().unwrap().to_string()
    };
    let (a, b) = (made("lane-a"), made("lane-b"));
    // A worker the lead starts in lane-a, then the user speaks to it directly.
    let started = raw(
        &home,
        &token,
        json!({"op":"start","session":{"account":null,"kind":"shell","project":a,"worktree":false,"label":"lane-a","args":["/bin/cat"],"model":null,"effort":null,"resume":null}}),
    );
    let worker = started["Ok"]["session"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    let told = raw(
        &home,
        owner.trim(),
        json!({"op":"agent_prompt","id":worker,"text":"cap the delay\nat 30 seconds API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}),
    );
    assert!(told["Ok"].is_object(), "{told}");
    // The window's composer sends in two requests (the text, then its Enter): the same one line.
    for request in [
        json!({"op":"send_text","id":worker,"text":"\u{1b}[200~and log each retry\u{1b}[201~","composer":true,"seen":[]}),
        json!({"op":"send_keys","id":worker,"keys":["enter"],"composer":true,"seen":[]}),
    ] {
        let reply = raw(&home, owner.trim(), request.clone());
        assert!(reply["Ok"].is_object(), "{request} -> {reply}");
    }
    // The owner takes lane-a back, hands it over again (only to the project's own lead), and removes lane-b.
    assert!(worktree(&owner, "team", Some(&a), None, "")["Ok"].is_object());
    let wrong = worktree(&owner, "team", Some(&a), None, &"0".repeat(32));
    assert!(
        wrong["Err"]
            .as_str()
            .is_some_and(|e| e.contains("the lead of its project")),
        "{wrong}"
    );
    let handed = worktree(&owner, "team", Some(&a), None, &main.id);
    let again = handed["Ok"]["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["path"] == a.as_str())
        .unwrap()
        .clone();
    assert_eq!(again["team"], main.id.as_str());
    // A session may not change a worktree's team.
    assert!(worktree(&token, "team", Some(&a), None, "")["Err"].is_string());
    assert!(worktree(&owner, "remove", Some(&b), None, "")["Ok"].is_object());
    let room = raw(
        &home,
        owner.trim(),
        json!({"op":"room_read","project":proj}),
    );
    let notes: Vec<&Value> = room["Ok"]["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("{room}"))
        .iter()
        .filter(|m| m["kind"] == "team")
        .collect();
    // What the lead typed into its worker's terminal is in the room too, and is no unread message for the worker.
    let prompted = raw(
        &home,
        &token,
        json!({"op":"agent_prompt","id":worker,"text":"read BRIEF.md and start"}),
    );
    assert!(prompted["Ok"].is_object(), "{prompted}");
    let room2 = raw(
        &home,
        owner.trim(),
        json!({"op":"room_read","project":proj}),
    );
    let typed: Vec<&Value> = room2["Ok"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["kind"] == "typed")
        .collect();
    assert_eq!(typed.len(), 1, "{room2}");
    assert_eq!(
        (
            typed[0]["from"].as_str(),
            typed[0]["to"].as_str(),
            typed[0]["body"].as_str(),
            typed[0]["created_by"].as_str()
        ),
        (
            Some(seat.id.as_str()),
            Some(worker.as_str()),
            Some("read BRIEF.md and start"),
            Some("agent")
        )
    );
    let whats: Vec<&str> = notes
        .iter()
        .map(|m| m["team"]["what"].as_str().unwrap())
        .collect();
    assert_eq!(
        whats,
        [
            "created", "created", "told", "told", "taken", "handed", "removed"
        ],
        "{room}"
    );
    // What the lead did itself goes to the person; what others did goes to the lead's seat, as one line.
    assert_eq!(notes[0]["to"], "person");
    assert_eq!(
        (notes[2]["to"].as_str(), notes[2]["team"]["seat"].as_str()),
        (Some(seat.id.as_str()), Some(worker.as_str()))
    );
    assert_eq!(
        notes[3]["body"],
        "The user told lane-a directly: \"and log each retry\""
    );
    // One line, and a key-like value in it is masked as in the logs.
    let told_body = notes[2]["body"].as_str().unwrap();
    assert!(
        told_body.starts_with("The user told lane-a directly: \"cap the delay at 30 seconds "),
        "{told_body}"
    );
    assert!(
        told_body.contains("[redacted") && !told_body.contains("AAAAAAAA"),
        "{told_body}"
    );
    assert_eq!(notes[6]["to"], seat.id.as_str());
    assert_eq!(
        (
            notes[6]["team"]["merged"].as_bool(),
            notes[6]["team"]["name"].as_str()
        ),
        (Some(true), Some("lane-b"))
    );
    assert!(
        notes
            .iter()
            .all(|m| m["created_by"] == "core" && m["thread"] == "team")
    );
}

/// Ticket 992: a seat opens at a level. The lead asks one (`team open --level`), a schedule entry carries one; the
/// level picks the model from the level table; an idle seat at another level is replaced, a busy one keeps its level;
/// a pin wins, Auto clamps at its limit, a custom model has no level, and no level asked never replaces.
#[test]
fn a_seat_opens_at_the_asked_level() {
    use nunchiro_core::team::{Level, Team, Teammate};
    let (home, proj, path) = setup("sch-level");
    // In the project folder the fake never shows its composer: the brief stays queued, so that seat is never idle.
    fs::write(
        home.join("bin/claude"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\ncase \"$(pwd -P)\" in */proj) echo busy; exec cat;; esac\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let team = Team::open(&home);
    let mate = |name: &str, project: Option<PathBuf>| Teammate {
        id: String::new(),
        name: name.into(),
        job: format!("{name}'s job."),
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project,
        lead: false,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    };
    team.save(
        None,
        Teammate {
            lead: true,
            ..mate("Chief", None)
        },
    )
    .unwrap();
    team.save(None, mate("Inbox", None)).unwrap();
    team.save(
        None,
        Teammate {
            level: Some(Level::Light),
            ..mate("Pinned", None)
        },
    )
    .unwrap();
    team.save(
        None,
        Teammate {
            level_max: Some(Level::Standard),
            ..mate("Capped", None)
        },
    )
    .unwrap();
    team.save(
        None,
        Teammate {
            model: Some("opus".into()),
            ..mate("Own", None)
        },
    )
    .unwrap();
    let all = team.save(None, mate("Busy", Some(proj.clone()))).unwrap();
    let id = |name: &str| all.iter().find(|t| t.name == name).unwrap().id.clone();
    let mut s = Schedules::load(&home);
    let task = |who: &str, words: &str, level: Option<Level>| Run {
        task: Some(words.into()),
        teammate: Some(id(who)),
        level,
        ..run(&proj, "x")
    };
    for run in [
        task("Chief", "morning report", None),
        task("Busy", "sort the mail", Some(Level::Light)),
        task("Busy", "write the contract reply", Some(Level::Deep)),
    ] {
        s.add(run, "21:00".into(), false, None, &known(&proj), 0, UTC)
            .unwrap();
    }
    // An entry with no level has none in its stored form, so an entry from before levels keeps its MAC.
    let stored = fs::read_to_string(home.join("schedules.json")).unwrap();
    assert_eq!(stored.matches("\"level\"").count(), 2, "{stored}");
    drop(s);
    let _core = serve(&home, &path);
    let live = |label: &str| -> Vec<Session> {
        rows(&home)
            .into_iter()
            .filter(|r| r.label == label && r.state == SessionState::Running)
            .collect()
    };
    let mut chief = String::new();
    wait("the lead's seat printed no token", || {
        live("Chief").first().is_some_and(|r| {
            output(&home, &r.id)
                .split("TOKEN=")
                .nth(1)
                .and_then(|t| t.split('.').next())
                .filter(|t| !t.is_empty())
                .map(|t| chief = t.to_string())
                .is_some()
        })
    });
    // A schedule's level: the busy seat opened light; the deep task waits in it and its level stays.
    wait("the busy seat never got both tasks", || {
        live("Busy").first().is_some_and(|r| {
            r.send_queue
                .iter()
                .any(|q| q.content.ends_with("write the contract reply"))
        })
    });
    let busy = live("Busy");
    assert_eq!(busy.len(), 1);
    assert_eq!(
        (busy[0].level, busy[0].model.as_deref()),
        (Some(Level::Light), Some("haiku"))
    );
    assert_eq!(
        live("Chief")[0].level,
        Some(Level::Standard),
        "no level asked: standard"
    );

    let open = |name: &str, level: Option<&str>| {
        let mut req = json!({"op":"team_open","name":name});
        if let Some(l) = level {
            req["level"] = l.into();
        }
        raw(&home, &chief, req)["Ok"].clone()
    };
    let light = open("Inbox", Some("light"));
    assert_eq!(light["started"], true, "{light}");
    assert_eq!(
        (&light["session"]["level"], &light["session"]["model"]),
        (&json!("light"), &json!("haiku"))
    );
    let first = light["session"]["id"].as_str().unwrap().to_string();
    wait("the light seat never took its brief", || {
        live("Inbox").first().is_some_and(|r| {
            r.send_queue.is_empty() && output(&home, &r.id).contains("You are Inbox")
        })
    });
    // No level asked: the open seat is returned as it is.
    let same = open("Inbox", None);
    assert_eq!(
        (same["started"].clone(), same["session"]["id"].clone()),
        (json!(false), json!(first))
    );
    // A seat is replaced only when a turn finished after its last input (its brief). The fake agent sends no hooks,
    // so the test finishes the brief's turn as Claude's hooks would.
    let turn = |seat: &str| {
        for event in ["UserPromptSubmit", "Stop"] {
            call(
                &home,
                Request::Hook {
                    id: seat.into(),
                    event: event.into(),
                    payload: json!({}),
                },
            )
            .unwrap();
        }
    };
    turn(&first);
    // Another level on an idle seat: it is ended and a new seat opens on the standard model.
    let standard = open("Inbox", Some("standard"));
    assert_eq!(standard["started"], true, "{standard}");
    assert_eq!(
        (&standard["session"]["level"], &standard["session"]["model"]),
        (&json!("standard"), &json!("sonnet"))
    );
    assert_ne!(standard["session"]["id"], json!(first));
    wait("the idle seat was not ended", || live("Inbox").len() == 1);
    // Ticket 992 rule 6: a level the user picked on the row goes before the lead's ask, once.
    team.set_next_level(&id("Inbox"), Some(Level::Light))
        .unwrap();
    wait("the standard seat never took its brief", || {
        live("Inbox")
            .first()
            .is_some_and(|r| r.level == Some(Level::Standard) && r.send_queue.is_empty())
    });
    turn(&live("Inbox")[0].id);
    let picked = open("Inbox", Some("deep"));
    assert_eq!(
        (&picked["started"], &picked["session"]["level"]),
        (&json!(true), &json!("light")),
        "{picked}"
    );
    assert_eq!(
        team.list()
            .unwrap()
            .iter()
            .find(|t| t.name == "Inbox")
            .unwrap()
            .next_level,
        None
    );
    // A pin wins and says so; Auto's limit clamps; a custom model has no level.
    let pinned = open("Pinned", Some("deep"));
    assert_eq!(pinned["session"]["level"], "light");
    assert!(
        pinned["why"].as_str().unwrap().contains("pinned to light"),
        "{pinned}"
    );
    let capped = open("Capped", Some("deep"));
    assert_eq!(capped["session"]["level"], "standard");
    assert!(
        capped["why"]
            .as_str()
            .unwrap()
            .contains("goes up to standard"),
        "{capped}"
    );
    let own = open("Own", Some("light"));
    assert!(own["session"]["level"].is_null(), "{own}");
    assert_eq!(own["session"]["model"], "opus");
    assert!(own["why"].is_null());
}

/// A fake `claude` that draws a composer line, prints its session token and echoes what arrives.
fn talking_claude(home: &Path) {
    fs::write(
        home.join("bin/claude"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
}
fn teammate(name: &str, project: Option<PathBuf>, lead: bool) -> nunchiro_core::team::Teammate {
    nunchiro_core::team::Teammate {
        id: String::new(),
        name: name.into(),
        job: format!("{name}'s job."),
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project,
        lead,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    }
}
fn entry(home: &Path, id: &str) -> nunchiro_core::schedule::Entry {
    schedules(home)
        .into_iter()
        .find(|e| e.id == id)
        .unwrap_or_else(|| panic!("no schedule {id}"))
}
/// One hook of the session, as Claude's own hooks would send it (the fake agent sends none).
fn hook(home: &Path, session: &str, event: &str) {
    call(
        home,
        Request::Hook {
            id: session.into(),
            event: event.into(),
            payload: json!({}),
        },
    )
    .unwrap();
}
/// The event log's cursor now, and a wait until `session` is seen in `state` after it (the core notes a state at its
/// tick, so two hooks sent together could pass as no change at all).
fn cursor(home: &Path) -> u64 {
    match call(
        home,
        Request::Events {
            project: None,
            since: None,
        },
    )
    .unwrap()
    {
        Reply::Events { latest, .. } => latest,
        other => panic!("{other:?}"),
    }
}
fn wait_state(home: &Path, since: u64, session: &str, state: &str) {
    wait(&format!("{session} never reached {state}"), || {
        let Ok(Reply::Events { events, .. }) = call(
            home,
            Request::Events {
                project: None,
                since: Some(since),
            },
        ) else {
            return false;
        };
        events
            .iter()
            .any(|e| e.session.as_deref() == Some(session) && e.state.as_deref() == Some(state))
    });
}

/// Ticket 993 rule 5: a run is recorded on its entry (the session it started, and that session is marked as the
/// schedule's run), its result follows the session's turn, a run that cannot start is a failed run with its reason
/// (a once entry comes back switched off for it), and a switched-off entry starts nothing.
#[test]
fn a_run_is_recorded_and_a_run_that_cannot_start_is_a_failed_run() {
    use nunchiro_core::schedule::Outcome;
    use nunchiro_core::team::Team;
    let (home, proj, path) = setup("sch-last");
    talking_claude(&home);
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let team = Team::open(&home);
    let gone = team
        .save(None, teammate("Lister", None, false))
        .unwrap()
        .remove(0);
    let mut s = Schedules::load(&home);
    let mut add = |run: Run, daily: bool| {
        s.add(run, "21:00".into(), daily, None, &known(&proj), 0, UTC)
            .unwrap()
    };
    let task = |label: &str| Run {
        task: Some(format!("{label} task")),
        ..run(&proj, label)
    };
    let for_gone = || Run {
        teammate: Some(gone.id.clone()),
        ..task("x")
    };
    let ok = add(task("ok"), true);
    let off = add(task("off"), true);
    let daily_gone = add(for_gone(), true);
    let once_gone = add(for_gone(), false);
    s.pause(&off.id, true, 0, UTC).unwrap();
    drop(s);
    team.remove(&gone.id).unwrap();

    let _core = serve(&home, &path);
    let mut row = None;
    // The mark is set right after the start, in its own lock.
    wait(
        "the scheduled session never appeared, marked as its run",
        || {
            row = rows(&home)
                .into_iter()
                .find(|r| r.label == "ok" && r.schedule.as_deref() == Some(ok.id.as_str()));
            row.is_some()
        },
    );
    let row = row.unwrap();
    wait("the run was not recorded on its entry", || {
        entry(&home, &ok.id).last.is_some()
    });
    let last = entry(&home, &ok.id).last.unwrap();
    assert_eq!(
        (last.session.as_deref(), last.result, last.reason),
        (Some(row.id.as_str()), None, None)
    );
    assert!(last.at > 0);
    // The turn runs, then ends: finished.
    let since = cursor(&home);
    hook(&home, &row.id, "UserPromptSubmit");
    wait_state(&home, since, &row.id, "working");
    assert_eq!(entry(&home, &ok.id).last.unwrap().result, None);
    hook(&home, &row.id, "Stop");
    wait("the result never followed the session's turn", || {
        entry(&home, &ok.id).last.unwrap().result == Some(Outcome::Finished)
    });
    // The session is closed while a later turn runs: that run did not finish.
    let since = cursor(&home);
    hook(&home, &row.id, "UserPromptSubmit");
    wait_state(&home, since, &row.id, "working");
    call(&home, Request::Close { id: row.id.clone() }).unwrap();
    wait("a session closed in its turn is not a failed run", || {
        entry(&home, &ok.id).last.unwrap().result == Some(Outcome::Failed)
    });

    // The removed teammate: both runs failed with the reason, in words the list can show.
    for id in [&daily_gone.id, &once_gone.id] {
        let last = entry(&home, id).last.unwrap();
        assert_eq!(
            (last.session, last.result, last.reason.as_deref()),
            (
                None,
                Some(Outcome::Failed),
                Some("Lister is no longer a teammate")
            )
        );
    }
    assert!(!entry(&home, &daily_gone.id).paused);
    assert!(
        entry(&home, &once_gone.id).paused,
        "a once entry that could not start stays, switched off"
    );
    // The switched-off entry started nothing and is as it was.
    assert!(rows(&home).iter().all(|r| r.label != "off"));
    let off_now = entry(&home, &off.id);
    assert_eq!(
        (off_now.paused, off_now.last, off_now.next_ms),
        (true, None, off.next_ms)
    );
    // Rule 6: the Home digest names each failed run (which schedule, why); the one that never ran is not among them.
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let digest = raw(
        &home,
        owner.trim(),
        json!({"op":"task","operation":"digest"}),
    );
    let failed = digest["Ok"]["failed_runs"]
        .as_array()
        .unwrap_or_else(|| panic!("{digest}"))
        .clone();
    let of = |id: &str| {
        failed
            .iter()
            .find(|f| f["schedule"] == id)
            .unwrap_or_else(|| panic!("{id} not in {digest}"))
            .clone()
    };
    assert_eq!(failed.len(), 3, "{digest}");
    assert_eq!(
        of(&daily_gone.id),
        json!({"schedule":daily_gone.id,"line":"Lister · Every day 9:00 PM: x task","reason":"Lister is no longer a teammate","at":of(&daily_gone.id)["at"]})
    );
    assert_eq!(
        (
            of(&ok.id)["line"].as_str(),
            of(&ok.id)["reason"].as_str(),
            of(&ok.id)["session"].as_str()
        ),
        (
            Some("ok · Every day 9:00 PM: ok task"),
            Some("the session ended before the task was done"),
            Some(row.id.as_str())
        )
    );
}

/// Ticket 993 rule 5: the owner's requests. An add carries its days; the list row carries them, the switch, the last
/// run and the next time the core will run it. Pause switches it off; Run now runs it once at once, also while it is
/// off, and its next time does not move; switched on again it runs at its next time from then.
#[test]
fn the_owner_adds_days_pauses_and_runs_now() {
    let (home, proj, path) = setup("sch-now");
    let _core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let ask = |request: Value| raw(&home, owner.trim(), request);
    let added = ask(
        json!({"op":"schedule_add","run":run(&proj, "weekly"),"at":"03:30","daily":true,"days":[1,3]}),
    );
    let row = added["Ok"]["schedules"][0].clone();
    let id = row["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{added}"))
        .to_string();
    assert_eq!(row["days"], json!([1, 3]), "{row}");
    let next = row["next_ms"].as_u64().unwrap();
    assert!(next > now_ms() && next <= now_ms() + 7 * 24 * HOUR, "{row}");
    // Never ran and on: neither key is in the row.
    assert!(
        row.get("paused").is_none() && row.get("last").is_none(),
        "{row}"
    );
    for bad in [json!([7]), json!([3, 1])] {
        let refused = ask(
            json!({"op":"schedule_add","run":run(&proj, "bad"),"at":"03:30","daily":true,"days":bad}),
        );
        assert!(refused["Err"].is_string(), "{refused}");
    }
    let once_with_days = ask(
        json!({"op":"schedule_add","run":run(&proj, "bad"),"at":"03:30","daily":false,"days":[1]}),
    );
    assert!(once_with_days["Err"].is_string(), "{once_with_days}");

    let paused = ask(json!({"op":"schedule_pause","id":id,"paused":true}));
    assert_eq!(paused["Ok"]["schedules"][0]["paused"], true, "{paused}");
    let ran = ask(json!({"op":"schedule_run_now","id":id}));
    let row = ran["Ok"]["schedules"][0].clone();
    let session = row["last"]["session"]
        .as_str()
        .unwrap_or_else(|| panic!("{ran}"))
        .to_string();
    assert_eq!(
        (&row["next_ms"], &row["paused"], &row["last"]["result"]),
        (&json!(next), &json!(true), &Value::Null),
        "{row}"
    );
    let started: Vec<Session> = rows(&home)
        .into_iter()
        .filter(|r| r.label == "weekly")
        .collect();
    assert_eq!(started.len(), 1, "one run");
    assert_eq!(
        (started[0].id.as_str(), started[0].schedule.as_deref()),
        (session.as_str(), Some(id.as_str()))
    );
    wait("the run never started its agent", || {
        output(&home, &session).contains("scheduled-ran")
    });
    // An edit keeps the switch and the last run under the new id.
    let edited = ask(
        json!({"op":"schedule_add","run":run(&proj, "weekly"),"at":"04:00","daily":true,"days":[1],"replace":id}),
    );
    let row = edited["Ok"]["schedules"][0].clone();
    let id = row["id"].as_str().unwrap().to_string();
    assert_eq!(
        (&row["paused"], &row["last"]["session"], &row["days"]),
        (&json!(true), &json!(session), &json!([1])),
        "{edited}"
    );
    let on = ask(json!({"op":"schedule_pause","id":id,"paused":false}));
    let row = on["Ok"]["schedules"][0].clone();
    assert!(
        row.get("paused").is_none() && row["next_ms"].as_u64().unwrap() > now_ms(),
        "{row}"
    );
    for request in [
        json!({"op":"schedule_run_now","id":"nope"}),
        json!({"op":"schedule_pause","id":"nope","paused":true}),
    ] {
        assert_eq!(
            ask(request.clone()),
            json!({"Err":"no such schedule"}),
            "{request}"
        );
    }
    assert_eq!(
        rows(&home).iter().filter(|r| r.label == "weekly").count(),
        1
    );
}

/// A home with a Home lead (Chief) and its teammate (Inbox), a project lead (Main) and its teammate (Helper), and
/// both leads' seats running, each opened by a once schedule with `task`. Gives the serve guard, the teammates'
/// ids by name, and each lead's session token.
struct Leads {
    _core: home::ServeGuard,
    home: PathBuf,
    proj: PathBuf,
    ids: std::collections::BTreeMap<String, String>,
    chief: String,
    main: String,
}
fn token_of(home: &Path, label: &str) -> String {
    let mut token = String::new();
    wait(&format!("{label} printed no token"), || {
        rows(home)
            .into_iter()
            .filter(|r| r.label == label && r.state == SessionState::Running)
            .any(|r| {
                output(home, &r.id)
                    .split("TOKEN=")
                    .nth(1)
                    .and_then(|t| t.split('.').next())
                    .filter(|t| !t.is_empty())
                    .map(|t| token = t.to_string())
                    .is_some()
            })
    });
    token
}
fn leads(tag: &str) -> Leads {
    use nunchiro_core::team::Team;
    let (home, proj, path) = setup(tag);
    talking_claude(&home);
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let team = Team::open(&home);
    team.save(None, teammate("Chief", None, true)).unwrap();
    team.save(None, teammate("Inbox", None, false)).unwrap();
    team.save(None, teammate("Main", Some(proj.clone()), true))
        .unwrap();
    let all = team
        .save(None, teammate("Helper", Some(proj.clone()), false))
        .unwrap();
    let ids: std::collections::BTreeMap<String, String> =
        all.into_iter().map(|t| (t.name, t.id)).collect();
    let mut s = Schedules::load(&home);
    for lead in ["Chief", "Main"] {
        let run = Run {
            task: Some("morning report".into()),
            teammate: Some(ids[lead].clone()),
            ..run(&proj, "x")
        };
        s.add(run, "21:00".into(), false, None, &known(&proj), 0, UTC)
            .unwrap();
    }
    drop(s);
    let core = serve(&home, &path);
    let (chief, main) = (token_of(&home, "Chief"), token_of(&home, "Main"));
    // The two once entries fired and stay listed (switched off); the tests start from an empty list.
    for e in schedules(&home) {
        call(&home, Request::ScheduleRemove { id: e.id }).unwrap();
    }
    Leads {
        _core: core,
        home,
        proj,
        ids,
        chief,
        main,
    }
}

/// Ticket 993 rule 4: a lead reads the schedules of its own place, the Home lead all of them, and any other session
/// none, as before. The owner's requests stay the owner's for a lead too.
#[test]
fn a_lead_reads_only_its_places_schedules() {
    let l = leads("sch-read");
    let (home, proj) = (&l.home, &l.proj);
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let add = |run: Value| {
        let reply = raw(
            home,
            owner.trim(),
            json!({"op":"schedule_add","run":run,"at":"03:30","daily":true}),
        );
        let all = reply["Ok"]["schedules"]
            .as_array()
            .unwrap_or_else(|| panic!("{reply}"))
            .clone();
        all.last().unwrap()["id"].as_str().unwrap().to_string()
    };
    let for_mate =
        |name: &str| json!({"kind":"claude","project":proj,"task":"sort","teammate":l.ids[name]});
    let inbox = add(for_mate("Inbox"));
    let helper = add(for_mate("Helper"));
    let plain = add(json!({"kind":"claude","project":proj,"label":"nightly"}));
    let listed = |token: &str| {
        let reply = raw(home, token, json!({"op":"schedule_list"}));
        let mut ids: Vec<String> = reply["Ok"]["schedules"]
            .as_array()
            .unwrap_or_else(|| panic!("{reply}"))
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        ids
    };
    let sorted = |mut ids: Vec<String>| {
        ids.sort();
        ids
    };
    assert_eq!(
        listed(&l.chief),
        sorted(vec![inbox.clone(), helper.clone(), plain.clone()])
    );
    assert_eq!(listed(&l.main), sorted(vec![helper.clone(), plain.clone()]));
    // A teammate that is no lead, opened by its lead: refused as every session was.
    let opened = raw(home, &l.chief, json!({"op":"team_open","name":"Inbox"}));
    assert_eq!(opened["Ok"]["started"], true, "{opened}");
    let not_lead = token_of(home, "Inbox");
    assert_eq!(
        raw(home, &not_lead, json!({"op":"schedule_list"})),
        json!({"Err":"operation not granted"})
    );
    // Reading is all a lead does by itself: add, remove, pause and run now stay the owner's.
    for request in [
        json!({"op":"schedule_add","run":for_mate("Helper"),"at":"21:00","daily":true}),
        json!({"op":"schedule_remove","id":helper}),
        json!({"op":"schedule_pause","id":helper,"paused":true}),
        json!({"op":"schedule_run_now","id":helper}),
    ] {
        for token in [&l.chief, &l.main] {
            let got = raw(home, token, request.clone());
            // Ticket 1002 lane 1: the Home lead's seat is locked, so its own lock refuses first.
            let locked =
                token == &l.chief && got["Err"].as_str().is_some_and(|e| e.contains("seat lock"));
            assert!(
                locked || got == json!({"Err":"operation not granted"}),
                "{request}: {got}"
            );
        }
    }
    assert_eq!(schedules(home).len(), 3);
}

/// Ticket 993 rule 4: a lead proposes a schedule and a change; each is a card for the user and stores nothing. The
/// user's yes applies it and "Not now" drops it, and the lead hears either in one line. A session that does a
/// scheduled run proposes nothing until the user speaks to it; what an add refuses, a proposal refuses at once.
#[test]
fn a_leads_proposal_is_the_users_card_and_a_scheduled_run_proposes_nothing() {
    let l = leads("sch-prop");
    let (home, proj) = (&l.home, &l.proj);
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim();
    let propose = |token: &str, who: &str, when: &str, task: &str, level: Option<&str>| {
        let mut request = json!({"op":"schedule_propose","who":who,"when":when,"task":task});
        if let Some(level) = level {
            request["level"] = level.into();
        }
        raw(home, token, request)
    };
    let cards = || {
        raw(home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    // Gives the refusal, if any.
    let answer = |card: &Value, kind: &str| {
        raw(
            home,
            owner,
            json!({"op":"answer","item":card["id"],"answer":{"type":kind},"confirmed":true}),
        )["Err"]
            .clone()
    };
    let notes = |project: &Path| -> Vec<(String, String)> {
        let room = raw(home, owner, json!({"op":"room_read","project":project}));
        room["Ok"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("{room}"))
            .iter()
            .filter(|m| {
                m["team"]["what"]
                    .as_str()
                    .is_some_and(|w| w.starts_with("schedule_"))
            })
            .map(|m| {
                (
                    m["team"]["what"].as_str().unwrap().to_string(),
                    m["body"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };

    // Both leads' seats were started by a schedule: they are scheduled runs, and propose nothing.
    for token in [&l.chief, &l.main] {
        let refused = propose(token, "Inbox", "daily 21:00", "Sort the mail.", None);
        assert!(
            refused["Err"].as_str().is_some_and(
                |e| e.starts_with("a scheduled run cannot propose or change schedules")
            ),
            "{refused}"
        );
    }
    assert!(cards().is_empty() && schedules(home).is_empty());
    // The user speaks to each lead: from then it is the user's conversation.
    for label in ["Chief", "Main"] {
        let id = rows(home)
            .into_iter()
            .find(|r| r.label == label)
            .unwrap()
            .id;
        let told = raw(
            home,
            owner,
            json!({"op":"agent_prompt","id":id,"text":"good morning"}),
        );
        assert!(told["Ok"].is_object(), "{told}");
        assert!(
            rows(home)
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .schedule
                .is_none()
        );
    }

    // What an add refuses, a proposal refuses, with no card: another place's teammate, a time that does not parse,
    // a date that has passed, no task, a task over the limit.
    for (who, when, task) in [
        ("Helper", "daily 21:00", "t"),
        ("Nobody", "daily 21:00", "t"),
        ("Inbox", "daily 25:00", "t"),
        ("Inbox", "every day at nine", "t"),
        ("Inbox", "weekly someday 09:00", "t"),
        ("Inbox", "once 2020-01-01 09:00", "t"),
        ("Inbox", "daily 21:00", "  "),
        ("Inbox", "daily 21:00", &"x".repeat(4001)),
    ] {
        let refused = propose(&l.chief, who, when, task, None);
        assert!(refused["Err"].is_string(), "{who} {when}: {refused}");
    }
    assert!(cards().is_empty());
    // A teammate that is no lead proposes nothing; nor does the owner's own socket (the user adds in the window).
    let opened = raw(home, &l.chief, json!({"op":"team_open","name":"Inbox"}));
    assert_eq!(opened["Ok"]["started"], true, "{opened}");
    let not_lead = propose(&token_of(home, "Inbox"), "Inbox", "daily 21:00", "t", None);
    assert_eq!(
        not_lead,
        json!({"Err":"only the lead of a place proposes or changes a schedule"})
    );
    assert!(propose(owner, "Inbox", "daily 21:00", "t", None)["Err"].is_string());

    // The Home lead proposes: one sentence on a card, nothing stored.
    let asked = propose(
        &l.chief,
        "inbox",
        "daily 21:00",
        "Sort the\nmail.",
        Some("light"),
    );
    let line = "Inbox · Every day 9:00 PM · Haiku: Sort the mail.";
    assert_eq!(asked["Ok"]["text"], line, "{asked}");
    let all = cards();
    assert_eq!(all.len(), 1, "{all:?}");
    let card = &all[0];
    assert_eq!(
        (
            card["kind"].as_str(),
            card["owner"]["type"].as_str(),
            card["owner"]["change"].as_str(),
            card["owner"]["line"].as_str(),
            card["owner"]["run"]["teammate"].as_str(),
            &card["owner"]["when"],
            &card["owner"]["id"],
        ),
        (
            Some("owner"),
            Some("schedule"),
            Some("add"),
            Some(line),
            Some(l.ids["Inbox"].as_str()),
            &json!({"at":"21:00","daily":true}),
            &Value::Null,
        ),
        "{card}"
    );
    assert_eq!(card["text"], format!("add the schedule: {line}"));
    assert!(
        schedules(home).is_empty(),
        "nothing is stored before the answer"
    );
    // The same proposal again is the same card; a reworded task replaces it.
    propose(
        &l.chief,
        "Inbox",
        "daily 21:00",
        "Sort the\nmail.",
        Some("light"),
    );
    assert_eq!(cards()[0]["id"], card["id"]);
    propose(
        &l.chief,
        "Inbox",
        "daily 21:00",
        // A hidden character (here a right-to-left override) never reaches the card's sentence.
        "Sort the mail\u{202E} and flag bills.",
        None,
    );
    let all = cards();
    assert_eq!(all.len(), 1);
    // No level asked is Light, as a schedule made by hand starts (rule 3), on the card's line and in its run.
    assert_eq!(
        all[0]["owner"]["line"],
        "Inbox · Every day 9:00 PM · Haiku: Sort the mail and flag bills."
    );
    assert_eq!(all[0]["owner"]["run"]["level"], "light", "{}", all[0]);
    // Not now: nothing is added, the card is gone, the lead hears it.
    assert_eq!(answer(&all[0], "deny"), Value::Null);
    assert!(cards().is_empty() && schedules(home).is_empty());
    let home_folder = nunchiro_core::team::Team::open(home).home();
    assert_eq!(
        notes(&home_folder),
        [(
            "schedule_no".to_string(),
            "The user said not now to the schedule (add): Inbox · Every day 9:00 PM · Haiku: Sort the mail and flag bills.".to_string()
        )]
    );
    // Add: the entry is the owner's own add (the teammate's folder and name, the level, the task whole, its days).
    propose(
        &l.chief,
        "Inbox",
        "weekdays 09:00",
        "Sort the\nmail.",
        Some("light"),
    );
    assert_eq!(answer(&cards()[0], "allow_once"), Value::Null);
    assert!(cards().is_empty());
    let added = schedules(home);
    assert_eq!(added.len(), 1);
    let e = &added[0];
    assert_eq!(
        (
            e.run.teammate.as_deref(),
            e.run.task.as_deref(),
            e.run.level,
            e.run.label.as_str(),
            &e.run.project,
            e.at.as_str(),
            e.daily,
            e.days.as_slice(),
            e.paused
        ),
        (
            Some(l.ids["Inbox"].as_str()),
            Some("Sort the\nmail."),
            Some(nunchiro_core::team::Level::Light),
            "Inbox",
            &home_folder,
            "09:00",
            true,
            &[1, 2, 3, 4, 5][..],
            false
        )
    );
    assert!(e.next_ms > now_ms());
    let said = notes(&home_folder);
    assert_eq!(
        said.last().unwrap(),
        &(
            "schedule_yes".to_string(),
            "The user added the schedule: Inbox · Weekdays 9:00 AM · Haiku: Sort the mail."
                .to_string()
        )
    );
    // The answer went to the lead's own seat, as a room line it reads.
    let room = raw(home, owner, json!({"op":"room_read","project":home_folder}));
    let chief = rows(home)
        .into_iter()
        .find(|r| r.label == "Chief")
        .unwrap()
        .id;
    let last = room["Ok"]["messages"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(last["to"], chief.as_str(), "{last}");

    // A change: only an entry of the caller's reach, only a change that changes something; then a card.
    let change = |token: &str, id: &str, change: &str| {
        raw(
            home,
            token,
            json!({"op":"schedule_change","id":id,"change":change}),
        )
    };
    let id = e.id.clone();
    let out_of_reach = change(&l.main, &id, "pause"); // the project's lead does not read Home's schedules
    assert!(
        out_of_reach["Err"]
            .as_str()
            .is_some_and(|e| e.starts_with("no schedule")),
        "{out_of_reach}"
    );
    for (word, why) in [
        ("resume", "already on"),
        ("skip", "pause, resume or remove"),
    ] {
        let refused = change(&l.chief, &id, word);
        assert!(
            refused["Err"].as_str().is_some_and(|e| e.contains(why)),
            "{refused}"
        );
    }
    assert!(cards().is_empty());
    let asked = change(&l.chief, &id, "pause");
    assert_eq!(
        asked["Ok"]["text"],
        "Inbox · Weekdays 9:00 AM · Haiku: Sort the mail."
    );
    let card = cards().remove(0);
    assert_eq!(
        (
            card["owner"]["change"].as_str(),
            card["owner"]["id"].as_str()
        ),
        (Some("pause"), Some(id.as_str())),
        "{card}"
    );
    assert!(!schedules(home)[0].paused, "not before the yes");
    // A later change to the same entry replaces the card that waits.
    change(&l.chief, &id, "remove");
    assert_eq!(cards().len(), 1);
    change(&l.chief, &id, "pause");
    assert_eq!(answer(&cards()[0], "allow_once"), Value::Null);
    assert!(schedules(home)[0].paused);
    assert!(
        change(&l.chief, &id, "pause")["Err"]
            .as_str()
            .is_some_and(|e| e.contains("already off"))
    );
    change(&l.chief, &id, "resume");
    answer(&cards()[0], "allow_once");
    let on = schedules(home).remove(0);
    assert!(!on.paused && on.next_ms > now_ms());
    change(&l.chief, &id, "remove");
    assert_eq!(answer(&cards()[0], "deny"), Value::Null);
    assert_eq!(schedules(home).len(), 1, "Not now removes nothing");
    change(&l.chief, &id, "remove");
    answer(&cards()[0], "allow_once");
    assert!(schedules(home).is_empty() && cards().is_empty());
    let said: Vec<String> = notes(&home_folder).into_iter().map(|n| n.1).collect();
    let tail = "Inbox · Weekdays 9:00 AM · Haiku: Sort the mail.";
    assert_eq!(
        said[2..],
        [
            format!("The user paused the schedule: {tail}"),
            format!("The user resumed the schedule: {tail}"),
            format!("The user said not now to the schedule (remove): {tail}"),
            format!("The user removed the schedule: {tail}"),
        ]
    );

    // The project's lead proposes for its own place; the card counts for that project and its yes adds the entry.
    let asked = propose(
        &l.main,
        "Helper",
        "weekly mon 08:30",
        "Check the build.",
        Some("deep"),
    );
    assert_eq!(
        asked["Ok"]["text"],
        "Helper · Mondays 8:30 AM · Opus: Check the build."
    );
    assert!(propose(&l.main, "Inbox", "daily 21:00", "t", None)["Err"].is_string());
    let card = cards().remove(0);
    assert_eq!(card["owner"]["place"], json!(proj), "{card}");
    assert_eq!(
        card["owner"]["run"]["level"], "deep",
        "an asked level is kept: {card}"
    );
    answer(&card, "allow_once");
    let added = schedules(home);
    assert_eq!(
        (added[0].run.project.as_path(), added[0].days.as_slice()),
        (proj.as_path(), &[1][..])
    );
    assert_eq!(notes(proj).last().unwrap().0, "schedule_yes");
    // A card that can no longer be applied (the teammate was removed) stays, with the reason; Not now clears it.
    propose(&l.main, "Helper", "daily 07:00", "Another.", None);
    nunchiro_core::team::Team::open(home)
        .remove(&l.ids["Helper"])
        .unwrap();
    let card = cards().remove(0);
    let failed = answer(&card, "allow_once");
    assert!(
        failed.as_str().is_some_and(|e| e.contains("no teammate")),
        "{failed}"
    );
    assert_eq!((cards().len(), schedules(home).len()), (1, 1));
    answer(&card, "deny");
    assert!(cards().is_empty());
}

/// Look 11-17 v8 (Home S2-A): Run now on a Light schedule for the Home lead ended the lead's open Standard
/// conversation and opened an empty Light seat. A scheduled run never replaces a lead's seat: the task goes into the
/// open seat as it is, a schedule for a lead stores no level (an add and a proposal drop a given one, and the
/// proposal's line shows the lead's own level). Ticket 992's rule for the others stays: an assistant's idle seat at
/// another level gives way to a new one.
#[test]
fn a_scheduled_run_never_replaces_a_leads_seat() {
    use nunchiro_core::team::Level;
    let l = leads("sch-leadseat");
    let (home, proj) = (&l.home, &l.proj);
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let ask = |request: Value| raw(home, owner.trim(), request);
    let live = |label: &str| -> Vec<Session> {
        rows(home)
            .into_iter()
            .filter(|r| r.label == label && r.state == SessionState::Running)
            .collect()
    };
    // Both seats open at Standard, their briefs taken and that turn finished: idle seats.
    let opened = raw(home, &l.chief, json!({"op":"team_open","name":"Inbox"}));
    assert_eq!(opened["Ok"]["session"]["level"], "standard", "{opened}");
    let mut seats = vec![];
    for name in ["Chief", "Inbox"] {
        wait(&format!("{name} never took its brief"), || {
            live(name).first().is_some_and(|r| {
                r.send_queue.is_empty() && output(home, &r.id).contains(&format!("You are {name}"))
            })
        });
        let seat = live(name).remove(0);
        assert_eq!(seat.level, Some(Level::Standard));
        // The brief's turn ends (the fake agent sends no hooks).
        hook(home, &seat.id, "UserPromptSubmit");
        hook(home, &seat.id, "Stop");
        seats.push(seat.id);
    }
    let (chief, inbox) = (seats[0].clone(), seats[1].clone());
    let add = |who: &str, task: &str| {
        let run = Run {
            task: Some(task.into()),
            teammate: Some(l.ids[who].clone()),
            level: Some(Level::Light),
            ..run(proj, "x")
        };
        let added = ask(json!({"op":"schedule_add","run":run,"at":"03:30","daily":true}));
        added["Ok"]["schedules"]
            .as_array()
            .unwrap_or_else(|| panic!("{added}"))
            .iter()
            .find(|e| e["run"]["task"] == task)
            .unwrap()
            .clone()
    };
    let run_now = |entry: &Value| {
        let ran = ask(json!({"op":"schedule_run_now","id":entry["id"]}));
        ran["Ok"]["schedules"]
            .as_array()
            .unwrap_or_else(|| panic!("{ran}"))
            .iter()
            .find(|e| e["id"] == entry["id"])
            .unwrap()["last"]["session"]
            .as_str()
            .unwrap()
            .to_string()
    };
    // The lead: no level stored, the same seat before and after, the task in it.
    let for_lead = add("Chief", "count the files");
    assert!(for_lead["run"].get("level").is_none(), "{for_lead}");
    assert_eq!(
        run_now(&for_lead),
        chief,
        "the lead's seat is the run's session"
    );
    let now = live("Chief");
    assert_eq!(
        (now.len(), now[0].id.as_str(), now[0].level),
        (1, chief.as_str(), Some(Level::Standard))
    );
    wait("the task never arrived in the lead's seat", || {
        output(home, &chief).contains("count the files")
    });
    // A lead's proposal for a lead (the project's own): the level asked is dropped and the line says the lead's own.
    // (The user speaks to it first: its seat was opened by a schedule, and a scheduled run proposes nothing.)
    ask(json!({"op":"agent_prompt","id":live("Main")[0].id,"text":"good morning"}));
    let proposed = raw(
        home,
        &l.main,
        json!({"op":"schedule_propose","who":"Main","when":"daily 21:00","task":"Plan the day.","level":"light"}),
    );
    assert_eq!(
        proposed["Ok"]["text"], "Main · Every day 9:00 PM · Sonnet: Plan the day.",
        "{proposed}"
    );
    let card = ask(json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
        .as_array()
        .and_then(|cards| cards.iter().find(|c| c["owner"]["change"] != "failed"))
        .cloned()
        .unwrap_or_default();
    assert!(card["owner"]["run"].get("level").is_none(), "{card}");
    // The assistant: the level is kept, and its idle Standard seat gives way to a Light one.
    let for_mate = add("Inbox", "sort the notes");
    assert_eq!(for_mate["run"]["level"], "light", "{for_mate}");
    let seat = run_now(&for_mate);
    assert_ne!(seat, inbox, "a new seat at the asked level");
    wait("the assistant's idle seat was not replaced", || {
        let now = live("Inbox");
        now.len() == 1 && now[0].id == seat && now[0].level == Some(Level::Light)
    });
}

/// Look 11-17 v8 (Home S2-C): a Once schedule that fired by the clock vanished from the list at once, with no dot and
/// no result. It stays: listed, switched off, with its last run (the session, and the result as it follows that
/// session); it never fires again by itself, a relaunch keeps it, and an edit to a later time arms it again.
#[test]
fn a_once_entry_that_fired_stays_switched_off_with_its_run() {
    use nunchiro_core::schedule::Outcome;
    let (home, proj, path) = setup("sch-once");
    talking_claude(&home);
    let mut core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    core.stop();
    let once = Schedules::load(&home)
        .add(
            Run {
                task: Some("count the files".into()),
                ..run(&proj, "counter")
            },
            "21:00".into(),
            false,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    let mut core = serve(&home, &path);
    wait("the once entry never ran", || {
        entry(&home, &once.id).last.is_some()
    });
    let fired = entry(&home, &once.id);
    let runs = || -> Vec<Session> {
        rows(&home)
            .into_iter()
            .filter(|r| r.label == "counter")
            .collect()
    };
    let session = runs().remove(0).id;
    assert_eq!(
        (fired.paused, fired.daily, fired.id.as_str()),
        (true, false, once.id.as_str()),
        "listed, switched off"
    );
    let last = fired.last.clone().unwrap();
    assert_eq!(
        (last.session.as_deref(), last.result),
        (Some(session.as_str()), None)
    );
    // Its result follows the session's turn.
    let since = cursor(&home);
    hook(&home, &session, "UserPromptSubmit");
    wait_state(&home, since, &session, "working");
    hook(&home, &session, "Stop");
    wait("the result never followed the session", || {
        entry(&home, &once.id).last.unwrap().result == Some(Outcome::Finished)
    });
    // It never fires again by itself, also after a relaunch.
    thread::sleep(Duration::from_millis(2500));
    assert_eq!(runs().len(), 1);
    core.stop();
    let _core = serve(&home, &path);
    thread::sleep(Duration::from_millis(2500));
    let kept = entry(&home, &once.id);
    assert_eq!(
        (
            kept.paused,
            kept.last.unwrap().session.as_deref(),
            runs().len()
        ),
        (true, Some(session.as_str()), 1),
        "a relaunch keeps it, and it does not run"
    );
    // An edit to a later time switches it on again; its last run stays.
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let edited = raw(
        &home,
        owner.trim(),
        json!({"op":"schedule_add","run":fired.run,"at":"03:30","daily":false,"replace":once.id}),
    );
    let row = edited["Ok"]["schedules"][0].clone();
    assert!(
        row.get("paused").is_none()
            && row["next_ms"].as_u64().unwrap() > now_ms()
            && row["last"]["session"] == session.as_str(),
        "{edited}"
    );
}

/// Look 11-17 v8 (Home S2-B): a failed run was listed under "Needs you" and nowhere else: the Team badge, the lead's
/// chip and the Decisions count did not include it. A failed run is an owner card (`owner.type` "schedule", `change`
/// "failed"), so every count is the same number. One card per schedule; allow_once runs it again now, deny dismisses
/// the card (the entry keeps its failed last run); the card goes by itself when the entry is switched off, edited,
/// removed, or runs well.
#[test]
fn a_failed_run_is_an_owner_card() {
    use nunchiro_core::schedule::Outcome;
    use nunchiro_core::team::Team;
    let (home, proj, path) = setup("sch-card");
    talking_claude(&home);
    let _core = serve(&home, &path);
    shell(&home, &proj, "exec cat");
    let team = Team::open(&home);
    let lister = team
        .save(None, teammate("Lister", None, false))
        .unwrap()
        .remove(0);
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let ask = |request: Value| raw(&home, owner.trim(), request);
    let cards = || -> Vec<Value> {
        ask(json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let add = |task: &str| {
        let run = Run {
            task: Some(task.into()),
            teammate: Some(lister.id.clone()),
            ..run(&proj, "x")
        };
        let added = ask(json!({"op":"schedule_add","run":run,"at":"03:30","daily":true}));
        added["Ok"]["schedules"]
            .as_array()
            .unwrap_or_else(|| panic!("{added}"))
            .iter()
            .find(|e| e["run"]["task"] == task)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let (a, b) = (add("list the files"), add("count the files"));
    team.remove(&lister.id).unwrap();
    let run_now = |id: &str| ask(json!({"op":"schedule_run_now","id":id}));
    let failed = run_now(&a);
    assert_eq!(failed["Err"], "Lister is no longer a teammate", "{failed}");
    let all = cards();
    assert_eq!(all.len(), 1, "{all:?}");
    let card = all[0].clone();
    let place = team.home();
    assert_eq!(
        card,
        json!({
            "id": card["id"], "session_id": a, "scope": "owner", "kind": "owner",
            "text": "run the schedule again (it failed: Lister is no longer a teammate): Lister · Every day 3:30 AM: list the files",
            "choices": [], "sources": ["owner"], "observed_at": card["observed_at"], "actionable": true,
            "reconciled": false, "hook_event_id": null, "screen_text": null,
            "owner": {
                "type": "schedule", "change": "failed", "id": a,
                "run": {"kind": "claude", "project": place, "label": "Lister", "task": "list the files", "teammate": lister.id},
                "when": {"at": "03:30", "daily": true},
                "place": place,
                "line": "Lister · Every day 3:30 AM: list the files",
                "reason": "Lister is no longer a teammate",
            },
        }),
        "the card as the window sees it"
    );
    // A second failure of the same schedule is the same one card; another schedule's is its own.
    run_now(&a);
    assert_eq!(cards().len(), 1);
    run_now(&b);
    assert_eq!(cards().len(), 2);
    let card_of = |id: &str| cards().into_iter().find(|c| c["owner"]["id"] == id);
    let answer = |card: &Value, kind: &str| {
        ask(json!({"op":"answer","item":card["id"],"answer":{"type":kind},"confirmed":true}))
    };
    // Deny dismisses the card; the entry keeps its failed run (the row's red dot).
    let dismissed = answer(&card_of(&b).unwrap(), "deny");
    assert!(dismissed["Ok"].is_object(), "{dismissed}");
    assert!(card_of(&b).is_none());
    assert_eq!(entry(&home, &b).last.unwrap().result, Some(Outcome::Failed));
    // Look 11-17 v9 (Home S2-1): dismissed is gone from Home's "Needs you" (the digest) too; `a`'s card still waits.
    let digest = ask(json!({"op":"task","operation":"digest"}));
    let listed: Vec<&str> = digest["Ok"]["failed_runs"]
        .as_array()
        .unwrap_or_else(|| panic!("{digest}"))
        .iter()
        .filter_map(|f| f["schedule"].as_str())
        .collect();
    assert_eq!(listed, [a.as_str()], "{digest}");
    // Switched off by the user: the card goes by itself. So does the card of an edited or removed entry.
    run_now(&b);
    assert!(card_of(&b).is_some());
    ask(json!({"op":"schedule_pause","id":b,"paused":true}));
    assert!(card_of(&b).is_none(), "switched off");
    run_now(&b);
    ask(json!({"op":"schedule_remove","id":b}));
    assert!(card_of(&b).is_none(), "removed");
    // Allow once runs it again now (as Run now): it fails again, so the card is back with the newer failure.
    let first = entry(&home, &a).last.unwrap().at;
    let again = answer(&card_of(&a).unwrap(), "allow_once");
    assert!(again["Ok"].is_object(), "{again}");
    wait("the failed run was not run again", || {
        entry(&home, &a).last.unwrap().at > first && card_of(&a).is_some()
    });
    // Look 11-17 v9 (Home S2-5): the teammate is added again under the same name (a new id). It takes the schedule
    // over with no edit: the run starts its seat, the entry now names it and the card goes.
    let back = team
        .save(None, teammate("Lister", None, false))
        .unwrap()
        .into_iter()
        .find(|t| t.name == "Lister")
        .unwrap();
    assert_ne!(back.id, lister.id);
    let ran = run_now(&a);
    assert!(ran["Ok"].is_object(), "{ran}");
    assert_eq!(entry(&home, &a).run.teammate, Some(back.id.clone()));
    assert!(cards().is_empty(), "{:?}", cards());
    // A run whose session ends before the task is done is a failed run too: its card. The run before it failed as
    // well (Allow once above), so the card names the streak (ticket 1002 lane 4).
    let session = entry(&home, &a).last.unwrap().session.unwrap();
    let since = cursor(&home);
    hook(&home, &session, "UserPromptSubmit");
    wait_state(&home, since, &session, "working");
    call(&home, Request::Close { id: session }).unwrap();
    wait("a run that ended in its turn raised no card", || {
        card_of(&a).is_some_and(|c| {
            c["owner"]["reason"]
                == "the session ended before the task was done · second time in a row"
        })
    });
    // It runs well: the card goes by itself.
    assert!(run_now(&a)["Ok"].is_object());
    assert!(cards().is_empty());
}

/// Look 11-17 v13 N2: an edit of a schedule whose teammate was removed saves, and keeps its teammate target (the
/// stored folder and name) and its switch; an edit that names another missing teammate is still refused.
#[test]
fn an_edit_of_a_removed_teammates_schedule_saves_and_keeps_its_target() {
    use nunchiro_core::team::Team;
    let (home, proj, _) = setup("sch-gone-edit");
    let team = Team::open(&home);
    let lister = team
        .save(None, teammate("Lister", Some(proj.clone()), false))
        .unwrap()
        .remove(0);
    let mut s = Schedules::load(&home);
    let mate = |task: &str, id: &str| Run {
        task: Some(task.into()),
        teammate: Some(id.into()),
        ..run(&proj, "x")
    };
    let old = s
        .add(
            mate("list the files", &lister.id),
            "21:00".into(),
            true,
            None,
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    s.pause(&old.id, true, 0, UTC).unwrap();
    team.remove(&lister.id).unwrap();
    // The form sends the stored run with the new task.
    let sent = Run {
        task: Some("count the files".into()),
        ..old.run.clone()
    };
    let edited = s
        .add(
            sent,
            "21:00".into(),
            true,
            Some(&old.id),
            &known(&proj),
            0,
            UTC,
        )
        .unwrap();
    let all = s.list().unwrap();
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(all[0].id, edited.id);
    let run = &all[0].run;
    assert_eq!(
        (
            run.teammate.as_deref(),
            run.label.as_str(),
            run.project.as_path(),
            run.task.as_deref()
        ),
        (
            Some(lister.id.as_str()),
            "Lister",
            proj.as_path(),
            Some("count the files")
        )
    );
    assert!(all[0].paused, "the edit keeps the schedule switched off");
    // Another missing teammate is not the edited one's: refused as before.
    let other = mate("x", "0123456789abcdef");
    assert!(
        s.add(
            other,
            "21:00".into(),
            true,
            Some(&edited.id),
            &known(&proj),
            0,
            UTC
        )
        .is_err()
    );
}
