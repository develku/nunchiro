use nunchiro_core::{api::AgentKind, queue::Kind, waiting::screen::Screen};
#[test]
fn split_ansi_trust_dialog_is_current_screen_state() {
    let mut screen = Screen::new(160, 50);
    screen.feed(b"\x1b[2J\x1b[HTrust this fol");
    screen.feed(b"der?\r\n1. Trust and continue\r\n2. Quit");
    let item = screen.detect(AgentKind::Codex).unwrap();
    assert_eq!(item.kind, Kind::Dialog);
    assert!(item.choices[0].changes_settings);
    assert!(!item.choices[1].changes_settings);
    screen.feed(b"\x1b[2J\x1b[HAsk Codex to do anything");
    assert!(screen.detect(AgentKind::Codex).is_none());
}
#[test]
fn erased_permission_is_not_found_in_scrollback() {
    let mut screen = Screen::new(160, 50);
    screen.feed(b"Do you want to proceed?\r\n1. Yes\r\n2. No");
    assert_eq!(
        screen.detect(AgentKind::Claude).unwrap().kind,
        Kind::Permission
    );
    screen.feed(b"\x1b[H\x1b[JDone");
    assert!(screen.detect(AgentKind::Claude).is_none());
}
#[test]
fn transcript_tool_calls_questions_and_turns_are_parsed() {
    use nunchiro_core::waiting::transcript::events;
    use serde_json::json;
    assert_eq!(events(AgentKind::Claude,&json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"red or blue?"}]}}]}}))[0].0,"Question");
    assert_eq!(
        events(
            AgentKind::Codex,
            &json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}})
        )[0]
        .0,
        "Stop"
    );
    assert_eq!(
        events(
            AgentKind::Codex,
            &json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1"}})
        )[0]
        .0,
        "Interrupted"
    );
}
#[test]
fn task_notifications_finish_background_work_without_starting_a_new_user_turn() {
    use nunchiro_core::waiting::transcript::events;
    use serde_json::json;
    let e = events(
        AgentKind::Claude,
        &json!({"type":"user","message":{"content":[{"type":"text","text":"<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>"}]}}),
    );
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].0, "TaskCompleted");
    assert_eq!(e[0].1["task_id"], "task-1");
}
#[test]
fn untrusted_oversized_csi_parameters_cannot_panic_or_escape_screen_bounds() {
    for command in ['B', 'C', 'E', 'X'] {
        let mut s = Screen::new(160, 50);
        s.feed(format!("\n\x1b[18446744073709551615{command}").as_bytes());
        s.feed(b"\x1b[HTrust this folder?");
        assert!(s.detect(AgentKind::Codex).is_some());
    }
}
#[test]
fn ordinary_tools_are_not_actionable_permissions() {
    use nunchiro_core::waiting::transcript::events;
    use serde_json::json;
    let cases = [
        (
            AgentKind::Codex,
            json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"sleep 30\"}"}}),
        ),
        (
            AgentKind::Claude,
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"readme"}}]}}),
        ),
    ];
    for (kind, record) in cases {
        assert!(
            events(kind, &record)
                .iter()
                .all(|(e, _)| e != "PermissionRequest")
        );
    }
}
#[test]
fn split_hangul_question_text_keeps_its_original_letters() {
    let mut screen = Screen::new(160, 50);
    let bytes = "눈치로 질문: 빨강 또는 파랑?".as_bytes();
    for byte in bytes {
        screen.feed(&[*byte]);
    }
    assert!(screen.text().contains("눈치로 질문: 빨강 또는 파랑?"));
}

