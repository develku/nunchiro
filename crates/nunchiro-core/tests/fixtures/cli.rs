//! Ticket 439: the `nunchiro` CLI these tests start. `cargo test -p nunchiro-core` does not build another package's
//! binary, and a nested `cargo build` would wait on the build lock the running `cargo test` holds, so a missing one
//! fails here with what to run instead of a bare NotFound from spawn.
use std::path::PathBuf;

pub fn path() -> PathBuf {
    // Ticket 1147: next to this test binary (<target>/<profile>/deps/), so CARGO_TARGET_DIR, --target-dir and
    // build.target-dir all hold; with none set it is <workspace>/target/debug/nunchiro as before.
    let exe = std::env::current_exe().expect("test binary path");
    let bin = exe
        .parent()
        .and_then(|deps| deps.parent())
        .expect("<target>/<profile>/deps")
        .join("nunchiro");
    assert!(
        bin.is_file(),
        "{} is missing: run `cargo build -p nunchiro` before `cargo test -p nunchiro-core` (the whole-workspace `cargo test` builds it)",
        bin.display()
    );
    bin
}
