//! Session registry: lifecycle, launch policy and metadata share one owner.
use crate::{
    api::*,
    files,
    pty::{Attach, Pty},
    queue::{self, Queue},
    store, waiting,
};
mod claude_modes; // W35 picker
mod handoff_acp; // 2026-11-20: moved out for the 1 MiB publish scan
pub(crate) use handoff_acp::{handoff_send, problem_fix};
pub(crate) mod locate; // ticket 1040
mod prelock; // ticket 1002 lane 1
#[cfg(test)]
mod reattach_tests; // V2-1b
mod room; // ticket 571
mod seat_env; // S-m1, ticket 1002
mod start_worktree; // w35: a worktree start's base and branch
pub(crate) use room::open_ask; // ticket 990 slice g: a task's open questions
mod switch_hooks; // Q9 en-b-J7-2
pub(crate) use switch_hooks::switch_model;
pub(crate) mod skill;
mod tokens; // ticket 573
mod wake; // ticket 159
use portable_pty::CommandBuilder;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
pub(crate) use wake::report_status; // ticket 1081: advance.rs and the task views read a seat's report
// Ticket 1143: the registry split by responsibility; each child says its own in one `//!` line.
mod account_use;
mod agent_calls;
mod answer;
mod close;
mod codex_config;
mod deliver;
mod handoff;
mod home;
mod launch;
mod machines;
mod model_mode;
mod observe;
mod outbox;
mod persist;
mod program;
mod read;
mod refresh;
mod schedules;
mod screen;
mod seats;
mod send;
mod settings;
mod spawn;
mod start;
mod worktrees;
pub(crate) use answer::*;
use close::*;
use codex_config::*;
pub(crate) use deliver::*;
pub(crate) use launch::*;
pub(crate) use machines::*;
pub(crate) use model_mode::*;
pub(crate) use observe::*;
use persist::*;
use program::*;
pub(crate) use read::*;
use refresh::*;
use screen::*;
use send::*;
use settings::*;
pub(crate) use spawn::*;
pub(crate) use start::*;
pub(crate) use worktrees::*;

