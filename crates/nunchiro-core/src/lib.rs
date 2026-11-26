//! Headless session ownership, independent of clients.
mod account_carry; // ticket 451 step 2
mod account_near; // ticket 1126: the card at 98% of the week, the optional automatic switch
mod account_signin; // ticket 178 finding 20
pub mod accounts; // v2-2a
pub mod acp; // V2-4a
mod advance; // ticket 1081: team auto-advance
mod agent_canary; // ticket 1100: new agent versions checked against the screen readers
pub mod agent_models; // ticket 1100: Codex's own model list
mod agent_permission; // ticket 362
mod agent_update; // ticket 358
pub mod api;
pub mod codex_reset; // needs 225
mod dirfd; // ticket 452
pub mod home_lock; // ticket 1002 lane 1: the Home seat lock
pub mod outward; // ticket 1130 S1: outward actions ask in every session
pub(crate) mod session_context;
pub mod usage; // v2-2c
pub mod user_commands; // ticket-98
// v1b-14
pub mod approval;
pub mod browser; // V2.5-20
pub mod delivery;
pub mod projects; // V2.5-15
// v1b-11
pub mod diff;
pub mod events; // ticket 573 slice 2
pub mod grants;
pub mod machines; // v1a-06
// v1b-15
pub mod board;
// v1b-08
pub mod files;
pub mod holder; // v2-1a
pub mod http;
mod identity;
pub mod images; // v1b-05
pub mod login_path; // ticket 575
pub mod logs; // v2-13a
pub mod loops; // ticket 1003
mod opener; // ticket 800
mod outbox; // ticket 1002 lane 2
pub mod process; // V2-1b r3: `setsid` for the CLI restart helper
mod user_env; // ticket 260
// v1a-13
mod codex_sandbox; // v1b-38
mod peer;
mod pty;
pub mod queue;
pub mod record; // counts of delivered and resent prompts and of core restarts
pub mod room; // ticket 571
pub mod server;
mod sessions;
pub mod start_secrets; // ticket 457
mod store;
/// The sessions.json versions this core writes (`nunchiro diagnose` reads the same ones).
pub use store::{TOKEN_VERSION as STORE_TOKEN_VERSION, VERSION as STORE_VERSION};
pub mod team; // owner 2026-11-16: teammates
pub mod tokens; // ticket 573
pub mod waiting;
// v1b-02
pub mod chat;

// v1b-17
pub mod sandbox;
pub mod schedule; // V2.5-11
// v1a-40
mod scrollback;
// v1a-38b
pub mod scrollback_edit;
// v1b-19
pub mod widgets;
// v1a-47
pub mod themes_online;
// v25f F7
pub mod git_providers;
// Ticket 335
mod auto_pull;
// v2-8c
pub mod pr; // V2.5-8/9
pub mod pr_live;
// V2-8a
pub mod worktree_clean;
pub mod worktree_setup; // ticket 259
pub mod worktree_shared; // ticket 253
// V2-CF5 (needs 124)
pub mod keep_awake;
// v2-9a
pub mod tree;
// ticket 276
pub mod extensions;
// v2-10c
pub mod ledger; // ticket 990 slice g: the job ledger
pub mod libs;
pub mod notes; // ticket 990 slice h: accepted notes
pub mod roles; // ticket 990 slice i: the user's roles
// v2-5a
pub mod firstrun;
pub mod import; // V2.5-12
// v2-5b
pub mod problems;
#[cfg(test)]
mod worktree_base_tests; // ticket 374
