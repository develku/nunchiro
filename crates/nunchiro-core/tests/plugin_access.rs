// A plugin is approved for what it can reach, not only for its bytes (docs/plugins.md, Approval and the switch): a
// change that asks for nothing new (its scripts, its titles) stays approved and says it was updated; a change that
// adds a part, a host, a folder it reads or a check asks again and lists what is new. An approval stored before
// access was recorded asks again on any change.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::approval::{self, Level, State};
use std::fs;
use std::path::Path;

const MANIFEST: &str = "id = \"hello\"\nname = \"Hello\"\nversion = \"1.0.0\"\nabout = \"Says hello.\"\n\n[[command]]\nname = \"hi\"\ncommand = [\"/bin/sh\", \"hi.sh\"]\nshow = \"note\"\n";
const NAME: &str = "plugin:hello";

fn plugin(home: &Path, manifest: &str, script: &str) {
    let dir = home.join("plugins/hello");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.toml"), manifest).unwrap();
    fs::write(dir.join("hi.sh"), script).unwrap();
}
fn approve(home: &Path) {
    let view = approval::status(home, NAME).unwrap();
    approval::grant(home, NAME, Level::Read, &view.hash).unwrap();
}

#[test]
fn a_change_that_asks_for_nothing_new_stays_approved() {
    let home = home::short("pa1");
    plugin(&home, MANIFEST, "echo hello\n");
    approve(&home);
    plugin(
        &home,
        &MANIFEST.replace("Says hello.", "Says hello, louder."),
        "echo HELLO\n",
    );
    let view = approval::status(&home, NAME).unwrap();
    assert_eq!(view.state, State::Approved);
    assert!(view.updated, "it says it changed since the approval");
    assert!(view.added.is_empty());
    approval::check(&home, "plugin__hello__hi").expect("its command runs");
}

#[test]
fn a_change_that_adds_access_asks_again_and_says_what_is_new() {
    let home = home::short("pa2");
    plugin(&home, MANIFEST, "echo hello\n");
    approve(&home);
    let more = MANIFEST.replace(
        "show = \"note\"\n",
        "show = \"note\"\nnetwork = [\"example.com\"]\n\n[[command]]\nname = \"bye\"\ncommand = [\"/bin/sh\", \"hi.sh\"]\nshow = \"note\"\n",
    );
    plugin(&home, &more, "echo hello\n");
    let view = approval::status(&home, NAME).unwrap();
    assert_eq!(view.state, State::Changed);
    assert_eq!(
        view.added,
        ["command bye", "command hi reaches example.com"],
        "{:?}",
        view.added
    );
    assert!(approval::check(&home, "plugin__hello__hi").is_err());
    // Approving the new access approves it.
    approve(&home);
    assert_eq!(
        approval::status(&home, NAME).unwrap().state,
        State::Approved
    );
}

#[test]
fn an_approval_from_before_access_was_recorded_asks_again_on_any_change() {
    let home = home::short("pa3");
    plugin(&home, MANIFEST, "echo hello\n");
    approve(&home);
    // The store as an older Nunchiro wrote it: the hash alone.
    let file = home.join("approvals.json");
    let mut stored: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    for a in stored["approvals"].as_array_mut().unwrap() {
        a.as_object_mut().unwrap().remove("access");
    }
    fs::write(&file, stored.to_string()).unwrap();
    plugin(&home, MANIFEST, "echo HELLO\n");
    assert_eq!(approval::status(&home, NAME).unwrap().state, State::Changed);
}
