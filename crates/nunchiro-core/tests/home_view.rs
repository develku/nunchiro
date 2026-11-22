//! Home view (2026-11-17, docs/design/leader-room/home-view-1117.html): through a real `serve`, a Home lead and two
//! projects, one with a lead and one without. Change 1: the digest's counts and order come from the core. Change 4: a
//! goal goes through the user's card (Send writes the room line with its origin and wakes the lead; Not now tells the
//! Home lead; no lead: refused). Change 5: the Home lead reads every place's tasks and writes nowhere else; a project's
//! lead reads its own place only.
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
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
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
fn mate(home: &Path, name: &str, project: Option<PathBuf>) -> Teammate {
    Team::open(home)
        .save(
            None,
            Teammate {
                id: String::new(),
                name: name.into(),
                job: format!("{name}'s job."),
                kind: AgentKind::Claude,
                model: None,
                effort: None,
                project,
                lead: true,
                level: None,
                level_max: None,
                next_level: None,
                agent: None,
            },
        )
        .unwrap()
        .into_iter()
        .find(|t| t.name == name)
        .unwrap()
}
fn shell(home: &Path, project: &Path) {
    call(
        home,
        Request::Start {
            receipt: None,
            env: Default::default(),
            folder: None,
            session: StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: project.to_path_buf(),
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
}

#[test]
fn home_view_digest_goal_card_and_read_only_reach() {
    let home = home::short("home-view");
    fs::create_dir_all(home.join("bin")).unwrap();
    let claude = home.join("bin/claude");
    fs::write(
        &claude,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi\nprintf '\\342\\235\\257 \\n'\necho \"TOKEN=$NUNCHIRO_TOKEN.\"\nexec cat\n",
    )
    .unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o700)).unwrap();
    let path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    let [alpha, beta] = ["alpha", "beta"].map(|n| {
        fs::create_dir_all(home.join(n)).unwrap();
        fs::canonicalize(home.join(n)).unwrap()
    });
    let serve = || {
        home::spawn_serve(
            &home,
            &[
                ("PATH", path.as_str()),
                (
                    "CLAUDE_CONFIG_DIR",
                    &home.join("claude-home").to_string_lossy(),
                ),
            ],
        )
    };
    let mut core = serve();
    // A session in each project, so the core knows both.
    shell(&home, &alpha);
    shell(&home, &beta);
    core.stop();
    let chief = mate(&home, "Chief", None);
    let main = mate(&home, "Main", Some(alpha.clone()));
    // Both seats open as a schedule opens them in the app (a missed fire runs at the next start).
    let mut s = Schedules::load(&home);
    for m in [&chief, &main] {
        s.add(
            Run {
                kind: AgentKind::Claude,
                project: alpha.clone(),
                label: "x".into(),
                model: None,
                effort: None,
                task: Some("start".into()),
                teammate: Some(m.id.clone()),
                level: None,
            },
            "21:00".into(),
            false,
            None,
            &BTreeSet::from([alpha.to_string_lossy().into_owned()]),
            0,
            &|_| 0,
        )
        .unwrap();
    }
    drop(s);
    let _core = serve();
    wait("the seats did not open", || {
        let r = rows(&home);
        ["Chief", "Main"]
            .iter()
            .all(|n| r.iter().any(|s| s.label == *n))
    });
    let seat = |name: &str| rows(&home).into_iter().find(|r| r.label == name).unwrap();
    let (chief_seat, main_seat) = (seat("Chief"), seat("Main"));
    let (chief_t, main_t) = (
        token_of(&home, &chief_seat.id),
        token_of(&home, &main_seat.id),
    );
    let owner = fs::read_to_string(home.join("core.token")).unwrap();
    let owner = owner.trim();
    let task = |token: &str, request: Value| {
        let mut request = request;
        request["op"] = "task".into();
        raw(&home, token, request)
    };
    let titles = |reply: &Value| -> Vec<String> {
        reply["Ok"]["tasks"]
            .as_array()
            .unwrap_or_else(|| panic!("{reply}"))
            .iter()
            .map(|t| t["title"].as_str().unwrap().to_string())
            .collect()
    };
    let made = task(&main_t, json!({"operation":"new","text":"Login page"}));
    let alpha_task = made["Ok"]["tasks"][0]["id"].as_str().unwrap().to_string();
    task(&chief_t, json!({"operation":"new","text":"Morning brief"}));

    // Change 5: the Home lead lists every place, read only; its writes stay in its own place; a project's lead lists
    // its own place only.
    let all = task(&chief_t, json!({"operation":"list-all"}));
    let mut got = titles(&all);
    got.sort();
    assert_eq!(got, ["Login page", "Morning brief"], "{all}");
    assert_eq!(
        titles(&task(&chief_t, json!({"operation":"list"}))),
        ["Morning brief"]
    );
    for write in [
        json!({"operation":"done","id":alpha_task}),
        json!({"operation":"drop","id":alpha_task}),
        json!({"operation":"staff","id":alpha_task,"text":"builder"}),
        json!({"operation":"merge","id":alpha_task}),
        json!({"operation":"learn","id":alpha_task,"text":"x"}),
    ] {
        let refused = task(&chief_t, write.clone());
        assert!(
            // Look 1117 home S2-5: a refusal that says what it is and what to do instead.
            refused["Err"].as_str().is_some_and(|e| e.contains(
                "the Home lead reads other projects' tasks; it cannot change them. Send a goal to that project's lead with nunchiro task goal"
            )),
            "{write} {refused}"
        );
    }
    // Look 1117 home S2-4: `--project <other>` lists that place for the Home lead (read only), and it reads the digest.
    assert_eq!(
        titles(&task(&chief_t, json!({"operation":"list","project":alpha}))),
        ["Login page"]
    );
    assert_eq!(
        titles(&task(&chief_t, json!({"operation":"show","id":alpha_task}))),
        ["Login page"]
    );
    let seen = task(&chief_t, json!({"operation":"digest"}));
    assert_eq!(
        seen["Ok"]["projects"].as_array().map(|p| p.len()),
        Some(2),
        "{seen}"
    );
    let mine = task(&main_t, json!({"operation":"list-all"}));
    assert!(
        mine["Err"]
            .as_str()
            .is_some_and(|e| e.contains("only the Home lead")),
        "{mine}"
    );
    assert_eq!(
        titles(&task(&main_t, json!({"operation":"list"}))),
        ["Login page"]
    );

    // Change 4: no lead, no goal; a project lead asks none; the Home lead's goal is the user's card.
    let none = task(
        &chief_t,
        json!({"operation":"goal","text":"Ship it","project":beta}),
    );
    assert!(
        none["Err"]
            .as_str()
            .is_some_and(|e| e.contains("beta has no leader")),
        "{none}"
    );
    assert!(
        task(
            &main_t,
            json!({"operation":"goal","text":"Ship it","project":alpha})
        )["Err"]
            .is_string()
    );
    // Security look 11-17: a yes that cannot write the goal into the room (a full room here) refuses and leaves the
    // card waiting; Not now on it still works.
    let log = {
        use sha2::{Digest, Sha256};
        let key = Sha256::digest(alpha.as_os_str().as_encoded_bytes());
        let key: String = key[..8].iter().map(|b| format!("{b:02x}")).collect();
        home.join("room").join(key).join("log.jsonl")
    };
    fs::create_dir_all(log.parent().unwrap()).unwrap();
    let kept = fs::read(&log).unwrap_or_default();
    let mut full = kept.clone();
    full.extend(std::iter::repeat_n(b' ', 8 << 20));
    full.push(b'\n');
    fs::write(&log, &full).unwrap();
    task(
        &chief_t,
        json!({"operation":"goal","text":"Into a full room","project":alpha}),
    );
    let card = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
        .as_array()
        .and_then(|cards| cards.iter().find(|c| c["owner"]["change"] != "failed"))
        .cloned()
        .unwrap_or_default();
    let refused = raw(
        &home,
        owner,
        json!({"op":"answer","item":card["id"],"answer":{"type":"allow_once"},"confirmed":true}),
    );
    assert!(
        refused["Err"]
            .as_str()
            .is_some_and(|e| e.contains("the goal was not sent")),
        "{refused}"
    );
    let waiting = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"].clone();
    assert!(
        waiting
            .as_array()
            .is_some_and(|a| a.iter().any(|c| c["id"] == card["id"])),
        "the card waits: {waiting}"
    );
    let no = raw(
        &home,
        owner,
        json!({"op":"answer","item":card["id"],"answer":{"type":"deny"}}),
    );
    assert!(no["Err"].is_null(), "{no}");
    let left = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"].clone();
    assert!(
        // (A scheduled run of this scene that could not deliver its brief leaves its own card: not this test's.)
        left.as_array()
            .is_none_or(|a| a.iter().all(|c| c["owner"]["change"] == "failed")),
        "Not now cleared it: {left}"
    );
    fs::write(&log, &kept).unwrap();

    let before = nunchiro_core::queue::now_ms();
    let asked = task(
        &chief_t,
        json!({"operation":"goal","text":"Ship the login page by Friday","project":alpha}),
    );
    assert!(asked["Ok"].is_object(), "{asked}");
    let card = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
        .as_array()
        .and_then(|cards| cards.iter().find(|c| c["owner"]["change"] != "failed"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        (
            card["owner"]["type"].as_str(),
            card["owner"]["lead"].as_str(),
            card["owner"]["from"].as_str()
        ),
        (Some("goal"), Some(main.id.as_str()), Some("Chief")),
        "{card}"
    );
    assert_eq!(
        card["text"],
        "Chief wants to give alpha's lead this goal: Ship the login page by Friday"
    );
    // Nothing reached the project yet.
    let room = |project: &Path| {
        raw(&home, owner, json!({"op":"room_read","project":project}))["Ok"]["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    assert!(room(&alpha).iter().all(|m| m["team"]["what"] != "goal"));

    // Change 1: the digest, from the core: alpha (a lead, an open task, the card) before beta (no lead, never counted).
    let digest = |since: u64| {
        let d = task(
            owner,
            json!({"operation":"digest","text":since.to_string()}),
        );
        d["Ok"]["projects"]
            .as_array()
            .unwrap_or_else(|| panic!("{d}"))
            .clone()
    };
    let d = digest(before);
    // Gate of wave 16: on the slower gate machine a scheduled run of this scene that could not deliver its brief
    // leaves a failed-run card, and a waiting failed run counts in Needs you (look v9 Home S2-1). It is not this
    // test's: alpha's needs is its own card plus at most the failed-run cards seen after the digest.
    let failed = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
        .as_array()
        .map_or(0, |a| {
            a.iter()
                .filter(|c| c["owner"]["change"] == "failed")
                .count() as u64
        });
    let needs = d[0]["needs"].as_u64().unwrap();
    assert!(
        (1..=1 + failed).contains(&needs),
        "alpha needs {needs}, failed-run cards {failed}: {d:?}"
    );
    let view: Vec<_> = d
        .iter()
        .map(|r| {
            (
                r["project"].as_str().unwrap().to_string(),
                r["lead"].as_str().map(String::from),
                r["open"].as_u64().unwrap(),
                r["needs"].as_u64().unwrap().min(1),
                r["decisions"].as_u64().unwrap().min(1), // a failed-run card of the scene may be new too
            )
        })
        .collect();
    assert_eq!(
        view,
        [
            (
                alpha.to_string_lossy().into_owned(),
                Some(main.id.clone()),
                1,
                1,
                1
            ),
            (beta.to_string_lossy().into_owned(), None, 0, 0, 0),
        ],
        "{d:?}"
    );
    // The oldest is this test's card, or a failed-run card of the scene raised before it (the gate machine, wave 17).
    let oldest = d[0]["oldest"].clone();
    let failed_ids: Vec<Value> =
        raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
            .as_array()
            .map_or(vec![], |a| {
                a.iter()
                    .filter(|c| c["owner"]["change"] == "failed")
                    .map(|c| c["id"].clone())
                    .collect()
            });
    assert!(
        oldest == card["id"] || failed_ids.contains(&oldest),
        "oldest {oldest}: {d:?}"
    );
    assert_eq!(digest(0)[0]["decisions"], 0, "no cursor: nothing is new");
    assert!(
        task(&main_t, json!({"operation":"digest"}))["Err"].is_string(),
        "an agent reads no digest"
    );

    // Send: the line in alpha's room says where it came from and who approved it; the lead's seat gets the goal.
    let yes = raw(
        &home,
        owner,
        json!({"op":"answer","item":card["id"],"answer":{"type":"allow_once"},"confirmed":true}),
    );
    assert!(yes["Err"].is_null(), "{yes}");
    let line = room(&alpha)
        .into_iter()
        .find(|m| m["team"]["what"] == "goal")
        .expect("the goal line");
    assert_eq!(
        line["body"],
        "Goal from Chief (the Home lead), approved by the user: Ship the login page by Friday"
    );
    assert_eq!(line["to"], main_seat.id.as_str());
    assert_eq!(line["created_by"], "core");
    wait("the lead was not woken with the goal", || {
        rows(&home).iter().any(|r| {
            r.id == main_seat.id
                && r.send_log
                    .iter()
                    .chain(&r.send_queue)
                    .any(|s| s.content.contains("Ship the login page by Friday"))
        })
    });
    // The scene's failed-run cards (a brief the loaded gate machine could not write in time) are not this test's.
    let failed_now = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
        .as_array()
        .map_or(0, |a| {
            a.iter()
                .filter(|c| c["owner"]["change"] == "failed")
                .count() as u64
        });
    assert!(
        digest(before)[0]["needs"].as_u64().unwrap() <= failed_now,
        "the answered card is no longer counted"
    );
    // Look 1117 home S2-6: the Home lead hears Send too.
    let sent = room(&Team::open(&home).home())
        .into_iter()
        .find(|m| m["team"]["what"] == "goal_yes")
        .expect("the Home lead hears Send");
    assert_eq!(sent["to"], chief_seat.id.as_str());
    assert_eq!(
        sent["body"],
        "The user sent your goal to alpha's lead: \"Ship the login page by Friday\""
    );

    // Not now: nothing reaches alpha, and the Home lead hears it in Home's room.
    task(
        &chief_t,
        json!({"operation":"goal","text":"Rewrite everything","project":alpha}),
    );
    let card = raw(&home, owner, json!({"op":"snapshot"}))["Ok"]["owner_decisions"]
        .as_array()
        .and_then(|cards| cards.iter().find(|c| c["owner"]["change"] != "failed"))
        .cloned()
        .unwrap_or_default();
    let no = raw(
        &home,
        owner,
        json!({"op":"answer","item":card["id"],"answer":{"type":"deny"}}),
    );
    assert!(no["Err"].is_null(), "{no}");
    assert!(room(&alpha).iter().all(|m| {
        !m["body"]
            .as_str()
            .unwrap_or("")
            .contains("Rewrite everything")
    }));
    let heard = room(&Team::open(&home).home())
        .into_iter()
        .find(|m| {
            m["team"]["what"] == "goal_no"
                && m["body"]
                    .as_str()
                    .is_some_and(|b| b.contains("Rewrite everything"))
        })
        .expect("the Home lead hears the refusal");
    assert_eq!(heard["to"], chief_seat.id.as_str());
    assert!(
        heard["body"]
            .as_str()
            .unwrap()
            .contains("Rewrite everything")
    );
}
