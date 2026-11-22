use nunchiro_core::{
    api::AgentKind,
    chat::{project, turn_files::Tracker},
};
use serde_json::json;

#[test]
fn chat_claude_text_hides_waiting_markers() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":"hello"}})
        ),
        vec![json!({"kind":"message","role":"user","text":"hello"})]
    );
    for marker in [
        "<system-reminder>",
        "<bash-input>",
        "<local-command-x>",
        "<task-notification>",
    ] {
        assert!(
            project(
                AgentKind::Claude,
                &json!({"type":"user","message":{"content":marker}})
            )
            .is_empty()
        );
    }
}

#[test]
fn chat_claude_images() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"c2FtcGxl"}}]}})
        ),
        vec![
            json!({"kind":"image","role":"user","source":{"type":"base64","media_type":"image/png","data":"c2FtcGxl"}})
        ]
    );
}

#[test]
fn chat_claude_assistant_blocks() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"thinking","thinking":"consider"}]}})
        ),
        vec![
            json!({"kind":"message","role":"assistant","text":"hello"}),
            json!({"kind":"thinking","text":"consider"})
        ]
    );
}

#[test]
fn chat_claude_tools() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"sample.txt"}}]}})
        ),
        vec![
            json!({"kind":"tool_use","tool_id":"read-1","name":"Read","input":{"file_path":"sample.txt"}})
        ]
    );
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":"sample","is_error":false}]}})
        ),
        vec![json!({"kind":"tool_result","tool_id":"read-1","output":"sample","is_error":false})]
    );
}

#[test]
fn chat_claude_edit() {
    assert_eq!(project(AgentKind::Claude, &json!({"type":"user","toolUseResult":{"filePath":"sample.txt","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-old","+new"]}]},"message":{"content":[{"type":"tool_result","tool_use_id":"edit-1","content":"edited"}]}})).last().unwrap(), &json!({"kind":"edit","tool_id":"edit-1","path":"sample.txt","added":1,"removed":1,"hunks":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-old","+new"]}]}));
}

#[test]
fn chat_claude_sidechain_and_unknown() {
    assert!(project(AgentKind::Claude, &json!({"type":"assistant","isSidechain":true,"parentToolUseID":"task-1","message":{"content":[{"type":"thinking","thinking":"private"}]}})).is_empty());
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"assistant","isSidechain":true,"parentToolUseID":"task-1","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"result"}]}})
        ),
        vec![json!({"kind":"task_result","tool_id":"task-1","text":"result"})]
    );
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"future","secret":"never emit raw JSON","message":{"content":"x"}})
        ),
        vec![json!({"kind":"skipped","count":1})]
    );
    for line in [json!("garbage line"), json!(7), json!([])] {
        assert_eq!(
            project(AgentKind::Claude, &line),
            vec![json!({"kind":"skipped","count":1})]
        );
        assert_eq!(
            project(AgentKind::Codex, &line),
            vec![json!({"kind":"skipped","count":1})]
        );
    }
    // Ticket 409: a record type with no message is bookkeeping, not left-out conversation.
    assert!(
        project(
            AgentKind::Claude,
            &json!({"type":"future","secret":"never emit raw JSON"})
        )
        .is_empty()
    );
}

#[test]
fn chat_codex_message_and_local_image() {
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"look"},{"type":"input_image","image_url":"file:///project/sample.png"}]}})
        ),
        vec![
            json!({"kind":"message","role":"user","text":"look"}),
            json!({"kind":"image","role":"user","source":{"type":"url","url":"file:///project/sample.png"}})
        ]
    );
}

#[test]
fn chat_codex_reasoning() {
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"consider"}],"encrypted_content":"omit"}})
        ),
        vec![json!({"kind":"thinking","text":"consider"})]
    );
}

#[test]
fn chat_codex_tools() {
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}})
        ),
        vec![
            json!({"kind":"tool_use","tool_id":"call-1","name":"exec_command","input":{"cmd":"pwd"}})
        ]
    );
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"/project"}})
        ),
        vec![json!({"kind":"tool_result","tool_id":"call-1","output":"/project","is_error":false})]
    );
}

