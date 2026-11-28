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
    let (mut core, launches, [seat, worker, _, other]) = family("memory-room");
    let home = core.home.clone();
    bot_seat(&mut core, &seat, "bot-a");
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
    // A room message: every session of the room hears it.
    let _ = core.handle_agent(
        &seat,
        Request::RoomSend {
            to: None,
            thread: None,
            body: "from the page".into(),
            ask: false,
            project: None,
        },
    );
    assert_eq!(
        crate::team::outside(&home, std::slice::from_ref(&worker.id)),
        Some(Source::Web)
    );
    end_family(core, launches);
}

#[test]
fn a_claude_seat_may_not_edit_the_memory_files() {
    let home = Path::new("/h/home");
    let mut settings = serde_json::Map::new();
    super::super::memory::deny_memory(&mut settings, home);
    let deny = settings["permissions"]["deny"].as_array().unwrap();
    for rule in [
        "Edit(//h/home/team/*/MEMORY.md)",
        "Edit(//h/home/team/*/memory/**)",
        "Edit(//h/home/team/USER.md)",
        "Edit(//h/home/memory-state/**)",
    ] {
        assert!(deny.iter().any(|r| r == rule), "{rule}: {deny:?}");
    }
    assert!(
        !deny.iter().any(|r| r.as_str().unwrap().contains("SOUL")),
        "SOUL.md stays the bot's"
    );
}
