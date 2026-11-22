//! Ticket 439: the `nunchiro` CLI these tests start. `cargo test -p nunchiro-core` does not build another package's
//! binary, and a nested `cargo build` would wait on the build lock the running `cargo test` holds, so a missing one
//! fails here with what to run instead of a bare NotFound from spawn.
use std::path::PathBuf;

pub fn path() -> PathBuf {
    let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/nunchiro");
    assert!(
        bin.is_file(),
        "{} is missing: run `cargo build -p nunchiro` before `cargo test -p nunchiro-core` (the whole-workspace `cargo test` builds it)",
        bin.display()
    );
    bin
}