#[test]
fn chat_codex_patch() {
    let events = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"edit-1","input":"*** Begin Patch\n*** Update File: sample.txt\n@@\n-old\n+new\n*** End Patch"}}),
    );
    assert_eq!(
        events[1],
        json!({"kind":"edit","tool_id":"edit-1","path":"sample.txt","added":1,"removed":1,"hunks":["-old","+new"]}),
        "look 11-17 N11: no bare `@@` before the first line"
    );
}

#[test]
fn chat_codex_turns_and_unknown() {
    for (name, state) in [
        ("task_started", "started"),
        ("task_complete", "completed"),
        ("turn_aborted", "interrupted"),
    ] {
        assert_eq!(
            project(
                AgentKind::Codex,
                &json!({"type":"event_msg","payload":{"type":name,"turn_id":"turn-1"}})
            ),
            vec![json!({"kind":"turn","turn_id":"turn-1","state":state})]
        );
    }
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"future","payload":{"secret":"hidden","content":"x"}})
        ),
        vec![json!({"kind":"skipped","count":1})]
    );
    assert!(
        project(
            AgentKind::Codex,
            &json!({"type":"future","payload":{"secret":"hidden"}})
        )
        .is_empty()
    );
}

#[test]
fn chat_pages_are_newest_200_then_older_without_overlap() {
    use nunchiro_core::chat::Feed;
    let mut feed = Feed::default();
    for n in 0..405 {
        feed.push(json!({"kind":"message","role":"user","text":n.to_string()}));
    }
    let newest = feed.page(None).unwrap();
    assert_eq!(newest.events.len(), 200);
    assert_eq!(newest.events[0].data["text"], "205");
    let older = feed.page(newest.before).unwrap();
    assert_eq!(older.events.len(), 200);
    assert_eq!(older.events[0].data["text"], "5");
    let oldest = feed.page(older.before).unwrap();
    assert_eq!(oldest.events.len(), 5);
    assert!(oldest.before.is_none());
    let mut all = oldest.events;
    all.extend(older.events);
    all.extend(newest.events);
    assert_eq!(all.len(), 405);
    for (n, e) in all.iter().enumerate() {
        assert_eq!(e.cursor, n as u64 + 1);
    }
    assert!(feed.page(Some(9999)).is_err());
}

#[test]
fn chat_live_cursor_catches_up_in_bounded_pages() {
    let mut feed = nunchiro_core::chat::Feed::default();
    for _ in 0..405 {
        feed.push(json!({"kind":"message"}));
    }
    let first = feed.since(0).unwrap();
    assert_eq!(first.events.len(), 200);
    assert_eq!(first.events[199].cursor, 200);
    let rest = feed.since(400).unwrap();
    assert_eq!(rest.events.len(), 5);
    assert_eq!(rest.end, 405);
    assert!(feed.since(406).is_err());
}

#[test]
fn chat_claude_interrupted_turn_and_unbound_sidechain() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":"[Request interrupted by user]"}})
        ),
        vec![json!({"kind":"turn","turn_id":null,"state":"interrupted"})]
    );
    assert!(project(AgentKind::Claude,&json!({"type":"assistant","isSidechain":true,"agentId":"agent-1","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"not a standalone chat row"}]}})).is_empty());
}
#[test]
fn chat_codex_local_image_block() {
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"local_image","path":"/project/sample.png"}]}})
        ),
        vec![
            json!({"kind":"image","role":"user","source":{"type":"path","path":"/project/sample.png"}})
        ]
    );
}

#[test]
fn chat_versioned_fixtures_match_checked_in_event_lists() {
    for (kind, fixture) in [
        (AgentKind::Claude, "claude-2.1.310"),
        (AgentKind::Codex, "codex-0.161.0"),
        (AgentKind::Codex, "codex-0.162.1"),
    ] {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat")
            .join(fixture);
        let expected: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(root.join("expected.json")).unwrap()).unwrap();
        let actual = std::fs::read_to_string(root.join("transcript.jsonl"))
            .unwrap()
            .lines()
            .flat_map(|line| {
                project(
                    kind,
                    &serde_json::from_str::<serde_json::Value>(line).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "{fixture}");
    }
}

#[test]
fn chat_codex_patch_deletion_does_not_invent_a_zero_line_count() {
    let events = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"delete-1","input":"*** Begin Patch\n*** Delete File: sample.txt\n*** End Patch"}}),
    );
    assert_eq!(
        events[1],
        json!({"kind":"edit","tool_id":"delete-1","path":"sample.txt","operation":"delete","added":0,"removed":null,"hunks":[]})
    );
}
#[test]
fn chat_codex_patch_rename_exposes_destination() {
    let events = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"move-1","input":"*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch"}}),
    );
    assert_eq!(
        events[1],
        json!({"kind":"edit","tool_id":"move-1","path":"old.txt","operation":"move","destination":"new.txt","added":1,"removed":1,"hunks":["-old","+new"]})
    );
}

