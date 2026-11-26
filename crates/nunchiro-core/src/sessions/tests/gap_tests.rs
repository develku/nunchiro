//! The gap rule: another sender's message goes into an agent's box only when its turn ended, the owner pressed no key
//! for the session in the last `TYPING_QUIET`, and the box holds none of his text. His own prompt waits for the turn.
use super::*;

fn claude_box(text: &str) -> String {
    format!(
        "\x1b[?2004h\x1b[2J\x1b[H{RULE}{RULE}{RULE}\r\n\u{276f} {text}\r\n{RULE}{RULE}{RULE}\r\n  footer\r\n"
    )
}
fn codex_box(text: &str) -> String {
    format!("\x1b[?2004h\x1b[2J\x1b[H\u{203a} {text}\r\n\r\n  gpt-5 high \u{b7} ~/p\r\n")
}
/// An idle seat of `kind` whose screen shows `screen`; input lands in `got`. Labeled Ada: it sends its own lines.
fn seat(name: &str, kind: AgentKind, screen: &str) -> Flood {
    let mut f = unobserved(name, screen.as_bytes());
    let id = f.id.clone();
    let entry = f.core.entries.get_mut(&id).unwrap();
    entry.meta.kind = kind;
    entry.meta.label = "Ada".into();
    f.core.tick().unwrap();
    f
}
fn sent(reply: Response) -> crate::delivery::Send {
    match reply {
        Ok(Reply::Delivery { send }) => send,
        other => panic!("not taken: {other:?}"),
    }
}
/// Another sender's line: the seat's own (as the room's notice is).
fn agent_line(f: &mut Flood, text: &str) -> crate::delivery::Send {
    let id = f.id.clone();
    sent(f.core.send(&id, &id, text.into(), vec![], true))
}
fn owner_prompt(f: &mut Flood, text: &str) -> crate::delivery::Send {
    sent(f.core.handle(Request::AgentPrompt {
        id: f.id.clone(),
        text: text.into(),
    }))
}
fn wait_of(f: &mut Flood, send: &str) -> Option<String> {
    let Ok(Reply::Agent { session }) = f.core.handle(Request::AgentGet { id: f.id.clone() }) else {
        panic!("no session")
    };
    session.send_waits.get(send).cloned()
}
fn status(f: &Flood, send: &str) -> String {
    send_row(f, send).status
}
fn typing(f: &mut Flood) {
    f.core.handle(Request::Typing { id: f.id.clone() }).unwrap();
}
/// The owner's last key was `TYPING_QUIET` ago.
fn quiet(f: &mut Flood) {
    let id = f.id.clone();
    if let Some(t) = f.core.typing_until.get_mut(&id) {
        *t = std::time::Instant::now() - std::time::Duration::from_millis(1);
    }
}
fn turn_ends(f: &mut Flood) {
    hook(f, "UserPromptSubmit");
    hook(f, "Stop");
}

#[test]
fn an_agent_line_waits_while_the_owner_types() {
    let mut f = seat("gap-typing", AgentKind::Claude, &claude_box(""));
    typing(&mut f);
    let line = agent_line(&mut f, "agent line");
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), b"", "no byte while he types");
    assert_eq!(status(&f, &line.id), "queued");
    assert_eq!(wait_of(&mut f, &line.id).as_deref(), Some("typing"));
    quiet(&mut f);
    f.core.flush_delivery().unwrap();
    enter_1085(&mut f);
    assert_eq!(got(&f), [paste_1085("agent line"), b"\r".to_vec()].concat());
    assert_eq!(status(&f, &line.id), "delivered");
}

#[test]
fn the_owners_prompt_does_not_wait_for_his_typing() {
    let mut f = seat("gap-own", AgentKind::Claude, &claude_box(""));
    typing(&mut f);
    let mine = owner_prompt(&mut f, "my prompt");
    assert_eq!(mine.status, "attempting");
    enter_1085(&mut f);
    assert_eq!(got(&f), [paste_1085("my prompt"), b"\r".to_vec()].concat());
}

