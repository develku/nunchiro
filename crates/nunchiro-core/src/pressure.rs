//! macOS memory pressure at a seat's start: one `kern.memorystatus_vm_pressure_level` read when a new agent seat is
//! asked for. Above normal, the start is held with one plain sentence; the owner can start it anyway
//! (`agent start --anyway`). A held start of a session, a lead, a due schedule or the window's click waits in a list
//! and goes by itself once memory is free (`wait`, the only reading while something waits). Running seats,
//! model-switch restarts and sessions a core brings back are never asked.
//! Also the low-memory kills macOS recorded (JetsamEvent reports) for `serve status`.
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

/// The sentence a held start answers the owner's CLI with.
pub const HELD: &str = "Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway with `nunchiro agent start --anyway`";
/// The window's: its note carries a "Start anyway" button.
pub const HELD_WINDOW: &str = "Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway";
/// A session's: it cannot start anyway, so it is not told to.
pub const HELD_SESSION: &str =
    "This Mac is low on memory, so the new session was not started. Try again once memory is free";
/// A schedule's run that was held: its stored reason and the Run now refusal (a schedule has no `--anyway`).
pub const HELD_SCHEDULE: &str = "This Mac is low on memory, so the scheduled run was not started. Close something, then run it again";
/// An agent's own token asking to start anyway.
pub const OWNER_ONLY: &str = "Only you can start a session anyway; a session cannot";
/// A session's `agent start` that waits (`wait`).
pub const WAITING_SESSION: &str = "This Mac is low on memory, so the new session is waiting. It starts by itself when memory is free, and you get a message then. Do not start it again. It starts with no first prompt: send it one when that message comes";
/// A schedule's run that waits: its Last run's reason.
pub const WAITING_SCHEDULE: &str = "waiting for memory";
/// A schedule's run dropped after the longest wait: its Last run's reason.
pub const DROPPED_SCHEDULE: &str = "low memory";

/// A lead's `team open` that waits.
pub(crate) fn waiting_lead(name: &str) -> String {
    format!(
        "This Mac is low on memory, so {name}'s seat is waiting. The task is kept and goes to {name} when the seat opens. Do not open it again"
    )
}

/// A session's held start that went: only the start was kept, so the seat has no first prompt (a `task staff` prompt
/// is sent by the CLI after the start, which then never came). The asker gets the seat's id to send it.
pub(crate) fn unprompted_line(name: &str, id: &str) -> String {
    format!(
        "{name} started after waiting for memory, with no first prompt: send it its brief now (nunchiro agent prompt {id} \"<brief>\")."
    )
}

/// The line a waiting start's asker gets when it leaves the list.
pub(crate) fn asker_line(name: &str, done: wait::Done, result: &Result<String, String>) -> String {
    use wait::Done;
    match (done, result) {
        (Done::Released | Done::Anyway, Ok(_)) => {
            format!("{name} started after waiting for memory.")
        }
        (Done::Released | Done::Anyway, Err(e)) => {
            format!("{name} was not started after waiting for memory: {e}")
        }
        (Done::Cancelled, _) => {
            format!("{name} was not started: the owner cancelled it while it waited for memory.")
        }
        (Done::Dropped, _) => {
            format!("{name} was not started: this Mac stayed low on memory for 30 minutes.")
        }
    }
}

mod wait;
pub(crate) use wait::{
    Asker, Done, Go, answer, event, forget, hold, restore, shown, spawn, take_key, version,
};

/// An agent's name in a waiting start's line.
pub(crate) fn kind_name(kind: crate::api::AgentKind) -> &'static str {
    match kind {
        crate::api::AgentKind::Claude => "Claude",
        crate::api::AgentKind::Codex => "Codex",
        crate::api::AgentKind::Acp => "Agent",
        crate::api::AgentKind::Shell => "Terminal",
    }
}

