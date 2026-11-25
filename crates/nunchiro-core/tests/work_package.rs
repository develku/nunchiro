//! Ticket 1095 slice 1: a task's work package through a real core and the `nunchiro task` CLI. The lead fills it, a
//! worker seat cannot, the staffed seat's first prompt carries it in full, and it outlives `task done` and a restart.
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
    process::Output,
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
fn token_of(home: &Path, id: &str) -> String {
    let mut token = String::new();
    wait("the session printed no token", || {
        let out = match call(
            home,
            Request::Read {
                id: id.into(),
                after: 0,
            },
        ) {
            Ok(Reply::Output { data, .. }) => String::from_utf8_lossy(&data).into_owned(),
            _ => String::new(),
        };
        out.split("TOKEN=")
            .nth(1)
            .and_then(|t| t.split('.').next())
            .filter(|t| !t.is_empty())
            .map(|t| token = t.to_string())
            .is_some()
    });
    token
}
fn git(dir: &Path, args: &[&str]) {
    assert!(
        home::git_env::scrubbed("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=F", "-c", "user.email=f@example.invalid"])
            .args(args)
            .status()
            .unwrap()
            .success()
    );
}
/// `nunchiro task <args>` as the session of `token`.
fn cli(home: &Path, token: &str, args: &[&str]) -> Output {
    home::git_env::scrubbed(home::cli::path())
        .arg("task")
        .args(args)
        .env("NUNCHIRO_HOME", home)
        .env("NUNCHIRO_TOKEN", token)
        .output()
        .unwrap()
}
fn ok(out: Output) -> String {
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        out.status.success(),
        "{text}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    text
}