#[test]
fn nothing_is_pasted_into_a_box_that_holds_text() {
    for (i, (kind, screen)) in [
        (AgentKind::Claude, claude_box("my own words")),
        (AgentKind::Codex, codex_box("my own words")),
    ]
    .into_iter()
    .enumerate()
    {
        let mut f = seat(&format!("gap-box-{i}"), kind, &screen);
        let mine = owner_prompt(&mut f, "my prompt");
        let line = agent_line(&mut f, "agent line");
        for _ in 0..3 {
            f.core.flush_delivery().unwrap();
        }
        assert_eq!(got(&f), b"", "{kind:?}: nothing pasted behind his text");
        for send in [&mine.id, &line.id] {
            assert_eq!(status(&f, send), "queued", "{kind:?}");
            assert_eq!(
                wait_of(&mut f, send).as_deref(),
                Some("terminal_text"),
                "{kind:?}"
            );
        }
    }
}

#[test]
fn the_composer_send_waits_behind_text_in_the_box() {
    let mut f = seat(
        "gap-composer",
        AgentKind::Claude,
        &claude_box("my own words"),
    );
    f.core
        .handle(text_request(&f, "from the composer", true, &[]))
        .unwrap();
    composer_keys(&mut f, &["enter"], &[]).unwrap();
    assert_eq!(got(&f), b"", "neither the words nor the Enter");
    let row = rows(&f)
        .into_iter()
        .find(|s| s.content == "from the composer")
        .unwrap();
    assert_eq!(
        (row.sender.as_str(), row.status.as_str()),
        ("user", "queued")
    );
}

#[test]
fn send_now_skips_the_typing_wait() {
    let mut f = seat("gap-now", AgentKind::Claude, &claude_box(""));
    typing(&mut f);
    let line = agent_line(&mut f, "agent line");
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), b"");
    f.core
        .handle(Request::SendNow {
            id: f.id.clone(),
            send: line.id.clone(),
        })
        .unwrap();
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), paste_1085("agent line"), "goes while he types");
    // His own prompt never waits for him: no choice to make on it.
    typing(&mut f);
    let mine = owner_prompt(&mut f, "mine");
    let refused = f.core.handle(Request::SendNow {
        id: f.id.clone(),
        send: mine.id,
    });
    assert!(refused.is_err(), "{refused:?}");
}

#[test]
fn later_waits_for_the_turn_after_the_owners_next_prompt() {
    let mut f = seat("gap-later", AgentKind::Claude, &claude_box(""));
    typing(&mut f);
    let line = agent_line(&mut f, "agent line");
    f.core
        .handle(Request::SendLater {
            id: f.id.clone(),
            send: line.id.clone(),
        })
        .unwrap();
    quiet(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), b"", "Later: not in this gap");
    assert_eq!(wait_of(&mut f, &line.id).as_deref(), Some("later"));
    owner_prompt(&mut f, "mine");
    f.core.flush_delivery().unwrap(); // queued behind the waiting line, it goes first
    enter_1085(&mut f);
    let mine = [paste_1085("mine"), b"\r".to_vec()].concat();
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), mine, "not before his prompt's turn ended");
    assert_eq!(wait_of(&mut f, &line.id).as_deref(), Some("later"));
    turn_ends(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), [mine, paste_1085("agent line")].concat());
}

