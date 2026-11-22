// Ticket 222 (B19): each finished turn's event carries the files that turn wrote, relative to the session project.
use nunchiro_core::{
    api::AgentKind,
    chat::turn_files::{MAX_EXEC_CALLS, Tracker},
};
use serde_json::{Value, json};

fn run(kind: AgentKind, records: &[Value]) -> Vec<Value> {
    let mut t = Tracker::default();
    records
        .iter()
        .flat_map(|r| t.project(kind, r))
        .filter(|e| e["kind"] == "turn")
        .collect()
}

fn claude_use(name: &str, input: Value) -> Value {
    json!({"type":"assistant","cwd":"/w/p","message":{"content":[{"type":"tool_use","id":format!("t-{name}"),"name":name,"input":input}]}})
}

#[test]
fn chat_turn_files_core_extracts_edit_and_patch_paths_capped() {
    // Claude: Edit, Write, MultiEdit and NotebookEdit paths; a Read, a path outside the project and a `..` path are not.
    let end = |id: &str| json!({"type":"system","subtype":"turn_duration","uuid":id,"cwd":"/w/p"});
    let claude = run(
        AgentKind::Claude,
        &[
            json!({"type":"user","cwd":"/w/p","message":{"content":"go"}}),
            claude_use("Edit", json!({"file_path":"/w/p/src/a.rs"})),
            claude_use("Write", json!({"file_path":"/w/p/notes/new.md"})),
            claude_use("MultiEdit", json!({"file_path":"/w/p/src/a.rs"})),
            claude_use("NotebookEdit", json!({"notebook_path":"/w/p/nb.ipynb"})),
            claude_use("Read", json!({"file_path":"/w/p/read.rs"})),
            claude_use("Write", json!({"file_path":"/etc/passwd"})),
            claude_use("Write", json!({"file_path":"/w/p2/sibling.rs"})),
            claude_use("Edit", json!({"file_path":"/w/p/../escape.rs"})),
            claude_use("Write", json!({"file_path":"/w/p/bad\u{202e}name.rs"})),
            end("u1"),
            // The next turn starts empty: it wrote nothing.
            json!({"type":"user","cwd":"/w/p","message":{"content":"thanks"}}),
            end("u2"),
        ],
    );
    assert_eq!(
        claude,
        vec![
            json!({"kind":"turn","turn_id":"u1","state":"completed","files":["src/a.rs","notes/new.md","nb.ipynb"]}),
            json!({"kind":"turn","turn_id":"u2","state":"completed","files":[]}),
        ]
    );

    // Codex: apply_patch (update, add, delete, move) relative to the session cwd; `..` and absolute outside dropped.
    let patch = "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-a\n+b\n*** Add File: docs/x.md\n+x\n*** Delete File: old.txt\n*** Update File: from.rs\n*** Move to: to.rs\n@@\n-c\n+d\n*** Update File: ../out.rs\n+e\n*** Add File: /tmp/abs.rs\n+f\n*** Add File: /w/c/inside.rs\n+g\n*** End Patch";
    let ev = |t: &str, id: &str| json!({"type":"event_msg","payload":{"type":t,"turn_id":id}});
    let codex = run(
        AgentKind::Codex,
        &[
            json!({"type":"session_meta","payload":{"id":"s","cwd":"/w/c"}}),
            ev("task_started", "c1"),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"p1","name":"apply_patch","input":patch}}),
            ev("task_complete", "c1"),
        ],
    );
    assert_eq!(codex[0]["state"], "started");
    assert_eq!(
        codex[1],
        json!({"kind":"turn","turn_id":"c1","state":"completed","files":["src/lib.rs","docs/x.md","old.txt","from.rs","to.rs","inside.rs"]})
    );

    // Cap: at most 200 paths per turn; an interrupted turn is finished too.
    let mut records = vec![json!({"type":"session_meta","payload":{"cwd":"/w/c"}})];
    records.push(ev("task_started", "c2"));
    for i in 0..250 {
        let p = format!("*** Begin Patch\n*** Add File: f{i}.txt\n+x\n*** End Patch");
        records.push(json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":format!("q{i}"),"name":"apply_patch","input":p}}));
    }
    records.push(ev("turn_aborted", "c2"));
    let capped = run(AgentKind::Codex, &records);
    let files = capped[1]["files"].as_array().unwrap();
    assert_eq!(capped[1]["state"], "interrupted");
    assert_eq!(files.len(), 200);
    assert_eq!(files[199], "f199.txt");
}

