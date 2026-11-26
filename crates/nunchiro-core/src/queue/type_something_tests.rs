use super::Choice;
/// Home look S2-7: only Claude's free-text row takes words; its digit alone opens the field.
#[test]
fn s2_7_only_the_type_something_row_takes_text() {
    let c = |label: &str| Choice {
        label: label.into(),
        keys: vec!["3".into(), "enter".into()],
        changes_settings: false,
    };
    assert!(c("Type something.").takes_text() && c(" type something ").takes_text());
    assert!(!c("alpha").takes_text() && !c("Chat about this").takes_text());
}
