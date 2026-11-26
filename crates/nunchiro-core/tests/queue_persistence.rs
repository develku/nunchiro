use nunchiro_core::{api::AgentKind, queue::Queue};
use serde_json::json;
use std::{fs, path::PathBuf};
#[path = "fixtures/aside.rs"]
mod aside;
fn home(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("queue-{name}-{}", std::process::id()));
    fs::create_dir_all(&p).unwrap();
    p
}
#[test]
fn pending_permission_survives_restart_without_replaying_an_answer() {
    let home = home("restart");
    let mut queue = Queue::open(&home).unwrap();
    queue
        .register("session-1", AgentKind::Claude, 1000)
        .unwrap();
    queue
        .observe(
            "session-1",
            "PermissionRequest",
            &json!({"tool_name":"Bash","tool_input":{"command":"touch forbidden"}}),
            "hook",
            1001,
        )
        .unwrap();
    assert_eq!(queue.items().len(), 1);
    drop(queue);
    let queue = Queue::open(&home).unwrap();
    assert_eq!(queue.items().len(), 1);
    assert!(queue.items()[0].reconciled);
    assert!(!queue.items()[0].actionable);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn malformed_queue_is_left_untouched() {
    let home = home("broken");
    for bytes in [
        "[]",
        r#"{"version":"1","sessions":{},"seen":{}}"#,
        r#"{"version":1,"sessions":{"bad/id":{"kind":"claude","attention":{},"items":[]}},"seen":{}}"#,
    ] {
        fs::write(home.join("queue.json"), bytes).unwrap();
        assert!(Queue::open(&home).is_err());
        assert_eq!(fs::read_to_string(home.join("queue.json")).unwrap(), bytes);
    }
    // v1b-40: a well-formed queue of another version is not malformed: it is kept aside and the queue starts empty.
    // V2-1a: this core reads 1 and 2, so 3 is the newer core's.
    let bytes = r#"{"version":3,"sessions":{},"seen":{}}"#;
    fs::write(home.join("queue.json"), bytes).unwrap();
    assert!(Queue::open(&home).unwrap().items().is_empty());
    let kept = aside::asides(&home);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].1, bytes.as_bytes());
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn background_stop_and_duplicate_sources_finish_once() {
    let home = home("turn");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe("s", "UserPromptSubmit", &json!({}), "hook", 1)
        .unwrap();
    q.observe(
        "s",
        "Stop",
        &json!({"background_tasks":[{"status":"running"}]}),
        "hook",
        2,
    )
    .unwrap();
    assert_eq!(q.attention("s").completion_seq, 0);
    assert_eq!(q.items()[0].kind, nunchiro_core::queue::Kind::Background);
    // N12-S2-4: a background note is no ask: the session still works and does not wait ("needs you").
    assert!(q.attention("s").working && !q.attention("s").waiting);
    q.observe(
        "s",
        "SubagentStop",
        &json!({"agent_id":"worker"}),
        "hook",
        3,
    )
    .unwrap();
    q.observe("s", "Stop", &json!({}), "transcript", 4).unwrap();
    assert_eq!(q.attention("s").completion_seq, 1);
    assert!(q.items().is_empty());
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn stale_threshold_uses_latest_activity_and_excludes_waiting() {
    let home = home("stale");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 100).unwrap();
    let live = std::collections::BTreeSet::from(["s".to_string()]);
    // B14 (ticket 991): idle at its prompt (no turn running) is never stale, however long it is quiet.
    q.tick(1_000_000, 1100, &live).unwrap();
    assert!(!q.attention("s").stale);
    q.observe("s", "UserPromptSubmit", &json!({}), "hook", 1_000_000)
        .unwrap();
    q.tick(1_001_099, 1100, &live).unwrap();
    assert!(!q.attention("s").stale);
    q.tick(1_001_100, 1100, &live).unwrap();
    assert!(q.attention("s").stale);
    q.activity("s", 1_001_101).unwrap();
    assert!(!q.attention("s").stale);
    q.observe("s", "PermissionRequest", &json!({}), "hook", 1_001_102)
        .unwrap();
    q.tick(9_000_000, 1100, &live).unwrap();
    assert!(!q.attention("s").stale);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn late_permission_cannot_reopen_a_finished_turn() {
    let home = home("late");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "UserPromptSubmit",
        &json!({"prompt_id":"p"}),
        "hook",
        100,
    )
    .unwrap();
    q.observe("s", "Stop", &json!({}), "hook", 200).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Bash"}),
        "hook",
        150,
    )
    .unwrap();
    assert!(
        q.items().is_empty(),
        "late evidence reopened a finished turn"
    );
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn subagent_screen_merges_with_its_hook_without_a_duplicate_main_item() {
    let home = home("submerge");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        // v1b-12: a real payload carries the tool input, and the screen shows that request (rule, command, prompt);
        // a frame that does not show the hook's request no longer merges into it (security review, round 4).
        &json!({"agent_id":"worker","tool_name":"Bash","tool_input":{"command":"touch done"}}),
        "hook",
        100,
    )
    .unwrap();
    q.screen(
        "s",
        nunchiro_core::queue::Kind::Permission,
        format!(
            "{}\n Bash command\n{dash}\n touch done\n{dash}\n Do you want to proceed?",
            "\u{2500}".repeat(40),
            dash = "\u{254c}".repeat(40)
        ),
        vec![nunchiro_core::queue::Choice {
            label: "Yes".into(),
            keys: vec!["1".into(), "enter".into()],
            changes_settings: false,
        }],
        101,
    )
    .unwrap();
    assert_eq!(q.items().len(), 1);
    assert_eq!(q.items()[0].sources.len(), 2);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn lifted_orca_payloads_without_tool_use_id_detect_both_permissions() {
    let home = home("orca");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let data = include_str!("fixtures/orca/claude-permission-approve-deny-hooks.jsonl");
    let mut permissions = 0;
    for line in data.lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let p = &v["payload"];
        let Some(event) = p["hook_event_name"].as_str() else {
            continue;
        };
        q.observe(
            "s",
            event,
            p,
            "hook",
            (v["t"].as_f64().unwrap() * 1000.0) as u64,
        )
        .unwrap();
        if event == "PermissionRequest" {
            permissions += 1;
            assert!(p.get("tool_use_id").is_none());
            assert_eq!(q.items().len(), 1);
        }
    }
    assert_eq!(permissions, 2);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn transcript_completion_preserves_background_work_before_hook_stop() {
    let home = home("bg-source-race");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.transcript("s","file".into(),100,&[
        json!({"type":"user","uuid":"prompt-1","message":{"content":"start"}}),
        json!({"type":"user","toolUseResult":{"backgroundTaskId":"task-1"},"message":{"content":[{"type":"tool_result"}]}}),
        json!({"type":"assistant","message":{"stop_reason":"end_turn"}})
    ],100).unwrap();
    assert_eq!(
        q.attention("s").completion_seq,
        0,
        "transcript finished while background work remained"
    );
    assert_eq!(q.attention("s").background, 1);
    q.observe(
        "s",
        "Stop",
        &json!({"background_tasks":[{"id":"task-1","status":"running"}]}),
        "hook",
        101,
    )
    .unwrap();
    q.observe(
        "s",
        "TaskCompleted",
        &json!({"task_id":"task-1"}),
        "hook",
        102,
    )
    .unwrap();
    assert_eq!(q.attention("s").completion_seq, 1);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn broken_item_session_relation_preserves_store_bytes() {
    let home = home("relation");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe("s", "PermissionRequest", &json!({}), "hook", 1)
        .unwrap();
    drop(q);
    let path = home.join("queue.json");
    let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    v["sessions"]["s"]["items"][0]["session_id"] = json!("other");
    let bytes = serde_json::to_vec(&v).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(matches!(Queue::open(&home),Err(e) if e.contains("relationship")));
    assert_eq!(fs::read(path).unwrap(), bytes);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn delayed_completion_of_old_turn_cannot_finish_the_new_turn() {
    let home = home("turn-id");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Codex, 0).unwrap();
    q.observe(
        "s",
        "UserPromptSubmit",
        &json!({"turn_id":"old"}),
        "hook",
        1,
    )
    .unwrap();
    q.observe("s", "Stop", &json!({"turn_id":"old"}), "hook", 2)
        .unwrap();
    q.observe(
        "s",
        "UserPromptSubmit",
        &json!({"turn_id":"new"}),
        "hook",
        3,
    )
    .unwrap();
    q.transcript(
        "s",
        "file".into(),
        50,
        &[json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"old"}})],
        4,
    )
    .unwrap();
    assert!(q.attention("s").working);
    assert_eq!(q.attention("s").completion_seq, 1);
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn replacing_a_screen_prompt_invalidates_the_old_decision_identity() {
    let home = home("replace-screen");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.screen(
        "s",
        nunchiro_core::queue::Kind::Permission,
        "Approve command A?".into(),
        vec![],
        1,
    )
    .unwrap();
    let old = q.items()[0].id.clone();
    q.screen(
        "s",
        nunchiro_core::queue::Kind::Permission,
        "Approve command B?".into(),
        vec![],
        2,
    )
    .unwrap();
    assert!(q.decision(&old).is_err());
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn explicit_resume_copies_pending_evidence_without_approval_authority() {
    let home = home("resume");
    let mut q = Queue::open(&home).unwrap();
    q.register("old", AgentKind::Claude, 0).unwrap();
    q.observe(
        "old",
        "UserPromptSubmit",
        &json!({"prompt_id":"p"}),
        "hook",
        1,
    )
    .unwrap();
    q.observe("old", "Stop", &json!({}), "hook", 2).unwrap();
    q.observe(
        "old",
        "PermissionRequest",
        &json!({"tool_name":"Bash","nunchiro_event_id":"old-hook"}),
        "hook",
        3,
    )
    .unwrap();
    let old = q.items()[0].id.clone();
    q.observer_error("old", Some("old process error".into()))
        .unwrap();
    q.close("old", true).unwrap();
    q.prepare_resume("old", "new").unwrap();
    let pending = q
        .items()
        .into_iter()
        .find(|i| i.session_id == "new")
        .unwrap();
    assert!(!pending.actionable);
    assert!(pending.reconciled);
    assert_ne!(pending.id, old);
    assert!(pending.hook_event_id.is_none());
    assert_eq!(q.attention("new").completion_seq, 1);
    assert!(!q.attention("new").failed);
    assert!(q.attention("new").observer_error.is_none());
    // The old mapping remains durable until session metadata commits; a failed resume cannot lose it.
    assert!(q.items().iter().any(|i| i.session_id == "old"));
    drop(q);
    let mut q = Queue::open(&home).unwrap();
    assert_eq!(q.items().len(), 2);
    q.screen(
        "new",
        nunchiro_core::queue::Kind::Permission,
        "Allow DIFFERENT command?".into(),
        vec![],
        4,
    )
    .unwrap();
    assert!(q.decision(&pending.id).is_err());
    let fresh = q
        .items()
        .into_iter()
        .find(|i| i.session_id == "new")
        .unwrap();
    assert!(fresh.actionable);
    assert_eq!(fresh.text, "Allow DIFFERENT command?");
    q.prepare_resume("old", "hook-resume").unwrap();
    let restored = q
        .items()
        .into_iter()
        .find(|i| i.session_id == "hook-resume")
        .unwrap();
    q.observe(
        "hook-resume",
        "PermissionRequest",
        &json!({"tool_name":"Bash","nunchiro_event_id":"fresh-hook"}),
        "hook",
        5,
    )
    .unwrap();
    assert!(q.decision(&restored.id).is_err());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn streaming_activity_and_unchanged_ticks_do_not_rewrite_the_store() {
    use std::{collections::BTreeSet, os::unix::fs::MetadataExt};
    let home = home("activity-write");
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let inode = fs::metadata(home.join("queue.json")).unwrap().ino();
    for now in 1..100 {
        q.activity("s", now).unwrap();
        q.tick(now, 20_000, &BTreeSet::from(["s".into()])).unwrap();
    }
    assert_eq!(
        fs::metadata(home.join("queue.json")).unwrap().ino(),
        inode,
        "activity fsync on every chunk"
    );
    assert_eq!(q.attention("s").last_activity, 99);
    q.activity("s", 1000).unwrap();
    assert_ne!(fs::metadata(home.join("queue.json")).unwrap().ino(), inode);
    assert!(q.activity("missing", 1001).is_err());
    fs::remove_dir_all(home).unwrap();
}

// v1b-12: Claude Code 2.1.310 draws an edit prompt in ~9 screen frames (two of them read as a dialog mid-draw).
// Frames are the detected screens of a real run (fixtures/claude-edit-prompt, user paths scrubbed).
fn edit_prompt_frames() -> Vec<(
    nunchiro_core::queue::Kind,
    String,
    Vec<nunchiro_core::queue::Choice>,
)> {
    use nunchiro_core::waiting::screen::Screen;
    let raw = include_str!("fixtures/claude-edit-prompt/2.1.310-frames.txt");
    raw.split("=== ")
        .filter(|f| !f.is_empty())
        .filter_map(|f| {
            let (label, text) = f.split_once('\n').unwrap();
            let mut screen = Screen::new(160, 50);
            screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
            let Some(d) = screen.detect(AgentKind::Claude) else {
                // The first frame shows the prompt line before any choice or hint: not yet a prompt (round 4).
                assert!(
                    !text.contains("1. Yes"),
                    "a frame with choices went undetected"
                );
                return None;
            };
            assert_eq!(
                format!("{:?}", d.kind),
                label.trim(),
                "fixture frame re-detects as recorded"
            );
            Some((d.kind, d.text, d.choices))
        })
        .collect()
}
const EDIT_INPUT: &str = r#"{"file_path":"/private/tmp/project/a.txt","new_string":"edited by agent","old_string":"original line","replace_all":false}"#;
/// `live`: a window holds the queue lease, so the hook is still waiting for an answer (as in a real run).
fn edit_hook(q: &mut Queue, event: &str, live: bool) {
    if live {
        q.connect(0);
        assert!(q.begin_hook(event, 50));
    }
    let input: serde_json::Value = serde_json::from_str(EDIT_INPUT).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Edit","tool_input":input,"nunchiro_event_id":event}),
        "hook",
        50,
    )
    .unwrap();
}

#[test]
fn hook_permission_keeps_id_kind_and_tool_input_through_progressive_screen_frames() {
    use nunchiro_core::queue::Kind;
    let frames = edit_prompt_frames();
    assert_eq!(frames.iter().filter(|f| f.0 == Kind::Dialog).count(), 2);
    let input: serde_json::Value = serde_json::from_str(EDIT_INPUT).unwrap();
    // Hook first, then every frame.
    let dir = home("edit-frames-hook-first");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    edit_hook(&mut q, "e1", true);
    let id = q.items()[0].id.clone();
    for (n, (kind, text, choices)) in frames.iter().enumerate() {
        q.screen(
            "s",
            kind.clone(),
            text.clone(),
            choices.clone(),
            100 + n as u64,
        )
        .unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1, "frame {n}");
        assert_eq!(items[0].id, id, "frame {n} replaced the hook item");
        assert_eq!(items[0].kind, Kind::Permission, "frame {n}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&items[0].text).unwrap(),
            input,
            "frame {n}"
        );
        assert!(items[0].sources.contains("hook"));
    }
    // The settled prompt (its own request) is recorded for a late (screen) answer; mid-draw frames were not.
    assert!(q.items()[0].sources.contains("screen"));
    assert_eq!(q.items()[0].choices.len(), 3);
    assert_eq!(
        q.items()[0].screen_text.as_deref(),
        Some(frames.last().unwrap().1.as_str())
    );
    fs::remove_dir_all(&dir).unwrap();
    // Frames first: the screen-only item behaves as today until the hook lands mid-draw; from then on it holds.
    let dir = home("edit-frames-hook-mid");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    for (n, (kind, text, choices)) in frames[..3].iter().enumerate() {
        q.screen(
            "s",
            kind.clone(),
            text.clone(),
            choices.clone(),
            10 + n as u64,
        )
        .unwrap();
    }
    edit_hook(&mut q, "e2", true);
    let id = q.items()[0].id.clone();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&q.items()[0].text).unwrap(),
        input
    );
    for (n, (kind, text, choices)) in frames[3..].iter().enumerate() {
        q.screen(
            "s",
            kind.clone(),
            text.clone(),
            choices.clone(),
            100 + n as u64,
        )
        .unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id, "frame {} replaced the hook item", n + 3);
        assert_eq!(items[0].kind, Kind::Permission);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&items[0].text).unwrap(),
            input
        );
    }
    // A new hook event is a new prompt: it still takes a new identity.
    edit_hook(&mut q, "e3", true);
    assert_ne!(q.items()[0].id, id);
    // v1b-30: with e2 still pending too, the screen is not proven to show e3's request; once the tool resolves, a
    // new hook takes its prompt again.
    let last = frames.last().unwrap();
    q.screen("s", last.0.clone(), last.1.clone(), last.2.clone(), 150)
        .unwrap();
    assert!(q.items()[0].screen_text.is_none());
    q.observe("s", "PostToolUse", &json!({}), "hook", 50)
        .unwrap();
    edit_hook(&mut q, "e4", true);
    q.screen("s", last.0.clone(), last.1.clone(), last.2.clone(), 170)
        .unwrap();
    assert!(q.items()[0].sources.contains("hook") && q.items()[0].screen_text.is_some());
    // The prompt leaving the screen still clears the item once the screen has shown it.
    q.screen("s", last.0.clone(), last.1.clone(), last.2.clone(), 200)
        .unwrap();
    q.clear_screen("s").unwrap();
    assert!(q.items().is_empty());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn screen_frames_never_change_a_hook_question_and_a_screen_only_dialog_stays_a_dialog() {
    use nunchiro_core::queue::Kind;
    let frames = edit_prompt_frames();
    let dir = home("edit-frames-question");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.connect(0);
    assert!(q.begin_hook("q1", 5));
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"AskUserQuestion","tool_input":{"question":"red or blue?"},"nunchiro_event_id":"q1"}),
        "hook",
        5,
    )
    .unwrap();
    let id = q.items()[0].id.clone();
    let last = frames.last().unwrap();
    q.screen("s", last.0.clone(), last.1.clone(), last.2.clone(), 6)
        .unwrap();
    // No upgrade: a permission frame never turns a hook question into a permission.
    assert_eq!(
        (q.items()[0].id.clone(), q.items()[0].kind.clone()),
        (id, Kind::Question)
    );
    fs::remove_dir_all(&dir).unwrap();
    // A dialog on screen with no hook is a dialog, and screen-only items keep today's replace-on-change.
    let dir = home("edit-frames-dialog");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let dialog = frames.iter().find(|f| f.0 == Kind::Dialog).unwrap();
    q.screen("s", Kind::Dialog, dialog.1.clone(), dialog.2.clone(), 7)
        .unwrap();
    assert_eq!(q.items()[0].kind, Kind::Dialog);
    let old = q.items()[0].id.clone();
    q.screen("s", last.0.clone(), last.1.clone(), last.2.clone(), 8)
        .unwrap();
    assert_ne!(q.items()[0].id, old);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_different_prompt_never_becomes_what_a_held_hook_item_answers_and_restored_items_reset() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    let frames = edit_prompt_frames();
    let own = frames.last().unwrap().clone();
    let frame = |text: &str| {
        let mut screen = Screen::new(160, 50);
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).unwrap();
        (d.kind, d.text, d.choices)
    };
    // Security review probe: a Bash prompt for `rm -rf ~/important`, with "Read a.txt" in the scrollback above it.
    let rule = "─".repeat(80);
    let bash = frame(&format!(
        "❯ Read a.txt, then edit it\n\n  Read 1 file\n\n⏺ Bash(rm -rf ~/important)\n\n{rule}\n Bash command\n\n   rm -rf ~/important\n   Remove the folder\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm commands in /private/tmp/project\n   3. No\n\n Esc to cancel · Tab to amend"
    ));
    assert_eq!(bash.0, Kind::Permission);
    // Same file, different content.
    let other_edit = frame(&own.1.replace("edited by agent", "deleted everything"));
    // The whole edit prompt scrolled up above a new Bash prompt: only the region below the last rule counts.
    let bash_body = bash.1.rsplit_once(&rule).unwrap().1;
    let scrolled_up = frame(&format!(
        "{rule}\n Edit file\n a.txt\n 1 -original line\n 1 +edited by agent\n Do you want to make this edit to a.txt?\n 1. Yes\n 2. No\n Esc to cancel\n\n{rule}{bash_body}"
    ));
    // Ticket 991 B3: a Claude decision's text is the region below its last rule, so A's prompt above is not in it.
    assert!(
        !scrolled_up.1.contains("1 +edited by agent")
            && !scrolled_up.1.contains("make this edit to a.txt?"),
        "only the Bash prompt is the decision's text"
    );
    assert_eq!(scrolled_up.0, Kind::Permission);
    for (name, swap) in [
        ("bash", &bash),
        ("same file, other content", &other_edit),
        ("edit prompt in scrollback", &scrolled_up),
    ] {
        // Hook no longer live (most answers come after its 1.4 s window): the other prompt ends the item.
        let dir = home("edit-other-prompt");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        edit_hook(&mut q, "e1", false);
        q.screen("s", own.0.clone(), own.1.clone(), own.2.clone(), 60)
            .unwrap();
        let held = q.items()[0].clone();
        assert_eq!(
            held.screen_text.as_deref(),
            Some(own.1.as_str()),
            "{name}: own frame absorbed"
        );
        q.screen("s", swap.0.clone(), swap.1.clone(), swap.2.clone(), 61)
            .unwrap();
        assert!(
            q.decision(&held.id).is_err(),
            "{name}: the held item survived another prompt"
        );
        let now = q.items()[0].clone();
        assert!(
            !now.sources.contains("hook") && now.text != held.text,
            "{name}"
        );
        fs::remove_dir_all(&dir).unwrap();
        // Hook no longer live and its own prompt never shown: the first frame is another prompt, which still ends it.
        let dir = home("edit-other-prompt-first");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        edit_hook(&mut q, "e1", false);
        let held = q.items()[0].clone();
        q.screen("s", swap.0.clone(), swap.1.clone(), swap.2.clone(), 61)
            .unwrap();
        assert!(
            q.decision(&held.id).is_err(),
            "{name}: first foreign frame merged into the hook item"
        );
        fs::remove_dir_all(&dir).unwrap();
        // Hook still live: the frame is ignored; the hook answers for its own request and the screen text stays its own.
        let dir = home("edit-other-prompt-live");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        edit_hook(&mut q, "e1", true);
        q.screen("s", own.0.clone(), own.1.clone(), own.2.clone(), 60)
            .unwrap();
        let held = q.items()[0].clone();
        q.screen("s", swap.0.clone(), swap.1.clone(), swap.2.clone(), 61)
            .unwrap();
        let now = q.items()[0].clone();
        assert_eq!(
            (now.id.clone(), now.text.clone()),
            (held.id.clone(), held.text.clone()),
            "{name}"
        );
        assert_eq!(
            now.screen_text, held.screen_text,
            "{name}: a live hook item took another prompt's screen"
        );
        assert_eq!(now.choices, held.choices, "{name}");
        fs::remove_dir_all(&dir).unwrap();
    }
    // Own frame with changed scrollback above the prompt: still its own request.
    let dir = home("edit-own-scrollback");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    edit_hook(&mut q, "e1", false);
    q.screen("s", own.0.clone(), own.1.clone(), own.2.clone(), 60)
        .unwrap();
    let held = q.items()[0].clone();
    let scrolled = frame(&own.1.replacen("Read 1 file", "Read 2 files", 1));
    q.screen(
        "s",
        scrolled.0.clone(),
        scrolled.1.clone(),
        scrolled.2.clone(),
        62,
    )
    .unwrap();
    assert_eq!(q.items()[0].id, held.id);
    assert_eq!(
        q.items()[0].screen_text.as_deref(),
        Some(scrolled.1.as_str())
    );
    drop(q);
    // A restored (reconciled) hook item is not held: a screen frame replaces it as before.
    let mut q = Queue::open(&dir).unwrap();
    let restored = q.items()[0].clone();
    assert!(restored.reconciled);
    q.screen("s", own.0.clone(), own.1.clone(), own.2.clone(), 70)
        .unwrap();
    assert_ne!(q.items()[0].id, restored.id);
    assert!(!q.items()[0].sources.contains("hook"));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn allow_once_rule_matches_the_shared_label_cases() {
    // v1b-12: web/tests/chat-diff-card-model.spec.ts checks the window's cardPlan against the same file.
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/allow-once-labels.json")).unwrap();
    for c in cases {
        let choice = nunchiro_core::queue::Choice {
            label: c["label"].as_str().unwrap().into(),
            keys: vec!["1".into()],
            changes_settings: c["changes_settings"].as_bool().unwrap(),
        };
        assert_eq!(
            choice.allows_once(),
            c["allows_once"].as_bool().unwrap(),
            "{}",
            choice.label
        );
    }
}