/// v25-sendkeys: a PTY write that failed after Claude's input was marked uncertain may have landed partway, so the
/// window must not type it again; any other write failure is a plain refusal.
fn typed_error(error: String, uncertain: bool) -> String {
    if uncertain {
        crate::delivery::UNCERTAIN.into()
    } else {
        error
    }
}
/// The agents whose input box the core follows: keys or words typed there by hand mark it edited (`Input::edited`)
/// until the owner's Enter, and a dropped prompt is never pasted behind them.
fn hand_edits(kind: AgentKind) -> bool {
    matches!(kind, AgentKind::Claude | AgentKind::Codex)
}
#[derive(Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Settings {
    /// Ticket 1083: the user's home (`$HOME`), read once when the core opens; the unset worktrees folder lies in it.
    #[serde(skip)]
    user_home: PathBuf,
    // v1a-06
    machines: BTreeMap<String, crate::machines::Config>,
    disable_hook_injection: bool,
    worktrees_dir: Option<PathBuf>,
    stale_after_ms: Option<u64>,
    permission_answers: BTreeMap<PathBuf, bool>,
    // v1a-09
    session_lifetime: Lifetime,
    start_at_login: bool,
    // v1b-19: off until the security review (ticket 21) turns it on.
    script_widgets: bool,
    // v1b-22: web widgets, off until their security review (ticket 23); no UI toggle.
    web_widgets: bool,
    // v1a-74 (needs 79): an absent key keeps history, so not `bool::default`; see `history`.
    keep_history: Option<bool>,
    mask_history: bool,
    // v2-8c (needs 82): live PR status through the user's gh, off by default; its one-time offer; pinned PR links.
    live_pr_status: bool,
    live_pr_offered: bool,
    pr_watch: Vec<String>,
    // V2-8a: auto-clean merged worktrees, off by default (worktree_clean.rs).
    auto_clean_worktrees: bool,
    // V2-CF5 (needs 124): hold off idle system sleep while any session works; off by default.
    keep_awake: bool,
    // V2.5-31 (needs 145)
    orchestration: OrchestrationSettings,
    // Ticket 211: canonical folders the owner allowed Usage to read through a link; `usage.rs` reads the file itself.
    usage_link_roots: Vec<PathBuf>,
    // Ticket 250: absorb features' own values by dotted key (`quit_settings` checks key and size); read with `feature`.
    features: BTreeMap<String, serde_json::Value>,
}
impl Settings {
    /// Ticket 250: a feature's stored value; absent or of another type is `None`, so the reader uses its default.
    pub(crate) fn feature<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.features.get(key).and_then(|v| T::deserialize(v).ok())
    }
    /// v25f: the root a record without its own was made under: an absolute `worktrees_dir`, else `<home>/worktrees`
    /// (a relative setting is new with v25f, so no older record lies under one).
    fn legacy_worktree_root(&self, home: &Path) -> PathBuf {
        match &self.worktrees_dir {
            Some(d) if d.is_absolute() => d.clone(),
            _ => home.join("worktrees"),
        }
    }
    /// v25f: where `project`'s new worktrees go (each under `<root>/<repo name>/`).
    fn worktree_root_for(&self, project: &Path) -> Result<PathBuf, String> {
        worktree_root_for(self.worktrees_dir.as_deref(), project, &self.user_home)
    }
    /// Ticket 1083: the visible `<user home>/nunchiro` folder the unset default lies in; none when a setting names the folder.
    fn default_base(&self) -> Option<PathBuf> {
        self.worktrees_dir
            .is_none()
            .then(|| self.user_home.join("nunchiro"))
    }
    /// v1a-74: `None` writes no scrollback; else whether the saved copy is masked.
    fn history(&self) -> Option<bool> {
        self.keep_history
            .unwrap_or(true)
            .then_some(self.mask_history)
    }
}
struct Entry {
    meta: Session,
    pty: Option<Pty>,
    /// The PTY's size as this core last set it (the holder opens at 160x50); `None` when unknown, as after a reattach
    /// (the holder keeps the last client's size). Only a known equal size lets `resize_pty` skip.
    pty_size: Option<(u16, u16)>,
    /// The token an inside peer's owner token is swapped for (V2-1b: after a reattach, a fresh in-memory alias, since
    /// only the agent holds its real token).
    token: Option<String>,
    /// V2-1b: SHA-256 of the agent's token, as sessions.json keeps it; the agent's token is checked against it.
    token_hash: Option<String>,
    /// V2-1b: a live holder this core did not attach (another protocol, or not answering), while its agent runs.
    stale: Option<Stale>,
    observer: waiting::Observer,
    input: crate::delivery::Input,
    // v1a-10: a Claude model switch in flight, advanced by `tick` from what the screen shows; the launch's
    // extra args, which a Codex restart passes again. `None` when not known: a session restored from disk or
    // started as a resume (the conversation's first launch args are gone).
    switch: Option<Switch>,
    args: Option<Vec<String>>,
    /// W35 round 5: what this run was started with, a resume's own too (none with `--env`), for a fast restart; kept
    /// in `store::Live`, never on the row.
    launch: Option<Vec<String>>,
    /// Ticket 362: the arguments the owner's stored permission added at launch. A Codex model switch passes them again (a
    /// restored entry has none, and `carried_codex_args` refuses its switch); a problem-card restart reads the stored choice.
    permission: Vec<String>,
    /// Ticket 362: Claude's settings turned Bypass permissions off when this session started (or at the last pick).
    bypass_disabled: bool,
    // CHAT-MODELIST: a walk to a picked permission mode (advanced by `tick`), how the last one failed, and whether the
    // owner chose Bypass permissions for this session (picked it, or launched in it). In memory only.
    walk: Option<Walk>,
    walk_error: Option<ModeWalk>,
    skip_chosen: bool,
    // CHAT-MODELIST r4: a failed walk left (or may have left) the footer in Skip permissions the owner never confirmed:
    // other input stays held until a mode other than that is positively read.
    skip_hold: Option<SkipHold>,
    // v1a-40: without a PTY, the scrollback saved when it stopped; read from disk once, on the first read.
    saved: std::cell::OnceCell<Option<crate::pty::Saved>>,
    // v1a-33: the folder probe of a session this core started, until `refresh` reads its answer or the bound passes.
    probe: Option<(
        std::time::Instant,
        std::sync::mpsc::Receiver<std::io::Result<()>>,
    )>,
    // V1A-89: the `--version` probe still running when its Start went on; `refresh` reads its answer.
    version_probe: Option<VersionProbe>,
    // V2-4a: an ACP session's agent (a stdio child of the core); `None` for PTY sessions and once it ended.
    acp: Option<crate::acp::Acp>,
    // Ticket 286: the agent quit and its wrapper left a shell on the PTY (`AGENT_WRAPPER`); the session stays Running
    // for the user's keys only. Set from the wrapper's marker and never cleared (a restarted core reads it again).
    agent_ended: bool,
    // Ticket 488: the agent ended (its exit code) and its why-it-ended card waits for its last output, until this time.
    card_due: Option<(std::time::Instant, Option<i32>)>,
}
/// V2-1b: a running session without an attached PTY: its holder and agent, as recorded.
struct Stale {
    record: crate::holder::Record,
    pid: u32,
    started: Option<u64>,
    /// Ticket 512: the stored `run_start`, for the attach a retry makes.
    run_start: u64,
    /// When a silent holder is tried again.
    retry: std::time::Instant,
    /// Ticket 353: `PEER_CHECK_BUSY` answers so far. Ticket 385: another failed answer in between does not reset it.
    busy: u32,
}
impl Entry {
    /// Seventh look (B S1-1): the screen model a resize blanked is filled again by the agent's redraw. With nothing
    /// drawn once the redraw's time is over, the terminal still shows what it showed: the old screen comes back at
    /// the new size. `true`: restored now (the tick tells the queue, `Queue::undrawn`, so the prompt's card stays the
    /// card it was).
    fn restore_undrawn(&mut self) -> bool {
        let over = std::time::Duration::from_millis(queue::RESIZE_GRACE_MS);
        if self
            .observer
            .unredrawn
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() >= over)
            && let Some((old, _)) = self.observer.unredrawn.take()
        {
            if !self.observer.screen.drawn()
                && let Some((cols, rows)) = self.pty_size
            {
                self.observer.screen = old.fit(cols as usize, rows as usize);
                self.observer.recheck = true;
                return true;
            }
            // Lane w96: a redraw that cleared and drew nothing in the time is read again, so its card goes.
            self.observer.recheck |= self.observer.screen.blank();
        }
        false
    }
    /// V2-1b: the session's holder record and its agent's start time, attached or not.
    fn holder(&self) -> Option<(&crate::holder::Record, Option<u64>)> {
        match (&self.pty, &self.stale) {
            (Some(pty), _) => Some((pty.holder(), pty.agent_started())),
            (None, Some(stale)) => Some((&stale.record, stale.started)),
            (None, None) => None,
        }
    }
    /// Ticket 286: an agent is at work on this session, so the agent paths (sends, delivery, answers, hooks, tokens)
    /// apply. A shell left after the agent quit takes only the user's own keys.
    fn agent_live(&self) -> bool {
        self.meta.state == SessionState::Running && !self.agent_ended
    }
}
/// Ticket 372: the only text a resume at reset types (T3 UsageLimitRecoveryWorker.ts:66).
pub(crate) const CONTINUE_TEXT: &str = "Continue where you left off.";
/// Ticket 1081: the sender of a line the core itself types (auto-advance); never a seat id or a token caller.
pub(crate) const CORE: &str = "core";
const STALE_RETRY: std::time::Duration = std::time::Duration::from_secs(5);
/// Ticket 353: a holder still busy after this many tries (about 35 s, backing off) is not under load and will not admit
/// this core: a holder from before the fix whose app was updated answers busy for as long as it lives.
const BUSY_TRIES: u32 = 4;
pub struct Sessions {
    // v1a-06: remote authority expires with this local core.
    pub(crate) remote: crate::machines::State,
    remote_epoch: String,
    start_modes: Option<Modes>, // W35: `start_with_modes`, for one `spawn`
    home: PathBuf,
    /// Ticket 752: the conversations of dropped Closed token rows and their origins, saved in sessions.json.
    token_conversations: Vec<store::TokenConversation>,
    /// Ticket 961: a set-aside store's origins could not all be read (`store::load_all`), so any conversation may be
    /// a token's: a token's resume of one with no known origin is refused.
    origins_lost: bool,
    // v1b-02: plans never perform I/O while the registry is locked.
    chat: crate::chat::Cache,
    settings: Settings,
    pub(crate) queue: Queue,
    entries: BTreeMap<String, Entry>,
    recovery_warnings: usize,
    grants: crate::grants::Grants,
    delivery_inflight: BTreeMap<String, u64>,
    // Ticket 159: per worker, the (state, turn) wakes already sent or dropped (in memory, like `grants`).
    wakes: BTreeMap<String, std::collections::BTreeSet<(wake::Reached, u64)>>,
    room: room::State, // ticket 571
    // v1a-15: per session, the submit send whose pasted text is written and whose Enter a later tick writes.
    pending_enter: BTreeMap<String, PendingEnter>,
    /// Ticket 1137: per plain shell still waiting for a window's size, the file that ends the wait (`spawn`).
    size_waits: BTreeMap<String, PathBuf>,
    /// Look 11-17 v8 N1: per session, the last submit whose Enter the core wrote and has not seen taken (`verify_submits`).
    submitted: BTreeMap<String, Submitted>,
    // v1b-20: queued widget acts by send id -> the approved hash their text was rendered from (in memory: a restart
    // never replays a queued send).
    widget_hashes: BTreeMap<String, String>,
    // V2-8e: queued deny instructions by send id (in memory, like `widget_hashes`): each waits until no prompt shows.
    deny_notes: std::collections::BTreeSet<String>,
    /// Look 11-17 v6r B5-S2-3: the answers to a Codex async question by send id (in memory, like `deny_notes`). Each
    /// goes into the turn that waits for it: Codex sleeps a minute at a time for the answer, and held for the turn's
    /// end as every other send is, it came 60 to 130 s late.
    steers: std::collections::BTreeSet<String>,
    /// The finish lines the core queued for a worker, by send id (in memory). The core typed them, so they go in also
    /// after that worker's agent ended: ticket 286 stops what an ended agent itself had queued, and a worker that
    /// exited while its lead could not take the line was never heard of.
    wake_rows: std::collections::BTreeSet<String>,
    /// Ticket 1081: the lines auto-advance typed as the core (sender `CORE`), by send id (in memory; also in
    /// `wake_rows`, so the user's rows go first). Only the core adds to it: a sender named "core" from anywhere else
    /// is no seat and no token, and `send_refused` cancels its rows.
    core_rows: std::collections::BTreeSet<String>,
    /// Ticket 1056: the wake lines joined into a written wake row, by that row's send id (in memory). They stay
    /// `attempting` until that row ends, and then end as it does (`mark_send`).
    joined_rows: BTreeMap<String, Vec<String>>,
    /// Ticket 1085: sessions whose input box still holds an automatic line the core pasted and whose Enter was dropped
    /// (in memory). The next submit there clears it first (`clear_box_first`), so the owner's words never join it.
    left_typed: std::collections::BTreeSet<String>,
    /// Ticket 1085: automatic rows put back in the queue once after a dropped Enter, by send id; a second drop fails.
    retried: std::collections::BTreeSet<String>,
    /// Ticket 1094: when each `delivery_inflight` mark was set (in memory), so an idle agent releases it (`delivery_open`).
    inflight_at: BTreeMap<String, std::time::Instant>,
    /// Ticket 1094: a user message (by send id) whose Enter was dropped again waits until then before the next try.
    retry_at: BTreeMap<String, std::time::Instant>,
    /// Ticket 1094: dropped Enters of each queued user row, by send id (in memory).
    drops: BTreeMap<String, u32>,
    /// Ticket 1094 r5: by session, the user's row whose dropped paste the core left in the box. Gone once the core
    /// clears the box (Ctrl+U), pastes into it again, or an Enter sends it: only while it is set can his own Enter
    /// have sent that copy.
    copy_left: BTreeMap<String, String>,
    /// Ticket 1094 r6: by session, what the owner typed by hand since that drop (None once a key or text the core
    /// cannot follow went in): the box proves the copy only as the paste with exactly these words around it.
    hand_typed: BTreeMap<String, Option<String>>,
    /// Ticket 1121: queued rows (by send id) the core will not paste again (`Session::stopped_sends`), in memory.
    spent: std::collections::BTreeSet<String>,
    /// Ticket 1121: by send id, when a guarded row first and last found no clean box (`CLEAN_WAIT`).
    clean_wait: BTreeMap<String, (std::time::Instant, std::time::Instant)>,
    /// Ticket 1094 r6: by session, the dropped row his own Enter sent with the box as proven (send id, completion_seq
    /// and working at his Enter, its time in ms and as an Instant). It is delivered once a turn starts after that
    /// Enter (`settle_hand_sent`); until then the core does not paste it, and with no turn it goes again.
    hand_sent: BTreeMap<String, (String, u64, bool, u64, std::time::Instant)>,
    /// Gap rule: by session, until when the owner counts as typing there (`Typing`, a key in its terminal). Another
    /// sender's line waits until then (in memory, as every mark below: queued rows never outlive a core).
    typing_until: BTreeMap<String, std::time::Instant>,
    /// Gap rule: rows (send id) the owner said to send now: no wait for his typing, no Later.
    now_rows: std::collections::BTreeSet<String>,
    /// Gap rule: rows the owner put off until after his next prompt, by send id: `None` until a submit of his went in,
    /// then the turns finished at that moment; the row waits until a turn ends after it.
    later_rows: BTreeMap<String, Option<u64>>,
    /// Gap rule: rows the owner attached to his next prompt; they go in with it, under his words.
    attached: std::collections::BTreeSet<String>,
    /// Type in terminal: by session, until when the owner types in the agent's own box (`Direct`, renewed by his keys).
    direct_until: BTreeMap<String, std::time::Instant>,
    /// Text left in the terminal comes home (home.rs): the clears written and not seen yet, the words the composer has
    /// not taken (also on disk), the sessions whose Type in terminal just went off, and each session's still output.
    homing: BTreeMap<String, home::Homing>,
    drafts_home: BTreeMap<String, home::DraftHome>,
    home_ask: std::collections::BTreeSet<String>,
    home_quiet: BTreeMap<String, (u64, std::time::Instant)>,
    /// Home view change 4: the leads (teammate id, prompt) a goal the user sent must reach; `team::wake_goals` opens
    /// each seat off the registry lock and hands it the goal.
    pub(crate) goal_wakes: Vec<(String, String)>,
    /// Ticket 1003: when the open loops were last read for overdue rows (ms).
    loops_checked: u64,
    removing_worktrees: std::collections::BTreeSet<PathBuf>,
    /// Ticket 991 (Q7 point 1): (folder, title) of each session outside its project's checkout that just got its title
    /// from its first prompt; the next worktree request takes them (`take_branch_titles`) and names a generated branch.
    branch_titles: Vec<(PathBuf, String)>,
    /// Look 11-17 w10 item 1: a question's "Type something" answer whose digit is written; its words go once the
    /// screen shows the text field.
    typed_answers: BTreeMap<String, TypedAnswer>,
    /// Verify look (ticket 991 A11): the size a window last gave a PTY. A new PTY takes it at once, so a shell draws its
    /// first prompt at the window's width, not at 160 columns that the window's first resize then reflows into a second prompt.
    window_size: Option<(u16, u16)>,
    // Ticket 32: account folder -> its logout tab (in memory). While that row is listed, no agent starts on the folder.
    pub(crate) logouts: BTreeMap<PathBuf, String>,
    // v1b-15
    board_error: Option<String>,
    // S9: the rows the board last observed, with the `board_key` they were built at.
    board_rows: Option<(u64, Vec<Session>)>,
    // S9: the `board_key` and time of the last board observation.
    board_observed: Option<(u64, std::time::Instant)>,
    // v1a-33: opens a new session's folder off the lock; tests swap it for a fake refusal or hang.
    folder_probe: fn(&Path) -> std::io::Result<()>,
    // v1a-33: probe threads not yet answered, at most PROBES_MAX.
    probes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    // V2-1a: a session being launched and its token's hash, saved before the agent starts.
    launching: Option<(String, String)>,
    // V2-1b: the core let go of its sessions (`exit`); nothing is saved or polled after that.
    left: bool,
    // Q9 en-b-J7-2: read off the lock; ticket 1150: with the question that restart's Codex said yes to.
    switch_hooks: Option<(switch_hooks::Key, bool, crate::outward::CodexAsk)>,
    // Ticket 990: the owner's Stop ran (`stop`); a start that was preparing outside the lock sees it (`stopped`).
    halted: bool,
    // Ticket 990: what the window's composer typed into a session and has not entered yet (`send_text`, then the
    // Enter of `send_keys`): the entered text is what the user told a sub-bot (`told`).
    composed: std::collections::HashMap<String, String>,
    /// Look 11-17 v5 item 1: sessions whose composer text was queued behind a start question; the composer's own Enter
    /// that follows it writes nothing.
    held_enter: std::collections::HashSet<String>,
    /// Ticket 992: for each session, the count of finished turns (`completion_seq`) its last input needs before its
    /// input box is known empty again: any text or key sent to it (by the user, an agent or the core's own delivery)
    /// sets it to the count at that moment, plus one while a turn runs (text typed during a turn is still in the box
    /// when that turn ends). A session not in the map (all of them after a core restart) is never known empty. Only
    /// a seat past its mark is idle (`seat_idle`).
    touched: std::collections::HashMap<String, u64>,
    /// Ticket 1130 B-L3 round 3: by resumed ACP session, the rows it continues. An ACP agent loads a conversation
    /// after its start (`session/load`), so those rows stay, with the conversation id, until the load succeeded
    /// (`refresh`): a load that fails leaves the conversation in History; nothing ever drops them on a failure. In
    /// memory only: after a core restart they stay as well.
    acp_loading: BTreeMap<String, Vec<String>>,
    /// Ticket 1130 B-L3 round 5: the rows an Undo is about to continue, while that op runs (`hold_row`). With the rows
    /// in `acp_loading` they are out of the Closed-row bound (`drop_closed`): each is the only place its conversation
    /// id lives until the resume has succeeded.
    held_rows: std::collections::BTreeSet<String>,
    /// Ticket 1003 (Codex note on w79): each spent Outbox mail (with when it was spent), whose waiting-for row waits
    /// for that very call's PostToolUse; a failed call fires no PostToolUse, so its row is never made.
    outbox_sending: Vec<(u64, queue::Approved)>,
    // v1a-68 r3 (needs 78): closed shells whose view is held in memory, oldest first, at most CLOSED_VIEWS.
    closed_views: std::collections::VecDeque<String>,
    // V2-6d: the one stopped or done session closed less than CLOSE_UNDO_MS ago, out of `entries` and sessions.json.
    closing: Option<Closing>,
    // Ticket 1073: every conversation id a saved row held (ran.json), which outlives the row's close.
    ran: std::sync::Mutex<crate::import::Ran>,
    // Ticket 999: a pass changed rows that are not on disk yet (`save_unsaved`); any `save` writes them with the rest.
    unsaved: std::sync::atomic::AtomicBool,
    // V2-6d follow-up: how many times `save` ran (tests count the writes of a path).
    #[cfg(test)]
    saves: std::sync::atomic::AtomicUsize,
    // Ticket 300 step 2: rows an ended session's cancel walked, and session snapshots taken (tests count lock work).
    #[cfg(test)]
    exit_walked: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    snapshots: std::sync::atomic::AtomicUsize,
    // V2.5-85: queued send rows the delivery tick cloned.
    #[cfg(test)]
    send_clones: std::sync::atomic::AtomicUsize,
    // v2-9a: tree.toml; an unreadable file stays an error (reads fail, edits are refused) and is never overwritten.
    tree: Result<crate::tree::Tree, String>,
    // V2.5-11: schedules.json; an unreadable file is never overwritten and nothing fires.
    pub(crate) schedules: crate::schedule::Schedules,
    /// Look 11-17 v8 (Home S2-B): the entries the owner asked to run again on a failed run's card; the schedule timer
    /// runs them off this lock (`schedule::fire`), as Run now.
    pub(crate) schedule_reruns: Vec<String>,
    /// Ticket 1004: the check-ins that wait for the judge, at most one per task (`check_in_due`); the server's loop
    /// has them judged off this lock (`start_judge`: git is read there).
    pub(crate) check_ins: Vec<crate::ledger::CheckIn>,
    // V1A-74 follow-up: scrollback writes taken under the registry lock, done by `drain_scrollback` after it.
    writes: Writes,
    // Ticket 372: session -> the reset (epoch second) of the limit the owner armed one resume at. In memory only: a core
    // restart forgets it, like the mark itself.
    limit_resumes: BTreeMap<String, i64>,
    // Ticket 573 slice 2: each session's last state the event log saw.
    events: crate::events::Seen,
}
/// V2-6d: a row kept whole for its Undo until `until` (core time, ms).
struct Closing {
    entry: Entry,
    until: u64,
    /// Who closed it: phase 2 runs with the same authority (a session caller never ends a stale holder).
    owner: bool,
}
/// V2-6d: how long a closed stopped or done session can be brought back.
pub(crate) const CLOSE_UNDO_MS: u64 = 10_000;
/// Look v20 S1: an Outbox card's Undo after the core approved it.
pub(crate) const OUTBOX_TOO_LATE: &str =
    "too late to undo: it was already approved, and the chief of staff is sending it";
