//! Public preview seam: bounded history without changing existing handoff callers.
use nunchiro_core::chat::handoff;
use serde_json::json;
use std::path::Path;

#[test]
fn side_chat_last_five_turns_excludes_older_requests_results_and_files() {
    let mut events = vec![];
    for n in 1..=7 {
        events.extend([
            json!({"kind":"message","role":"user","text":format!("request-{n}")}),
            json!({"kind":"edit","path":format!("/project/file-{n}"),"added":1,"removed":0}),
            json!({"kind":"final_text","text":format!("result-{n}")}),
            json!({"kind":"turn","state":"completed"}),
        ]);
    }
    let h = handoff::build_last_five(&events, "Claude", "source", Path::new("/project"), false);
    assert_eq!((h.prompts, h.files), (5, 5));
    for n in 1..=2 {
        for label in ["request", "result", "file"] {
            assert!(!h.text.contains(&format!("{label}-{n}")), "{}", h.text);
        }
    }
    assert!(h.text.contains("request-3") && h.text.contains("result-7"));
    assert!(h.text.contains("5 turns"));
    let normal = handoff::build(&events, "Claude", "source", Path::new("/project"), false);
    assert_eq!(normal.prompts, 7, "legacy handoff stays unbounded");
}

#[test]
fn side_chat_last_five_empty_short_and_switch_boundaries() {
    let events = [
        json!({"kind":"message","role":"user","text":"before-switch"}),
        json!({"kind":"switch"}),
        json!({"kind":"message","role":"user","text":"current"}),
    ];
    let h = handoff::build_last_five(&events, "Codex", "source", Path::new("/project"), false);
    assert_eq!(h.prompts, 1);
    assert!(!h.text.contains("before-switch"));
    assert!(h.text.contains("current"));
    let empty = handoff::build_last_five(&[], "Claude", "empty", Path::new("/project"), false);
    assert_eq!((empty.prompts, empty.files), (0, 0));
}
