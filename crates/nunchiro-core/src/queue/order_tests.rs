// V2.5-41 (audit B14): hooks carry the hook process's creation time; an event with no turn state must
// neither move nor be dropped by the per-session hook clock. Fixed stamps, no clock reads.
use super::*;

fn queue(tag: &str) -> (PathBuf, Queue) {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("queue-order-{tag}-{}", store::new_id().unwrap()));
    fs::create_dir_all(&home).unwrap();
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Codex, 1).unwrap();
    (home, q)
}
fn hook(q: &mut Queue, event: &str, p: Value, at: u64) {
    q.observe("s", event, &p, "hook", at).unwrap();
}
fn turn(q: &mut Queue, id: &str, at: u64) {
    hook(q, "UserPromptSubmit", json!({"turn_id": id}), at);
    hook(q, "Stop", json!({"turn_id": id}), at + 1);
}

#[test]
fn sessionstart_does_not_order_out_turn_hooks() {
    let (home, mut q) = queue("start");
    // identity::watch path: core clock T2 lands before the turn's hooks stamped T1 < T2.
    hook(
        &mut q,
        "SessionStart",
        json!({"session_id": "agent-1"}),
        200,
    );
    hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
    assert!(q.attention("s").working, "the prompt was ordered out");
    hook(&mut q, "Stop", json!({"turn_id": "t1"}), 101);
    assert_eq!(q.attention("s").completion_seq, 1);
    hook(&mut q, "Stop", json!({"turn_id": "t1"}), 101);
    assert_eq!(q.attention("s").completion_seq, 1, "counted once");
    fs::remove_dir_all(home).unwrap();
}

