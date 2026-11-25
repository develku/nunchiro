//! Ticket 1094: every real turn end is counted. The fixtures are real record shapes from a lead's night (Claude Code
//! 2.1.330, Code Mode on), cut to the fields the detection reads; every text is "x".
use super::*;

const BACKGROUND: &str = include_str!("fixtures/1094-background-agent.jsonl");
const SCHEDULED: &str = include_str!("fixtures/1094-scheduled-code-mode-turn.jsonl");

fn open(tag: &str) -> (PathBuf, Queue) {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("turn-ends-{tag}-{}", store::new_id().unwrap()));
    fs::create_dir_all(&home).unwrap();
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 1).unwrap();
    (home, q)
}
fn records(text: &str) -> Vec<Value> {
    text.lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
/// Each record read on its own, as the observer reads a growing transcript.
fn read(q: &mut Queue, records: &[Value], now: u64) {
    for r in records {
        let (_, end) = q.transcript_cursor("s");
        q.transcript("s", "fixture".into(), end + 1, std::slice::from_ref(r), now)
            .unwrap();
    }
}
fn live() -> BTreeSet<String> {
    BTreeSet::from(["s".to_string()])
}

/// Cause 1: a background agent launched in turn 1 ends while turn 2 runs; Claude writes that end as a queued command
/// (an attachment), not a user record. Was: turn 1's Stop held for the task, turn 2 started inside it, and no later
/// Stop counted (the lead's night: 0 of 36 turn ends after 18:25).
#[test]
fn a_background_agent_end_in_an_attachment_ends_every_turn() {
    let (home, mut q) = open("bg");
    read(&mut q, &records(BACKGROUND), 1000);
    let a = q.attention("s");
    assert_eq!(
        (a.completion_seq, a.working),
        (3, false),
        "three turns, idle"
    );
    assert!(q.items_of("s").is_empty(), "no background note left");
    fs::remove_dir_all(home).ok();
}

/// Cause 1, the task ending inside the turn that launched it: its end is an attachment too, so the Stop is not held.
#[test]
fn a_task_that_ends_inside_its_turn_does_not_hold_the_stop() {
    let (home, mut q) = open("bg-same");
    let all = records(BACKGROUND);
    // Turn 1 (prompt, launch), the task's end read before turn 1's end records.
    let turn = [&all[0], &all[1], &all[6], &all[2], &all[3], &all[4]].map(Clone::clone);
    read(&mut q, &turn, 1000);
    let a = q.attention("s");
    assert_eq!((a.completion_seq, a.working, a.background), (1, false, 0));
    fs::remove_dir_all(home).ok();
}

/// Not a cause, kept as a guard: a turn a scheduled prompt starts (an isMeta user record) in Code Mode (virtual
/// "stop_sequence" records, ticket 1056) ends once, at its real end.
#[test]
fn a_scheduled_code_mode_turn_ends_once_at_its_end() {
    let (home, mut q) = open("sched");
    let all = records(SCHEDULED);
    read(&mut q, &all[..5], 1000);
    let a = q.attention("s");
    assert_eq!(
        (a.completion_seq, a.working),
        (0, true),
        "virtual records end nothing"
    );
    read(&mut q, &all[5..], 1000);
    let a = q.attention("s");
    assert_eq!((a.completion_seq, a.working), (1, false));
    fs::remove_dir_all(home).ok();
}

/// Cause 2: the replayed-hook id set full (32768 ids, under a day of tool calls) refused every hook, so no hook Stop
/// reached the queue. The oldest quarter goes; the hook is taken.
#[test]
fn a_full_hook_id_set_still_takes_hooks() {
    let (home, mut q) = open("seen");
    q.change(|q| {
        for at in 0..SEEN_MAX as u64 {
            q.disk.seen.insert(store::new_id()?, 1_000_000 + at);
        }
        Ok(())
    })
    .unwrap();
    let event = |name: &str, created: u64| journal::Event {
        version: 1,
        event_id: store::new_id().unwrap(),
        session_id: "s".into(),
        event: name.into(),
        payload: json!({}),
        created,
    };
    let now = now_ms();
    q.replay(&event("UserPromptSubmit", now)).unwrap();
    q.replay(&event("Stop", now + 1)).unwrap();
    let a = q.attention("s");
    assert_eq!((a.completion_seq, a.working), (1, false));
    assert!(q.disk.seen.len() <= SEEN_MAX);
    assert!(Queue::open(&home).is_ok(), "the saved store still opens");
    fs::remove_dir_all(home).ok();
}

/// The self-heal: a Stop held for a task whose end never arrives settles after HELD_STOP_MS, also across a core
/// restart (the held Stop is in queue.json).
#[test]
fn a_held_stop_settles_after_a_restart() {
    let (home, mut q) = open("held");
    let all = records(BACKGROUND);
    read(&mut q, &all[..5], 10_000);
    assert!(q.attention("s").working, "held for the background agent");
    drop(q);
    let mut q = Queue::open(&home).unwrap();
    q.tick(10_000 + HELD_STOP_MS - 1, u64::MAX, &live())
        .unwrap();
    assert!(q.attention("s").working, "not before its time");
    q.tick(10_000 + HELD_STOP_MS, u64::MAX, &live()).unwrap();
    let a = q.attention("s");
    assert_eq!((a.completion_seq, a.working), (1, false));
    assert!(q.items_of("s").is_empty());
    fs::remove_dir_all(home).ok();
}

/// A held Stop with a question open waits for the answer; the self-heal never ends a turn that asks.
#[test]
fn a_held_stop_with_a_question_open_waits() {
    let (home, mut q) = open("held-ask");
    read(&mut q, &records(BACKGROUND)[..5], 10_000);
    q.observe(
        "s",
        "Question",
        &json!({"tool_name":"AskUserQuestion","tool_input":{}}),
        "hook",
        10_001,
    )
    .unwrap();
    q.tick(10_000 + HELD_STOP_MS * 2, u64::MAX, &live())
        .unwrap();
    assert!(q.attention("s").working);
    fs::remove_dir_all(home).ok();
}

/// Review r1 point 3: a Stop held for two background tasks; the first ends and Claude starts a turn by itself (no
/// prompt). Its records and output are activity: the held Stop is not settled while that turn shows any.
#[test]
fn a_turn_claude_starts_by_itself_is_not_settled() {
    let (home, mut q) = open("self-turn");
    q.observe("s", "UserPromptSubmit", &json!({}), "hook", 10_000)
        .unwrap();
    let two =
        json!({"background_tasks":[{"id":"a1","status":"running"},{"id":"a2","status":"running"}]});
    q.observe("s", "Stop", &two, "hook", 10_001).unwrap();
    assert_eq!(q.attention("s").background, 2);
    // a1 ends, told as a queued command; Claude starts working on it by itself.
    let done = json!({"type":"attachment","attachment":{"type":"queued_command",
        "prompt":"<task-notification><task-id>a1</task-id><status>completed</status>"}});
    read(&mut q, &[done], 20_000);
    let result = json!({"type":"user","uuid":"r1","message":{"role":"user",
        "content":[{"type":"tool_result","tool_use_id":"t1"}]}});
    read(&mut q, &[result], 50_000);
    q.activity("s", 65_000).unwrap();
    q.tick(10_001 + HELD_STOP_MS, u64::MAX, &live()).unwrap();
    q.tick(80_000, u64::MAX, &live()).unwrap();
    assert!(
        q.attention("s").working,
        "a turn that shows activity is not settled"
    );
    q.tick(65_000 + HELD_STOP_MS, u64::MAX, &live()).unwrap();
    assert!(
        !q.attention("s").working,
        "settled once it showed none for HELD_STOP_MS"
    );
    fs::remove_dir_all(home).ok();
}

/// Review r1 point 2: a prompt journaled long ago (a hook no core took, replayed at the next start) starts no turn;
/// a fresh one does.
#[test]
fn an_old_journaled_prompt_starts_no_turn() {
    let (home, mut q) = open("old-prompt");
    let event = |created: u64| journal::Event {
        version: 1,
        event_id: store::new_id().unwrap(),
        session_id: "s".into(),
        event: "UserPromptSubmit".into(),
        payload: json!({}),
        created,
    };
    q.replay(&event(now_ms() - 3_600_000)).unwrap();
    assert!(
        !q.attention("s").working,
        "an hour-old prompt says nothing about now"
    );
    q.replay(&event(now_ms())).unwrap();
    assert!(q.attention("s").working);
    fs::remove_dir_all(home).ok();
}

#[cfg(test)]
impl Queue {
    /// Test only: makes the held Stop of `id`, and its last activity, `ms` older.
    pub(crate) fn age_held_stop(&mut self, id: &str, ms: u64) {
        if let Some(s) = self.disk.sessions.get_mut(id) {
            s.stop_at = s.stop_at.saturating_sub(ms);
        }
        self.age_activity(id, ms);
    }
    /// Test only: makes the last activity of `id` `ms` older.
    pub(crate) fn age_activity(&mut self, id: &str, ms: u64) {
        if let Some(s) = self.disk.sessions.get_mut(id) {
            s.attention.last_activity = s.attention.last_activity.saturating_sub(ms);
        }
        if let Some(at) = self.activity.get_mut(id) {
            *at = at.saturating_sub(ms);
        }
    }
}

/// Ticket 1133: a hook that changes only the replayed ids does not rewrite queue.json; `flush` writes them.
#[test]
fn replayed_ids_alone_do_not_rewrite_the_store() {
    let (home, mut q) = open("seen-only");
    let before = fs::read(home.join("queue.json")).unwrap();
    let id = store::new_id().unwrap();
    q.change(|q| {
        q.disk.seen.insert(id.clone(), now_ms());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        fs::read(home.join("queue.json")).unwrap(),
        before,
        "a seen-only change is not saved"
    );
    q.flush().unwrap();
    assert!(
        Queue::open(&home).unwrap().disk.seen.contains_key(&id),
        "flush saves the ids"
    );
    fs::remove_dir_all(home).ok();
}