#[test]
fn corrupt_transcript_line_does_not_hide_the_next_turn() {
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.scratch");
    let path = home.join(format!("corrupt-lines-{}.jsonl", std::process::id()));
    std::fs::write(&path,b"{broken\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"t\"}}\n").unwrap();
    let (_, end, records) = nunchiro_core::waiting::transcript::read(&path, "", 0)
        .unwrap()
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(end, std::fs::metadata(&path).unwrap().len());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn invalid_utf8_preserves_the_byte_starting_the_next_character() {
    let mut screen = Screen::new(20, 3);
    screen.feed(&[0xe2, b'Q']);
    assert!(screen.text().contains("\u{fffd}Q"));
    screen.reset();
    screen.feed(b"\x1b[3;1HX");
    let text = screen.text();
    assert_eq!(text.lines().count(), 3);
    assert_eq!(text.lines().nth(2).unwrap().trim(), "X");
}
#[test]
fn malformed_and_oversized_lines_advance_a_counted_durable_cursor() {
    use nunchiro_core::{queue::Queue, waiting::transcript::read_batch};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("skip-lines-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let path = home.join("input.jsonl");
    let mut bytes = vec![b'x'; 1024 * 1024 + 10];
    bytes.extend_from_slice(b"\n{broken\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"t\"}}\n");
    std::fs::write(&path, bytes).unwrap();
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Codex, 0).unwrap();
    let batch = read_batch(&path, "", 0, false).unwrap().unwrap();
    assert_eq!(batch.skipped, 1);
    assert!(batch.discarding);
    q.transcript_batch("s", batch, 1).unwrap();
    drop(q);
    let mut q = Queue::open(&home).unwrap();
    let (key, offset) = q.transcript_cursor("s");
    let batch = read_batch(&path, &key, offset, q.transcript_discarding("s"))
        .unwrap()
        .unwrap();
    assert_eq!(batch.skipped, 1);
    assert_eq!(batch.records.len(), 1);
    q.transcript_batch("s", batch, 2).unwrap();
    assert_eq!(q.attention("s").skipped_transcript_lines, 2);
    assert!(q.attention("s").working);
    std::fs::remove_dir_all(home).unwrap();
}
#[test]
fn refused_transcript_record_is_skipped_and_the_turn_still_ends() {
    // Q9 pin-J7-1: an over-limit question once failed the whole batch every tick, so Stop never arrived. The records
    // come from a crafted Claude transcript file, read as the core's tick reads it.
    use nunchiro_core::{queue::Queue, waiting::transcript::read_batch};
    let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("refused-record-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let huge = "x".repeat(70_000); // a question input over the queue's 64 KiB
    let lines = [
        serde_json::json!({"type":"user","uuid":"u1","message":{"content":"hi"}}),
        serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"q":huge}}]}}),
        serde_json::json!({"type":"assistant","message":{"content":[],"stop_reason":"end_turn"}}),
    ];
    let path = home.join("transcript.jsonl");
    std::fs::write(&path, lines.map(|l| l.to_string() + "\n").concat()).unwrap();
    let batch = read_batch(&path, "", 0, false).unwrap().unwrap();
    assert_eq!(batch.records.len(), 3);
    let (key, end) = (batch.key.clone(), batch.end);
    q.transcript_batch("s", batch, 1).unwrap();
    assert_eq!(q.transcript_cursor("s"), (key, end));
    assert_eq!(end, std::fs::metadata(&path).unwrap().len());
    assert!(!q.attention("s").working);
    std::fs::remove_dir_all(home).unwrap();
}
#[test]
fn reworded_trust_dialog_fails_closed_as_dialog() {
    let mut screen = Screen::new(160, 50);
    screen.feed(b"Do you want to work in this directory?\r\n\xe2\x9d\xaf 1. Yes, continue\r\n  2. No, exit\r\nEnter to confirm");
    let item = screen.detect(AgentKind::Codex).unwrap();
    assert_eq!(item.kind, Kind::Dialog);
    assert_eq!(item.choices.len(), 2);
}
#[test]
fn unknown_numbered_dialog_fails_closed_as_dialog() {
    let mut screen = Screen::new(160, 50);
    screen.feed(b"Pick a theme\r\n> 1. Dark\r\n  2. Light\r\n  3. Solarized\r\nEsc to cancel");
    assert_eq!(screen.detect(AgentKind::Claude).unwrap().kind, Kind::Dialog);
}
#[test]
fn plain_numbered_output_is_not_a_dialog() {
    let mut screen = Screen::new(160, 50);
    screen.feed(b"Steps:\r\n1. build\r\n2. test");
    assert!(screen.detect(AgentKind::Claude).is_none());
}
#[test]
fn working_footer_over_numbered_plan_is_not_waiting() {
    let mut screen = Screen::new(160, 50);
    screen.feed(
        "Plan:\r\n1. Install\r\n2. Configure\r\n✳ Working… (12s · esc to interrupt)\r\n❯ "
            .as_bytes(),
    );
    assert!(screen.detect(AgentKind::Claude).is_none());
}
#[test]
fn quoted_numbered_list_is_not_waiting() {
    let mut screen = Screen::new(160, 50);
    screen.feed(b"> 1. Install\r\n> 2. Configure\r\nPress esc to cancel the quote");
    assert!(screen.detect(AgentKind::Claude).is_none());
}