// Side effect of the Claude turn boundary (ticket 222 round 2): handoff text counts finished Claude turns. Before,
// a Claude transcript had no completed turn event, so its handoff always said "0 turns".
#[test]
fn handoff_counts_completed_claude_turns() {
    let end = |id: &str| json!({"type":"system","subtype":"turn_duration","uuid":id,"cwd":"/w/p"});
    let say = |role: &str, text: &str| json!({"type":role,"cwd":"/w/p","message":{"content":text}});
    let records = [
        say("user", "one"),
        say("assistant", "did one"),
        end("u1"),
        say("user", "two"),
        say("assistant", "did two"),
        end("u2"),
        // A third turn still running is not counted.
        say("user", "three"),
    ];
    let events: Vec<Value> = records
        .iter()
        .flat_map(|r| nunchiro_core::chat::project(AgentKind::Claude, r))
        .collect();
    let h = nunchiro_core::chat::handoff::build(
        &events,
        "Claude",
        "abcd1234ef",
        std::path::Path::new("/w/p"),
        false,
    );
    assert!(
        h.text
            .starts_with("Handoff from Claude (2 turns, session abcd1234)\n"),
        "{}",
        h.text
    );
}

// Codex exec-call tracking is bounded when a transcript has no `task_started` (V2.5-25).
fn exec_call(id: &str) -> Value {
    json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":"exec_command","arguments":"{\"cmd\":\"x\"}"}})
}
fn exec_end(id: &str) -> Value {
    json!({"type":"event_msg","payload":{"type":"exec_command_end","call_id":id,"exit_code":0,"aggregated_output":"out\n","duration":{"secs":1,"nanos":0}}})
}
fn exec_output(id: &str) -> Value {
    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":"receipt"}})
}
fn tracked_calls(t: &Tracker) -> usize {
    serde_json::to_value(t).unwrap()["exec_calls"]
        .as_object()
        .map_or(0, |m| m.len())
}
fn results_for(events: &[Value], id: &str) -> usize {
    events
        .iter()
        .filter(|e| e["kind"] == "tool_result" && e["tool_id"] == id)
        .count()
}

#[test]
fn codex_exec_calls_bounded_without_task_started() {
    let mut t = Tracker::default();
    for i in 0..MAX_EXEC_CALLS * 10 {
        let id = format!("c{i}");
        t.project(AgentKind::Codex, &exec_call(&id));
        t.project(AgentKind::Codex, &exec_end(&id));
        assert!(tracked_calls(&t) <= MAX_EXEC_CALLS, "call {i}");
    }
    assert_eq!(tracked_calls(&t), MAX_EXEC_CALLS);
}

fn full(t: &mut Tracker) {
    for i in 0..MAX_EXEC_CALLS {
        t.project(AgentKind::Codex, &exec_call(&format!("c{i}")));
    }
}
fn tracked_ids(t: &Tracker) -> Vec<String> {
    serde_json::to_value(t).unwrap()["exec_calls"]
        .as_object()
        .map_or(vec![], |m| m.keys().cloned().collect())
}

#[test]
fn exec_cap_tracks_newest_call() {
    let mut t = Tracker::default();
    full(&mut t);
    t.project(AgentKind::Codex, &exec_call("new"));
    // Tracked: the finished-command record shows the result, and the later output is the duplicate and is dropped.
    let end = t.project(AgentKind::Codex, &exec_end("new"));
    let out = t.project(AgentKind::Codex, &exec_output("new"));
    assert_eq!(results_for(&end, "new"), 1);
    assert_eq!(results_for(&out, "new"), 0);
}

#[test]
fn exec_cap_evicts_oldest_and_stays_bounded() {
    let mut t = Tracker::default();
    full(&mut t);
    t.project(AgentKind::Codex, &exec_call("new"));
    let ids = tracked_ids(&t);
    assert_eq!(ids.len(), MAX_EXEC_CALLS);
    assert!(!ids.contains(&"c0".to_string()));
    assert!(ids.contains(&"c1".to_string()) && ids.contains(&"new".to_string()));
    for i in 0..MAX_EXEC_CALLS * 3 {
        t.project(AgentKind::Codex, &exec_call(&format!("n{i}")));
        assert!(tracked_calls(&t) <= MAX_EXEC_CALLS, "call {i}");
    }
}

