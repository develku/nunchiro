//! Shared commands for the CLI, hooks and future window transport.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
// Ticket 1162: the answers moved out whole; the child says its own in one `//!` line.
mod reply;
pub use reply::{Reply, Response};
// The published wire schema, written by a test (docs/api.md).
#[cfg(test)]
mod schema_tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    Shell,
    // V2-4a: an ACP agent declared in `agents.toml`; its name is the session's `acp_agent` (on start, `args[0]`).
    Acp,
}

/// Internal launch directive; consumed by the core, never passed to an agent.
pub const SIDE_CHAT_ARG: &str = "--nunchiro-side-chat";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct StartSession {
    pub kind: AgentKind,
    pub project: PathBuf,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume: Option<String>,
    // V2-2b: an agent account's label (the registry resolves it); absent = "Your own". Never a path.
    // Ticket 451: with `resume`, an account other than the one the conversation ran on continues it there (the core
    // copies the conversation's record into that account's folder first; Claude only). An empty label names "Your own".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

// v1a-09: when agents end. `keep_running` is the default: the window and the app may quit, agents stay.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Lifetime {
    #[default]
    KeepRunning,
    EndWithApp,
}

/// Ticket 250: the feature ids an absorb ticket has shipped a core reader for. A support bundle (`nunchiro diagnose`)
/// keeps a `features` entry only under one of these keys; add the id here with the reader.
pub const KNOWN_FEATURES: &[&str] = &[
    "git.branch_prefix", // v25f: read at worktree create
    "git.auto_pull",     // ticket 335: read by auto_pull.rs
    // Needs 225 (codex_reset.rs): the flags of Codex reset tickets; the agent mode and the weekly cap are not flags.
    "usage.codex_resets",
    "usage.codex_reset_weekly_only",
    "usage.codex_reset_keep_last",
    "usage.codex_reset_expiring",
    "env.inherit_shell", // ticket 260: user_env.rs (names only, never values)
    "env.names",
    "env.strip_secrets", // ticket 1008: sessions/seat_env.rs (names only)
    "env.keep_secrets",
];