#[test]
fn a_bash_hook_item_takes_its_own_real_prompt_frame_for_late_answers() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    // v1b-12: Claude Code 2.1.310's Bash prompt (V1A-08 real row C1, 2026-10-24), user path scrubbed.
    let rule = "\u{2500}".repeat(149);
    let dash = "\u{254c}".repeat(149);
    let text = format!(
        "\u{23fa} Bash(touch done-50250eb4 && ls -l done-50250eb4)\r\n  \u{23bf}  Waiting\u{2026}\r\n\r\n{rule}\r\n Bash command\r\n Tip: auto mode handles these prompts for you \u{2014} choose \"switch to auto mode\" below\r\n Create the done-50250eb4 file in the working directory\r\n{dash}\r\n touch done-50250eb4 && ls -l done-50250eb4\r\n{dash}\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. Yes, and always allow access to /private/tmp/project from this project\r\n   3. Yes, and switch to auto mode \u{b7} auto mode handles these prompts for you\r\n   4. No\r\n\r\n Esc to cancel \u{b7} Tab to amend"
    );
    let mut screen = Screen::new(160, 50);
    screen.feed(format!("\x1b[2J\x1b[H{text}").as_bytes());
    let d = screen.detect(AgentKind::Claude).unwrap();
    assert_eq!(d.kind, Kind::Permission);
    let dir = home("bash-own-frame");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Bash","tool_input":{"command":"touch done-50250eb4 && ls -l done-50250eb4","description":"Create the done-50250eb4 file in the working directory"},"nunchiro_event_id":"b1"}),
        "hook",
        10,
    )
    .unwrap();
    let id = q.items()[0].id.clone();
    q.screen("s", d.kind.clone(), d.text.clone(), d.choices.clone(), 20)
        .unwrap();
    let item = q.items()[0].clone();
    assert_eq!(item.id, id);
    assert_eq!(item.screen_text.as_deref(), Some(d.text.as_str()));
    // Only "1. Yes" allows once; "always allow" and "switch to auto mode" change settings.
    assert_eq!(item.choices.iter().filter(|c| c.allows_once()).count(), 1);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_hook_landing_on_another_prompt_never_inherits_its_screen_and_bodies_must_match_whole_lines() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    let frame = |text: &str| {
        let mut screen = Screen::new(160, 50);
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).unwrap();
        (d.kind, d.text, d.choices)
    };
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let bash = |cmd: &str| {
        frame(&format!(
            "{rule}\n Bash command\n{dash}\n {cmd}\n{dash}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
        ))
    };
    let hook = |q: &mut Queue, input: serde_json::Value, tool: &str| {
        q.observe(
            "s",
            "PermissionRequest",
            &json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":"h1"}),
            "hook",
            50,
        )
        .unwrap();
    };
    // Review MUST: a Bash rm prompt is on screen (screen-only item); the Edit hook lands on it.
    let dir = home("hook-on-foreign");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let rm = bash("rm -rf ~/x");
    q.screen("s", rm.0.clone(), rm.1.clone(), rm.2.clone(), 10)
        .unwrap();
    let foreign = q.items()[0].id.clone();
    hook(&mut q, serde_json::from_str(EDIT_INPUT).unwrap(), "Edit");
    let item = q.items()[0].clone();
    assert_ne!(
        item.id, foreign,
        "the Edit request kept the rm prompt's identity"
    );
    assert_eq!(
        item.screen_text, None,
        "the Edit request inherited the rm prompt's screen"
    );
    assert!(item.choices.is_empty());
    fs::remove_dir_all(&dir).unwrap();
    // A hook landing on its own already-drawn prompt keeps it (screen first, then hook).
    let dir = home("hook-on-own");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let touch = bash("touch done");
    q.screen("s", touch.0.clone(), touch.1.clone(), touch.2.clone(), 10)
        .unwrap();
    hook(&mut q, json!({"command":"touch done"}), "Bash");
    assert_eq!(q.items()[0].screen_text.as_deref(), Some(touch.1.as_str()));
    fs::remove_dir_all(&dir).unwrap();
    // Whole lines: `git push origin main` is not `git push origin main --force`.
    for (want, shown) in [
        (
            json!({"command":"git push origin main"}),
            bash("git push origin main --force"),
        ),
        (
            json!({"command":"git push origin main"}),
            bash("echo git push origin main"),
        ),
    ] {
        let dir = home("hook-whole-line");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        hook(&mut q, want.clone(), "Bash");
        let id = q.items()[0].id.clone();
        q.screen("s", shown.0.clone(), shown.1.clone(), shown.2.clone(), 60)
            .unwrap();
        assert!(
            q.decision(&id).is_err(),
            "{want} absorbed {:?}",
            shown.1.lines().find(|l| l.contains("git"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }
    // Same first line, different later line of the new text: not this request.
    let input = json!({"file_path":"/private/tmp/project/a.txt","old_string":"a","new_string":"keep\nsafe\n"});
    let shown = frame(&format!(
        "{rule}\n Edit file\n a.txt\n{dash}\n 1 -a\n 1 +keep\n 2 +rm -rf /\n{dash}\n Do you want to make this edit to a.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
    ));
    assert_eq!(shown.0, Kind::Permission);
    let dir = home("hook-later-line");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    hook(&mut q, input, "Edit");
    let id = q.items()[0].id.clone();
    q.screen("s", shown.0.clone(), shown.1.clone(), shown.2.clone(), 60)
        .unwrap();
    assert!(
        q.decision(&id).is_err(),
        "a different later line was absorbed"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_held_hook_item_needs_its_whole_body_in_order_on_screen() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    // v1b-12 round 5 (security review SHOULD): bodies compare whole, in order, every edit of a multi-edit.
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let edit_frame = |diff: &str| {
        let mut screen = Screen::new(160, 50);
        let text = format!(
            "{rule}\n Edit file\n a.txt\n{dash}\n{diff}\n{dash}\n Do you want to make this edit to a.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
        );
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).unwrap();
        assert_eq!(d.kind, Kind::Permission);
        (d.kind, d.text, d.choices)
    };
    // Hook (not live) for `input`, then `frame`: whether the item kept its identity (absorbed the frame).
    let absorbed = |input: serde_json::Value,
                    frame: (Kind, String, Vec<nunchiro_core::queue::Choice>)| {
        let dir = home("whole-body");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        q.observe(
            "s",
            "PermissionRequest",
            &json!({"tool_name":"Edit","tool_input":input,"nunchiro_event_id":"w1"}),
            "hook",
            50,
        )
        .unwrap();
        let id = q.items()[0].id.clone();
        q.screen("s", frame.0, frame.1.clone(), frame.2, 60)
            .unwrap();
        let kept = q
            .decision(&id)
            .ok()
            .map(|d| d.screen_text == Some(frame.1.clone()));
        fs::remove_dir_all(&dir).unwrap();
        kept == Some(true)
    };
    let four = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"l1\nl2\nl3\nl4\n"});
    // Its own frame (all four lines, in order) is absorbed.
    assert!(absorbed(
        four.clone(),
        edit_frame(" 1 -x\n 1 +l1\n 2 +l2\n 3 +l3\n 4 +l4")
    ));
    // Same first three lines, differs from line 4 on: not absorbed (the item ends).
    assert!(!absorbed(
        four.clone(),
        edit_frame(" 1 -x\n 1 +l1\n 2 +l2\n 3 +l3\n 4 +rm -rf /")
    ));
    // Reordered lines.
    assert!(!absorbed(
        four.clone(),
        edit_frame(" 1 -x\n 1 +l2\n 2 +l1\n 3 +l3\n 4 +l4")
    ));
    // A line slipped in between.
    assert!(!absorbed(
        four.clone(),
        edit_frame(" 1 -x\n 1 +l1\n 2 +evil\n 3 +l2\n 4 +l3\n 5 +l4")
    ));
    // The new lines shown only as deletions.
    assert!(!absorbed(
        four.clone(),
        edit_frame(" 1 -l1\n 2 -l2\n 3 -l3\n 4 -l4\n 1 +x")
    ));
    // A body the region cannot show whole (the agent truncated it): fail closed.
    assert!(!absorbed(
        four.clone(),
        edit_frame(" 1 -x\n 1 +l1\n 2 +l2\n …")
    ));
    // Lines both texts share show once, unmarked, as context: still its own frame.
    let shared = json!({"file_path":"/p/a.txt","old_string":"a\nb\nc","new_string":"a\nX\nc"});
    assert!(absorbed(
        shared.clone(),
        edit_frame(" 1  a\n 2 -b\n 2 +X\n 3  c")
    ));
    assert!(!absorbed(shared, edit_frame(" 1  a\n 2 -b\n 2 +Y\n 3  c")));
    // Multi-edit: every edit, in order.
    let multi = json!({"file_path":"/p/a.txt","edits":[{"old_string":"a","new_string":"a1\na2"},{"old_string":"b","new_string":"b1"}]});
    assert!(absorbed(
        multi.clone(),
        edit_frame(" 1 -a\n 1 +a1\n 2 +a2\n 7 -b\n 8 +b1")
    ));
    assert!(!absorbed(
        multi.clone(),
        edit_frame(" 1 -a\n 1 +a1\n 2 +a2\n 7 -b\n 8 +b2")
    ));
    assert!(!absorbed(
        multi,
        edit_frame(" 7 -b\n 8 +b1\n 1 -a\n 1 +a1\n 2 +a2")
    ));
}

