//! Task dependencies, part 2: the rules the team works through. A seat that writes does not start on a task that waits;
//! one that does not write does. When a task lands, its lead hears once which tasks it freed; when it is dropped, the
//! tasks that waited for it ask. The owner's clear is told to the lead. Driven through the real CLI and a real core with
//! a running lead seat (a fake agent that never ends its turn, so the core's lines queue up and can be counted).
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::*,
    schedule::{Run, Schedules},
    server::call,
    team::{Team, Teammate},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
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
fn rows(home: &Path) -> Vec<Session> {
    match call(home, Request::Snapshot).unwrap() {
        Reply::Snapshot { sessions, .. } => sessions,
        other => panic!("{other:?}"),
    }
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
/// The owner's shell: `nunchiro task <args> --project <dir>`; (ok, stdout, stderr).
fn task(home: &Path, project: &Path, args: &[&str]) -> (bool, String, String) {
    let out = home::git_env::scrubbed(home::cli::path())
        .arg("task")
        .args(args)
        .arg("--project")
        .arg(project)
        .env("NUNCHIRO_HOME", home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn a_waiting_task_starts_no_writer_and_its_lead_hears_once_when_it_is_free() {
    let home = home::short("after-rules");
    fs::create_dir_all(home.join("bin")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let proj = home.join("proj");
    fs::create_dir_all(&proj).unwrap();
    let proj = fs::canonicalize(proj).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    let config = home.join("claude-home").to_string_lossy().into_owned();
    let serve = || {
        home::spawn_serve(
            &home,
            &[("PATH", path.as_str()), ("CLAUDE_CONFIG_DIR", &config)],
        )
    };
    // The project's lead, opened by a schedule as in the app.
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
            kind: AgentKind::Claude,
            project: proj.clone(),
            label: "x".into(),
            model: None,
            effort: None,
            task: Some("plan the day".into()),
            teammate: Some(main.id.clone()),
            level: None,
        },
        "21:00".into(),
        false,
        None,
        &BTreeSet::from([proj.to_string_lossy().into_owned()]),
        0,
        &|_| 0,
    )
    .unwrap();
    drop(s);
    let mut core = serve();
    wait("the lead's seat did not open", || {
        rows(&home).iter().any(|r| r.label == "Main")
    });
    let seat = rows(&home).into_iter().find(|r| r.label == "Main").unwrap();
    let mut lead = String::new();
    wait("the lead printed no token", || {
        output(&home, &seat.id)
            .split("TOKEN=")
            .nth(1)
            .and_then(|t| t.split('.').next())
            .filter(|t| !t.is_empty())
            .map(|t| lead = t.to_string())
            .is_some()
    });
    let as_lead = |request: Value| {
        let mut request = request;
        request["op"] = "task".into();
        let reply = raw(&home, &lead, request);
        assert!(reply["Ok"].is_object(), "{reply}");
        reply
    };
    // Every line the core queued or delivered to the lead's seat.
    let told = || {
        let row = rows(&home).into_iter().find(|r| r.id == seat.id).unwrap();
        // A queued row is in both lists: one line per row id.
        let rows: std::collections::BTreeMap<String, String> = row
            .send_log
            .iter()
            .chain(&row.send_queue)
            .map(|s| (s.id.clone(), s.content.clone()))
            .collect();
        rows.into_values().collect::<Vec<_>>()
    };
    let room = || {
        nunchiro_core::room::Log::open(&home, &proj)
            .find(|_| true)
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.body)
            .collect::<Vec<_>>()
    };
    let run = |args: &[&str]| task(&home, &proj, args);
    let ok = |args: &[&str]| {
        let (ok, out, err) = run(args);
        assert!(ok, "{args:?}: {err}");
        out
    };

    // a; b, c and d wait for a; d waits for x too.
    for (title, after) in [
        ("a", vec![]),
        ("x", vec![]),
        ("b", vec!["t1"]),
        ("c", vec!["t1"]),
        ("d", vec!["t1", "t2"]),
    ] {
        as_lead(json!({"operation":"new","text":title,"after":after}));
    }

    // Red first: a seat that writes starts on a waiting task before this change.
    let before = rows(&home).len();
    let (started, out, err) = run(&["staff", "t3", "builder"]);
    assert!(
        !started
            && err.contains(
                "Not started: \"b\" waits for \"a\", which has not landed. You are told when it lands. A seat that does not write files may start now. To stop waiting: nunchiro task after t3 --none"
            ),
        "{out}{err}"
    );
    assert_eq!(rows(&home).len(), before, "no session row appeared");
    // A writer started by hand and then assigned is held the same way.
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let hand = raw(
        &home,
        owner.trim(),
        json!({"op":"start","session":{"account":null,"kind":"claude","project":proj,"worktree":false,"label":"lane-b","args":[],"model":null,"effort":null,"resume":null}}),
    );
    let hand = hand["Ok"]["session"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{hand}"))
        .to_string();
    let (assigned, out, err) = run(&["assign", "t3", &hand]);
    assert!(
        !assigned && err.contains("Not started: \"b\" waits for \"a\""),
        "{out}{err}"
    );
    raw(&home, owner.trim(), json!({"op":"close","id":hand}));
    // A seat that does not write starts.
    ok(&["staff", "t3", "reviewer"]);
    assert!(rows(&home).iter().any(|r| r.label == "Reviewer · b"));

    // a lands: one line names b and c, and says d still waits.
    as_lead(json!({"operation":"done","id":"t1"}));
    let line = "\"a\" landed. \"b\" and \"c\" no longer wait: start them when you are ready. \"d\" still waits for 1 task.";
    wait("the lead was not told that a landed", || {
        told().iter().any(|c| c == line)
    });
    // Another close, a list, and a pass later: still one.
    ok(&["list"]);
    as_lead(json!({"operation":"new","text":"y"}));
    as_lead(json!({"operation":"done","id":"t6"}));
    assert_eq!(
        told().iter().filter(|c| c.contains("\"a\" landed")).count(),
        1,
        "{:?}",
        told()
    );
    // b's writer now starts.
    ok(&["staff", "t3", "builder"]);

    // e is dropped: f, which waited for it, asks; the lead hears.
    as_lead(json!({"operation":"new","text":"e"}));
    as_lead(json!({"operation":"new","text":"f","after":["t7"]}));
    as_lead(json!({"operation":"new","text":"g","after":["t8"]}));
    let dropped = ok(&["drop", "t7"]);
    assert!(dropped.contains("  1 task waits for this\n"), "{dropped}");
    let f = ok(&["show", "t8"]);
    assert!(
        f.contains("\nt8 [needs] f\n")
            && f.contains(
                "  asks: \"e\" was dropped, so this cannot start. Stop waiting for it, or drop this too?\n"
            ),
        "{f}"
    );
    wait("the lead was not told that e was dropped", || {
        told().iter().any(|c| {
            c == "\"e\" was dropped. \"f\" waited for it: stop waiting (nunchiro task after t8 --none) or drop it."
        })
    });
    // Drop this task: f goes as dropped, and g, which waited for f, asks in turn.
    ok(&["drop", "t8"]);
    assert!(ok(&["show", "t9"]).contains("\nt9 [needs] g\n"));
    // Stop waiting, by the owner: g clears, the lead is told in the room, and g's writer may start.
    ok(&["after", "t9", "--none"]);
    wait("the owner's clear was not told", || {
        room()
            .iter()
            .any(|b| b == "The owner let \"g\" start without waiting for \"f\".")
    });
    let g = ok(&["show", "t9"]);
    assert!(
        g.contains("\nt9 [idle] g\n") && g.contains("  order set by the user\n"),
        "{g}"
    );

    // A dependency added while a writer runs: the seat is left alone, the task says it started early.
    as_lead(json!({"operation":"after","id":"t3","after":["t2"]}));
    let b = ok(&["show", "t3"]);
    assert!(b.contains("  started before \"x\" landed\n"), "{b}");
    assert!(
        rows(&home)
            .iter()
            .any(|r| r.label == "Builder · b" && r.state == SessionState::Running),
        "the builder runs on"
    );

    for r in rows(&home) {
        let owner = fs::read_to_string(home.join("core.token")).unwrap();
        raw(&home, owner.trim(), json!({"op":"close","id":r.id}));
    }
    core.stop();
    let _ = fs::remove_dir_all(&home);
}
