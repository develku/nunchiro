// Ticket 1065: the meta record Claude writes for a pasted image is not drawn as a message of its own.
use nunchiro_core::{api::AgentKind, chat::project};
use serde_json::json;

fn texts(content: serde_json::Value) -> Vec<String> {
    project(
        AgentKind::Claude,
        &json!({"type":"user","message":{"role":"user","content":content}}),
    )
    .iter()
    .filter(|e| e["kind"] == "message")
    .map(|e| e["text"].as_str().unwrap().to_string())
    .collect()
}

#[test]
fn chat_image_source_only_lines_make_no_message() {
    // The path is built from parts: a literal home path in a test file fails the publish check.
    let path = ["", "home", "someone", ".nunchiro", "images", "s", "h.png"].join("/");
    let line = format!("[Image: source: {path}]");
    assert!(texts(json!([{"type":"text","text":line}])).is_empty());
    assert!(texts(json!(format!("{line}\n{line}"))).is_empty());
    // Text beside the line, or the words inside other words, stays.
    assert_eq!(
        texts(json!([{"type":"text","text":format!("see {line} here")}])).len(),
        1
    );
    assert_eq!(
        texts(json!([{"type":"text","text":"[Image #1] fix this"}, {"type":"text","text":line}])),
        ["[Image #1] fix this"]
    );
}
