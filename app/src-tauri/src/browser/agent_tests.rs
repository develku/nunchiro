use super::*;

/// Ticket 997 L7: a page shows as driven while a verb runs and DRIVEN_FOR after the last one, on the agent's current tab
/// only (tab 1 before it listed any), and never while the owner holds the space.
#[test]
fn driven_follows_the_agents_last_verb() {
    let sp = "test-driven-997";
    assert!(!driven(sp), "a space the agent never used");
    with_space(sp, |s| s.busy = true);
    assert!(driven(sp) && drives(sp, &view::label(sp)));
    with_space(sp, |s| {
        s.busy = false;
        s.acted = Some(Instant::now());
        s.tabs = vec![tab_label(sp, 1), tab_label(sp, 2)];
        s.current = 1;
    });
    assert!(drives(sp, &tab_label(sp, 2)));
    assert!(!drives(sp, &tab_label(sp, 1)), "not the agent's tab");
    with_space(sp, |s| s.acted = Instant::now().checked_sub(DRIVEN_FOR));
    assert!(!driven(sp), "off DRIVEN_FOR after the last verb");
    with_space(sp, |s| s.acted = Some(Instant::now()));
    control::held_by_owner(sp);
    assert!(!driven(sp), "the owner holds it");
}

/// Ticket 998 L3 (B2): settle takes a page once it is past "loading", not only at "complete".
#[test]
fn settle_takes_a_page_past_loading() {
    assert!(!arrived(&json!({"ready": "loading"})));
    assert!(arrived(&json!({"ready": "interactive"})));
    assert!(arrived(&json!({"ready": "complete"})));
    assert!(!arrived(&json!({})), "no answer is not a page");
    assert_eq!(loaded("went".into(), None), "went");
    assert_eq!(
        loaded(
            "went".into(),
            Some(", but the page did not load: offline".into())
        ),
        "went, but the page did not load: offline"
    );
}

/// Ticket 998 L8 (B6): a click or key that starts no load ends on the page's changes, not on a fixed 400 ms wait; a
/// load it started is waited for; `goto` and `open` wait for their page only.
#[test]
fn settle_ends_on_the_pages_changes() {
    let ms = Duration::from_millis;
    let page = |idle: Option<f64>| json!({"ready": "complete", "idle": idle});
    let (none, quiet, busy) = (page(None), page(Some(QUIET_MS)), page(Some(10.0)));
    // Nothing changed: on at 180 ms, over at NO_CHANGE with the note.
    assert_eq!(verdict(false, ms(180), Some(&none), false, false), None);
    let note = verdict(false, NO_CHANGE, Some(&none), false, false)
        .unwrap()
        .unwrap();
    assert!(
        note.contains("no page change seen in 200 ms; requests may still be running"),
        "{note}"
    );
    // A change, then quiet: settled with no note, well before the old 400 ms floor.
    assert_eq!(
        verdict(false, ms(130), Some(&quiet), false, false),
        Some(None)
    );
    assert_eq!(verdict(false, ms(130), Some(&busy), false, false), None);
    let note = verdict(false, CHANGING_MAX, Some(&busy), false, false)
        .unwrap()
        .unwrap();
    assert!(note.contains("still changing after 1000 ms"), "{note}");
    // A load the click started: no DOM rule ends it; the new page past loading does.
    assert_eq!(verdict(false, ms(3000), Some(&none), false, true), None);
    assert_eq!(
        verdict(false, ms(3000), Some(&none), true, true),
        Some(None)
    );
    let loading = json!({"ready": "loading"});
    assert_eq!(verdict(false, ms(3000), Some(&loading), true, true), None);
    // goto / open: only their page ends the wait; a page that never answers ends at LOAD_MAX.
    assert_eq!(verdict(true, ms(3000), Some(&quiet), false, false), None);
    assert_eq!(
        verdict(true, ms(3000), Some(&quiet), false, true),
        None,
        "a load's state never ends goto's wait"
    );
    assert_eq!(verdict(false, ms(3000), None, false, false), None);
    let note = verdict(true, LOAD_MAX + ms(1), None, false, false)
        .unwrap()
        .unwrap();
    assert!(note.contains("outcome unknown"), "{note}");
}