#[test]
fn chat_malformed_content_blocks_are_counted_instead_of_emitted() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":8,"name":"Read","input":{}}]}})
        ),
        vec![json!({"kind":"skipped","count":1})]
    );
}

#[test]
fn chat_claude_user_content_accepts_schema_string_blocks() {
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":["hello",{"type":"text","text":"again"}]}})
        ),
        vec![
            json!({"kind":"message","role":"user","text":"hello"}),
            json!({"kind":"message","role":"user","text":"again"})
        ]
    );
    assert!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":["<system-reminder>hidden"]}})
        )
        .is_empty()
    );
    // Q9 pop-J15-1: a reminder block first must not hide the prompt or tool result beside it.
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","message":{"content":[
                {"type":"text","text":"<system-reminder>x</system-reminder>"},
                {"type":"text","text":"my prompt"},
                {"type":"tool_result","tool_use_id":"t1","content":"ok"}
            ]}})
        ),
        vec![
            json!({"kind":"message","role":"user","text":"my prompt"}),
            json!({"kind":"tool_result","tool_id":"t1","output":"ok","is_error":false})
        ]
    );
}

#[test]
fn chat_unknown_content_blocks_count_as_skipped() {
    for (kind, record) in [
        (
            AgentKind::Claude,
            json!({"type":"user","message":{"content":[{"type":"new_block"}]}}),
        ),
        (
            AgentKind::Codex,
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"new_block"}]}}),
        ),
    ] {
        assert_eq!(
            project(kind, &record),
            vec![json!({"kind":"skipped","count":1})]
        );
    }
}

/// v1b-37: Codex 0.161 applies patches through `exec`; the diff cards match the plain `apply_patch` call.
#[test]
fn chat_codex_exec_patch_gives_the_same_edits_as_apply_patch() {
    let patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+hi\n*** Delete File: c.txt\n*** Update File: d.txt\n*** Move to: e.txt\n@@\n-x\n+y\n*** End Patch";
    let plain = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"k","input":patch}}),
    );
    let script = format!(
        "const patch = \"{}\";\ntools.apply_patch(patch);",
        patch.replace('\n', "\\n")
    );
    let exec = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"k","input":script}}),
    );
    assert_eq!(plain.len(), 5, "{plain:#?}");
    assert_eq!(exec[1..], plain[1..]);
    // CRLF line ends parse the same.
    let crlf = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"k","input":script.replace("\\n", "\\r\\n")}}),
    );
    assert_eq!(crlf[1..], plain[1..]);
    // No `tools.apply_patch(` call: no edit event.
    let none = project(
        AgentKind::Codex,
        &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"k","input":script.replace("tools.apply_patch(", "console.log(")}}),
    );
    assert_eq!(none.len(), 1, "{none:#?}");
}

#[test]
fn tool_result_carries_at() {
    let at = "2026-10-27T10:00:00.000Z";
    let claude = |ts: serde_json::Value| {
        let mut r = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":"ok"}]}});
        if !ts.is_null() {
            r["timestamp"] = ts;
        }
        project(AgentKind::Claude, &r)
    };
    assert_eq!(
        claude(json!(at)),
        vec![json!({"kind":"tool_result","tool_id":"u1","output":"ok","is_error":false,"at":at})]
    );
    // No record timestamp: no `at`, and the event stays valid (not turned into a skip).
    assert_eq!(
        claude(json!(null)),
        vec![json!({"kind":"tool_result","tool_id":"u1","output":"ok","is_error":false})]
    );
    assert_eq!(
        project(
            AgentKind::Codex,
            &json!({"type":"response_item","timestamp":at,"payload":{"type":"function_call_output","call_id":"c1","output":"ok"}})
        ),
        vec![json!({"kind":"tool_result","tool_id":"c1","output":"ok","is_error":false,"at":at})]
    );
    // Only tool results take it.
    assert_eq!(
        project(
            AgentKind::Claude,
            &json!({"type":"user","timestamp":at,"message":{"content":"hi"}})
        ),
        vec![json!({"kind":"message","role":"user","text":"hi"})]
    );
}

