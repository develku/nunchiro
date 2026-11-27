
use super::*;

const NOW: u64 = 100 * MIN;
fn task() -> Task {
    serde_json::from_value(serde_json::json!({
            "id": "t1", "place": "/p", "title": "tax", "lead": "lead",
            "seats": [{"session": "b1", "name": "Builder · tax", "role": "builder", "writes": true, "at": 1}],
            "created": 1, "updated": 1
        }))
        .unwrap()
}
fn live(last: u64, working: bool) -> Facts {
    Facts {
        live: true,
        working,
        last,
        since: last,
        ..Default::default()
    }
}
fn run(t: &Task, f: &Facts, now: u64) -> (Vec<Act>, Task) {
    let (acts, advance) = plan(t, &|_| f.clone(), &|_, _| false, now);
    (
        acts,
        Task {
            advance,
            ..t.clone()
        },
    )
}
fn home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nunchiro-advance-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_row_queued_five_minutes_stalls_the_seat_and_is_sent_once_more() {
    let f = Facts {
        queued: Some(("r1".into(), NOW - 6 * MIN)),
        ..live(NOW, true)
    };
    let (acts, t) = run(&task(), &f, NOW);
    assert_eq!(
        acts,
        [Act::Resend {
            seat: "b1".into(),
            name: "Builder · tax".into(),
            row: "r1".into(),
            why: "a message has waited 6 min to be delivered".into()
        }]
    );
    assert_eq!(t.advance.stalled.len(), 1);
    assert!(run(&t, &f, NOW + EVERY_MS).0.is_empty(), "one resend");
    let young = Facts {
        queued: Some(("r1".into(), NOW - 4 * MIN)),
        ..live(NOW, true)
    };
    assert!(run(&task(), &young, NOW).0.is_empty());
}
#[test]
fn a_seat_quiet_twenty_minutes_without_a_report_is_nudged_once() {
    assert!(run(&task(), &live(NOW - 19 * MIN, false), NOW).0.is_empty());
    let f = live(NOW - 20 * MIN, false);
    let (acts, t) = run(&task(), &f, NOW);
    assert_eq!(
        acts,
        [Act::Nudge {
            seat: "b1".into(),
            name: "Builder · tax".into(),
            minutes: 20
        }]
    );
    assert_eq!(t.advance.stalled[0].why, "quiet for 20 min");
    assert!(run(&t, &f, NOW + EVERY_MS).0.is_empty(), "one nudge");
    assert!(
        nudge_line(20).starts_with("Lead: you have been quiet for 20 minutes with the task open")
    );
}
#[test]
fn a_finished_report_is_no_stall() {
    let dir = home("report");
    let f = Facts {
        cwd: dir.clone(),
        ..live(NOW - 30 * MIN, false)
    };
    assert!(!reported(&f), "no report");
    std::fs::write(dir.join("REPORT.md"), "STATUS: done\n").unwrap();
    assert!(reported(&f));
    let (acts, _) = plan(&task(), &|_| f.clone(), &|_, f| reported(f), NOW);
    assert!(acts.is_empty());
    // A report from before its last start or prompt speaks for an earlier turn.
    let later = Facts {
        since: crate::queue::now_ms() + MIN,
        ..f
    };
    assert!(!reported(&later));
    let _ = std::fs::remove_dir_all(dir);
}
#[test]
fn a_seat_marked_working_but_silent_twenty_five_minutes_is_stalled() {
    assert!(
        run(&task(), &live(NOW - 24 * MIN, true), NOW).0.is_empty(),
        "a working seat gets more time"
    );
    let (acts, _) = run(&task(), &live(NOW - 25 * MIN, true), NOW);
    assert!(
        matches!(acts[..], [Act::Nudge { minutes: 25, .. }]),
        "{acts:?}"
    );
    // One waiting for an answer, or not running, is not stalled.
    assert!(
        run(
            &task(),
            &Facts {
                waits: true,
                ..live(NOW - 60 * MIN, false)
            },
            NOW
        )
        .0
        .is_empty()
    );
    assert!(
        run(
            &task(),
            &Facts {
                live: false,
                ..live(NOW - 60 * MIN, false)
            },
            NOW
        )
        .0
        .is_empty()
    );
}
#[test]
fn still_stalled_five_minutes_after_the_nudge_asks_the_owner_once() {
    let f = live(NOW - 20 * MIN, false);
    let (_, t) = run(&task(), &f, NOW);
    assert!(run(&t, &f, NOW + 4 * MIN).0.is_empty());
    let (acts, t) = run(&t, &f, NOW + 5 * MIN);
    assert_eq!(
        acts,
        [Act::Card {
            seat: "b1".into(),
            name: "Builder · tax".into(),
            why: "quiet for 20 min".into()
        }]
    );
    assert!(run(&t, &f, NOW + 6 * MIN).0.is_empty(), "one card");
}
#[test]
fn movement_clears_the_stall_and_its_card() {
    let f = live(NOW - 20 * MIN, false);
    let (_, t) = run(&task(), &f, NOW);
    let (_, t) = run(&t, &f, NOW + 5 * MIN);
    let (acts, t) = run(&t, &live(NOW + 5 * MIN, true), NOW + 6 * MIN);
    assert_eq!(
        acts,
        [Act::Moved {
            seat: "b1".into(),
            name: "Builder · tax".into(),
            card: true
        }]
    );
    assert!(t.advance.stalled.is_empty());
}
#[test]
fn a_restart_repeats_nothing() {
    let home = home("restart");
    let l = Ledger::open(&home);
    let made = l
        .make(Path::new("/p"), Some("lead"), "tax", &[], false, 1)
        .unwrap()
        .0;
    let t = Task {
        seats: task().seats,
        ..made
    };
    let f = live(NOW - 20 * MIN, false);
    let (acts, t) = run(&t, &f, NOW);
    assert_eq!(acts.len(), 1);
    l.set_advance(&t.id, t.advance.clone()).unwrap();
    // A new core reads the record from the file.
    let read = Ledger::open(&home).list().unwrap().remove(0);
    assert_eq!(read.advance, t.advance);
    let back = Task {
        seats: task().seats,
        ..read
    };
    assert!(run(&back, &f, NOW + EVERY_MS).0.is_empty());
    // Its stall mark lost, the same stall (same start) still gets no second nudge.
    let bare = Task {
        advance: Advance {
            stalled: vec![],
            ..back.advance.clone()
        },
        ..back
    };
    assert!(run(&bare, &f, NOW + EVERY_MS).0.is_empty());
    let _ = std::fs::remove_dir_all(home);
}
#[test]
fn the_heartbeat_goes_only_when_something_waits_and_at_most_every_ten_minutes() {
    let view = |waits: Option<&str>, stalled: usize| View {
        task: Task {
            advance: Advance {
                stalled: (0..stalled)
                    .map(|i| Stalled {
                        session: format!("s{i}"),
                        name: "B".into(),
                        why: "w".into(),
                        n: 1,
                        at: 1,
                        card: false,
                    })
                    .collect(),
                ..Default::default()
            },
            ..task()
        },
        state: "idle".into(),
        stale: false,
        live: vec![],
        asks: vec![],
        asking: vec![],
        floor: None,
        seen: Default::default(),
        waits: waits.map(Into::into),
        package: None,
        accounts: Default::default(),
        blockers: vec![],
        waiters: 0,
        stuck: None,
        early: None,
    };
    assert_eq!(beat(&[view(None, 0)]), None);
    assert_eq!(
        beat(&[
            view(Some("review"), 0),
            view(Some("review"), 0),
            view(Some("review"), 1),
            view(Some("merge"), 0)
        ])
        .as_deref(),
        Some("Team: 3 reports wait for review, 1 approved waits to merge, 1 seat stalled.")
    );
    assert!(beat_due(None, NOW));
    assert!(!beat_due(Some(NOW - 9 * MIN), NOW));
    assert!(beat_due(Some(NOW - 10 * MIN), NOW));
}
// Part B.
fn built() -> Task {
    serde_json::from_value(serde_json::json!({
            "id": "t1", "place": "/p", "title": "tax", "lead": "lead", "worktrees": ["/w"],
            "seats": [{"session": "b1", "name": "Builder · tax", "role": "builder", "writes": true, "at": 1}],
            "created": 1, "updated": 1
        }))
        .unwrap()
}
/// The Builder's turn ended with a done report (`since` 1 reads as reported), the Reviewer `r1` per `reviewer`.
fn review(t: &Task, way: &str, rev: &str, reviewer: Facts, free: bool) -> (Vec<Act>, Task) {
    let facts = |s: &str| match s {
        "b1" => Facts {
            since: 1,
            ..live(NOW - MIN, false)
        },
        _ => reviewer.clone(),
    };
    let (acts, advance) = review_plan(
        t,
        t.advance.clone(),
        way,
        Some(rev),
        &facts,
        &|f| f.since == 1,
        free,
    );
    (
        acts,
        Task {
            advance,
            ..t.clone()
        },
    )
}
fn with_reviewer(t: &Task, at: u64) -> Task {
    let mut t = t.clone();
    t.seats.push(Seat {
        session: "r1".into(),
        name: "Reviewer · tax".into(),
        role: "reviewer".into(),
        writes: false,
        briefed: false,
        worktree: None,
        at,
    });
    t
}
fn verdict(t: &Task, rev: &str, pass: bool) -> Task {
    Task {
        review: Some(crate::ledger::Review {
            revision: rev.into(),
            pass,
            note: "the test is missing".into(),
            by: "r1".into(),
            name: "Reviewer · tax".into(),
            at: NOW,
        }),
        ..t.clone()
    }
}