/// Ticket 998 L10 round 2 (security MUST): many spaces never mean many threads. Workers stay at WORKERS_MAX, a busy
/// one is never retired (its space's order holds), a new space past the cap with every worker busy is refused, and
/// idle and forgotten workers end their threads.
#[test]
fn space_workers_are_bounded_and_retired() {
    use std::sync::atomic::AtomicBool;
    static HOLD: AtomicBool = AtomicBool::new(false);
    let run = |_: Value| {
        while HOLD.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(2));
        }
    };
    let settled = |list: &Vec<(String, Worker)>| {
        let until = Instant::now() + Duration::from_secs(5);
        while !list.iter().all(|(_, w)| w.idle()) {
            assert!(Instant::now() < until, "jobs did not end");
            thread::sleep(Duration::from_millis(2));
        }
    };
    let (mut list, now) = (Vec::new(), Instant::now());
    for i in 0..200 {
        let at = now + Duration::from_millis(i);
        assert!(hand(&mut list, &format!("s{i}"), json!(i), at, &run).is_ok());
        assert!(list.len() <= WORKERS_MAX);
        settled(&list);
    }
    let threads_down_to = |n: usize| {
        let until = Instant::now() + Duration::from_secs(5);
        while LIVE.load(Ordering::SeqCst) > n {
            assert!(Instant::now() < until, "worker threads did not end");
            thread::sleep(Duration::from_millis(2));
        }
    };
    threads_down_to(WORKERS_MAX); // a dropped worker's thread ends
    // Every worker busy: a new space waits for room, a busy space keeps its worker through Forget and the idle wait.
    HOLD.store(true, Ordering::SeqCst);
    let names: Vec<String> = list.iter().map(|(s, _)| s.clone()).collect();
    for s in &names {
        assert!(hand(&mut list, s, json!(0), now, &run).is_ok());
    }
    assert!(hand(&mut list, "new", json!(0), now, &run).is_err());
    prune(&mut list, now + WORKER_IDLE * 2);
    assert_eq!(list.len(), WORKERS_MAX, "busy workers stay");
    HOLD.store(false, Ordering::SeqCst);
    settled(&list);
    // Forget retires its space; the idle wait retires the rest, and every thread ends.
    let gone = names[0].clone();
    *WORKERS.lock().unwrap() = std::mem::take(&mut list);
    retire(&gone);
    let mut list = std::mem::take(&mut *WORKERS.lock().unwrap());
    assert!(list.iter().all(|(s, _)| *s != gone) && list.len() == WORKERS_MAX - 1);
    prune(&mut list, now + WORKER_IDLE * 2);
    assert!(list.is_empty());
    threads_down_to(0);
}

/// Ticket 998 L10 round 3 (B3): a job whose clock ran out while it waited (behind earlier jobs, or waking its page)
/// never starts its action; it says so. With time left the action runs.
#[test]
fn late_job_is_not_run() {
    let ran = Cell::new(false);
    UNTIL.set(Some(Instant::now() + START_MIN / 2));
    let e = in_time(|| {
        ran.set(true);
        Ok(())
    })
    .unwrap_err();
    assert!(!ran.get() && e.starts_with("Not run: out of time") && e.contains("nothing ran"));
    UNTIL.set(Some(Instant::now()));
    assert_eq!(in_time(|| Ok(1)), Err(OUT_OF_TIME.into()));
    UNTIL.set(Some(Instant::now() + START_MIN * 3));
    assert_eq!(in_time(|| Ok(1)), Ok(1));
    UNTIL.set(None);
    assert_eq!(in_time(|| Ok(1)), Ok(1), "off a job nothing is refused");
}

/// Ticket 998 L10 (B9): open's worst case (a throttled page woken, the load cap, the snapshot after it) fits the job's
/// clock, which ends before the core's VERB_WAIT (12 s); every wait of a job is cut to what is left of it.
#[test]
fn open_answers_before_the_verb_wait() {
    assert!(WAKE_MAX + LOAD_MAX + SNAPSHOT_WAIT <= ANSWER_BY);
    assert!(ANSWER_BY < Duration::from_secs(12));
    assert_eq!(left(), Duration::MAX, "off a job nothing is cut");
    UNTIL.set(Some(Instant::now() + Duration::from_secs(1)));
    assert!(left() > Duration::ZERO && left() <= Duration::from_secs(1));
    UNTIL.set(Some(Instant::now()));
    assert!(left().is_zero());
    UNTIL.set(None);
}

/// Ticket 998 L5 (B3): after an action's own call, a late answer is "outcome unknown" (the action may still run);
/// only a refusal, where nothing ran, stays an error.
#[test]
fn late_action_is_outcome_unknown() {
    for e in [LATE_INPUT, LATE_PAGE, LATE_LOAD] {
        let note = unknown::<()>(Err(e.into())).unwrap().unwrap();
        assert!(loaded("clicked [1] button Go".into(), Some(note)).contains("outcome unknown"));
    }
    assert_eq!(unknown(Ok(())), Ok(None));
    assert!(unknown::<()>(Err("The owner has the browser".into())).is_err());
}

