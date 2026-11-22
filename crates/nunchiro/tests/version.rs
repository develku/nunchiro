//! F1: `--version` carries the build's git sha when the build had git.
use std::process::Command;

#[test]
fn version_names_the_build_sha() {
    let out = Command::new(env!("CARGO_BIN_EXE_nunchiro"))
        .arg("--version")
        .env_remove("NUNCHIRO_HOME")
        .output()
        .unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let want = format!("nunchiro {}", env!("CARGO_PKG_VERSION"));
    let line = text.trim();
    assert!(line.starts_with(&want), "{line}");
    match option_env!("NUNCHIRO_GIT_SHA") {
        Some(sha) => assert_eq!(line, format!("{want} ({sha})")),
        None => assert_eq!(line, want),
    }
}