// Ticket 139: Codex's finished-command records (`exec_command_end`, and 0.161.0's `item_completed` /
// `CommandExecution`) become one `tool_result`, only through the stateful Tracker.
fn tracked(records: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut t = Tracker::default();
    records
        .iter()
        .flat_map(|r| t.project(AgentKind::Codex, r))
        .collect()
}
fn call(id: &str) -> serde_json::Value {
    json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":"exec_command","arguments":"{\"cmd\":\"x\"}"}})
}
fn end(id: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut p = json!({"type":"exec_command_end","call_id":id,"aggregated_output":"out\n","duration":{"secs":1,"nanos":0}});
    p.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({"type":"event_msg","payload":p})
}
fn command_execution(id: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut item = json!({"type":"CommandExecution","id":id,"status":"completed","aggregated_output":"out\n","exit_code":0,"duration":{"secs":1,"nanos":0}});
    item.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({"type":"event_msg","payload":{"type":"item_completed","item":item}})
}
fn output(id: &str) -> serde_json::Value {
    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":"receipt"}})
}
fn results(events: &[serde_json::Value]) -> Vec<&serde_json::Value> {
    events
        .iter()
        .filter(|e| e["kind"] == "tool_result")
        .collect()
}

#[test]
fn codex_exec_command_end_projects_result() {
    let expected = json!({"kind":"tool_result","tool_id":"c1","output":"Wall time: 1.0000 seconds\nProcess exited with code 0\nOutput:\nout\n","is_error":false});
    for record in [
        end("c1", json!({"exit_code":0})),
        command_execution("c1", json!({})),
    ] {
        let events = tracked(&[call("c1"), record]);
        assert_eq!(results(&events), vec![&expected]);
    }
}

#[test]
fn codex_exec_command_end_no_false_success() {
    // Nonzero exit, or a status other than completed, is an error.
    let events = tracked(&[call("c1"), end("c1", json!({"exit_code":2}))]);
    assert_eq!(results(&events)[0]["is_error"], true);
    let events = tracked(&[
        call("c1"),
        command_execution("c1", json!({"status":"failed"})),
    ]);
    assert_eq!(results(&events)[0]["is_error"], true);
    // No exit code, a malformed one, or an id without a tool_use: nothing, never a success.
    for bad in [
        end("c1", json!({})),
        end("c1", json!({"exit_code":"0"})),
        end("c1", json!({"exit_code":null})),
        end("c1", json!({"exit_code":0.5})),
        end("other", json!({"exit_code":0})),
        command_execution("exec-1", json!({})),
        command_execution("c1", json!({"exit_code":null})),
        json!({"type":"event_msg","payload":{"type":"exec_command_end","exit_code":0}}),
    ] {
        assert!(
            results(&tracked(&[call("c1"), bad.clone()])).is_empty(),
            "{bad}"
        );
    }
    // A replay, and both representations in either order, show one result.
    let end0 = end("c1", json!({"exit_code":0}));
    assert_eq!(
        results(&tracked(&[call("c1"), end0.clone(), end0.clone()])).len(),
        1
    );
    assert_eq!(
        results(&tracked(&[call("c1"), end0.clone(), output("c1")])).len(),
        1
    );
    assert_eq!(
        results(&tracked(&[call("c1"), output("c1"), end0.clone()])).len(),
        1
    );
    assert_eq!(
        results(&tracked(&[call("c1"), output("c1"), output("c1")])).len(),
        1
    );
    // A new turn forgets the previous turn's calls.
    let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}});
    assert!(results(&tracked(&[call("c1"), turn, end0])).is_empty());
}

