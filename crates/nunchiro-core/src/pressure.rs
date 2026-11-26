//! macOS memory pressure at a seat's start: one `kern.memorystatus_vm_pressure_level` read when a new agent seat is
//! asked for (no polling). Above normal, the start is held with one plain sentence; the owner can start it anyway
//! (`agent start --anyway`). Running seats, model-switch restarts and sessions a core brings back are never asked.
//! Also the low-memory kills macOS recorded (JetsamEvent reports) for `serve status`.
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

/// The sentence a held start answers with.
pub const HELD: &str = "Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway with `nunchiro agent start --anyway`";
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

/// Whether a new seat may start: held above normal pressure unless the owner said anyway. A failed reading allows it.
fn allowed(level: Option<i32>, anyway: bool) -> Result<(), String> {
    match level {
        Some(level) if level > 1 && !anyway => Err(HELD.into()),
        _ => Ok(()),
    }
}

/// The check at a new seat's start.
pub(crate) fn check(anyway: bool) -> Result<(), String> {
    allowed(level(), anyway)
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
        assert_eq!(allowed(Some(1), false), Ok(()));
        for level in [2, 4] {
            let held = allowed(Some(level), false).unwrap_err();
            assert!(
                held.contains("memory") && held.contains("not started"),
                "{held}"
            );
            assert_eq!(allowed(Some(level), true), Ok(()));
        }
        // A reading that failed never holds a start.
        assert_eq!(allowed(None, false), Ok(()));
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