#[test]
fn a_held_hook_item_needs_exactly_its_body_in_the_diff_block_and_never_panics() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    // v1b-12 round 5 preflight: the body fills the block between the dashed rules exactly; nothing else changes there.
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let frame = |head: &str, body: &str, prompt: &str| {
        let mut screen = Screen::new(160, 50);
        let text = format!(
            "{rule}\n {head}\n{dash}\n{body}\n{dash}\n {prompt}\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
        );
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).unwrap();
        assert_eq!(d.kind, Kind::Permission);
        (d.kind, d.text, d.choices)
    };
    let edit = |body: &str| {
        frame(
            "Edit file\n a.txt",
            body,
            "Do you want to make this edit to a.txt?",
        )
    };
    let bash = |head: &str, body: &str| frame(head, body, "Do you want to proceed?");
    let absorbed = |tool: &str,
                    input: serde_json::Value,
                    f: (Kind, String, Vec<nunchiro_core::queue::Choice>)| {
        let dir = home("exact-body");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        q.observe(
            "s",
            "PermissionRequest",
            &json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":"x1"}),
            "hook",
            50,
        )
        .unwrap();
        let id = q.items()[0].id.clone();
        q.screen("s", f.0, f.1.clone(), f.2, 60).unwrap();
        let kept = q
            .decision(&id)
            .ok()
            .map(|d| d.screen_text == Some(f.1.clone()));
        fs::remove_dir_all(&dir).unwrap();
        kept == Some(true)
    };
    let ab = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a\nb"});
    assert!(absorbed("Edit", ab.clone(), edit(" 1 -x\n 1 +a\n 2 +b")));
    // Ticket 991 B3: Claude 2.1.325 draws unchanged file context around the edit; context rows outside it are fine
    // (fold markers and other text without the gutter still fail, below), a changed row outside it is not.
    assert!(absorbed(
        "Edit",
        ab.clone(),
        edit(" 4  above\n 5 -x\n 5 +a\n 6 +b\n 7  below")
    ));
    assert!(!absorbed(
        "Edit",
        ab.clone(),
        edit(" 4 +above\n 5 -x\n 5 +a\n 6 +b\n 7  below")
    ));
    // Our body as a sub-run of a longer foreign change.
    assert!(!absorbed(
        "Edit",
        ab.clone(),
        edit(" 1 -x\n 1 +a\n 2 +b\n 3 +rm -rf x")
    ));
    // Another change elsewhere in the block.
    assert!(!absorbed(
        "Edit",
        ab.clone(),
        edit(" 1 -x\n 1 +a\n 2 +b\n 9 -keep\n 9 +evil")
    ));
    // A pure deletion never matches a replacement; a pure insertion never matches our lines shown only as context.
    let del = json!({"file_path":"/p/a.txt","old_string":"secret","new_string":""});
    assert!(absorbed("Edit", del.clone(), edit(" 3 -secret")));
    assert!(!absorbed("Edit", del, edit(" 3 -secret\n 3 +evil")));
    let ins = json!({"file_path":"/p/a.txt","old_string":"","new_string":"l1\nl2"});
    assert!(!absorbed(
        "Edit",
        ins,
        edit(" 1  l1\n 2  l2\n 3 -keep\n 3 +evil")
    ));
    // Case and the body's own text count: ./Build is not ./build.
    assert!(!absorbed(
        "Bash",
        json!({"command":"rm -rf ./Build"}),
        bash("Bash command", " rm -rf ./build")
    ));
    // Bash: the command fills the block; a description equal to our command is not the command.
    assert!(absorbed(
        "Bash",
        json!({"command":"ls"}),
        bash("Bash command", " ls")
    ));
    assert!(!absorbed(
        "Bash",
        json!({"command":"ls"}),
        bash("Bash command", " ls\n rm -rf /")
    ));
    assert!(!absorbed(
        "Bash",
        json!({"command":"ls"}),
        bash("Bash command\n ls", " rm -rf /")
    ));
    // Claude indents the command by one column; a command shifted further is another command (heredocs, python -c).
    // v1b-30: a multi-line command is never proven, even shown at the right indent.
    let py = json!({"command":"python -c \"\n  x\""});
    assert!(!absorbed(
        "Bash",
        py.clone(),
        bash("Bash command", " python -c \"\n   x\"")
    ));
    assert!(!absorbed(
        "Bash",
        py,
        bash("Bash command", "     python -c \"\n       x\"")
    ));
    // A body longer than the region can show: no panic, not absorbed.
    let long: String = (1..=60).map(|n| format!("line {n}\n")).collect();
    assert!(!absorbed(
        "Edit",
        json!({"file_path":"/p/a.txt","old_string":"x","new_string":long}),
        edit(" 1 -x\n 1 +line 1\n …")
    ));
    let long_cmd: String = (1..=60).map(|n| format!("echo {n}\n")).collect();
    assert!(!absorbed(
        "Bash",
        json!({"command":long_cmd}),
        bash("Bash command", " echo 1")
    ));
}