/// Ticket 1054: a lead got "worker done" lines while its worker was mid-job: a subagent's Stop counted as the
/// worker's turn end.
#[test]
fn a_subagents_stop_is_no_turn_end() {
    let (home, mut q) = queue("subagent-stop");
    hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
    hook(&mut q, "Stop", json!({"agent_id": "sub-1"}), 101);
    let a = q.attention("s");
    assert!(a.working, "a subagent's Stop ended the turn");
    assert_eq!(a.completion_seq, 0);
    hook(
        &mut q,
        "Stop",
        json!({"turn_id": "t1", "agent_id": ""}),
        102,
    );
    assert_eq!(q.attention("s").completion_seq, 1, "the main Stop ends it");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn working_since_is_the_turn_start() {
    let (home, mut q) = queue("since");
    hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
    hook(&mut q, "PreToolUse", json!({}), 150);
    assert_eq!(
        q.attention("s").working_since,
        100,
        "a later event in the turn kept the start"
    );
    hook(&mut q, "Stop", json!({"turn_id": "t1"}), 200);
    hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t2"}), 300);
    assert_eq!(q.attention("s").working_since, 300);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn stale_stop_after_newer_prompt_still_dropped() {
    let (home, mut q) = queue("stale");
    turn(&mut q, "a", 100);
    hook(&mut q, "UserPromptSubmit", json!({}), 300);
    // A Stop with no turn id stamped before the newer prompt is the earlier turn's.
    hook(&mut q, "Stop", json!({}), 200);
    let a = q.attention("s");
    assert!(a.working, "a stale Stop finished the current turn");
    assert_eq!(a.completion_seq, 1);
    hook(&mut q, "Stop", json!({}), 301);
    assert_eq!(q.attention("s").completion_seq, 2);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn sessionstart_mid_turn_keeps_working_state() {
    let (home, mut q) = queue("mid");
    hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
    hook(
        &mut q,
        "PermissionRequest",
        json!({"tool_name": "Bash", "tool_input": {"command": "touch x"}}),
        110,
    );
    let before = (q.attention("s"), q.items());
    // A late (resume) and an old (replayed) SessionStart.
    hook(
        &mut q,
        "SessionStart",
        json!({"session_id": "agent-1"}),
        120,
    );
    hook(&mut q, "SessionStart", json!({"session_id": "agent-1"}), 50);
    let after = (q.attention("s"), q.items());
    assert_eq!(after.0.working, before.0.working);
    assert_eq!(after.0.waiting, before.0.waiting);
    assert_eq!(after.0.completion_seq, before.0.completion_seq);
    assert_eq!(after.1, before.1, "items unchanged");
    // The turn it interrupted still completes, and a permission stamped between still applies.
    hook(&mut q, "Stop", json!({"turn_id": "t1"}), 115);
    assert_eq!(q.attention("s").completion_seq, 1);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn persisted_clock_from_sessionstart_does_not_hide_next_turn() {
    let (home, mut q) = queue("persist");
    turn(&mut q, "a", 100);
    hook(
        &mut q,
        "SessionStart",
        json!({"session_id": "agent-1"}),
        500,
    );
    drop(q);
    let mut q = Queue::open(&home).unwrap();
    turn(&mut q, "b", 200);
    assert_eq!(q.attention("s").completion_seq, 2);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn non_turn_arms_decided() {
    // Kinds that fall to `_ => {}` carry no turn state: none orders a turn's hooks out.
    for (event, p) in [
        ("SessionStart", json!({"session_id": "agent-1"})),
        (
            "Notification",
            json!({"message": "Claude needs your permission"}),
        ),
        ("SubagentStart", json!({"agent_id": "sub-1"})),
        ("PreToolUse", json!({"tool_name": "Bash", "tool_input": {}})),
        ("SessionEnd", json!({})),
    ] {
        let (home, mut q) = queue("arms");
        hook(&mut q, event, p, 200);
        turn(&mut q, "t1", 100);
        assert_eq!(
            q.attention("s").completion_seq,
            1,
            "{event} ordered the turn out"
        );
        fs::remove_dir_all(home).unwrap();
    }
    // A question PreToolUse raises an item, so it is a turn event and keeps the ordering.
    let (home, mut q) = queue("question");
    hook(
        &mut q,
        "PreToolUse",
        json!({"tool_name": "AskUserQuestion", "tool_input": {}}),
        200,
    );
    hook(&mut q, "PostToolUse", json!({}), 100);
    assert!(
        q.attention("s").waiting,
        "an older PostToolUse cleared a newer question"
    );
    fs::remove_dir_all(home).unwrap();
}

// Ticket 691: Codex 0.161 rollout lines for `request_user_input_async` (shape from the ticket 589 live run: `title`
// and plain-string options, `{"accepted":true}` at once, the answer later as a user message).
/// Seventh look (B S2-1): Claude runs two Write calls of one message one after the other. The first's result is in
/// the transcript before the second's permission request is asked, but the queue read it after that request
/// arrived (the transcript is read every tick, a hook at once): it took the second request's card, and Claude
/// waited at its prompt with the session "running" and nothing pending.
#[test]
fn w14_a_tool_result_written_before_a_request_leaves_its_card() {
    let (home, mut q) = queue("late-result");
    let ms =
        |t: &str| crate::usage::epoch(t).unwrap() as u64 * 1000 + t[20..23].parse::<u64>().unwrap();
    let result = |at: &str| {
        json!({"type":"user","timestamp":at,"uuid":at,
            "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}})
    };
    let ask = |q: &mut Queue, file: &str, event: &str, at: &str| {
        hook(
            q,
            "PermissionRequest",
            json!({"tool_name":"Write","tool_input":{"file_path":file},"nunchiro_event_id":event}),
            ms(at),
        );
    };
    q.disk.sessions.get_mut("s").unwrap().kind = AgentKind::Claude;
    hook(
        &mut q,
        "UserPromptSubmit",
        json!({"prompt_id":"t1"}),
        ms("2026-11-18T01:57:30.000Z"),
    );
    ask(
        &mut q,
        "/w/lane-slug/BRIEF.md",
        "e1",
        "2026-11-18T01:57:34.000Z",
    );
    let first = q.items_of("s")[0].id.clone();
    q.remove(&first).unwrap(); // allowed on its card
    hook(
        &mut q,
        "PostToolUse",
        json!({"tool_name":"Write"}),
        ms("2026-11-18T01:57:35.400Z"),
    );
    ask(
        &mut q,
        "/w/lane-greet/BRIEF.md",
        "e2",
        "2026-11-18T01:57:35.450Z",
    );
    // The first call's result, written before the second request, read after it.
    let read = ms("2026-11-18T01:57:35.500Z");
    q.transcript(
        "s",
        "k".into(),
        1,
        &[result("2026-11-18T01:57:35.412Z")],
        read,
    )
    .unwrap();
    let items = q.items_of("s");
    assert!(
        matches!(&items[..], [i] if i.text.contains("lane-greet") && i.hook_event_id.as_deref() == Some("e2")),
        "the second request lost its card: {items:?}"
    );
    assert!(q.attention("s").waiting && q.attention("s").working);
    // Its own result, written after it, ends it as before.
    q.transcript(
        "s",
        "k".into(),
        2,
        &[result("2026-11-18T01:57:41.000Z")],
        read + 6000,
    )
    .unwrap();
    assert!(q.items_of("s").is_empty() && !q.attention("s").waiting);
    // A question a transcript record made is as old as its record: its result in the same read ends it.
    let asks = json!({"type":"assistant","timestamp":"2026-11-18T01:58:00.000Z","message":{"role":"assistant",
        "content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[]}}]}});
    q.transcript(
        "s",
        "k".into(),
        3,
        std::slice::from_ref(&asks),
        read + 30_000,
    )
    .unwrap();
    assert_eq!(q.items_of("s").len(), 1);
    q.transcript(
        "s",
        "k".into(),
        4,
        &[asks, result("2026-11-18T01:58:05.000Z")],
        read + 60_000,
    )
    .unwrap();
    assert!(q.items_of("s").is_empty(), "{:?}", q.items_of("s"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_async_question_waits_until_answered() {
    let (home, mut q) = queue("async");
    let item = |payload: Value| json!({"timestamp":"2026-11-14T10:00:00.000Z","type":"response_item","payload":payload});
    let event = |payload: Value| json!({"timestamp":"2026-11-14T10:00:00.000Z","type":"event_msg","payload":payload});
    let ask = |call: &str| {
        item(
            json!({"type":"function_call","name":"request_user_input_async","call_id":call,
        "arguments":"{\"questions\":[{\"title\":\"Which port?\",\"options\":[\"8080\",\"9090\"]}]}"}),
        )
    };
    let output = |call: &str, out: &str| {
        item(json!({"type":"function_call_output","call_id":call,"output":out}))
    };
    let user = |text: &str| {
        item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]}))
    };
    let mut at = 100;
    let mut read = |q: &mut Queue, records: &[Value]| {
        at += 1;
        q.transcript("s", "k".into(), at, records, at).unwrap();
        q.attention("s").waiting
    };
    let turn = event(json!({"type":"task_started","turn_id":"t1"}));
    assert!(
        read(&mut q, &[turn, user("pick a port"), ask("call_1")]),
        "the question waits"
    );
    // Look 11-17 N20: its card offers the options as choices, answered by a message (no keys).
    let open = q.items_of("s");
    let labels: Vec<_> = open[0].choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["8080", "9090"]);
    assert!(answered_by_message(&open[0]) && open[0].choices[0].keys.is_empty());
    assert!(
        read(&mut q, &[output("call_1", "{\"accepted\":true}")]),
        "accepted is not answered"
    );
    assert!(
        read(
            &mut q,
            &[event(json!({"type":"task_complete","turn_id":"t1"}))]
        ),
        "the turn's end keeps it"
    );
    assert!(!read(&mut q, &[user("8080")]), "the answer clears it");
    // A call the room's hook denied (sent to the lead) is not a question for the person.
    let denied = "Tool call blocked by PreToolUse hook: sent as ask m1 to your lead";
    assert!(
        !read(&mut q, &[ask("call_2"), output("call_2", denied)]),
        "a denied call"
    );
    // Another tool's output while the question is open leaves it.
    assert!(read(&mut q, &[ask("call_3"), output("call_x", "ok")]));
    assert!(!read(&mut q, &[user("9090")]));
    // The hook path: the tool result and Stop keep it, the next prompt clears it.
    let tool =
        json!({"tool_name":"request_user_input_async","tool_use_id":"call_4","tool_input":{}});
    hook(&mut q, "PreToolUse", tool.clone(), 200);
    hook(&mut q, "PostToolUse", tool, 201);
    hook(&mut q, "Stop", json!({}), 202);
    assert!(
        q.attention("s").waiting,
        "hook: kept past the tool result and Stop"
    );
    hook(&mut q, "UserPromptSubmit", json!({}), 203);
    assert!(!q.attention("s").waiting, "hook: the prompt clears it");
    fs::remove_dir_all(home).unwrap();
}
