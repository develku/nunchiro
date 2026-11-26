use super::*;

/// Ticket 1054 round 2 (Codex security look): a key, a colon and the secret on the next line is still masked.
#[test]
fn a_review_note_masks_a_secret_on_the_next_line() {
    let got = note("password:\ncorrect-horse-battery-staple");
    assert!(!got.contains("correct-horse"), "{got}");
    let got = note("token =\n  sk-ant-TEST0000000000abcdef\nmore");
    assert!(!got.contains("sk-ant-TEST"), "{got}");
}
#[test]
fn a_review_note_keeps_its_lines() {
    let text = "1. tax rounds down  \n2. no test for 0\n\nfix both";
    assert_eq!(
        note(text),
        "1. tax rounds down\n2. no test for 0\n\nfix both"
    );
}

/// Look 11-17 v5 item 4: a project whose lead's seat failed says so in the digest ("failed"), until a session of
/// that seat runs again.
#[test]
fn v5_4_the_digest_says_a_failed_lead() {
    let home = std::env::temp_dir().join(format!(
        "nunchiro-digest-{}",
        crate::store::new_id().unwrap()
    ));
    let project = home.join("harbor");
    std::fs::create_dir_all(&project).unwrap();
    let project = std::fs::canonicalize(project).unwrap();
    let team = crate::team::Team::open(&home);
    let all = team
        .save(
            None,
            crate::team::Teammate {
                id: String::new(),
                name: "Lead".into(),
                job: "Leads.".into(),
                kind: crate::api::AgentKind::Claude,
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
    let lead = all[0].id.clone();
    let row = |failed: bool, live: bool| {
        let mut f = crate::sessions::DigestFacts::default();
        if failed {
            f.seats_failed.insert(lead.clone());
        }
        if live {
            f.seats_live.insert(lead.clone());
        }
        digest(
            &[],
            vec![project.clone()],
            [(project.clone(), f)].into(),
            &team,
            0,
        )
        .remove(0)
        .lead_state
    };
    assert_eq!(row(false, false), None);
    assert_eq!(row(true, false).as_deref(), Some("failed"));
    assert_eq!(row(true, true), None, "a running seat session wins");
    // Look 11-17 v9 (Home S2-3): its folder removed, the project with a lead stays, as needing the user.
    std::fs::remove_dir_all(&project).unwrap();
    assert_eq!(row(false, false).as_deref(), Some("missing"));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_session_that_waits_for_the_user_is_not_working() {
    // N2 (look 1117 v3)
    let working = crate::queue::Attention {
        working: true,
        ..Default::default()
    };
    assert!(working_now(true, &working, 0));
    assert!(!working_now(true, &working, 1), "a pending ask");
    let waiting = crate::queue::Attention {
        waiting: true,
        ..working.clone()
    };
    assert!(!working_now(true, &waiting, 0), "the agent waits");
    assert!(!working_now(false, &working, 0), "not running");
}

#[test]
fn the_seat_cap_is_two_to_eight_and_left_out_at_four() {
    let home = home("cap");
    let l = Ledger::open(&home);
    let p = Path::new("/p");
    assert_eq!(l.place(p).cap, 4);
    assert!(l.set_cap(p, 3).is_err());
    assert_eq!(l.set_cap(p, 6).unwrap().cap, 6);
    assert_eq!(Ledger::open(&home).place(p).cap, 6);
    l.set_cap(p, 4).unwrap();
    let file = std::fs::read_to_string(home.join("ledger.json")).unwrap();
    assert!(!file.contains("cap"), "{file}");
    let _ = std::fs::remove_dir_all(home);
}
fn home(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("ledger-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}
fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
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
    assert!(
        ok.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&ok.stderr)
    );
}

#[test]
fn a_task_asked_twice_is_one_task_and_survives_a_reopen() {
    let home = home("twice");
    let place = home.join("p");
    let (a, made) = Ledger::open(&home)
        .make(
            &place,
            Some("lead"),
            "  Add   tax() ",
            &["tests pass".into()],
            false,
            1,
        )
        .unwrap();
    assert!(made);
    assert_eq!((a.id.as_str(), a.title.as_str()), ("t1", "Add tax()"));
    // A new conversation asks again, in other letter case: the same task, nothing new.
    let (b, made) = Ledger::open(&home)
        .make(&place, Some("lead"), "add tax()", &[], false, 2)
        .unwrap();
    assert!(!made);
    assert_eq!(b, a);
    // Another place has its own.
    let (c, made) = Ledger::open(&home)
        .make(&home.join("q"), None, "add tax()", &[], false, 3)
        .unwrap();
    assert!(made && c.id == "t2");
    // Closed: the title is free again.
    Ledger::open(&home).close("t1", "done", 4).unwrap();
    let (d, made) = Ledger::open(&home)
        .make(&place, Some("lead"), "Add tax()", &[], false, 5)
        .unwrap();
    assert!(made && d.id == "t3");
    assert_eq!(Ledger::open(&home).list().unwrap().len(), 3);
}

#[test]
fn one_writer_per_worktree_and_the_seat_follows_a_resume() {
    let home = home("writer");
    let (place, wt) = (home.join("p"), home.join("wt"));
    let l = Ledger::open(&home);
    let t = l.worktree_made(&place, "lead", &wt, "tax", 1).unwrap();
    assert!(t.auto && t.worktrees == [wt.clone()]);
    // A folder no task uses takes any start and records nothing.
    assert!(l.writer_free(&home.join("other"), |_| true).is_ok());
    assert!(
        l.seat(&home.join("other"), "s0", "x", 1, &|_| true)
            .unwrap()
            .is_none()
    );

    l.writer_free(&wt, |_| true).unwrap();
    l.seat(&wt, "s1", "lane-tax", 2, &|_| true)
        .unwrap()
        .unwrap();
    // A second builder while the first lives: refused with the words that name the first.
    let no = l.writer_free(&wt, |s| s == "s1").unwrap_err();
    assert!(no.contains("lane-tax") && no.contains("t1"), "{no}");
    // A reviewer is a seat that does not write: it is never the second writer.
    let t = l
        .seat(&wt, "s2", "review-tax", 3, &|_| true)
        .unwrap()
        .unwrap();
    assert_eq!(
        t.seats
            .iter()
            .map(|s| (s.role.as_str(), s.writes))
            .collect::<Vec<_>>(),
        [("builder", true), ("reviewer", false)]
    );
    // The same start reported twice is one seat.
    let t = l
        .seat(&wt, "s2", "review-tax", 3, &|_| true)
        .unwrap()
        .unwrap();
    assert_eq!(t.seats.len(), 2);
    // The builder's run is resumed under a new id: still the one writer, now under that id.
    l.reseat(&["s1".into()], "s9").unwrap();
    assert!(l.writer_free(&wt, |s| s == "s9").is_err());
    // After one Codex look: a full task forgets its oldest ended seat, never a running one.
    for n in 0..SEATS_KEPT {
        l.seat(&wt, &format!("r{n}"), "review-x", 5, &|s| s == "s9")
            .unwrap();
    }
    let t = l.of_worktree(&wt).unwrap();
    assert_eq!(t.seats.len(), SEATS_KEPT);
    assert!(
        t.seats.iter().any(|s| s.session == "s9"),
        "the running writer stays"
    );
    assert!(l.writer_free(&wt, |s| s == "s9").is_err());
    assert!(
        l.seat(&wt, "one-more", "review-x", 6, &|_| true).is_err(),
        "all running: no seat is dropped for a new one"
    );
    // The builder ended: the next builder is a new seat.
    l.writer_free(&wt, |_| false).unwrap();
    let t = l
        .seat(&wt, "s3", "lane-tax-2", 4, &|_| false)
        .unwrap()
        .unwrap();
    assert!(t.seats.iter().any(|s| s.session == "s3"));
}

#[test]
fn what_the_user_told_a_seat_is_kept_once() {
    let home = home("told");
    let (place, wt) = (home.join("p"), home.join("wt"));
    let l = Ledger::open(&home);
    l.worktree_made(&place, "lead", &wt, "tax", 1).unwrap();
    l.seat(&wt, "s1", "lane-tax", 2, &|_| true).unwrap();
    assert!(
        l.told(
            "s1",
            &wt,
            "lane-tax",
            "Use  integer cents,\nnot floats.",
            10
        )
        .unwrap()
    );
    // The same send reported by a second path, then really said again later.
    assert!(
        l.told("s1", &wt, "lane-tax", "Use integer cents, not floats.", 900)
            .unwrap()
    );
    assert!(
        l.told(
            "s1",
            &wt,
            "lane-tax",
            "Use integer cents, not floats.",
            60_000
        )
        .unwrap()
    );
    // A session that is no seat, in a folder no task uses: nothing to record.
    assert!(!l.told("zz", &home.join("other"), "x", "hello", 11).unwrap());
    // The user's own tab in the task's worktree counts for the task.
    assert!(
        l.told("mine", &wt, "my tab", "Also rename it.", 12)
            .unwrap()
    );
    let t = Ledger::open(&home).of_worktree(&wt).unwrap();
    assert_eq!(
        t.told
            .iter()
            .map(|n| (n.at, n.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (10, "Use integer cents, not floats."),
            (60_000, "Use integer cents, not floats."),
            (12, "Also rename it."),
        ]
    );
}

#[test]
fn a_review_holds_for_one_revision_only() {
    let home = home("review");
    let wt = home.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    git(&wt, &["init", "-q"]);
    std::fs::write(wt.join("a.txt"), "one\n").unwrap();
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-qm", "one"]);
    let l = Ledger::open(&home);
    let t = l
        .worktree_made(&home.join("p"), "lead", &wt, "tax", 1)
        .unwrap();
    l.seat(&wt, "s1", "lane-tax", 1, &|_| true).unwrap();
    l.seat(&wt, "s2", "review-tax", 1, &|_| true).unwrap();
    let idle = |_: &str| SeatNow {
        live: true,
        state: "waiting",
    };
    let at = revision_of(&t).unwrap();
    assert_eq!(at.len(), 40, "a clean folder is its commit: {at}");
    assert_eq!(view(t.clone(), &idle, vec![], &at).state, "idle");
    let t = l
        .review(
            &t.id,
            Review {
                revision: at.clone(),
                pass: true,
                note: "ok".into(),
                by: "s2".into(),
                name: "review-tax".into(),
                at: 5,
            },
        )
        .unwrap();
    let v = view(t.clone(), &idle, vec![], &revision_of(&t).unwrap());
    assert_eq!((v.state.as_str(), v.stale), ("approved", false));
    // An uncommitted edit after the approval: not approved any more.
    std::fs::write(wt.join("a.txt"), "two\n").unwrap();
    let dirty = revision_of(&t).unwrap();
    let v = view(t.clone(), &idle, vec![], &dirty);
    assert_eq!((v.state.as_str(), v.stale), ("review", true));
    // A second edit of the same file is a third revision, and so is a new untracked file.
    std::fs::write(wt.join("a.txt"), "three\n").unwrap();
    let dirty2 = revision_of(&t).unwrap();
    assert_ne!(dirty, dirty2);
    // An untracked file is in no merge: it changes nothing until it is added.
    std::fs::write(wt.join("new.txt"), "n\n").unwrap();
    assert_eq!(dirty2, revision_of(&t).unwrap());
    git(&wt, &["add", "new.txt"]);
    assert_ne!(dirty2, revision_of(&t).unwrap());
    // After one Codex look: an edit far past the first 64 KiB of a long file, and a changed binary file, are each a
    // new revision (the digest is of every changed file's whole content).
    let long = "line\n".repeat(40_000);
    std::fs::write(wt.join("long.txt"), format!("{long}end one\n")).unwrap();
    git(&wt, &["add", "long.txt"]);
    let far = revision_of(&t).unwrap();
    std::fs::write(wt.join("long.txt"), format!("{long}end two\n")).unwrap();
    assert_ne!(far, revision_of(&t).unwrap());
    std::fs::write(wt.join("blob.bin"), [0u8, 1, 2, 0, 255]).unwrap();
    git(&wt, &["add", "blob.bin"]);
    let bin = revision_of(&t).unwrap();
    std::fs::write(wt.join("blob.bin"), [0u8, 1, 3, 0, 255]).unwrap();
    assert_ne!(bin, revision_of(&t).unwrap());
    // Committed: still not what was reviewed.
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-qm", "two"]);
    assert!(view(t.clone(), &idle, vec![], &revision_of(&t).unwrap()).stale);
    // Back at the reviewed commit, the approval speaks again.
    git(&wt, &["reset", "-q", "--hard", "HEAD~1"]);
    assert_eq!(
        view(t.clone(), &idle, vec![], &revision_of(&t).unwrap()).state,
        "approved"
    );
    // A seat that waits for the user outranks every other word; a running reviewer reads "review".
    let asks = |s: &str| SeatNow {
        live: true,
        state: if s == "s1" { "permission" } else { "working" },
    };
    assert_eq!(view(t.clone(), &asks, vec![], &at).state, "needs");
    let reviewing = |s: &str| SeatNow {
        live: true,
        state: if s == "s2" { "working" } else { "waiting" },
    };
    assert_eq!(view(t.clone(), &reviewing, vec![], &at).state, "review");
    // An open ask of a seat (a Builder's question sent to its lead) reads "asked" while no other seat works; a
    // working one still reads its work.
    let ask = |from: &str| vec![(from.to_string(), "Builder → Lead: one or two?".to_string())];
    assert_eq!(view(t.clone(), &idle, ask("s9"), &at).state, "asked");
    assert_eq!(view(t.clone(), &reviewing, ask("s9"), &at).state, "review");
    // N14-S3-3: an asking seat whose agent ended (quit in its shell, no `lost` event) waits no more.
    assert_ne!(
        view(t.clone(), &|_: &str| SeatNow::default(), ask("s1"), &at).state,
        "asked"
    );
    // Look v10 Home S2-3: the asking seat itself runs a command while it waits (`ask --wait`): still "asked".
    let waits_in_turn = |s: &str| SeatNow {
        live: true,
        state: if s == "s1" { "working" } else { "waiting" },
    };
    let asked = view(t.clone(), &waits_in_turn, ask("s1"), &at);
    assert_eq!(
        (asked.state.as_str(), asked.asking),
        ("asked", vec!["s1".to_string()])
    );
    // A worktree that cannot be read has no revision: nothing binds to it and no review holds for it.
    let lost = Task {
        worktrees: vec![home.join("nowhere")],
        ..t.clone()
    };
    assert_eq!(revision_of(&lost), None);
    // A second worktree joins: the review never saw it, so it is gone.
    let t = l.attach(&t.id, &home.join("wt2"), 9).unwrap();
    assert!(t.review.is_none() && t.worktrees.len() == 2);
}

#[test]
fn worktrees_come_and_go() {
    let home = home("gone");
    let place = home.join("p");
    let l = Ledger::open(&home);
    // A named task takes the worktree of the same name; the worktree's own unnamed task never appears.
    let (named, _) = l
        .make(&place, Some("lead"), "tax", &["cents".into()], false, 1)
        .unwrap();
    let t = l
        .worktree_made(&place, "lead", &home.join("w1"), "Tax", 2)
        .unwrap();
    assert_eq!((t.id.as_str(), t.auto), (named.id.as_str(), false));
    // An unnamed one, then moved to the named task with its seat and what was told there.
    let u = l
        .worktree_made(&place, "lead", &home.join("w2"), "tax-ui", 3)
        .unwrap();
    assert!(u.auto && u.id != named.id);
    l.seat(&home.join("w2"), "s5", "lane-ui", 3, &|_| true)
        .unwrap();
    l.told("s5", &home.join("w2"), "lane-ui", "Dark mode too.", 4)
        .unwrap();
    let t = l.attach(&named.id, &home.join("w2"), 5).unwrap();
    assert_eq!(t.worktrees.len(), 2);
    assert_eq!((t.seats.len(), t.told.len()), (1, 1));
    assert!(
        l.list().unwrap().iter().all(|x| x.id != u.id),
        "the emptied unnamed task is deleted"
    );
    // One worktree merges and goes: the task stays open for the other. The last one, unmerged: a named task stays
    // open with no worktree. Merged: closed.
    l.worktree_gone(&home.join("w1"), Some(true), 6).unwrap();
    assert!(l.of_worktree(&home.join("w2")).is_some());
    l.worktree_gone(&home.join("w2"), Some(false), 7).unwrap();
    let t = l
        .list()
        .unwrap()
        .into_iter()
        .find(|x| x.id == named.id)
        .unwrap();
    assert!(t.closed.is_none() && t.worktrees.is_empty());
    // An unnamed task closes with its worktree either way; taken back by the user, it is deleted.
    let a = l
        .worktree_made(&place, "lead", &home.join("w3"), "docs", 8)
        .unwrap();
    l.worktree_gone(&home.join("w3"), Some(false), 9).unwrap();
    let a = l
        .list()
        .unwrap()
        .into_iter()
        .find(|x| x.id == a.id)
        .unwrap();
    assert_eq!(a.closed.unwrap().how, "removed");
    // N14-S3-2: closed as merged (by `task list`) before its folder went: the folder still leaves the task.
    let m = l
        .worktree_made(&place, "lead", &home.join("w6"), "merged-first", 10)
        .unwrap();
    l.close(&m.id, "merged", 10).unwrap();
    l.worktree_gone(&home.join("w6"), Some(true), 10).unwrap();
    let m = l
        .list()
        .unwrap()
        .into_iter()
        .find(|x| x.id == m.id)
        .unwrap();
    assert!(m.worktrees.is_empty() && m.closed.unwrap().how == "merged");
    let b = l
        .worktree_made(&place, "lead", &home.join("w4"), "spike", 10)
        .unwrap();
    l.worktree_taken(&home.join("w4"), 11).unwrap();
    assert!(l.list().unwrap().iter().all(|x| x.id != b.id));
    // An unnamed task dropped before anyone sat on it leaves no row; a named one stays as "dropped".
    let c = l
        .worktree_made(&place, "lead", &home.join("w5"), "lane-api", 12)
        .unwrap();
    assert_eq!(
        l.close(&c.id, "dropped", 13).unwrap().closed.unwrap().how,
        "dropped"
    );
    assert!(l.list().unwrap().iter().all(|x| x.id != c.id));
    let (d, _) = l
        .make(&place, Some("lead"), "a named task", &[], false, 14)
        .unwrap();
    l.close(&d.id, "dropped", 15).unwrap();
    assert!(l.list().unwrap().iter().any(|x| x.id == d.id));
}

#[test]
fn a_task_is_in_the_project_once_its_approved_commit_is() {
    let home = home("inproject");
    let place = home.join("p");
    std::fs::create_dir_all(&place).unwrap();
    git(&place, &["init", "-q", "-b", "main"]);
    std::fs::write(place.join("a.txt"), "one\n").unwrap();
    git(&place, &["add", "."]);
    git(&place, &["commit", "-qm", "one"]);
    let wt = home.join("wt");
    git(
        &place,
        &["worktree", "add", "-q", "-b", "lane", wt.to_str().unwrap()],
    );
    std::fs::write(wt.join("b.txt"), "two\n").unwrap();
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-qm", "two"]);
    let l = Ledger::open(&home);
    let t = l.worktree_made(&place, "lead", &wt, "tax", 1).unwrap();
    let at = revision_of(&t).unwrap();
    let review = |revision: &str| Review {
        pass: true,
        revision: revision.into(),
        by: "s2".into(),
        name: "review-tax".into(),
        note: String::new(),
        at: 2,
    };
    let t = l.review(&t.id, review(&at)).unwrap();
    assert!(!in_project(&t), "no yes from the user yet");
    let t = l.merge_ok(&t.id, &at, 3).unwrap();
    assert!(!in_project(&t), "approved, not merged yet");
    git(&place, &["merge", "-q", "lane"]);
    assert!(
        in_project(&t),
        "the approved commit is in the project's checkout"
    );
    // An edit after the yes: the files are no longer the approved ones.
    std::fs::write(wt.join("b.txt"), "three\n").unwrap();
    assert!(!in_project(&t));
}

/// Ticket 1095: a task with no package prints what it printed before the package existed, in \`show\` and \`list\`.
#[test]
fn a_task_with_no_package_prints_as_before() {
    let task = Task {
        id: "t3".into(),
        place: "/p".into(),
        title: "Tax in cents".into(),
        accept: vec!["tests pass".into()],
        lead: None,
        auto: false,
        worktrees: vec!["/p/w".into()],
        seats: vec![Seat {
            session: "s1".into(),
            name: "Builder · tax".into(),
            role: "builder".into(),
            writes: true,
            briefed: true,
            worktree: None,
            at: 1,
        }],
        told: vec![],
        review: Some(Review {
            revision: "r".into(),
            pass: true,
            note: "fine\nsecond".into(),
            by: "s2".into(),
            name: "Reviewer · tax".into(),
            at: 2,
        }),
        learned: vec![],
        merge: None,
        closed: None,
        stall: None,
        advance: Advance::default(),
        created: 1,
        updated: 2,
    };
    let v = view(task, &|_| SeatNow::default(), vec![], "r");
    let before = "t3 [approved] Tax in cents\n  accept: tests pass\n  worktree: /p/w\n  seat: builder · Builder · tax (s1, ended)\n  review by Reviewer · tax: pass: fine\n    second\n";
    assert_eq!(lines(&v, true), before);
    let shown = View {
        package: Some(package::Package::default()),
        ..v.clone()
    };
    assert_eq!(lines(&shown, true), before);
    assert!(!serde_json::to_string(&v).unwrap().contains("package"));
    // A package shows in \`show\` only, never in the list's rows.
    let mut p = package::Package::default();
    package::keep_brief(&mut p, "s1", "Builder · tax", "Read BRIEF.md", 1).unwrap();
    let filled = View {
        package: Some(p),
        ..v.clone()
    };
    assert_eq!(lines(&filled, false), lines(&v, false));
    assert!(lines(&filled, true).ends_with(
            "  package:\n    brief to Builder · tax (13 bytes): Read BRIEF.md (the whole text: nunchiro task show t3 --json)\n"
        ));
}

/// Ticket 1095 threat 5: a ledger from before the package loads as it was, and a package never writes into it.
#[test]
fn an_old_ledger_loads_unchanged_and_packages_stay_out_of_it() {
    let home = home("old-store");
    let old = r#"{
  "version": 1,
  "next": 3,
  "tasks": [
    {"id": "t1", "place": "/p", "title": "Old one", "accept": ["works"], "seats": [{"session": "s1", "name": "Builder · old", "role": "builder", "writes": true, "at": 1}], "created": 1, "updated": 1},
    {"id": "t2", "place": "/p", "title": "Old two", "closed": {"at": 3, "how": "done"}, "created": 2, "updated": 3}
  ],
  "places": {"/p": {"way": "strict", "seats": "ask"}}
}"#;
    std::fs::write(home.join("ledger.json"), old).unwrap();
    let l = Ledger::open(&home);
    let tasks = l.list().unwrap();
    assert_eq!(
        tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["t1", "t2"]
    );
    assert_eq!(tasks[0].seats[0].name, "Builder · old");
    assert_eq!(l.place(Path::new("/p")).way, "strict");
    let stored = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
    assert_eq!(
        stored(&serde_json::to_string(&l.read().unwrap()).unwrap()),
        stored(old),
        "read and written back, nothing is added or lost"
    );
    // A package and a brief go to their own file; ledger.json stays byte for byte.
    let packages = Packages::open(&home);
    packages
        .change("t1", |p| {
            package::apply(
                p,
                &home,
                "background",
                "why",
                &Default::default(),
                "Lead · Main",
                true,
                4,
            )
        })
        .unwrap();
    let sent = l.brief("t1", "s1", "Read BRIEF.md", 5).unwrap();
    assert!(sent.contains("Background, the lead's words") && sent.ends_with("\nRead BRIEF.md"));
    assert!(
        l.brief("t1", "nobody", "x", 5)
            .unwrap_err()
            .contains("no seat")
    );
    assert!(
        l.brief("t2", "s1", "x", 5)
            .unwrap_err()
            .contains("no open task")
    );
    assert_eq!(
        std::fs::read_to_string(home.join("ledger.json")).unwrap(),
        old
    );
    // A ledger write after that holds no package either; the package is still there after done.
    l.close("t1", "done", 6).unwrap();
    assert!(
        !std::fs::read_to_string(home.join("ledger.json"))
            .unwrap()
            .contains("package")
    );
    let p = packages.get("t1").unwrap();
    assert_eq!(
        (p.background.unwrap().text, p.briefs.len()),
        ("why".to_string(), 1)
    );
    let _ = std::fs::remove_dir_all(home);
}

/// Ticket 1095: a task the core made and dropped unused leaves no row, unless its lead filled a package.
#[test]
fn a_dropped_auto_task_with_a_package_keeps_its_row() {
    let home = home("auto-package");
    let l = Ledger::open(&home);
    let (a, _) = l.make(&home, None, "wt-a", &[], true, 1).unwrap();
    let (b, _) = l.make(&home, None, "wt-b", &[], true, 1).unwrap();
    Packages::open(&home)
        .change(&b.id, |p| {
            package::apply(p, &home, "see", "a line", &Default::default(), "L", true, 1)
        })
        .unwrap();
    l.close(&a.id, "dropped", 2).unwrap();
    l.close(&b.id, "dropped", 2).unwrap();
    let ids: Vec<String> = l.list().unwrap().into_iter().map(|t| t.id).collect();
    assert_eq!(ids, [b.id]);
    let _ = std::fs::remove_dir_all(home);
}