// v1a-09: the settings the window edits; absent fields stay as they are.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default, deny_unknown_fields)]
pub struct LifetimePatch {
    pub lifetime: Option<Lifetime>,
    pub start_at_login: Option<bool>,
    pub disable_hook_injection: Option<bool>,
    // v1a-74 (needs 79)
    pub keep_history: Option<bool>,
    pub mask_history: Option<bool>,
    // V2-8a: auto-clean merged worktrees (off by default)
    pub auto_clean_worktrees: Option<bool>,
    // V2-CF5 (needs 124): hold off idle system sleep while any session works (off by default)
    pub keep_awake: Option<bool>,
    // Ticket 872: the Settings switch for script widgets (off by default; V1B-21 reviewed the sandbox).
    pub script_widgets: Option<bool>,
    // V2.5-31
    pub orchestration: Option<OrchestrationPatch>,
    // Ticket 211: the owner names a folder Usage may read through a link in their own default folder; the core stores
    // its canonical path in `usage_link_roots` (settings.json). Only adds; the owner removes by editing the file.
    pub usage_allow_link: Option<PathBuf>,
    // v25f (F7): the folder new worktrees go in, absolute or relative to the project; "" is the default (ticket 1061:
    // `../.worktrees`, beside the repository). A relative path that leaves the project's folder or its parent is refused.
    pub worktrees_dir: Option<String>,
    // Ticket 250: an absorb feature's own core value by dotted key (`^[a-z0-9]+(\.[a-z0-9_]+)+$`, at most 4096 bytes
    // serialised); a `null` value removes the key. A bad key, size, or a patch that grows the map past 256 keys
    // (V2.5-77) refuses the whole patch.
    pub features: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    // Ticket 456: the custom extension ids the owner turned on after reading what they run (the window's dialog, the
    // CLI's question). A `features["extensions.enabled"]` change that adds an id not named here is refused.
    pub extensions_confirmed: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct LifetimeSettings {
    pub lifetime: Lifetime,
    pub start_at_login: bool,
    pub disable_hook_injection: bool,
    pub keep_history: bool,
    pub mask_history: bool,
    #[serde(default)]
    pub auto_clean_worktrees: bool,
    // V2-CF5: off unless the owner turned it on.
    #[serde(default)]
    pub keep_awake: bool,
    // Ticket 872
    #[serde(default)]
    pub script_widgets: bool,
    // V2.5-31
    #[serde(default)]
    pub orchestration: OrchestrationSettings,
    /// The folder whose files replace the built-in orchestration skill's.
    #[serde(default)]
    pub orchestration_override: PathBuf,
    // Ticket 250: `settings.json` `features`; absent reads as empty.
    #[serde(default)]
    pub features: std::collections::BTreeMap<String, serde_json::Value>,
    // v25f: as stored; `None` is the default folder.
    #[serde(default)]
    pub worktrees_dir: Option<PathBuf>,
    // Ticket 260: why the login shell's environment was not read (Settings shows it); `None` when read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_env_error: Option<String>,
    // Ticket 1008: the secret-looking variable names the core and the login shell hold (never values).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_env_names: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    Failed,
    Exited,
    Resumable,
    Closed,
}

/// Words that came home from an agent's box (sessions/home.rs) and when they left it (ms).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct DraftHome {
    pub words: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Session {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub side_chat: bool,
    /// Ticket 1121: queued rows the core will not paste again (their Enter dropped past the re-paste bound, or no clean
    /// box read for CLEAN_WAIT); the composer says so. Snapshot only: never saved, never read from a store.
    #[serde(default, skip_serializing_if = "Vec::is_empty", skip_deserializing)]
    pub stopped_sends: Vec<String>,
    /// Why each queued row waits, by send id: `turn`, `typing`, `terminal_text`, `later`, `attached`, `dialog`. Snapshot
    /// only: never saved, never read from a store.
    #[serde(
        default,
        skip_serializing_if = "std::collections::BTreeMap::is_empty",
        skip_deserializing
    )]
    pub send_waits: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_split: Option<String>,
    // v1a-06: absent for local sessions and older stores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    pub id: String,
    pub kind: AgentKind,
    pub project: PathBuf,
    pub cwd: PathBuf,
    pub label: String,
    /// Ticket 1017: `label` came from the first message (`auto_title`, `codex_title`), not from the user; the window
    /// numbers two equal such names ("ASK 1", "ASK 2"). A hand-set label clears it. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_label: bool,
    pub state: SessionState,
    /// Ticket 1013 F6: closed by a command (the CLI, a script, the lead, any core caller but the window's own Close); the
    /// window drops its tab at once. Absent: the window keeps the done tab with Continue and Restart, as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub closed_by_command: bool,
    pub agent_session_id: Option<String>,
    pub agent_version: Option<String>,
    pub untested: bool,
    pub pid: Option<u32>,
    #[serde(default)]
    pub completion_seq: u64,
    #[serde(default)]
    pub attention: Box<crate::queue::Attention>,
    #[serde(default)]
    pub pending: Vec<crate::queue::Decision>,
    #[serde(default)]
    pub send_log: Vec<crate::delivery::Send>,
    #[serde(default)]
    pub send_queue: Vec<crate::delivery::Send>,
    // v1a-10: the model and effort this session runs with; absent = the agent's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    // v1b-11: the folder's state at session start; absent in records written before v1b-11. Omitted when
    // absent, so the snapshot wire of such a session stays byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_commit: Option<crate::diff::Base>,
    // v1b-07: the artifact folder id (`artifacts/<id>` of the data folder) when it is not this session's own id: a
    // resumed conversation keeps the folder of the run it continues. Omitted when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<String>,
    // v1a-33: the core could not open the session folder (macOS file access); the agent keeps running. Omitted
    // when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<Blocked>,
    // V2-1b: a reattach found this session's holder on another protocol; its agent keeps running. Omitted when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder_status: Option<HolderStatus>,
    // V2-2b: the account's config folder this agent runs with, fixed at start; absent = "Your own". Omitted when
    // absent, so older records and "Your own" sessions stay byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<PathBuf>,
    // V2-2b: that account's label, kept beside the folder for the tab and AGENTS rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    // V2-3b: the conversation (one tab's chain of sessions joined by agent switches) this session belongs to; absent
    // until its first switch. Omitted when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
    // V2-4a: the `agents.toml` entry an `acp` session runs. Omitted when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_agent: Option<String>,
    // V2-5b: why this session failed and the card the window shows; omitted when absent, none when unreadable.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::problems::lenient"
    )]
    pub problem: Option<crate::problems::Problem>,
    // V2-5b: started by "Start without Nunchiro hooks": waiting is found from the screen only. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub without_hooks: bool,
    // Round 3: a sign-in tab (`git_providers`); its output is never saved as scrollback. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_history: bool,
    // Ticket 322: a login or logout tab the core itself started for an account. Never taken from a request. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub account_tab: bool,
    /// Ticket 1002 lane 1: this Claude session runs with the Home seat lock (`home_lock`): a Home seat, or a session one
    /// started. A session it starts carries the lock too. Set by the core at spawn, never taken from a request.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub home_lock: bool,
    /// Ticket 1002 lane 1 (Fable review R5): the lock's mode this run started in (`home_lock::name`); absent when not locked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_mode: Option<String>,
    // CHAT-PERMCHIP: Claude's permission mode as its footer shows it; set per snapshot, omitted when unknown.
    // Ticket 991 (B6 chip): for Codex, the mode it was started in (`ran_mode`: own, ask, auto, full-access).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Look 11-17 v3 P1: a new Claude session whose input box has not shown yet; a first message waits in the window
    /// until it has (a startup question may still come, and text typed before the box is lost). Set per snapshot.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub starting: bool,
    /// The screen shows the agent's input box and nothing asks: letters typed in its terminal go to the window's composer
    /// unless the owner turned on Type in terminal. Set per snapshot, never saved.
    #[serde(
        default,
        skip_serializing_if = "std::ops::Not::not",
        skip_deserializing
    )]
    pub at_box: bool,
    /// Words the core took out of the agent's box for the window's composer (the composer answers `draft_taken`). Set
    /// per snapshot, never saved in the session store (they live in `<home>/aside/<id>.json`).
    #[serde(default, skip_serializing_if = "Option::is_none", skip_deserializing)]
    pub draft_home: Option<DraftHome>,
    /// Another sender's message sits in the agent's box waiting for its Enter (pasted, or left after a dropped Enter):
    /// `take_back` clears it and puts the row back. Set per snapshot, never saved.
    #[serde(
        default,
        skip_serializing_if = "std::ops::Not::not",
        skip_deserializing
    )]
    pub take_back: bool,
    /// Look 11-17 N2: the last permission mode Claude's footer showed while the session ran (stored, unlike
    /// `permission_mode`), so a resume starts in the mode the session ran with. Ticket 991 (B6 chip): for Codex, the
    /// stored choice the owner's start applied (none when the arguments stated the permission, and on older rows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ran_mode: Option<String>,
    // CHAT-MODELIST (ticket 285): what the mode list may offer this Claude session and how a walk to a picked mode
    // stands; set per snapshot, never stored, omitted when there is nothing to say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_state: Option<ModeState>,
    // V2.5-30 (needs 145): the session that started this one, stored at its start; omitted when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Ticket 990: the teammate (team.rs id) whose seat this session is, stored when the core opens the seat and kept
    /// by a resumed run. The lead of a place is found by it, so a lead outlives its session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teammate: Option<String>,
    /// Look 1117 v10 N10-S2-3: the ids of the runs this resumed run continues, newest first (their rows are gone). A
    /// room line names the seat by its old id; the window finds the seat's name through this.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resumed_from: Vec<String>,
    /// Codex security MUST (w20-h): the runs whose started sessions this run may close and list as `--mine`
    /// (`Sessions::started_by`). Only a resume the owner or the core made carries them; an agent's own
    /// `session start --resume` keeps `resumed_from` (names only) and gets none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owned_from: Vec<String>,
    /// Ticket 992: the level a seat was started at (team.rs `open_seat`); absent on a seat with a custom model and on
    /// every other session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<crate::team::Level>,
    /// Ticket 993: the schedule (its id) whose run this session does unattended: set when a scheduled run starts the
    /// session or sends its task to it, cleared when the user speaks to it. While set, the session may not propose
    /// or change schedules. (A schedule's row names its last run's session itself: `Entry::last`.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    /// Ticket 573 round 6: the outside token (`token-<id>`) this session acts for, stored once at its start from the
    /// caller, the run it continues or its side chat's main session, and copied into every continuation. Never
    /// recomputed from live records and never cleared, so a closed or resumed parent changes nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_origin: Option<String>,
    /// Ticket 621: when the row went Closed (epoch ms); only the newest closed rows are kept. Absent on rows closed
    /// before ticket 621, which count as the oldest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<u64>,
    /// Ticket 1025: when this run started (epoch ms), for History's start time and run length. Absent on rows
    /// started before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// Lane w59 (History run length): when this run ended (epoch ms), stamped once by the core that saw it end: the
    /// agent quit (its shell may stay), the process exited, or the core stopped it. Absent on a run still going, on
    /// one a close ended (`closed_at` is its end) and on rows that ended before this field or while no core watched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    // Ticket 286 item 1 r5 (card C-20261106-06): the agent quit and its wrapper's shell is left Running for the user's
    // keys; "done" follows this, not the shell. Set per snapshot, never stored; omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent_ended: bool,
    // Ticket 372: the usage limit this live session's screen shows while its reset is ahead, and whether the owner armed
    // one resume at that reset. Set per snapshot, never stored; omitted when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<SessionLimit>,
    // Look 1117 v13 (Home S3-5): an ended local session whose folder is no longer on disk (its project folder was
    // removed), so the window names no checkout ("harbor / main"). Set per snapshot, never stored; omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub folder_gone: bool,
    // Look 1117 v10 N10-S3-3: an ended row's ask that ended with it unanswered (a question waiting when the app quit),
    // in its first words, so its tab says so. Set per snapshot, never stored; omitted when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ask: Option<String>,
    /// W35 picker: a Claude session's fast mode and ultracode as far as Nunchiro knows them (`sessions/claude_modes.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<Modes>,
}

impl Session {
    /// Ticket 1016: the state `session list` reports, read as the tree reads it (`status` and `agentState` in
    /// web/src/types.ts): a live shell whose agent failed (a problem card) is failed, one whose agent quit is exited.
    pub fn listed_state(&self) -> SessionState {
        match self.state {
            SessionState::Running if self.problem.is_some() || self.attention.failed => {
                SessionState::Failed
            }
            SessionState::Running if self.agent_ended => SessionState::Exited,
            state => state,
        }
    }
}

#[cfg(test)]
mod listed_tests {
    use super::*;

    fn running() -> Session {
        serde_json::from_value(serde_json::json!({
            "id": "s1", "kind": "claude", "project": "/p", "cwd": "/p", "label": "one", "state": "running",
            "agent_session_id": null, "agent_version": null, "untested": false, "pid": null,
            "attention": {"completion_seq": 0, "working": false, "waiting": false, "stale": false,
            "failed": false, "last_activity": 0, "background": 0}, "pending": []
        }))
        .expect("session meta")
    }

    /// Ticket 1016: a Claude session whose agent exited with code 3 and left its shell reads failed in the list, as in the tree.
    #[test]
    fn an_agent_that_failed_reads_failed_in_the_list() {
        let mut s = running();
        assert_eq!(s.listed_state(), SessionState::Running);
        s.agent_ended = true;
        assert_eq!(s.listed_state(), SessionState::Exited);
        s.problem = crate::problems::ended(AgentKind::Claude, b"boom\r\n", Some(3), true);
        assert!(
            s.problem
                .as_ref()
                .is_some_and(|p| p.cause.contains("exit code 3"))
        );
        assert_eq!(s.listed_state(), SessionState::Failed);
        let mut closed = running();
        closed.attention.failed = true;
        assert_eq!(closed.listed_state(), SessionState::Failed);
        closed.state = SessionState::Closed;
        assert_eq!(closed.listed_state(), SessionState::Closed);
    }
}