/// Ticket 998 L5 (B3, B4): a page with a huge title, then click: the answer is Ok and keeps the done line. An
/// over-budget snapshot keeps its first 80% and last 20% of rows and counts the cut (998 L9: `cut`).
#[test]
fn answer_fits_the_budget() {
    let huge = "T".repeat(ANSWER_MAX + 1);
    let click =
        json!({"done": "clicked [3] button Buy", "title": huge, "url": huge, "tab": 1, "tabs": 1});
    let r = fit(click).expect("an action's answer is never an error");
    assert!(r.to_string().len() <= ANSWER_MAX);
    assert!(s(&r["done"]).starts_with("clicked [3] button Buy; "), "{r}");
    assert_eq!(r["tab"], 1);
    // Round 2 (security MUST): a done line that is itself over budget (a page's option label) still arrives.
    let select = json!({"done": format!("selected {huge} in [2] Topic"), "title": "t", "url": "u"});
    let r = fit(select).expect("an action's answer is never an error");
    assert!(
        r.to_string().len() <= ANSWER_MAX,
        "{} bytes",
        r.to_string().len()
    );
    assert!(s(&r["done"]).starts_with("selected TTT"));

    let rows: Vec<Value> = (1..=1000)
        .map(|i| json!({"i": i, "role": "link", "label": "L".repeat(1000)}))
        .collect();
    let r = fit(json!({"title": "t", "url": "u", "rows": rows, "text": "x"})).unwrap();
    assert!(r.to_string().len() <= ANSWER_MAX);
    let kept: Vec<u64> = r["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["i"].as_u64().unwrap())
        .collect();
    assert_eq!(kept[0], 1);
    assert_eq!(*kept.last().unwrap(), 1000, "the last rows stay");
    let gap = kept.windows(2).filter(|w| w[1] != w[0] + 1).count();
    assert_eq!(gap, 1, "one cut, in the middle");
    let head = kept.windows(2).position(|w| w[1] != w[0] + 1).unwrap() + 1;
    assert_eq!(head, (kept.len() * 4).div_ceil(5), "80% before the cut");
    assert_eq!(
        r["cut"],
        1000 - kept.len() as u64,
        "the answer counts the cut"
    );

    let tree = (0..20_000)
        .map(|i| format!("- text \"{i} {}\"", "w".repeat(40)))
        .collect::<Vec<_>>()
        .join("\n");
    let r = fit(json!({"title": "t", "url": "u", "tree": tree})).unwrap();
    assert!(r.to_string().len() <= ANSWER_MAX);
    assert!(
        s(&r["tree"]).contains(" lines cut\n"),
        "the outline names its cut"
    );

    let small = json!({"title": "t", "url": "u", "rows": [], "text": "x"});
    assert_eq!(
        fit(small.clone()).unwrap(),
        small,
        "under budget: unchanged"
    );
}

/// L9 round 2 (security MUST): the page after an action is read under the action's turn. Once the owner has the
/// space, the answer keeps its done line but carries none of his page, and the agent's numbers stay as they were.
#[test]
fn page_after_a_takeover_is_not_shown() {
    let turn = control::Turn {
        space: "r2-taken".into(),
        queued: control::now_micros(),
    };
    // As run_js: a read with a turn is refused while `control::gate` refuses it.
    let read = |t: Option<&control::Turn>, _: String| {
        if let Some(t) = t {
            control::gate(t)?;
        }
        Ok(
            json!({"title": "Bank", "url": "https://bank.example/", "doc": "d1",
                "rows": [{"i": 1, "role": "textbox", "label": "IBAN", "value": "DE00"}], "text": "balance 9,000"}),
        )
    };
    let r = finish(&turn, "r2-view", "clicked [1] button Pay".into(), read).unwrap();
    assert_eq!(
        r["text"], "balance 9,000",
        "the agent's own turn: the page is shown"
    );
    control::held_by_owner("r2-taken");
    let r = finish(&turn, "r2-view", "clicked [1] button Pay".into(), read).unwrap();
    assert_eq!(
        s(&r["done"]),
        "clicked [1] button Pay; the page is not shown: the owner took over this browser"
    );
    let shown = r.to_string();
    assert!(
        !shown.contains("balance") && !shown.contains("DE00") && !shown.contains("bank"),
        "{shown}"
    );
    assert_eq!(
        seen_doc("r2-taken", "r2-view").as_deref(),
        Some("d1"),
        "numbers unchanged"
    );
}

/// Ticket 998 L9 (idle throttle): a space is throttled IDLE_AFTER after its last job or park, never while a job runs,
/// and only once; the thread sleeps until the next space is due.
#[test]
fn idle_spaces_are_throttled_once_after_the_wait() {
    let now = Instant::now();
    let space = |idle: Option<Duration>, busy: bool| Space {
        idle: idle.map(|d| now - d),
        busy,
        ..Space::default()
    };
    let mut all = vec![
        ("old".into(), space(Some(IDLE_AFTER), false)),
        ("busy".into(), space(Some(IDLE_AFTER * 2), true)),
        ("new".into(), space(Some(Duration::from_secs(1)), false)),
        ("done".into(), space(None, false)),
    ];
    let (due_now, next) = due(&mut all, now);
    assert_eq!(due_now, vec!["old".to_string()]);
    assert!(
        all[0].1.asleep && all[0].1.idle.is_none(),
        "throttled, so the next job wakes it"
    );
    assert_eq!(
        next,
        Some(now + IDLE_AFTER - Duration::from_secs(1)),
        "the new one is next"
    );
    assert_eq!(due(&mut all, now).0, Vec::<String>::new(), "once");
    assert!(!all[1].1.asleep, "never during a job");
}

/// Ticket 998 L9 (B8): numbers are looked up only in the view and document of the last page answer; the answer's
/// tab is the view that was read; Forget ends it; a refusal names its code first.
#[test]
fn numbers_belong_to_the_page_they_came_from() {
    let space = "l9-seen";
    two_tabs(space);
    with_space(space, |s| s.current = 1);
    let (t1, t2) = (tab_label(space, 1), tab_label(space, 2));
    assert_eq!(
        seen_doc(space, &t1),
        None,
        "no page yet: every number is page_moved"
    );
    let mut r = json!({"title": "t", "url": "u", "doc": "100.5", "next": 40, "rows": []});
    place(space, &t1, &mut r);
    assert!(
        r.get("doc").is_none() && r.get("next").is_none(),
        "the page's keys stay in the app"
    );
    assert_eq!(
        with_space(space, |s| s.next),
        40,
        "the next page read numbers on from here"
    );
    assert_eq!(
        (r["tab"].clone(), r["tabs"].clone()),
        (json!(1), json!(2)),
        "the tab that was read, not the current one"
    );
    assert_eq!(seen_doc(space, &t1).as_deref(), Some("100.5"));
    assert_eq!(
        seen_doc(space, &t2),
        None,
        "another tab's numbers are not these"
    );
    // An answer without a page (a snapshot that did not answer) keeps the last page's numbers.
    place(space, &t2, &mut json!({"title": "", "url": ""}));
    assert_eq!(seen_doc(space, &t1).as_deref(), Some("100.5"));
    // A takeover note is not ended by an action's page.
    with_space(space, |s| s.moved = Some(2));
    place(space, &t2, &mut json!({"doc": "200.25"}));
    assert_eq!(with_space(space, |s| s.moved), Some(2));
    assert_eq!(seen_doc(space, &t2).as_deref(), Some("200.25"));
    place(space, &t2, &mut json!({"doc": "300", "next": 7}));
    assert_eq!(
        with_space(space, |s| s.next),
        40,
        "the counter never goes back"
    );
    take_tabs(space);
    assert_eq!(seen_doc(space, &t2), None, "Forget starts over");
    assert_eq!(
        with_space(space, |s| s.next),
        40,
        "but no number is given again"
    );
    for code in ["ref_stale", "page_moved"] {
        let e = refusal(code, &json!(4));
        assert!(
            e.starts_with(&format!("{code}: [4] ")) && is_refusal(&e),
            "{e}"
        );
    }
}

/// C4: the app accepts the closed verb set only; an unknown verb, an extra field (a space or session the agent
/// names) or a script is refused before anything runs.
#[test]
fn app_browser_link_typed_variants_only() {
    for bad in [
        json!({"id": 1, "space": "s1", "verb": {"verb": "eval", "script": "document.cookie"}}),
        json!({"id": 1, "space": "s1", "verb": {"verb": "goto", "url": "https://a", "space": "s2"}}),
        json!({"id": 1, "space": "s1", "verb": {"verb": "tabs", "session": "s2"}}),
        json!({"id": 1, "space": "s1", "verb": {"verb": "open_window"}}),
        json!({"id": 1, "space": "s1", "window": "main", "verb": {"verb": "tabs"}}),
        // Ticket 328 part 2: an agent names its tab by number only, never by a view label or another space.
        json!({"id": 1, "space": "s1", "verb": {"verb": "tab", "tab": 2, "label": "browser-x"}}),
        json!({"id": 1, "space": "s1", "verb": {"verb": "tab", "tab": 2, "space": "s2"}}),
        json!({"id": 1, "space": "s1", "verb": {"verb": "tab", "tab": "browser-x"}}),
    ] {
        assert!(serde_json::from_value::<Job>(bad.clone()).is_err(), "{bad}");
    }
    let ok: Job =
        serde_json::from_value(json!({"id": 7, "space": "s1", "verb": {"verb": "snapshot"}}))
            .unwrap();
    assert_eq!(
        ok.verb,
        Verb::Snapshot {
            tree: false,
            full: false
        }
    );
}

/// A3, app side: `handle` refuses the "you" store first, before it looks up or creates any view.
#[test]
fn agent_verbs_refuse_you_store() {
    assert!(refuse_you(YOU).unwrap_err().contains("the owner's own"));
    assert!(refuse_you("").is_err());
    assert!(refuse_you("you:a1").is_err());
    assert!(refuse_you("s1").is_ok());
}

/// Ticket 255 (needs 198): the home page loads for the owner's empty address only; an agent's open or goto never lands on it.
#[test]
fn home_page_loads_in_user_tab_never_on_agent_goto() {
    let prefs =
        view::Prefs::from_features(&json!({"browser.home_page": "https://mail.example/inbox"}));
    let home = "https://mail.example/inbox";
    assert_eq!(start_page("", Some(YOU), &prefs).unwrap().as_str(), home);
    assert_eq!(start_page("  ", Some(YOU), &prefs).unwrap().as_str(), home);
    assert!(
        start_page("", None, &prefs).is_err(),
        "an agent names its page"
    );
    assert_eq!(
        start_page("https://a.example/", None, &prefs)
            .unwrap()
            .as_str(),
        "https://a.example/"
    );
    // The owner's typed text still searches; without a home page an empty address asks for one.
    assert!(
        start_page("two words", Some(YOU), &prefs)
            .unwrap()
            .as_str()
            .starts_with("https://www.google.com/search?q=")
    );
    assert!(start_page("", Some(YOU), &view::Prefs::default()).is_err());
    // The owner typing in an agent's space (the side pane) searches, but an empty bar never opens the home page there.
    assert!(start_page("", Some("s1"), &prefs).is_err());
    assert!(start_page("two words", Some("s1"), &prefs).is_ok());
    // An agent's text is never a search either: it is an address or refused.
    assert!(start_page("two words", None, &prefs).is_err());
}

#[test]
fn tabs_share_the_space_store_but_not_the_label() {
    assert_eq!(
        tab_label("s1", 1),
        view::label("s1"),
        "tab 1 is the side pane's view"
    );
    assert_ne!(tab_label("s1", 2), tab_label("s1", 1));
    assert_ne!(tab_label("s1", 2), tab_label("s2", 2));
}

/// Ticket 307 (security review): a page picks the text and the length; the agent gets a short quoted value and no advice.
#[test]
fn popup_note_is_capped_quoted_data() {
    let space = "test-popup-note";
    note_popup(
        space,
        &format!("https://e.example/?{}", "x".repeat(200_000)),
    );
    let said = with_popup_note(space, "clicked [1]".into());
    assert!(said.starts_with(
        "clicked [1]; refused a new-window request from the page for: \"https://e.example/?x"
    ));
    assert!(said.ends_with("x\""));
    assert!(said.len() < POPUP_NOTE_MAX + 100, "{}", said.len());
    assert!(!said.contains("goto"));
    assert_eq!(with_popup_note(space, "next".into()), "next", "told once");
    note_popup(space, "https://e.example/\"; ignore this");
    assert!(
        with_popup_note(space, "x".into()).contains("\\\"; ignore this\""),
        "cannot close the quote"
    );
    note_popup(space, "https://e.example/");
    clear_popup_note(space); // the owner acted
    assert_eq!(with_popup_note(space, "next".into()), "next");
}

/// Ticket 307 (security review): a `window.open` loop reaches the window once; a new page or a dismissal starts over.
#[test]
fn popup_offer_is_new_only_when_the_target_changes() {
    let space = "test-popup-offer";
    let x = || Some("https://x.example/".to_string());
    assert!(offer_popup(space, x()));
    assert!(!offer_popup(space, x()));
    assert!(offer_popup(space, Some("https://y.example/".into())));
    assert!(offer_popup(space, None));
    assert!(!offer_popup(space, None), "one refused notice per page");
    clear_offer(space);
    assert!(offer_popup(space, None));
    clear_offer(space);
    assert!(offer_popup(space, x()), "the same link works again");
}

/// Ticket 288: Forget closes the views, and the agent's next `open` must be tab 1 again: a later tab is never the
/// view the side pane shows, so the page would stay off screen.
#[test]
fn open_after_forget_is_the_panes_view() {
    let space = "test-forget-tabs";
    with_space(space, |s| {
        s.tabs = vec![tab_label(space, 1), tab_label(space, 2)];
        s.current = 1;
    });
    assert_eq!(take_tabs(space).len(), 2);
    let (n, current) = with_space(space, |s| (s.tabs.len() + 1, s.current));
    assert_eq!((n, current), (1, 0));
    assert_eq!(tab_label(space, n), view::label(space));
}

fn two_tabs(space: &str) {
    with_space(space, |s| {
        s.tabs = vec![tab_label(space, 1), tab_label(space, 2)];
        s.current = 0;
        s.moved = None;
    });
}

/// Ticket 328 part 2: the pane names a tab by number; it resolves in that space's own list only. No number, 1 and an
/// unused space stay tab 1 (the pane's view, as before). 0, past the end, another space's tab and the owner's spaces are refused.
#[test]
fn pane_tab_resolves_within_its_space_only() {
    two_tabs("test-tab-of");
    two_tabs("test-tab-of-other");
    assert_eq!(
        tab_of("test-tab-of", None).unwrap(),
        view::label("test-tab-of")
    );
    assert_eq!(
        tab_of("test-tab-of", Some(1)).unwrap(),
        view::label("test-tab-of")
    );
    assert_eq!(
        tab_of("test-tab-of", Some(2)).unwrap(),
        tab_label("test-tab-of", 2)
    );
    assert_ne!(
        tab_of("test-tab-of", Some(2)),
        tab_of("test-tab-of-other", Some(2))
    );
    for bad in [0, 3, 9, u32::MAX] {
        assert!(
            tab_of("test-tab-of", Some(bad))
                .unwrap_err()
                .contains("No tab"),
            "{bad}"
        );
    }
    assert!(tab_of("test-tab-never-used", Some(2)).is_err());
    assert!(
        peek("test-tab-never-used", |_| ()).is_none(),
        "a pane's question adds no space"
    );
    // Ticket 328 part 1's refusal holds here too: the owner's own spaces never have agent tabs, whatever the list says.
    two_tabs("you:a1");
    for you in [YOU, "you:a1", ""] {
        assert!(
            tab_of(you, Some(2))
                .unwrap_err()
                .contains("the owner's own"),
            "{you:?}"
        );
    }
}

/// Ticket 328 part 2: the strip's read lists every open tab with its address and page title, and the agent's current
/// tab; a tab whose view is gone is left out; a space the agent never used lists none.
#[test]
fn tab_read_lists_each_tab_with_title_and_current() {
    let space = "test-tab-read";
    two_tabs(space);
    with_space(space, |s| s.current = 1);
    let read = |l: &str| {
        let n = tab_index(space, l);
        Some(
            json!({"url": format!("https://e.example/{n}"), "title": format!("Page {n}"), "back": false}),
        )
    };
    assert_eq!(
        tabs_list(space, read),
        json!({"current": 2, "tabs": [
            {"tab": 1, "url": "https://e.example/1", "title": "Page 1"},
            {"tab": 2, "url": "https://e.example/2", "title": "Page 2"},
        ]})
    );
    let gone = tab_label(space, 2);
    let without = tabs_list(space, |l| (l != gone).then(|| read(l)).flatten());
    assert_eq!(without["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(
        tabs_list("test-tab-read-none", read),
        json!({"tabs": [], "current": 1})
    );
}

/// Ticket 328 part 2: a view label maps back to its tab number before `open` lists it (its first page load comes first).
#[test]
fn tab_number_comes_from_the_label() {
    assert_eq!(tab_index("test-ix", &view::label("test-ix")), 1);
    assert_eq!(tab_index("test-ix", &tab_label("test-ix", 3)), 3);
    assert_eq!(
        tab_index("test-ix", &tab_label("test-ix", TABS_MAX)),
        TABS_MAX
    );
    assert_eq!(
        tab_index("test-ix", &tab_label("test-ix-other", 3)),
        1,
        "another space's tab is not ours"
    );
}

/// Ticket 328 part 2: the owner acts on tab 2, so the agent's current tab is 2. A label of another space, or of the tab
/// that is already current, changes nothing.
#[test]
fn owner_takeover_moves_the_agent_to_that_tab() {
    let space = "test-owner-on";
    two_tabs(space);
    owner_on(space, &tab_label("test-owner-on-other", 2));
    assert_eq!(with_space(space, |s| (s.current, s.moved)), (0, None));
    owner_on(space, &tab_label(space, 2));
    assert_eq!(with_space(space, |s| (s.current, s.moved)), (1, Some(2)));
    with_space(space, |s| s.moved = None);
    owner_on(space, &tab_label(space, 2));
    assert_eq!(with_space(space, |s| s.moved), None, "no move, no note");
    owner_on(space, &view::label(space));
    assert_eq!(take_tabs(space).len(), 2);
    assert_eq!(with_space(space, |s| s.moved), None, "Forget clears it");
}

/// Security review r1 MUST 1: after the owner took over tab 2, the agent's first page-changing verb is refused, nothing is
/// done, and the answer names tab 2; the next one runs. Reading verbs pass; a snapshot (fresh numbers of tab 2) and the
/// agent's own `tab` verb end the refusal.
/// Ticket 997 L7 round 4 (wrong-element fill): a fill gives its own field the keyboard focus under the B8 guard, and checks
/// that the field holds it, before any text goes in; text sent first went to the field the owner had left focused.
#[test]
fn fill_focuses_its_field_before_typing() {
    let code: String = include_str!("agent.rs")
        .split("#[cfg(test)]")
        .next()
        .unwrap()
        .split_whitespace()
        .collect();
    let fill = code
        .split("Verb::Fill{index,text}=>{")
        .nth(1)
        .unwrap()
        .split("Verb::Select")
        .next()
        .unwrap();
    let focus = fill
        .find(r#"on_ref(space,&wv,Some(turn),json!({"op":"focus","i":index}))?"#)
        .expect("the fill asks its field for the focus");
    let insert = fill.find("n.insert(").unwrap();
    assert!(focus < insert, "focus before any text");
    assert!(
        fill[focus..insert].contains(r#"f["focused"]!=true"#)
            && fill[focus..insert].contains("returnErr(")
    );
}

#[test]
fn fill_after_takeover_is_refused_once() {
    let space = "test-moved-gate";
    let fill = || Verb::Fill {
        index: 2,
        text: "x".into(),
    };
    two_tabs(space);
    owner_on(space, &tab_label(space, 2));
    assert!(moved_gate(space, &Verb::Tabs {}).is_ok(), "reading passes");
    let e = moved_gate(space, &fill()).unwrap_err();
    assert!(
        e.contains("Nothing was done") && e.contains("tab 2") && e.contains("snapshot"),
        "{e}"
    );
    assert!(moved_gate(space, &fill()).is_ok(), "refused once");
    for verb in [
        Verb::Goto {
            url: "https://e.example/".into(),
        },
        Verb::Click { index: 1 },
        Verb::Select {
            index: 1,
            option: "a".into(),
        },
        Verb::Press {
            key: "Enter".into(),
        },
        Verb::Scroll { down: true },
    ] {
        with_space(space, |s| s.moved = Some(2));
        assert!(moved_gate(space, &verb).is_err(), "{verb:?}");
    }
    with_space(space, |s| s.moved = Some(2));
    let snapshot = Verb::Snapshot {
        tree: false,
        full: false,
    };
    assert!(moved_gate(space, &snapshot).is_ok());
    // Ticket 553: the gate passed but the snapshot failed, so snapshot_seen never ran: the click is still refused once.
    assert!(
        moved_gate(space, &Verb::Click { index: 3 }).is_err(),
        "a failed snapshot keeps it"
    );
    assert!(
        moved_gate(space, &Verb::Click { index: 3 }).is_ok(),
        "refused once"
    );
    with_space(space, |s| s.moved = Some(2));
    assert!(moved_gate(space, &snapshot).is_ok());
    snapshot_seen(space, with_space(space, |s| s.takeovers));
    assert!(
        moved_gate(space, &fill()).is_ok(),
        "a snapshot of tab 2 ends it"
    );
}

/// Ticket 553 review r1 SHOULD: the owner takes over while the snapshot script runs. The answer is about the old tab, so the
/// new note stays and the next page-changing verb is refused once, also when he came back to the tab the note names.
#[test]
fn takeover_during_a_snapshot_keeps_the_refusal() {
    let space = "test-snapshot-race";
    two_tabs(space);
    owner_on(space, &tab_label(space, 2));
    let snapshot = Verb::Snapshot {
        tree: false,
        full: false,
    };
    assert!(moved_gate(space, &snapshot).is_ok());
    let before = with_space(space, |s| s.takeovers);
    // While the script runs: the owner goes to tab 1 and back to tab 2, so the note again names tab 2.
    owner_on(space, &tab_label(space, 1));
    owner_on(space, &tab_label(space, 2));
    snapshot_seen(space, before);
    assert_eq!(
        with_space(space, |s| s.moved),
        Some(2),
        "the new note stays"
    );
    assert!(
        moved_gate(space, &Verb::Click { index: 3 }).is_err(),
        "refused once"
    );
    assert!(moved_gate(space, &Verb::Click { index: 3 }).is_ok());
}

/// Security review r1 SHOULD 2: `open` makes the new tab current, so a takeover note about an older tab is over.
#[test]
fn open_clears_the_takeover_note() {
    let space = "test-open-moved";
    two_tabs(space);
    owner_on(space, &tab_label(space, 2));
    add_tab(space, tab_label(space, 3));
    assert_eq!(with_space(space, |s| (s.current, s.moved)), (2, None));
    assert!(moved_gate(space, &Verb::Click { index: 1 }).is_ok());
}

/// Security review r1 SHOULD 3: a page picks its title; the pane gets at most `TITLE_MAX` characters, cut on a
/// character boundary.
#[test]
fn page_title_is_capped() {
    assert_eq!(cap_title("Docs".into()), "Docs");
    let long = "가".repeat(TITLE_MAX * 1000);
    let cut = cap_title(long);
    assert_eq!(cut.chars().count(), TITLE_MAX);
    assert!(cut.chars().all(|c| c == '가'));
}

#[test]
fn press_takes_named_keys_only() {
    assert_eq!(keys::of("Enter"), Some(("\r", 36)));
    assert!(keys::of("Cmd+Q").is_none());
    assert!(keys::of("a").is_none());
}

/// Ticket 349: `Webview::url` unwraps WKWebView.URL inside wry, so calling it before a view's first commit ended the
/// whole app. A running WKWebView cannot be driven from a unit test, so this checks the source: no browser code calls
/// it (a page-load payload's `p.url()` is a stored value), and the toolbar's read goes through `mac::nav`, which allows nil.
#[test]
fn toolbar_url_never_reaches_wrys_unwrap() {
    let code = |src: &str| -> String {
        src.split("#[cfg(test)]")
            .next()
            .unwrap()
            .split_whitespace()
            .collect()
    };
    for (name, src) in [
        ("agent.rs", include_str!("agent.rs")),
        ("agent/settle.rs", include_str!("agent/settle.rs")), // ticket 1162: agent.rs's children
        ("agent/workers.rs", include_str!("agent/workers.rs")),
        ("annotate.rs", include_str!("annotate.rs")),
        ("control.rs", include_str!("control.rs")),
        ("mod.rs", include_str!("mod.rs")),
        ("view.rs", include_str!("view.rs")),
    ] {
        assert!(
            !code(src).replace("p.url()", "").contains(".url()"),
            "{name} calls Webview::url"
        );
    }
    let agent = code(include_str!("agent.rs"));
    let state = agent.split("fnnav_state(").nth(1).unwrap();
    assert!(state.split("fnstop(").next().unwrap().contains("mac::nav("));
    assert!(agent.contains("leturl:Option<Retained<AnyObject>>=msg_send![wk,URL]"));
}

/// A17: the lifted snapshot code names its upstream and commit in its header, and NOTICES and the reuse ledger
/// carry it (scripts/check-reuse-ledger.sh checks the ledger against every header).
#[test]
fn notices_list_lifted_browser_code() {
    let head: String = SCRIPT.lines().take(20).collect::<Vec<_>>().join("\n");
    assert!(
        head.contains("jev-ultrafast `jev_ultrafast/snapshot.js`")
            && head.contains("commit 1231850a")
    );
    assert!(
        head.contains("MIT License, Copyright (c) 2026 Browser Use")
            && head.contains("Permission is hereby granted")
    );
    assert!(
        include_str!("../../../../NOTICES")
            .lines()
            .any(|l| l.starts_with("jev-ultrafast ") && l.contains("1231850a"))
    );
    assert!(
        include_str!("../../../../docs/reuse-ledger.md")
            .contains("| `app/src-tauri/src/browser/snapshot.js` | code | jev-ultrafast |")
    );
    for network in [
        "fetch(",
        "XMLHttpRequest",
        "sendBeacon",
        "WebSocket",
        "import(",
    ] {
        assert!(!SCRIPT.contains(network), "{network}");
    }
}

/// Round 2 review: a first open that fails must not fix the space's profile or its pick; a retry with another pick wins.
#[test]
fn failed_first_open_leaves_the_pick_free() {
    let rows = std::cell::RefCell::new(json!([]));
    let read = || {
        Ok(view::Profiles::from_features(&json!({
            "browser.profiles": {"list": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
            "browser.space_profiles": rows.borrow().clone(),
        })))
    };
    let save = |v| {
        *rows.borrow_mut() = v;
        Ok(())
    };
    let known = || None;
    let space = "test-failed-first-open";
    let failed = on_profile(space, Some("a"), read, save, known, |_| {
        Err::<String, _>("no window".to_string())
    });
    assert_eq!(failed.unwrap_err(), "no window");
    assert_eq!(with_space(space, |s| s.profile.clone()), None);
    assert_eq!(spaces_on("a"), 0, "a failed build holds nothing");
    assert_eq!(read().unwrap().pick_of(space), None);
    let built = on_profile(space, Some("b"), read, save, known, |p| Ok(p.to_string()));
    assert_eq!(built.unwrap(), "b");
    assert_eq!(read().unwrap().pick_of(space), Some("b"));
}

/// A3 and A10 in the script's source: password, file and hidden inputs never reach the table, and the script
/// has no op that runs caller-supplied code.
#[test]
fn snapshot_script_rules() {
    assert!(SCRIPT.contains("!['password', 'file', 'hidden'].includes"));
    assert!(
        SCRIPT.contains("case 'signin'"),
        "the sign-in handoff asks the page"
    );
    for bad in [
        "eval(",
        "new Function",
        "Function(",
        "setTimeout(req",
        "innerHTML =",
    ] {
        assert!(!SCRIPT.contains(bad), "{bad}");
    }
}
