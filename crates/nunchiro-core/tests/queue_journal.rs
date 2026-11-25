use nunchiro_core::{
    api::AgentKind,
    queue::{
        Queue,
        journal::{self, Event},
        now_ms,
    },
};
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
fn home(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("j-{name}-{}", std::process::id()));
    fs::create_dir_all(&p).unwrap();
    p
}
#[test]
fn replay_is_idempotent_and_files_are_private() {
    let h = home("replay");
    let mut q = Queue::open(&h).unwrap();
    q.register("s", AgentKind::Claude, 0).unwrap();
    let e = Event::new(
        "s".into(),
        "PermissionRequest".into(),
        json!({"tool_name":"Bash"}),
    )
    .unwrap();
    let p = journal::write(&h, &e).unwrap();
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(h.join("hook-journal"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    q.replay(&e).unwrap();
    let id = q.items()[0].id.clone();
    drop(q);
    let mut q = Queue::open(&h).unwrap();
    q.replay(&e).unwrap();
    assert_eq!(q.items().len(), 1);
    assert_eq!(q.items()[0].id, id);
    assert!(!q.items()[0].actionable);
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn invalid_or_newer_event_is_preserved_and_old_event_expires() {
    let h = home("invalid");
    fs::create_dir_all(h.join("hook-journal")).unwrap();
    let p = h.join("hook-journal/bad.json");
    for text in [
        "[]",
        r#"{"version":2,"event_id":"bad","session_id":"s","event":"Stop","payload":{},"created":0}"#,
    ] {
        fs::write(&p, text).unwrap();
        assert!(journal::read(&h, 1).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), text);
    }
    fs::remove_file(p).unwrap();
    let mut e = Event::new("s".into(), "Stop".into(), json!({})).unwrap();
    e.created = 1;
    let p = journal::write(&h, &e).unwrap();
    assert!(
        journal::read(&h, journal::MAX_AGE_MS + 2)
            .unwrap()
            .is_empty()
    );
    assert!(!p.exists());
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn credentials_are_not_retained_in_hook_journal() {
    let h = home("redact");
    let e=Event::new("s".into(),"PermissionRequest".into(),json!({"token":"never-store","authorization":"never-store","tool_input":{"api_key":"never-store","command":"pwd"}})).unwrap();
    let p = journal::write(&h, &e).unwrap();
    assert!(!fs::read_to_string(p).unwrap().contains("never-store"));
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn quarantine_stays_within_cap_across_starts() {
    let h = home("cap");
    let dir = h.join("hook-journal");
    fs::create_dir_all(&dir).unwrap();
    for start in 0..3 {
        for n in 0..100 {
            fs::write(dir.join(format!("m{start}-{n}.json")), b"{broken").unwrap();
        }
        let (_, rejected) = journal::recover(&h, 1).unwrap();
        assert!(rejected >= 100);
        let count = fs::read_dir(h.join("hook-journal-quarantine"))
            .unwrap()
            .count();
        assert!(count <= journal::QUARANTINE_MAX_FILES, "{count} files");
    }
    // Byte cap: oversized rejects (300 KiB each) are pruned oldest-first to 8 MiB.
    for n in 0..40 {
        fs::write(dir.join(format!("big{n}.json")), vec![b'x'; 300 * 1024]).unwrap();
    }
    journal::recover(&h, 1).unwrap();
    let bytes: u64 = fs::read_dir(h.join("hook-journal-quarantine"))
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(bytes <= journal::QUARANTINE_MAX_BYTES, "{bytes} bytes");
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn malformed_journal_file_does_not_block_hook_writes() {
    let h = home("lenient");
    let dir = h.join("hook-journal");
    fs::create_dir_all(&dir).unwrap();
    let bad = dir.join("bad.json");
    fs::write(&bad, b"{broken").unwrap();
    let e = Event::new("s".into(), "Stop".into(), json!({})).unwrap();
    let p = journal::write(&h, &e).unwrap();
    assert!(p.exists());
    assert_eq!(fs::read(&bad).unwrap(), b"{broken");
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn single_oversized_reject_is_kept_and_non_files_are_skipped() {
    let h = home("big1");
    let dir = h.join("hook-journal");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(h.join("hook-journal-quarantine/subdir")).unwrap();
    fs::write(dir.join("huge.json"), vec![b'x'; 9 * 1024 * 1024]).unwrap();
    journal::recover(&h, 1).unwrap();
    let kept = fs::read_dir(h.join("hook-journal-quarantine"))
        .unwrap()
        .count();
    assert_eq!(kept, 2); // the reject and the untouched subdir
    fs::remove_dir_all(h).unwrap();
}
// V2.5-41 (audit B14): the agent's own SessionStart, replayed with its `nunchiro_created` stamp.
fn event(id: &str, kind: &str, payload: serde_json::Value, created: u64) -> Event {
    Event {
        version: 1,
        event_id: id.into(),
        session_id: "s".into(),
        event: kind.into(),
        payload,
        created,
    }
}
#[test]
fn agent_sessionstart_does_not_order_out_turn_hooks() {
    // Ticket 1094: a journaled prompt 5 min old starts no turn, so the turn is stamped now, not in 1970.
    let t = now_ms();
    let h = home("agent-start");
    let mut q = Queue::open(&h).unwrap();
    q.register("s", AgentKind::Codex, 0).unwrap();
    q.replay(&event(
        "e0",
        "SessionStart",
        json!({"session_id":"a"}),
        t + 100,
    ))
    .unwrap();
    q.replay(&event("e1", "UserPromptSubmit", json!({"turn_id":"t1"}), t))
        .unwrap();
    q.replay(&event("e2", "Stop", json!({"turn_id":"t1"}), t + 1))
        .unwrap();
    assert_eq!(q.attention("s").completion_seq, 1);
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn replayed_turn_after_sessionstart_counts_once() {
    // Ticket 1094: a journaled prompt 5 min old starts no turn, so the turn is stamped now, not in 1970.
    let t = now_ms();
    let h = home("replay-once");
    let mut q = Queue::open(&h).unwrap();
    q.register("s", AgentKind::Codex, 0).unwrap();
    let turn = [
        event("e1", "UserPromptSubmit", json!({"turn_id":"t1"}), t),
        event("e2", "Stop", json!({"turn_id":"t1"}), t + 1),
    ];
    q.replay(&event(
        "e0",
        "SessionStart",
        json!({"session_id":"a"}),
        t + 100,
    ))
    .unwrap();
    for e in &turn {
        q.replay(e).unwrap();
    }
    for e in &turn {
        q.replay(e).unwrap();
    }
    // The same events again after a core restart, and the same Stop from the transcript.
    drop(q);
    let mut q = Queue::open(&h).unwrap();
    for e in &turn {
        q.replay(e).unwrap();
    }
    q.observe("s", "Stop", &json!({"turn_id":"t1"}), "transcript", t + 2)
        .unwrap();
    assert_eq!(q.attention("s").completion_seq, 1);
    fs::remove_dir_all(h).unwrap();
}
#[test]
fn future_stamped_sessionstart_cannot_mute_turns() {
    // Ticket 1094: a journaled prompt 5 min old starts no turn, so the turn is stamped now, not in 1970.
    let t = now_ms();
    let h = home("future-start");
    let mut q = Queue::open(&h).unwrap();
    q.register("s", AgentKind::Codex, 0).unwrap();
    q.register("o", AgentKind::Codex, 0).unwrap();
    q.replay(&event(
        "e0",
        "SessionStart",
        json!({"session_id":"a"}),
        u64::MAX / 2,
    ))
    .unwrap();
    q.replay(&event("e1", "UserPromptSubmit", json!({"turn_id":"t1"}), t))
        .unwrap();
    q.replay(&event("e2", "Stop", json!({"turn_id":"t1"}), t + 1))
        .unwrap();
    assert_eq!(q.attention("s").completion_seq, 1);
    // Another session's clock is its own.
    let mut other = event("e3", "UserPromptSubmit", json!({"turn_id":"t1"}), t);
    other.session_id = "o".into();
    q.replay(&other).unwrap();
    assert!(q.attention("o").working);
    fs::remove_dir_all(h).unwrap();
}
