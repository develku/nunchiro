//! Orphaned holders (no core attached). Ticket 433: a stopped agent gets the orphan wait to be resumed; a resume or a
//! reattach keeps it. Ticket 416: a holder whose data folder stayed deleted for `GONE_WAIT` ends with its agent; one
//! that comes back inside it keeps the agent.
use crate::pty::{Attach, Pty, QUICK_WAIT};
use portable_pty::CommandBuilder;
use std::{
    thread,
    time::{Duration, Instant},
};

const WAIT: Duration = Duration::from_millis(1500);
/// Past the holder's first look (it looks each second) and before `WAIT` from it.
const FIRST_LOOK: Duration = Duration::from_millis(1300);

fn wait(what: &str, ok: impl FnMut() -> bool) {
    wait_for(what, Duration::from_secs(10), ok)
}
fn wait_for(what: &str, limit: Duration, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + limit;
    while !ok() {
        assert!(Instant::now() < until, "timed out: {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

/// An orphaned session (its core left) whose agent runs `sleep 120` (past `GONE_WAIT`, so it never ends on its own).
fn orphan(name: &str) -> (std::path::PathBuf, crate::holder::Record, u32) {
    // The same value the orphan test in pty.rs sets, so tests running at once agree on it.
    *super::ORPHAN_WAIT_TEST.lock().unwrap() = Some(WAIT);
    // Under the system temp dir: holder sockets bind under this home, and `.scratch` paths can pass `sun_path`.
    let home = std::env::temp_dir().join(format!("ns-stop-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut cmd = CommandBuilder::new("/bin/sleep");
    cmd.arg("120");
    let pty = Pty::spawn(&home, &format!("s-stop-{name}"), cmd, &[]).unwrap();
    let (record, agent) = (pty.holder().clone(), pty.pid());
    pty.leave();
    (home, record, agent)
}

fn signal(pid: u32, sig: i32) {
    assert_eq!(unsafe { libc::kill(pid as i32, sig) }, 0);
}

/// Darwin can drop a SIGSTOP that reaches a child just after its exec, so it is sent until `ps` shows the stop.
fn stop(pid: u32) {
    let state = || {
        let ps = std::process::Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&ps.stdout).trim().to_string()
    };
    wait("the agent stops", || {
        signal(pid, libc::SIGSTOP);
        state().starts_with('T')
    });
}

#[test]
fn a_stopped_orphan_is_ended_after_the_orphan_wait() {
    let (home, record, agent) = orphan("left");
    stop(agent);
    thread::sleep(FIRST_LOOK);
    assert!(
        record.socket.exists(),
        "the holder left before the wait passed"
    );
    assert!(
        crate::peer::running_since(agent, None),
        "the stopped agent was ended at once"
    );
    wait("the holder exits after the wait", || {
        !record.socket.exists()
    });
    wait("its agent is ended", || {
        !crate::peer::running_since(agent, None)
    });
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_resumed_or_reattached_orphan_is_kept() {
    for reattach in [false, true] {
        let (home, record, agent) = orphan(if reattach { "attach" } else { "resume" });
        stop(agent);
        thread::sleep(FIRST_LOOK);
        let core = if reattach {
            let Attach::Attached(pty) = Pty::attach_retrying(&record, QUICK_WAIT) else {
                panic!("not attached")
            };
            Some(pty)
        } else {
            signal(agent, libc::SIGCONT);
            None
        };
        thread::sleep(WAIT * 2);
        assert!(
            record.socket.exists(),
            "the holder left (reattach={reattach})"
        );
        assert!(
            crate::peer::running_since(agent, None),
            "the agent was ended (reattach={reattach})"
        );
        let mut core = core.unwrap_or_else(|| {
            let Attach::Attached(pty) = Pty::attach_retrying(&record, QUICK_WAIT) else {
                panic!("not attached")
            };
            pty
        });
        core.stop().unwrap();
        assert!(!crate::peer::running_since(agent, None));
        let _ = std::fs::remove_dir_all(&home);
    }
}

// Ticket 416: a test run deletes its home after its core; a holder left without a core ends once it stayed gone.
#[test]
fn an_orphan_whose_home_stayed_deleted_ends() {
    let (home, _, agent) = orphan("gone");
    std::fs::remove_dir_all(&home).unwrap();
    let removed = Instant::now();
    // The socket went with the home, so the holder's end shows as its agent's: dropping the PTY stops it.
    wait_for(
        "the holder ends its agent",
        super::GONE_WAIT + Duration::from_secs(10),
        || !crate::peer::running_since(agent, None),
    );
    assert!(
        removed.elapsed() >= super::GONE_WAIT,
        "ended before the home stayed gone"
    );
}

// Ticket 416 round 2: a home that is away for a moment (an external volume remounting) and comes back inside
// `GONE_WAIT` keeps its holder and agent. A rename stands in for the unmount: the socket comes back with it.
#[test]
fn an_orphan_whose_home_comes_back_is_kept() {
    let (home, record, agent) = orphan("back");
    let away = home.with_extension("away");
    let _ = std::fs::remove_dir_all(&away);
    std::fs::rename(&home, &away).unwrap();
    let log = away.join("logs/sessions/s-stop-back.log");
    let read = || std::fs::read_to_string(&log).unwrap_or_default();
    wait("the holder sees the home missing", || {
        read().contains("data folder or socket missing")
    });
    let missed = Instant::now();
    std::fs::rename(&away, &home).unwrap();
    let log = home.join("logs/sessions/s-stop-back.log");
    let read = || std::fs::read_to_string(&log).unwrap_or_default();
    wait("the holder sees it back", || {
        read().contains("data folder and socket are back")
    });
    // Past the window from the first miss: a holder that kept counting would have ended by now.
    thread::sleep((super::GONE_WAIT + Duration::from_secs(2)).saturating_sub(missed.elapsed()));
    assert!(
        crate::peer::running_since(agent, None),
        "the agent was ended"
    );
    let Attach::Attached(mut core) = Pty::attach_retrying(&record, QUICK_WAIT) else {
        panic!("not attached")
    };
    core.stop().unwrap();
    assert!(!crate::peer::running_since(agent, None));
    let _ = std::fs::remove_dir_all(&home);
}

// Q9 fr-J8-2: an ALIVE answer "ended" that never reached its core (the link broke while the holder replied) does not
// count as collected: the holder waits for the next core, which still gets the end and its exit code. The core's link
// is filled by agent output it does not read, so the reply waits behind that output and fails when the link closes.
#[test]
fn an_end_whose_answer_was_lost_is_kept_for_the_next_core() {
    use super::frame::{ALIVE, SPAWN, SPAWNED, read_frame, write_frame};
    *super::ORPHAN_WAIT_TEST.lock().unwrap() = Some(WAIT);
    let home = std::env::temp_dir().join(format!("ns-stop-lost-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let (mut link, record) = super::start(&home, "s-stop-lost").unwrap();
    let spawn = super::encode(&CommandBuilder::new("/usr/bin/yes"), &[]);
    write_frame(&mut link, SPAWN, &spawn).unwrap();
    let agent = loop {
        match read_frame(&mut link).unwrap() {
            (SPAWNED, p) => break u32::from_be_bytes([p[0], p[1], p[2], p[3]]),
            _ => continue,
        }
    };
    // Unread output fills the link; the agent then ends.
    thread::sleep(Duration::from_millis(300));
    signal(agent, libc::SIGKILL);
    thread::sleep(Duration::from_millis(200));
    write_frame(&mut link, ALIVE, &[]).unwrap();
    // The holder has read the ALIVE before the link closes under its reply.
    thread::sleep(Duration::from_millis(300));
    drop(link);
    let Attach::Attached(mut core) = Pty::attach_retrying(&record, QUICK_WAIT) else {
        panic!("the holder left with the end uncollected")
    };
    wait("the next core sees the end", || !core.alive().unwrap());
    assert!(core.exit_code().is_some(), "the exit code was lost");
    let _ = std::fs::remove_dir_all(&home);
}