#[test]
fn a_done_report_at_a_clean_revision_starts_one_reviewer() {
    let (acts, t) = review(&built(), "team", "c1", Facts::default(), true);
    assert_eq!(
        acts,
        [Act::Staff {
            name: "Reviewer · tax".into(),
            rev: "c1".into()
        }]
    );
    assert_eq!(t.advance.review, "started");
    assert!(
        review(&t, "team", "c1", Facts::default(), true)
            .0
            .is_empty(),
        "once per revision"
    );
    assert!(
        review(&built(), "team", "c1+0a1b", Facts::default(), true)
            .0
            .is_empty(),
        "a dirty tree"
    );
    assert!(
        review(&built(), "solo", "c1", Facts::default(), true)
            .0
            .is_empty(),
        "solo"
    );
    assert!(
        !review(&built(), "strict", "c1", Facts::default(), true)
            .0
            .is_empty(),
        "strict"
    );
    // No report since the Builder's last prompt, or the Builder still at work: none.
    let (none, _) = review_plan(
        &built(),
        Advance::default(),
        "team",
        Some("c1"),
        &|_| live(NOW, true),
        &|_| true,
        true,
    );
    assert!(none.is_empty());
    let (none, _) = review_plan(
        &built(),
        Advance::default(),
        "team",
        Some("c1"),
        &|_| live(NOW, false),
        &|_| false,
        true,
    );
    assert!(none.is_empty());
    // A review already at this revision: none.
    assert!(
        review(
            &verdict(&built(), "c1", true),
            "team",
            "c1",
            Facts::default(),
            true
        )
        .0
        .is_empty()
    );
}
#[test]
fn changes_go_to_the_builder_once_a_round_and_the_fourth_asks_the_user() {
    let mut t = built();
    for round in 1..=3 {
        let rev = format!("c{round}");
        let (acts, next) = review(
            &verdict(&t, &rev, false),
            "team",
            &rev,
            Facts::default(),
            true,
        );
        let [
            Act::Forward {
                seat,
                round: r,
                line,
                ..
            },
        ] = &acts[..]
        else {
            panic!("{acts:?}");
        };
        assert_eq!((seat.as_str(), *r), ("b1", round));
        assert!(
            line.contains("the test is missing") && line.contains("agent send"),
            "{line}"
        );
        assert!(
            review(&next, "team", &rev, Facts::default(), true)
                .0
                .is_empty(),
            "one line a round"
        );
        t = next;
    }
    let (acts, t) = review(
        &verdict(&t, "c4", false),
        "team",
        "c4",
        Facts::default(),
        true,
    );
    assert!(matches!(acts[..], [Act::Rounds { .. }]), "{acts:?}");
    let (acts, _) = review(
        &verdict(&t, "c5", false),
        "team",
        "c5",
        Facts::default(),
        true,
    );
    assert!(
        !acts
            .iter()
            .any(|a| matches!(a, Act::Forward { .. } | Act::Rounds { .. }))
    );
    // A verdict for an older revision is stale: nothing is forwarded.
    assert!(
        review(
            &verdict(&built(), "c0", false),
            "team",
            "c1",
            Facts::default(),
            true
        )
        .0
        .iter()
        .all(|a| matches!(a, Act::Staff { .. }))
    );
}
#[test]
fn at_the_cap_the_review_waits_then_starts_when_a_seat_closes() {
    let (acts, t) = review(&built(), "team", "c1", Facts::default(), false);
    assert!(acts.is_empty());
    assert_eq!(t.advance.review, "waits");
    let (acts, t) = review(&t, "team", "c1", Facts::default(), true);
    assert!(matches!(acts[..], [Act::Staff { .. }]));
    assert_eq!(t.advance.review, "started");
}
#[test]
fn a_moved_tree_waits_for_the_reviewer_at_work() {
    let (_, t) = review(&built(), "team", "c1", Facts::default(), true);
    let t = with_reviewer(&t, NOW);
    // Started, not yet at its prompt; then at work: no second Reviewer for the new revision.
    assert!(
        review(&t, "team", "c2", live(NOW - MIN, false), true)
            .0
            .is_empty()
    );
    assert!(
        review(&t, "team", "c2", live(NOW + MIN, true), true)
            .0
            .is_empty()
    );
    // Its turn ended: the new revision gets its own.
    let (acts, _) = review(&t, "team", "c2", live(NOW + MIN, false), true);
    assert!(
        matches!(&acts[..], [Act::Staff { rev, .. }] if rev == "c2"),
        "{acts:?}"
    );
}
#[test]
fn a_restart_starts_and_forwards_nothing_twice() {
    let home = home("restart-b");
    let l = Ledger::open(&home);
    let made = l
        .make(Path::new("/p"), Some("lead"), "tax", &[], false, 1)
        .unwrap()
        .0;
    let t = Task {
        seats: built().seats,
        worktrees: built().worktrees,
        ..made
    };
    let (acts, t) = review(
        &verdict(&t, "c1", false),
        "team",
        "c1",
        Facts::default(),
        true,
    );
    assert_eq!(acts.len(), 1);
    l.set_advance(&t.id, t.advance.clone()).unwrap();
    let read = Ledger::open(&home).list().unwrap().remove(0);
    assert_eq!(read.advance.round, 1);
    let back = Task {
        advance: read.advance,
        ..t
    };
    assert!(
        review(&back, "team", "c1", Facts::default(), true)
            .0
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(home);
}
#[test]
fn the_review_prompt_is_the_guides_filled_in() {
    let b = &built().seats[0];
    let p = review_prompt(false, Path::new("/w"), "lane-tax", "main", b);
    assert!(
        p.starts_with("Review the diff of branch `lane-tax` against `main` in `/w`"),
        "{p}"
    );
    assert!(
        p.contains("VERDICT: pass") && p.contains("--to b1") && !p.contains("for security only")
    );
    assert!(review_prompt(true, Path::new("/w"), "x", "main", b).contains("for security only"));
    // Ticket 1095 rule 3: the owner's question, and what of it is a MUST.
    assert!(
            p.contains("\"What did the owner ask or show that I do not see in the result?\"")
                && p.contains("MUST (blocks the merge: wrong behavior, a fault the owner will see, a risk to saved data,"),
            "{p}"
        );
}
#[test]
fn staffing_runs_one_path_start_level_then_the_prompt() {
    use crate::api::{Reply, Request};
    let staff = |folder: Option<PathBuf>, level| Reply::Staff {
        task: "t1".into(),
        folder,
        session: serde_json::from_value(serde_json::json!({
            "kind": "claude", "project": "/p", "label": "Reviewer · tax"
        }))
        .unwrap(),
        level,
        why: None,
    };
    let run = |reply, prompt: Option<&str>| {
        let mut seen = vec![];
        let started = crate::ledger::seat_up(reply, prompt.map(Into::into), &mut |r| {
            let step = match &r {
                Request::Start { .. } => "start".to_string(),
                Request::Task {
                    operation, level, ..
                } => format!("{operation} {level:?}"),
                Request::AgentPrompt { text, .. } => format!("prompt {text}"),
                _ => "other".into(),
            };
            seen.push(step);
            Ok(match r {
                    Request::Start { session, .. } => Reply::Started {
                        session: serde_json::from_value(serde_json::json!({
                            "id": "r1", "label": session.label, "kind": "claude", "state": "running",
                            "cwd": "/w", "project": "/p", "agent_session_id": null, "agent_version": null,
                            "untested": false, "pid": null, "attention": {"completion_seq": 0, "working": false,
                            "waiting": false, "stale": false, "failed": false, "last_activity": 0, "background": 0},
                            "pending": []
                        }))
                        .unwrap(),
                    },
                    // Ticket 1095: the core puts the package in front of the words.
                    Request::Task {
                        operation, text, ..
                    } if operation == "brief" => Reply::Text {
                        text: format!("quoted\n{text}"),
                    },
                    _ => Reply::Ack,
                })
        });
        (started.map(|(task, s, _)| (task, s.id)), seen)
    };
    // The core's Reviewer: in its worktree, at the floor level, with the review prompt.
    let (got, seen) = run(
        staff(Some("/w".into()), Some(crate::team::Level::Deep)),
        Some("review it"),
    );
    assert_eq!(got.unwrap(), ("t1".to_string(), "r1".to_string()));
    assert_eq!(
        seen,
        [
            "start",
            "assign Some(Deep)",
            "brief None",
            "prompt quoted\nreview it"
        ]
    );
    // A first prompt over a brief's limit starts no seat.
    let (got, seen) = run(
        staff(Some("/w".into()), None),
        Some(&"x".repeat(64 * 1024 + 1)),
    );
    assert!(got.unwrap_err().contains("limit of a brief"));
    assert!(seen.is_empty());
    // The lead's `task staff` on a task with no worktree, no level, no prompt: seated by `assign`.
    let (_, seen) = run(staff(None, None), None);
    assert_eq!(seen, ["start", "assign None"]);
}

#[test]
fn auto_advance_off_does_nothing_in_that_place() {
    let home = home("auto");
    let l = Ledger::open(&home);
    l.make(Path::new("/p"), Some("lead"), "tax", &[], false, 1)
        .unwrap();
    l.make(Path::new("/q"), Some("lead"), "fee", &[], false, 1)
        .unwrap();
    l.make(Path::new("/q"), None, "no lead", &[], false, 1)
        .unwrap();
    assert_eq!(
        watched(&l).unwrap().len(),
        2,
        "on by default; a task with no lead is not watched"
    );
    assert!(l.place(Path::new("/p")).auto);
    l.set_place(Path::new("/p"), None, None, Some(false))
        .unwrap();
    let left: Vec<String> = watched(&l).unwrap().into_iter().map(|t| t.title).collect();
    assert_eq!(left, ["fee"]);
    let _ = std::fs::remove_dir_all(home);
}
#[test]
fn the_cap_counts_every_live_seat_of_the_place() {
    let mut closed = with_reviewer(&built(), 1);
    closed.id = "t0".into();
    closed.closed = Some(crate::ledger::Closed {
        at: 1,
        how: "done".into(),
    });
    let mut other = built();
    other.place = "/q".into();
    other.seats[0].session = "q1".into();
    let all = [built(), closed, other];
    let live = |s: &str| s != "gone";
    let lead_seat = |l: &str| (l == "lead").then(|| "lead-seat".to_string());
    // b1 (the open task's and the closed one's Builder, once), r1 of the closed task, and the lead's seat.
    assert_eq!(live_seats(&all, Path::new("/p"), &live, &lead_seat), 3);
    assert_eq!(
        live_seats(&all, Path::new("/p"), &|s| s != "r1", &lead_seat),
        2
    );
}
#[test]
fn a_failed_start_is_tried_again_then_asks_the_user_at_the_third() {
    let (_, t) = review(&built(), "team", "c1", Facts::default(), true);
    let mut adv = t.advance.clone();
    // Skipped (no longer due): no try counted, the next pass may plan it again.
    assert!(!start_failed(&mut adv, "c1", false));
    assert!(!adv.done.contains(&"review:c1".to_string()));
    for n in 1..=3 {
        let t = Task {
            advance: adv.clone(),
            ..built()
        };
        let (acts, next) = review(&t, "team", "c1", Facts::default(), true);
        assert!(matches!(acts[..], [Act::Staff { .. }]), "try {n}: {acts:?}");
        adv = next.advance;
        assert_eq!(start_failed(&mut adv, "c1", true), n == 3, "try {n}");
    }
    let t = Task {
        advance: adv,
        ..built()
    };
    assert!(
        review(&t, "team", "c1", Facts::default(), true)
            .0
            .is_empty(),
        "no fourth try"
    );
}
#[test]
fn the_reviewer_the_core_started_is_closed_after_its_verdict() {
    let (_, t) = review(&built(), "team", "c1", Facts::default(), true);
    let mut t = with_reviewer(&t, NOW);
    let judged = |t: &Task, f: Facts| review(&verdict(t, "c1", true), "team", "c1", f, true);
    // A Reviewer the lead started is the lead's to close.
    assert!(judged(&t, live(NOW + MIN, false)).0.is_empty());
    t.advance.done.push("reviewer:r1".into());
    assert!(
        review(&t, "team", "c1", live(NOW + MIN, false), true)
            .0
            .is_empty(),
        "no verdict yet"
    );
    assert!(
        judged(&t, live(NOW + MIN, true)).0.is_empty(),
        "its turn goes on"
    );
    let asking = Facts {
        waits: true,
        ..live(NOW + MIN, false)
    };
    assert!(judged(&t, asking).0.is_empty(), "it waits on an ask");
    let (acts, next) = judged(&t, live(NOW + MIN, false));
    assert_eq!(
        acts,
        [Act::Close {
            seat: "r1".into(),
            name: "Reviewer · tax".into()
        }]
    );
    assert!(judged(&next, live(NOW + MIN, false)).0.is_empty(), "once");
}

/// Task dependencies: a landing in a chain of 150 open tasks frees the last one (no cap on the scan), in one line;
/// once its waiter is marked, a reopened ledger plans nothing again; a task with no lead is told nothing.
#[test]
fn a_landing_frees_its_waiter_once_however_long_the_chain() {
    let home = home("release");
    let l = Ledger::open(&home);
    let p = Path::new("/p");
    for n in 1..=150 {
        l.make(p, Some("lead"), &format!("n{n}"), &[], false, 1)
            .unwrap();
    }
    for n in 2..=150 {
        l.set_after(&format!("t{n}"), &[format!("t{}", n - 1)], "x", 2)
            .unwrap();
    }
    l.close("t149", "merged", 3).unwrap();
    let got = releases(&l.list().unwrap());
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(
        (
            got[0].blocker.as_str(),
            &got[0].waiters,
            got[0].line.as_str()
        ),
        (
            "t149",
            &vec!["t150".to_string()],
            "\"n149\" landed. \"n150\" no longer waits: start it when you are ready."
        )
    );
    assert_eq!(l.mark_released("t149", &got[0].waiters).unwrap(), ["t150"]);
    assert!(l.mark_released("t149", &got[0].waiters).unwrap().is_empty());
    assert!(
        releases(&Ledger::open(&home).list().unwrap()).is_empty(),
        "told once"
    );
    // Dropped, and a waiter with no lead.
    let (lone, _) = l.make(p, None, "lone", &[], false, 4).unwrap();
    l.set_after(&lone.id, &["t147".into()], "x", 4).unwrap();
    l.close("t147", "dropped", 5).unwrap();
    let got = releases(&l.list().unwrap());
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(
        got[0].line,
        "\"n147\" was dropped. \"n148\" waited for it: stop waiting (nunchiro task after t148 --none) or drop it."
    );
    let _ = std::fs::remove_dir_all(home);
}
