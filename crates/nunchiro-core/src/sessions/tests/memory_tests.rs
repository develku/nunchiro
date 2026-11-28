//! A bot's seat and its memory marks (sessions/memory.rs): the mark follows a resumed seat, a seat whose tool calls the
//! core cannot see writes only proposals, and a marked seat's words mark whoever hears them.
use super::*;
use crate::team::Source;

/// `caller` becomes bot `bot`'s Claude seat.
fn bot_seat(core: &mut Sessions, caller: &crate::grants::Caller, bot: &str) {
    let meta = &mut core.entries.get_mut(&caller.id).unwrap().meta;
    meta.teammate = Some(bot.into());
    meta.kind = AgentKind::Claude;
}
fn add(core: &mut Sessions, caller: &crate::grants::Caller, text: &str) -> String {
    match core.handle_agent(
        caller,
        Request::BotMemory {
            operation: "add".into(),
            text: text.into(),
            topic: None,
            user: false,
            from_user: false,
        },
    ) {
        Ok(Reply::Text { text }) => text,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_resumed_seat_keeps_its_mark_and_an_unseen_seat_only_proposes() {
    let (mut core, launches, [seat, _, _, other]) = family("memory-marks");
    let home = core.home.clone();
    bot_seat(&mut core, &seat, "bot-a");
    assert!(
        add(&mut core, &seat, "Weekly review is on Friday.")
            .contains("Kept (from: a conversation)")
    );
    // The run this seat continues read a mail (a resume gives the seat a new row).
    core.entries.get_mut(&seat.id).unwrap().meta.resumed_from = vec!["run-before".into()];
    crate::team::mark_outside(&home, "run-before", Source::Mail).unwrap();
    assert!(
        add(&mut core, &seat, "Invoices go to finance.").contains("read mail"),
        "a resumed seat keeps the mark"
    );
    // A seat whose tool calls never reach the core: an ACP agent, and a Claude seat started without hooks.
    bot_seat(&mut core, &other, "bot-b");
    core.entries.get_mut(&other.id).unwrap().meta.kind = AgentKind::Acp;
    assert!(add(&mut core, &other, "Dana prefers Thursday.").contains("read a tool"));
    let meta = &mut core.entries.get_mut(&other.id).unwrap().meta;
    meta.kind = AgentKind::Claude;
    meta.without_hooks = true;
    assert!(add(&mut core, &other, "Dana prefers Tuesday.").contains("proposal"));
    let memory = crate::team::Team::open(&home).bot_memory("bot-b").unwrap();
    assert_eq!(memory.proposals().0.len(), 2);
    assert!(memory.facts().unwrap().is_empty());
    end_family(core, launches);
}

#[test]
fn a_marked_seat_marks_who_hears_it() {
    let (mut core, launches, [seat, worker, sub, other]) = family("memory-room");
    let home = core.home.clone();
    bot_seat(&mut core, &seat, "bot-a");
    let marked = |id: &str| crate::team::outside(&home, &[id.to_string()]);
    // A message from a session whose tool calls the core cannot see (a plain terminal here) marks its reader too.
    let Ok(Reply::Room { messages }) = core.handle_agent(
        &other,
        Request::RoomSend {
            to: Some(sub.id.clone()),
            thread: None,
            body: "hello".into(),
            ask: false,
            project: None,
        },
    ) else {
        panic!("room send")
    };
    let _ = core.handle_agent(
        &sub,
        Request::RoomThread {
            thread: messages[0].thread.clone(),
            project: None,
        },
    );
    assert_eq!(marked(&sub.id), Some(Source::Tool));
    // Not marked: its words mark nobody.
    let _ = core.handle_agent(
        &seat,
        Request::AgentSend {
            id: other.id.clone(),
            text: "hi".into(),
        },
    );
    assert_eq!(
        crate::team::outside(&home, std::slice::from_ref(&other.id)),
        None
    );
    crate::team::mark_outside(&home, &seat.id, Source::Web).unwrap();
    let _ = core.handle_agent(
        &seat,
        Request::AgentSend {
            id: other.id.clone(),
            text: "the page says hi".into(),
        },
    );
    assert_eq!(
        crate::team::outside(&home, std::slice::from_ref(&other.id)),
        Some(Source::Web)
    );
    // A room message marks the seat that reads it, when it reads it.
    let Ok(Reply::Room { messages }) = core.handle_agent(
        &seat,
        Request::RoomSend {
            to: Some(worker.id.clone()),
            thread: None,
            body: "from the page".into(),
            ask: false,
            project: None,
        },
    ) else {
        panic!("room send")
    };
    let thread = messages[0].thread.clone();
    assert_eq!(marked(&worker.id), None, "not read yet");
    let read = core.handle_agent(
        &worker,
        Request::RoomThread {
            thread,
            project: None,
        },
    );
    assert!(matches!(read, Ok(Reply::Room { .. })), "{read:?}");
    assert_eq!(marked(&worker.id), Some(Source::Web));
    end_family(core, launches);
}

#[test]
fn a_claude_seat_may_not_edit_the_memory_files_or_a_settled_soul() {
    let home = scratch("memory-deny");
    let team = crate::team::Team::open(&home);
    let bot = team
        .save(
            None,
            crate::team::Teammate {
                id: String::new(),
                name: "Bom".into(),
                job: "Keeps the mail in order.".into(),
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
        .unwrap()[0]
        .id
        .clone();
    let mut settings = serde_json::Map::new();
    super::super::memory::deny_memory(&mut settings, &home);
    let deny = settings["permissions"]["deny"].as_array().unwrap();
    let h = home.display();
    for rule in [
        format!("Edit(/{h}/team/*/MEMORY.md)"),
        format!("Edit(/{h}/[tT][eE][aA][mM]/*/[mM][eE][mM][oO][rR][yY].[mM][dD])"),
        format!("Edit(/{h}/team/*/memory/**)"),
        format!("Edit(/{h}/team/USER.md)"),
        format!("Edit(/{h}/[tT][eE][aA][mM]/[uU][sS][eE][rR].[mM][dD])"),
        format!("Edit(/{h}/memory-state/**)"),
        format!("Edit(/{h}/[mM][eE][mM][oO][rR][yY]-[sS][tT][aA][tT][eE]/**)"),
        // A bot with no first chat: its SOUL is the owner's to edit, on the Bots page.
        format!("Edit(/{h}/team/{bot}/SOUL.md)"),
    ] {
        assert!(deny.iter().any(|r| r == &rule), "{rule}: {deny:?}");
    }
    let _ = fs::remove_dir_all(home);
}

#[test]
fn a_marked_seat_cannot_forget_and_reading_a_marked_seat_marks_the_reader() {
    let (mut core, launches, [seat, worker, _, other]) = family("memory-forget");
    let home = core.home.clone();
    bot_seat(&mut core, &seat, "bot-a");
    add(&mut core, &seat, "Weekly review is on Friday.");
    crate::team::mark_outside(&home, &seat.id, Source::Mail).unwrap();
    let forget = core.handle_agent(
        &seat,
        Request::BotMemory {
            operation: "forget".into(),
            text: "Weekly review".into(),
            topic: None,
            user: false,
            from_user: false,
        },
    );
    assert!(
        matches!(&forget, Err(e) if e.contains("Memory tab")),
        "{forget:?}"
    );
    let marked = |id: &str| crate::team::outside(&home, &[id.to_string()]);
    // Reading a marked seat's row or screen marks the reader.
    let _ = core.handle_agent(
        &worker,
        Request::AgentGet {
            id: seat.id.clone(),
        },
    );
    assert_eq!(marked(&worker.id), Some(Source::Mail));
    assert_eq!(marked(&other.id), None);
    end_family(core, launches);
}

#[test]
fn a_resume_of_a_resume_keeps_the_mark_and_a_journaled_read_marks_at_start() {
    let (mut core, mut launches, [_, worker, _, _]) = family("memory-resume");
    let home = core.home.clone();
    crate::team::mark_outside(&home, &worker.id, Source::Web).unwrap();
    let mut id = worker.id.clone();
    for _ in 0..2 {
        core.handle(Request::Close { id: id.clone() }).unwrap();
        let conversation = store::new_id().unwrap();
        core.entries.get_mut(&id).unwrap().meta.agent_session_id = Some(conversation.clone());
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
                resume: Some(conversation),
            })
            .prepare()
            .unwrap();
        let resumed = core.start(&launch).unwrap();
        launch.committed = true;
        launches.push(launch);
        // Its own row carries the mark: the chain's ids may be dropped.
        assert_eq!(
            crate::team::outside(&home, std::slice::from_ref(&resumed.id)),
            Some(Source::Web)
        );
        id = resumed.id;
    }
    // A web read the hook journaled while no core ran marks its session when the next core starts.
    let event = crate::queue::journal::Event::new(
        "seat-journaled".into(),
        "PostToolUse".into(),
        serde_json::json!({"tool_name": "WebFetch", "tool_input": {"url": "https://example.com"}}),
    )
    .unwrap();
    crate::queue::journal::write(&home, &event).unwrap();
    end_family_keep(core, launches);
    let core = Sessions::open(&home).unwrap();
    assert_eq!(
        crate::team::outside(&home, &["seat-journaled".to_string()]),
        Some(Source::Web)
    );
    end_family(core, vec![]);
}

#[test]
fn hooks_off_at_the_start_stay_off_for_memory() {
    let home = scratch("memory-hooks-off");
    let mut core = Sessions::open(&home).unwrap();
    approve_fake_claude(&home, &[]);
    core.settings.disable_hook_injection = true;
    let mut launch = core
        .launch(claude_start(&home, &[]))
        .owner_start()
        .prepare()
        .unwrap();
    let id = core.start(&launch).unwrap().id;
    launch.committed = true;
    // The setting changed after the start: the seat still has no hooks, so it only proposes.
    core.settings.disable_hook_injection = false;
    assert!(core.entries[&id].meta.without_hooks);
    assert_eq!(core.read_outside(&id), Some(Source::Tool));
    end_family(core, vec![launch]);
}

/// `end_family` that keeps the home, for a next core to open.
fn end_family_keep(mut core: Sessions, launches: Vec<Launch>) {
    core.handle(Request::Stop).unwrap();
    drop((core, launches));
}

#[test]
fn a_home_path_with_pattern_characters_still_gets_the_memory_rules() {
    let mut settings = serde_json::Map::new();
    super::super::memory::deny_memory(&mut settings, Path::new("/h/my (old) [x]/home"));
    let deny = settings["permissions"]["deny"].as_array().unwrap();
    for rule in [
        "Edit(//h/my ?old? ?x?/home/team/USER.md)",
        "Edit(//h/my ?old? ?x?/home/memory-state/**)",
    ] {
        assert!(deny.iter().any(|r| r == rule), "{rule}: {deny:?}");
    }
}

#[test]
fn a_night_tidy_runs_for_a_bot_that_talked_and_raises_one_card() {
    let (core, launches, [seat, other, _, _]) = family("memory-night");
    let home = core.home.clone();
    let team = crate::team::Team::open(&home);
    let mate = |name: &str| crate::team::Teammate {
        id: String::new(),
        name: name.into(),
        job: "Keeps the mail in order.".into(),
        kind: AgentKind::Claude,
        model: None,
        effort: None,
        project: None,
        lead: false,
        level: None,
        level_max: None,
        next_level: None,
        agent: None,
    };
    let id_of = |all: Vec<crate::team::Teammate>, name: &str| {
        all.into_iter().find(|t| t.name == name).unwrap().id
    };
    // Boo comes first and its run fails (the bin answers no JSON for its index): Bom still tidies after it.
    let boo = id_of(team.save(None, mate("Boo")).unwrap(), "Boo");
    team.bot_memory(&boo)
        .unwrap()
        .add("Boom line.", Source::You, None, 1)
        .unwrap();
    let bom = id_of(team.save(None, mate("Bom")).unwrap(), "Bom");
    let quiet = id_of(team.save(None, mate("Mina")).unwrap(), "Mina");
    let m = team.bot_memory(&bom).unwrap();
    m.add("Weekly review Friday.", Source::Conversation, None, 1)
        .unwrap();
    m.add("Review is on Fridays at 10.", Source::You, None, 2)
        .unwrap();
    team.bot_memory(&quiet)
        .unwrap()
        .add("Quiet line.", Source::You, None, 1)
        .unwrap();
    let before = m.facts().unwrap();
    // The bin answers as Claude's print mode would; it records that it ran.
    let ran = home.join("ran");
    let bin = home.join("fake-claude");
    let answer = serde_json::json!({"result": serde_json::json!({"lines": [{"text": "Weekly review is on Friday at 10:00.", "from": [1, 2]}, {"text": "Keep the rest.", "from": [3]}]}).to_string(), "usage": {"input_tokens": 40, "output_tokens": 2}});
    fs::write(
        &bin,
        format!(
            "#!/bin/sh\nin=$(cat)\necho run >> '{}'\ncase \"$in\" in *Boom*) echo 'not json'; exit 0;; esac\necho '{answer}'\n",
            ran.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let registry = std::sync::Mutex::new(core);
    let night = |now: u64| {
        crate::team::memory_night(&registry, &home, now, Some(&bin), &Default::default()).unwrap()
    };
    // A new home only notes the time: no tidy the first day.
    let day = 86_400_000;
    let now = 1_795_780_800_000u64; // noon UTC: past three in the morning in any zone near it
    night(now - 3 * day);
    assert!(!ran.exists());
    {
        let mut core = registry.lock().unwrap();
        core.entries.get_mut(&seat.id).unwrap().meta.teammate = Some(bom.clone());
        core.queue.activity(&seat.id, now - day).unwrap();
        core.entries.get_mut(&other.id).unwrap().meta.teammate = Some(boo.clone());
        core.queue.activity(&other.id, now - day).unwrap();
    }
    night(now);
    assert_eq!(
        fs::read_to_string(&ran).unwrap().lines().count(),
        2,
        "only the bots that talked"
    );
    let order: Vec<String> = team.list().unwrap().into_iter().map(|t| t.id).collect();
    assert!(
        order.iter().position(|i| *i == boo) < order.iter().position(|i| *i == bom),
        "Boo is tidied first"
    );
    assert!(
        team.bot_memory(&boo).unwrap().pending_tidy().is_none(),
        "Boo's run failed"
    );
    let part = m.tidy_part(&bom, "Bom").unwrap().unwrap();
    assert_eq!(part.added[0].text, "Weekly review is on Friday at 10:00.");
    // A rewritten line takes the most outside source of the whole prompt: here a conversation's.
    assert_eq!(part.added[0].from, Some(Source::Conversation));
    assert_eq!(part.tokens, 42);
    let core = registry.into_inner().unwrap();
    let cards: Vec<_> = core
        .queue
        .owner_items()
        .into_iter()
        .filter(|i| matches!(&i.owner, Some(crate::queue::OwnerAsk::NightTidy { .. })))
        .collect();
    assert_eq!(cards.len(), 1, "no Chief: one card in the bot's own chat");
    assert_eq!(cards[0].session_id, bom);
    // The index did not change: the tidy waits for the user's look.
    assert_eq!(m.facts().unwrap(), before);
    end_family(core, launches);
}

#[test]
fn an_answer_from_a_marked_seat_and_a_read_of_its_transcript_pass_the_mark() {
    let (core, launches, [lead, worker, sub, _]) = family("memory-answer");
    let mut core = core;
    let home = core.home.clone();
    crate::team::mark_outside(&home, &worker.id, Source::Mail).unwrap();
    // The marked worker answers its own worker's question: that session heard it.
    let item = core
        .queue
        .acp_ask(
            &sub.id,
            crate::queue::Kind::Question,
            "Which branch?".into(),
        )
        .unwrap();
    core.pass_outside(
        &worker.id,
        &Request::Answer {
            item,
            answer: crate::queue::Answer::AllowOnce,
            confirmed: false,
        },
    );
    let marked = |id: &str| crate::team::outside(&home, &[id.to_string()]);
    assert_eq!(marked(&sub.id), Some(Source::Mail));
    // Its lead reads its transcript (the read the core serves off its lock): the lead is marked.
    assert_eq!(marked(&lead.id), None);
    let read = Request::AgentRead {
        id: worker.id.clone(),
        source: "transcript".into(),
        lines: 10,
    };
    let checked = core.check_reader(&lead, &read);
    assert!(checked.is_ok(), "{checked:?}");
    assert_eq!(marked(&lead.id), Some(Source::Mail));
    end_family(core, launches);
}