#[test]
fn exec_cap_replay_of_tracked_id_dedupes() {
    let mut t = Tracker::default();
    full(&mut t);
    // Replaying a tracked call neither evicts nor resets it: one result, the output dropped.
    t.project(AgentKind::Codex, &exec_call("c0"));
    assert!(tracked_ids(&t).contains(&"c0".to_string()));
    let mut events = t.project(AgentKind::Codex, &exec_end("c0"));
    events.extend(t.project(AgentKind::Codex, &exec_output("c0")));
    events.extend(t.project(AgentKind::Codex, &exec_end("c0")));
    assert_eq!(results_for(&events, "c0"), 1);
}

#[test]
fn exec_cap_evicted_id_passes_through() {
    let mut t = Tracker::default();
    full(&mut t);
    t.project(AgentKind::Codex, &exec_call("new"));
    // c0 was evicted: its end record adds nothing, its output shows once.
    let mut events = t.project(AgentKind::Codex, &exec_end("c0"));
    events.extend(t.project(AgentKind::Codex, &exec_output("c0")));
    assert_eq!(results_for(&events, "c0"), 1);
    assert_eq!(
        events.iter().find(|e| e["kind"] == "tool_result").unwrap()["output"],
        "receipt"
    );
}

#[test]
fn codex_exec_end_duplicate_still_dropped() {
    let mut t = Tracker::default();
    let mut events = t.project(AgentKind::Codex, &exec_call("c1"));
    events.extend(t.project(AgentKind::Codex, &exec_end("c1")));
    events.extend(t.project(AgentKind::Codex, &exec_output("c1")));
    events.extend(t.project(AgentKind::Codex, &exec_end("c1")));
    assert_eq!(results_for(&events, "c1"), 1);
}

#[test]
fn exec_cap_state_saved_without_order_still_evicts() {
    // A full map saved before `exec_order` existed: a new call still gets tracked and the map stays bounded.
    let calls: serde_json::Map<String, Value> = (0..MAX_EXEC_CALLS)
        .map(|i| (format!("c{i:04}"), json!(false)))
        .collect();
    let mut t: Tracker =
        serde_json::from_value(json!({"root": null, "files": [], "exec_calls": calls})).unwrap();
    t.project(AgentKind::Codex, &exec_call("new"));
    assert_eq!(tracked_calls(&t), MAX_EXEC_CALLS);
    assert!(tracked_ids(&t).contains(&"new".to_string()));
}

// Real-app 11-10 defect 3: a turn that changed a file through a shell command listed no file and Diff said the turn
// changed none. A turn that ran any tool which may write outside the edit tools marks its list partial.
#[test]
fn chat_turn_files_marks_a_turn_with_a_shell_command_partial() {
    let end = |id: &str| json!({"type":"system","subtype":"turn_duration","uuid":id,"cwd":"/w/p"});
    let say = |text: &str| json!({"type":"user","cwd":"/w/p","message":{"content":text}});
    let claude = run(
        AgentKind::Claude,
        &[
            say("append"),
            claude_use("Bash", json!({"command":"echo x >> a.txt"})),
            end("u1"),
            // Reading and editing only: the list is whole again.
            say("look"),
            claude_use("Read", json!({"file_path":"/w/p/a.txt"})),
            claude_use("Edit", json!({"file_path":"/w/p/b.txt"})),
            end("u2"),
            say("agent"),
            claude_use("Task", json!({"prompt":"fix it"})),
            claude_use("mcp__fs__write", json!({})),
            end("u3"),
        ],
    );
    assert_eq!(
        claude,
        vec![
            json!({"kind":"turn","turn_id":"u1","state":"completed","files":[],"files_partial":true}),
            json!({"kind":"turn","turn_id":"u2","state":"completed","files":["b.txt"]}),
            json!({"kind":"turn","turn_id":"u3","state":"completed","files":[],"files_partial":true}),
        ]
    );
    // Codex: exec_command is a shell; a new turn starts whole.
    let ev = |t: &str, id: &str| json!({"type":"event_msg","payload":{"type":t,"turn_id":id}});
    let codex = run(
        AgentKind::Codex,
        &[
            json!({"type":"session_meta","payload":{"cwd":"/w/c"}}),
            ev("task_started", "c1"),
            exec_call("x1"),
            ev("task_complete", "c1"),
            ev("task_started", "c2"),
            ev("task_complete", "c2"),
        ],
    );
    assert_eq!(codex[1]["files_partial"], true);
    assert_eq!(codex[3].get("files_partial"), None);
}