/// A project's name in the window's list: its folder's name.
pub(crate) fn place_name(project: &Path) -> String {
    project
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The level that holds `who`'s new seat: critical for the window, warning for the rest.
pub(crate) fn from(who: Who) -> i32 {
    if who == Who::Window { 4 } else { 2 }
}
/// Debug builds only: a test core's faked reading, a level number or "fail", or an absolute path to a file holding one
/// (read at each check, so a test can change it). A debug build without it reads normal, so a test run on a busy
/// machine or CI runner is never held by the host's own pressure.
const FAKE: &str = "NUNCHIRO_TEST_MEMORY_PRESSURE";

/// The kernel's level: 1 normal, 2 warning, 4 critical. `None` when it cannot be read.
fn level() -> Option<i32> {
    if cfg!(debug_assertions) {
        let fake = match std::env::var(FAKE) {
            Ok(fake) if fake.starts_with('/') => std::fs::read_to_string(fake).ok()?,
            Ok(fake) => fake,
            Err(_) => return Some(1),
        };
        return fake.trim().parse().ok();
    }
    read().map(|level| settled(level, free()))
}

/// A warning with at least this much of memory free (percent) reads as normal.
const WARNING_FREE: i32 = 25;
/// The level a start goes by. macOS keeps "warning" set long after memory is free again (a bot-task trial held a seat
/// with 45 % free), so a warning with at least `WARNING_FREE` percent free reads as normal; critical always holds.
/// shortcut: one fixed percent, measured on one Mac; tune it from the hold log lines if holds still look wrong.
fn settled(level: i32, free: Option<i32>) -> i32 {
    if level == 2 && free.is_some_and(|f| f >= WARNING_FREE) {
        1
    } else {
        level
    }
}
/// The percent of memory free (`kern.memorystatus_level`, what `memory_pressure` prints as free).
fn free() -> Option<i32> {
    sysctl(c"kern.memorystatus_level")
}

/// One `sysctlbyname` read, no process started.
fn read() -> Option<i32> {
    sysctl(c"kern.memorystatus_vm_pressure_level")
}
fn sysctl(name: &std::ffi::CStr) -> Option<i32> {
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    let read = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&raw mut value).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0 && size == std::mem::size_of::<i32>()).then_some(value)
}

/// Who asks for the new seat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Who {
    /// The owner's CLI, which can say `--anyway`.
    Owner,
    /// The window, which overrides with its own "Start anyway": held at critical only, since warning can be common and
    /// sticky on a Mac running several seats.
    Window,
    /// A session or a lead: no override.
    Session,
}

/// Whether a new seat may start: held from warning (critical for the window) unless the owner said anyway. A failed
/// reading allows it.
fn allowed(level: Option<i32>, who: Who, anyway: bool) -> Result<(), &'static str> {
    let from = from(who);
    match level {
        Some(level) if level >= from && !anyway => Err(match who {
            Who::Owner => HELD,
            Who::Window => HELD_WINDOW,
            Who::Session => HELD_SESSION,
        }),
        _ => Ok(()),
    }
}

/// The start a `StartAnyway` carries, and whether it was one: the owner's alone (the CLI's `--anyway`, the window's
/// "Start anyway"); a session's token is refused.
pub(crate) fn unwrap_anyway(
    request: crate::api::Request,
    owner: bool,
) -> Result<(crate::api::Request, bool), String> {
    let crate::api::Request::StartAnyway { start } = request else {
        return Ok((request, false));
    };
    if !owner {
        return Err(OWNER_ONLY.into());
    }
    let crate::api::Request::Start { .. } = *start else {
        return Err("start_anyway carries a start only".into());
    };
    Ok((*start, true))
}

/// The check at a new seat's start; `path` names the start in the one log line a hold writes.
pub(crate) fn check(who: Who, anyway: bool, path: &str) -> Result<(), String> {
    checked(level(), who, anyway, path, None)
}

/// The levels last logged for a start retried by itself (`check_once`), by its key.
static LOGGED: std::sync::Mutex<std::collections::BTreeMap<String, i32>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// `check_start` for a start the core retries by itself (the auto-started Reviewer, every pass): its hold is logged
/// once per `key` until it starts or the level changes.
pub(crate) fn check_once(
    start: &crate::api::StartSession,
    who: Who,
    path: &str,
    key: &str,
) -> Result<(), String> {
    if start.kind == crate::api::AgentKind::Shell || start.resume.is_some() {
        return Ok(());
    }
    checked(level(), who, false, path, Some(key))
}

/// `allowed`, and its log line; with a `key`, a hold already logged at this level is not logged again.
fn checked(
    level: Option<i32>,
    who: Who,
    anyway: bool,
    path: &str,
    key: Option<&str>,
) -> Result<(), String> {
    // A start the waiting list let through (memory free again, or the owner's Start anyway on it) is not held again.
    let result = allowed(level, who, anyway || wait::passing());
    let level = level.unwrap_or(0);
    let log = key.is_none_or(|key| first_hold(key, result.is_err(), level));
    result.map_err(|held| {
        if log {
            eprintln!("memory pressure: held a new seat (level {level}, {path})");
        }
        held.to_string()
    })
}

/// Whether `key`'s hold at `level` is news: the first one, or one at another level. A start that went through
/// forgets it.
fn first_hold(key: &str, held: bool, level: i32) -> bool {
    let Ok(mut logged) = LOGGED.lock() else {
        return true;
    };
    match held {
        false => {
            logged.remove(key);
            false
        }
        true => logged.insert(key.into(), level) != Some(level),
    }
}

