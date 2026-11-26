//! macOS memory pressure at a seat's start: one `kern.memorystatus_vm_pressure_level` read when a new agent seat is
//! asked for (no polling). Above normal, the start is held with one plain sentence; the owner can start it anyway
//! (`agent start --anyway`). Running seats, model-switch restarts and sessions a core brings back are never asked.
//! Also the low-memory kills macOS recorded (JetsamEvent reports) for `serve status`.
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

/// The sentence a held start answers the owner's CLI with.
pub const HELD: &str = "Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway with `nunchiro agent start --anyway`";
/// The window's: it has no "Start anyway" yet, so it names the CLI's.
pub const HELD_WINDOW: &str = "Your Mac is low on memory, so the new session was not started. Close something and try again, or run `nunchiro agent start --anyway`";
/// A session's: it cannot start anyway, so it is not told to.
pub const HELD_SESSION: &str =
    "This Mac is low on memory, so the new session was not started. Try again once memory is free";
/// A schedule's run that was held: its stored reason and the Run now refusal (a schedule has no `--anyway`).
pub const HELD_SCHEDULE: &str = "This Mac is low on memory, so the scheduled run was not started. Close something, then run it again";
/// An agent's own token asking to start anyway.
pub const OWNER_ONLY: &str = "Only you can start a session anyway; a session cannot";
/// Debug builds only: a test core's faked reading, a level number or "fail". A debug build without it reads normal, so
/// a test run on a busy machine or CI runner is never held by the host's own pressure.
const FAKE: &str = "NUNCHIRO_TEST_MEMORY_PRESSURE";

/// The kernel's level: 1 normal, 2 warning, 4 critical. `None` when it cannot be read.
fn level() -> Option<i32> {
    if cfg!(debug_assertions) {
        return match std::env::var_os(FAKE) {
            Some(fake) => fake.to_str()?.parse().ok(),
            None => Some(1),
        };
    }
    read()
}

/// One `sysctlbyname` read, no process started.
fn read() -> Option<i32> {
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    let name = c"kern.memorystatus_vm_pressure_level";
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
    /// The window, which has no override yet: held at critical only, since warning can be common and sticky on a Mac
    /// running several seats.
    Window,
    /// A session or a lead: no override.
    Session,
}

/// Whether a new seat may start: held from warning (critical for the window) unless the owner said anyway. A failed
/// reading allows it.
fn allowed(level: Option<i32>, who: Who, anyway: bool) -> Result<(), &'static str> {
    let from = if who == Who::Window { 4 } else { 2 };
    match level {
        Some(level) if level >= from && !anyway => Err(match who {
            Who::Owner => HELD,
            Who::Window => HELD_WINDOW,
            Who::Session => HELD_SESSION,
        }),
        _ => Ok(()),
    }
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
    let result = allowed(level, who, anyway);
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
        // The window has no override yet: warning does not hold it, critical does, naming the CLI's way.
        assert_eq!(allowed(Some(2), Who::Window, false), Ok(()));
        assert!(HELD_WINDOW.contains("nunchiro agent start --anyway"));
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
