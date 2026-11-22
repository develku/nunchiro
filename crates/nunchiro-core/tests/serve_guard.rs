//! ticket 52: a `serve` started through `ServeGuard` dies with its test, on a panic and on a normal return.
//! The parent test re-runs this binary for one child test (env `NS_SERVE_GUARD_CHILD`), reads the daemon PID the
//! child printed, and checks that process (same PID and start time, so a reused PID is not mistaken for it) is gone
//! once the child has exited.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const FLAG: &str = "NS_SERVE_GUARD_CHILD";

/// Child body: start `serve`, print its PID, then panic when `panic` else return.
fn child(panic: bool) {
    let Ok(mode) = std::env::var(FLAG) else {
        return;
    };
    if (mode == "panic") != panic {
        return;
    }
    let home = home::short("sg");
    let core = home::spawn_serve(&home, &[]);
    let pid = core.child.id().to_string();
    println!("SERVE_PID={pid}");
    println!("SERVE_START={}", start_of(&pid));
    println!("SERVE_HOME={}", home.display());
    assert!(!panic, "panic on purpose");
}

/// The start time `ps` reports for `pid`; empty when there is no such process.
fn start_of(pid: &str) -> String {
    let out = Command::new("ps")
        .args(["-p", pid, "-o", "lstart="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Runs child test `name` in a sub-process; returns (exit ok, daemon pid, daemon start time, daemon home).
fn run_child(name: &str, mode: &str) -> (bool, String, String, PathBuf) {
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env(FLAG, mode)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.split_once(key)) // the harness prefixes the first line with `test <name> ... `
            .unwrap_or_else(|| panic!("no {key} in child output:\n{text}"))
            .1
            .to_string()
    };
    (
        out.status.success(),
        field("SERVE_PID="),
        field("SERVE_START="),
        PathBuf::from(field("SERVE_HOME=")),
    )
}

fn assert_gone(pid: &str, start: &str) {
    let until = Instant::now() + Duration::from_secs(5);
    while start_of(pid) == start {
        assert!(Instant::now() < until, "serve {pid} outlived its test");
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn child_panics() {
    child(true);
}

#[test]
fn child_returns() {
    child(false);
}

#[test]
fn serve_started_by_a_test_dies_with_the_test() {
    let (ok, pid, start, home) = run_child("child_panics", "panic");
    assert!(!ok, "the child was meant to fail");
    assert_gone(&pid, &start);
    // The failed child keeps its home for inspection; this test owns the cleanup.
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn serve_started_by_a_test_dies_when_the_test_returns() {
    let (ok, pid, start, home) = run_child("child_returns", "return");
    assert!(ok);
    assert_gone(&pid, &start);
    assert!(!home.exists(), "a passing test removes its home");
}

#[test]
fn a_stopped_guard_does_not_stop_the_core_that_replaced_it() {
    let home = home::short("sg");
    let mut first = home::spawn_serve(&home, &[]);
    first.stop();
    let second = home::spawn_serve(&home, &[]);
    drop(first); // must not send a second Stop to the home the new core now owns
    thread::sleep(Duration::from_millis(300));
    assert!(matches!(
        call(&home, Request::Snapshot),
        Ok(Reply::Snapshot { .. })
    ));
    drop(second);
}

// Ticket 840: every core a test starts as a process goes through `git_env::scrub`, which sets the ticket 800 switch.
#[test]
fn the_shared_scrub_sets_the_test_opener_switch() {
    let out = home::git_env::scrubbed("/usr/bin/env").output().unwrap();
    let env = String::from_utf8(out.stdout).unwrap();
    assert!(
        env.lines().any(|l| l == "NUNCHIRO_TEST_OPENER=record"),
        "{env}"
    );
}
