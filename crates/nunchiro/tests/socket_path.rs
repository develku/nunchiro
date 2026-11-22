//! v1a-69: a command with a home whose `core.sock` is too long fails with the length, not a log pointer.
use std::fs;
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;

#[test]
fn cli_shows_socket_path_refusal() {
    let base = home::short("cli-long");
    let pad = 104 - base.as_os_str().len() - "/".len() - "/core.sock".len();
    let long = base.join("x".repeat(pad));
    fs::create_dir_all(&long).unwrap();
    let out = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
        .args(["session", "list"])
        .env("NUNCHIRO_HOME", &long)
        .env("HOME", &base)
        .env_remove("NUNCHIRO_TOKEN")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{err}");
    assert!(
        err.contains(long.join("core.sock").to_str().unwrap()),
        "{err}"
    );
    assert!(err.contains("104") && err.contains("103"), "{err}");
    assert!(!err.contains("see logs/core.log"), "{err}");
    fs::remove_dir_all(base).unwrap();
}