/// Milliseconds since the first call in this process: the monotonic elapsed time plus the largest lead the wall clock
/// ever had over it. A Mac sleep stops `Instant` but not the wall clock, so it adds its length to the lead and ends the
/// Undo window; the lead never shrinks, so a wall clock set back afterwards cannot run this clock backwards and widen
/// the window. A core restart (clock back to 0) ends a pending close at `open`.
// shortcut: a wall clock set forward ends a pending close early and stays in the lead (it only shortens the window);
// upgrade only if users report lost Undos.
pub(crate) fn close_clock() -> u64 {
    static START: std::sync::OnceLock<(std::time::Instant, std::time::SystemTime)> =
        std::sync::OnceLock::new();
    let (mono, wall) =
        START.get_or_init(|| (std::time::Instant::now(), std::time::SystemTime::now()));
    static OFFSET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    clock_ms(
        &OFFSET,
        mono.elapsed().as_millis() as u64,
        wall.elapsed().map_or(0, |d| d.as_millis() as u64),
    )
}
/// The two elapsed times of `close_clock`, combined through the lead kept in `offset`; `wall` is 0 when the wall clock
/// went back.
fn clock_ms(offset: &std::sync::atomic::AtomicU64, mono: u64, wall: u64) -> u64 {
    let lead = wall.saturating_sub(mono);
    let kept = offset.fetch_max(lead, std::sync::atomic::Ordering::SeqCst);
    mono + kept.max(lead)
}
/// A scrollback write waiting for `drain_scrollback`.
enum Write {
    Save {
        bytes: Vec<u8>,
        mask: bool,
    },
    /// An ended session's file, masked in place (the owner turned masking on).
    Remask,
}
#[derive(Default)]
struct Writes {
    /// At most one per id, oldest first.
    queued: Vec<(String, Write)>,
    /// Ids a drain is writing now, outside the lock.
    writing: std::collections::BTreeSet<String>,
    /// Ids among `writing` whose file must not stay (closed, replaced, or history turned off meanwhile).
    dropped: std::collections::BTreeSet<String>,
}
/// Held for a whole drain, so drains run one at a time and in order: a later one never sees an older write land
/// after its own, and the Stop reply's drain returns only once an earlier tick's drain is done.
static DRAINING: std::sync::Mutex<()> = std::sync::Mutex::new(());
impl Sessions {
    pub fn handle(&mut self, request: Request) -> Response {
        if self.left {
            return Err("core is stopping".into());
        }
        if matches!(request, Request::Stop) {
            self.stop()?;
            return Ok(Reply::Ack);
        }
        if matches!(request, Request::Exit) {
            self.leave()?;
            return Ok(Reply::Ack);
        }
        if !matches!(request, Request::Close { .. }) {
            self.refresh()?;
            self.observe()?;
        }
        match request {
            Request::AddMachine { alias, host, user, port, replace } => self.add_machine(alias, host, user, port, replace),
            Request::ForgetMachine { .. } => Err("machine removal requires unlocked owner dispatch".into()),
            Request::MachineDetails { .. }
            | Request::MachineAliases
            | Request::MachineProbe { .. }
            | Request::MachineShare
            | Request::MachineTrust { .. } => {
                Err("machine discovery requires unlocked owner dispatch".into())
            }
            // v1a-06: transport requests are handled outside the registry lock.
            Request::RemoteService { .. }
            | Request::Remote { .. }
            | Request::Forwarded { .. }
            | Request::MachineStatus { .. } => Err("transport requires owner dispatch".into()),
            // v1a-13: answered by the socket server after its owner peer check.
            Request::WindowAuth => Err("window auth requires owner dispatch".into()),
            // V2.5-20: only the owner socket serves these (`browser::serve`); the window drives its view directly.
            Request::Browser { .. } | Request::BrowserNext | Request::BrowserDone { .. } => {
                Err("browser verbs run only on the owner socket".into())
            }
            // v1b-02
            Request::ChatPage { .. } => Err("chat requires unlocked transport dispatch".into()),
            Request::HandoffPreview { .. } | Request::HandoffSend { .. } => {
                Err("handoff requires unlocked transport dispatch".into())
            }
            Request::PrChip { .. } => Err("pr chip requires unlocked transport dispatch".into()),
            Request::Subagents { .. } => Err("subagents require unlocked transport dispatch".into()), // V2-CF4
            Request::PrLive { .. }
            | Request::PrLiveSet { .. }
            | Request::PrWatch { .. }
            | Request::PrFront { .. } => Err("live PR status requires the window".into()),
            Request::PrView { .. } | Request::PrList | Request::PrMerge { .. } => {
                Err("the PR view requires the window".into())
            }
            Request::PrBranch { .. } => Err("the PR view requires the window".into()), // ticket 373
            // v2-10c: answered by the socket server after its owner check.
            Request::LibsResolve { .. } | Request::LibsEntry { .. } => {
                Err("libraries require owner dispatch".into())
            }
            // Ticket 573: answered by the socket server after its owner check.
            Request::TokenCreate { .. } | Request::TokenList | Request::TokenRevoke { .. } => {
                Err("tokens require owner dispatch".into())
            }
            Request::AccountList
            | Request::AccountCheck { .. }
            | Request::AccountAdd { .. }
            | Request::AccountRename { .. }
            | Request::AccountRemove { .. } => {
                Err("accounts require unlocked transport dispatch".into())
            }
            // Ticket 178 finding 20: each returns at once (the login runs on its own thread), so under the lock.
            request @ (Request::AccountSignIn { .. }
            | Request::AccountSignInCode { .. }
            | Request::AccountSignInCancel { .. }
            | Request::AccountSignInState { .. }) => {
                crate::account_signin::handle(&self.home, request, |folder| {
                    // A logout mark outlives its exited tab until the tab closes, a login, or the remove's Move step.
                    !self.account_users(folder).0.is_empty()
                        || self
                            .logouts
                            .get(folder)
                            .and_then(|id| self.entries.get(id))
                            .is_some_and(|tab| tab.meta.state != SessionState::Closed)
                })
            }
            // Ticket 358: each returns at once (the update and the version reads run on their own threads).
            request @ (Request::AgentUpdateStart { .. }
            | Request::AgentUpdateCancel { .. }
            | Request::AgentUpdateState) => crate::agent_update::handle(&self.home, request),
            // Ticket 1100: Codex's own model list (or the fixed one); read-only, no path in the reply.
            Request::AgentModels => Ok(Reply::AgentModels {
                codex: crate::agent_models::codex(),
            }),
            Request::SessionContext { .. } => Err("context requires window dispatch".into()),
            Request::AccountUsage { .. } | Request::UsageDetail { .. } => {
                Err("usage requires unlocked transport dispatch".into())
            }
            Request::CodexResetRead { .. }
            | Request::CodexResetUse { .. }
            | Request::CodexResetLog => {
                Err("codex resets require unlocked transport dispatch".into())
            }
            Request::GitProviders { .. } => {
                Err("git providers require unlocked transport dispatch".into())
            }
            Request::UserCommands { .. } => {
                Err("user commands require unlocked transport dispatch".into())
            }
            Request::FirstRun => Err("first run requires unlocked transport dispatch".into()),
            Request::AcpAgents
            | Request::AcpAgentCheck { .. }
            | Request::AcpAgentAdd { .. }
            | Request::AcpAgentLogin { .. } => {
                Err("agent setup requires unlocked transport dispatch".into()) // V2-4b
            }
            Request::AcpAgentSignIn { .. }
            | Request::AcpAgentSignInState { .. }
            | Request::AcpAgentSignInCancel { .. }
            | Request::AcpAgentSignOut { .. } => {
                Err("agent setup requires unlocked transport dispatch".into()) // ticket 358
            }
            Request::ExtensionsList
            | Request::ExtensionsMcpAdd { .. }
            | Request::ExtensionsMcpRemove { .. }
            | Request::ExtensionsItemFiles { .. }
            | Request::ExtensionsItemRead { .. }
            | Request::ExtensionsItemSave { .. }
            | Request::ExtensionsSkillNew { .. }
            | Request::ExtensionsItemRemove { .. }
            => {
                Err("extensions require unlocked transport dispatch".into()) // ticket 276
            }
            Request::ProblemFix { .. } => Err("problem fix requires unlocked transport dispatch".into()), // v2-5b

            Request::Worktree { .. } => Err("worktree requires off-lock preparation".into()),
            Request::SetupStatus { .. } | Request::SetupGrant { .. } => {
                Err("setup requests run off the registry lock".into()) // ticket 259: `worktree_setup::serve`
            }
            Request::AgentSend { id, text } => self.send("user", &id, text, vec![], false),
            Request::AgentPrompt { id, text } => {
                let reply = match self.send("user", &id, text.clone(), vec![], true) {
                    // The owner's words to a session that waits at a question in its terminal (a start question such
                    // as folder trust) are kept, not refused: typed now they would answer the question, so they wait
                    // in the session's queue, go in once it is answered there, and are dropped like any queued send.
                    // The question's own card says which session waits; a session's prompt is still refused.
                    Err(e)
                        if e == "agent_blocked"
                            && (self.queue.items_of(&id).iter())
                                .any(|item| item.kind == queue::Kind::Dialog) =>
                    {
                        Reply::Delivery {
                            send: self.begin_send("user", &id, text.clone(), vec![], true, "queued")?,
                        }
                    }
                    sent => sent?,
                };
                self.told(&id, &text); // ticket 990: a sub-bot's lead learns what the user said to it
                Ok(reply)
            }
            Request::SteerNow { id, text, seen } => {
                let reply = self.steer_now("user", &id, text.clone(), &seen)?;
                self.told(&id, &text); // ticket 990, as AgentPrompt
                Ok(reply)
            }
            Request::AgentKeys { id, keys } => self.agent_keys("user", &id, keys, true),
            Request::Events { .. } => Err("events require socket dispatch".into()), // ticket 573
            Request::AgentGet { id } => {
                let meta = self.entry(&id)?.meta.clone();
                Ok(Reply::Agent {
                    session: self.snapshot_session(&meta),
                })
            }
            Request::AgentRead { id, source, lines } => self.agent_read(&id, &source, lines),
            Request::CancelSend { id, send } => {
                let row = self
                    .entry(&id)?
                    .meta
                    .send_queue
                    .iter()
                    .find(|s| s.id == send)
                    .ok_or("send not found")?;
                if row.status != "queued" {
                    return Err("send is not queued".into());
                }
                self.finish_send(&id, &send, "canceled")?;
                Ok(Reply::Ack)
            }
            // v1b-15, v1b-16; V2.5-35: the owner's and the window's board requests, through the rights check.
            Request::BoardSnapshot
            | Request::BoardSeen { .. }
            | Request::BoardPut { .. }
            | Request::BoardDelete { .. }
            | Request::BoardMove { .. }
            | Request::BoardColumnsPut { .. }
            | Request::BoardSettingsPut { .. } // V2.5-38
            | Request::BoardTaskPut { .. }
            | Request::BoardUndo { .. }
            | Request::BoardDone { .. }
            | Request::BoardAdd { .. }
            | Request::BoardSelf => self.board(crate::board::rights::Writer::Owner, request),
            // v2-9a: one write per edit, on disk before the reply; a refused edit changes nothing.
            // V2.5-15: a path must lie inside a project some session record names.
            Request::ProjectCreate { .. } => {
                Err("project create requires unlocked transport dispatch".into())
            }
            // Ticket 370: each returns at once (the clone runs on its own thread), so under the lock.
            request @ (Request::ProjectClone { .. }
            | Request::ProjectCloneState { .. }
            | Request::ProjectCloneCancel { .. }) => crate::projects::clone::handle(request),
            Request::OpenInEditor { path, line } => crate::projects::open_in_editor(
                &self.home,
                &path,
                line,
                &self.editor_roots(),
                self.settings.feature::<String>("editor.app"),
            ),
            Request::EditorApps => crate::projects::editor_apps(),
            Request::ProjectIconSet { project, data_b64 } => {
                crate::projects::icon_set(&self.home, &project, &data_b64, &self.project_roots())
            }
            Request::ProjectIconGet { project } => crate::projects::icon_get(&self.home, &project),
            Request::ProjectFolders | Request::ProjectLocate { .. } => {
                Err("project folder requests run off the registry lock".into()) // ticket 1040: `locate`
            }
            Request::TreeGet => self.tree.clone().map(|tree| Reply::Tree { tree }),
            Request::TreeEdit { edit } => {
                let known = (!store::kept_aside(&self.home, "sessions.json"))
                    .then(|| project_set(&self.entries));
                let next = self
                    .tree
                    .as_ref()
                    .map_err(Clone::clone)?
                    .edited(&edit, known.as_ref())?;
                next.save(&self.home)?;
                self.tree = Ok(next.clone());
                Ok(Reply::Tree { tree: next })
            }
            Request::Start { .. } => Err("start requires launch preparation".into()),
            Request::List | Request::Snapshot => self.snapshot(),
            // V2.5-30: the owner outside every session has no children of its own.
            Request::AgentList { mine: true } => Err("agent list --mine runs inside a session".into()),
            Request::AgentList { mine: false } => self.snapshot(),
            // Ticket 571: outside every session the sender is the person.
            request @ (Request::RoomSend { .. }
            | Request::RoomReply { .. }
            | Request::RoomCheck { .. }
            | Request::RoomThread { .. }
            | Request::RoomRead { .. }
            | Request::RoomPin { .. }
            | Request::RoomAnswer { .. }) => self.room(None, request),
            // v1b-18: owner only through check_agent's allow-list; writes only board.json.
            Request::BoardResolve {
                identity,
                updated_at,
            } => crate::board::resolve(
                &self.home,
                &self
                    .entries
                    .values()
                    .map(|e| self.snapshot_session(&e.meta))
                    .collect::<Vec<_>>(),
                &identity,
                updated_at,
            ),
            Request::Read { id, after } => read_replay(
                &self.home,
                self.entries.get(&id).ok_or("session not found")?,
                after,
            ),
            Request::SendText {
                id,
                text,
                seen,
                composer,
            } => {
                // v1a-10: Enter or a letter in Claude's open picker would save a default model.
                if self.entry(&id)?.switch.is_some() && text != "\x1b" {
                    return Err("model switch in progress".into());
                }
                // CHAT-MODELIST r2: nothing is typed while a mode walk passes through modes the owner did not pick.
                if self.walk_hold(&id) && text != "\x1b" {
                    return Err(MODE_BUSY.into());
                }
                // Ticket 1130 C-C3: the person's Enter in a lead's own seat is a prompt to the lead (no text kept).
                if text.ends_with('\r') {
                    let meta = &self.entry(&id)?.meta;
                    let (seat, project) = (meta.teammate.clone(), meta.project.clone());
                    if seat.is_some() && self.team_lead_of(&id) == seat {
                        crate::events::owner_prompt(&project, &id);
                    }
                }
                if composer {
                    self.composer_live(&id)?;
                    // Look 11-17 v5 item 1 (rule b): typed into a start question, the text's Enter answers it ("No,
                    // exit" ends Claude). Held as the first prompt is held, and delivered once the input box is back.
                    // Look 1117 v13 N13-S2-3: so is a send while any request waits, seen or not: held, never typed.
                    if self.dialog_on_screen(&id)? {
                        let text = text.replace("\x1b[200~", "").replace("\x1b[201~", "");
                        // As every queued send: a row over the size limit would be written to sessions.json and
                        // refuse the next core start (Codex look).
                        crate::delivery::check_text(self.entry(&id)?.meta.kind, &text)?;
                        self.begin_send("user", &id, text, vec![], true, "queued")?;
                        self.held_enter.insert(id);
                        return Ok(Reply::Ack);
                    }
                    self.key_gate(&id, &seen)?;
                    // Ticket 1085: the core pasted a line here and its Enter waits (a turn runs, or the paste is not
                    // drawn yet). Typed now, the owner's words joined that line and his Enter sent both as one message.
                    // They wait in the queue as above and go alone after it.
                    if self.pending_enter.contains_key(&id) {
                        let text = text.replace("\x1b[200~", "").replace("\x1b[201~", "");
                        crate::delivery::check_text(self.entry(&id)?.meta.kind, &text)?;
                        self.begin_send("user", &id, text, vec![], true, "queued")?;
                        self.held_enter.insert(id);
                        return Ok(Reply::Ack);
                    }
                    // Gap rule: nothing is typed behind text in the agent's box, and a prompt that takes attached
                    // messages is joined with them by the delivery walk: queued as his prompt, as above.
                    let plain = text.replace("\x1b[200~", "").replace("\x1b[201~", "");
                    let words = plain.strip_suffix('\r').unwrap_or(&plain).to_string();
                    if !words.trim().is_empty()
                        && (self.owner_text(&id) || joinable(&words) && self.has_attached(&id))
                    {
                        crate::delivery::check_text(self.entry(&id)?.meta.kind, &words)?;
                        self.begin_send("user", &id, words, vec![], true, "queued")?;
                        if !plain.ends_with('\r') {
                            self.held_enter.insert(id);
                        }
                        return Ok(Reply::Ack);
                    }
                    self.held_enter.remove(&id);
                    self.clear_box_first(&id)?;
                }
                // Ticket 992: only the terminal's own reports (focus, mouse) are no input.
                // Seventh look: nor its answers to an agent's questions (Claude asks for the terminal's name and
                // colours when it starts and xterm.js answers through this request): a device or mode report
                // (`CSI ?` or `CSI >`), a DCS or an OSC string. No key sends one of these.
                let report = text == "\x1b[I"
                    || text == "\x1b[O"
                    || ["\x1b[<", "\x1b[M", "\x1b[?", "\x1b[>", "\x1bP", "\x1b]"]
                        .iter()
                        .any(|start| text.starts_with(start));
                // Look 11-17 v6r B6-S2-1: nor do they edit Claude's input box. A lead's terminal shown for a question
                // sent its focus reports; marked as edited by hand, the box refused every worker's finish line and room
                // notice (`Input::submit`), and the lead heard nothing until the user wrote to it.
                if !report && !composer && !text.ends_with('\r') {
                    self.typing(&id); // gap rule: a key in the terminal is the owner typing there
                }
                // Type in terminal: his keys there keep it on.
                if !report
                    && !composer
                    && let Some(until) = self.direct_until.get_mut(&id)
                {
                    *until = std::time::Instant::now() + DIRECT_QUIET;
                }
                if !report && text.ends_with('\r') {
                    self.owner_submitted(&id); // gap rule: his Enter there releases a Later after its turn
                }
                if !report {
                    self.submitted.remove(&id); // the box holds the user's own words from here
                    self.left_typed.remove(&id); // ticket 1085: so nothing in it is cleared as the core's own
                }
                let uncertain = !report && hand_edits(self.entry(&id)?.meta.kind);
                if uncertain {
                    self.entry(&id)?.input.mark_uncertain();
                }
                // Ticket 1094 r6: what he types into a box that may hold a dropped copy, as plain text; anything else
                // (a control key, a line break inside) leaves the box unprovable.
                if !report && let Some(typed) = self.hand_typed.get_mut(&id) {
                    let plain = text.replace("\x1b[200~", "").replace("\x1b[201~", "");
                    let body = plain.strip_suffix('\r').unwrap_or(&plain);
                    let known = !body.chars().any(char::is_control);
                    // Round 6 (security look): bounded by the largest send row (`delivery::SEND_LIMIT`): a box past it
                    // proves no copy of a row, and the string never grows with chunks that bring no Enter.
                    *typed = typed
                        .take()
                        .filter(|t| known && t.len() + body.len() <= crate::delivery::SEND_LIMIT)
                        .map(|t| t + body);
                }
                // Ticket 1094 r4: read before his Enter goes, while the box still shows what it sends.
                let taken = if text.ends_with('\r') {
                    self.taken_by_hand(&id)
                } else {
                    vec![]
                };
                let before = self.queue.attention(&id);
                // v25-sendkeys: these bytes may have landed partway; the window must not type the text again.
                self.live(&id)?
                    .write(text.as_bytes())
                    .map_err(|error| typed_error(error, uncertain))?;
                if text.ends_with('\r') && hand_edits(self.entry(&id)?.meta.kind) {
                    self.entry(&id)?.input = Default::default();
                }
                if text.ends_with('\r') {
                    self.copy_gone(&id); // r5: his Enter sent the box, the copy with it if it was there
                }
                // Ticket 1094 r6: not delivered yet: only a turn that starts after this Enter proves it went.
                for send in taken {
                    self.hand_sent.insert(
                        id.clone(),
                        (
                            send,
                            before.completion_seq,
                            before.working,
                            queue::now_ms(),
                            std::time::Instant::now(),
                        ),
                    );
                }
                if !report {
                    self.touch_input(&id);
                }
                if composer {
                    // Without the paste marks the window wraps a prompt in (seen in the real app's room line).
                    self.composed.insert(
                        id,
                        text.replace("\x1b[200~", "").replace("\x1b[201~", ""),
                    );
                }
                Ok(Reply::Ack)
            }
            Request::SendKeys {
                id,
                keys,
                seen,
                composer,
            } => {
                self.touch_input(&id); // ticket 992: Up can recall an old prompt into the box
                self.submitted.remove(&id); // N1: a key of the user's (Stop puts a stopped prompt back in the box)
                // CHAT-PERMCHIP r2: Shift+Tab changes a mode, so even the owner's raw keys take the one gate.
                if keys.iter().any(|k| k.eq_ignore_ascii_case("shift+tab")) {
                    return self.agent_keys("user", &id, keys, true);
                }
                // v1a-10: see SendText.
                if self.entry(&id)?.switch.is_some()
                    && !matches!(keys.as_slice(), [k] if k.eq_ignore_ascii_case("esc"))
                {
                    return Err("model switch in progress".into());
                }
                if self.walk_hold(&id)
                    && !matches!(keys.as_slice(), [k] if k.eq_ignore_ascii_case("esc"))
                {
                    return Err(MODE_BUSY.into());
                }
                let mut data = Vec::new();
                for key in &keys {
                    data.extend(key_bytes(key)?);
                }
                // ticket 115: Stop is a lone Esc; one sent before a dialog's snapshot would answer that dialog (deny).
                if has_bare_esc(&keys)? && self.entry(&id)?.switch.is_none() {
                    self.key_gate(&id, &seen)?;
                }
                // ticket 123: the composer's follow-up Enter takes the same gate; the flag never widens past one Enter.
                if composer {
                    self.composer_live(&id)?;
                    if data != b"\r" {
                        return Err("composer gate: only a single enter".into());
                    }
                    // Look 11-17 v5 item 1: the Enter of a text the core queued goes with it; none answers a question.
                    if self.held_enter.remove(&id) {
                        return Ok(Reply::Ack);
                    }
                    if let Err(reason) = self.key_gate(&id, &seen) {
                        let entry = self.entry(&id)?;
                        // A stale screen cannot prove Ctrl+U will miss a dialog.
                        if entry.observer.behind
                            || entry.observer.screen.detect(entry.meta.kind).is_some()
                        {
                            return Err(format!(
                                "{reason}; current line not cleared: a dialog is focused or the screen is not current"
                            ));
                        }
                        // A hook can queue a request before its dialog draws; it may draw after this screen check.
                        self.live(&id)?.write(b"\x15").map_err(|error| {
                            format!("{reason}; current line could not be cleared: {error}")
                        })?;
                        // Ctrl+U clears only the cursor line, so earlier pasted lines can remain.
                        self.entry(&id)?.input.mark_uncertain();
                        return Err(format!("{reason}; current line cleared"));
                    }
                    // After the key gate, which clears a line typed before an unseen request (N13-S2-3: on Claude's
                    // permission prompt this Enter would pick its first option).
                    if self.dialog_on_screen(&id)? {
                        return Err("agent_blocked: a question is on the screen; answer it first".into());
                    }
                }
                let uncertain = hand_edits(self.entry(&id)?.meta.kind);
                if uncertain {
                    self.entry(&id)?.input.mark_uncertain();
                }
                // Ticket 1094 r6: a key other than Enter (an arrow, a backspace) changes the box in ways not followed.
                if data != b"\r"
                    && let Some(typed) = self.hand_typed.get_mut(&id)
                {
                    *typed = None;
                }
                // Ticket 1094 r4: see SendText.
                let taken = if data.ends_with(b"\r") {
                    self.taken_by_hand(&id)
                } else {
                    vec![]
                };
                let before = self.queue.attention(&id);
                // v25-sendkeys: see SendText.
                self.live(&id)?.write(&data).map_err(|error| typed_error(error, uncertain))?;
                if interrupt_key(&keys) {
                    self.interrupted(&id)?;
                }
                if data.ends_with(b"\r") && hand_edits(self.entry(&id)?.meta.kind) {
                    self.entry(&id)?.input = Default::default();
                }
                if data.ends_with(b"\r") {
                    self.copy_gone(&id); // r5: his Enter sent the box, the copy with it if it was there
                }
                // Ticket 1094 r6: not delivered yet: only a turn that starts after this Enter proves it went.
                for send in taken {
                    self.hand_sent.insert(
                        id.clone(),
                        (
                            send,
                            before.completion_seq,
                            before.working,
                            queue::now_ms(),
                            std::time::Instant::now(),
                        ),
                    );
                }
                if data.ends_with(b"\r") {
                    self.owner_submitted(&id); // gap rule: his Enter releases a Later after its turn
                }
                // Ticket 990: the composer's Enter sends what it typed: a sub-bot's lead learns it in one line.
                if composer && let Some(text) = self.composed.remove(&id) {
                    self.submitted(&id, &text);
                    self.told(&id, &text);
                }
                Ok(Reply::Ack)
            }
            Request::Resize { id, cols, rows } => {
                self.resize_pty(&id, cols, rows)?;
                // Ticket 991 A11: the next PTY opens at it. aS2-1: kept on disk, so a shell the CLI starts before
                // the window (also after a core restart) builds its prompt at the window's width.
                if self.window_size != Some((cols, rows)) {
                    self.window_size = Some((cols, rows));
                    let _ = store::atomic_write(
                        &self.home.join(WINDOW_SIZE),
                        format!("{cols} {rows}\n").as_bytes(),
                    );
                }
                self.queue.resized(&id, queue::now_ms()); // v1a-71; v1a-75: only the owner and the window reach here
                Ok(Reply::Ack)
            }
            Request::Label { id, label } => {
                if label.len() > 256 {
                    return Err("label exceeds 256 bytes".into());
                }
                let entry = self.entry(&id)?;
                let old = std::mem::replace(&mut entry.meta.label, label);
                let auto = std::mem::take(&mut entry.meta.auto_label); // ticket 1017: the user named it
                if let Err(e) = self.save() {
                    let meta = &mut self.entry(&id)?.meta;
                    meta.label = old;
                    meta.auto_label = auto;
                    return Err(e);
                }
                Ok(Reply::Ack)
            }
            Request::Close { id } | Request::SessionTidy { id, .. } => self.close(&id, true, false),
            Request::CloseUndo { id } => self.close_undo(&id, close_clock()),
            Request::CloseIdle { id } => {
                let a = self.queue.attention(&id);
                if a.working || a.waiting || !self.entry(&id)?.meta.send_queue.is_empty() {
                    return Err(format!("{id} is busy: not closed"));
                }
                self.close(&id, true, false)
            }
            Request::LimitResume { id, on } => self.limit_resume(&id, on, queue::now_ms() as i64 / 1000), // ticket 372
            Request::Typing { id } => {
                self.entry(&id)?;
                self.typing(&id);
                Ok(Reply::Ack)
            }
            Request::SendNow { id, send } => self.knock_choice(&id, &send, Knock::Now),
            Request::SendLater { id, send } => self.knock_choice(&id, &send, Knock::Later),
            Request::SendAttach { id, send } => self.knock_choice(&id, &send, Knock::Attach),
            Request::SendDetach { id, send } => self.knock_choice(&id, &send, Knock::Detach),
            Request::Direct { id, on } => {
                self.entry(&id)?;
                if on {
                    self.direct_until
                        .insert(id, std::time::Instant::now() + DIRECT_QUIET);
                } else if self.direct_until.remove(&id).is_some() {
                    self.home_ask.insert(id); // what he left in the box comes home once he stops
                }
                Ok(Reply::Ack)
            }
            Request::DraftTaken { id, at } => self.draft_taken(&id, at),
            Request::DraftPutBack { id, words } => self.draft_put_back(&id, words),
            // Ticket 990: the server serves it before this point (the start runs off the registry lock).
            Request::TeamOpen { .. } => Err("team open is for a lead's session".into()),
            Request::Task { .. } => Err("task requests run off the registry lock".into()), // `ledger::serve`
            Request::Note { .. } => Err("note requests run off the registry lock".into()), // `notes::serve`
            Request::Role { .. } => Err("role requests run off the registry lock".into()), // `roles::serve`
            // V2.5-11: owner only (check_agent, server's remote list, the browser role's allowlist).
            Request::ScheduleList => self.schedules.shown().map(|schedules| Reply::Schedules { schedules }),
            Request::ScheduleAdd { run, at, daily, replace, days } => {
                let now = crate::queue::now_ms();
                let known = self.known_projects();
                self.schedules.add_on(
                    run,
                    crate::schedule::When { at, daily, days },
                    replace.as_deref(),
                    &known,
                    now,
                    &crate::usage::local_offset,
                )?;
                self.schedules_changed();
                self.schedules.shown().map(|schedules| Reply::Schedules { schedules })
            }
            Request::ScheduleRemove { id } => {
                self.schedules.remove(&id)?;
                self.schedules_changed();
                self.schedules.shown().map(|schedules| Reply::Schedules { schedules })
            }
            // Ticket 993
            Request::SchedulePause { id, paused } => {
                self.schedules.pause(&id, paused, crate::queue::now_ms(), &crate::usage::local_offset)?;
                if paused {
                    self.drop_failed_card(&id);
                }
                self.schedules_changed();
                self.schedules.shown().map(|schedules| Reply::Schedules { schedules })
            }
            // The run starts a session off the registry lock (`schedule::run_now`; server.rs, http/mod.rs).
            Request::ScheduleRunNow { .. } => Err("run now runs off the registry lock".into()),
            // A proposal is a lead's ask for the owner's card; the owner needs none.
            Request::SchedulePropose { .. } | Request::ScheduleChange { .. } => Err(
                "a schedule is proposed from a lead's session; the user adds and changes one in the Schedules widget"
                    .into(),
            ),
            // An offer is a bot's ask for the owner's card; the owner needs none.
            Request::BotOffer { .. } => {
                Err("a bot is offered from a bot's session; the user makes one in the Bots view".into())
            }
            // Ticket 1002 lane 2: the user writes their own mail; a card is the Home lead's ask, spent by its seat.
            Request::OutboxStage { .. } | Request::OutboxSpend { .. } => {
                Err("an Outbox card is staged and sent from the Home lead's session".into())
            }
            // Ticket 1036: the status line's `rate_limits` (hook.rs `statusline`), kept for the session's account only;
            // not an event of the session's state, so the queue never sees it.
            Request::Hook { id, event, payload } if event == "StatusLine" => {
                let entry = self.entry(&id)?;
                if entry.meta.kind == AgentKind::Claude {
                    let now = queue::now_ms() as i64 / 1000;
                    let dir = entry.meta.config_dir.clone();
                    // Ticket 1126: the moment a weekly share changes, so the card shows without waiting for a start.
                    if crate::usage::observe_status(&self.home, dir.as_deref(), &payload["rate_limits"], now) {
                        let (home, weekly) = (self.home.clone(), crate::account_near::claude_weekly(&self.home));
                        crate::account_near::check(self, &home, crate::accounts::Agent::Claude, &weekly, now);
                    }
                    crate::session_context::observe(&id, &payload["context_window"]); // ticket 1048
                }
                Ok(Reply::Ack)
            }
            Request::Hook { id, event, payload } => {
                let entry = self.entry(&id)?;
                if !entry.agent_live() {
                    return Err("hook session is not running".into());
                }
                // Ticket 501: the agent is working, so a transcript not found yet may exist now.
                entry.observer.search_soon(std::time::Instant::now());
                if let (Some(event_id), Some(created)) = (
                    payload["nunchiro_event_id"].as_str(),
                    payload["nunchiro_created"].as_u64(),
                ) {
                    self.queue.replay(&queue::journal::Event {
                        version: 1,
                        event_id: event_id.into(),
                        session_id: id.clone(),
                        event: event.clone(),
                        payload: payload.clone(),
                        created,
                    })?;
                } else {
                    self.queue
                        .observe(&id, &event, &payload, "hook", queue::now_ms())?;
                }
                // Look 11-17 v3 P1: hooks run only after the startup questions; the start is over.
                // Look 11-17 v8 N1: not SessionStart. Claude 2.1.327 fires it before it draws its input box (and, on a
                // slow start, before it reads keys at all): the window sent its held first message at that moment.
                if event != "SessionStart" {
                    let entry = self.entry(&id)?;
                    entry.observer.before_box = false;
                    entry.observer.screen.mark_started(); // start dialogs make no card from here
                }
                // Peer item 2 (ticket 991): an unnamed agent session takes its title from its first prompt; a name the
                // user gave (any label) is never replaced.
                if event == "UserPromptSubmit"
                    && payload["agent_id"].as_str().is_none_or(str::is_empty)
                    && let Some(title) = payload["prompt"].as_str().and_then(auto_title)
                {
                    let entry = self.entry(&id)?;
                    if entry.meta.label.is_empty()
                        && !entry.meta.side_chat
                        && entry.meta.kind != AgentKind::Shell
                    {
                        entry.meta.label = title;
                        entry.meta.auto_label = true; // ticket 1017
                        self.title_names_branch(&id);
                        self.save()?;
                    }
                }
                if event == "SessionStart" {
                    let entry = self.entry(&id)?;
                    if !entry.agent_live() {
                        return Err("hook session is not running".into());
                    }
                    if let Some(agent_id) = payload
                        .get("session_id")
                        .or_else(|| payload.get("thread_id"))
                        .and_then(|v| v.as_str())
                    {
                        if !store::valid_id(agent_id) {
                            return Err("invalid agent session id".into());
                        }
                        if entry.meta.kind == AgentKind::Claude
                            && entry.meta.agent_session_id.as_deref() != Some(agent_id)
                        {
                            return Err("Claude session id changed".into());
                        }
                        entry.meta.agent_session_id = Some(agent_id.into());
                        self.save()?;
                    }
                }
                if payload["agent_id"].as_str().is_none_or(str::is_empty)
                    && let Some(path) = payload["transcript_path"].as_str()
                {
                    let entry = self.entry(&id)?;
                    entry.observer.transcript = Some(waiting::transcript::validate_path(
                        &entry.meta,
                        Path::new(path),
                    )?);
                }
                self.outbox_sent(&id, &event, &payload);
                // Ticket 571: unread room messages reach a long Claude turn as one context line; a subagent's tool
                // call (non-empty `agent_id`) neither gets it nor uses up the batch.
                match (event == "PostToolUse" && payload["agent_id"].as_str().is_none_or(str::is_empty))
                    .then(|| self.room_context(&id))
                    .flatten()
                {
                    Some(decision) => Ok(Reply::HookDecision {
                        decision: Some(decision),
                    }),
                    None => Ok(Reply::Ack),
                }
            }
            Request::QueueConnect => {
                self.queue.connect(queue::now_ms());
                Ok(Reply::Ack)
            }
            Request::Answer {
                item,
                answer,
                confirmed,
            } => self.answer(&item, answer, confirmed),
            Request::Stop => {
                self.stop()?;
                Ok(Reply::Ack)
            }
            Request::Exit => {
                self.leave()?;
                Ok(Reply::Ack)
            }
            // F24: checked and acted on in one hold of the registry lock, so nothing starts in between.
            Request::ExitIfIdle { holder_floor } => {
                if self.exit_blockers(holder_floor) > 0 {
                    return Err(crate::server::EXIT_BUSY.into());
                }
                self.leave()?;
                Ok(Reply::Ack)
            }
            Request::ExitBlockers { holder_floor } => Ok(Reply::ExitBlockers {
                count: self.exit_blockers(holder_floor),
            }),
            // v1b-17: new requests remain owner-only through check_agent's allow-list.
            Request::BoardSourceStatus { name } => Ok(Reply::ApprovalStatus {
                view: crate::approval::source_status(&self.home, &name)?,
            }),
            Request::BoardSourceGrant { name, level, hash } => {
                self.approve(crate::approval::SubjectKind::Source, &name, level, &hash)
            }
            Request::BoardSourceMove { name, id, column } => {
                crate::board::sources::move_card(&self.home, &name, &id, &column)?;
                Ok(Reply::Ack)
            }
            // v1b-08
            Request::FilesList { .. }
            | Request::FileRead { .. }
            | Request::FileWrite { .. }
            | Request::FilesSearch { .. } => {
                Err("files requests run outside the registry lock".into())
            }
            // V2-4a: owner only (`check_agent` refuses every session caller).
            Request::AcpAgentStatus { name } => Ok(Reply::AcpAgent {
                view: crate::approval::agent_status(&self.home, &name)?,
            }),
            Request::AcpAgentGrant { name, hash } => Ok(Reply::AcpAgent {
                view: crate::approval::grant_agent(&self.home, &name, &hash)?,
            }),
            // v1b-14
            Request::ApprovalStatus { name } => Ok(Reply::ApprovalStatus {
                view: crate::approval::status(&self.home, &name)?,
            }),
            Request::ApprovalGrant { name, level, hash } => {
                self.approve(crate::approval::SubjectKind::Widget, &name, level, &hash)
            }
            // v1a-23: session callers asking `on` were turned into a waiting item before this (`ask_owner`).
            Request::PermissionAnswers { project, on } => self.permission_answers(&project, on),
            // v1a-09
            Request::QuitSettings { patch } => self.quit_settings(patch),
            // v1b-11
            Request::DiffList { .. } | Request::DiffFile { .. } => {
                Err("diff requests run outside the registry lock".into())
            }
            // v1a-07b: served by the window through the server (http::layout::forward).
            Request::Layout { .. } => Err("layout commands need the window".into()),
            // v1b-19: owner dispatch runs these outside the registry lock (widgets::handle).
            Request::WidgetList
            | Request::WidgetRun { .. }
            | Request::WidgetAct { .. } /* v1b-20 */
            | Request::WidgetPage { .. } /* v1b-22 */ => {
                Err("widget requests run outside the registry lock".into())
            }
            // v1b-05
            Request::ImagePut { .. } => Err("image uploads run outside the registry lock".into()),
            // CHAT-MODELIST: the window's mode list; the owner path only (see `check_agent`).
            Request::SetMode { id, mode } => self.set_mode("user", &id, &mode),
            // Ticket 362: owner only (`check_agent`, the browser's list).
            Request::AgentPermissionGet => Ok(self.agent_permissions()),
            Request::AgentPermissionSet { agent, choice } => {
                self.set_agent_permission(agent, choice)
            }
            // Ticket 358: owner only (`check_agent`, the browser's list, never forwarded). The grant and reset run here so
            // `approvals.json` keeps one writer and a start re-reading under this lock sees a whole change.
            Request::AgentCommandStatus { agent } => Ok(Reply::AgentCommand {
                view: crate::approval::command_status(&self.home, agent)?,
            }),
            Request::AgentCommandCheck { .. } => {
                Err("agent command check requires unlocked transport dispatch".into())
            }
            Request::AgentCommandGrant { agent, hash } => Ok(Reply::AgentCommand {
                view: crate::approval::command_grant(&self.home, agent, &hash)?,
            }),
            Request::AgentCommandReset { agent, draft_only } => Ok(Reply::AgentCommand {
                view: crate::approval::command_reset(&self.home, agent, draft_only)?,
            }),
            // v1a-10
            Request::SwitchModel { id, ultracode: Some(on), .. } => self.ultracode_toggle(&id, on),
            Request::SwitchModel { id, fast: Some(on), .. } => self.fast_restart(&id, on),
            Request::SwitchModel { id, model, effort, .. } => {
                let result = self.switch_model(&id, model.clone(), effort.clone());
                if let Err(error) = &result {
                    switch_log(&id, None, &model, &effort, &format!("refused: {error}"));
                }
                result
            }
        }
    }
    pub(crate) fn tick(&mut self) -> Result<(), String> {
        // Look v16 Home: the server's loop can tick once after a Stop (it waited on the lock the Stop held). That tick
        // saw the sessions the Stop ended as ended mid-run and stored "the session ended before the task was done", so
        // the next start never said "interrupted when the app closed". After a Stop nothing is observed.
        if self.stopped() {
            return Ok(());
        }
        self.finish_close(close_clock()); // V2-6d
        self.expire_outbox(queue::now_ms()); // ticket 1002 lane 2
        self.loops_overdue(queue::now_ms()); // ticket 1003
        // w10 item 12: a start question the core answers is read again each second, output or not.
        // N12-S2-3: so is a box shown after an interrupt, until it has stayed long enough to end the turn.
        for entry in self.entries.values_mut() {
            if entry.observer.at_box.is_some() {
                entry.observer.recheck = true;
            }
            if entry.observer.own_folder.is_some()
                && entry
                    .observer
                    .own_folder_since
                    .is_some_and(|t| t.elapsed() >= std::time::Duration::from_secs(1))
            {
                entry.observer.recheck = true;
            }
        }
        // Seventh look (B S1-1): a resize blanks the screen model and the agent's redraw fills it again. An agent that
        // draws nothing in the redraw's time (the size it was told is the size it had, a resize there and back it saw
        // as one, a holder that answered late) leaves the terminal showing what it showed, while the model stayed
        // blank: the next few bytes (the agent's answer to a focus report) were read as "no question", the card went
        // and every later re-read read the same blank screen. The old screen comes back at the new size.
        for (id, entry) in self.entries.iter_mut() {
            if entry.restore_undrawn() {
                // V2-1b: the old screen is no fresh output, so it never proves a restored item again (a new id,
                // answerable). After a restart the window's first fit is such a resize: the size the agent already had.
                if self.queue.items_of(id).iter().any(|i| i.reconciled) {
                    entry.observer.recheck = false;
                } else {
                    self.queue.undrawn(id, queue::now_ms());
                }
            }
        }
        // Look 11-17 v5 item 1 (rule b): a question the screen still shows but no card holds (a card cleared by an event,
        // a frame read half-drawn) is read again each second: the screen is fed only on new output, and a waiting
        // dialog draws none, so it would read as an idle row for ever and the composer would type into it.
        for (id, entry) in self.entries.iter_mut() {
            if entry.meta.state != SessionState::Running
                || entry.agent_ended
                || entry.switch.is_some()
                || entry.observer.own_folder_since.is_some()
                || !matches!(entry.meta.kind, AgentKind::Claude | AgentKind::Codex)
                || entry
                    .observer
                    .reread
                    .is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(1))
            {
                continue;
            }
            entry.observer.reread = Some(std::time::Instant::now());
            // Seventh look (B S2-1): mid-turn too. A permission prompt stands on a still screen while its turn "works";
            // a card an event took from it never came back and the lead waited there unseen. Only once the screen has
            // been still for a second: a prompt just answered through its hook is redrawn sooner than that, and is
            // not made a card again in between.
            let a = self.queue.attention(id);
            if (!a.working || queue::now_ms().saturating_sub(a.last_activity) >= REREAD_STILL_MS)
                && !crate::delivery::blocked(&self.queue.items_of(id))
                && entry
                    .observer
                    .screen
                    .detect(entry.meta.kind)
                    .is_some_and(|d| d.kind != queue::Kind::Background)
            {
                entry.observer.recheck = true;
            }
        }
        self.settle_idle()?;
        // Ticket 999: one save for the whole pass, made before the tick goes on, also when the pass failed half way (its
        // first read was saved at once before). A send is still saved "attempting" before its bytes are written.
        let pass = self.delivery_pass();
        let saved = self.save_unsaved();
        pass.and(saved)?;
        self.fire_resumes(queue::now_ms() as i64 / 1000); // ticket 372
        self.observe_events(); // ticket 573
        self.wake_parents(); // ticket 159
        self.room_notices(); // ticket 571
        self.advance_walks(); // CHAT-MODELIST
        self.advance_typed();
        self.advance_switches() // v1a-10
    }
    /// `finish_send` without its save, for a caller that saves once after many rows (ticket 300).
    fn mark_send(&mut self, id: &str, send: &str, status: &str) -> Result<(), String> {
        if status == "attempting" {
            // Ticket 992: the queued prompt goes into the box now. Not at "delivered": by then its turn may run, and
            // the mark would ask for one finished turn too many.
            self.touch_input(id);
        }
        let attention = self.queue.attention(id);
        let meta = &mut self.entries.get_mut(id).ok_or("session not found")?.meta;
        let index = meta
            .send_queue
            .iter()
            .position(|s| s.id == send)
            .ok_or("send not found")?;
        if !matches!(status, "queued" | "attempting") {
            let row = meta.send_queue.remove(index);
            let agent = row.sender != "user";
            let owner_sent = !agent && row.submit && status == "delivered";
            retire_send(meta, &mut self.widget_hashes, row, status);
            // Ticket 1089: the room shows when a seat's line reached this seat. The time goes to the room's
            // cursors.json, never onto the send row: an older core refuses a store with a key it does not know.
            if agent
                && status == "delivered"
                && let Some(room) = self.room_project(id)
                && let Err(e) =
                    crate::room::Log::open(&self.home, &room).reached(&[send.to_string()])
            {
                eprintln!("delivery time not kept in the room: {e}");
            }
            // Ticket 1056: the wake lines joined into this row went, failed or were canceled with it.
            for joined in self.joined_rows.remove(send).unwrap_or_default() {
                if self.entries[id]
                    .meta
                    .send_queue
                    .iter()
                    .any(|s| s.id == joined)
                {
                    self.mark_send(id, &joined, status)?;
                }
            }
            if owner_sent {
                self.owner_submitted(id); // gap rule: a Later goes after the turn this prompt starts
            }
            return Ok(());
        }
        let row = &mut meta.send_queue[index];
        if status == "attempting" {
            row.completion_seq = attention.completion_seq;
            row.last_activity = attention.last_activity;
        }
        row.status = status.into();
        Ok(())
    }
    /// Ticket 300: an ended session's queued sends, canceled in queue order through `retire_send`, as `mark_send`
    /// retires one. This cancel walks this session's queue and no other. The caller saves once for the pass.
    fn cancel_own_queue(&mut self, id: &str) -> Result<(), String> {
        let meta = &mut self.entries.get_mut(id).ok_or("session not found")?.meta;
        #[cfg(test)]
        self.exit_walked
            .fetch_add(meta.send_queue.len(), std::sync::atomic::Ordering::SeqCst);
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut meta.send_queue)
            .into_iter()
            .partition(|s| s.status == "queued");
        meta.send_queue = kept;
        for send in gone {
            retire_send(meta, &mut self.widget_hashes, send, "canceled");
        }
        Ok(())
    }
    /// V2-6d phase 1: the row leaves `entries` (snapshot, search, tokens) and sessions.json at once, so a core that
    /// ends inside the window finishes the close on its next start (`open` sweeps files no row owns). Its files and
    /// queue state stay until `finish_close`. One at a time: an earlier pending close ends now.
    fn close_later(&mut self, id: &str, owner: bool) -> Response {
        self.finish_close(u64::MAX);
        // Its token stays unusable: callers and hooks are found in `entries` only, and only a running row's token
        // is accepted there. The hash is kept so an Undo writes back the same record.
        let entry = self.entries.remove(id).ok_or("session not found")?;
        let until = close_clock() + CLOSE_UNDO_MS;
        self.closing = Some(Closing {
            entry,
            until,
            owner,
        });
        if let Err(e) = self.save() {
            let closing = self.closing.take().unwrap();
            self.entries.insert(id.to_string(), closing.entry);
            return Err(e);
        }
        Ok(Reply::Ack)
    }
    /// V2-6d phase 2: once `now` reaches its deadline, the pending close runs as Close always did, then the record
    /// goes. The tick calls it with core time; tests pass their own.
    pub(crate) fn finish_close(&mut self, now: u64) {
        let Some(Closing { entry, owner, .. }) = self.closing.take_if(|c| now >= c.until) else {
            return;
        };
        let id = entry.meta.id.clone();
        self.entries.insert(id.clone(), entry);
        // A close that fails (a holder that will not stop) keeps its row, shown again with its error logged, as before.
        // One save for the whole phase: phase 1 already saved the store without this row, so it never holds the id as
        // Closed, and a crash before the save leaves no row (the next `open` sweeps its files).
        self.close_and_drop(&id, owner);
        if let Err(e) = self.save() {
            eprintln!("close {id}: record not saved: {e}");
        }
    }
    /// Close as `finish_close` runs it, unsaved: the row goes unless a token needs it kept.
    fn close_and_drop(&mut self, id: &str, owner: bool) {
        if let Err(e) = self.close_unsaved(id, owner) {
            eprintln!("close {id}: {e}");
        } else if self.token_origin(&self.entries[id].meta).is_none() {
            // Ticket 621 round 3: a token row stays, Closed, so a later resume of its conversation keeps the token's limits.
            self.entries.remove(id);
            self.closed_views.retain(|other| other != id);
            if let Err(e) = self.queue.retain_sessions(|other| other != id) {
                eprintln!("close {id}: queue state not dropped: {e}"); // ticket 750
            }
        }
    }
    /// V2-6d: puts the pending row back as it was; refused once its window has passed.
    fn close_undo(&mut self, id: &str, now: u64) -> Response {
        self.finish_close(now);
        // A conversation resumed meanwhile owns the id now: bringing this row back would give two rows one id.
        if let Some(closing) = self.closing.as_ref().filter(|c| c.entry.meta.id == id)
            && let Some(conversation) = closing.entry.meta.agent_session_id.as_ref()
            && self
                .entries
                .values()
                .any(|e| e.meta.agent_session_id.as_ref() == Some(conversation))
        {
            return Err("this session was resumed meanwhile; it can no longer be undone".into());
        }
        let Some(closing) = self.closing.take_if(|c| c.entry.meta.id == id) else {
            return Err("this close can no longer be undone".into());
        };
        self.entries.insert(id.to_string(), closing.entry);
        if let Err(e) = self.save() {
            let entry = self.entries.remove(id).unwrap();
            self.closing = Some(Closing { entry, ..closing });
            return Err(e);
        }
        Ok(Reply::Ack)
    }
    fn close_now(&mut self, id: &str, owner: bool) -> Response {
        self.close_unsaved(id, owner)?;
        self.save()?;
        Ok(Reply::Ack)
    }
    /// `close_now` without its final save, for `finish_close`, which removes the row before it saves.
    fn close_unsaved(&mut self, id: &str, owner: bool) -> Response {
        let entry = self.entry(id)?;
        if let Some(stale) = entry.stale.as_ref() {
            if !stop_stale(stale, owner) {
                return Err("session holder did not answer; the agent still runs".into());
            }
            entry.stale = None;
        }
        if let Some(pty) = entry.pty.as_mut()
            && let Err(e) = pty.stop()
        {
            let (pid, started, record) = (pty.pid(), pty.agent_started(), pty.holder().clone());
            if !(owner && pty.agent_running() && end_group(pid, started, &record)) {
                return Err(e);
            }
        }
        // V2-4a
        if let Some(mut acp) = entry.acp.take() {
            acp.stop();
        }
        close_queue(&mut self.queue, id, false);
        let home = self.home.clone();
        let entry = self.entry(id)?;
        if let Some(token) = &entry.token {
            crate::logs::unregister(token); // v2-13a: a closed session's token is not live
        }
        // v1a-68 r3 (needs 78): a shell's read-only view is its replay, kept in memory only (from the PTY, or
        // the copy read at `open`); an agent's view is its transcript.
        let view = match &entry.pty {
            _ if entry.meta.kind != AgentKind::Shell => None,
            Some(pty) => Some(crate::pty::Saved::new(pty.snapshot())),
            // A restored row the preload skipped is read now, before its file goes.
            None => {
                entry.saved.get_or_init(|| load_saved(&home, id));
                entry.saved.take().flatten()
            }
        };
        let kept = view.is_some();
        entry.pty = None;
        entry.token_hash = None; // V2-1b: revoked
        entry.saved = view.into(); // v1a-40: never read back from disk after Close
        entry.meta.pid = None;
        entry.meta.state = SessionState::Closed;
        entry.meta.closed_at = Some(queue::now_ms()); // ticket 621
        entry.meta.holder_status = None;
        entry.meta.problem = None; // v2-5b
        if kept {
            // Closing a closed shell again moves it to the newest place, never a second one.
            self.closed_views.retain(|other| other != id);
            self.closed_views.push_back(id.to_string());
            while self.closed_views.len() > CLOSED_VIEWS {
                let oldest = self.closed_views.pop_front().unwrap();
                if let Some(entry) = self.entries.get_mut(&oldest) {
                    entry.saved = None.into();
                }
            }
        }
        remove_hooks(&self.home, id)?;
        self.forget_write(id);
        // v1a-40: logged, not fatal, so a stuck file never leaves the session half closed.
        if let Err(e) = crate::scrollback::remove(&self.home, id) {
            eprintln!("scrollback remove {id}: {e}");
        }
        // v1a-38b: the exported copy goes with it.
        if let Err(e) = crate::scrollback_edit::remove(&self.home, id) {
            eprintln!("export remove {id}: {e}");
        }
        // v2-13a: and its log.
        if let Err(e) = crate::logs::remove_session(&self.home, id) {
            eprintln!("session log remove {id}: {e}");
        }
        self.drop_closed();
        Ok(Reply::Ack)
    }
}
/// v1a-68 r3 (needs 2, 78): the closed shells whose view the core holds, at most `REPLAY_BYTES` each (16 MiB).
const CLOSED_VIEWS: usize = 16;
use crate::agent_permission::{ALLOW_SKIP, START_IN_SKIP};
/// A send that reached a final status, taken out of `meta`'s queue by the caller, goes to the same session's log and
/// its widget hash is dropped (v1b-20). The one retire step of `mark_send` and the exit cancel (ticket 300).
fn retire_send(
    meta: &mut Session,
    widget_hashes: &mut BTreeMap<String, String>,
    mut send: crate::delivery::Send,
    status: &str,
) {
    send.status = status.into();
    widget_hashes.remove(&send.id);
    meta.send_log.push(send);
    cap_log(&mut meta.send_log);
}

#[cfg(test)]
mod tests; // 2026-11-20: moved out for the 1 MiB publish scan

#[cfg(test)]
type BeforeDecide = Box<dyn FnOnce(&std::sync::Mutex<Sessions>)>;
/// Ticket 32: the fake `claude` and `codex` unit tests run, set once (`agent_program`).
#[cfg(test)]
static FAKE_AGENTS: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
#[cfg(test)]
thread_local! {
    // Ticket 32: runs at the start of `Launch::prepare` on the thread that prepares.
    static IN_PREPARE: std::cell::Cell<Option<Box<dyn FnOnce()>>> = const { std::cell::Cell::new(None) };
    static IN_HOOKS_CHECK: std::cell::Cell<Option<Box<dyn FnOnce() -> bool>>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
thread_local! {
    // Ticket 39: runs in `handoff_send` between the first decision (and prepare) and the lock that decides again.
    static BEFORE_DECIDE: std::cell::Cell<Option<BeforeDecide>> = const { std::cell::Cell::new(None) };
}
