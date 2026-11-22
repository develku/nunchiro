//! Ticket 419 (after 394): what a test fixture's git, and a core a test starts, never inherit from the shell that runs
//! the tests: git's location and config variables. A gate or a hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE,
//! and a fixture `git init` or `git commit` would then write to that repository instead of the test's temp one.
//! One list for every test file (`#[path = "fixtures/git_env.rs"] mod git_env;`); fixtures/home.rs uses it for its core.
#![allow(dead_code)]
use std::{ffi::OsStr, process::Command};

/// The variables removed: the same set as `nunchiro_core::process::FIXTURE_SCRUB` (unit tests, ticket 394 round 2).
pub const SCRUB: [&str; 8] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

/// Drops [`SCRUB`] from `c`'s environment; returns it for chaining. Ticket 840: also sets
/// `NUNCHIRO_TEST_OPENER=record`, so a core started through here (or a CLI that starts one) records what it would hand
/// to macOS `open` in `<home>/opened.argv` instead of launching TextEdit or the browser (ticket 800).
pub fn scrub(c: &mut Command) -> &mut Command {
    for k in SCRUB {
        c.env_remove(k);
    }
    c.env("NUNCHIRO_TEST_OPENER", "record")
}

/// `Command::new(program)` with [`SCRUB`] removed and the login-shell PATH off: a fixture's `git`, or the `nunchiro` binary a test starts.
pub fn scrubbed(program: impl AsRef<OsStr>) -> Command {
    let mut c = Command::new(program);
    scrub(&mut c);
    // Ticket 575: a core a test starts keeps the PATH the test gives it, not the machine's login-shell PATH.
    c.env("NUNCHIRO_LOGIN_PATH", "off");
    c
}
