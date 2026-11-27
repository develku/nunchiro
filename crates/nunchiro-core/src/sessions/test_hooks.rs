//! Test-only hooks the sessions code calls under `cfg(test)`.
use super::Sessions;
pub(super) type BeforeDecide = Box<dyn FnOnce(&std::sync::Mutex<Sessions>)>;
/// Ticket 32: the fake `claude` and `codex` unit tests run, set once (`agent_program`).
pub(super) static FAKE_AGENTS: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
thread_local! {
    // Ticket 32: runs at the start of `Launch::prepare` on the thread that prepares.
    pub(super) static IN_PREPARE: std::cell::Cell<Option<Box<dyn FnOnce()>>> = const { std::cell::Cell::new(None) };
    pub(super) static IN_HOOKS_CHECK: std::cell::Cell<Option<Box<dyn FnOnce() -> bool>>> = const { std::cell::Cell::new(None) };
}
thread_local! {
    // Ticket 39: runs in `handoff_send` between the first decision (and prepare) and the lock that decides again.
    pub(super) static BEFORE_DECIDE: std::cell::Cell<Option<BeforeDecide>> = const { std::cell::Cell::new(None) };
}
