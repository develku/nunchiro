// V2.5-34 capability_narrow: the window may open the folder picker and nothing else from the dialog plugin
// (no save, message, ask, confirm). Tauri cannot limit "open" to folders; the web side always asks for a directory.
#[test]
fn dialog_grant_is_open_only() {
    let text = include_str!("../capabilities/default.json");
    let json: serde_json::Value = serde_json::from_str(text).unwrap();
    let dialog: Vec<&str> = json["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p.as_str())
        .filter(|p| p.starts_with("dialog:"))
        .collect();
    assert_eq!(dialog, ["dialog:allow-open"]);
    assert!(!text.contains("dialog:default"));
}