/// W35 picker: `fast` is set at a start that chose it and read from Claude's ↯ per snapshot; `ultracode` is known only
/// when Nunchiro started or typed it. Absent: not known.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Modes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ultracode: Option<bool>,
    /// Claude's own sentence when it last refused ultracode ("Ultracode needs dynamic workflows turned on ..."), read
    /// from its screen; cleared by its next "on" or "off" line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Ticket 1010: Claude's own sentence when it turned fast mode off for the account ("Fast mode disabled · Out of
    /// usage credits"), read from the footer of its screen; gone when its ↯ shows again or a fast restart starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_note: Option<String>,
    /// Ticket 1010: fast mode is on but paused: set per snapshot while Claude draws its ↯ faint, with what its notice
    /// said when one was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_cooldown: Option<FastCooldown>,
}

/// Ticket 1010: `text` is Claude's notice before its "· resets in 5m" ("Fast limit reached, fast mode paused"), `until`
/// the epoch second that "in 5m" pointed at when the notice came. Both absent: the faint ↯ alone was read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct FastCooldown {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

/// Ticket 372: `resets` as the agent printed it, `until` its epoch second.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SessionLimit {
    pub resets: String,
    pub until: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub armed: bool,
}

/// CHAT-MODELIST: the mode list's per-session facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ModeState {
    pub skip: SkipPermissions,
    /// A walk to a picked mode: `error` is `None` while it runs and the reason once it stopped short.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk: Option<ModeWalk>,
}
/// Bypass permissions (Claude `bypassPermissions`) for one session. `Unavailable`: Claude's Shift+Tab cycle has no such
/// mode (the session was not launched with the flags that list it); `Available`: pickable; `Disabled`: Claude's own
/// settings turn it off (`permissions.disableBypassPermissionsMode`); `NeedsSetting`: not in this session's cycle and the
/// stored choice is Ask, so a new session would not have it either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SkipPermissions {
    Unavailable,
    Available,
    Disabled,
    NeedsSetting,
}
/// Ticket 362 (owner 11-09): an agent's stored permission for the sessions the owner starts. `Own` adds no flag and leaves
/// the agent's own setting in charge. Stored by these names: never rename one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
pub enum PermissionChoice {
    Own,
    Ask,
    AcceptEdits,
    Auto,
    FullAccess,
}
impl PermissionChoice {
    /// A stored value this build cannot read adds no flag.
    pub(crate) fn deserialize_or_own(value: &serde_json::Value) -> Self {
        Self::deserialize(value).unwrap_or(Self::Own)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ModeWalk {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// V2-1b
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HolderStatus {
    /// The holder is older than this core: "Needs restart after update" (Restart session).
    NeedsRestart,
    /// The holder is newer than this core: not attached, "Update Nunchiro".
    UpdateNunchiro,
}

// v1a-33
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Blocked {
    pub reason: BlockedReason,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    FileAccess,
}

/// V2-2d: the steps of an account remove, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoveStep {
    Check,
    Logout,
    Move,
    // Ticket 322: "Your own" only: the agent login in a visible tab.
    Login,
}

/// V2.5-36 (ticket 184): board task writes, served by `board::handle_task`. Kept out of `Request` so this
/// lane does not touch the exhaustive dispatch in sessions.rs and http/browser.rs; ticket 183 folds them
/// in (same `op` tags, so the wire does not change) when it routes and gates them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BoardTaskRequest {
    // Sets a manual card's task fields; an omitted field keeps its value, `"receipt": null` clears it.
    BoardTaskPut {
        id: String,
        #[serde(default)]
        group: Option<String>,
        #[serde(default, rename = "ref")]
        reference: Option<String>,
        #[serde(default, deserialize_with = "crate::board::present")]
        receipt: Option<Option<crate::board::Receipt>>,
        #[serde(default)]
        waits_on: Option<Vec<String>>,
        #[serde(default)]
        attachments: Option<Vec<crate::board::Attachment>>,
    },
    // Restores a manual card's state before its last change (one step).
    BoardUndo {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    // v1a-06: RemoteService is interpreted only by the SSH relay.
    RemoteService {
        restart: bool,
    },
    // v1a-06: Remote is authorized locally; Forwarded is remote-owner-only.
    Remote {
        machine: String,
        request: Box<Request>,
    },
    AddMachine {
        alias: String,
        host: String,
        user: Option<String>,
        port: Option<u32>,
        // Edit: saves over a listed alias (its project mappings stay); the same values write nothing.
        #[serde(default)]
        replace: bool,
    },
    ForgetMachine {
        alias: String,
    },
    MachineDetails {
        alias: Option<String>,
    },
    // v25f: the Add form's suggestions and its Test; both owner-only and read-only.
    MachineAliases,
    MachineProbe {
        host: String,
        user: Option<String>,
        port: Option<u32>,
    },
    // Ticket 1050: Share this Mac (reads only) and a pasted link's Test (writes one Nunchiro-owned known_hosts line).
    MachineShare,
    MachineTrust {
        alias: String,
        link: String,
    },
    MachineStatus {
        label: Option<String>,
        #[serde(default)]
        retry: bool,
    },
    Forwarded {
        caller: crate::machines::Caller,
        request: Box<Request>,
    },
    // v1b-02
    ChatPage {
        id: String,
        #[serde(default)]
        before: Option<u64>,
        #[serde(default)]
        after: Option<u64>,
    },
    // v2-3a: the handoff text for a session's chat since its last agent switch; window only.
    HandoffPreview {
        id: String,
        #[serde(default)]
        through: Option<String>,
        #[serde(default)]
        last_five: bool,
    },
    // v2-3b: on the user's Enter: starts (or reuses) a session of `to` in `from`'s folder and sends `text` there as one
    // user message. Owner and window only.
    HandoffSend {
        from: String,
        to: AgentKind,
        text: String,
        // V2-4b: the approved `agents.toml` entry to hand off to; required exactly when `to` is `acp`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_agent: Option<String>,
    },
    // v2-8b: the last known PR state from the chat's `gh pr` results; window only, no network.
    PrChip {
        id: String,
    },
    // V2-CF4: a session's sub-agents for the tree; read-only (the last 256 KiB of its transcript). Allowed for the window and
    // the paired browser role (watch, like `ChatPage`); refused on the owner socket, for session tokens and for `Remote`.
    // Needs 169: `open` (a `Kid.id`) also returns that child's own output (`Reply::Subagents.opened`); never a path.
    Subagents {
        id: String,
        #[serde(default)]
        open: Option<String>,
    },
    // v2-8c: live PR status through the user's gh (opt-in); window only. A read, with `url` the PR it asks about.
    PrLive {
        #[serde(default)]
        url: Option<String>,
    },
    // v2-8c: the setting and its one-time offer; an absent field stays.
    PrLiveSet {
        #[serde(default)]
        on: Option<bool>,
        #[serde(default)]
        offered: Option<bool>,
    },
    // v2-8c: "Watch PR" (a pin, stored per machine).
    PrWatch {
        url: String,
        on: bool,
    },
    // v2-8c: the window's in-front heartbeat.
    PrFront {
        front: bool,
    },
    // V2.5-8: the PR view through the user's gh (live PR status on); window only.
    PrView {
        url: String,
    },
    // V2.5-9: the open PRs of the repositories the core knows (agent-created or pinned); window only.
    PrList,
    // V2.5-9: merge through the user's gh after the window's confirm step, which sends the head commit it showed
    // (`gh pr merge --match-head-commit`); window only.
    PrMerge {
        url: String,
        method: String,
        #[serde(default)]
        head: String,
    },
    // Ticket 373: the PR of the branch checked out in `path` (a worktree folder), through the user's gh run there (live
    // PR status on); window only.
    PrBranch {
        path: String,
    },
    // The Diff panel's Push after the window's confirm strip, which sends the head commit it showed; the core checks
    // the branch again and runs `git push <remote> <head>:refs/heads/<branch>` in the session's folder. Window only.
    GitPush {
        session: String,
        #[serde(flatten)]
        shown: crate::git_write::Shown,
    },
    // v2-10c: owner only and local (the app's `serve`), answered by the socket server before any session check.
    // Reads the library cache; Allow, auto-allow and Remove are window-only `libs::Op`, never a `Request`.
    LibsResolve {
        urls: Vec<String>,
        #[serde(default)]
        requester: String,
    },
    LibsEntry {
        sha384: String,
    },
    // Ticket 573 slice 3: outside-caller tokens. Owner only and local, answered by the socket server before any
    // session check; a session or token caller is refused.
    TokenCreate {
        scope: crate::tokens::Scope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<PathBuf>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_in_ms: Option<u64>,
    },
    TokenList,
    TokenRevoke {
        id: String,
    },
    // v2-2a: owner and window only. The list probes each account's signed-in state; an add creates the account and
    // opens its login tab.
    AccountList,
    // v2-2a r2: probes the agent's "Your own" config, only on the owner's request (at most once a minute). Accounts probe
    // 11-10: `force` (the owner's Check or Check again) probes even within that minute; a page opening never sets it.
    AccountCheck {
        agent: crate::accounts::Agent,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        force: bool,
    },
    AccountAdd {
        agent: crate::accounts::Agent,
        label: String,
    },
    // Ticket 358: owner and window only, local only. A new name for an added account; its id and folder stay.
    AccountRename {
        agent: crate::accounts::Agent,
        id: String,
        label: String,
    },
    // v2-2c: tokens today and over 7 days per account, counted from local transcripts; window and owner only.
    // Ticket 1031: `limits` reads only the records that carry limits (Codex), for the status bar's usage block: the
    // rows keep their shape and Claude's token counts are 0. Days of Claude transcripts are not read for it.
    AccountUsage {
        #[serde(default)]
        limits: bool,
    },
    // Needs 225 (codex_reset.rs): Codex reset tickets through the user's own `codex`, only while `usage.codex_resets`
    // is on. Read and log are the owner's (window, owner socket); use is the owner's confirmed click, or a session's
    // ask under the owner's agent policy. Never forwarded to or from another machine, never from a browser or widget.
    CodexResetRead {
        account: String,
    },
    CodexResetUse {
        // The owner's account pick (`own` when absent); a session names none and asks for its own.
        #[serde(default)]
        account: Option<String>,
        #[serde(default)]
        reason: String,
    },
    CodexResetLog,
    // v4 Usage page (usage.html v4): sums over the last `days` (1, 7, 30 or 90) by agent, model, folder and agent
    // session, the 42-day grid and the weekday-by-hour grid, from local transcripts; window and owner only.
    UsageDetail {
        days: u32,
        // Ticket 324: one account as `agent:id`; absent means every account.
        #[serde(default)]
        account: Option<String>,
        // Ticket 324, "Nunchiro sessions only": the agent session ids to count; absent means every record on this Mac.
        #[serde(default)]
        sessions: Option<Vec<String>>,
    },
    /// Context of one local conversation, resolved by the core registry.
    SessionContext {
        id: String,
        /// Ticket 1059: the Context widget's Show breakdown first types /context into the session (window only, as the
        /// read; `Sessions::context_send` says when).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        refresh: bool,
    },
    // ticket-98: the `/` menu's user-level commands, skills and prompts for an agent kind; read only, window and owner only.
    UserCommands {
        kind: AgentKind,
    },
    // v2-2d: owner and window only, local only. Check counts the sessions that lose their history (refused while one
    // is live or resumable); Logout opens the agent's own logout tab; Move puts the folder in `accounts/.trash/` once
    // logout exited 0 or `leftovers` confirms what it left.
    AccountRemove {
        agent: crate::accounts::Agent,
        id: String,
        step: RemoveStep,
        #[serde(default)]
        leftovers: bool,
    },
    // Ticket 178 finding 20: owner and window only, local only. A sign-in runs the agent's own login headless in a new
    // account folder (or the signed-out account `id`), opens its sign-in link in the default browser and registers a
    // new account only once its status command says signed in. Code hands a pasted code to the login's stdin; State
    // reads an attempt; Cancel stops it.
    AccountSignIn {
        agent: crate::accounts::Agent,
        label: String,
        #[serde(default)]
        id: Option<String>,
    },
    AccountSignInCode {
        attempt: String,
        code: String,
    },
    AccountSignInCancel {
        attempt: String,
    },
    AccountSignInState {
        attempt: String,
    },
    // Ticket 358: owner and window only, local only. A tool's update runs its one fixed command from the core's table
    // (agent_update.rs); the tool enum is all a caller chooses. State answers from memory; Cancel ends the update's group.
    AgentUpdateStart {
        tool: crate::agent_update::Tool,
    },
    AgentUpdateCancel {
        tool: crate::agent_update::Tool,
    },
    AgentUpdateState,
    /// Ticket 1100: the models the window offers per agent (Codex's own catalog, else the fixed list).
    AgentModels,
    // v2-5a: agents found on PATH with versions and the transcript counts of their own folders; read only, owner and window only.
    FirstRun,
    // v2-5b: a problem card's fix on an ended session (restart, or start without Nunchiro hooks); owner and window only.
    ProblemFix {
        id: String,
        fix: crate::problems::Fix,
    },
    // V2-8a: `rename` changes the label only; `restore` re-adds a removed worktree at its path from its kept branch;
    // `create` with no branch derives it from `from` (the window's one field: text, a GitHub URL, or empty).
    // `confirm` is the loss the user saw: a dirty remove without the same list removes nothing (owner only).
    Worktree {
        operation: String,
        project: Option<PathBuf>,
        path: Option<PathBuf>,
        branch: Option<String>,
        base: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirm: Option<WorktreeLoss>,
    },
    AgentSend {
        id: String,
        text: String,
    },
    AgentPrompt {
        id: String,
        text: String,
    },
    /// v25-sendkeys: the composer's Ctrl+Enter. Claude Code's send-now breaks the running turn (Esc, through Stop's
    /// gate) and this text then goes in where the ordinary send would put it: at once when the agent is idle, after
    /// the broken turn unwinds when it was working. Nothing is written twice: a kind with no turn to interrupt, or an
    /// Esc that fails, refuses with the reason and leaves the queue as it was.
    SteerNow {
        id: String,
        text: String,
        /// ticket 115, as `SendKeys`: the pending item ids the window has drawn; the interrupt is an Esc and takes
        /// Stop's gate.
        #[serde(default)]
        seen: Vec<String>,
    },
    AgentKeys {
        id: String,
        keys: Vec<String>,
    },
    AgentRead {
        id: String,
        source: String,
        lines: usize,
    },
    AgentGet {
        id: String,
    },
    /// Ticket 573 slice 2: the event log after `since` (`None`: none yet, only the cursor). A session's token sees its
    /// own project's events only; the owner sees all, or `project`'s.
    Events {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<PathBuf>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<u64>,
    },
    CancelSend {
        id: String,
        send: String,
    },
    // v1b-15
    BoardSnapshot,
    BoardSeen {
        id: String,
        completion_seq: u64,
    },
    BoardPut {
        id: Option<String>,
        title: String,
        #[serde(default)]
        note: String,
        session_id: Option<String>,
        column: Option<String>,
    },
    BoardDelete {
        id: String,
    },
    BoardMove {
        source: crate::board::Source,
        id: String,
        column: String,
    },
    // v1b-18: owner only; refused with "card changed" when `updated_at` is not the card's current one.
    BoardResolve {
        identity: String,
        updated_at: u64,
    },
    // v1b-16: replaces board.toml's columns; refused unless `revision` matches the last snapshot.
    BoardColumnsPut {
        revision: String,
        columns: Vec<crate::board::Column>,
    },
    // V2.5-38 (ticket 186): writes board.toml `[settings]`; the owner's and the window's only, refused unless
    // `revision` matches the last snapshot (the board_columns_put rule).
    BoardSettingsPut {
        revision: String,
        stale_minutes: u32,
        turn_end_nudge: bool,
        // Ticket 1066: absent keeps the board's current value.
        #[serde(default)]
        done_days: Option<u32>,
    },
    // V2.5-35 (ticket 183): `BoardTaskRequest` on the socket, same JSON; served by `board::rights::serve`.
    BoardTaskPut {
        id: String,
        #[serde(default)]
        group: Option<String>,
        #[serde(default, rename = "ref")]
        reference: Option<String>,
        #[serde(default, deserialize_with = "crate::board::present")]
        receipt: Option<Option<crate::board::Receipt>>,
        #[serde(default)]
        waits_on: Option<Vec<String>>,
        #[serde(default)]
        attachments: Option<Vec<crate::board::Attachment>>,
    },
    // V2.5-35: owner only.
    BoardUndo {
        id: String,
    },
    // V2.5-35: stores the receipt (when given) and moves the card into the first `proof` column.
    BoardDone {
        id: String,
        #[serde(default)]
        receipt: Option<crate::board::Receipt>,
    },
    // V2.5-35: a new card with its task fields in one write; a refused task field leaves no card.
    BoardAdd {
        title: String,
        #[serde(default)]
        group: Option<String>,
        #[serde(default, rename = "ref")]
        reference: Option<String>,
        #[serde(default)]
        waits_on: Option<Vec<String>>,
        #[serde(default)]
        attachments: Option<Vec<crate::board::Attachment>>,
    },
    // V2.5-35: the caller's attached card (a snapshot with that one card, or none); sessions only.
    BoardSelf,
    // v2-9a: owner and window only.
    TreeGet,
    TreeEdit {
        edit: crate::tree::TreeEdit,
    },
    Start {
        session: StartSession,
        /// Existing managed worktree of `session.project`; absent keeps the normal start path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        folder: Option<PathBuf>,
        /// Ticket 573: `agent start --env KEY=VALUE`, for this start only (a restart or switch does not carry it).
        /// The core takes only allow-list names and refuses secret words (`sessions::check_start_env`, ticket 595).
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        env: std::collections::BTreeMap<String, String>,
        /// Ticket 573 slice 2 (Orca): a start retried with the same receipt returns the first start's session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<String>,
    },
    /// `agent start --anyway`: the owner's `Start` (the only request it carries) that a memory-pressure hold lets
    /// through (`pressure::check`). A session's own token asking it is refused.
    StartAnyway {
        start: Box<Request>,
    },
    /// The window's start that waits for memory when it is held (`pressure::wait`), instead of being refused. Window
    /// only; its other starts keep the refusal and their Start anyway.
    StartOrWait {
        start: Box<Request>,
    },
    /// The starts waiting for memory (owner only).
    MemoryWaitList,
    /// The owner's Start anyway on a waiting start.
    MemoryWaitGo {
        id: String,
    },
    /// The owner's Cancel of a waiting start.
    MemoryWaitCancel {
        id: String,
    },
    List,
    Snapshot,
    Read {
        id: String,
        #[serde(default)]
        after: u64,
    },
    SendText {
        id: String,
        text: String,
        /// The pending item ids drawn before the composer sent its text.
        #[serde(default)]
        seen: Vec<String>,
        /// Gate composer text before any byte can answer an unseen dialog.
        #[serde(default)]
        composer: bool,
    },
    SendKeys {
        id: String,
        keys: Vec<String>,
        /// ticket 115: the pending item ids the window has drawn; a bare Esc is refused while another one is pending.
        #[serde(default)]
        seen: Vec<String>,
        /// ticket 123: this Enter submits text the window just sent; gated like Stop.
        #[serde(default)]
        composer: bool,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Close {
        id: String,
    },
    /// Ticket 1130 C6: close for a restart only while the session is idle; refused while a turn runs or it waits for
    /// the owner, in the same lock as the close, so the window never ends a turn that started after it looked.
    CloseIdle {
        id: String,
    },
    /// Ticket 1113: a lead tidies a session; uncertain work needs an owner card.
    SessionTidy {
        id: String,
        why: String,
    },
    // V2-6d: owner and window only; brings back a stopped or done session closed less than 10 s ago.
    CloseUndo {
        id: String,
    },
    Label {
        id: String,
        label: String,
    },
    Hook {
        id: String,
        event: String,
        payload: serde_json::Value,
    },
    QueueConnect,
    Answer {
        item: String,
        answer: crate::queue::Answer,
        #[serde(default)]
        confirmed: bool,
    },
    Stop,
    // V2-1b: the core exits and leaves every agent running in its holder (`serve restart`); the next core reattaches.
    Exit,
    // F24: `exit`, refused with `server::EXIT_BUSY` while it would lose work (`Sessions::exit_blockers`). Owner only.
    // `holder_floor` is the asking binary's `frame::MIN_COMPATIBLE`: an older core cannot know the next one's.
    ExitIfIdle {
        holder_floor: u16,
    },
    // Ticket 1130 A-D3: what `exit_if_idle` would count now, without exiting, so `update install` waits before it swaps
    // the bundle instead of after. Owner only.
    ExitBlockers {
        holder_floor: u16,
    },
    // v1a-13: the window's port and token, for an owner peer outside every session (the app at page load).
    WindowAuth,
    // v1b-17
    BoardSourceStatus {
        name: String,
    },
    BoardSourceGrant {
        name: String,
        level: crate::approval::Level,
        hash: String,
    },
    BoardSourceMove {
        name: String,
        id: String,
        column: String,
    },
    // v1b-08: confined file access. `root` is a session id or `data`; `path` is relative. Ticket 820 adds the one write.
    FilesList {
        root: String,
        #[serde(default)]
        path: String,
    },
    FileRead {
        root: String,
        path: String,
    },
    /// Ticket 820: the window's one file write. Replaces a text file the window read, refused unless the file on disk
    /// still has `hash` (the `file_read` reply's). Session folders only, never `data`; owner window only.
    FileWrite {
        root: String,
        path: String,
        text: String,
        hash: String,
    },
    FilesSearch {
        root: String,
        query: String,
        #[serde(default)]
        path: String,
        /// Ticket 821 (quick open): match the relative path, any case, instead of the text.
        #[serde(default)]
        names: bool,
    },
    // V2-4a: the approval sheet of an `agents.toml` entry, and its grant at the hash the sheet showed. The grant is
    // human-only: window and owner outside every session (never a session token, the agent CLI or a remote caller).
    AcpAgentStatus {
        name: String,
    },
    AcpAgentGrant {
        name: String,
        hash: String,
    },
    // V2-4b: the setup requests of Settings > Agents. All four are the owner's and the window's alone, like the grant.
    /// Terminal agents found on the core's PATH and the ACP rows (the bundled known list plus `agents.toml`).
    AcpAgents,
    /// The pre-approval check of a typed entry: handshake only, confined, 5 s.
    AcpAgentCheck {
        entry: crate::acp::config::Entry,
        /// The owner pressed "Run check" on an entry that came from agents.toml and is not approved as it stands; the
        /// core refuses that check without it (nothing from agents.toml runs before the owner has seen it).
        #[serde(default)]
        confirmed: bool,
    },
    /// Appends one validated `[[agent]]` table to `agents.toml`; never approves.
    AcpAgentAdd {
        entry: crate::acp::config::Entry,
    },
    /// A visible shell tab running an approved entry's command with no arguments (the agent's own login).
    AcpAgentLogin {
        name: String,
        project: std::path::PathBuf,
    },
    /// Ticket 358: signs in by a method the agent reports; a terminal method opens a tab in `project`.
    AcpAgentSignIn {
        name: String,
        method: String,
        #[serde(default)]
        project: Option<std::path::PathBuf>,
    },
    AcpAgentSignInState {
        attempt: String,
    },
    AcpAgentSignInCancel {
        attempt: String,
    },
    /// Asks the agent to log out, only when it advertises that.
    AcpAgentSignOut {
        name: String,
    },
    // Ticket 276: Agent extensions, the owner window's alone (refused from an agent, a remote machine and a widget).
    /// Skills and hooks, the agents' MCP servers read-only (env names only), and Nunchiro's own servers.
    ExtensionsList,
    /// Adds a server to Nunchiro's own `extensions/mcp.json` (passed per session); never the agent's config.
    ExtensionsMcpAdd {
        name: String,
        command: Vec<String>,
        /// Only sessions of this project folder get it; absent (an older window or CLI too), every project.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<PathBuf>,
    },
    ExtensionsMcpRemove {
        name: String,
    },
    // Ticket 452: an item's files (bounded, links never listed or followed), one file's text, a custom item's file saved,
    // and a new custom skill (off until switched on). `id` is an item's `id` from the list.
    ExtensionsItemFiles {
        id: String,
    },
    ExtensionsItemRead {
        id: String,
        path: String,
    },
    ExtensionsItemSave {
        id: String,
        path: String,
        text: String,
        /// Q9 en-b-J13-4: the text the editor opened. When given, a file that differs on disk now is not written over.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    /// A new custom item: one starting skill, or (`hook`, ticket 580) one starting `hooks/hooks.json`.
    ExtensionsSkillNew {
        name: String,
        description: String,
        #[serde(default)]
        hook: bool,
    },
    /// Ticket 991 C11: a custom item's folder moved to `extensions/.removed/<name>-<unix seconds>` (kept, never deleted);
    /// the shipped skill is not removed.
    ExtensionsItemRemove {
        id: String,
    },
    // v1b-14
    /// What the permission sheet shows for the widget folder `~/.nunchiro/widgets/<name>`.
    ApprovalStatus {
        name: String,
    },
    /// Grants `level` for the folder content whose `hash` the user was shown. Window and token-less CLI only.
    ApprovalGrant {
        name: String,
        level: crate::approval::Level,
        hash: String,
    },
    // Ticket 259: a worktree's repo setup script (`orca.yaml`) for the approval sheet, and what start-an-agent does now.
    // Owner only, local only (`worktree_setup::serve`).
    SetupStatus {
        path: PathBuf,
    },
    /// Approves the script text whose `hash` the sheet showed and runs it in the worktree's visible `setup` tab.
    SetupGrant {
        path: PathBuf,
        hash: String,
    },
    // v1b-11: the session folder's changes against its start commit, plus untracked files. Owner only.
    DiffList {
        session: String,
        /// Ticket 374: what the list compares with; the session's start commit when absent.
        #[serde(default)]
        scope: crate::diff::Scope,
        /// Ticket 373: also read the Diff button's git facts (a few git calls); only the Diff dock asks.
        #[serde(default)]
        git: bool,
        /// Ticket 463: a person asked (Diff opened, Refresh): read git now, never the list kept from its stamp.
        #[serde(default)]
        fresh: bool,
    },
    /// One file's unified patch; `path` must be one `DiffList` returned.
    DiffFile {
        session: String,
        path: String,
        #[serde(default)]
        scope: crate::diff::Scope,
    },
    /// v1a-09: reads the lifetime settings, applying `patch` first (persisted before it takes effect).
    QuitSettings {
        #[serde(default)]
        patch: LifetimePatch,
    },
    /// v25f (F7): owner and window only. Asks each source-control CLI its state, or with `login` / `logout` opens that tab.
    GitProviders {
        #[serde(default)]
        login: Option<crate::git_providers::Id>,
        #[serde(default)]
        logout: Option<crate::git_providers::Id>,
    },
    /// v1a-23: `nunchiro permission-answers on|off`: the verified-yes switch for one project. From inside a session,
    /// `on` waits for the owner (a waiting item); `off` always applies.
    PermissionAnswers {
        project: PathBuf,
        on: bool,
    },
    /// v1a-07b: `nunchiro layout ...`, forwarded to a connected window (owner only).
    Layout {
        args: Vec<String>,
    },
    // v1b-19: script widgets, owner only (no session token reaches them).
    /// The folders under `~/.nunchiro/widgets/` with their approval state.
    WidgetList,
    /// Runs one approved script widget for the project of `session` (none = no project), or returns its
    /// cached run when called before its interval.
    WidgetRun {
        name: String,
        #[serde(default)]
        session: Option<String>,
    },
    /// v1b-20: a click on output row `row` of the run `ran_at_ms` the window showed for the placement on
    /// `session`. The core renders the text from its own cached run; nothing here reaches `answer`.
    WidgetAct {
        name: String,
        #[serde(default)]
        session: Option<String>,
        // v1b-22: `row`/`ran_at_ms` are the script widget's row form; a web widget sends `text` and `target` instead
        // (after the user's Send on its header confirm). A request mixing the two forms is refused.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        row: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ran_at_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<crate::widgets::web::Target>,
        /// v1b-22 r2: the approval hash of the widget page the confirm was drawn for (web form only).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hash: Option<String>,
        /// v1b-34 r2: the frame id of the page that asked (web form only); it must be framed with act.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    /// v1b-22: an approved web widget's entry bytes, approval hash, public approved hosts and `context` (owner only;
    /// refused while `web_widgets` is off or the folder is not approved as it is now).
    WidgetPage {
        name: String,
    },
    /// Plugins (`plugins.rs`): list, on and off, settings, a command run, remove. Owner and window only.
    Plugin {
        action: crate::plugins::Action,
    },
    /// Triggers (`schedule/triggers.rs`): the owner lists, adds, removes and pauses them; the owner or a token of the
    /// `trigger` scope fires one.
    Trigger {
        action: crate::schedule::triggers::Action,
    },
    /// v1a-10: owner only. Claude replies `delivery` (the switch runs as one send row); Codex restarts into
    /// the same conversation and replies `started` with the replacing session.
    SwitchModel {
        id: String,
        model: Option<String>,
        effort: Option<String>,
        /// W35 picker: a Claude session's fast mode, applied by a restart into the same conversation (Claude Code's own
        /// `/fast` saves the choice into the user's settings for every session). Replies `started`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fast: Option<bool>,
        /// W35 picker: ultracode, typed as `/effort ultracode on|off` (session only in Claude Code). Replies `delivery`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ultracode: Option<bool>,
    },
    /// CHAT-MODELIST (ticket 285): owner only. Walks Claude's permission-mode cycle to `mode` (a footer name: `manual`,
    /// `accept edits`, `plan`, `auto`, `bypass permissions`), one logged Shift+Tab at a time, until the footer shows it.
    SetMode {
        id: String,
        mode: String,
    },
    /// Ticket 362: each agent's permission for the sessions the owner starts. Owner only.
    AgentPermissionGet,
    AgentPermissionSet {
        agent: AgentKind,
        choice: PermissionChoice,
    },
    /// Ticket 358: Claude's or Codex's own command, the owner's alone (`approval::command`).
    AgentCommandStatus {
        agent: AgentKind,
    },
    /// Runs only `<path> --version`, confined; a pass holds the command for the grant.
    AgentCommandCheck {
        agent: AgentKind,
        path: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<String>,
    },
    /// Approves the held command whose `hash` the form showed.
    AgentCommandGrant {
        agent: AgentKind,
        hash: String,
    },
    /// Back to the PATH command; `draft_only` drops just the held command.
    AgentCommandReset {
        agent: AgentKind,
        #[serde(default)]
        draft_only: bool,
    },
    // v1b-05: one piece of a composer image, saved to `images/<session>/<sha256>.<ext>` (owner only).
    ImagePut {
        session: String,
        upload: String,
        offset: u64,
        chunk_b64: String,
        last: bool,
        sha256: String,
    },
    /// V2.5-20: one `nunchiro browser` verb, run in the calling session's own space (session callers only).
    Browser {
        verb: crate::browser::Verb,
    },
    /// V2.5-20: the app takes the next browser job (owner only; waits up to `browser::POLL`).
    BrowserNext,
    /// V2.5-20: the app's answer to job `id` (owner only).
    BrowserDone {
        id: u64,
        result: Result<serde_json::Value, String>,
    },
    /// V2.5-15 (ticket 154): the wizard's folder, a new Git repository; owner and window only.
    ProjectCreate {
        name: String,
        /// Ticket 370: `~/` or absolute, no `..`; `~/Projects` when absent.
        parent: Option<String>,
    },
    /// Ticket 370: `git clone` of a typed URL into `parent`; answers at once. Owner and window only.
    ProjectClone {
        url: String,
        parent: String,
    },
    ProjectCloneState {
        job: String,
    },
    ProjectCloneCancel {
        job: String,
    },
    /// V2.5-15: opens a known project, or a file inside one, in the user's editor (`open -t`, or `open -a` the app in
    /// `editor-app`); a path outside every known project is refused. Owner and window only. Ticket 375: also a
    /// session's folder or a managed worktree; the app chosen in Settings (`editor.app`) wins over `editor-app`; `line`
    /// jumps there in an editor with a URL handler (VS Code, Cursor, Zed), else the file opens at its top.
    OpenInEditor {
        path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
    },
    /// Ticket 375: which known editor apps are in /Applications or ~/Applications (Settings' editor row). Owner only.
    EditorApps,
    /// V2.5-15: a chosen image (PNG, JPEG or SVG, at most 256 KiB, base64) as a known project's icon.
    ProjectIconSet {
        project: PathBuf,
        data_b64: String,
    },
    ProjectIconGet {
        project: PathBuf,
    },
    /// Ticket 1040: the folder state of every known project (Settings > Projects). Owner only.
    ProjectFolders,
    /// Ticket 1040 (Locate): the project at `from`, whose folder moved, is the folder `to` from now on; everything the
    /// core stores under `from` moves with it, all or nothing (`sessions::locate`). Owner only.
    ProjectLocate {
        from: String,
        to: String,
    },
    /// V2.5-11 (needs 136): scheduled runs, owner only (`schedule`).
    ScheduleList,
    ScheduleAdd {
        run: crate::schedule::Run,
        /// Local `HH:MM`, or `YYYY-MM-DD HH:MM` for a once-schedule with a date.
        at: String,
        #[serde(default)]
        daily: bool,
        /// Ticket 991 C3: the schedule this one replaces (Edit), in the same write; `None` adds a new one. Ticket 993:
        /// the edited entry keeps the replaced one's switch (`paused`), and its last run unless that failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replace: Option<String>,
        /// Ticket 993: the days of the week a daily entry runs on (0 Sunday to 6 Saturday, sorted); empty: every day.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        days: Vec<u8>,
    },
    ScheduleRemove {
        id: String,
    },
    /// Ticket 993: the entry runs once now, also when it is switched off; its next time does not move. Owner only.
    ScheduleRunNow {
        id: String,
    },
    /// Ticket 993: switches an entry off (`paused`) or on again. Owner only.
    SchedulePause {
        id: String,
        paused: bool,
    },
    /// Ticket 993: the lead of a place proposes a schedule for a teammate of its place, by name
    /// (`nunchiro schedule propose`). `when` is `daily HH:MM`, `weekdays HH:MM`, `weekly <day> HH:MM` or
    /// `once YYYY-MM-DD HH:MM`. Nothing is stored: the user gets a card (`queue::OwnerAsk::Schedule`) and only its
    /// yes adds the entry. Refused to every other caller and to a session that does a scheduled run.
    SchedulePropose {
        who: String,
        when: String,
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<crate::team::Level>,
    },
    /// A bot's seat offers the user a new bot for work it saw come back (`nunchiro bot offer`): `why` is what it
    /// counted. Nothing is made: the user gets a card (`queue::OwnerAsk::Bot`) and only its yes makes the bot, in the
    /// offering bot's place. Refused to every caller that is no bot's seat.
    BotOffer {
        name: String,
        job: String,
        why: String,
    },
    /// Ticket 993: a lead asks to `pause`, `resume` or `remove` (`change`) a schedule it may read; a card, as above.
    ScheduleChange {
        id: String,
        change: String,
    },
    /// Ticket 1002 lane 2: the Home lead stages one outward tool call as the user's Outbox card (`nunchiro outbox
    /// stage`): `tool` the exact tool name it will call (a Gmail `send_message`, `reply`, `forward`; a calendar
    /// `create_event`), `args` the exact arguments, each one shown on the card (any other is refused). Nothing is sent.
    /// Refused to every other caller; a scheduled run of the Home lead may stage. Reply: `Text` (the card in words).
    OutboxStage {
        tool: String,
        args: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    /// Ticket 1002 lane 2: the Home lead's seat (its hook, before the tool runs) asks to make the outward call `tool`
    /// whose `approval::outward_call_hash` is `args_hash`. `Text { text: <card id> }` once, when an approved, unspent
    /// card has exactly that call (it is spent then); otherwise an error, and the call must not run.
    OutboxSpend {
        tool: String,
        args_hash: String,
    },
    /// V2.5-30: `agent list`, the sessions a `session list` shows; `mine` keeps the calling session's direct children
    /// (the caller is the token's or the peer-checked session, never an argument; refused outside every session).
    AgentList {
        #[serde(default)]
        mine: bool,
    },
    /// Ticket 372: arm (`on`) or cancel one resume of session `id` at the reset its limit line shows; owner and window
    /// only. The core then sends the fixed continue text once, at that reset.
    LimitResume {
        id: String,
        on: bool,
    },
    /// The owner is typing for session `id` (the window's composer or terminal); carries no text. Another sender's
    /// queued message waits `TYPING_QUIET` after the last one. Owner and window only.
    Typing {
        id: String,
    },
    /// The owner's choice on another sender's queued message `send` of session `id` (the knock): send it now (no wait
    /// for his typing), later (after his next prompt's turn), attached to his next prompt, or detached again (later).
    /// Owner and window only.
    SendNow {
        id: String,
        send: String,
    },
    SendLater {
        id: String,
        send: String,
    },
    SendAttach {
        id: String,
        send: String,
    },
    SendDetach {
        id: String,
        send: String,
    },
    /// The window's composer took the words `draft_home` gave it; their side file goes. Owner and window only.
    DraftTaken {
        id: String,
        /// The hand-over taken (`draft_home.at`): an answer to an older one leaves newer words alone.
        at: u64,
    },
    /// ⌘Z on words that came home: they go back into the agent's empty box, with no Enter. Owner and window only.
    DraftPutBack {
        id: String,
        words: String,
    },
    /// ⌘Z on another sender's message in the agent's box: its Enter is canceled, the box cleared, and the row waits as
    /// Later. A message the agent already took is not undone. Owner and window only.
    TakeBack {
        id: String,
    },
    /// Type in terminal (`on`) for session `id`: the owner types in the agent's own box; another sender's message waits
    /// (`direct`). It ends by itself 60 s after the last key in that terminal or the last renewal. Owner and window only.
    Direct {
        id: String,
        on: bool,
    },
    /// Ticket 990: a lead opens the seat of a teammate of its place, by name (`nunchiro team open <name>`). Only the
    /// place's lead seat may; the seat starts as its worker, with the teammate's own brief as its first prompt.
    TeamOpen {
        name: String,
        /// Ticket 992: the level the lead asks for this task (`--level`); absent asks none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<crate::team::Level>,
    },
    /// Ticket 990 slice g: the job ledger (`ledger.rs`). `operation`: `new` (`text` is the outcome, `accept` its
    /// conditions), `list`, `show`, `attach` (a worktree at `path` to task `id`), `assign` (`session` sits on a task
    /// that uses no worktree), `pass` / `changes` (a review of what the worktrees hold now, `text` its note), `learn`
    /// (a seat's lesson, `text`, for the merge card), `staff` (`text` is a role's name: what to
    /// start for that seat), `way` / `grant` (the owner's choice for the place, `text`), `merge` (the lead asks the user to merge an approved task: a
    /// card), `done`, `drop`, `package-<part>` and `brief` (ticket 1095). The owner and a place's lead make and close tasks; only a seat that does not write, or the owner,
    /// reviews. `project` is read for the owner only; a session's place is its lead's.
    Task {
        operation: String,
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        text: String,
        #[serde(default)]
        accept: Vec<String>,
        #[serde(default)]
        project: Option<PathBuf>,
        #[serde(default)]
        path: Option<PathBuf>,
        #[serde(default)]
        session: Option<String>,
        /// `learn`: a repo-relative file the lesson is about.
        #[serde(default)]
        cites: Option<String>,
        /// `list`: closed tasks too.
        #[serde(default)]
        all: bool,
        /// Ticket 993 rule 9, `staff`: the level the seat opens at (`--level`); absent asks none, which is standard.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<crate::team::Level>,
        /// Ticket 1003, `promise` and `waiting` (an open loop, `loops.rs`): who it is owed to or awaited from, and its
        /// due date as `YYYY-MM-DD`. `text` is what; `loop-close` names the loop with `id` and says why in `text`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        who: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due: Option<String>,
        /// Ticket 1054, `staff`: the effort the seat opens at (`--effort`), one of its agent's efforts; absent keeps
        /// the level's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        /// Ticket 1095, `package-<part>` (`nunchiro task package`): what the verb carries besides `text`: who said a
        /// quote and when, its images, a link's kind and whether a mockup is approved. `brief` (`seat_up`) needs none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        package: Option<crate::ledger::package::Fill>,
        /// Ticket 1099 panel 4, `ask-cap`: the lead's reason for the live-seat change it asks the user for.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
        /// Ticket 1120, `staff`: the account label the seat starts on (`--account`); absent: the place's account,
        /// else the caller's own.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
        /// `new` and `after`: the ids of the tasks of the same place it waits for; `after` with none clears them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        after: Vec<String>,
    },
    /// Ticket 990 slice i: the user's roles (`roles.rs`). `list`: anyone. `save` (`role`) and `remove` (`name`): the
    /// owner's only. `propose` (`role`, `why`): a place's lead asks the user on a card.
    Role {
        operation: String,
        #[serde(default)]
        role: Option<crate::roles::Role>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        why: Option<String>,
    },
    /// Ticket 990 slice h: accepted notes (`notes.rs`). `list`: the owner reads every note (flagged when its cited file
    /// is gone); a session reads the ones for its place and role. The owner's only: `keep` (lesson `lesson` of task
    /// `task` becomes a note in `scope`, or `text` with no task is the user's own note), `edit` (`id`, `text` and/or
    /// `scope`), `remove` (`id`).
    Note {
        operation: String,
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        scope: Option<crate::notes::Scope>,
        #[serde(default)]
        task: Option<String>,
        #[serde(default)]
        lesson: Option<usize>,
    },
    /// Ticket 571: the project's message room. The sender is the calling session (the person outside every session),
    /// stamped by the core; no field names it. `project` is read for the person only; a session's room is its own.
    RoomSend {
        #[serde(default)]
        to: Option<String>,
        #[serde(default)]
        thread: Option<String>,
        body: String,
        #[serde(default)]
        ask: bool,
        #[serde(default)]
        project: Option<PathBuf>,
    },
    RoomReply {
        message: String,
        body: String,
        #[serde(default)]
        project: Option<PathBuf>,
    },
    RoomCheck {
        #[serde(default)]
        project: Option<PathBuf>,
    },
    RoomThread {
        thread: String,
        #[serde(default)]
        project: Option<PathBuf>,
    },
    /// Ticket 571c: the window's room panel reads the newest `ROOM_READ_MAX` messages of a project's room, read or not,
    /// with no cursor moved. The owner's only: an agent reads its own inbox and threads, never the whole room.
    /// `since` and `log` (the last message number and the log id a reply gave) ask only for what came after; a log that is
    /// no longer that log, or a gap past the read cap, gets the newest messages again with `reset` set.
    RoomRead {
        #[serde(default)]
        project: Option<PathBuf>,
        #[serde(default)]
        since: Option<usize>,
        #[serde(default)]
        log: Option<u64>,
    },
    /// Ticket 593: the person pins (`pinned`) or unpins one message of a project's room; the owner's only, as `RoomRead`.
    RoomPin {
        #[serde(default)]
        project: Option<PathBuf>,
        message: String,
        pinned: bool,
    },
    /// The reply to the caller's own ask, if any; `give_up` with none logs the ask's timeout event.
    RoomAnswer {
        ask: String,
        #[serde(default)]
        give_up: bool,
        #[serde(default)]
        project: Option<PathBuf>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Envelope {
    pub token: String,
    pub request: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Worktree {
    pub project: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    pub label: String,
    #[serde(default)]
    pub missing: bool,
    /// v1a-16: session id of the token caller that created it; owner-created records have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    /// Ticket 990: the lead (team.rs teammate id) whose team this worktree is in: set when the lead's seat or one of
    /// its workers creates it, or when the owner hands it over; absent for an independent worktree. A teammate id,
    /// not a session id, so the team outlives the lead's session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// V2-8a: counted at list time for the reply only (never stored); absent for a missing folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<WorktreeFacts>,
    /// v25f: the worktree root the folder was made under (the setting may change since). A record from before has none
    /// and is stamped with that time's root on the next run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<PathBuf>,
    /// Ticket 374: on the worktree a create just made from origin's default branch when the fetch failed: that branch,
    /// as last fetched, was used (the window's toast). The reply only, never stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_base: Option<String>,
    /// Ticket 253: on the worktree a create just made, the shared paths (and the sparse preset) that failed, each as
    /// `<path>: <reason>` (the window's create line). The reply only, never stored.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_failed: Vec<String>,
    /// Ticket 991 (Q7 point 1): the branch has the name Nunchiro generated (`wt-xxxx`: a create with no name typed),
    /// so the first title of a session in the folder may name it, once (`WorktreePlan::apply_titles`). Stored;
    /// cleared at that title whatever comes of it, and omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_branch: bool,
}

/// V2-8a: a snapshot at list time. With no upstream, `unpushed` counts the commits not on the project's HEAD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct WorktreeFacts {
    pub uncommitted: u32,
    pub unpushed: u32,
    pub upstream: bool,
}

/// V2-8a: what a remove would lose: `git status --porcelain` lines and unpushed commits (`<sha> <subject>`), each
/// list cut at 200 with its full count; `kept_on` is the branch HEAD is on (`None`: detached, the commits go too).
/// `ignored`: git-ignored files a remove deletes too (`.env`, local config), less the build output `worktree_clean`
/// names (`target/`, `node_modules/`, ...), which can be rebuilt.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default, deny_unknown_fields)]
pub struct WorktreeLoss {
    pub uncommitted: Vec<String>,
    pub unpushed: Vec<String>,
    pub uncommitted_total: u32,
    pub unpushed_total: u32,
    pub kept_on: Option<String>,
    pub ignored: Vec<String>,
    pub ignored_total: u32,
    /// Coordinator 11-11 (v37-git-env R2): the status was past the read cap, so nothing is listed; `uncommitted_total`
    /// is then the entries seen, a lower bound, and the confirm still removes (with `--force`).
    pub too_large: bool,
    /// Ticket 253: the shared paths that are links to the project's own file (`worktree_shared`): listed, not lost, so
    /// they count in no total.
    pub linked: Vec<String>,
}

/// V2.5-61 B8: one branch the New worktree dialog may offer. `name` is the short name (`origin/x` for a remote ref);
/// `branch` the branch name create takes (a remote ref's name after its remote, `team/up/x` is `x`); `in_worktree`: a
/// worktree (the main checkout too) has it checked out. No path is ever carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct BranchRef {
    pub name: String,
    pub branch: String,
    pub remote: bool,
    pub in_worktree: bool,
}

/// V2-8a: one auto-clean removal; the branch is kept, so `restore` with these fields is its Undo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct WorktreeCleaned {
    pub id: u64,
    pub project: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    pub label: String,
    pub at_ms: u64,
}

/// V2.5-31 (needs 145): the orchestration skill's switch, stored by the core under `orchestration` in settings.json and
/// written only through the owner's `QuitSettings`. Owner F5 (2026-11-08): no agent limits; each agent follows its own settings.
// Unknown keys stay allowed: a settings.json from before F5 still holds level, max_workers, max_depth, merge, auto_close_finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct OrchestrationSettings {
    pub enabled: bool,
}
impl Default for OrchestrationSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default, deny_unknown_fields)]
pub struct OrchestrationPatch {
    pub enabled: Option<bool>,
    /// Creates the (empty) override folder so the window can open it; an empty folder changes nothing, the built-in files still serve.
    pub create_override: Option<bool>,
}

/// Ticket 1059: Claude's /context "Estimated usage by category" table, as its transcript record wrote it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Breakdown {
    /// When Claude wrote the record, epoch ms.
    pub at: u64,
    /// Empty: the record was there but its table could not be read.
    pub rows: Vec<BreakdownRow>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct BreakdownRow {
    pub label: String,
    pub tokens: u64,
    pub pct: f64,
}