#[test]
fn b3_claude_2_1_325_edit_prompt_with_file_context_keeps_its_hook_request() {
    // Ticket 991 B3: the real 2.1.325 frame of a plain insertion (3 context rows each side). Before, the context made the
    // frame "not this request", so the hook item became a screen-only, risky card whose Allow the core refused.
    use nunchiro_core::waiting::screen::Screen;
    let rule = "─".repeat(120);
    let dash = "╌".repeat(120);
    let text = format!(
        " ▐▛███▛█   Claude Code v2.1.325\n\n❯ Add a function tax(rate) to app.py\n\n⏺ Update(app.py)\n{rule}\n Edit file\n app.py\n{dash}\n  1  def total(items):\n  2      return sum(i['price'] * i['qty'] for i in items)\n  3\n  4 +def tax(rate):\n  5 +    if rate < 0 or rate > 100:\n  6 +        raise ValueError(f'rate must be within 0..100, got {{rate}}')\n  7 +    return 1 + rate / 100\n  8 +\n  9  if __name__ == '__main__':\n 10      print(total([{{'price': 3, 'qty': 2}}]))\n{dash}\n Do you want to make this edit to app.py?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend"
    );
    let mut screen = Screen::new(160, 50);
    screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
    let d = screen.detect(AgentKind::Claude).unwrap();
    let dir = home("b3-context");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let input = json!({"file_path":"/p/app.py","replace_all":false,"old_string":"if __name__ == '__main__':","new_string":"def tax(rate):\n    if rate < 0 or rate > 100:\n        raise ValueError(f'rate must be within 0..100, got {rate}')\n    return 1 + rate / 100\n\nif __name__ == '__main__':"});
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Edit","tool_input":input,"nunchiro_event_id":"b3"}),
        "hook",
        50,
    )
    .unwrap();
    let id = q.items()[0].id.clone();
    q.screen("s", d.kind, d.text.clone(), d.choices, 60)
        .unwrap();
    let item = q.decision(&id).expect("the hook item keeps its id");
    fs::remove_dir_all(&dir).unwrap();
    assert_eq!(item.screen_text, Some(d.text));
    assert!(item.sources.contains("hook"));
    assert_eq!(item.choices.len(), 3);
}

#[test]
fn the_shown_diff_must_equal_the_request_line_for_line_with_indentation_and_blank_lines() {
    use nunchiro_core::{queue::Kind, waiting::screen::Screen};
    // v1b-12 round 6 (security review): nothing outside the edit, indentation and blank lines exact.
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let edit = |body: &str| {
        let mut screen = Screen::new(160, 50);
        let text = format!(
            "{rule}\n Edit file\n a.txt\n{dash}\n{body}\n{dash}\n Do you want to make this edit to a.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
        );
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).unwrap();
        assert_eq!(d.kind, Kind::Permission);
        (d.kind, d.text, d.choices)
    };
    let absorbed = |input: serde_json::Value,
                    f: (Kind, String, Vec<nunchiro_core::queue::Choice>)| {
        let dir = home("shown-equals-request");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        q.observe(
            "s",
            "PermissionRequest",
            &json!({"tool_name":"Edit","tool_input":input,"nunchiro_event_id":"r6"}),
            "hook",
            50,
        )
        .unwrap();
        let id = q.items()[0].id.clone();
        q.screen("s", f.0, f.1.clone(), f.2, 60).unwrap();
        let kept = q
            .decision(&id)
            .ok()
            .map(|d| d.screen_text == Some(f.1.clone()));
        fs::remove_dir_all(&dir).unwrap();
        kept == Some(true)
    };
    let ab = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a\nb"});
    assert!(absorbed(ab.clone(), edit(" 1 -x\n 1 +a\n 2 +b")));
    // A fold marker or extra text after the diff fails closed.
    for tail in [" …", " +3 lines", "   … 2 more lines", "hello"] {
        assert!(
            !absorbed(ab.clone(), edit(&format!(" 1 -x\n 1 +a\n 2 +b\n{tail}"))),
            "{tail}"
        );
    }
    // Indentation counts (Python, YAML): an indent-only difference is another edit.
    let indented = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"    a"});
    assert!(absorbed(indented.clone(), edit(" 1 -x\n 1 +    a")));
    assert!(!absorbed(indented, edit(" 1 -x\n 1 +a")));
    // Blank lines count.
    let blank = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a\n\nb"});
    assert!(absorbed(blank.clone(), edit(" 1 -x\n 1 +a\n 2 +\n 3 +b")));
    assert!(!absorbed(blank, edit(" 1 -x\n 1 +a\n 2 +b")));
    // More than the two rules around the body: not proven.
    assert!(!absorbed(
        ab.clone(),
        edit(&format!(" 1 -x\n 1 +a\n{dash}\n 2 +b"))
    ));
    // A context line whose own text starts with `-` stays context (only Claude's marker column decides).
    let dashed = json!({"file_path":"/p/a.txt","old_string":"a\n-b","new_string":"X\n-b"});
    assert!(absorbed(dashed.clone(), edit(" 1 -a\n 1 +X\n 2  -b")));
    assert!(!absorbed(dashed, edit(" 1 -a\n 1 +X\n 2 --b")));
}