#[test]
fn codex_existing_projection_preserved() {
    // The stateless `project` (used by search and the sub-agent view) never turns a finished-command record
    // into a result, so a pair still shows exactly the one `function_call_output` result.
    for record in [
        end("c1", json!({"exit_code":0})),
        command_execution("c1", json!({})),
    ] {
        assert!(project(AgentKind::Codex, &record).is_empty());
    }
    let shown: Vec<_> = [call("c1"), command_execution("c1", json!({})), output("c1")]
        .iter()
        .flat_map(|r| project(AgentKind::Codex, r))
        .filter(|e| e["kind"] == "tool_result")
        .collect();
    assert_eq!(
        shown,
        vec![json!({"kind":"tool_result","tool_id":"c1","output":"receipt","is_error":false})]
    );
    // Outputs of other tools pass the Tracker untouched, even twice.
    let custom = json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"x","output":"ok"}});
    assert_eq!(results(&tracked(&[custom.clone(), custom])).len(), 2);
}

#[test]
fn codex_command_fixtures_match_checked_in_event_lists() {
    for fixture in ["codex-0.161.0-command-execution", "codex-0.161.0-exec-end"] {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat")
            .join(fixture);
        let expected: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(root.join("expected.json")).unwrap()).unwrap();
        let records: Vec<serde_json::Value> =
            std::fs::read_to_string(root.join("transcript.jsonl"))
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect();
        assert_eq!(tracked(&records), expected, "{fixture}");
    }
}

#[test]
fn tracker_state_without_result_ids_loads() {
    let old = json!({"root":"/project","files":["a.rs"]});
    let mut t: Tracker = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&t).unwrap(),
        old,
        "an empty id map is not written"
    );
    let events: Vec<_> = [call("c1"), end("c1", json!({"exit_code":0}))]
        .iter()
        .flat_map(|r| t.project(AgentKind::Codex, r))
        .collect();
    assert_eq!(results(&events).len(), 1);
    let saved: Tracker = serde_json::from_value(serde_json::to_value(&t).unwrap()).unwrap();
    assert_eq!(saved, t, "open call ids survive a save between batches");
}

// Ticket 383: real rollouts written by codex-cli 0.162.1 in its terminal UI against a local mock model.
fn real_rollout(name: &str) -> Vec<serde_json::Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/chat")
        .join(name)
        .join("transcript.jsonl");
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .flat_map(|line| project(AgentKind::Codex, &serde_json::from_str(line).unwrap()))
        .collect()
}
fn said<'a>(events: &'a [serde_json::Value], role: &str) -> Vec<&'a str> {
    events
        .iter()
        .filter(|e| e["kind"] == "message" && e["role"] == role)
        .map(|e| e["text"].as_str().unwrap())
        .collect()
}
fn user_record(block: &str, kinds: serde_json::Value) -> serde_json::Value {
    json!({"type":"response_item","payload":{"type":"message","role":"user",
        "content":[{"type":"input_text","text":block}],
        "internal_chat_message_metadata_passthrough":{"content_item_kinds":kinds}}})
}

/// The fixture is a first turn and then `codex resume`: the chat is the person's words and the replies, in both.
#[test]
fn codex_injected_blocks_stay_out_of_live_and_resumed_chat() {
    let events = real_rollout("codex-0.162.1");
    assert_eq!(said(&events, "user"), ["Say hello please", "And once more"]);
    assert_eq!(said(&events, "assistant").len(), 2, "both replies show");
    assert!(
        events.iter().all(|e| e["kind"] != "skipped"),
        "a normal chat counts no skipped lines: {events:?}"
    );
}

#[test]
fn codex_text_that_only_looks_injected_stays_visible() {
    let block = "<environment_context>\n  <cwd>/project</cwd>\n</environment_context>";
    let agents = "# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>";
    // Codex's label decides: the person pasted a whole block.
    assert_eq!(
        said(
            &project(AgentKind::Codex, &user_record(block, json!(["user.text"]))),
            "user"
        ),
        [block]
    );
    // Without labels the whole block's shape decides.
    for typed in [
        "<environment_context> what is this tag?",
        "why is </environment_context> in my log?",
        "# AGENTS.md instructions for my repo, please summarise them",
    ] {
        assert_eq!(
            said(
                &project(AgentKind::Codex, &user_record(typed, json!(null))),
                "user"
            ),
            [typed]
        );
    }
    for injected in [block, agents] {
        assert!(project(AgentKind::Codex, &user_record(injected, json!(null))).is_empty());
    }
}

