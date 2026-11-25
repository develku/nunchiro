//! Ticket 1130 (3.2): a debug build without NUNCHIRO_HOME never opens the owner's `~/.nunchiro`.
use std::os::unix::net::UnixListener;
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;

#[test]
fn a_debug_build_without_nunchiro_home_keeps_off_the_user_home() {
    let user = home::short("dev-home");
    let owner = user.join(".nunchiro");
    std::fs::create_dir_all(&owner).unwrap();
    // A "core" listening in the user's default home: a debug build must not see it.
    let _core = UnixListener::bind(owner.join("core.sock")).unwrap();
    let out = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["serve", "status"])
        .env_remove("NUNCHIRO_HOME")
        .env_remove("NUNCHIRO_TOKEN")
        .env("HOME", &user)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{text} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(text.contains(r#""core":false"#), "{text}");
}