// v1b-27: whether a not-live hook item for `tool`/`input` absorbs the detected screen `text` (its own request).
fn absorbs(agent: AgentKind, tool: &str, input: serde_json::Value, text: &str) -> bool {
    use nunchiro_core::waiting::screen::Screen;
    let mut screen = Screen::new(160, 50);
    screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
    let d = screen.detect(agent).expect("prompt detected");
    assert_eq!(d.kind, nunchiro_core::queue::Kind::Permission, "{text}");
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = home(&format!(
        "v1b27-absorbs-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", agent, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":"v27"}),
        "hook",
        50,
    )
    .unwrap();
    let id = q.items()[0].id.clone();
    q.screen("s", d.kind, d.text.clone(), d.choices, 60)
        .unwrap();
    let kept = q
        .decision(&id)
        .ok()
        .is_some_and(|i| i.screen_text == Some(d.text));
    fs::remove_dir_all(&dir).unwrap();
    kept
}

fn edit_screen(body: &str) -> String {
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    format!(
        "{rule}\n Edit file\n a.txt\n{dash}\n{body}\n{dash}\n Do you want to make this edit to a.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
    )
}

/// v1b-27: the synthetic Write frames (fixture header says how they were built), by label.
fn write_frame(label: &str) -> String {
    let raw = include_str!("fixtures/claude-write-prompt/2.1.310-synthetic-frames.txt");
    raw.split("=== ")
        .skip(1)
        .find_map(|f| {
            let (l, text) = f.split_once('\n').unwrap();
            (l.trim() == label).then(|| text.trim_end().to_string())
        })
        .unwrap()
}

#[test]
fn own_request_gutter_is_a_column_not_a_leading_number() {
    let edit = |input: serde_json::Value, body: &str| {
        absorbs(AgentKind::Claude, "Edit", input, &edit_screen(body))
    };
    let two = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a\nfoo"});
    // One long wrapped row ("a 12 +foo") is not the two lines "a" and "foo": a continuation is no diff row.
    assert!(!edit(two.clone(), " 1 -x\n 1 +a\n    12 +foo"));
    assert!(!edit(two.clone(), " 1 -x\n 1 +a\n   12 +foo"));
    assert!(edit(two, " 1 -x\n 1 +a\n 2 +foo"));
    // Real gutter forms still match: context rows, empty rows, right-aligned wider numbers.
    let ctx = json!({"file_path":"/p/a.txt","old_string":"a\n\nb","new_string":"a\n\nc"});
    assert!(edit(ctx, " 1  a\n 2\n 3 -b\n 3 +c"));
    let wide = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a\nb"});
    assert!(edit(wide.clone(), "  9 -x\n  9 +a\n 10 +b"));
    // Numbers that do not end in one column are not one gutter.
    assert!(!edit(wide, " 9 -x\n 9 +a\n 10 +b"));
}

#[test]
fn own_request_accepts_a_real_claude_write_create_prompt() {
    let create = json!({"file_path":"/p/b.txt","content":"hello\nworld\n"});
    assert!(absorbs(
        AgentKind::Claude,
        "Write",
        create,
        &write_frame("create")
    ));
}

#[test]
fn own_request_accepts_a_real_claude_write_overwrite_prompt() {
    let overwrite = json!({"file_path":"/p/a.txt","content":"alpha\nBETA\ngamma\n"});
    assert!(absorbs(
        AgentKind::Claude,
        "Write",
        overwrite,
        &write_frame("overwrite")
    ));
}

#[test]
fn own_request_refuses_a_write_prompt_whose_body_differs_or_lacks_a_dashed_rule() {
    let write =
        |input: serde_json::Value, text: &str| absorbs(AgentKind::Claude, "Write", input, text);
    let create = json!({"file_path":"/p/b.txt","content":"hello\nworld\n"});
    let overwrite = json!({"file_path":"/p/a.txt","content":"alpha\nBETA\ngamma\n"});
    let c = write_frame("create");
    let o = write_frame("overwrite");
    let dash = "╌".repeat(149);
    assert!(!write(create.clone(), &c.replace("2 +world", "2 +w0rld")));
    assert!(!write(
        create.clone(),
        &c.replace("2 +world", "2 +world\n 3 +rm -rf /")
    ));
    assert!(!write(create.clone(), &c.replace("b.txt?", "c.txt?")));
    // The other verb's prompt for the same body, or our body with a removed line, is not a create.
    assert!(!write(
        create.clone(),
        &c.replace("2 +world", "2 +world\n 3 -keep")
    ));
    assert!(!write(overwrite.clone(), &o.replace("2 +BETA", "2 +BETA!")));
    // Only the new side counts for an overwrite, and it is the whole file: it starts at line 1 and ends before
    // Claude's 3 context lines run out (3 trailing context rows: the file may go on unseen).
    assert!(!write(
        json!({"file_path":"/p/a.txt","content":"BETA\ngamma\n"}),
        &o.replace(" 1  alpha\n", "")
    ));
    assert!(!write(
        json!({"file_path":"/p/a.txt","content":"alpha\nBETA\ngamma\nd\ne\n"}),
        &o.replace(" 3  gamma", " 3  gamma\n 4  d\n 5  e")
    ));
    assert!(!write(
        overwrite.clone(),
        &o.replace(" 3  gamma", " 3  gamma\n …")
    ));
    // Without both dashed rules nothing matches.
    for text in [&c, &o] {
        let (top, rest) = text.split_once(&dash).unwrap();
        let no_top = format!("{top}{rest}");
        let (body, tail) = rest.split_once(&dash).unwrap();
        let no_bottom = format!("{top}{dash}{body}{tail}");
        for input in [&create, &overwrite] {
            assert!(!write(input.clone(), &no_top));
            assert!(!write(input.clone(), &no_bottom));
        }
    }
}

// v1b-30: whether a not-live hook item for `tool`/`input` is refused by the detected screen `text`: it keeps its id
// and text, never takes the screen (what a late answer types into), and no screen item replaces it.
fn refuses(agent: AgentKind, tool: &str, input: serde_json::Value, text: &str) -> bool {
    use nunchiro_core::waiting::screen::Screen;
    let mut screen = Screen::new(160, 50);
    screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
    let d = screen.detect(agent).expect("prompt detected");
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = home(&format!(
        "v1b30-refuses-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", agent, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":"v30"}),
        "hook",
        50,
    )
    .unwrap();
    let held = q.items()[0].clone();
    q.screen("s", d.kind, d.text, d.choices, 60).unwrap();
    let items = q.items();
    fs::remove_dir_all(&dir).unwrap();
    items.len() == 1
        && items[0].id == held.id
        && items[0].text == held.text
        && items[0].screen_text.is_none()
}

fn bash_screen(body: &str) -> String {
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    format!(
        "{rule}\n Bash command\n{dash}\n{body}\n{dash}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
    )
}

#[test]
fn late_answer_is_refused_when_the_request_has_trailing_spaces() {
    // v1b-30 (replaces the v1b-27 pin that trimmed both sides): the screen cannot show trailing whitespace, so a
    // request with it on a line the screen must match is unproven; the item waits for its hook or the terminal.
    let edit = |input: serde_json::Value| (input, edit_screen(" 1 -x\n 1 +a\n 2 +b"));
    let cases = [
        (
            "Edit",
            edit(json!({"file_path":"/p/a.txt","old_string":"x  ","new_string":"a\nb"})),
        ),
        (
            "Edit",
            edit(json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a \nb"})),
        ),
        (
            "Edit",
            edit(json!({"file_path":"/p/a.txt","old_string":"x\t","new_string":"a\nb"})),
        ),
        (
            "Edit",
            edit(json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a\r\nb"})),
        ),
        (
            "Edit",
            edit(
                json!({"file_path":"/p/a.txt","edits":[{"old_string":"x","new_string":"a\nb  "}]}),
            ),
        ),
        (
            "Write",
            (
                json!({"file_path":"/p/b.txt","content":"hello   \nworld\n"}),
                write_frame("create"),
            ),
        ),
        (
            "Write",
            (
                json!({"file_path":"/p/a.txt","content":"alpha\nBETA \ngamma\n"}),
                write_frame("overwrite"),
            ),
        ),
        (
            "Bash",
            (json!({"command":"touch done "}), bash_screen(" touch done")),
        ),
    ];
    for (tool, (input, screen)) in cases {
        let mut trimmed = input.clone();
        for key in ["old_string", "new_string", "content", "command"] {
            if let Some(t) = input[key].as_str() {
                let t: Vec<&str> = t.split('\n').map(str::trim_end).collect();
                trimmed[key] = json!(t.join("\n"));
            }
        }
        if let Some(e) = input["edits"].as_array() {
            trimmed["edits"] = json!([{"old_string":"x","new_string":"a\nb"}]);
            assert_eq!(e.len(), 1);
        }
        // The same request without the trailing whitespace is proven by this very frame.
        assert!(
            absorbs(AgentKind::Claude, tool, trimmed, &screen),
            "{input}"
        );
        assert!(
            refuses(AgentKind::Claude, tool, input.clone(), &screen),
            "{input}"
        );
    }
    // Codex: the one-line command too.
    let raw = include_str!("fixtures/codex-approval/0.161.0-synthetic-frame.txt");
    let own = raw.split_once("=== own\n").unwrap().1.trim_end();
    assert!(refuses(
        AgentKind::Codex,
        "Bash",
        json!({"command":"touch done "}),
        own
    ));
    // Trailing spaces on a line the screen does not match (the Bash description) do not refuse.
    assert!(absorbs(
        AgentKind::Claude,
        "Bash",
        json!({"command":"touch done","description":"Create the file  "}),
        &bash_screen(" touch done")
    ));
}

#[test]
fn late_answer_is_refused_for_a_multi_line_bash_command() {
    // v1b-30: a newline in the command (LF or CRLF) is never proven, even when the screen shows those lines.
    let two = bash_screen(" echo a\n echo b");
    assert!(refuses(
        AgentKind::Claude,
        "Bash",
        json!({"command":"echo a\necho b"}),
        &two
    ));
    assert!(refuses(
        AgentKind::Claude,
        "Bash",
        json!({"command":"echo a\r\necho b"}),
        &two
    ));
    assert!(refuses(
        AgentKind::Claude,
        "Bash",
        json!({"command":"echo a\recho b"}),
        &two
    ));
    // A single-line command follows the normal rule.
    assert!(absorbs(
        AgentKind::Claude,
        "Bash",
        json!({"command":"echo a"}),
        &bash_screen(" echo a")
    ));
}

#[test]
fn late_answer_is_refused_while_parallel_hooks_are_pending_for_the_session() {
    use nunchiro_core::waiting::screen::Screen;
    let frame = |text: &str| {
        let mut screen = Screen::new(160, 50);
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).unwrap();
        (d.kind, d.text, d.choices)
    };
    let first = frame(&bash_screen(" touch a"));
    let show = |q: &mut Queue, s: &str, at: u64| {
        q.screen(s, first.0.clone(), first.1.clone(), first.2.clone(), at)
            .unwrap();
    };
    let hook = |q: &mut Queue,
                s: &str,
                event: &str,
                agent: Option<&str>,
                command: &str,
                at: u64| {
        let mut p =
            json!({"tool_name":"Bash","tool_input":{"command":command},"nunchiro_event_id":event});
        if let Some(agent) = agent {
            p["agent_id"] = json!(agent);
        }
        q.observe(s, "PermissionRequest", &p, "hook", at).unwrap();
    };
    let late = |q: &Queue| q.items().iter().any(|i| i.screen_text.is_some());
    // Two hooks for the same scope (the card shows the last one), the screen shows the first one's prompt: even the
    // same command is not proven to be the card's request.
    for second in ["touch a", "touch b"] {
        let dir = home("v1b30-parallel-scope");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        hook(&mut q, "s", "p1", None, "touch a", 10);
        hook(&mut q, "s", "p2", None, second, 11);
        let card = q.items()[0].clone();
        show(&mut q, "s", 20);
        assert_eq!(q.items().len(), 1, "{second}");
        assert_eq!(
            (q.items()[0].id.clone(), q.items()[0].text.clone()),
            (card.id.clone(), card.text.clone())
        );
        assert!(
            !late(&q),
            "{second}: a screen answer while two hooks are pending"
        );
        // The pending tool resolves (both leave with it); a new hook follows the normal rule again.
        q.observe("s", "PostToolUse", &json!({}), "hook", 30)
            .unwrap();
        hook(&mut q, "s", "p3", None, "touch a", 40);
        show(&mut q, "s", 50);
        assert!(late(&q), "{second}: one pending hook takes its own prompt");
        fs::remove_dir_all(&dir).unwrap();
    }
    // A main and a sub-agent hook: the main item already holding its prompt loses it, and gets it back once the
    // sub-agent's request is gone.
    let dir = home("v1b30-parallel-agents");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.register("t", AgentKind::Claude, 0).unwrap();
    hook(&mut q, "s", "m1", None, "touch a", 10);
    show(&mut q, "s", 20);
    assert!(late(&q));
    hook(&mut q, "s", "a1", Some("sub1"), "touch b", 30);
    assert_eq!(q.items().len(), 2);
    assert!(
        !late(&q),
        "the main item kept its screen with two hooks pending"
    );
    show(&mut q, "s", 40);
    assert!(!late(&q), "a screen answer while two hooks are pending");
    assert_eq!(q.items().len(), 2, "a screen item joined the session");
    // Another session's hook neither blocks nor is blocked.
    hook(&mut q, "t", "t1", None, "touch a", 41);
    show(&mut q, "t", 42);
    assert!(
        q.items()
            .iter()
            .any(|i| i.session_id == "t" && i.screen_text.is_some())
    );
    q.observe("s", "PostToolUse", &json!({"agent_id":"sub1"}), "hook", 50)
        .unwrap();
    show(&mut q, "s", 60);
    assert!(
        q.items()
            .iter()
            .any(|i| i.session_id == "s" && i.screen_text.is_some()),
        "the remaining hook follows the normal rule"
    );
    fs::remove_dir_all(&dir).unwrap();
    // The hook path is unchanged: both live hooks answer for their own requests.
    let dir = home("v1b30-parallel-live");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.connect(0);
    assert!(q.begin_hook("m1", 5) && q.begin_hook("a1", 5));
    hook(&mut q, "s", "m1", None, "touch a", 10);
    hook(&mut q, "s", "a1", Some("sub1"), "touch b", 11);
    show(&mut q, "s", 20);
    for item in q.items() {
        let event = item.hook_event_id.clone().unwrap();
        assert!(q.answer_hook(&item, true, 30).unwrap());
        assert!(q.hook_response(&event).is_some());
    }
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_codex_approval_prompt_proves_only_its_one_line_command() {
    // v1b-27: the synthetic Codex 0.161.0 frame (fixture header), checked at the queue seam.
    let raw = include_str!("fixtures/codex-approval/0.161.0-synthetic-frame.txt");
    let own = raw.split_once("=== own\n").unwrap().1.trim_end();
    let bash = |command: &str, text: &str| {
        absorbs(
            AgentKind::Codex,
            "Bash",
            json!({ "command": command }),
            text,
        )
    };
    assert!(bash("touch done", own));
    assert!(!bash("touch done --force", own));
    assert!(!bash("touch", own));
    // A reason line posing as the command is a second `$ ` line.
    assert!(!bash(
        "touch done",
        &own.replace("Reason: create the done file", "$ touch done")
            .replace("$ touch done\n\n›", "$ rm -rf ~/x\n\n›")
    ));
    // A multi-line command or a wrapped continuation after the `$ ` line is unproven.
    assert!(!bash("touch done\nrm -rf ~/x", own));
    assert!(!bash(
        "touch done",
        &own.replace("$ touch done", "$ touch done\n  && rm -rf ~/x")
    ));
    // The prompt in agent prose above another prompt drawn below it: the region must end at the confirm hint.
    assert!(!bash(
        "touch done",
        &format!(
            "{own}\n\n  Would you like to make the following edits?\n\n› 1. Yes, proceed (y)\n  2. No (esc)"
        )
    ));
    // Below the choices only choices and the confirm hint, which ends the screen.
    assert!(!bash(
        "touch done",
        &own.replace("\n\n  Press enter", "\n  $ rm -rf ~/x\n\n  Press enter")
    ));
    assert!(!bash(
        "touch done",
        &own.replace(
            "Press enter to confirm or esc to cancel",
            "Press enter to run rm -rf ~/x"
        )
    ));
    // The same frame read as Claude has no rules: never Claude's own request.
    assert!(!absorbs(
        AgentKind::Claude,
        "Bash",
        json!({"command":"touch done"}),
        own
    ));
}

#[test]
fn own_request_reads_the_question_only_below_the_body() {
    // v1b-27 preflight MUST: the request body is the agent's; a prompt phrase inside it never picks the prompt kind.
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let screen = |head: &str, body: &str, question: &str| {
        format!(
            "{rule}\n {head}\n{dash}\n{body}\n{dash}\n {question}\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
        )
    };
    // An overwrite whose body carries the create question: 3 context rows could hide more of the file.
    let content = "Do you want to create x.txt?\nX\nb\nc\nd";
    let overwrite = screen(
        "Overwrite file\n x.txt",
        " 1  Do you want to create x.txt?\n 2 +X\n 3  b\n 4  c\n 5  d",
        "Do you want to overwrite x.txt?",
    );
    assert!(!absorbs(
        AgentKind::Claude,
        "Write",
        json!({"file_path":"/p/x.txt","content":content}),
        &overwrite
    ));
    // A command whose lines read as an edit's diff, with the Bash question inside it, on an Edit prompt.
    let edit = screen(
        "Edit file\n a.txt",
        " 1 -x\n 2 +Do you want to proceed?",
        "Do you want to make this edit to a.txt?",
    );
    assert!(!absorbs(
        AgentKind::Claude,
        "Bash",
        json!({"command":"1 -x\n2 +Do you want to proceed?"}),
        &edit
    ));
}

#[test]
fn b7_claude_2_1_325_bash_prompt_with_a_note_line_is_its_own_request() {
    // Ticket 991 B7: 2.1.325 puts "This command requires approval" between the body and the question.
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let screen = format!(
        "{rule}\n Bash command\n Run pytest quietly\n{dash}\n python3 -m pytest -q\n{dash}\n This command requires approval\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don’t ask again for: python3 *\n   3. No\n\n Esc to cancel · Tab to amend"
    );
    let cmd = |c: &str| json!({"command":c,"description":"Run pytest quietly"});
    assert!(absorbs(
        AgentKind::Claude,
        "Bash",
        cmd("python3 -m pytest -q"),
        &screen
    ));
    assert!(!absorbs(
        AgentKind::Claude,
        "Bash",
        cmd("python3 -m pytest"),
        &screen
    ));
}

// v1b-32: what the screen observer hands the queue for a frame.
fn detected(
    text: &str,
) -> (
    nunchiro_core::queue::Kind,
    String,
    Vec<nunchiro_core::queue::Choice>,
) {
    use nunchiro_core::waiting::screen::Screen;
    let mut screen = Screen::new(160, 50);
    screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
    let d = screen.detect(AgentKind::Claude).expect("prompt detected");
    (d.kind, d.text, d.choices)
}

fn show(q: &mut Queue, s: &str, text: &str, at: u64) {
    let (kind, text, choices) = detected(text);
    q.screen(s, kind, text, choices, at).unwrap();
}

fn dialog_screen() -> String {
    format!(
        "{}\n Select model\n ❯ 1. Opus\n   2. Sonnet\n\n Enter to confirm · Esc to cancel",
        "─".repeat(80)
    )
}

fn permission(
    q: &mut Queue,
    s: &str,
    agent: Option<&str>,
    tool: &str,
    input: serde_json::Value,
    event: &str,
    at: u64,
) {
    let mut p = json!({"tool_name":tool,"tool_input":input,"nunchiro_event_id":event});
    if let Some(agent) = agent {
        p["agent_id"] = json!(agent);
    }
    q.observe(s, "PermissionRequest", &p, "hook", at).unwrap();
}

/// v1b-32 r5: a screen card beside a held item is view-only (nothing to send; its answer writes nothing) unless it is
/// a dialog, which only Esc answers.
fn view_only(i: &nunchiro_core::queue::Decision) -> bool {
    i.hook_event_id.is_none()
        && !i.actionable
        && !i.reconciled
        && i.screen_text.is_none()
        && i.choices.is_empty()
}
fn digit_cards(items: &[nunchiro_core::queue::Decision]) -> Vec<nunchiro_core::queue::Decision> {
    items
        .iter()
        .filter(|i| {
            !i.sources.contains("hook")
                && i.actionable
                && i.kind != nunchiro_core::queue::Kind::Dialog
        })
        .cloned()
        .collect()
}

#[test]
fn a_new_prompt_after_an_unprovable_item_gets_its_own_card() {
    let unprovable = |q: &mut Queue, event: &str, at: u64| {
        permission(
            q,
            "s",
            None,
            "Edit",
            json!({"file_path":"/p/a.txt","old_string":"x ","new_string":"a"}),
            event,
            at,
        );
        q.items()[0].clone()
    };
    let same = |a: &nunchiro_core::queue::Decision, b: &nunchiro_core::queue::Decision| {
        (&a.id, &a.text, &a.hook_event_id, &a.screen_text)
            == (&b.id, &b.text, &b.hook_event_id, &b.screen_text)
    };
    let dir = home("v1b32-unprovable");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let held = unprovable(&mut q, "u1", 10);
    // Its own prompt makes no second card.
    let own = edit_screen(" 1 -x\n 1 +a");
    show(&mut q, "s", &own, 20);
    assert_eq!(q.items().len(), 1);
    assert!(same(&q.items()[0], &held));
    // A different prompt shows as one view-only card, however often it is redrawn.
    let bash = bash_screen(" touch b");
    for at in [30, 31, 32] {
        show(&mut q, "s", &bash, at);
    }
    let items = q.items();
    assert_eq!(items.len(), 2, "one new card for the Bash prompt");
    assert!(same(&items[0], &held), "the held item changed");
    let card = items[1].clone();
    assert!(view_only(&card), "{card:?}");
    assert_eq!(card.kind, nunchiro_core::queue::Kind::Permission);
    assert_eq!(card.text, detected(&bash).1);
    // Another prompt replaces the card's text and identity, never the held item.
    let other = edit_screen(" 1 -y\n 1 +b").replace("a.txt", "b.txt");
    show(&mut q, "s", &other, 40);
    let items = q.items();
    assert_eq!(items.len(), 2);
    assert!(same(&items[0], &held));
    assert!(view_only(&items[1]) && items[1].id != card.id);
    assert_eq!(items[1].text, detected(&other).1);
    // The held request's own prompt again ends the card.
    show(&mut q, "s", &own, 50);
    assert_eq!(q.items().len(), 1);
    show(&mut q, "s", &bash, 60);
    // The new card ends when its prompt is gone; the held item stays.
    q.clear_screen("s").unwrap();
    assert_eq!(q.items().len(), 1);
    assert!(same(&q.items()[0], &held));
    // The held item still ends on PostToolUse, Stop and UserPromptSubmit (with the scope's new card).
    show(&mut q, "s", &bash, 70);
    q.observe("s", "PostToolUse", &json!({}), "hook", 80)
        .unwrap();
    assert!(q.items().is_empty());
    for (n, event) in ["Stop", "UserPromptSubmit"].into_iter().enumerate() {
        let at = 100 + 100 * n as u64;
        unprovable(&mut q, event, at);
        show(&mut q, "s", &bash, at + 10);
        assert_eq!(q.items().len(), 2, "{event}");
        q.observe("s", event, &json!({}), "hook", at + 20).unwrap();
        assert!(q.items().is_empty(), "{event}");
    }
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_new_dialog_after_a_contended_item_gets_its_own_card() {
    // Two hooks in one scope (the second stacks on the first), and a main and a sub-agent hook.
    for sub in [None, Some("sub1")] {
        let dir = home("v1b32-contended");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        permission(
            &mut q,
            "s",
            None,
            "Bash",
            json!({"command":"touch a"}),
            "p1",
            10,
        );
        permission(
            &mut q,
            "s",
            sub,
            "Bash",
            json!({"command":"touch b"}),
            "p2",
            11,
        );
        let held = q.items();
        let key = |i: &nunchiro_core::queue::Decision| {
            (
                i.id.clone(),
                i.text.clone(),
                i.hook_event_id.clone(),
                i.screen_text.clone(),
            )
        };
        let kept = |q: &Queue| {
            held.iter()
                .all(|h| q.items().iter().any(|i| key(i) == key(h)))
        };
        // A Bash prompt could be either request: no card.
        show(&mut q, "s", &bash_screen(" touch b"), 20);
        assert_eq!(q.items().len(), held.len(), "{sub:?}");
        assert!(kept(&q));
        // An edit prompt is another request: a view-only card.
        show(&mut q, "s", &edit_screen(" 1 -x\n 1 +a"), 25);
        assert_eq!(q.items().len(), held.len() + 1, "{sub:?}");
        assert!(q.items().iter().any(view_only));
        assert!(kept(&q));
        // A dialog in the scope gets an Esc-only card, once however often it is redrawn.
        let dialog = dialog_screen();
        for at in [30, 31, 32] {
            show(&mut q, "s", &dialog, at);
        }
        let items = q.items();
        assert_eq!(items.len(), held.len() + 1, "{sub:?}: one new dialog card");
        assert!(kept(&q), "{sub:?}: a held item changed");
        let card = items.iter().find(|i| i.hook_event_id.is_none()).unwrap();
        assert_eq!(card.kind, nunchiro_core::queue::Kind::Dialog);
        assert_eq!(card.screen_text, Some(detected(&dialog).1));
        assert!(card.actionable);
        // The held items still end with their tool (the dialog card of their scope with them).
        q.observe("s", "PostToolUse", &json!({}), "hook", 40)
            .unwrap();
        if let Some(agent) = sub {
            q.observe("s", "PostToolUse", &json!({"agent_id":agent}), "hook", 41)
                .unwrap();
        }
        assert!(q.items().is_empty(), "{sub:?}");
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn no_card_beside_a_held_item_types_a_digit() {
    // v1b-32 r5: every way the security reviews r1-r4 found for a card beside a held item to type into a pending
    // request. Each gives at most a view-only card or an Esc-only dialog card.
    let rule = "─".repeat(80);
    let dash = "╌".repeat(80);
    let a_edit = json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a"});
    let unprovable_edit = |path: &str| json!({"file_path":path,"old_string":"x ","new_string":"a"});
    let edit_of = |name: &str| edit_screen(" 1 -x\n 1 +a").replace("a.txt", name);
    type Setup = Box<dyn Fn(&mut Queue)>;
    let one = |tool: &'static str, input: serde_json::Value| -> Setup {
        Box::new(move |q: &mut Queue| permission(q, "s", None, tool, input.clone(), "h1", 10))
    };
    let mcp_own = format!(
        "{rule}\n Tool use\n\n   fs - write_file(file_path: \"/p/a.txt\", content: \"hi\") (MCP)\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for fs - write_file commands in /p\n   3. No, and tell Claude what to do differently (esc)\n"
    );
    let reworded = format!(
        "{rule}\n Bash command\n{dash}\n rm -rf x\n{dash}\n Allow this command?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"
    );
    let wrapped = format!(
        "{rule}\n Edit file\n a.txt\n{dash}\n 1 -x\n 1 +a\n{dash}\n Do you\n want to make this edit to a.txt?\n ❯ 1. Yes\n   2. No\n\n Enter to select"
    );
    let question = format!(
        "{rule}\n Question 1/1: Which file?\n ❯ 1. a.txt\n   2. b.txt\n\n Enter to select · Esc to cancel"
    );
    let stacked = |second: &'static str| -> Setup {
        Box::new(move |q: &mut Queue| {
            permission(
                q,
                "s",
                None,
                "Edit",
                json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a"}),
                "p1",
                10,
            );
            permission(
                q,
                "s",
                None,
                "Edit",
                json!({"file_path":"/p/b.txt","old_string":"y","new_string":second}),
                "p2",
                11,
            );
        })
    };
    // Security review r4: X (unprovable, sub-agent) holds the session while p1's item is lost to an answered stacked
    // p2, a scope-wide PostToolUse, or a Question replacing it; p1's prompt is still on screen.
    let orphan = |how: &'static str| -> Setup {
        Box::new(move |q: &mut Queue| {
            permission(
                q,
                "s",
                Some("sub1"),
                "Bash",
                json!({"command":"echo 1\necho 2"}),
                "x1",
                5,
            );
            permission(
                q,
                "s",
                None,
                "Edit",
                json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a"}),
                "p1",
                10,
            );
            match how {
                "answer" => {
                    permission(
                        q,
                        "s",
                        None,
                        "Edit",
                        json!({"file_path":"/p/b.txt","old_string":"y","new_string":"b"}),
                        "p2",
                        11,
                    );
                    q.connect(11);
                    assert!(q.begin_hook("p2", 11));
                    let item = q
                        .items()
                        .into_iter()
                        .find(|i| i.hook_event_id.as_deref() == Some("p2"))
                        .unwrap();
                    assert!(q.answer_hook(&item, true, 12).unwrap());
                }
                "post" => {
                    permission(
                        q,
                        "s",
                        None,
                        "Edit",
                        json!({"file_path":"/p/b.txt","old_string":"y","new_string":"b"}),
                        "p2",
                        11,
                    );
                    q.observe("s", "PostToolUse", &json!({}), "hook", 12)
                        .unwrap();
                }
                _ => permission(
                    q,
                    "s",
                    None,
                    "AskUserQuestion",
                    json!({"questions":[{"question":"Pick?","options":[{"label":"x"}]}]}),
                    "q1",
                    11,
                ),
            }
        })
    };
    let mut deep = json!("/p/z.txt");
    for _ in 0..20 {
        deep = json!({ "x": deep });
    }
    deep["content"] = json!("hi ");
    let cases: Vec<(&str, Setup, String)> = vec![
        (
            "r1 A: MCP own prompt",
            one(
                "mcp__fs__write_file",
                json!({"file_path":"/p/a.txt","content":"hi "}),
            ),
            mcp_own,
        ),
        (
            "r1 B: NFD name",
            one("Edit", unprovable_edit("/p/cafe\u{301}.txt")),
            edit_of("cafe\u{301}.txt"),
        ),
        (
            "r1 D: reworded prompt",
            one("Bash", json!({"command":"rm -rf x "})),
            reworded,
        ),
        (
            "r1 E: zero-width name",
            one("Edit", unprovable_edit("/p/a\u{200b}.txt")),
            edit_of("a.txt"),
        ),
        (
            "r1: bidi name",
            one("Edit", unprovable_edit("/p/a\u{202e}.txt")),
            edit_of("a.txt"),
        ),
        (
            "r1: windows path",
            one("Edit", unprovable_edit("C:\\p\\a.txt")),
            edit_of("a.txt"),
        ),
        (
            "r1: name cut short",
            one("Edit", unprovable_edit("/p/a-very-long-name.txt")),
            edit_of("a-very-…-name.txt"),
        ),
        (
            "r1: wrapped question",
            one("Edit", unprovable_edit("/p/a.txt")),
            wrapped,
        ),
        (
            "r1: question frame",
            one("Edit", unprovable_edit("/p/a.txt")),
            question,
        ),
        ("r2: stacked, own prompt", stacked("b"), edit_of("a.txt")),
        ("r2: stacked, another file", stacked("b"), edit_of("c.txt")),
        (
            "r3: nested input",
            one(
                "mcp__x__edit",
                json!({"args":{"path":"/p/a.txt"},"content":"hi "}),
            ),
            edit_of("a.txt"),
        ),
        (
            "r3: deep input",
            one("mcp__x__edit", deep),
            edit_of("a.txt"),
        ),
        (
            "r3: no event id",
            Box::new(|q: &mut Queue| {
                q.observe("s", "PermissionRequest", &json!({"tool_name":"Edit","tool_input":{"file_path":"/p/a.txt","old_string":"x ","new_string":"a"}}), "hook", 10).unwrap();
            }),
            edit_of("b.txt"),
        ),
        (
            "r3: number",
            one("mcp__x__edit", json!({"id":42,"content":"hi "})),
            edit_of("42"),
        ),
        (
            "r3: key",
            one("mcp__x__edit", json!({"a.txt":{"x":"y"},"content":"hi "})),
            edit_of("a.txt"),
        ),
        (
            "r4: orphan after an answered stacked hook",
            orphan("answer"),
            edit_of("a.txt"),
        ),
        (
            "r4: orphan after PostToolUse",
            orphan("post"),
            edit_of("a.txt"),
        ),
        (
            "r4: orphan after a Question",
            orphan("question"),
            edit_of("a.txt"),
        ),
        (
            "plain Edit beside nothing held stays answerable",
            one("Edit", a_edit.clone()),
            bash_screen(" touch b"),
        ),
    ];
    for (name, setup, frame) in cases {
        let dir = home("v1b32r5-digit");
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        setup(&mut q);
        show(&mut q, "s", &frame, 20);
        let items = q.items();
        fs::remove_dir_all(&dir).unwrap();
        if name.starts_with("plain") {
            // Control: with nothing held the normal rule applies and the new prompt is answerable.
            assert_eq!(digit_cards(&items).len(), 1, "{name}: {items:?}");
            continue;
        }
        assert!(digit_cards(&items).is_empty(), "{name}: {items:?}");
    }
}

#[test]
fn another_sessions_events_never_clear_a_stacked_mark() {
    // Security review r3: session A stacks Edit b.txt on Edit a.txt; session B's events must not drop A's stacked
    // mark, or A's a.txt prompt gets an answerable card that types into the still-pending p1.
    let b_events: [(&str, serde_json::Value); 5] = [
        ("PermissionRequest", json!({})),
        ("PostToolUse", json!({})),
        (
            "Stop",
            json!({"background_tasks":[{"id":"t1","status":"running"}]}),
        ),
        ("Stop", json!({})),
        ("UserPromptSubmit", json!({})),
    ];
    for second in ["b", "b "] {
        for (n, (event, payload)) in b_events.iter().enumerate() {
            let dir = home(&format!("v1b32r4-cross-{n}"));
            let mut q = Queue::open(&dir).unwrap();
            q.register("a", AgentKind::Claude, 0).unwrap();
            q.register("b", AgentKind::Claude, 0).unwrap();
            permission(
                &mut q,
                "a",
                None,
                "Edit",
                json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a"}),
                "p1",
                10,
            );
            permission(
                &mut q,
                "a",
                None,
                "Edit",
                json!({"file_path":"/p/b.txt","old_string":"x","new_string":second}),
                "p2",
                11,
            );
            if *event == "PermissionRequest" {
                permission(
                    &mut q,
                    "b",
                    None,
                    "Edit",
                    json!({"file_path":"/p/c.txt","old_string":"x","new_string":"c"}),
                    "q1",
                    12,
                );
            } else {
                q.observe("b", event, payload, "hook", 12).unwrap();
            }
            show(&mut q, "b", &bash_screen(" touch b"), 13);
            for (at, frame) in [
                (20, edit_screen(" 1 -x\n 1 +a")),
                (21, edit_screen(" 1 -x\n 1 +c").replace("a.txt", "c.txt")),
            ] {
                show(&mut q, "a", &frame, at);
                let a: Vec<_> = q
                    .items()
                    .into_iter()
                    .filter(|i| i.session_id == "a")
                    .collect();
                assert!(digit_cards(&a).is_empty(), "{second:?} {event}: {a:?}");
                assert!(
                    a.iter().any(|i| i.hook_event_id.as_deref() == Some("p2")),
                    "{second:?} {event}"
                );
            }
            fs::remove_dir_all(&dir).unwrap();
        }
    }
}

#[test]
fn a_view_only_card_is_never_continued_after_the_hold_ends() {
    // Security review r5 MUST and SHOULD 1: a view-only card is never upgraded, reused or re-keyed; when the hold ends
    // it goes, and the next frame or hook gets a fresh card (new id, its own text and screen text).
    let evil = edit_screen(" 1 -x\n 1 +rm -rf ~").replace("a.txt", "evil.sh");
    for after in ["frame", "hook", "post"] {
        let dir = home(&format!("v1b32r6-{after}"));
        let mut q = Queue::open(&dir).unwrap();
        q.register("s", AgentKind::Claude, 0).unwrap();
        // X: an unprovable sub-agent request holds the session; an edit prompt shows as a view-only card.
        permission(
            &mut q,
            "s",
            Some("sub1"),
            "Bash",
            json!({"command":"echo 1\necho 2"}),
            "x1",
            5,
        );
        show(&mut q, "s", &edit_screen(" 1 -x\n 1 +a"), 10);
        let view = q
            .items()
            .into_iter()
            .find(view_only)
            .expect("a view-only card");
        // The hold ends: X answered through its hook, or its tool finished.
        if after == "post" {
            q.observe("s", "PostToolUse", &json!({"agent_id":"sub1"}), "hook", 11)
                .unwrap();
        } else {
            q.connect(11);
            assert!(q.begin_hook("x1", 11));
            let x = q
                .items()
                .into_iter()
                .find(|i| i.hook_event_id.as_deref() == Some("x1"))
                .unwrap();
            assert!(q.answer_hook(&x, true, 12).unwrap());
            q.end_hook("x1");
        }
        assert!(
            q.items().iter().all(|i| i.id != view.id),
            "{after}: the view-only card outlived the hold"
        );
        if after == "hook" {
            permission(
                &mut q,
                "s",
                None,
                "Edit",
                json!({"file_path":"/p/evil.sh","old_string":"x","new_string":"rm"}),
                "p3",
                20,
            );
            let item = q
                .items()
                .into_iter()
                .find(|i| i.hook_event_id.as_deref() == Some("p3"))
                .unwrap();
            assert_ne!(item.id, view.id, "{after}");
            assert!(item.text.contains("evil.sh"), "{after}");
        } else {
            show(&mut q, "s", &evil, 20);
            let items = q.items();
            assert_eq!(items.len(), 1, "{after}: {items:?}");
            assert_ne!(items[0].id, view.id, "{after}");
            assert_eq!(items[0].text, detected(&evil).1, "{after}");
            assert_eq!(items[0].screen_text, Some(detected(&evil).1), "{after}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }
    // SHOULD 1: stacked p1/p2, a c.txt frame shows view-only; p2 answered through its hook; a new hook p5 never takes
    // the view-only card's id.
    let dir = home("v1b32r6-stacked");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    permission(
        &mut q,
        "s",
        None,
        "Edit",
        json!({"file_path":"/p/a.txt","old_string":"x","new_string":"a"}),
        "p1",
        10,
    );
    permission(
        &mut q,
        "s",
        None,
        "Edit",
        json!({"file_path":"/p/b.txt","old_string":"y","new_string":"b"}),
        "p2",
        11,
    );
    show(
        &mut q,
        "s",
        &edit_screen(" 1 -x\n 1 +a").replace("a.txt", "c.txt"),
        12,
    );
    let view = q
        .items()
        .into_iter()
        .find(view_only)
        .expect("a view-only card");
    q.connect(13);
    assert!(q.begin_hook("p2", 13));
    let p2 = q
        .items()
        .into_iter()
        .find(|i| i.hook_event_id.as_deref() == Some("p2"))
        .unwrap();
    assert!(q.answer_hook(&p2, true, 14).unwrap());
    q.end_hook("p2");
    permission(
        &mut q,
        "s",
        None,
        "Edit",
        json!({"file_path":"/p/d.txt","old_string":"x","new_string":"d"}),
        "p5",
        20,
    );
    let items = q.items();
    assert!(items.iter().all(|i| i.id != view.id), "{items:?}");
    fs::remove_dir_all(&dir).unwrap();
}

/// Look C N5 and the Home look S2-8 (11-17): a redraw of Claude's Bash prompt that wraps the command (the terminal got
/// narrower) never replaces the hook's card while that request waits; a later frame that matches again gives it back
/// its screen answer when it matches. Another command still ends it.
#[test]
fn a_redraw_never_turns_a_waiting_hook_permission_into_a_screen_card() {
    use nunchiro_core::waiting::screen::Screen;
    let cmd = "printf 'hello' > \"/private/var/folders/jr/yqyyd28j0z94g1w76lmd37hh0000gn/T/ns-click-9x5s3324/demo-shop/notes.txt\"";
    let frame = |width: usize, cmd: &str| {
        let rule = "\u{2500}".repeat(width);
        let dash = "\u{254c}".repeat(width);
        let mut screen = Screen::new(width, 50);
        let text = format!(
            "{rule}\n Bash command\n{dash}\n \u{2502} {cmd}\n   Create notes.txt containing hello\n{dash}\n Do you want to proceed?\n \u{276f} 1. Yes\n   2. No\n\n Esc to cancel"
        );
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).expect("a prompt");
        (d.kind, d.text, d.choices)
    };
    let (wide, narrow) = (frame(160, cmd), frame(60, cmd));
    assert_ne!(wide.1, narrow.1);
    let dir = home("n5-redraw");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Bash","tool_input":{"command":cmd},"nunchiro_event_id":"b1"}),
        "hook",
        50,
    )
    .unwrap();
    let id = q.items()[0].id.clone();
    // Claude 2.1.326 draws the command behind a gutter, wide or wrapped: neither frame makes a second card.
    for (n, f) in [&wide, &narrow, &wide].into_iter().enumerate() {
        q.screen("s", f.0.clone(), f.1.clone(), f.2.clone(), 100 + n as u64)
            .unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1, "frame {n}: no second card");
        assert_eq!(items[0].id, id, "frame {n}: the hook's card stays");
        assert!(items[0].sources.contains("hook") && items[0].actionable);
    }
    // Another command on screen is another prompt: the held card ends, as before.
    let other = frame(160, "rm -rf ~/important");
    q.screen("s", other.0, other.1, other.2, 130).unwrap();
    assert!(q.decision(&id).is_err());
    fs::remove_dir_all(&dir).unwrap();
}

/// Look 11-17 v4 Home S2-8: a Write prompt whose body does not fit the screen (so the frame never proves the request)
/// keeps the hook's card when its question names the file, also after the hook's hold ended; another file's prompt ends it.
#[test]
fn a_waiting_write_permission_never_turns_into_a_screen_card() {
    use nunchiro_core::waiting::screen::Screen;
    let frame = |file: &str| {
        let rule = "\u{2500}".repeat(120);
        let dash = "\u{254c}".repeat(120);
        let mut screen = Screen::new(120, 50);
        let text = format!(
            "{rule}\n Create file\n {file}\n{dash}\n  1 skiff\n  2 ...\n{dash}\n Do you want to create {file}?\n \u{276f} 1. Yes\n   2. Yes, allow all edits during this session (shift+tab)\n   3. No\n\n Esc to cancel"
        );
        screen.feed(format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).as_bytes());
        let d = screen.detect(AgentKind::Claude).expect("a prompt");
        (d.kind, d.text, d.choices)
    };
    let dir = home("s2-8-write");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Write","tool_input":{"file_path":"/w/harbor/NOTE.txt","content":"skiff\n".repeat(80)},"nunchiro_event_id":"w1"}),
        "hook",
        50,
    )
    .unwrap();
    let id = q.items()[0].id.clone();
    // Long after the hook's hold (no live hook), frames of the same prompt keep the hook's card.
    for n in 0..3 {
        let f = frame("NOTE.txt");
        q.screen("s", f.0, f.1, f.2, 400_000 + n).unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1, "frame {n}");
        assert_eq!(items[0].id, id, "frame {n}: the hook's card stays");
        assert!(items[0].sources.contains("hook"));
    }
    let f = frame("OTHER.txt");
    q.screen("s", f.0, f.1, f.2, 500_000).unwrap();
    assert!(
        q.decision(&id).is_err(),
        "another file's prompt is another request"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_local_slash_command_ends_its_turn_without_a_stop() {
    // W35 look v23 S2-1: `/effort ultracode on` gets Claude's local answer and no model turn, so no Stop ever comes.
    use nunchiro_core::waiting::transcript::events;
    let home = home("local-command");
    let mut queue = Queue::open(&home).unwrap();
    queue.register("s", AgentKind::Claude, 1000).unwrap();
    let feed = |queue: &mut Queue, record: serde_json::Value, now: u64| {
        for (event, payload) in events(AgentKind::Claude, &record) {
            queue
                .observe("s", &event, &payload, "transcript", now)
                .unwrap();
        }
    };
    let user = |text: &str| json!({"type":"user","message":{"role":"user","content":text}});
    // From the transcript alone.
    feed(
        &mut queue,
        user(
            "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>ultracode on</command-args>",
        ),
        2000,
    );
    assert!(queue.attention("s").working);
    feed(
        &mut queue,
        user("<local-command-stdout>Ultracode on (this session only)</local-command-stdout>"),
        2100,
    );
    assert!(!queue.attention("s").working, "idle again");
    // A hook's UserPromptSubmit for the command, then the transcript's records.
    queue
        .observe(
            "s",
            "UserPromptSubmit",
            &json!({"prompt":"/effort ultracode off"}),
            "hook",
            3000,
        )
        .unwrap();
    feed(
        &mut queue,
        user("<command-name>/effort</command-name>"),
        3100,
    );
    feed(
        &mut queue,
        user("<local-command-stdout>Ultracode off.</local-command-stdout>"),
        3200,
    );
    assert!(
        !queue.attention("s").working,
        "idle again after the hook's turn"
    );
    // A model turn is not ended by a command typed while it works (`/fast` runs then).
    queue
        .observe(
            "s",
            "UserPromptSubmit",
            &json!({"prompt":"fix the bug"}),
            "hook",
            4000,
        )
        .unwrap();
    feed(&mut queue, user("<command-name>/fast</command-name>"), 4100);
    feed(
        &mut queue,
        user("<local-command-stdout>Fast mode ON</local-command-stdout>"),
        4200,
    );
    assert!(queue.attention("s").working, "the model turn still works");
    let _ = fs::remove_dir_all(&home);
}

/// One permission request is one card with one id. Claude runs its PreToolUse hook, draws its dialog, then runs the
/// held PermissionRequest hook: a screen read in between used to raise a screen card, and the hook's item replaced it
/// under a new id (a prompt the screen cannot prove, here a frame with no dashed body rules, never merges), so the
/// owner's answer on the first card found nothing. With no hook after the window, the screen card still comes.
#[test]
fn a_dialog_drawn_before_its_held_hook_is_one_card_with_one_id() {
    use nunchiro_core::waiting::screen::Screen;
    let frame = {
        let mut screen = Screen::new(160, 50);
        screen.feed(
            "\x1b[2J\x1b[H> [trial perm 1] make a folder\r\n\u{25cf} Bash(mkdir trial-1)\r\nBash command\r\n  mkdir trial-1\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n"
                .as_bytes(),
        );
        screen.detect(AgentKind::Claude).unwrap()
    };
    assert_eq!(frame.kind, nunchiro_core::queue::Kind::Permission);
    let call = json!({"tool_name":"Bash","tool_input":{"command":"mkdir trial-1"}});
    let dir = home("dialog-before-hook");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "UserPromptSubmit",
        &json!({"prompt":"[trial perm 1] make a folder"}),
        "hook",
        10,
    )
    .unwrap();
    q.observe("s", "PreToolUse", &call, "hook", 20).unwrap();
    let mut ids = std::collections::BTreeSet::new();
    for at in [30, 60, 90] {
        q.screen(
            "s",
            frame.kind.clone(),
            frame.text.clone(),
            frame.choices.clone(),
            at,
        )
        .unwrap();
        ids.extend(q.items_of("s").into_iter().map(|i| i.id));
    }
    let mut held = call.clone();
    held["nunchiro_event_id"] = json!("e1");
    q.observe("s", "PermissionRequest", &held, "hook", 120)
        .unwrap();
    q.screen(
        "s",
        frame.kind.clone(),
        frame.text.clone(),
        frame.choices.clone(),
        150,
    )
    .unwrap();
    let items = q.items_of("s");
    ids.extend(items.iter().map(|i| i.id.clone()));
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(ids.len(), 1, "the request showed under {} ids", ids.len());
    assert_eq!(
        items[0].hook_event_id.as_deref(),
        Some("e1"),
        "the card answers through the hook"
    );
    let _ = fs::remove_dir_all(&dir);
    // A PreToolUse with no PermissionRequest after it (no hook installed, or it failed): the dialog's card comes once
    // the wait is over.
    let dir = home("dialog-no-hook");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe("s", "PreToolUse", &call, "hook", 20).unwrap();
    q.screen(
        "s",
        frame.kind.clone(),
        frame.text.clone(),
        frame.choices.clone(),
        20 + 10_000,
    )
    .unwrap();
    assert_eq!(q.items_of("s").len(), 1);
    let _ = fs::remove_dir_all(&dir);
}

/// The wait for a held hook is bounded from the first frame it hid: tool calls that go on (a subagent's, a sibling
/// call's PreToolUse every 2 s) never keep a dialog with no hook item from its card. The first read 4 s after the
/// first hidden frame makes the card; the core's tick reads the screen at that moment, so the card comes within the
/// 5 s the trial allows a dialog with no card. The wait cannot grow much past this.
#[test]
fn a_dialog_with_no_hook_gets_its_card_within_the_bound_while_tools_go_on() {
    use nunchiro_core::waiting::screen::Screen;
    let frame = {
        let mut screen = Screen::new(160, 50);
        screen.feed(
            "\x1b[2J\x1b[H\u{25cf} Bash(mkdir x)\r\nBash command\r\n  mkdir x\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n"
                .as_bytes(),
        );
        screen.detect(AgentKind::Claude).unwrap()
    };
    let dir = home("dialog-busy-tools");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe("s", "UserPromptSubmit", &json!({"prompt":"go"}), "hook", 1)
        .unwrap();
    q.observe(
        "s",
        "PreToolUse",
        &json!({"tool_name":"Bash","tool_input":{"command":"mkdir x"}}),
        "hook",
        1000,
    )
    .unwrap();
    let first_frame = 1100;
    let mut card = None;
    for at in (first_frame..first_frame + 30_000).step_by(100) {
        if at % 2000 == 0 {
            let pre =
                json!({"tool_name":"Read","tool_input":{"file_path":"/tmp/a"},"agent_id":"bg-1"});
            q.observe("s", "PreToolUse", &pre, "hook", at).unwrap();
        }
        q.screen(
            "s",
            frame.kind.clone(),
            frame.text.clone(),
            frame.choices.clone(),
            at,
        )
        .unwrap();
        if !q.items_of("s").is_empty() {
            card = Some(at);
            break;
        }
    }
    let card = card.expect("no card in 30 s while tools went on");
    assert!(
        card - first_frame <= 4000,
        "card {} ms after the first hidden frame",
        card - first_frame
    );
    let _ = fs::remove_dir_all(&dir);
}

/// A permission item restored from before a restart (reconciled, answers nothing) does not turn the wait off: the
/// next request is still one card with one id.
#[test]
fn a_restored_permission_item_keeps_the_next_request_one_card() {
    use nunchiro_core::waiting::screen::Screen;
    let frame = {
        let mut screen = Screen::new(160, 50);
        screen.feed(
            "\x1b[2J\x1b[H\u{25cf} Bash(mkdir new)\r\nBash command\r\n  mkdir new\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n"
                .as_bytes(),
        );
        screen.detect(AgentKind::Claude).unwrap()
    };
    let dir = home("restored-then-new");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe(
        "s",
        "PermissionRequest",
        &json!({"tool_name":"Bash","tool_input":{"command":"mkdir old"},"nunchiro_event_id":"old"}),
        "hook",
        10,
    )
    .unwrap();
    drop(q);
    let mut q = Queue::open(&dir).unwrap();
    assert!(q.items_of("s")[0].reconciled);
    let call = json!({"tool_name":"Bash","tool_input":{"command":"mkdir new"}});
    q.observe("s", "PreToolUse", &call, "hook", 1000).unwrap();
    let mut ids = std::collections::BTreeSet::new();
    q.screen(
        "s",
        frame.kind.clone(),
        frame.text.clone(),
        frame.choices.clone(),
        1050,
    )
    .unwrap();
    let live = |q: &Queue| {
        q.items_of("s")
            .into_iter()
            .filter(|i| !i.reconciled)
            .map(|i| i.id)
            .collect::<Vec<_>>()
    };
    ids.extend(live(&q));
    let mut held = call.clone();
    held["nunchiro_event_id"] = json!("new");
    q.observe("s", "PermissionRequest", &held, "hook", 1100)
        .unwrap();
    ids.extend(live(&q));
    assert_eq!(
        ids.len(),
        1,
        "the new request showed under {} ids",
        ids.len()
    );
    let _ = fs::remove_dir_all(&dir);
}

/// A held hook that starts late (a busy Mac: 3.5 s after its dialog was first read) is still one card with one id,
/// while the screen is read again and again meanwhile.
#[test]
fn a_hook_3_5_s_after_its_dialog_is_still_one_card_with_one_id() {
    use nunchiro_core::waiting::screen::Screen;
    let frame = {
        let mut screen = Screen::new(160, 50);
        screen.feed(
            "\x1b[2J\x1b[H\u{25cf} Bash(mkdir x)\r\nBash command\r\n  mkdir x\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n"
                .as_bytes(),
        );
        screen.detect(AgentKind::Claude).unwrap()
    };
    let call = json!({"tool_name":"Bash","tool_input":{"command":"mkdir x"}});
    let dir = home("dialog-late-hook");
    let mut q = Queue::open(&dir).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    q.observe("s", "UserPromptSubmit", &json!({"prompt":"go"}), "hook", 1)
        .unwrap();
    q.observe("s", "PreToolUse", &call, "hook", 1000).unwrap();
    let first_frame = 1100;
    let mut ids = std::collections::BTreeSet::new();
    for at in (first_frame..=first_frame + 3500 + 100).step_by(100) {
        if at == first_frame + 3500 {
            let mut held = call.clone();
            held["nunchiro_event_id"] = json!("late");
            q.observe("s", "PermissionRequest", &held, "hook", at)
                .unwrap();
        }
        q.screen(
            "s",
            frame.kind.clone(),
            frame.text.clone(),
            frame.choices.clone(),
            at,
        )
        .unwrap();
        ids.extend(q.items_of("s").into_iter().map(|i| i.id));
    }
    let items = q.items_of("s");
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(ids.len(), 1, "the request showed under {} ids", ids.len());
    assert_eq!(items[0].hook_event_id.as_deref(), Some("late"));
    let _ = fs::remove_dir_all(&dir);
}