#[test]
fn an_attached_message_goes_under_the_owners_next_prompt() {
    let mut f = seat("gap-attach", AgentKind::Claude, &claude_box(""));
    let id = f.id.clone();
    typing(&mut f);
    let line = agent_line(&mut f, "agent words");
    f.core
        .handle(Request::SendAttach {
            id: id.clone(),
            send: line.id.clone(),
        })
        .unwrap();
    quiet(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), b"", "attached: waits for his prompt");
    assert_eq!(wait_of(&mut f, &line.id).as_deref(), Some("attached"));
    // A command takes no attachment; the message stays attached.
    owner_prompt(&mut f, "/compact");
    f.core.flush_delivery().unwrap();
    enter_1085(&mut f);
    let compact = [paste_1085("/compact"), b"\r".to_vec()].concat();
    assert_eq!(got(&f), compact);
    assert_eq!(wait_of(&mut f, &line.id).as_deref(), Some("attached"));
    turn_ends(&mut f);
    let mine = owner_prompt(&mut f, "my words");
    f.core.flush_delivery().unwrap();
    enter_1085(&mut f);
    let joined = "my words\n\n[Message from Ada, attached by the owner]\nagent words";
    assert_eq!(
        String::from_utf8_lossy(&got(&f)),
        String::from_utf8_lossy(&[compact, paste_1085(joined), b"\r".to_vec()].concat()),
        "one paste, his words first"
    );
    assert_eq!(status(&f, &mine.id), "delivered");
    assert_eq!(status(&f, &line.id), "delivered");
    // Detached, a message waits as Later.
    turn_ends(&mut f);
    typing(&mut f);
    let other = agent_line(&mut f, "more words");
    for request in [
        Request::SendAttach {
            id: id.clone(),
            send: other.id.clone(),
        },
        Request::SendDetach {
            id: id.clone(),
            send: other.id.clone(),
        },
    ] {
        f.core.handle(request).unwrap();
    }
    assert_eq!(wait_of(&mut f, &other.id).as_deref(), Some("later"));
}

#[test]
fn the_new_requests_are_the_owners_only() {
    let mut f = seat("gap-owner", AgentKind::Claude, &claude_box(""));
    let id = f.id.clone();
    typing(&mut f);
    let line = agent_line(&mut f, "agent line");
    let peer = crate::grants::Caller {
        id: "peer".into(),
        project: f.home.clone(),
    };
    let send = line.id.clone();
    for request in [
        Request::Typing { id: id.clone() },
        Request::SendNow {
            id: id.clone(),
            send: send.clone(),
        },
        Request::SendLater {
            id: id.clone(),
            send: send.clone(),
        },
        Request::SendAttach {
            id: id.clone(),
            send: send.clone(),
        },
        Request::SendDetach {
            id: id.clone(),
            send: send.clone(),
        },
    ] {
        let refused = f.core.handle_agent(&peer, request.clone());
        assert!(refused.is_err(), "{request:?}: {refused:?}");
    }
    assert!(f.core.now_rows.is_empty() && f.core.later_rows.is_empty());
}

#[test]
fn the_user_row_still_goes_first() {
    let mut f = seat("gap-first", AgentKind::Claude, &claude_box(""));
    let id = f.id.clone();
    hook(&mut f, "UserPromptSubmit");
    let wake = agent_line(&mut f, "worker done");
    f.core.wake_rows.insert(wake.id.clone());
    owner_prompt(&mut f, "mine");
    hook(&mut f, "Stop");
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), paste_1085("mine"));
    assert_eq!(status(&f, &wake.id), "queued");
    assert!(f.core.pending_enter.contains_key(&id));
}

#[test]
fn one_message_per_gap() {
    let mut f = seat("gap-one", AgentKind::Claude, &claude_box(""));
    hook(&mut f, "UserPromptSubmit");
    agent_line(&mut f, "first");
    let second = agent_line(&mut f, "second");
    hook(&mut f, "Stop");
    for _ in 0..3 {
        f.core.flush_delivery().unwrap();
    }
    enter_1085(&mut f);
    f.core.flush_delivery().unwrap();
    assert_eq!(got(&f), [paste_1085("first"), b"\r".to_vec()].concat());
    assert_eq!(status(&f, &second.id), "queued");
    assert_eq!(wait_of(&mut f, &second.id), None, "it goes in the next gap");
}

#[test]
fn an_attached_senders_name_carries_no_control_character() {
    let mut f = seat("gap-name", AgentKind::Claude, &claude_box(""));
    let id = f.id.clone();
    f.core.entries.get_mut(&id).unwrap().meta.label = "Ada\x1b[201~\r".into();
    assert_eq!(f.core.sender_name(&id), "Ada[201~");
}