#[test]
fn a_lead_fills_the_package_the_seat_gets_it_in_full_and_it_outlives_done_and_a_restart() {
    let home = home::short("package");
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
    git(&proj, &["init", "-q", "-b", "main"]);
    fs::write(proj.join("a.txt"), "a\n").unwrap();
    git(&proj, &["add", "."]);
    git(&proj, &["commit", "-q", "-m", "first"]);
    let serve = || {
        home::spawn_serve(
            &home,
            &[
                ("PATH", path.as_str()),
                (
                    "CLAUDE_CONFIG_DIR",
                    &home.join("claude-home").to_string_lossy(),
                ),
                // The worktrees go under <HOME>/nunchiro: the test's home, never the user's own folder.
                ("HOME", &home.to_string_lossy()),
            ],
        )
    };
    let mut core = serve();
    call(
        &home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: proj.clone(),
                worktree: false,
                label: "keeper".into(),
                args: vec!["/bin/sh".into(), "-c".into(), "exec cat".into()],
                model: None,
                effort: None,
                resume: None,
            },
        },
    )
    .unwrap();
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
    let lead = token_of(&home, &seat.id);
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim().to_string();
    let task = |token: &str, mut request: Value| {
        request["op"] = "task".into();
        raw(&home, token, request)
    };

    // The task and its worktree, as a lead makes them.
    let made = task(&lead, json!({"operation":"new","text":"Package card"}));
    assert_eq!(made["Ok"]["tasks"][0]["id"], "t1", "{made}");
    // Before anything is in its package, `show` prints what it printed before the package existed.
    let bare = ok(cli(&home, &lead, &["show", "t1"]));
    assert_eq!(
        bare,
        "Way of working here: team (levels.md). Seats here ask the user before each edit and command. Auto-advance: on, up to 4 seats at once.\nt1 [idle] Package card\n"
    );
    let created = raw(
        &home,
        &lead,
        json!({"op":"worktree","operation":"create","project":proj,"path":null,"branch":"lane-pkg","base":"HEAD","label":""}),
    );
    let wt = created["Ok"]["worktrees"]
        .as_array()
        .unwrap_or_else(|| panic!("{created}"))
        .iter()
        .find(|w| w["branch"] == "lane-pkg")
        .unwrap()["path"]
        .as_str()
        .unwrap()
        .to_string();
    let attached = task(&lead, json!({"operation":"attach","id":"t1","path":wt}));
    assert!(attached["Ok"].is_object(), "{attached}");

    // The owner's attached image, and one outside the images folder (threat 3: refused).
    fs::create_dir_all(home.join("images/s9")).unwrap();
    let shot = home.join("images/s9/shot.png");
    fs::write(&shot, b"IMAGE-BYTES").unwrap();
    let outside = home.join("outside.png");
    fs::write(&outside, b"IMAGE-BYTES").unwrap();

    // Through the CLI: two long quotes, the lead's background (together over the notes' 6 KB), a line, a mockup.
    let q1 = format!("{}\n두 번째 줄", "보드 안에서 결과물을 확인. ".repeat(80)); // about 3.5 KB
    let q2 = "what the lead answered. ".repeat(150); // about 3.6 KB
    let bg = format!(
        "{} end of background",
        "Decided before: keep the ledger. ".repeat(110)
    );
    assert!(q1.len() + q2.len() + bg.len() > 6 * 1024);
    let when = "2026-11-24 09:40";
    let refused = cli(
        &home,
        &lead,
        &[
            "package",
            "t1",
            "quote",
            "x",
            "--who",
            "the user",
            "--when",
            when,
            "--image",
            outside.to_str().unwrap(),
        ],
    );
    assert!(!refused.status.success());
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("no attached image"),
        "{refused:?}"
    );
    let shown = ok(cli(
        &home,
        &lead,
        &[
            "package",
            "t1",
            "quote",
            &q1,
            "--who",
            "the user",
            "--when",
            when,
            "--image",
            shot.to_str().unwrap(),
        ],
    ));
    assert!(
        shown.contains("  package:\n    quote 1, the user, 2026-11-24 09:40: \""),
        "{shown}"
    );
    ok(cli(
        &home,
        &lead,
        &[
            "package",
            "t1",
            "quote",
            &q2,
            "--who",
            "Lead · Main",
            "--when",
            when,
        ],
    ));
    ok(cli(&home, &lead, &["package", "t1", "background", &bg]));
    ok(cli(
        &home,
        &lead,
        &["package", "t1", "see", "The card says Shown 0 of 1"],
    ));
    // Security look round 2: the lead cannot mark the owner's approval; the user's own shell can.
    let mockup = [
        "package",
        "t1",
        "link",
        "docs/design/work-package/card.html",
        "--kind",
        "mockup",
        "--approved",
    ];
    for args in [&["package", "t1", "approve", "1"][..], &mockup[..]] {
        let refused = cli(&home, &lead, args);
        assert!(
            String::from_utf8_lossy(&refused.stderr).contains("only the user marks"),
            "{refused:?}"
        );
    }
    let user = |args: &[&str]| {
        ok(home::git_env::scrubbed(home::cli::path())
            .arg("task")
            .args(args)
            .args(["--project", proj.to_str().unwrap()])
            .env("NUNCHIRO_HOME", &home)
            .env_remove("NUNCHIRO_TOKEN")
            .output()
            .unwrap())
    };
    user(&["package", "t1", "approve", "1"]);
    user(&mockup);
    // A quote is never edited: no part does it, and the words are as they were added.
    let edit = cli(&home, &lead, &["package", "t1", "edit", "1", "other words"]);
    assert!(!edit.status.success());
    let package = |token: &str| {
        task(token, json!({"operation":"show","id":"t1"}))["Ok"]["tasks"][0]["package"].clone()
    };
    assert_eq!(package(&lead)["excerpt"][0]["text"], q1.as_str());
    assert_eq!(package(&lead)["excerpt"][0]["images"], json!([shot]));

    // The Builder, staffed by the lead through the CLI: its first prompt carries every word of the excerpt and the
    // background, after the notes' head and before the lead's own words.
    let staffed = ok(cli(
        &home,
        &lead,
        &[
            "staff",
            "t1",
            "Builder",
            "--prompt",
            "Read BRIEF.md in your folder.",
        ],
    ));
    assert!(staffed.starts_with("started "), "{staffed}");
    let builder = rows(&home)
        .into_iter()
        .find(|r| r.label.starts_with("Builder"))
        .unwrap();
    let first = || {
        rows(&home)
            .into_iter()
            .find(|r| r.id == builder.id)
            .unwrap()
            .send_log
            .iter()
            .chain(&builder.send_queue)
            .map(|s| s.content.clone())
            .find(|c| c.contains("Read BRIEF.md in your folder."))
    };
    wait("the builder's first prompt was not recorded", || {
        first().is_some()
    });
    let first = first().unwrap();
    assert!(
        first.starts_with("You sit on a task as Builder."),
        "{first}"
    );
    for line in q1.lines().chain(q2.lines()) {
        assert!(
            first.contains(&format!("  > {line}\n")),
            "a quote line is missing: {line}"
        );
    }
    assert!(first.contains(&bg) && first.contains("Background, the lead's words (not the user's)"));
    assert!(first.contains(&format!(
        "  image (a file to open if you need it): {}",
        shot.display()
    )));
    assert!(
        !first.contains("IMAGE-BYTES"),
        "an image is a path, never its bytes"
    );
    assert!(first.contains("- The card says Shown 0 of 1 (approved by the user)"));
    assert!(
        first.ends_with("\nRead BRIEF.md in your folder."),
        "{first}"
    );
    // Its brief is kept as sent.
    let brief = &package(&lead)["briefs"][0];
    assert_eq!(
        (brief["session"].as_str(), brief["text"].as_str()),
        (
            Some(builder.id.as_str()),
            Some("Read BRIEF.md in your folder.")
        )
    );

    // Threat 1: the worker seat cannot add, remove or change a line of the package.
    let worker = token_of(&home, &builder.id);
    for (operation, text) in [
        ("package-quote", "I said so"),
        ("package-unquote", "1"),
        ("package-background", "x"),
        ("brief", "x"),
    ] {
        let refused = task(
            &worker,
            json!({"operation":operation,"id":"t1","text":text,"session":builder.id,"package":{"who":"the user","when":when}}),
        );
        assert!(
            refused["Err"]
                .as_str()
                .is_some_and(|e| e.contains("only the lead of a place or the user")),
            "{operation}: {refused}"
        );
    }
    assert_eq!(package(&owner)["excerpt"].as_array().unwrap().len(), 2);

    // Done, then a core restart: the package is still there, in `show` and with the closed tasks.
    ok(cli(&home, &lead, &["done", "t1"]));
    let closed = cli(&home, &lead, &["package", "t1", "see", "late"]);
    assert!(
        String::from_utf8_lossy(&closed.stderr).contains("is closed"),
        "{closed:?}"
    );
    core.stop();
    let _core = serve();
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim().to_string();
    let kept = package(&owner);
    assert_eq!(kept["excerpt"][0]["text"], q1.as_str());
    assert_eq!(kept["background"]["text"], bg.as_str());
    assert_eq!(kept["links"][0]["approved"]["by"], "the user");
    assert!(
        kept["see"][0]["approved"]["at"]
            .as_u64()
            .is_some_and(|at| at > 0)
    );
    let all = task(
        &owner,
        json!({"operation":"list","all":true,"project":proj}),
    );
    assert_eq!(all["Ok"]["tasks"][0]["state"], "done", "{all}");
    let shown = ok(home::git_env::scrubbed(home::cli::path())
        .args(["task", "show", "t1", "--project", proj.to_str().unwrap()])
        .env("NUNCHIRO_HOME", &home)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap());
    assert!(
        shown.contains("    background by Main (the lead's text): Decided before"),
        "{shown}"
    );
    assert!(
        shown.contains("    you will see 1 [not shown yet, approved by the user at "),
        "{shown}"
    );
    assert!(
        shown.contains("    link 1 mockup, approved by the user at "),
        "{shown}"
    );
    assert!(
        !fs::read_to_string(home.join("ledger.json"))
            .unwrap()
            .contains("보드")
    );
}
