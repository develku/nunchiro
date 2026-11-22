use nunchiro_core::{api::*, chat::Store};
use serde_json::json;
use std::{fs, path::PathBuf};

fn home(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("chat-{name}-{}", std::process::id()));
    fs::create_dir_all(&p).unwrap();
    p.canonicalize().unwrap()
}
#[test]
fn chat_unknown_version_keeps_each_turn_and_queue_on_restart() {
    let home = home("unknown");
    let mut store = Store::open(&home, "session-1").unwrap();
    store.stop("turn-1", "first").unwrap();
    store.stop("turn-1", "first").unwrap();
    store.stop("turn-2", "second").unwrap();
    drop(store);
    let store = Store::open(&home, "session-1").unwrap();
    let page = store
        .page(AgentKind::Claude, Some("2.1.310 (Claude Code)"), &[], None)
        .unwrap();
    assert_eq!(page.events.len(), 3);
    assert_eq!(
        page.events[0].data,
        json!({"kind":"version_banner","agent":"claude","version":"2.1.310 (Claude Code)"})
    );
    assert_eq!(
        page.events[1].data,
        json!({"kind":"final_text","turn_id":"turn-1","text":"first"})
    );
    assert_eq!(
        page.events[2].data,
        json!({"kind":"final_text","turn_id":"turn-2","text":"second"})
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_cache_rejects_broken_and_newer_stores_without_rewriting() {
    let home = home("broken");
    let mut s = Store::open(&home, "session-1").unwrap();
    s.stop("turn-1", "done").unwrap();
    drop(s);
    let path = home.join("chat/session-1.json");
    let good: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for bad in [
        json!([]),
        json!({"version":"1"}),
        {
            let mut v = good.clone();
            v["version"] = json!(99);
            v
        },
        {
            let mut v = good.clone();
            v["offset"] = json!(1);
            v
        },
        {
            let mut v = good.clone();
            v["finals"] = json!([["same", "a"], ["same", "b"]]);
            v
        },
    ] {
        let bytes = serde_json::to_vec(&bad).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(Store::open(&home, "session-1").is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_readonly_tail_restart_partial_line_and_skipped_count() {
    use std::os::unix::fs::PermissionsExt;
    let home = home("tail");
    let path = home.join("fixture.jsonl");
    let original=b"{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\nnot json\n{\"type\":\"future\",\"message\":{}}\n{\"type\":\"assistant\"";
    fs::write(&path, original).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    drop(s);
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    let page = s
        .page(
            AgentKind::Claude,
            Some("2.1.310 (Claude Code)"),
            nunchiro_core::chat::TESTED_VERSIONS,
            None,
        )
        .unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events[1].data, json!({"kind":"skipped","count":2}));
    assert_eq!(
        fs::metadata(home.join("chat/session-1.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(home.join("chat"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_unknown_version_banner_stays_available_on_newest_and_older_pages() {
    let home = home("banner");
    let mut s = Store::open(&home, "session-1").unwrap();
    for i in 0..205 {
        s.stop(&format!("turn-{i}"), "done").unwrap();
    }
    let page = s
        .page(AgentKind::Claude, Some("future"), &[], None)
        .unwrap();
    assert_eq!(page.events.len(), 200);
    assert_eq!(page.banner.unwrap().data["kind"], "version_banner");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_cache_rejects_invalid_event_data_without_rewriting() {
    let home = home("bad-event");
    let mut s = Store::open(&home, "session-1").unwrap();
    s.stop("turn-1", "done").unwrap();
    drop(s);
    let path = home.join("chat/session-1.json");
    let mut disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    disk["feed"]["events"] = json!([{"schema_version":1,"cursor":1,"data":{"kind":"message","role":"assistant","text":9}}]);
    let bytes = serde_json::to_vec(&disk).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(Store::open(&home, "session-1").is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_malformed_interrupted_turn_cannot_poison_cache() {
    let home = home("invalid-turn");
    let path = home.join("fixture.jsonl");
    fs::write(
        &path,
        json!({"type":"user","uuid":9,"message":{"content":"[Request interrupted by user]"}})
            .to_string()
            + "\n",
    )
    .unwrap();
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    drop(s);
    let s = Store::open(&home, "session-1").unwrap();
    let page = s
        .page(
            AgentKind::Claude,
            Some("2.1.310 (Claude Code)"),
            nunchiro_core::chat::TESTED_VERSIONS,
            None,
        )
        .unwrap();
    assert_eq!(page.events[0].data, json!({"kind":"skipped","count":1}));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_replacement_shrink_and_growing_rewrite_start_new_generations() {
    let home = home("generation");
    let path = home.join("fixture.jsonl");
    let line = |text: &str| json!({"type":"user","message":{"content":text}}).to_string() + "\n";
    fs::write(&path, line("first")).unwrap();
    let mut s = Store::open(&home, "session-1").unwrap();
    let mut last = 0;
    for text in [
        "first",
        "replacement",
        "x",
        "same inode rewrite grows well beyond old end",
    ] {
        if text == "replacement" {
            fs::rename(&path, home.join("old.jsonl")).unwrap();
        }
        fs::write(&path, line(text)).unwrap();
        s.refresh(AgentKind::Claude, &path).unwrap();
        let page = s
            .page(
                AgentKind::Claude,
                Some("2.1.310 (Claude Code)"),
                nunchiro_core::chat::TESTED_VERSIONS,
                None,
            )
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].data["text"], text);
        assert!(page.generation > last);
        last = page.generation;
    }
    drop(s);
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    assert_eq!(s.generation(), last);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_legacy_cache_streams_history_and_preserves_stop_texts() {
    let home = home("legacy");
    fs::create_dir_all(home.join("chat")).unwrap();
    let path = home.join("chat/session-1.json");
    fs::write(&path,json!({"version":1,"feed":{"events":[{"schema_version":1,"cursor":1,"data":{"kind":"message","role":"user","text":"old history"}}]},"key":"","offset":0,"discarding":false,"finals":[["turn-1","old final"]],"extension":true}).to_string()).unwrap();
    let mut s = Store::open(&home, "session-1").unwrap();
    s.stop("turn-1", "duplicate").unwrap();
    let page = s
        .page(
            AgentKind::Claude,
            Some("2.1.310 (Claude Code)"),
            nunchiro_core::chat::TESTED_VERSIONS,
            None,
        )
        .unwrap();
    assert_eq!(page.events[0].data["text"], "old history");
    let page = s.page(AgentKind::Claude, None, &[], None).unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events[1].data["text"], "old final");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap()["extension"],
        true
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_restart_pages_past_a_byte_limited_resident_tail() {
    let home = home("large-tail");
    let path = home.join("fixture.jsonl");
    let line = json!({"type":"user","message":{"content":"x".repeat(11000)}}).to_string() + "\n";
    fs::write(
        &path,
        line.repeat(199) + &json!({"type":"user","message":{"content":"last"}}).to_string() + "\n",
    )
    .unwrap();
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    drop(s);
    let s = Store::open(&home, "session-1").unwrap();
    let page = s
        .since(
            AgentKind::Claude,
            Some("2.1.310 (Claude Code)"),
            nunchiro_core::chat::TESTED_VERSIONS,
            199,
        )
        .unwrap();
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].data["text"], "last");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_duplicate_legacy_history_fields_are_rejected_without_rewrite() {
    let home = home("duplicate-legacy");
    fs::create_dir_all(home.join("chat")).unwrap();
    let path = home.join("chat/session-1.json");
    let bytes=br#"{"version":1,"key":"","offset":0,"discarding":false,"feed":{"events":[]},"feed":{"events":[]},"finals":[]}"#;
    fs::write(&path, bytes).unwrap();
    assert!(Store::open(&home, "session-1").is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir_all(home).unwrap();
}

/// Ticket 383: a real codex-cli 0.162.1 rollout reaches the chat page, and a cache indexed before the injected-block
/// filter is read again, so a resumed session loses the bubbles it had stored.
#[test]
fn codex_0_162_reply_reaches_the_page_and_an_old_cache_rereads() {
    let home = home("codex-162");
    let rollout = home.join("rollout.jsonl");
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat/codex-0.162.1/transcript.jsonl"),
        &rollout,
    )
    .unwrap();
    let read = |store: &Store| {
        store
            .page(
                AgentKind::Codex,
                Some("codex-cli 0.162.1"),
                nunchiro_core::chat::TESTED_VERSIONS,
                None,
            )
            .unwrap()
    };
    let mut store = Store::open(&home, "session-1").unwrap();
    store.refresh(AgentKind::Codex, &rollout).unwrap();
    let page = read(&store);
    assert!(page.banner.is_none(), "0.162 is a tested version");
    let replies = page
        .events
        .iter()
        .filter(|e| e.data["kind"] == "message" && e.data["role"] == "assistant")
        .count();
    assert_eq!(replies, 2);
    let before = store.generation();
    drop(store);
    let meta = home.join("chat/session-1.json");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("codex_injected");
    fs::write(&meta, serde_json::to_vec(&state).unwrap()).unwrap();
    let mut store = Store::open(&home, "session-1").unwrap();
    store.refresh(AgentKind::Codex, &rollout).unwrap();
    assert_eq!(
        store.generation(),
        before + 1,
        "the old cache is read again"
    );
    assert_eq!(read(&store).events.len(), page.events.len());
    fs::remove_dir_all(home).unwrap();
}

/// Ticket 409: a cache written when bookkeeping records counted as skipped re-reads once, and the count drops to the
/// lines really left out; the re-read cache keeps its count and is not read again.
#[test]
fn chat_old_skipped_count_rereads_once() {
    let home = home("skip-409");
    let path = home.join("fixture.jsonl");
    fs::write(
        &path,
        "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n{\"type\":\"ai-title\"}\nnot json\n",
    )
    .unwrap();
    let mut store = Store::open(&home, "session-1").unwrap();
    store.refresh(AgentKind::Claude, &path).unwrap();
    let skipped = |store: &Store| {
        store
            .page(
                AgentKind::Claude,
                Some("2.1.310 (Claude Code)"),
                nunchiro_core::chat::TESTED_VERSIONS,
                None,
            )
            .unwrap()
            .skipped
    };
    assert_eq!(skipped(&store), 1, "only the unreadable line");
    let before = store.generation();
    drop(store);
    let meta = home.join("chat/session-1.json");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("skip_409");
    state["skipped"] = json!(31);
    fs::write(&meta, serde_json::to_vec(&state).unwrap()).unwrap();
    let mut store = Store::open(&home, "session-1").unwrap();
    store.refresh(AgentKind::Claude, &path).unwrap();
    assert_eq!(
        store.generation(),
        before + 1,
        "the old cache is read again"
    );
    assert_eq!(skipped(&store), 1);
    store.refresh(AgentKind::Claude, &path).unwrap();
    assert_eq!(store.generation(), before + 1, "once");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn chat_open_turn_with_long_paths_still_reopens() {
    // Q9 ja-J19-1: 200 long paths in an open turn once made a state file the next open refused (64 KiB limit).
    let home = home("longpaths");
    let path = home.join("fixture.jsonl");
    let long = "d".repeat(400);
    let lines: Vec<String> = (0..200)
        .map(|i| json!({"type":"assistant","cwd":"/w/p","message":{"content":[{"type":"tool_use","id":format!("t{i}"),"name":"Write","input":{"file_path":format!("/w/p/{long}/f{i}")}}]}}).to_string())
        .collect();
    fs::write(&path, lines.join("\n") + "\n").unwrap();
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    drop(s);
    let mut s = Store::open(&home, "session-1").unwrap();
    s.refresh(AgentKind::Claude, &path).unwrap();
    fs::remove_dir_all(home).unwrap();
}
// The flake in chat_http_rotation_resets_live_cursor_and_history: an agent replacing its transcript (one rename) while
// the chat indexes it must never answer an error, or the window's live watch ends.
#[test]
fn chat_refresh_survives_transcript_rotation_mid_index() {
    let home = home("rotate");
    let path = home.join("rotate.jsonl");
    let line = |text: &str| json!({"type":"user","message":{"content":text}}).to_string() + "\n";
    fs::write(&path, line("first")).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rotator = {
        let (path, stop) = (path.clone(), stop.clone());
        std::thread::spawn(move || {
            let next = path.with_extension("next");
            for i in 0.. {
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                fs::write(&next, line(&format!("generation {i}"))).unwrap();
                fs::rename(&next, &path).unwrap();
            }
        })
    };
    let mut s = Store::open(&home, "session-1").unwrap();
    let errors = (0..500)
        .filter_map(|_| s.refresh(AgentKind::Claude, &path).err())
        .collect::<Vec<_>>();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    rotator.join().unwrap();
    assert!(
        errors.is_empty(),
        "{} of 500 refreshes failed: {:?}",
        errors.len(),
        errors.first()
    );
}