/// A label Codex has not used yet must not hide what the person wrote.
#[test]
fn codex_unseen_label_does_not_hide_the_message() {
    let text = "Please fix the login page";
    let events = project(
        AgentKind::Codex,
        &user_record(text, json!(["composer.text"])),
    );
    assert_eq!(said(&events, "user"), [text]);
}

/// A failed model call (here 429 from the mock) finishes the turn with no last message and an error of its own.
#[test]
fn codex_turn_that_ended_without_a_reply_says_so() {
    let events = real_rollout("codex-0.162.1-failed");
    assert_eq!(said(&events, "user"), ["Say hello please"]);
    assert_eq!(
        said(&events, "assistant"),
        ["exceeded retry limit, last status: 429 Too Many Requests"]
    );
    // With no error message the generic line still shows.
    let no_error = project(
        AgentKind::Codex,
        &json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","last_agent_message":null}}),
    );
    assert!(said(&no_error, "assistant")[0].contains("without a reply"));
}

/// Ticket 409: the bookkeeping records a normal Claude or Codex session writes (shapes seen 2026-11-10) are not
/// drawn and not counted, so its header shows no "could not be shown" note.
#[test]
fn chat_bookkeeping_records_are_not_counted() {
    let claude = [
        json!({"type":"attachment","attachment":{"type":"hook_success"}}),
        json!({"type":"api-request","requestId":"r"}),
        json!({"type":"api-request-blob","hash":"h","message":{"content":[{"type":"text","text":"sent"}]}}),
        json!({"type":"ai-title","aiTitle":"t"}),
        json!({"type":"last-prompt","lastPrompt":"p"}),
        json!({"type":"permission-mode","permissionMode":"auto"}),
        json!({"type":"file-history-snapshot","snapshot":{}}),
        json!({"type":"pr-link","url":"u"}),
        json!({"type":"assistant","message":{"content":[{"type":"redacted_thinking","data":"x"}]}}),
    ];
    let codex = [
        json!({"type":"session_meta","payload":{"id":"s"}}),
        json!({"type":"world_state","payload":{}}),
        json!({"type":"inter_agent_communication_metadata","payload":{"author":"/root"}}),
        json!({"type":"response_item","payload":{"type":"agent_message","content":[{"type":"encrypted_content"}]}}),
    ];
    for (kind, record) in claude
        .iter()
        .map(|r| (AgentKind::Claude, r))
        .chain(codex.iter().map(|r| (AgentKind::Codex, r)))
    {
        assert!(project(kind, record).is_empty(), "{record}");
    }
}

/// Look 11-17 N12: "No response requested." (Claude's synthetic filler after resuming an interrupted turn) is not shown;
/// another synthetic message (an API error) still is.
#[test]
fn n12_synthetic_no_response_is_not_shown() {
    let filler = json!({"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"No response requested."}]}});
    assert_eq!(
        project(AgentKind::Claude, &filler),
        Vec::<serde_json::Value>::new()
    );
    let error = json!({"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"API Error: 500"}]}});
    assert_eq!(
        project(AgentKind::Claude, &error)[0]["text"],
        "API Error: 500"
    );
}

/// Look 1117 v10 N10-S2-4: a message the user sent while Claude worked is recorded only as a `queued_command`
/// attachment; it shows as the user's message. A peer's queued message and Claude's own continuation do not.
#[test]
fn n10_a_message_sent_mid_turn_is_the_users() {
    let queued = |origin: &str| json!({"type":"attachment","uuid":"u1","attachment":{"type":"queued_command","prompt":"which fruit (fig, kiwi)","commandMode":"prompt","origin":{"kind":origin},"humanTurn":true}});
    assert_eq!(
        project(AgentKind::Claude, &queued("human")),
        vec![json!({"kind":"message","role":"user","text":"which fruit (fig, kiwi)"})]
    );
    for origin in ["peer", "auto-continuation"] {
        assert!(
            project(AgentKind::Claude, &queued(origin)).is_empty(),
            "{origin}"
        );
    }
}
