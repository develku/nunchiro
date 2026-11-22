//! CF5 (needs 124, ticket 127): opt-in no-idle-sleep while any session works.
//!
//! macOS only: one `caffeinate -i -w <core pid>` child blocks idle *system* sleep and lets the display sleep;
//! killing the child releases the assertion. Every other OS does nothing.
//!
//! `step` is a pure state machine on injected `Instant`s (no sleeping in unit tests); the ticker thread and the
//! OS child live at the bottom, and the held flag is a process global so a snapshot can report it without plumbing.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// How long the hold survives after the last turn ended (needs 124: "Released 2 minutes after the last turn").
pub const GRACE: Duration = Duration::from_secs(120);

/// What the OS side must do after one `step`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    Acquire,
    Release,
    Keep,
}

#[derive(Debug, Default)]
pub struct KeepAwake {
    /// Whether a hold is on now; `held_until` is set exactly while it is.
    held_until: Option<Instant>,
}

impl KeepAwake {
    /// One tick: `enabled` is the stored setting, `any_working` whether any session is working right now.
    /// Turning the setting off releases at once; work inside the grace resets it.
    pub fn step(&mut self, now: Instant, enabled: bool, any_working: bool) -> Hold {
        if !enabled {
            return match self.held_until.take() {
                Some(_) => Hold::Release,
                None => Hold::Keep,
            };
        }
        if any_working {
            let acquire = self.held_until.is_none();
            self.held_until = Some(now + GRACE);
            return if acquire { Hold::Acquire } else { Hold::Keep };
        }
        match self.held_until {
            Some(until) if now >= until => {
                self.held_until = None;
                Hold::Release
            }
            _ => Hold::Keep,
        }
    }

    pub fn held(&self) -> bool {
        self.held_until.is_some()
    }
}

/// Whether a hold is on now, for the snapshot reply. One core per process, so one flag.
static HELD: AtomicBool = AtomicBool::new(false);

pub fn held() -> bool {
    HELD.load(Ordering::SeqCst)
}

/// The OS assertion. `caffeinate` exits by itself when the core does, so a crash leaves no stray child.
struct Assertion {
    child: Option<std::process::Child>,
}

impl Assertion {
    fn new() -> Self {
        Self { child: None }
    }
    fn apply(&mut self, hold: Hold) {
        match hold {
            Hold::Acquire => {
                if self.child.is_some() {
                    return;
                }
                // `-i` blocks idle system sleep only; the display may sleep (needs 124).
                self.child = spawn();
                HELD.store(self.child.is_some(), Ordering::SeqCst);
            }
            Hold::Release => {
                if let Some(mut child) = self.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                HELD.store(false, Ordering::SeqCst);
            }
            Hold::Keep => {}
        }
    }
}

#[cfg(target_os = "macos")]
fn spawn() -> Option<std::process::Child> {
    caffeinate_command().spawn().ok()
}

#[cfg(target_os = "macos")]
fn caffeinate_command() -> std::process::Command {
    let core = std::process::id().to_string();
    let mut command = crate::process::command("/usr/bin/caffeinate");
    command
        .args(["-i", "-w", &core])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

#[cfg(not(target_os = "macos"))]
fn spawn() -> Option<std::process::Child> {
    None
}

/// The core's one keep-awake task: a look every second while the core runs; ends with the core.
pub(crate) fn spawn_ticker(
    registry: std::sync::Arc<std::sync::Mutex<crate::sessions::Sessions>>,
    stopping: std::sync::Arc<AtomicBool>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            let mut state = KeepAwake::default();
            let mut assertion = Assertion::new();
            while !stopping.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1000));
                let Ok((enabled, working)) = registry.lock().map(|s| s.keep_awake_view()) else {
                    break;
                };
                assertion.apply(state.step(Instant::now(), enabled, working));
            }
            // The core is leaving: release so no assertion outlives it even if the child is not yet reaped.
            assertion.apply(Hold::Release);
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn caffeinate_uses_absolute_path() {
        let mut command = caffeinate_command();
        command.env("PATH", "/synthetic/bin");
        assert_eq!(command.get_program(), "/usr/bin/caffeinate");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-i", "-w", &std::process::id().to_string()]
        );
    }

    fn at(secs: u64) -> Instant {
        Instant::now() + Duration::from_secs(secs)
    }

    // CF5 acceptance: keep_awake_default_off (unit half).
    #[test]
    fn keep_awake_default_off() {
        let mut state = KeepAwake::default();
        assert!(!state.held());
        assert_eq!(state.step(at(0), false, false), Hold::Keep);
        assert_eq!(state.step(at(0), false, true), Hold::Keep);
        assert!(!state.held(), "the setting off never holds");
    }

    // CF5 acceptance: keep_awake_release_two_minutes_after_last_turn.
    #[test]
    fn keep_awake_release_two_minutes_after_last_turn() {
        let (t0, t1, t2) = (at(0), at(60), at(120));
        let mut state = KeepAwake::default();
        // Two working sessions.
        assert_eq!(state.step(t0, true, true), Hold::Acquire);
        assert_eq!(state.step(t0, true, true), Hold::Keep);
        // The last one ends at t0: held until t0 + 2 min.
        assert_eq!(state.step(t0, true, false), Hold::Keep);
        assert_eq!(state.step(t1, true, false), Hold::Keep);
        assert!(state.held());
        assert_eq!(state.step(t2, true, false), Hold::Release);
        assert!(!state.held());
        assert_eq!(state.step(t2, true, false), Hold::Keep, "released once");

        // Work at t0 + 1 min resets the grace.
        let mut state = KeepAwake::default();
        state.step(t0, true, true);
        state.step(t0, true, false);
        assert_eq!(state.step(t1, true, true), Hold::Keep, "still held");
        assert_eq!(state.step(t2, true, false), Hold::Keep, "grace restarted");
        assert!(state.held());
        assert_eq!(state.step(at(180), true, false), Hold::Release);

        // Disabling releases at once.
        let mut state = KeepAwake::default();
        state.step(t0, true, true);
        assert_eq!(state.step(t0, false, true), Hold::Release);
        assert!(!state.held());
        assert_eq!(state.step(t0, false, false), Hold::Keep);
    }
}