/// The check for a start that may be a new seat: a plain terminal and a resumed conversation are never held.
pub(crate) fn check_start(
    start: &crate::api::StartSession,
    who: Who,
    anyway: bool,
    path: &str,
) -> Result<(), String> {
    if start.kind == crate::api::AgentKind::Shell || start.resume.is_some() {
        return Ok(());
    }
    check(who, anyway, path)
}

/// Whether a start's refusal is a memory-pressure hold (a schedule's run reads "held", not failed).
pub(crate) fn is_held(error: &str) -> bool {
    [HELD, HELD_WINDOW, HELD_SESSION, HELD_SCHEDULE].contains(&error)
}

/// Where macOS writes its JetsamEvent reports.
const REPORTS: &str = "/Library/Logs/DiagnosticReports";

/// The low-memory kills macOS reported in the last `days` days (JetsamEvent reports, by their file time; the files are
/// root's, so only listed, never read). `None` when the folder cannot be listed.
pub fn kills(days: u64) -> Option<usize> {
    kills_in(Path::new(REPORTS), SystemTime::now(), days)
}

fn kills_in(folder: &Path, now: SystemTime, days: u64) -> Option<usize> {
    let since = now.checked_sub(Duration::from_secs(days * 24 * 60 * 60))?;
    let count = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("JetsamEvent-"))
        .filter(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|t| t >= since)
        })
        .count();
    Some(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressure_above_normal_holds_a_new_seat_unless_anyway() {
        for who in [Who::Owner, Who::Window, Who::Session] {
            assert_eq!(allowed(Some(1), who, false), Ok(()));
            assert_eq!(allowed(Some(4), who, true), Ok(()));
            // A reading that failed never holds a start.
            assert_eq!(allowed(None, who, false), Ok(()));
            let held = allowed(Some(4), who, false).unwrap_err();
            assert!(
                held.contains("memory") && held.contains("not started"),
                "{held}"
            );
        }
        assert_eq!(allowed(Some(2), Who::Owner, false), Err(HELD));
        assert_eq!(allowed(Some(2), Who::Session, false), Err(HELD_SESSION));
        // Warning does not hold the window, critical does, pointing at its own button rather than the CLI.
        assert_eq!(allowed(Some(2), Who::Window, false), Ok(()));
        assert!(HELD_WINDOW.ends_with("or start it anyway"));
        assert!(!HELD_SESSION.contains("anyway"));
    }

    #[test]
    fn a_retried_hold_is_logged_once_per_level_until_it_starts() {
        let key = format!("task-{}", crate::store::new_id().unwrap());
        assert!(first_hold(&key, true, 2));
        assert!(!first_hold(&key, true, 2), "the same hold again");
        assert!(first_hold(&key, true, 4), "the level changed");
        assert!(!first_hold(&key, false, 1), "a start is no hold");
        assert!(first_hold(&key, true, 4), "held again after it started");
    }

    #[test]
    fn the_real_reading_is_a_known_level() {
        assert!(matches!(read(), Some(1 | 2 | 4)), "{:?}", read());
        assert!(
            free().is_some_and(|f| (0..=100).contains(&f)),
            "{:?}",
            free()
        );
    }

    // A bot-task trial: a lead's new seat was held at "warning" with 45 % of memory free. macOS keeps warning set long
    // after memory is free again; a warning with plenty free reads as normal, critical always holds.
    #[test]
    fn a_warning_with_plenty_free_is_no_hold() {
        assert_eq!(settled(2, Some(45)), 1);
        assert_eq!(settled(2, Some(WARNING_FREE)), 1);
        assert_eq!(settled(2, Some(WARNING_FREE - 1)), 2);
        assert_eq!(settled(2, None), 2, "free not known: the warning stands");
        assert_eq!(settled(4, Some(90)), 4);
        assert_eq!(settled(1, Some(5)), 1);
    }

    #[test]
    fn kills_count_jetsam_reports_of_the_last_days() {
        let dir = std::env::temp_dir().join(format!("jetsam-{}", crate::store::new_id().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "JetsamEvent-2026-11-25-013125.ips",
            "JetsamEvent-2026-11-26-1.ips",
            "Other-1.ips",
        ] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let now = SystemTime::now();
        assert_eq!(kills_in(&dir, now, 7), Some(2));
        // Eight days on, they are older than the window.
        assert_eq!(
            kills_in(&dir, now + Duration::from_secs(8 * 86_400), 7),
            Some(0)
        );
        assert_eq!(kills_in(&dir.join("missing"), now, 7), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
