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

/// v25-sendkeys: a PTY write that failed after Claude's input was marked uncertain may have landed partway, so the
/// window must not type it again; any other write failure is a plain refusal.
fn typed_error(error: String, uncertain: bool) -> String {
    if uncertain {
        crate::delivery::UNCERTAIN.into()
    } else {
        error
    }
}

/// Stop this alias' master off the registry lock, then persist removal under it.
pub(crate) fn forget_machine(registry: &std::sync::Mutex<Sessions>, alias: &str) -> Response {
    crate::machines::valid_alias(alias)?;
    {
        let mut s = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        s.check_machine_forget(alias)?;
        if !s.remote.forgetting.insert(alias.into()) {
            return Err("machine is already being forgotten".into());
        }
        if let Some(cancel) = s.remote.cancel.get(alias) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let mut s = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        if !s.remote.refreshing.contains(alias) {
            let result = s.forget_machine(alias);
            s.remote.forgetting.remove(alias);
            return result;
        }
        if std::time::Instant::now() >= until {
            s.remote.forgetting.remove(alias);
            return Err("machine channel is still closing; retry removal".into());
        }
        drop(s);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
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
    switch_hooks: Option<(switch_hooks::Key, bool)>, // Q9 en-b-J7-2: read off the lock
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
/// Look v20 S2: a prompt for a box that holds words another send typed and nobody submitted. Nothing was written.
pub(crate) const UNSENT_WORDS: &str = "refused: the input box holds words typed without Enter (send-keys enter submits them); nothing was typed";
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
    /// Ticket 1083: a core that treats `user_home` as the user's home (tests give a temp folder; the default
    /// worktrees folder is `<user home>/nunchiro/worktrees`).
    pub fn with_user_home(mut self, user_home: &Path) -> Self {
        self.settings.user_home = user_home.to_path_buf();
        self
    }
    pub fn open(home: &Path) -> Result<Self, String> {
        crate::sandbox::sweep(home); // v1b-21 r2: runs a dead core left
        let (mut rows, live, token_conversations, origins_lost) = store::load_all(home)?;
        // Ticket 358: a crash between a rename's two saves left these on the old name; the registry's wins.
        let names = crate::accounts::labels_by_folder(home);
        for meta in &mut rows {
            if let Some(label) = meta.config_dir.as_ref().and_then(|f| names.get(f)) {
                meta.account = Some(label.clone());
            }
        }
        let entries: BTreeMap<String, Entry> = rows
            .into_iter()
            .map(|meta| {
                (
                    meta.id.clone(),
                    Entry {
                        meta,
                        pty: None,
                        pty_size: None,
                        token: None,
                        token_hash: None, // V2-1b
                        stale: None,      // V2-1b
                        observer: waiting::Observer::default(),
                        input: crate::delivery::Input::default(),
                        // v1a-10
                        switch: None,
                        walk: None,
                        walk_error: None,
                        skip_chosen: false,
                        skip_hold: None,
                        args: None,
                        launch: None,              // from its live record below
                        permission: vec![],        // ticket 362
                        bypass_disabled: false,    // read at the first pick (`set_mode`)
                        saved: Default::default(), // v1a-40
                        probe: None,               // v1a-33
                        version_probe: None,       // V1A-89
                        acp: None,                 // V2-4a: ACP agents end with the core
                        agent_ended: false,
                        card_due: None,
                    },
                )
            })
            .collect();
        let mut entries = entries;
        for entry in entries.values_mut() {
            crate::delivery::validate(&entry.meta.send_log)?;
            crate::delivery::validate_queue(&entry.meta.send_queue, &entry.meta.send_log)?;
            cancel_queue(&mut entry.meta);
            for send in &mut entry.meta.send_log {
                if matches!(send.status.as_str(), "queued" | "attempting") {
                    send.status = "canceled".into();
                }
            }
            entry.meta.send_log.sort_by_key(|s| s.at);
            cap_log(&mut entry.meta.send_log);
            entry.meta.holder_status = None; // V2-1b: found again below
        }
        // V2-1b: sessions whose holders outlived the last core come back running, with their tokens (by hash).
        let mut kept = std::collections::BTreeSet::new();
        for (id, live) in &live {
            let (Some(entry), Some(record), Some(pid)) =
                (entries.get_mut(id), &live.holder, live.agent_pid)
            else {
                continue;
            };
            if reattach(
                entry,
                record,
                pid,
                live.agent_started,
                live.run_start,
                crate::pty::QUICK_WAIT,
                true,
            ) {
                entry.token_hash = Some(live.token_sha256.clone());
                entry.launch = live.launch_args.clone(); // W35
                entry.token = Some(store::new_id()? + &store::new_id()?);
                kept.insert(id.clone());
            }
        }
        // Ticket 1130 C-C3: what this start kept of the last core's running sessions.
        let (lost, exited) = live
            .keys()
            .filter(|id| !kept.contains(*id))
            .filter_map(|id| entries.get(id))
            .partition::<Vec<_>, _>(|e| resumable(&e.meta) == SessionState::Resumable);
        crate::events::core_started(kept.len(), lost.len(), exited.len());
        // V1A-91: a `--version` probe ends with its core. A row the last core left running without a version probes
        // again when its agent came back, and otherwise reads `unknown` (and so `untested`, as any unknown version
        // does), so the field is never left empty. A row with no live record was not running then: kept as stored.
        for (id, entry) in entries.iter_mut() {
            // Ticket 358: only a version read of a session already running, so a refused command falls back to PATH.
            let proof = crate::approval::check_command(home, entry.meta.kind)
                .ok()
                .flatten();
            let program = match entry.meta.kind {
                AgentKind::Claude => agent_program("claude", proof.as_ref()),
                AgentKind::Codex => agent_program("codex", proof.as_ref()),
                _ => continue,
            };
            if entry.meta.agent_version.is_some()
                || entry.meta.state == SessionState::Closed
                || !live.contains_key(id)
            {
                continue;
            }
            match kept
                .contains(id)
                .then(|| version_probe(&program, VERSION_CEILING))
            {
                Some(Ok(probe)) => entry.version_probe = Some(probe),
                answer => {
                    let reason = answer.and_then(Result::err);
                    let reason = reason
                        .as_deref()
                        .unwrap_or("the probe ended with the last core");
                    eprintln!("session {id}: version unknown: {reason}");
                    entry.meta.agent_version = Some("unknown".into());
                    entry.meta.untested = true;
                }
            }
        }
        let recorded: std::collections::BTreeSet<PathBuf> = entries
            .values()
            .filter_map(|e| e.holder().map(|(h, _)| h.socket.clone()))
            .collect();
        for socket in crate::holder::clean(home, &recorded) {
            eprintln!("unknown holder {}: not adopted", socket.display());
        }
        // v1a-40: before the registry is shared, so no file IO waits under its lock: drop files no open row
        // owns, then read each open row's saved scrollback once.
        let open_row = |id: &str| {
            entries
                .get(id)
                .is_some_and(|e| e.meta.state != SessionState::Closed)
        };
        let mut settings: Settings = match store::read_settings(&home.join("settings.json")) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("invalid settings: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.to_string()),
        };
        settings.user_home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        // v1a-74: with history off no scrollback file stays, a set-aside sessions.json's included.
        if settings.history().is_none() {
            crate::scrollback::sweep(home, |_| false);
        }
        // v1b-40 r2: rows of a set-aside sessions.json keep their files; nothing is swept while one is kept.
        if store::kept_aside(home, "sessions.json") {
            eprintln!(
                "a set-aside sessions.json is kept; saved scrollback and exports are not swept"
            );
        } else {
            crate::scrollback::sweep(home, open_row);
            crate::scrollback_edit::sweep(home, open_row); // v1a-38b
            sweep_rowless(home, |id| entries.contains_key(id)); // V2-6d
        }
        // v1b-38 (V1A-40 review): most recently active rows first, under one total.
        let mut open: Vec<&Entry> = entries
            .values()
            .filter(|e| e.meta.state != SessionState::Closed)
            .collect();
        open.sort_by_key(|e| std::cmp::Reverse(e.meta.attention.last_activity));
        let open: Vec<String> = open.into_iter().map(|e| e.meta.id.clone()).collect();
        for (id, saved) in open.iter().zip(preload(home, &open, PRELOAD_BYTES)) {
            let _ = entries.get_mut(id).unwrap().saved.set(saved);
        }
        let (mut logouts, bad) = Self::load_logouts(home);
        // Ticket 76 r2: a mark whose tab is gone or Closed ends there.
        logouts.retain(|_, tab| {
            entries
                .get(tab)
                .is_some_and(|e| e.meta.state != SessionState::Closed)
        });
        // Ticket 750: a queue.json over its session limit keeps only the states of these rows (none dropped while a
        // set-aside sessions.json is kept, v1b-40), so the core starts and the next register can save.
        let aside = store::kept_aside(home, "sessions.json");
        let mut queue = Queue::open_owned(home, |id| aside || entries.contains_key(id))?;
        for entry in entries.values() {
            queue.register(&entry.meta.id, entry.meta.kind, queue::now_ms())?;
        }
        let (events, mut recovery_warnings) = match queue::journal::recover(home, queue::now_ms()) {
            Ok(batch) => batch,
            Err(error) => {
                eprintln!("hook journal recovery/quarantine failed: {error}");
                (vec![], 1)
            }
        };
        recovery_warnings += bad;
        // v1b-02: recover unacknowledged Stop text after replaying its queue effect.
        let mut chat = crate::chat::Cache::new(home);
        let replayed = !events.is_empty();
        for (path, event) in events {
            if let Err(error) = queue.replay(&event) {
                recovery_warnings += 1;
                match queue::journal::quarantine(home, &path, &error) {
                    Ok(pruned) => recovery_warnings += pruned,
                    Err(error) => eprintln!("hook journal quarantine failed: {error}"),
                }
            } else {
                if event.event == "Stop"
                    && event.payload["agent_id"].as_str().is_none_or(str::is_empty)
                    && let Some(text) = event.payload["last_assistant_message"].as_str()
                    && let Some(entry) = entries.get(&event.session_id)
                {
                    let turn = crate::chat::stop_turn(
                        &event.payload,
                        queue.attention(&event.session_id).completion_seq,
                    );
                    if let Err(error) = chat
                        .stop_plan(&entry.meta, turn, text.into())
                        .and_then(|p| p.persist_bounded())
                    {
                        eprintln!("Stop chat recovery deferred: {error}");
                        recovery_warnings += 1;
                        continue;
                    }
                }
                if let Err(error) = fs::remove_file(path) {
                    eprintln!("hook journal acknowledgement cleanup failed: {error}");
                }
            }
        }
        if replayed {
            queue.flush()?; // ticket 1133: the replayed ids, which `replay` alone does not save
        }
        // V2-1b: a reattached session's items stay waiting, marked as restored until fresh evidence proves them;
        // r3 (S2): so do items the journal replay above raised again (a hook that fired while no core ran).
        for id in &kept {
            queue.checking(id)?;
        }
        for entry in entries.values().filter(|e| !kept.contains(&e.meta.id)) {
            queue.close(&entry.meta.id, entry.meta.state == SessionState::Failed)?;
        }
        let tree = crate::tree::Tree::load(home);
        if let Err(error) = &tree {
            eprintln!("{error}");
        }
        let mut sessions = Self {
            // v1a-06
            remote: crate::machines::State::default(),
            remote_epoch: store::new_id()?,
            start_modes: None,
            home: home.into(),
            token_conversations,
            origins_lost,
            chat,
            settings,
            entries,
            queue,
            recovery_warnings,
            grants: crate::grants::Grants::default(),
            schedules: crate::schedule::Schedules::load(home), // V2.5-11
            schedule_reruns: vec![],
            check_ins: vec![],
            delivery_inflight: BTreeMap::new(),
            wakes: BTreeMap::new(),
            room: room::State::default(),
            pending_enter: BTreeMap::new(),                // v1a-15
            size_waits: BTreeMap::new(),                   // ticket 1137
            widget_hashes: BTreeMap::new(),                // v1b-20
            deny_notes: std::collections::BTreeSet::new(), // V2-8e
            steers: std::collections::BTreeSet::new(),
            wake_rows: std::collections::BTreeSet::new(),
            core_rows: std::collections::BTreeSet::new(),
            joined_rows: BTreeMap::new(),
            left_typed: std::collections::BTreeSet::new(),
            retried: std::collections::BTreeSet::new(),
            inflight_at: BTreeMap::new(),
            retry_at: BTreeMap::new(),
            drops: BTreeMap::new(),
            copy_left: BTreeMap::new(),
            hand_typed: BTreeMap::new(),
            spent: std::collections::BTreeSet::new(),
            clean_wait: BTreeMap::new(),
            hand_sent: BTreeMap::new(),
            goal_wakes: vec![],
            loops_checked: 0,
            removing_worktrees: std::collections::BTreeSet::new(),
            branch_titles: vec![],
            typed_answers: BTreeMap::new(),
            window_size: saved_window_size(home),
            logouts,
            // v1b-15
            board_error: None,
            board_rows: None,                // S9
            board_observed: None,            // S9
            folder_probe: probe_folder,      // v1a-33
            probes: shared_probes().clone(), // v1a-33
            launching: None,                 // v2-1a
            left: false,                     // v2-1b
            switch_hooks: None,
            halted: false,
            composed: Default::default(),
            held_enter: Default::default(),
            submitted: Default::default(),
            touched: Default::default(),
            acp_loading: BTreeMap::new(),
            held_rows: Default::default(),
            outbox_sending: Default::default(),
            closed_views: Default::default(), // v1a-68
            closing: None,                    // V2-6d
            ran: std::sync::Mutex::new(crate::import::Ran::load(home)), // ticket 1073
            unsaved: Default::default(),      // ticket 999
            #[cfg(test)]
            saves: Default::default(),
            #[cfg(test)]
            exit_walked: Default::default(),
            #[cfg(test)]
            send_clones: Default::default(),
            #[cfg(test)]
            snapshots: Default::default(),
            tree, // v2-9a
            writes: Default::default(),
            limit_resumes: BTreeMap::new(), // ticket 372
            events: Default::default(),
        };
        // Ticket 990: the stored parent links, so a lead still hears its workers after a core restart.
        sessions.restore_parents();
        // Ticket 1073 round 4: once per home, the conversations of sessions closed before ran.json existed (before
        // drop_closed below, which may drop old Closed rows).
        let known: Vec<String> = sessions
            .entries
            .values()
            .filter_map(|e| e.meta.agent_session_id.clone())
            .chain(
                sessions
                    .token_conversations
                    .iter()
                    .map(|t| t.conversation.clone()),
            )
            .collect();
        if let Ok(ran) = sessions.ran.get_mut()
            && let Err(e) = ran.seed(home, known.iter().map(String::as_str))
        {
            eprintln!("{}: not seeded: {e}", crate::import::RAN);
        }
        // A set-aside sessions.json leaves no session to name a project or own queue state: then nothing is pruned (v1b-40).
        if !aside {
            // Ticket 621: a store from before the limit shrinks here; sessions.json follows at the next save.
            sessions.drop_closed();
            // Ticket 750: queue state no row owns (rows dropped or closed before the queue forgot them).
            let rows = &sessions.entries;
            if let Err(error) = sessions.queue.retain_sessions(|id| rows.contains_key(id)) {
                eprintln!("queue state of gone sessions not dropped: {error}");
            }
            // v2-9a: pruned in memory only; the file is rewritten by the next edit.
            let known = project_set(&sessions.entries);
            if let Ok(tree) = &mut sessions.tree {
                tree.prune(&known);
            }
        }
        sessions.end_pre_lock_home_seats();
        Ok(sessions)
    }
    /// CHAT-USAGE: copy only transcript identity; no file I/O or send-path access under the registry lock.
    pub(crate) fn context_target(&self, id: &str) -> Option<crate::session_context::Target> {
        let meta = &self.entries.get(id)?.meta;
        if meta.machine.is_some() || !matches!(meta.kind, AgentKind::Claude | AgentKind::Codex) {
            return None;
        }
        Some(crate::session_context::Target {
            kind: meta.kind,
            agent_session_id: meta.agent_session_id.clone()?,
            config_dir: meta.config_dir.clone(),
            cwd: meta.cwd.clone(),
            transcript: self.entries.get(id)?.observer.transcript.clone(),
        })
    }
    /// Ticket 1059: the Context widget's Show breakdown types /context through the send queue, as the user's own text
    /// (sender `user`; delivery.rs refuses it to a session token, and `check_agent` refuses the op to one).
    pub(crate) fn context_send(&mut self, id: &str) -> Result<(), String> {
        self.refresh()?;
        self.observe()?;
        let entry = self.entry(id)?;
        if !entry.agent_live() {
            return Err("agent is not running".into());
        }
        let claude = entry.meta.kind == AgentKind::Claude
            && entry.acp.is_none()
            && entry.meta.machine.is_none();
        let typed = entry.input.pending() || !entry.meta.send_queue.is_empty();
        let meta = entry.meta.clone();
        let shown = self.snapshot_session(&meta);
        crate::session_context::may_refresh(
            claude,
            shown.attention.working,
            crate::delivery::blocked(&shown.pending),
            typed,
        )?;
        self.send("user", id, "/context".into(), vec![], true)
            .map(drop)
    }
    // v1a-06
    pub(crate) fn remote_home(&self) -> PathBuf {
        self.home.clone()
    }
    // v1a-06: the local registry is the authority for remote children.
    pub(crate) fn remote_owned(
        &self,
        caller: &crate::grants::Caller,
        alias: &str,
        id: &str,
    ) -> bool {
        self.remote
            .children
            .get(&(alias.into(), id.into()))
            .is_some_and(|c| c.parent == caller.id)
    }
    pub(crate) fn machine_details(
        &self,
        alias: Option<String>,
    ) -> Result<
        Vec<(
            String,
            crate::machines::Config,
            Option<crate::machines::Channel>,
        )>,
        String,
    > {
        let aliases = self.remote_aliases(crate::machines::known(&self.home)?);
        if let Some(alias) = &alias {
            crate::machines::valid_alias(alias)?;
            if !aliases.contains(alias) {
                return Err("machine alias is not listed".into());
            }
        }
        Ok(aliases
            .into_iter()
            .filter(|a| alias.as_ref().is_none_or(|one| one == a))
            .map(|a| {
                let config = self.settings.machines.get(&a).cloned().unwrap_or_default();
                let channel = self.remote.channels.get(&a).cloned();
                (a, config, channel)
            })
            .collect())
    }
    fn add_machine(
        &mut self,
        alias: String,
        host: String,
        user: Option<String>,
        port: Option<u32>,
        replace: bool,
    ) -> Response {
        crate::machines::valid_alias(&alias)?;
        crate::machines::discovery::validate(&host, user.as_deref(), port)?;
        let listed = self
            .remote_aliases(crate::machines::known(&self.home)?)
            .contains(&alias);
        if replace && !listed {
            return Err("machine alias is not listed".into());
        }
        if !replace && (listed || self.remote.refreshing.contains(&alias)) {
            return Err("machine alias already listed or closing".into());
        }
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let mut machines: BTreeMap<String, crate::machines::Config> = match file.get("machines") {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("invalid machines settings: {e}"))?,
            None => BTreeMap::new(),
        };
        if !replace && machines.contains_key(&alias) {
            return Err("machine alias already listed".into());
        }
        let old = machines.get(&alias).cloned().unwrap_or_default();
        // An edit that changes nothing writes nothing. A changed one is read at the next connection
        // (`discovery::options`); the open channel and its sessions stay.
        if replace && (old.host.as_ref(), &old.user, old.port) == (Some(&host), &user, port) {
            return Ok(Reply::Ack);
        }
        machines.insert(
            alias,
            crate::machines::Config {
                projects: old.projects,
                host: Some(host),
                user,
                port,
            },
        );
        file["machines"] = serde_json::to_value(&machines).map_err(|e| e.to_string())?;
        store::write_capped(
            &path,
            &serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?,
            store::SETTINGS_READ_MAX,
        )?;
        self.settings.machines = machines;
        Ok(Reply::Ack)
    }
    fn check_machine_forget(&self, alias: &str) -> Result<(), String> {
        crate::machines::valid_alias(alias)?;
        if self.remote.starting.contains_key(alias) {
            return Err("machine start in progress; retry removal".into());
        }
        if self
            .remote
            .cache
            .get(alias)
            .into_iter()
            .flatten()
            .any(|s| s.state == SessionState::Running)
            || self.entries.values().any(|e| {
                e.meta.machine.as_deref() == Some(alias) && e.meta.state == SessionState::Running
            })
        {
            return Err("Stop its sessions first".into());
        }
        Ok(())
    }
    fn forget_machine(&mut self, alias: &str) -> Response {
        self.check_machine_forget(alias)?;
        let mut known = crate::machines::known(&self.home)?;
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let mut machines: BTreeMap<String, crate::machines::Config> = match file.get("machines") {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("invalid machines settings: {e}"))?,
            None => BTreeMap::new(),
        };
        if !known.iter().any(|a| a == alias)
            && !machines.contains_key(alias)
            && !self.settings.machines.contains_key(alias)
        {
            return Err("machine alias is not listed".into());
        }
        machines.remove(alias);
        file["machines"] = serde_json::to_value(&machines).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        let remembered = self.home.join("machines.json");
        let previous = match crate::store::read_regular(&remembered) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        // A pinned key left behind would be trusted for the next machine saved under this alias. Removed before the
        // saves, so a failure here changes nothing; a failed save below writes it back, as the machine stays saved.
        let pin = crate::machines::share::known_hosts(&self.home, alias);
        let pinned = match crate::store::read_regular(&pin) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if pinned.is_some() {
            fs::remove_file(&pin).map_err(|e| e.to_string())?;
        }
        let restore = |e: String| match &pinned {
            Some(b) => match store::write_capped(&pin, b, store::READ_MAX) {
                Ok(()) => e,
                Err(r) => format!("{e}; pinned host key restore failed: {r}"),
            },
            None => e,
        };
        known.retain(|a| a != alias);
        // Remove remembered aliases first: a failed settings write rolls them back; memory changes only on success.
        store::write_capped(
            &remembered,
            &serde_json::to_vec(&serde_json::json!({"version":1,"machines":known}))
                .map_err(|e| e.to_string())?,
            store::READ_MAX,
        )
        .map_err(&restore)?;
        if let Err(e) = store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX) {
            if let Err(rollback) = match previous {
                Some(b) => store::write_capped(&remembered, &b, store::READ_MAX),
                None => fs::remove_file(&remembered).map_err(|e| e.to_string()),
            } {
                return Err(restore(format!(
                    "settings.json write failed: {e}; machines.json rollback failed: {rollback}; stores diverged"
                )));
            }
            return Err(restore(e));
        }
        self.settings.machines = machines;
        if let Some(cancel) = self.remote.cancel.get(alias) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.remote.channels.remove(alias);
        self.remote.cache.remove(alias);
        self.remote.unseen_starts.remove(alias);
        self.remote.answered.remove(alias);
        self.remote
            .children
            .retain(|(machine, _), _| machine != alias);
        Ok(Reply::Ack)
    }
    // v1a-06
    pub(crate) fn remote_aliases(&self, known: Vec<String>) -> Vec<String> {
        known
            .into_iter()
            .chain(self.settings.machines.keys().cloned())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    // v1a-06
    pub(crate) fn remote_authorize(
        &mut self,
        caller: Option<&crate::grants::Caller>,
        alias: &str,
        request: &Request,
    ) -> Result<Request, String> {
        let Some(caller) = caller else {
            return Ok(request.clone());
        };
        let project = if let Request::Start { session, .. } = request {
            let mapped = self
                .settings
                .machines
                .get(alias)
                .and_then(|m| m.projects.get(&caller.project))
                .ok_or("remote project is not mapped for this caller")?;
            if !mapped.is_absolute() || &session.project != mapped {
                return Err("outside remote project mapping".into());
            }
            mapped.clone()
        } else if matches!(request, Request::List | Request::Snapshot) {
            self.settings
                .machines
                .get(alias)
                .and_then(|m| m.projects.get(&caller.project))
                .cloned()
                .ok_or("remote project is not mapped for this caller")?
        } else {
            let id = if let Request::Answer { item, answer, .. } = request {
                self.remote
                    .cache
                    .get(alias)
                    .into_iter()
                    .flatten()
                    .find(|s| s.pending.iter().any(|i| &i.id == item))
                    .map(|s| {
                        let decision = s.pending.iter().find(|i| &i.id == item).unwrap();
                        crate::grants::check_answer(
                            decision,
                            answer,
                            self.settings
                                .permission_answers
                                .get(&caller.project)
                                .copied()
                                .unwrap_or(false),
                        )
                        .map(|()| s.id.as_str())
                    })
                    .transpose()?
                    .ok_or("remote decision not found in grants")?
            } else {
                crate::grants::request_target(request).ok_or("remote operation not granted")?
            };
            if !self.remote_owned(caller, alias, id) {
                return Err("outside remote session grants".into());
            }
            self.remote
                .children
                .get(&(alias.into(), id.into()))
                .unwrap()
                .project
                .clone()
        };
        Ok(Request::Forwarded {
            caller: crate::machines::Caller {
                id: format!("{}-{}", self.remote_epoch, caller.id),
                project,
                permission_answers: self
                    .settings
                    .permission_answers
                    .get(&caller.project)
                    .copied()
                    .unwrap_or(false), // v1a-06
            },
            request: Box::new(request.clone()),
        })
    }
    // v1a-06
    pub(crate) fn remote_child(
        &mut self,
        alias: &str,
        caller: &crate::grants::Caller,
        session: &Session,
    ) {
        self.remote.children.insert(
            (alias.into(), session.id.clone()),
            crate::machines::Child {
                parent: caller.id.clone(),
                project: session.project.clone(),
            },
        );
    }
    // v1a-06: forwarding carries the LOCAL permission grant; never inherit remote user settings.
    fn remote_policy<T>(
        &mut self,
        caller: &crate::grants::Caller,
        f: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let enabled = self
            .remote
            .callers
            .get(&caller.id)
            .is_some_and(|c| c.permission_answers);
        // v1a-23: keeps the V1A-04 rule for this caller id. Ticket 32: a start decides by the request's own `remote`
        // flag instead (`launch_as`, `start_granted`), so a local token call of that id is never started as remote.
        self.grants.remote.insert(caller.id.clone());
        let previous = self
            .settings
            .permission_answers
            .insert(caller.project.clone(), enabled);
        let result = f(self);
        if let Some(previous) = previous {
            self.settings
                .permission_answers
                .insert(caller.project.clone(), previous);
        } else {
            self.settings.permission_answers.remove(&caller.project);
        }
        result
    }
    // v1a-06
    pub(crate) fn check_remote_agent(
        &mut self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        self.remote_policy(caller, |s| s.check_agent(caller, request))
    }
    // v1a-06
    pub(crate) fn handle_remote_agent(
        &mut self,
        caller: &crate::grants::Caller,
        request: Request,
    ) -> Response {
        self.remote_policy(caller, |s| s.handle_agent(caller, request))
    }
    // v1b-02: capture under the registry lock; execute after releasing it.
    pub(crate) fn chat_plan(
        &mut self,
        id: &str,
        before: Option<u64>,
        after: Option<u64>,
    ) -> Result<crate::chat::ReadPlan, String> {
        let entry = self.entry(id)?;
        let meta = entry.meta.clone();
        let path = entry.observer.transcript.clone();
        self.chat.plan_source(&meta, path, before, after)
    }
    /// v2-3a: what the handoff header and paths need from a session.
    pub(crate) fn handoff_meta(&mut self, id: &str) -> Result<(AgentKind, PathBuf), String> {
        let meta = &self.entry(id)?.meta;
        Ok((meta.kind, meta.cwd.clone()))
    }
    /// v2-3b: where a handoff from `from` to `to` goes: the conversation's newest session of `to` when it runs (reused,
    /// same id) or can resume (resumed, not duplicated), else a new one in `from`'s folder with the model, effort and
    /// account `to` last ran with. Changes nothing; `handoff_finish` records the conversation once the target exists.
    fn handoff_target(
        &mut self,
        from: &str,
        to: AgentKind,
        acp_agent: Option<&str>,
    ) -> Result<(String, Result<String, Box<Launch>>), String> {
        let meta = self.entry(from)?.meta.clone();
        // Ticket 1002 lane 1 (Fable review R4): the target would be an unlocked Codex or ACP agent fed the locked seat's
        // transcript.
        if meta.home_lock {
            return Err("the chief of staff's seat is not handed off in v1".into());
        }
        // V2-4b: a hand-off to an ACP agent names its `agents.toml` entry (the start checks it is approved); no other
        // target takes a name. Handing from one ACP agent to another is a switch.
        match (to, acp_agent) {
            (AgentKind::Acp, Some(name)) if !name.is_empty() => {}
            (AgentKind::Acp, _) => return Err("hand off to an ACP agent by name".into()),
            (_, Some(_)) => return Err("only a hand-off to an ACP agent names an agent".into()),
            _ => {}
        }
        let same =
            to == meta.kind && (to != AgentKind::Acp || acp_agent == meta.acp_agent.as_deref());
        if same || to == AgentKind::Shell || meta.kind == AgentKind::Shell {
            return Err("hand off to another agent: Claude, Codex or an ACP agent".into());
        }
        // An ACP session takes its agent's name only: no model, effort or account.
        let (args, acp) = match acp_agent {
            Some(name) => (vec![name.to_string()], true),
            None => (vec![], false),
        };
        let conversation = match meta.conversation.clone() {
            Some(c) => c,
            None => store::new_id()?,
        };
        let newest = |e: &&Entry| {
            let a = self.queue.attention(&e.meta.id);
            (a.last_activity, a.completion_seq)
        };
        let earlier = self
            .entries
            .values()
            .filter(|e| {
                e.meta.kind == to
                    && e.meta.conversation.as_ref() == Some(&conversation)
                    && (!acp || e.meta.acp_agent.as_deref() == acp_agent)
            })
            .max_by_key(newest);
        if let Some(e) = earlier {
            if e.meta.state == SessionState::Running && (e.pty.is_some() || e.acp.is_some()) {
                return Ok((conversation, Ok(e.meta.id.clone())));
            }
            // A Claude conversation exists on disk only after its first finished turn (`--resume` fails before).
            if let Some(resume) = e.meta.agent_session_id.clone().filter(|_| {
                to != AgentKind::Claude || self.queue.attention(&e.meta.id).completion_seq > 0
            }) {
                let start = StartSession {
                    kind: to,
                    project: e.meta.project.clone(),
                    worktree: false,
                    label: e.meta.label.clone(),
                    args: args.clone(),
                    model: e.meta.model.clone().filter(|_| !acp),
                    effort: e.meta.effort.clone().filter(|_| !acp),
                    resume: Some(resume),
                    account: None, // a resume keeps the account it ran on
                };
                return Ok((
                    conversation,
                    Err(Box::new(self.launch(start).owner_start())),
                ));
            }
        }
        let last = self
            .entries
            .values()
            .filter(|e| e.meta.kind == to)
            .max_by_key(newest)
            .map(|e| e.meta.clone());
        let start = StartSession {
            kind: to,
            project: meta.project.clone(),
            worktree: false,
            label: meta.label.clone(),
            args,
            model: last.as_ref().and_then(|m| m.model.clone()).filter(|_| !acp),
            effort: last
                .as_ref()
                .and_then(|m| m.effort.clone())
                .filter(|_| !acp),
            resume: None,
            account: last.and_then(|m| m.account).filter(|_| !acp),
        };
        let mut launch = self.launch(start).owner_start();
        // The same folder or worktree as the session handed off from.
        launch.resume_cwd = Some(meta.cwd.clone()).filter(|c| c.is_dir());
        Ok((conversation, Err(Box::new(launch))))
    }
    /// v2-3b: both sessions join the conversation, then `text` goes to `target` as one user message through the
    /// delivery path (queued until the agent is at its prompt).
    fn handoff_finish(
        &mut self,
        from: &str,
        target: &str,
        conversation: &str,
        text: String,
    ) -> Response {
        for id in [from, target] {
            if let Some(entry) = self.entries.get_mut(id) {
                entry.meta.conversation = Some(conversation.into());
            }
        }
        self.save()?;
        let Reply::Delivery { send } = self.send("user", target, text, vec![], true)? else {
            return Err("handoff not sent".into());
        };
        let meta = self.entry(target)?.meta.clone();
        Ok(Reply::Switched {
            session: self.snapshot_session(&meta),
            send,
        })
    }
    pub(crate) fn chat_stop_plan(
        &mut self,
        id: &str,
        payload: &serde_json::Value,
    ) -> Result<Option<crate::chat::StopPlan>, String> {
        if payload["agent_id"].as_str().is_some_and(|s| !s.is_empty()) {
            return Ok(None);
        }
        let Some(text) = payload["last_assistant_message"].as_str() else {
            return Ok(None);
        };
        let turn = crate::chat::stop_turn(payload, self.queue.attention(id).completion_seq);
        let meta = self.entry(id)?.meta.clone();
        self.chat.stop_plan(&meta, turn, text.into()).map(Some)
    }
    /// v1a-23: the leader pid of each live local session, with its token (the owner peer check names the caller).
    pub(crate) fn live_leaders(&mut self) -> Result<BTreeMap<u32, (u32, Option<String>)>, String> {
        self.refresh()?;
        Ok(self
            .entries
            .values()
            .filter(|e| e.meta.machine.is_none() && e.meta.state == SessionState::Running)
            // V2-1a: with its holder's pid, the leader's parent (V2-1b: also an unattached holder's).
            .filter_map(|e| Some((e.meta.pid?, (e.holder()?.0.pid, e.token.clone()))))
            // V2-4a: an ACP agent and its terminals are children of the core, each leading its own session.
            .chain(
                self.entries
                    .values()
                    .filter(|e| e.meta.state == SessionState::Running)
                    .flat_map(|e| {
                        e.acp.iter().flat_map(|acp| {
                            std::iter::once(acp.pid())
                                .chain(acp.terminal_pids())
                                .map(|pid| (pid, (std::process::id(), e.token.clone())))
                        })
                    }),
            )
            .collect())
    }
    pub(crate) fn agent_caller(&self, token: &str) -> Result<crate::grants::Caller, String> {
        // Round 5 (review r4 MUST 1): a token session's own credential stays that session's caller, so it keeps its
        // room seat; `token_of` gives it the token's limits in every check.
        self.entries
            .values()
            .find(|entry| token_matches(entry, token) && self.agent_running(entry)) // ticket 286: not a shell's
            .map(|entry| crate::grants::Caller {
                id: entry.meta.id.clone(),
                project: entry.meta.project.clone(),
            })
            .or_else(|| self.token_caller(token)) // ticket 573: an outside token
            .ok_or_else(|| "unauthorized".into())
    }
    /// Needs 225: a Codex session's label and the account folder its reset ask is for (`None` = "Your own"). Any other
    /// session has no Codex ticket of its own, so it gets no answer here and its ask is refused.
    pub(crate) fn codex_reset_caller(&self, id: &str) -> Option<(String, Option<PathBuf>)> {
        let meta = &self.entries.get(id)?.meta;
        (meta.kind == AgentKind::Codex).then(|| (meta.label.clone(), meta.config_dir.clone()))
    }

    /// Ticket 286 S2/S3: `agent_live` plus the agent-ended marker itself, for the checks that must hold before
    /// `refresh` has latched it: a restarted core's first request, or a holder not attached (whose marker `refresh`
    /// never reads). Any marker counts, torn or not (the wrapper writes it only after the agent exited); one that
    /// cannot be read counts as ended.
    fn agent_running(&self, entry: &Entry) -> bool {
        entry.agent_live()
            && !ended_marker(&self.home, &entry.meta.id)
                .try_exists()
                .unwrap_or(true)
    }
    /// v1a-23 (needs 47): a session caller runs the owner commands (sessions in any project, serve, layout,
    /// worktrees). This keeps what stays the user's: the window's own features, dialog and permission answers (Esc/deny, a verified yes only when the target project's verified-yes option is
    /// on), the launch model check, no hook intake for another session, no window token or transport, and no
    /// approval or verified-yes switch (`ask_owner` turns those into waiting items before this check).
    pub(crate) fn check_agent(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        if self.grants.remote.contains(&caller.id) {
            self.check_owned(caller, request)?;
        }
        self.check_token(caller, request)?; // ticket 573
        if self.locked(&caller.id) {
            self.check_locked(caller, request)?; // ticket 1002 lane 1
        }
        self.check_locked_input(caller, request)?; // look v20 S2
        match request {
            // Ticket 993: a place's lead reads its place's schedules, the Home lead all; any other session none.
            Request::ScheduleList | Request::SessionTidy { .. } => self.schedule_reach(caller).map(drop),
            // Ticket 362: a session caller's child never has Skip permissions in reach, whatever it asks for.
            Request::Start { session, .. }
                if session.kind == AgentKind::Claude && reaches_skip(&session.args) =>
            {
                Err("operation not granted".into())
            }
            Request::Start { session, .. }
                if session.kind == AgentKind::Codex && reaches_codex_bypass(&session.args) =>
            {
                Err("operation not granted".into())
            }
            // v1a-10: session tokens launch only models and efforts the window offers.
            Request::Start { session, .. } if session.model.is_some() || session.effort.is_some() => {
                self.check_stored_model(
                    session.kind,
                    session.model.as_deref(),
                    session.effort.as_deref(),
                )
            }
            Request::Answer { item, answer, .. } => {
                let decision = self.annotated(self.queue.decision(item)?); // V2-8e: its risk, for check_answer
                crate::grants::check_answer(
                    &decision,
                    answer,
                    self.answers_on(&decision.session_id),
                )
            }
            // The window's own features stay the owner's and the window's, as before v1a-23: they were never agent
            // CLI commands (ticket 23 opens the owner commands: sessions, serve, layout, worktrees).
            Request::FilesList { .. }
            | Request::FileRead { .. }
            | Request::FileWrite { .. } // ticket 820: the window's file write is never an agent's
            | Request::FilesSearch { .. }
            | Request::DiffList { .. }
            | Request::DiffFile { .. }
            | Request::ChatPage { .. }
            | Request::HandoffPreview { .. } // v2-3a: transcript text
            | Request::HandoffSend { .. } // v2-3b: starts a session and types into it
            | Request::PrChip { .. } // v2-8b: transcript-derived
            | Request::Subagents { .. } // V2-CF4: transcript-derived, read-only
            | Request::PrLive { .. } // v2-8c: runs the user's gh; the window's own setting
            | Request::PrLiveSet { .. }
            | Request::PrWatch { .. }
            | Request::PrFront { .. }
            | Request::PrView { .. } // V2.5-8/9: runs the user's gh; PrMerge merges as the user
            | Request::PrList
            | Request::PrMerge { .. }
            | Request::PrBranch { .. } // ticket 373: runs the user's gh in a worktree folder
            | Request::AccountList // v2-2a: agent config folders and their login
            | Request::AccountCheck { .. }
            | Request::AccountAdd { .. }
            | Request::AccountRemove { .. } // v2-2d: moves an account folder away
            | Request::AccountRename { .. } // ticket 358: changes what sessions resolve an account by
            | Request::AccountSignIn { .. } // ticket 178 finding 20: browser sign-in, its code, its state
            | Request::AccountSignInCode { .. }
            | Request::AccountSignInCancel { .. }
            | Request::AccountSignInState { .. }
            | Request::AcpAgentSignIn { .. }
            | Request::AcpAgentSignInState { .. }
            | Request::AcpAgentSignInCancel { .. }
            | Request::AcpAgentSignOut { .. }
            | Request::AgentUpdateStart { .. } // ticket 358: runs an installer as the user
            | Request::AgentUpdateCancel { .. }
            | Request::AgentUpdateState
            | Request::SessionContext { .. }
            | Request::AddMachine { .. }
            | Request::ForgetMachine { .. }
            | Request::MachineDetails { .. }
            | Request::MachineAliases // v25f: reads the owner's ~/.ssh, runs ssh
            | Request::MachineProbe { .. }
            | Request::MachineShare // ticket 1050: reads this Mac's host key; Test writes a known_hosts line
            | Request::MachineTrust { .. }
            | Request::AccountUsage { .. } // v2-2c: transcript totals
            | Request::UsageDetail { .. } // v4 Usage page: transcript totals, as AccountUsage
            | Request::CodexResetRead { .. } // needs 225: the owner's Refresh and log; a session only asks to use one
            | Request::CodexResetLog
            | Request::UserCommands { .. } // ticket-98: reads the user's agent config folders
            | Request::ProjectCreate { .. } // V2.5-15: makes a folder, opens an editor, stores an icon
            | Request::ProjectClone { .. } // ticket 370: network I/O from a typed URL, deletes the folder it claimed
            | Request::ProjectCloneState { .. }
            | Request::ProjectCloneCancel { .. }
            | Request::OpenInEditor { .. }
            | Request::EditorApps // ticket 375: reads the owner's Applications folders
            | Request::ProjectIconSet { .. }
            | Request::ProjectIconGet { .. }
            | Request::ProjectFolders // ticket 1040: stats the owner's folders
            | Request::ProjectLocate { .. } // ticket 1040: moves a project's stored records
            | Request::FirstRun // v2-5a: agent detection
            | Request::ProblemFix { .. } // v2-5b: restarts a session, or starts it without hooks
            | Request::LimitResume { .. } // ticket 372: types the fixed continue text into a session at its reset
            | Request::ImagePut { .. }
            | Request::WidgetList
            | Request::WidgetRun { .. }
            | Request::WidgetAct { .. }
            | Request::WidgetPage { .. }
            // V2.5-35 (ticket 183): BoardSnapshot, BoardPut, BoardMove, BoardTaskPut, BoardDone, BoardAdd, BoardSelf reach
            // `board::rights::serve` with the caller; the window's own board edits stay the owner's.
            | Request::BoardSeen { .. }
            | Request::BoardDelete { .. }
            | Request::BoardColumnsPut { .. }
            | Request::BoardSettingsPut { .. } // V2.5-38: like the columns, the owner's and the window's
            | Request::BoardUndo { .. }
            | Request::BoardResolve { .. }
            | Request::BoardSourceStatus { .. }
            | Request::BoardSourceMove { .. }
            | Request::TreeGet // v2-9a
            | Request::TreeEdit { .. }
            | Request::QuitSettings { .. }
            | Request::GitProviders { .. } // v25f: starts a login tab, and reports the owner's CLI logins
            | Request::QueueConnect
            | Request::SwitchModel { .. }
            | Request::SetMode { .. } // CHAT-MODELIST: a mode change is a person's click, never an agent's
            | Request::AgentPermissionGet // ticket 362: the owner's setting
            | Request::AgentPermissionSet { .. }
            | Request::AgentCommandStatus { .. } // ticket 358: what the owner's sessions run
            | Request::AgentCommandCheck { .. }
            | Request::AgentCommandGrant { .. }
            | Request::AgentCommandReset { .. }
            | Request::CloseUndo { .. } // V2-6d: the window's Undo, as the owner's
            | Request::CloseIdle { .. } // ticket 1130: the composer's restart for a new MCP server
            // V2.5-11: a schedule starts agent work later with the owner's authority, so only the owner makes one.
            | Request::ScheduleAdd { .. }
            | Request::ScheduleRemove { .. }
            | Request::ScheduleRunNow { .. } // ticket 993
            | Request::SchedulePause { .. }
            // V2-1b r3 (S1): only the owner makes the core exit and leave its holders without a core for anyone to
            // attach. `stop` stays a session's (v1a-23, OWNERC D'): it ends every holder with the core.
            | Request::Exit
            | Request::ExitIfIdle { .. }
            | Request::ExitBlockers { .. } // ticket 1130 A-D3: the owner's update asks
            // Ticket 573: tokens are the owner's to make (the server refuses them first).
            | Request::TokenCreate { .. }
            | Request::TokenList
            | Request::TokenRevoke { .. } => Err("operation not granted".into()),
            // Needs 225: a session asks for its own session's account only, and never from another machine.
            Request::CodexResetUse { account, .. }
                if account.is_some() || self.grants.remote.contains(&caller.id) =>
            {
                Err("operation not granted".into())
            }
            Request::Hook { .. }
            | Request::WindowAuth
            | Request::Remote { .. }
            | Request::RemoteService { .. }
            | Request::Forwarded { .. }
            | Request::MachineStatus { .. }
            | Request::ApprovalGrant { .. }
            | Request::BoardSourceGrant { .. }
            // Ticket 259: a setup script is approved by a person in the window (the server refuses these first).
            | Request::SetupStatus { .. }
            | Request::SetupGrant { .. }
            // V2-4a: approving an agent is human-only; never asked of the owner from a session either.
            | Request::AcpAgentStatus { .. }
            | Request::AcpAgentGrant { .. }
            // V2-4b: so are the setup requests (they run the typed command, write agents.toml, open a login tab).
            | Request::AcpAgents
            | Request::AcpAgentCheck { .. }
            | Request::AcpAgentAdd { .. }
            | Request::AcpAgentLogin { .. }
            // Ticket 276: an agent may not list, add or remove extensions.
            | Request::ExtensionsList
            | Request::ExtensionsMcpAdd { .. }
            | Request::ExtensionsMcpRemove { .. }
            | Request::ExtensionsItemFiles { .. }
            | Request::ExtensionsItemRead { .. }
            | Request::ExtensionsItemSave { .. }
            | Request::ExtensionsSkillNew { .. }
            | Request::ExtensionsItemRemove { .. }
            | Request::PermissionAnswers { on: true, .. } => Err("operation not granted".into()),
            // Ticket 286 r6 (Codex security review of 1a7025d4): a session caller closes only itself and the sessions
            // it started (their stored `parent`, which outlives a core restart, or a run it resumed: `started_by`); a
            // user tab or another parent's worker stays the owner's to close. Remote callers already passed
            // `check_owned` (their own workers only).
            Request::Close { id }
                if *id != caller.id
                    && self
                        .entries
                        .get(id)
                        .is_some_and(|e| !self.started_by(&e.meta, &caller.id)) =>
            {
                Err("a session closes only itself and the sessions it started".into())
            }
            _ => Ok(()),
        }
    }
    /// Ticket 1002 lane 1: the session runs with the Home seat lock.
    pub(crate) fn locked(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| e.meta.home_lock)
    }
    /// Ticket 1002 lane 1 (Fable check M5): what a locked session (the Home seat and what it started) may ask the core:
    /// its own work only, by op name (lane 2's outbox ops are named here before they exist on this branch). No shell,
    /// Codex or ACP child, no typed keys, no other machine, no browser, nothing sent to a session it did not start.
    pub(crate) fn check_locked(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        const OPS: &[&str] = &[
            "hook",
            "task",
            "role",
            "note",
            "schedule_list",
            "schedule_propose",
            "schedule_change",
            "room_send",
            "room_reply",
            "room_check",
            "room_thread",
            "room_read",
            "room_pin",
            "room_answer",
            "outbox_stage",
            "outbox_spend",
            "agent_list",
            "list",
            "events",
            "start",
            "team_open",
            "close",
            "session_tidy",
            "agent_send",
            "agent_prompt",
            "steer_now",
            "cancel_send",
            "agent_read",
            "agent_get",
            "read",
        ];
        let op = serde_json::to_value(request)
            .ok()
            .and_then(|v| Some(v.get("op")?.as_str()?.to_string()))
            .unwrap_or_default();
        let refused = || {
            Err(format!(
                "{op}: not for the chief of staff's seat (ticket 1002 seat lock)"
            ))
        };
        // Fable round 3 review M1: another session is its own only when it is locked too (an adopted pre-lock worker is
        // not).
        let own = |id: &str| {
            id == caller.id
                || self
                    .entries
                    .get(id)
                    .is_some_and(|e| e.meta.home_lock && self.started_by(&e.meta, &caller.id))
        };
        match request {
            _ if !OPS.contains(&op.as_str()) => refused(),
            // A child is a Claude start in the Home folder itself (Fable review R1a, final S6: not a subfolder, whose
            // own `.claude` the parent could have written) with no arguments, env, folder or worktree;
            // `launch_as` locks it.
            Request::Start {
                session,
                folder,
                env,
                ..
            } if session.kind != AgentKind::Claude
                || !session.args.is_empty()
                || !env.is_empty()
                || folder.is_some()
                || session.worktree
                || fs::canonicalize(&session.project).ok()
                    != Some(crate::team::Team::open(&self.home).home()) =>
            {
                refused()
            }
            Request::AgentSend { id, .. }
            | Request::AgentPrompt { id, .. }
            | Request::SteerNow { id, .. }
            | Request::CancelSend { id, .. }
            | Request::AgentRead { id, .. }
            | Request::AgentGet { id }
            | Request::Read { id, .. }
                if !own(id) =>
            {
                refused()
            }
            _ => Ok(()),
        }
    }
    /// Look v20 S2: a locked seat takes input (text, keys, a prompt, a send canceled, an answer to its prompt) only from
    /// the owner (the window and the owner socket never come here), itself, and a locked session that started it. A
    /// room line reaches it as the room's own fixed notice.
    fn check_locked_input(
        &self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Result<(), String> {
        let target = match request {
            Request::AgentSend { id, .. }
            | Request::AgentPrompt { id, .. }
            | Request::SteerNow { id, .. }
            | Request::AgentKeys { id, .. }
            | Request::SendText { id, .. }
            | Request::SendKeys { id, .. }
            | Request::CancelSend { id, .. } => id.clone(),
            Request::Answer { item, .. } => match self.queue.decision(item) {
                Ok(d) => d.session_id,
                Err(_) => return Ok(()), // not an agent's item: answering it reaches no seat
            },
            _ => return Ok(()),
        };
        let from_its_lead = self.locked(&caller.id)
            && self
                .entries
                .get(&target)
                .is_some_and(|e| self.started_by(&e.meta, &caller.id));
        if self.locked(&target) && target != caller.id && !from_its_lead {
            return Err("refused: the chief of staff's seat is locked and takes input only from you, in the window (ticket 1002 seat lock); nothing was sent".into());
        }
        Ok(())
    }
    /// Whether `caller` started `meta`'s session: its stored `parent` is the caller, or a run the caller resumed. Look
    /// 1117 v13 B N13-S2-2: a seat started before a quit and Resume names its lead's old id, which the core keeps in the
    /// lead's `owned_from` (an owner's or the core's resume only); the lead could not close it or clean up its worktree.
    fn started_by(&self, meta: &Session, caller: &str) -> bool {
        meta.parent.as_deref().is_some_and(|p| {
            p == caller
                || self
                    .entries
                    .get(caller)
                    .is_some_and(|c| c.meta.owned_from.iter().any(|r| r == p))
        })
    }
    /// v1a-23: the verified-yes option of the project the target session runs in.
    fn answers_on(&self, session: &str) -> bool {
        self.entries.get(session).is_some_and(|e| {
            self.settings
                .permission_answers
                .get(&e.meta.project)
                .copied()
                .unwrap_or(false)
        })
    }
    /// v1a-23: the two human actions asked by a session caller become one waiting item for the owner (one per
    /// subject or project; a repeat returns the same item). `None` for every other request.
    pub(crate) fn ask_owner(
        &mut self,
        caller: &crate::grants::Caller,
        request: &Request,
    ) -> Option<Response> {
        use crate::approval::SubjectKind;
        let approval =
            |subject, name: &String, level, view: Result<crate::approval::View, String>| {
                view.map(|v| queue::OwnerAsk::Approval {
                    subject,
                    name: name.clone(),
                    level,
                    hash: v.hash,
                })
            };
        let ask = match request {
            Request::ApprovalGrant { name, level, .. } => approval(
                SubjectKind::Widget,
                name,
                *level,
                crate::approval::status(&self.home, name),
            ),
            Request::BoardSourceGrant { name, level, .. } => approval(
                SubjectKind::Source,
                name,
                *level,
                crate::approval::source_status(&self.home, name),
            ),
            Request::PermissionAnswers { project, on: true } => fs::canonicalize(project)
                .map(|project| queue::OwnerAsk::PermissionAnswers { project })
                .map_err(|e| e.to_string()),
            Request::QuitSettings { patch } if crate::account_near::asks_leads_any(patch) => {
                Ok(queue::OwnerAsk::LeadAccounts)
            }
            _ => return None,
        };
        // Ticket 573: an outside token never asks the owner for a setting.
        if self.token_of(caller).is_some() {
            return Some(Err("operation not granted".into()));
        }
        Some(
            ask.and_then(|ask| self.queue.ask_owner(&caller.id, ask))
                .map(|item| Reply::Waiting { item }),
        )
    }
    /// V1A-04 grants, now for remote callers only (V1A-06: `--machine` reach stays the owned workers).
    /// Ticket 573: the sessions a remote-flagged caller may see events of (`owns`, as its snapshot); `None` for any
    /// other caller.
    pub(crate) fn owned_sessions(
        &self,
        caller: &crate::grants::Caller,
    ) -> Option<std::collections::BTreeSet<String>> {
        self.grants.remote.contains(&caller.id).then(|| {
            self.entries
                .values()
                .filter(|e| self.grants.owns(caller, &e.meta))
                .map(|e| e.meta.id.clone())
                .collect()
        })
    }
    fn check_owned(&self, caller: &crate::grants::Caller, request: &Request) -> Result<(), String> {
        if let Request::Start {
            session, folder, ..
        } = request
        {
            let project = fs::canonicalize(&session.project).map_err(|e| e.to_string())?;
            // v1a-16
            if project != caller.project && !self.created_worktree(caller, &project)? {
                return Err("outside session grants".into());
            }
            if let Some(folder) = folder
                && !self.created_worktree(caller, folder)?
            {
                return Err("outside session grants".into());
            }
            // v1a-10: session tokens launch only models and efforts the window offers.
            if session.model.is_some() || session.effort.is_some() {
                self.check_stored_model(
                    session.kind,
                    session.model.as_deref(),
                    session.effort.as_deref(),
                )?;
            }
            if let Some(resume) = &session.resume
                && !self.entries.values().any(|e| {
                    e.meta.agent_session_id.as_ref() == Some(resume)
                        && self.grants.owns(caller, &e.meta)
                })
            {
                return Err("resume outside session grants".into());
            }
            return Ok(());
        }
        if matches!(
            request,
            Request::List | Request::Snapshot | Request::AgentList { .. } // V2.5-30: filtered by `owns`
            | Request::Events { .. } // ticket 573: filtered by `owned_sessions`
        ) {
            return Ok(());
        }
        let id = if let Request::Answer { item, answer, .. } = request {
            let decision = self.annotated(self.queue.decision(item)?); // V2-8e
            crate::grants::check_answer(
                &decision,
                answer,
                self.settings
                    .permission_answers
                    .get(&caller.project)
                    .copied()
                    .unwrap_or(false),
            )?;
            decision.session_id
        } else {
            crate::grants::request_target(request)
                .ok_or("operation not granted")?
                .to_string()
        };
        let entry = self.entries.get(&id).ok_or("session not found")?;
        if !self.grants.owns(caller, &entry.meta) {
            return Err("outside session grants".into());
        }
        Ok(())
    }
    /// `remote`: this request came forwarded from another machine (ticket 32: per request, never remembered).
    pub(crate) fn start_granted(
        &mut self,
        caller: &crate::grants::Caller,
        launch: &Launch,
        remote: bool,
    ) -> Result<Session, String> {
        // v1a-16: re-read the store on every start; a yes is never cached. v1a-23: remote callers only.
        let worktree = launch.project != caller.project;
        if worktree && remote && !self.created_worktree(caller, &launch.project)? {
            return Err("outside session grants".into());
        }
        // Ticket 990: a worktree start now arrives as `folder` (its project is the main checkout). The caller's own
        // folder stays allowed, as it was when the worktree was the project (a worker starting its reviewer).
        if remote
            && let Some(folder) = &launch.folder
            && self
                .entries
                .get(&caller.id)
                .is_none_or(|e| &e.meta.cwd != folder)
            && !self.created_worktree(caller, folder)?
        {
            return Err("outside session grants".into());
        }
        // ACCOUNTPICK: the prepared launch (a resume included) runs on the caller's account; shells use none.
        // Ticket 1120: or the account the user set for the caller's place. Ticket 1126: or the owner's default, read
        // again here, so a launch prepared before the owner changed it is refused rather than started on the old one.
        // An explicit "Your own" default admits no label (None) for a caller on another account.
        let default = self.default_account(launch.start.kind, remote);
        if !matches!(launch.start.kind, AgentKind::Shell | AgentKind::Acp)
            && launch.account != self.caller_account(caller, remote)
            && default.as_ref() != Some(&launch.account)
            && (launch.account.is_none()
                || (launch.account != self.place_account(caller, remote)
                    && !self.lead_any(caller, remote)))
        {
            return Err("a session can start sessions only on its own account".into());
        }
        // Owner 2026-11-25: a start that only "Leads may use any of my accounts" admits says so in the room.
        let lead_line = (launch.account.is_some()
            && !matches!(launch.start.kind, AgentKind::Shell | AgentKind::Acp)
            && launch.account != self.caller_account(caller, remote)
            && launch.account != self.place_account(caller, remote)
            && default.as_ref() != Some(&launch.account))
        .then(|| launch.account.clone())
        .flatten();
        // Ticket 990 slice g: among the seats a lead's side starts, one writer per worktree. A resume continues a seat
        // (`start` moves it); a shell is no seat.
        let ledger = crate::ledger::Ledger::open(&self.home);
        // After one Codex look: only a session that works for the task's own lead is its seat. Any session may start
        // one in any folder; one from another place gets no seat there (no review, no notes of that project).
        let lead = self.team_lead_of(&caller.id);
        let seat_in = (launch.start.kind != AgentKind::Shell && launch.start.resume.is_none())
            .then(|| launch.cwd.clone())
            .filter(|cwd| {
                lead.is_some() && ledger.of_worktree(cwd).is_some_and(|t| t.lead == lead)
            });
        if let Some(cwd) = &seat_in
            && crate::roles::of(&self.home, &launch.start.label).1
        {
            ledger.writer_free(cwd, |s| self.entries.get(s).is_some_and(|e| e.agent_live()))?;
        }
        // Codex security look P2: the line is the audit of the start, so it is written first and a refused write
        // (a full room) refuses the start.
        if let Some(account) = &lead_line {
            self.lead_any_line(caller, launch, account)?;
        }
        let mut child = self.start(launch)?;
        if let Some(cwd) = &seat_in {
            let live = |s: &str| self.entries.get(s).is_some_and(|e| e.agent_live());
            match ledger.seat(cwd, &child.id, &child.label, queue::now_ms(), &live) {
                Ok(Some(task)) => crate::events::tasks(&task.place),
                Ok(None) => {}
                Err(e) => eprintln!("ledger seat not recorded: {e}"),
            }
        }
        self.grants
            .parents
            .insert(child.id.clone(), caller.id.clone());
        if worktree {
            self.grants
                .worktrees
                .insert(child.id.clone(), launch.project.clone());
        }
        // V2.5-30: the parent link on the stored record outlives a core restart (the grants map does not). The child
        // already runs, so a failed save is logged, not returned; the next save writes it.
        child.parent = Some(caller.id.clone());
        // After one Codex look: a session's own start never takes a teammate's seat, also when it resumes a seat's
        // conversation (the resumed run would carry the mark, and a lead's mark opens its place's teammates). A seat
        // is marked only by `team::open_seat`, after this.
        child.teammate = None;
        // Codex security MUST (w20-h): nor the close rights of the run it resumes (a local agent can name any ended
        // run's conversation in its project); `resumed_from` stays, for the room's names only.
        child.owned_from.clear();
        if let Some(entry) = self.entries.get_mut(&child.id) {
            entry.meta.parent = child.parent.clone();
            entry.meta.teammate = None;
            entry.meta.owned_from.clear();
        }
        if let Err(e) = self.save() {
            eprintln!("parent link not saved yet: {e}");
        }
        Ok(child)
    }
    // v1a-16: exactly the path of a present managed worktree of the caller's project that this session created.
    // v1a-21: a busy worktree lock is reported as busy instead of a refusal; v1a-22: `past_busy_worktree` retries it.
    fn created_worktree(
        &self,
        caller: &crate::grants::Caller,
        project: &Path,
    ) -> Result<bool, String> {
        let listed = self
            .worktree_plan(
                Some(caller),
                Request::Worktree {
                    operation: "list".into(),
                    project: Some(caller.project.clone()),
                    path: None,
                    branch: None,
                    base: String::new(),
                    label: String::new(),
                    from: None,
                    confirm: None,
                },
            )
            .and_then(WorktreePlan::execute);
        match listed {
            Err(e) if e == WORKTREE_BUSY => Err(e),
            listed => Ok(listed.is_ok_and(|(worktrees, _)| {
                worktrees.iter().any(|w| {
                    w.path == project && !w.missing && w.creator.as_deref() == Some(&caller.id)
                })
            })),
        }
    }
    /// v1a-22: runs `f` under the registry lock, retrying a busy worktree lock for 500 ms with the registry
    /// released between tries; returns the guard `f` last succeeded under. Ticket 396: an answer waiting for a resize
    /// redraw retries the same way and, still not redrawn, gets the usual refusal.
    pub(crate) fn past_busy_worktree<T>(
        registry: &std::sync::Mutex<Sessions>,
        mut f: impl FnMut(&mut Sessions) -> Result<T, String>,
    ) -> Result<(std::sync::MutexGuard<'_, Sessions>, T), String> {
        let until = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            let mut sessions = registry
                .lock()
                .map_err(|_| "session registry unavailable")?;
            match f(&mut sessions) {
                Err(e)
                    if (e == WORKTREE_BUSY || e == SCREEN_REDRAWING)
                        && std::time::Instant::now() < until =>
                {
                    drop(sessions);
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(e) if e == SCREEN_REDRAWING => return Err(NOT_ON_SCREEN.into()),
                result => return result.map(|t| (sessions, t)),
            }
        }
    }
    fn resize_pty(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        // A same-size resize raises no SIGWINCH, so the agent never redraws: blanking the screen would leave it blank.
        let same = self.entry(id)?.pty_size == Some((cols, rows));
        let live = self.live(id)?;
        if same {
            return Ok(());
        }
        if let Err(e) = live.resize(cols, rows) {
            // A holder reply timeout can leave the real size changed or not: unknown, so the next resize is a real one.
            self.entry(id)?.pty_size = None;
            return Err(e);
        }
        let entry = self.entry(id)?;
        entry.pty_size = Some((cols, rows));
        let old = std::mem::replace(
            &mut entry.observer.screen,
            waiting::screen::Screen::new(cols as usize, rows as usize),
        );
        entry.observer.screen.alt = old.alt; // a resize leaves the program in front where it was
        // Seventh look (B S1-1): kept for `tick`. A second resize before any redraw keeps the first's screen.
        let last = if old.drawn() {
            Some(old)
        } else {
            entry.observer.unredrawn.take().map(|(screen, _)| screen)
        };
        entry.observer.unredrawn = last.map(|screen| (screen, std::time::Instant::now()));
        Ok(())
    }
    pub(crate) fn handle_agent(
        &mut self,
        caller: &crate::grants::Caller,
        request: Request,
    ) -> Response {
        self.refresh()?;
        self.observe()?;
        self.check_agent(caller, &request)?;
        match &request {
            Request::AgentSend { id, text } | Request::SendText { id, text, .. } => {
                return self.send(&caller.id, id, text.clone(), vec![], false);
            }
            Request::AgentPrompt { id, text } => {
                let text = self.with_notes(id, text.clone()); // ticket 990 slice h
                return self.send(&caller.id, id, text, vec![], true);
            }
            // v25-sendkeys: a session caller's steer takes the same checks as its own Esc and prompt.
            Request::SteerNow { id, text, seen } => {
                return self.steer_now(&caller.id, id, text.clone(), seen);
            }
            Request::SendKeys { id, keys, .. } | Request::AgentKeys { id, keys } => {
                // v1a-23: the target's project; r2 (S1): a remote caller also needs the flag its machine delegated
                // (`remote_policy` puts it on `caller.project`), never only this machine's own setting.
                let enabled = self.answers_on(id)
                    && (!self.grants.remote.contains(&caller.id)
                        || self
                            .settings
                            .permission_answers
                            .get(&caller.project)
                            .copied()
                            .unwrap_or(false));
                return self.agent_keys(&caller.id, id, keys.clone(), enabled);
            }
            Request::Answer {
                item,
                answer,
                confirmed,
            } => {
                let target = self.queue.decision(item)?.session_id;
                let send = self.begin_send(
                    &caller.id,
                    &target,
                    format!(
                        "answer: {}",
                        serde_json::to_string(answer).map_err(|e| e.to_string())?
                    ),
                    vec![],
                    false,
                    "attempting",
                )?;
                let result = self.answer(item, answer.clone(), *confirmed);
                self.finish_send(
                    &target,
                    &send.id,
                    if result.is_ok() {
                        "delivered"
                    } else {
                        "failed"
                    },
                )?;
                return result;
            }
            // Ticket 993: only what the caller may read (`check_agent` refused every session that is no lead's seat).
            Request::ScheduleList => {
                let place = self.schedule_reach(caller)?;
                return self
                    .schedules_in(place.as_deref())
                    .map(|schedules| Reply::Schedules { schedules });
            }
            Request::SchedulePropose {
                who,
                when,
                task,
                level,
            } => return self.schedule_propose(caller, who, when, task.clone(), *level),
            Request::ScheduleChange { id, change } => {
                return self.schedule_change(caller, id, change);
            }
            Request::OutboxStage { .. } => return self.outbox_stage(caller, &request), // ticket 1002
            Request::OutboxSpend { tool, args_hash } => {
                return self.outbox_spend(caller, tool, args_hash);
            }
            // V2-1b: a session caller's close never ends an agent its holder no longer answers for.
            Request::Close { id } => return self.close(id, false, false),
            Request::SessionTidy { id, why } => {
                return self.tidy_session(caller, id, why, queue::now_ms());
            }
            Request::Resize { id, cols, rows } => {
                // v1a-75: a session agent's resize never arms the V1A-71 grace, or it could keep a gone prompt's card.
                // Nor does it keep the screen for `restore_undrawn` (which holds the card and arms that grace): after
                // an agent's resize the screen is blank until the agent redraws, as before (Codex look on wave 14).
                self.resize_pty(id, *cols, *rows)?;
                self.entry(id)?.observer.unredrawn = None;
                return Ok(Reply::Ack);
            }
            _ => {}
        }
        // Ticket 571: the room stamps this caller as the sender.
        if room::is_room(&request) {
            return self.room(Some(caller), request);
        }
        // V2.5-35 (ticket 183): a session's board requests carry the caller the core resolved (token, peer check).
        if let Request::BoardSnapshot
        | Request::BoardPut { .. }
        | Request::BoardMove { .. }
        | Request::BoardTaskPut { .. }
        | Request::BoardDone { .. }
        | Request::BoardAdd { .. }
        | Request::BoardSelf = request
        {
            return self.board(crate::board::rights::Writer::Session(&caller.id), request);
        }
        if let Request::List | Request::Snapshot | Request::AgentList { .. } = request {
            // V2.5-30: `--mine` is the caller's direct children; the caller is the token's or the peer-checked session.
            let mine = matches!(request, Request::AgentList { mine: true });
            self.refresh()?;
            self.observe()?;
            return Ok(Reply::Snapshot {
                sessions: self
                    .started_order()
                    .filter(|e| self.grants.owns(caller, &e.meta)) // v1a-23: every session, unless remote
                    .filter(|e| self.token_reaches(caller, &e.meta)) // ticket 573: a project token's project
                    .filter(|e| !mine || self.started_by(&e.meta, &caller.id))
                    .map(|e| self.snapshot_session(&e.meta))
                    .collect(),
                keep_awake_held: crate::keep_awake::held(), // V2-CF5
                problem: None, // v2-5b: the core's own problems are the owner's
                board_decisions: vec![], // v1b-18: board decisions are the owner's
                owner_decisions: vec![], // v1a-23: so are the waiting owner items
            });
        }
        self.handle(request)
    }
    /// V2.5-35: every board request, under the registry lock, with the live sessions the rights check reads.
    fn board(&self, writer: crate::board::rights::Writer, request: Request) -> Response {
        let sessions: Vec<_> = self
            .entries
            .values()
            .map(|e| self.snapshot_session(&e.meta))
            .collect();
        let mut reply = crate::board::rights::serve(&self.home, &sessions, writer, request)?;
        if let Reply::BoardSnapshot { board } = &mut reply {
            let merging: Vec<String> = self
                .queue
                .owner_items()
                .into_iter()
                .filter_map(|i| match i.owner {
                    Some(queue::OwnerAsk::Merge { task, .. }) => Some(task),
                    _ => None,
                })
                .collect();
            crate::board::task_cards_by_merge(board, &merging);
        }
        Ok(reply)
    }
    pub fn authorize_hook(&self, token: &str, request: &Request) -> bool {
        match request {
            Request::Hook { id, .. } => self
                .entries
                .get(id)
                .is_some_and(|e| token_matches(e, token)),
            _ => false,
        }
    }
    fn save(&self) -> Result<(), String> {
        #[cfg(test)]
        self.saves.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // V2-1b: after `exit` the file keeps what the next core reattaches.
        if self.left {
            return Ok(());
        }
        // V2-1a: a session's token hash and holder are kept while it has a PTY (V2-1b: or an unattached live holder);
        // closing drops them (revoked).
        let mut live: BTreeMap<String, store::Live> = self
            .entries
            .iter()
            .filter_map(|(id, e)| {
                let (holder, agent_started) = e.holder()?;
                let holder = holder.clone();
                let run_start = match (&e.pty, &e.stale) {
                    (Some(pty), _) => pty.run_start(),
                    (None, Some(stale)) => stale.run_start,
                    (None, None) => 0,
                };
                let live = store::Live {
                    token_sha256: e.token_hash.clone()?,
                    holder: Some(holder),
                    agent_started,
                    run_start,
                    launch_args: e
                        .launch
                        .clone()
                        .filter(|a| claude_modes::storable(e.meta.kind, a)), // W35: allow list only
                    agent_pid: None,
                };
                Some((id.clone(), live))
            })
            .collect();
        if let Some((id, hash)) = &self.launching {
            live.insert(
                id.clone(),
                store::Live {
                    token_sha256: hash.clone(),
                    holder: None,
                    agent_started: None,
                    run_start: 0,
                    launch_args: None,
                    agent_pid: None,
                },
            );
        }
        // Ticket 621 round 3: a token row inside its Undo window is stored as Closed, so a core that ends in the window
        // keeps the row (and its origin) instead of losing it with phase 1's removal.
        let pending = self
            .closing
            .as_ref()
            .map(|c| &c.entry.meta)
            .filter(|m| self.token_origin(m).is_some())
            .map(|m| {
                let mut m = m.clone();
                (m.state, m.closed_at, m.pid) = (SessionState::Closed, Some(queue::now_ms()), None);
                m
            });
        store::save_all(
            &self.home,
            self.entries
                .values()
                .map(|e| e.meta.clone())
                .chain(pending)
                .collect(),
            live,
            self.token_conversations.clone(),
        )?;
        // Ticket 1073: the conversations of the rows (and of the one in its close window) are Nunchiro's; logged, not
        // fatal: a lost write only lets History call that conversation "started in a terminal" after its close.
        if let Ok(mut ran) = self.ran.lock()
            && let Err(e) = ran.note(
                &self.home,
                self.entries
                    .values()
                    .map(|e| &e.meta)
                    .chain(self.closing.as_ref().map(|c| &c.entry.meta))
                    .filter_map(|m| m.agent_session_id.as_deref()),
            )
        {
            eprintln!("{}: {e}", crate::import::RAN);
        }
        // Ticket 999: this save wrote every row, so whatever a pass left unsaved went with it. Only once written: a
        // failed save keeps the mark and the next tick (or `refresh`) tries again.
        self.unsaved
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn refresh(&mut self) -> Result<(), String> {
        self.refresh_unsaved()?;
        self.save_unsaved()
    }
    /// Ticket 999: a save only when a pass left rows unsaved (`refresh_unsaved`, `deliver`) and none ran since.
    fn save_unsaved(&mut self) -> Result<(), String> {
        if self.unsaved.load(std::sync::atomic::Ordering::SeqCst) {
            return self.save();
        }
        Ok(())
    }
    /// `refresh` without its save: a change is marked `unsaved`, for a tick that saves once after its whole pass.
    fn refresh_unsaved(&mut self) -> Result<(), String> {
        // v1b-15
        self.observe_board();
        let mut changed = false;
        let mut saves = vec![];
        let mut finished_workers = vec![];
        let mut acp_settled = vec![]; // ticket 1130 round 3: resumed ACP sessions whose load ended, and how
        for entry in self.entries.values_mut() {
            // V1A-89: a probe that outlived Start's wait; a failed or hung one reads as a failed `--version` does.
            let answer = entry
                .version_probe
                .as_ref()
                .and_then(|probe| match probe.try_recv() {
                    Ok(answer) => Some(answer),
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        Some(Err("version probe ended without an answer".into()))
                    }
                });
            if let Some(answer) = answer {
                entry.version_probe = None;
                let version = answer.unwrap_or_else(|e| {
                    eprintln!("session {}: {e}", entry.meta.id);
                    "unknown".into()
                });
                entry.meta.untested = !crate::chat::tested(
                    entry.meta.kind,
                    Some(&version),
                    crate::chat::TESTED_VERSIONS,
                );
                crate::agent_canary::version_seen(&self.home, entry.meta.kind, &version); // ticket 1100
                entry.meta.agent_version = Some(version);
                changed = true;
            }
            if entry.meta.state != SessionState::Running {
                continue;
            }
            // v1a-33: EPERM/EACCES or no answer within the bound is macOS file access; any other answer is not ours.
            let denied = entry
                .probe
                .as_ref()
                .and_then(|(since, answer)| match answer.try_recv() {
                    Ok(Err(e)) => Some(e.kind() == std::io::ErrorKind::PermissionDenied),
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        (since.elapsed() >= PROBE_BOUND).then_some(true)
                    }
                    Ok(Ok(())) | Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(false),
                });
            if let Some(denied) = denied {
                entry.probe = None;
                if denied {
                    entry.meta.blocked = Some(crate::api::Blocked {
                        reason: crate::api::BlockedReason::FileAccess,
                        path: entry.meta.cwd.clone(),
                    });
                    changed = true;
                }
            }
            // V2-1b: an unattached holder: the session runs while its agent does; a silent one is tried again.
            if entry.pty.is_none()
                && let Some(stale) = entry.stale.as_mut()
            {
                if crate::peer::running_since(stale.pid, stale.started) {
                    if entry.meta.holder_status.is_none()
                        && std::time::Instant::now() >= stale.retry
                    {
                        stale.retry = std::time::Instant::now() + STALE_RETRY;
                        let (record, pid, started, run_start) = (
                            stale.record.clone(),
                            stale.pid,
                            stale.started,
                            stale.run_start,
                        );
                        // Under the registry lock: a short bound, so a silent holder costs little per retry.
                        changed |= reattach(
                            entry,
                            &record,
                            pid,
                            started,
                            run_start,
                            std::time::Duration::from_millis(200),
                            false,
                        );
                    }
                    continue;
                }
                entry.stale = None;
                entry.meta.state = resumable(&entry.meta);
                entry.meta.pid = None;
                entry.meta.holder_status = None;
                close_queue(&mut self.queue, &entry.meta.id, false);
                changed = true;
                continue;
            }
            // V2-4a: an ACP agent's messages since the last pass; it ends exited (resumable when it declared
            // `loadSession`) or failed.
            if let Some(acp) = entry.acp.as_mut() {
                let before = (
                    entry.meta.agent_session_id.clone(),
                    entry.meta.model.clone(),
                    entry.meta.effort.clone(),
                );
                let state = match acp.pump(&mut entry.meta, &mut self.queue)? {
                    Ok(true) => {
                        if acp.handshaken() && self.acp_loading.contains_key(&entry.meta.id) {
                            acp_settled.push((entry.meta.id.clone(), true));
                        }
                        changed |= before
                            != (
                                entry.meta.agent_session_id.clone(),
                                entry.meta.model.clone(),
                                entry.meta.effort.clone(),
                            );
                        continue;
                    }
                    Ok(false) => resumable(&entry.meta),
                    Err(reason) => {
                        eprintln!("session {}: {reason}", entry.meta.id);
                        // V2-4b: its card, from the handshake's own reason; a running session never gets one.
                        // Only before the handshake finished: a running session's later failure is no "no answer".
                        entry.meta.problem = entry
                            .meta
                            .acp_agent
                            .as_deref()
                            .filter(|_| !acp.handshaken())
                            .and_then(|name| {
                                crate::problems::acp_failed(&crate::acp::label_of(name), &reason)
                            });
                        SessionState::Failed
                    }
                };
                acp_settled.push((entry.meta.id.clone(), false));
                acp.stop();
                entry.acp = None;
                entry.meta.state = state;
                entry.meta.ended_at.get_or_insert(queue::now_ms());
                entry.meta.pid = None;
                close_queue(
                    &mut self.queue,
                    &entry.meta.id,
                    state == SessionState::Failed,
                );
                changed = true;
                continue;
            }
            let state = match entry.pty.as_mut().map(|p| (p.alive(), p.lost())) {
                Some((Ok(true), _)) => {
                    // Ticket 286: the agent quit and left its shell: what an exit did (below), without the exit.
                    if card_judged(entry, false) {
                        // Ticket 286 r5: a worker (a session another session started) leaves no shell; a session
                        // the user started keeps it. r6: a worker that failed keeps its shell and the why-it-ended
                        // card just raised (Close would clear it).
                        if entry.meta.parent.is_some() && entry.meta.problem.is_none() {
                            finished_workers.push(entry.meta.id.clone());
                        }
                        changed = true;
                        continue;
                    }
                    if !entry.agent_ended
                        && entry.meta.kind != AgentKind::Shell
                        && let Some(code) = read_marker(&ended_marker(&self.home, &entry.meta.id))
                        // Whole lines only: the wrapper's `echo` truncates before it writes.
                        && code.ends_with('\n')
                    {
                        entry.agent_ended = true;
                        // An answered marker ("seen") is an end an earlier core saw: its time is not now.
                        if !code.starts_with("seen ") {
                            entry.meta.ended_at.get_or_insert(queue::now_ms());
                        }
                        let marker = ended_marker(&self.home, &entry.meta.id);
                        let code = code.trim().trim_start_matches("seen ").to_string();
                        // The wrapper's go-ahead: from here every agent path refuses this session (`agent_live`).
                        if let Err(e) = answer_marker(&marker, &code) {
                            eprintln!("session {}: agent end not answered: {e}", entry.meta.id);
                        }
                        // Queued sends and a pending Enter are canceled by the next delivery pass.
                        close_queue(&mut self.queue, &entry.meta.id, false);
                        // A core restarted since keeps the card the first read raised (the screen is the shell's now).
                        // Ticket 488: else the card waits for the agent's last output (`card_judged`), never here.
                        if entry.meta.problem.is_none() && entry.pty.is_some() {
                            entry.card_due = Some((
                                std::time::Instant::now() + ENDED_MARK_WAIT,
                                code.parse().ok(),
                            ));
                        } else if entry.meta.parent.is_some() && entry.meta.problem.is_none() {
                            finished_workers.push(entry.meta.id.clone()); // as `card_judged` below, with no card to wait for
                        }
                        changed = true;
                    }
                    continue;
                }
                // V2-1b: a holder that died took its agent: resumable from the transcript, never running.
                Some((Ok(false), true)) => resumable(&entry.meta),
                Some((Ok(false), false)) => SessionState::Exited,
                status => {
                    eprintln!("session {} wait failed: {:?}", entry.meta.id, status);
                    SessionState::Failed
                }
            };
            // Ticket 488: the shell quit before the agent's card was judged: judged now, as the agent's. Ticket 512: a
            // worker it leaves without a card is finished, as when the card is judged while its shell runs (above).
            if card_judged(entry, true)
                && entry.meta.parent.is_some()
                && entry.meta.problem.is_none()
            {
                finished_workers.push(entry.meta.id.clone());
                changed = true;
                continue;
            }
            // v1a-40: the replay is saved after the registry lock is released (`drain_scrollback`).
            if let Some(pty) = &entry.pty {
                let bytes = pty.snapshot();
                // V2-5b: why it ended, read only now that it has (a running session never gets a card from its screen).
                // Ticket 286: after the agent's shell quits, the card is the agent's, raised when it ended.
                if !entry.agent_ended {
                    entry.meta.problem = crate::problems::ended(
                        entry.meta.kind,
                        &bytes,
                        pty.exit_code(),
                        state == SessionState::Failed || pty.lost(),
                    );
                }
                saves.push((entry.meta.id.clone(), bytes));
            }
            entry.meta.state = state;
            entry.meta.ended_at.get_or_insert(queue::now_ms());
            entry.meta.pid = None;
            close_queue(
                &mut self.queue,
                &entry.meta.id,
                state == SessionState::Failed,
            );
            changed = true;
        }
        for (id, bytes) in saves {
            self.queue_save(id, bytes);
        }
        // Ticket 1130 round 3: the rows a resumed ACP session continues leave only now, once its load succeeded (as
        // `spawn_acp` dropped them at once before); a session that ended before that leaves them where they are.
        for (id, loaded) in acp_settled {
            if let Some(prior) = self.acp_loading.remove(&id)
                && loaded
            {
                for old in prior {
                    self.entries.remove(&old);
                }
                changed = true;
            }
        }
        for id in finished_workers {
            if let Err(e) = self.close_unsaved(&id, true) {
                eprintln!("session {id}: finished worker not closed: {e}");
            }
        }
        let ended: Vec<_> = self
            .entries
            .values()
            .filter(|e| {
                e.meta.side_chat
                    && e.meta.state != SessionState::Closed
                    && e.meta.side_parent.as_ref().is_some_and(|parent| {
                        !self.entries.get(parent).is_some_and(Entry::agent_live) // ticket 286: a side chat ends with its parent's agent
                    })
            })
            .map(|e| e.meta.id.clone())
            .collect();
        for id in ended {
            // Q9 psn-J4-1: a close that fails is logged, as a finished worker's: it never fails every request.
            if let Err(e) = self.close_unsaved(&id, true) {
                eprintln!("session {id}: side chat not closed: {e}");
            }
            changed = true;
        }
        if changed {
            self.unsaved
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }
    /// v1a-74: `None` from `Settings::history` writes nothing; nor does a `no_history` session (a sign-in tab).
    fn queue_save(&mut self, id: String, bytes: Vec<u8>) {
        if self.entries.get(&id).is_some_and(|e| e.meta.no_history) {
            return;
        }
        if let Some(mask) = self.settings.history() {
            self.queue_write(id, Write::Save { bytes, mask });
        }
    }
    /// A newer write of an id replaces its queued one.
    fn queue_write(&mut self, id: String, write: Write) {
        self.writes.queued.retain(|(other, _)| *other != id);
        self.writes.queued.push((id, write));
    }
    /// The id's file goes (Close, a replaced row): no queued write of it runs, and one being written is removed
    /// again once written.
    fn forget_write(&mut self, id: &str) {
        self.writes.queued.retain(|(other, _)| other != id);
        if self.writes.writing.contains(id) {
            self.writes.dropped.insert(id.to_string());
        }
    }
    pub(crate) fn scrollback_pending(&self) -> bool {
        !self.writes.queued.is_empty()
    }
    /// V1A-74 follow-up: does the queued scrollback writes (`logs::mask`, fsync) with the registry lock released.
    /// The caller holds no lock; the server calls it from the tick (on its own thread) and before the Stop reply.
    pub(crate) fn drain_scrollback(registry: &std::sync::Mutex<Sessions>) {
        let _one = DRAINING.lock().unwrap_or_else(|e| e.into_inner());
        let (home, batch) = {
            let Ok(mut sessions) = registry.lock() else {
                return;
            };
            let batch = std::mem::take(&mut sessions.writes.queued);
            let ids = batch.iter().map(|(id, _)| id.clone());
            sessions.writes.writing.extend(ids);
            (sessions.home.clone(), batch)
        };
        if batch.is_empty() {
            return;
        }
        write_scrollback(&home, &batch, std::thread::Builder::new);
        let Ok(mut sessions) = registry.lock() else {
            return;
        };
        for (id, _) in &batch {
            sessions.writes.writing.remove(id);
            if sessions.writes.dropped.remove(id)
                && let Err(e) = crate::scrollback::remove(&home, id)
            {
                eprintln!("scrollback remove {id}: {e}");
            }
        }
    }
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
                let reply = self.send("user", &id, text.clone(), vec![], true)?;
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
                if !report {
                    self.submitted.remove(&id); // the box holds the user's own words from here
                    self.left_typed.remove(&id); // ticket 1085: so nothing in it is cleared as the core's own
                }
                let uncertain = !report && self.entry(&id)?.meta.kind == AgentKind::Claude;
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
                if text.ends_with('\r') && self.entry(&id)?.meta.kind == AgentKind::Claude {
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
                let uncertain = self.entry(&id)?.meta.kind == AgentKind::Claude;
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
                if data.ends_with(b"\r") && self.entry(&id)?.meta.kind == AgentKind::Claude {
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
                    self.entry(&id)?.observer.before_box = false;
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
    // v1b-11
    /// For a diff request: the session's folder and start commit, so the caller can drop the lock
    /// before `diff::run` (all `git` work). `None` for any other request.
    pub(crate) fn diff_root(
        &self,
        request: &Request,
    ) -> Option<Result<(PathBuf, Option<crate::diff::Base>), String>> {
        let (Request::DiffList { session, .. } | Request::DiffFile { session, .. }) = request
        else {
            return None;
        };
        Some(
            self.entries
                .get(session)
                .map(|e| (e.meta.cwd.clone(), e.meta.start_commit.clone()))
                .ok_or_else(|| "session not found".into()),
        )
    }
    // v1b-05: the data home for an upload to a known session; the write runs after the lock is released.
    pub(crate) fn image_home(
        &self,
        request: &Request,
    ) -> Option<Result<std::path::PathBuf, String>> {
        let Request::ImagePut { session, .. } = request else {
            return None;
        };
        Some(if self.entries.contains_key(session) {
            Ok(self.home.clone())
        } else {
            Err("session not found".into())
        })
    }
    // v1b-08
    /// For a files request: its root, resolved here so the caller can drop the registry lock and run
    /// `files::run` (all file and `git` work) outside it. A session id names its folder or worktree;
    /// `data` names Nunchiro's data folder. `None` for any other request.
    pub(crate) fn file_root(&self, request: &Request) -> Option<Result<files::Root, String>> {
        let (Request::FilesList { root, .. }
        | Request::FileRead { root, .. }
        | Request::FileWrite { root, .. }
        | Request::FilesSearch { root, .. }) = request
        else {
            return None;
        };
        Some(if root == "data" {
            Ok(files::Root::Data(self.home.clone()))
        } else {
            self.entries
                .get(root)
                .map(|e| files::Root::Folder(e.meta.cwd.clone()))
                .ok_or_else(|| "session not found".into())
        })
    }
    // v1a-09: edits the file as it is now (not the copy read at start), changes only the patched keys and keeps
    // any other key, then writes atomically; the running core follows only after the write succeeded.
    pub(crate) fn quit_settings(&mut self, patch: LifetimePatch) -> Response {
        let override_dir = self.home.join("skills/orchestration");
        let reply = |s: &Settings| {
            Ok(Reply::QuitSettings {
                settings: LifetimeSettings {
                    lifetime: s.session_lifetime,
                    start_at_login: s.start_at_login,
                    disable_hook_injection: s.disable_hook_injection,
                    keep_history: s.history().is_some(),
                    mask_history: s.mask_history,
                    auto_clean_worktrees: s.auto_clean_worktrees,
                    keep_awake: s.keep_awake,
                    script_widgets: s.script_widgets,
                    orchestration: s.orchestration,
                    orchestration_override: override_dir.clone(),
                    features: s.features.clone(),
                    worktrees_dir: s.worktrees_dir.clone(),
                    shell_env_error: crate::user_env::error(), // ticket 260
                    secret_env_names: crate::user_env::secret_names(), // ticket 1008
                },
            })
        };
        // The window's read on opening Settings: nothing to write.
        if patch.lifetime.is_none()
            && patch.start_at_login.is_none()
            && patch.disable_hook_injection.is_none()
            && patch.keep_history.is_none()
            && patch.mask_history.is_none()
            && patch.auto_clean_worktrees.is_none()
            && patch.keep_awake.is_none()
            && patch.script_widgets.is_none()
            && patch.orchestration.is_none()
            && patch.usage_allow_link.is_none()
            && patch.features.is_none()
            && patch.worktrees_dir.is_none()
        {
            return reply(&self.settings);
        }
        // Ticket 250: every feature key and value is checked before anything is written.
        for (k, v) in patch.features.iter().flatten() {
            if !feature_key(k) {
                return Err(format!(
                    "invalid feature key {k:?}: expected dotted lowercase, like terminal.scrollback_lines"
                ));
            }
            let size = serde_json::to_vec(v).map_err(|e| e.to_string())?.len();
            if size > FEATURE_VALUE_MAX {
                return Err(format!(
                    "feature {k} is {size} bytes; a value may be at most {FEATURE_VALUE_MAX} bytes"
                ));
            }
            // Ticket 992: a level's model and effort are what a session start would take.
            if k == crate::team::LEVELS_KEY && !v.is_null() {
                crate::team::check_levels(v, |kind, m, e| self.check_stored_model(kind, m, e))?;
            }
            if k == crate::team::WORKERS_KEY && !v.is_null() {
                crate::team::check_workers(v)?; // ticket 1055
            }
            if k == crate::home_lock::MODE_KEY {
                crate::home_lock::check(v)?; // ticket 1002 lane 1
            }
            // Ticket 456: an item that can run commands goes on only once the owner has read them.
            if k == crate::extensions::ENABLED_KEY {
                crate::extensions::check_enabled(
                    &crate::extensions::enabled(self.settings.feature(k)),
                    v,
                    patch.extensions_confirmed.as_deref().unwrap_or_default(),
                )?;
            }
            // Ticket 253: a shared path outside its project is refused here (and skipped at create).
            if k == crate::worktree_shared::FEATURE && !v.is_null() {
                crate::worktree_shared::check(v)?;
            }
        }
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let mut next = self.settings.clone();
        if let Some(v) = patch.lifetime {
            next.session_lifetime = v;
            file["session_lifetime"] = serde_json::to_value(v).map_err(|e| e.to_string())?;
        }
        if let Some(v) = patch.start_at_login {
            next.start_at_login = v;
            file["start_at_login"] = v.into();
        }
        if let Some(v) = patch.disable_hook_injection {
            next.disable_hook_injection = v;
            file["disable_hook_injection"] = v.into();
        }
        // v1a-74
        if let Some(v) = patch.keep_history {
            next.keep_history = Some(v);
            file["keep_history"] = v.into();
        }
        if let Some(v) = patch.mask_history {
            next.mask_history = v;
            file["mask_history"] = v.into();
        }
        if let Some(v) = patch.auto_clean_worktrees {
            next.auto_clean_worktrees = v;
            file["auto_clean_worktrees"] = v.into();
        }
        if let Some(v) = patch.keep_awake {
            next.keep_awake = v;
            file["keep_awake"] = v.into();
        }
        if let Some(v) = patch.script_widgets {
            next.script_widgets = v;
            file["script_widgets"] = v.into();
        }
        // v25f: "" clears to the default; anything else passes the folder rule first (a refusal writes nothing).
        if let Some(d) = patch.worktrees_dir.as_deref().map(str::trim) {
            if !d.is_empty() {
                check_worktrees_dir(Path::new(d))?;
            }
            // Older records (no root of their own) are stamped with the root of now first, so they still list after.
            if Some(Path::new(d)) != self.settings.worktrees_dir.as_deref() {
                WorktreePlan::owner(&self.home, &self.worktree_root(), "stamp", None)
                    .run_waiting(false)?;
            }
            if d.is_empty() {
                next.worktrees_dir = None;
                if let Some(m) = file.as_object_mut() {
                    m.remove("worktrees_dir");
                }
            } else {
                next.worktrees_dir = Some(d.into());
                file["worktrees_dir"] = d.into();
            }
        }
        // Ticket 211: one canonical folder, once.
        if let Some(p) = patch.usage_allow_link {
            let root = crate::usage::allow_root(&p)?;
            if !next.usage_link_roots.contains(&root) {
                next.usage_link_roots.push(root);
            }
            file["usage_link_roots"] =
                serde_json::to_value(&next.usage_link_roots).map_err(|e| e.to_string())?;
        }
        if let Some(p) = patch.orchestration {
            if p.create_override == Some(true) {
                fs::create_dir_all(&override_dir)
                    .map_err(|e| format!("{}: {e}", override_dir.display()))?;
            }
            let o = &mut next.orchestration;
            o.enabled = p.enabled.unwrap_or(o.enabled);
            file["orchestration"] = serde_json::to_value(*o).map_err(|e| e.to_string())?;
        }
        // Ticket 250: `null` removes the key; the file's other feature keys stay as they are.
        if let Some(patch) = patch.features {
            let mut stored = match file.get("features") {
                Some(serde_json::Value::Object(m)) => m.clone(),
                _ => serde_json::Map::new(),
            };
            // V2.5-77: refuse a patch that grows the map past the cap; an over-cap file may still shrink or rewrite.
            let after = patch.iter().fold(stored.len(), |n, (k, v)| {
                match (v.is_null(), stored.contains_key(k)) {
                    (true, true) => n - 1,
                    (false, false) => n + 1,
                    _ => n,
                }
            });
            if after > FEATURE_KEYS_MAX && after > stored.len() {
                return Err(format!(
                    "this patch would leave {after} feature keys; settings.json may hold at most {FEATURE_KEYS_MAX}"
                ));
            }
            for (k, v) in patch {
                if v.is_null() {
                    stored.remove(&k);
                    next.features.remove(&k);
                } else {
                    stored.insert(k.clone(), v.clone());
                    next.features.insert(k, v);
                }
            }
            file["features"] = serde_json::Value::Object(stored);
        }
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
        let masked = self.settings.history() == Some(true);
        self.settings = next;
        // v1a-74: off takes effect once stored: every file under scrollback/ goes, never through a link.
        if self.settings.history().is_none() {
            self.writes.queued.clear();
            let writing = self.writes.writing.iter().cloned();
            self.writes.dropped.extend(writing);
            crate::scrollback::sweep(&self.home, |_| false);
        }
        // V1A-74 follow-up: masking turned on masks what is already saved. A live PTY's file is written masked at its
        // own next save; every other file (an ended row, a set-aside row) is masked in place by the next drain.
        if !masked && self.settings.history() == Some(true) {
            for (_, write) in &mut self.writes.queued {
                if let Write::Save { mask, .. } = write {
                    *mask = true;
                }
            }
            // A save being written now lands after this; its id is masked again once it has (drains run in order).
            let writing = self.writes.writing.iter().cloned().collect::<Vec<_>>();
            match crate::scrollback::saved_ids(&self.home) {
                Ok(saved) => {
                    // A duplicate is skipped below: its first Remask is queued by then.
                    let ids = saved.into_iter().chain(writing);
                    for id in ids {
                        // An exited PTY stays on its row; only a running one saves again.
                        let live = self.entries.get(&id).is_some_and(|e| {
                            e.pty.is_some() && e.meta.state == SessionState::Running
                        });
                        if !live && !self.writes.queued.iter().any(|(other, _)| *other == id) {
                            self.writes.queued.push((id, Write::Remask));
                        }
                    }
                }
                Err(e) => eprintln!("scrollback mask: {e}"),
            }
        }
        reply(&self.settings)
    }
    // v1a-23: the owner's approval; it also answers the waiting items that asked for this subject.
    fn approve(
        &mut self,
        subject: crate::approval::SubjectKind,
        name: &str,
        level: crate::approval::Level,
        hash: &str,
    ) -> Response {
        let view = match subject {
            crate::approval::SubjectKind::Widget => {
                crate::approval::grant(&self.home, name, level, hash)?
            }
            crate::approval::SubjectKind::Source => {
                crate::approval::grant_source(&self.home, name, level, hash)?
            }
            crate::approval::SubjectKind::Agent => {
                return Err("an agent is approved on its own sheet".into()); // V2-4a
            }
            crate::approval::SubjectKind::AgentCommand => {
                return Err("an agent command is approved on its own form".into()); // ticket 358
            }
            crate::approval::SubjectKind::Setup => {
                return Err("a setup script is approved on its own sheet".into()); // ticket 259
            }
        };
        self.queue.answer_owner(|i| {
            matches!(&i.owner, Some(queue::OwnerAsk::Approval { subject: s, name: n, .. }) if *s == subject && n == name)
        })?;
        Ok(Reply::ApprovalStatus { view })
    }
    /// v2-8c: the live PR settings, written like `quit_settings`; all `None` is a read. `watch` adds or removes one
    /// pin (validated by the caller).
    pub fn pr_live(
        &mut self,
        on: Option<bool>,
        offered: Option<bool>,
        watch: Option<(String, bool)>,
    ) -> Result<(bool, bool, Vec<String>), String> {
        let read = |s: &Settings| (s.live_pr_status, s.live_pr_offered, s.pr_watch.clone());
        if on.is_none() && offered.is_none() && watch.is_none() {
            return Ok(read(&self.settings));
        }
        let mut next = self.settings.clone();
        if let Some(v) = on {
            next.live_pr_status = v;
        }
        if let Some(v) = offered {
            next.live_pr_offered = v;
        }
        if let Some((url, add)) = watch {
            next.pr_watch.retain(|u| *u != url);
            if add {
                if next.pr_watch.len() >= crate::pr_live::MAX_PINNED {
                    return Err("too many watched pull requests".into());
                }
                next.pr_watch.push(url);
            }
        }
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        file["live_pr_status"] = next.live_pr_status.into();
        file["live_pr_offered"] = next.live_pr_offered.into();
        file["pr_watch"] = next.pr_watch.clone().into();
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
        self.settings = next;
        Ok(read(&self.settings))
    }
    // v1a-23: the verified-yes option for one canonical project, written like `quit_settings` (the file as it is
    // now, other keys kept, atomic); the running core follows only after the write succeeded.
    fn permission_answers(&mut self, project: &Path, on: bool) -> Response {
        let project = fs::canonicalize(project).map_err(|e| e.to_string())?;
        let key = project.to_str().ok_or("project path is not UTF-8")?;
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        if !file["permission_answers"].is_object() {
            file["permission_answers"] = serde_json::json!({});
        }
        file["permission_answers"][key] = on.into();
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        store::write_capped(&path, &bytes, store::SETTINGS_READ_MAX)?;
        self.settings.permission_answers.insert(project.clone(), on);
        if on {
            self.queue.answer_owner(|i| {
                i.owner
                    == Some(queue::OwnerAsk::PermissionAnswers {
                        project: project.clone(),
                    })
            })?;
        }
        Ok(Reply::PermissionAnswers { project, on })
    }
    // v1b-19
    pub(crate) fn script_widgets(&self) -> bool {
        self.settings.script_widgets
    }
    // v1b-22
    pub(crate) fn web_widgets(&self) -> bool {
        self.settings.web_widgets
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
    /// S9: `flush_delivery` without its own reads: this tick reads once before delivering and again only when a send
    /// was written, waits for its Enter or was canceled. An idle tick read the same state twice (twice the holder
    /// `alive` round trips and board reads, every 50 ms). Changes are left `unsaved` for the tick's one save.
    fn delivery_pass(&mut self) -> Result<(), String> {
        self.refresh_unsaved()?;
        self.observe()?;
        if self.deliver()? {
            self.refresh_unsaved()?;
            self.observe()?;
        }
        Ok(())
    }
    /// Ticket 573 slice 2: the state changes since the last tick, into the event log.
    fn observe_events(&mut self) {
        let rows = self
            .entries
            .values()
            // A closed row stays listed (its view, its Undo); for the log it has ended.
            .filter(|e| e.meta.state != SessionState::Closed)
            .map(|e| {
                let live = e.meta.state == SessionState::Running && !e.agent_ended;
                let asks = if live {
                    self.queue.items_of(&e.meta.id)
                } else {
                    vec![]
                };
                crate::events::Row {
                    id: e.meta.id.clone(),
                    project: e.meta.project.clone(),
                    label: e.meta.label.clone(),
                    state: crate::events::state(
                        e.meta.state,
                        e.agent_ended,
                        live && self.queue.attention(&e.meta.id).working,
                        asks.iter().map(|i| &i.kind),
                    ),
                }
            })
            .collect();
        // Ticket 993: a schedule's last result follows its session, only on a change of that session's state.
        for (id, before, state) in self.events.observe(rows) {
            if !self.schedules.follow(&id, before, state) {
                continue;
            }
            // Look 11-17 v8 (Home S2-B): a run that failed after its start is a failed run too: the same card.
            for e in self.schedules.list().unwrap_or_default() {
                if let Some(last) = &e.last
                    && last.session.as_deref() == Some(id.as_str())
                    && last.result == Some(crate::schedule::Outcome::Failed)
                {
                    self.failed_run_card(&e.id, last.reason.as_deref().unwrap_or_default());
                }
            }
            self.schedules_changed();
        }
    }
    fn observe(&mut self) -> Result<(), String> {
        /// The session's artifact folder as Claude was given it, when it holds nothing Claude would load from it
        /// (settings, skills, memory files, a repository): an agent can write there, so a folder that holds one of
        /// these is the user's to judge.
        fn own_artifacts(home: &Path, meta: &crate::api::Session) -> Option<PathBuf> {
            let id = meta.artifacts.as_deref().unwrap_or(&meta.id);
            unloaded(fs::canonicalize(home.join("artifacts").join(id)).ok()?)
        }
        /// Look 11-17 C7: the Home folder the core made for Home teammates, when the session runs in it and it holds
        /// nothing Claude would load: Claude's folder-trust question about it is the core's to answer.
        fn own_home(home: &Path, meta: &crate::api::Session) -> Option<PathBuf> {
            let folder = crate::team::Team::open(home).home();
            (fs::canonicalize(&meta.cwd).ok()? == folder)
                .then_some(folder)
                .and_then(unloaded)
        }
        fn unloaded(folder: PathBuf) -> Option<PathBuf> {
            [
                ".claude",
                ".git",
                ".mcp.json",
                "CLAUDE.md",
                "CLAUDE.local.md",
            ]
            .iter()
            .all(|name| fs::symlink_metadata(folder.join(name)).is_err())
            .then_some(folder)
        }
        // v1b-15. S9 r3: observed by the `refresh` that every call of this one follows, not twice in a row (the board
        // key alone is two stats and a hash of every row); a row this pass moves is observed at the next refresh.
        let now = queue::now_ms();
        let mut ran_changed = false;
        for (id, entry) in &mut self.entries {
            if entry.meta.state != SessionState::Running {
                continue;
            }
            let mut press: Option<&'static [u8]> = None;
            // v1a-19: at most OBSERVE_BYTES per pass.
            if let Some(pty) = &entry.pty
                && let Reply::Output {
                    data,
                    start,
                    end,
                    truncated,
                } = pty.read_at_most(entry.observer.output_offset, OBSERVE_BYTES)?
            {
                entry.observer.behind = start + (data.len() as u64) < end; // v1a-19 r2
                // w10 item 12: a start question the core answers is read again with no new output.
                if data.is_empty() && !std::mem::take(&mut entry.observer.recheck) {
                    continue;
                }
                if truncated {
                    entry.observer.screen.reset();
                }
                entry.observer.screen.feed(&data);
                // Ticket 286: a shell left after its agent quit is fed for the screen gates only: no activity, no
                // decisions read from what the shell prints.
                if entry.agent_ended {
                    entry.observer.output_offset = start + data.len() as u64;
                    continue;
                }
                // Built once for `detect_in` and the limit mark; a shell session has neither reader.
                let text = if entry.meta.kind == AgentKind::Shell {
                    String::new()
                } else {
                    entry.observer.screen.text()
                };
                // Output is activity; a re-read of a still screen is not (the re-read of a working session waits for
                // a still second, and a turn that draws nothing still goes stale).
                if !data.is_empty() {
                    self.queue.activity(id, now)?;
                }
                // Claude 2.1.326 asks about each `--add-dir` folder at start, the cursor on "No, exit". The one folder
                // the core adds is the session's own artifact folder: the core made it, and for exactly that folder,
                // while it holds nothing Claude would load, the core answers yes itself (Down, then Enter once the
                // screen shows the cursor on Yes). Only during the start, once, and on a screen that is current: after
                // Claude's input box showed, the screen can hold an agent's own words. Any other such question stays a
                // dialog for the user.
                let at = std::time::Instant::now();
                if waiting::screen::past_start(&text) {
                    entry.observer.own_folder = None;
                    entry.observer.before_box = false;
                }
                // w25-m: a question cut off by a short window takes only "No": no key, a card at once (`detect_in`).
                let starting = entry.observer.own_folder.is_some()
                    && !entry.observer.behind
                    && !waiting::screen::cut_off(&text);
                let trusting = starting
                    && text.contains("Accessing workspace:")
                    && !text.contains("Adding a new directory");
                let adding = starting && text.contains("Adding a new directory") || trusting;
                let folder = if trusting {
                    own_home(&self.home, &entry.meta)
                } else {
                    adding
                        .then(|| own_artifacts(&self.home, &entry.meta))
                        .flatten()
                };
                let own = folder.as_ref().and_then(|folder| {
                    if trusting {
                        waiting::screen::trust_question(&text, folder)
                    } else {
                        waiting::screen::add_dir_question(&text, folder)
                    }
                });
                // The question while it is still being drawn, or about the session's own folder: no card and no
                // "blocked (question)" line to the lead. Each new seat showed the question for a moment, and the
                // lead spent a turn on every one of those lines (real run 11-17). A question that names another
                // folder is a dialog as before.
                let mine = adding
                    && folder.as_ref().is_some_and(|folder| {
                        if trusting {
                            waiting::screen::trust_folder(&text)
                        } else {
                            waiting::screen::add_dir_folder(&text)
                        }
                        .is_none_or(|shown| shown == folder.to_string_lossy())
                    });
                // v1a-10: Claude's own model picker, opened by a switch, is not a decision to queue.
                let mut asking = false;
                // w10 item 12: a question the core could not answer in `OWN_GIVE_UP` (a key Claude did not take, rows it
                // cannot read) is the user's: no more keys, and it shows as a card, never an idle row.
                // Look 11-17 v5 item 10: the clock runs only while a question about the session's own folder is on the
                // screen. The user's own folder-trust question can wait for minutes; the artifact folder's question
                // after it is still the core's.
                let own = if own.is_some() || mine {
                    let since = *entry.observer.own_folder_since.get_or_insert(at);
                    if at.duration_since(since) > waiting::OWN_GIVE_UP {
                        entry.observer.own_folder = None;
                        entry.observer.own_folder_key = None;
                        entry.observer.own_folder_since = None;
                        None
                    } else {
                        own
                    }
                } else {
                    entry.observer.own_folder_since = None;
                    own
                };
                let mine = mine && entry.observer.own_folder.is_some();
                // Look 11-17 v5 item 1 (rule a): while a model switch runs only its own picker is hidden; any other
                // question on the screen (a start question the switch is waiting behind) is a card.
                let picker =
                    entry.switch.is_some() && text.lines().any(|l| l.trim() == "Select model");
                if let Some(on_yes) = own {
                    // Enter only after the core's own Down: a mark the screen model kept from the dialog before
                    // (the folder-trust question, answered on its Yes row) read as "the cursor is on Yes" while
                    // Claude's cursor was on "No, exit", and the Enter ended Claude (real run 11-17, one lead of five).
                    if on_yes && entry.observer.own_folder_key.is_some() {
                        press = Some(b"\r");
                        // The trust question comes first; the artifact folder's question may follow it.
                        if !trusting {
                            entry.observer.own_folder = None;
                        }
                        entry.observer.own_folder_key = None;
                        entry.observer.own_folder_since = None;
                    } else if on_yes {
                        // Not the core's doing: no key. It shows as a dialog once the start window has passed.
                    } else if entry
                        .observer
                        .own_folder_key
                        // 3 s, not 1: Down is a relative key. A second Down sent while Claude's redraw of the first
                        // is only late moves the cursor back to "No, exit", and the Enter that follows ends Claude.
                        .is_none_or(|t| at.duration_since(t) > std::time::Duration::from_secs(3))
                    {
                        press = Some(b"\x1b[B");
                        entry.observer.own_folder_key = Some(at);
                    }
                    self.queue.clear_screen(id)?;
                } else if mine || picker {
                    self.queue.clear_screen(id)?;
                } else if let Some(item) = entry.observer.screen.detect_in(entry.meta.kind, &text) {
                    asking = true;
                    self.queue
                        .screen(id, item.kind, item.text, item.choices, now)?;
                } else if entry.observer.unredrawn.is_some()
                    && (!entry.observer.screen.drawn() || entry.observer.screen.blank())
                {
                    // A screen a resize blanked and nothing has drawn on since says nothing about the question: the
                    // card stays until the agent redraws or `restore_undrawn` gives the screen back. Lane w96: so does
                    // a redraw read between its clear and its text (two writes; the card went and came back re-keyed).
                } else if entry.observer.before_box
                    && waiting::screen::start_question_left(&text)
                    && entry
                        .observer
                        .quiet_since
                        .is_none_or(|t| t.elapsed() < waiting::startup_quiet())
                {
                    // w25-s: a start question still on the screen that the core cannot read (rows a narrow window
                    // split) has not been answered: its card stays. A screen without it clears the card as before;
                    // `starting`'s quiet valve ends this too, so a box the core misses cannot hold the first message.
                } else {
                    self.queue.clear_screen(id)?;
                }
                // Look 11-17 v3 P1: a question on the screen restarts the quiet time that ends a start.
                asking |= own.is_some() || mine;
                entry.observer.silent_since = None; // it drew: the quiet time rules from here
                if asking {
                    entry.observer.quiet_since = None;
                } else if entry.observer.quiet_since.is_none() {
                    entry.observer.quiet_since = Some(at);
                }
                if entry.observer.interrupted.is_some_and(|until| at >= until) {
                    entry.observer.interrupted = None;
                }
                if entry.observer.interrupted.is_none()
                    || entry.observer.behind
                    || !interrupted_at_prompt(&text)
                {
                    entry.observer.at_box = None;
                } else if at.duration_since(*entry.observer.at_box.get_or_insert(at))
                    >= std::time::Duration::from_millis(REREAD_STILL_MS)
                {
                    entry.observer.interrupted = None;
                    entry.observer.at_box = None;
                    self.queue
                        .observe(id, "Interrupted", &serde_json::json!({}), "screen", now)?;
                }
                // W35: ultracode as Claude last answered `/effort ultracode` (claude_modes.rs).
                ran_changed |= entry.meta.kind == AgentKind::Claude
                    && claude_modes::ultracode_read(&mut entry.meta.modes, &text);
                // Ticket 1010: fast mode's pause and refusal as Claude's footer says them.
                ran_changed |= entry.meta.kind == AgentKind::Claude
                    && claude_modes::fast_read(
                        &mut entry.meta.modes,
                        &mut entry.observer.fast_notice,
                        &text,
                        now as i64 / 1000,
                    );
                // Look 11-17 N2: the mode the session runs in, kept for a resume.
                if let Some(mode) = permission_mode(&text, entry.meta.kind) {
                    entry.observer.footer_seen = true;
                    if entry.meta.ran_mode.as_ref() != Some(&mode) {
                        entry.meta.ran_mode = Some(mode);
                        ran_changed = true;
                    }
                }
                // Ticket 1100: the canary watches the first session on a new agent version (flags only).
                if let Some(version) = entry.meta.agent_version.as_deref()
                    && crate::agent_canary::watching(&self.home, entry.meta.kind, Some(version))
                    && crate::agent_canary::observed(
                        &self.home,
                        entry.meta.kind,
                        version,
                        id,
                        crate::agent_canary::Pass {
                            box_read: composer(&text, entry.meta.kind).is_some(),
                            footer_read: entry.observer.footer_seen,
                            dialog: asking,
                        },
                    )
                {
                    crate::agent_canary::fresh_start(&self.home, entry.meta.kind, version);
                }
                // V2-2c: the limit mark reads the same screen and writes only its in-memory mark.
                crate::usage::observe_limit(
                    &self.home,
                    id,
                    entry.meta.kind,
                    entry.meta.config_dir.as_deref(),
                    &text,
                    now as i64 / 1000,
                    &crate::usage::local_offset,
                );
                entry.observer.output_offset = start + data.len() as u64; // v1a-19
            }
            if let (Some(keys), Some(pty)) = (press, entry.pty.as_mut())
                && let Err(e) = pty.write(keys)
            {
                eprintln!("session {id}: the artifact folder question was not answered: {e}");
            }
        }
        if ran_changed {
            self.save()?;
        }
        self.settle_walks(); // CHAT-MODELIST r3
        let live = self
            .entries
            .iter()
            .filter(|(_, e)| e.agent_live())
            .map(|(id, _)| id.clone())
            .collect();
        self.queue.tick(
            now,
            self.settings
                .stale_after_ms
                .unwrap_or(queue::DEFAULT_STALE_MS),
            &live,
        )
    }
    pub(crate) fn transcript_jobs(&mut self) -> Vec<waiting::TranscriptJob> {
        let now = std::time::Instant::now();
        self.entries
            .values_mut()
            .filter_map(|entry| {
                if !entry.agent_live()
                    || entry.meta.kind == AgentKind::Shell
                    || (entry.observer.transcript.is_none() && !entry.observer.search_due(now))
                {
                    return None;
                }
                let (key, offset) = self.queue.transcript_cursor(&entry.meta.id);
                // S9 r3: a followed transcript read to its end, same file, same size: nothing to read, so no job (a
                // row clone, an open and a read per live session every 50 ms). `read_batch` keys a file the same way.
                if let Some(path) = &entry.observer.transcript
                    && let Ok(m) = fs::symlink_metadata(path)
                {
                    use std::os::unix::fs::MetadataExt;
                    if m.len() == offset
                        && key == format!("{}:{}:{}", path.display(), m.dev(), m.ino())
                    {
                        return None;
                    }
                }
                Some(waiting::TranscriptJob {
                    session: entry.meta.clone(),
                    path: entry.observer.transcript.clone(),
                    key,
                    offset,
                    discarding: self.queue.transcript_discarding(&entry.meta.id),
                })
            })
            .collect()
    }
    pub(crate) fn apply_transcript(
        &mut self,
        job: waiting::TranscriptJob,
        path: Option<PathBuf>,
        result: Result<Option<waiting::transcript::Batch>, String>,
    ) -> Result<(), String> {
        // v1b-15
        self.observe_board();
        let Some(entry) = self.entries.get_mut(&job.session.id) else {
            return Ok(());
        };
        // A close/resume, new hook path or newer cursor invalidates this read plan.
        if !entry.agent_live()
            || entry.meta.agent_session_id != job.session.agent_session_id
            || entry.observer.transcript != job.path
            || self.queue.transcript_cursor(&entry.meta.id) != (job.key, job.offset)
            || self.queue.transcript_discarding(&entry.meta.id) != job.discarding
        {
            return Ok(());
        }
        entry.observer.transcript = path;
        match result {
            Ok(Some(batch)) => {
                // Look 11-17 N6: Codex sends no prompt hook, so an unnamed Codex session takes its title from its
                // transcript's first own message (after Codex's context blocks), as a Claude one does from its hook.
                // Named, it keeps that name across a resume instead of a window number ("New Codex session 2").
                // Ticket 1042: Claude Code titles a session itself (its small fast model, after the first prompt) and
                // writes an `ai-title` record to the transcript; read here, it costs no call. It replaces the
                // first-message name but never a hand-set one, and without it (no such record) that name stays.
                let title = match entry.meta.kind {
                    AgentKind::Codex if entry.meta.label.is_empty() => codex_title(&batch.records),
                    AgentKind::Claude if entry.meta.label.is_empty() || entry.meta.auto_label => {
                        claude_ai_title(&batch.records).filter(|t| *t != entry.meta.label)
                    }
                    _ => None,
                };
                if !entry.meta.side_chat
                    && let Some(title) = title
                {
                    entry.meta.label = title;
                    entry.meta.auto_label = true; // ticket 1017
                    self.title_names_branch(&job.session.id);
                    self.save()?;
                }
                let entry = self
                    .entries
                    .get_mut(&job.session.id)
                    .ok_or("session not found")?;
                self.queue
                    .transcript_batch(&entry.meta.id, batch, queue::now_ms())?;
                self.queue.observer_error(&entry.meta.id, None)?;
            }
            Ok(None) => {}
            Err(error) => self.queue.observer_error(&entry.meta.id, Some(error))?,
        }
        Ok(())
    }
    fn answer(&mut self, id: &str, answer: queue::Answer, confirmed: bool) -> Response {
        /// The deny message Claude reads while its turn stops; the user's own words follow as their next message.
        const DENY_NOTE_FOLLOWS: &str = "The user denied this. Do not retry it; their instruction follows as their next message.";
        /// Look v34 S3-4: a deny with no instruction yet (the card above the composer) stops the turn the same way.
        const DENY_WAIT: &str =
            "The user denied this. Do not retry it; wait for their next message.";
        // V2-8e: a deny with an instruction is a deny; the instruction goes as the hook's message, else as the user's next
        // message once the agent is back at its prompt (the delivery queue waits for that). Empty text sends none.
        let (answer, note) = match answer {
            // Look v10 N10-S2-2: an owner item (a merge card's "Not yet" with a reason) takes the text itself; split
            // here, it was looked up among the agents' items, never found ("not there anymore").
            queue::Answer::DenyWith { text } if self.queue.owner_decision(id).is_none() => {
                (queue::Answer::Deny, Some(queue::deny_note(&text)))
            }
            other => (other, None),
        };
        // Look v34 S3-4: an empty instruction still stops a hooked Claude's turn (as Claude Code's own "No, and tell
        // Claude what to do differently"), so what the owner types next in the composer reaches it at once.
        if note.as_deref() == Some("")
            && let Ok(item) = self.queue.decision(id)
            && item.kind == queue::Kind::Permission
            && self.entry(&item.session_id)?.meta.kind == AgentKind::Claude
        {
            let now = queue::now_ms();
            if self.queue.hook_live(&item, now) {
                self.answer_inner(id, answer, confirmed, Some(DENY_WAIT), true, now)?;
                self.interrupted(&item.session_id)?;
                return Ok(Reply::Ack);
            }
        }
        if let Some(note) = note.filter(|n| !n.is_empty()) {
            // Typed at the agent's prompt, a leading `/` or `!` would run a slash or shell command, and `#` would write
            // the agent's memory (CLAUDE.md, agent config).
            if note.starts_with(['/', '!', '#']) {
                return Err("an instruction cannot start with /, ! or #".into());
            }
            let item = self.queue.decision(id)?;
            if item.kind != queue::Kind::Permission {
                return Err("a deny instruction needs a permission request".into());
            }
            let session = item.session_id.clone();
            let now = queue::now_ms();
            let hooked = self.queue.hook_live(&item, now);
            // Look 11-17 B13: Claude reads a hook's deny message as tool output, not as the user ("That text is not
            // from you"), and runs the command again. So its hook denies and stops the turn, and the note goes in as the
            // user's own next message once Claude is back at its prompt. Another agent's hook takes the note as before.
            let claude = self.entry(&session)?.meta.kind == AgentKind::Claude;
            if hooked && claude {
                self.answer_inner(id, answer, confirmed, Some(DENY_NOTE_FOLLOWS), true, now)?;
                self.interrupted(&session)?;
            } else {
                self.answer_inner(id, answer, confirmed, Some(&note), false, now)?;
            }
            // A hook still waiting takes the note as its own message; nothing is left to send.
            if hooked && !claude {
                return Ok(Reply::Ack);
            }
            // Queued, never written now: the prompt may still be on screen, where typed text would pick its options.
            let send = self.begin_send("user", &session, note, vec![], true, "queued")?;
            self.deny_notes.insert(send.id.clone());
            return Ok(Reply::Delivery { send });
        }
        self.answer_inner(id, answer, confirmed, None, false, queue::now_ms())
    }
    /// V2-8e: an item as the window sees it (`Queue::annotate` with its session's folder); without a session it stays
    /// risky.
    fn annotated(&self, mut item: queue::Decision) -> queue::Decision {
        if let Some(entry) = self.entries.get(&item.session_id) {
            self.queue
                .annotate(&mut item, &entry.meta.cwd, entry.meta.home_lock);
        }
        item
    }
    fn answer_inner(
        &mut self,
        id: &str,
        answer: queue::Answer,
        confirmed: bool,
        note: Option<&str>,
        interrupt: bool,
        now: u64,
    ) -> Response {
        // v1a-23: an owner item. Only owner callers get here with one: session callers' `check_agent` looks the item
        // up with `queue.decision`, which never finds owner items.
        if let Some(item) = self.queue.owner_decision(id) {
            // Needs 225: an agent's Codex reset ask. Allow spends one off this lock (codex_reset::answered); both are logged.
            if let Some(ask @ queue::OwnerAsk::CodexReset { .. }) = &item.owner {
                let allow = match answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny => false,
                    _ => return Err("an owner item takes allow_once or deny".into()),
                };
                self.queue.answer_owner(|i| i.id == id)?;
                let title = self
                    .entries
                    .get(&item.session_id)
                    .map(|e| e.meta.label.clone());
                crate::codex_reset::answered(
                    &self.home,
                    ask,
                    &item.session_id,
                    title.as_deref(),
                    allow,
                );
                return Ok(Reply::Ack);
            }
            // Ticket 990 slice h: the merge card. The yes is recorded for the reviewed files only, and the lead
            // hears the answer in the room.
            if let Some(queue::OwnerAsk::Merge {
                task,
                title,
                place,
                revision,
                ..
            }) = &item.owner
            {
                let (yes, why) = match &answer {
                    queue::Answer::AllowOnce => (true, String::new()),
                    queue::Answer::Deny => (false, String::new()),
                    queue::Answer::DenyWith { text } => (false, queue::deny_note(text)),
                    _ => return Err("a merge card takes allow_once or deny".into()),
                };
                let ledger = crate::ledger::Ledger::open(&self.home);
                // The task closed while its card was open (its worktree was removed): the card goes, nothing is merged.
                if ledger
                    .list()?
                    .iter()
                    .any(|t| t.id == *task && t.closed.is_some())
                {
                    self.queue.answer_owner(|i| i.id == id)?;
                    crate::events::tasks(place);
                    return Err(format!("task {task} is closed; there is nothing to merge"));
                }
                // Q9 tt-J4-1: the yes is recorded before the card goes, so a failed write leaves Yes to press again.
                // Codex round 2: a no clears a yes an earlier failed attempt left, so a resumed lead never hears it.
                let recorded = if yes {
                    ledger.merge_ok(task, revision, now).map(|_| ())
                } else {
                    ledger.merge_no(task, now)
                };
                if let Err(e) = recorded {
                    let what = if yes { "yes" } else { "no" };
                    return Err(format!("the {what} was not recorded: {e}"));
                }
                if let Err(e) = self.queue.answer_owner(|i| i.id == id) {
                    // The card stays, so its yes goes too: a yes reaches the lead only with its card answered.
                    if yes && let Err(undo) = ledger.merge_no(task, now) {
                        eprintln!("merge yes for task {task} not taken back: {undo}");
                    }
                    return Err(e);
                }
                // Look 11-17 v5 item 8: answered, the task's cards leave the needs-decision column (a merge then
                // retires them to done).
                if let Some(t) = ledger.list()?.iter().find(|t| t.id == *task)
                    && let Err(e) = crate::board::park_task(&self.home, t, false)
                {
                    eprintln!("board: task {task} cards not moved back: {e}");
                }
                crate::events::tasks(place);
                let body = match (yes, why.is_empty()) {
                    (true, _) => merge_yes_line(task, title, revision),
                    (false, true) => {
                        format!("The user said not yet to merging task {task} ({title}).")
                    }
                    (false, false) => {
                        format!("The user said not yet to merging task {task} ({title}): \"{why}\"")
                    }
                };
                if let Some(lead) = ledger
                    .list()?
                    .iter()
                    .find(|t| t.id == *task)
                    .and_then(|t| t.lead.clone())
                {
                    self.team_note(
                        place,
                        &lead,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "merge_yes" } else { "merge_no" }.into(),
                            worktree: None,
                            name: Some(title.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 990 slice i: the role card. A yes adds the role to the user's roles; the lead hears the answer.
            if let Some(queue::OwnerAsk::Role { role, place, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a role card takes allow_once or deny".into()),
                };
                if yes {
                    crate::roles::Roles::open(&self.home).save(role.clone())?;
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let team = crate::team::Team::open(&self.home);
                if let Some(lead) = team.lead_of(team.place(place).as_deref()) {
                    let body = if yes {
                        format!(
                            "The user added the role {}: staff it with `nunchiro task staff <task> \"{}\"`.",
                            role.name, role.name
                        )
                    } else {
                        format!("The user said not now to the role {}.", role.name)
                    };
                    self.team_note(
                        place,
                        &lead.id,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "role_yes" } else { "role_no" }.into(),
                            worktree: None,
                            name: Some(role.name.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1113: the owner uses the same close path as their own command. A failed close keeps the card.
            if let Some(queue::OwnerAsk::SessionClose {
                target,
                label,
                place,
                ..
            }) = &item.owner
            {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a close-session card takes allow_once or deny".into()),
                };
                if yes {
                    self.close(target, true, false)?;
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let who = self
                    .task_caller(
                        Some(&crate::grants::Caller {
                            id: item.session_id.clone(),
                            project: place.clone(),
                        }),
                        None,
                    )
                    .ok();
                if let Some(who) = who
                    && let (Some(lead), Some(room)) = (who.lead, who.place)
                {
                    self.team_note(
                        &room,
                        &lead,
                        None,
                        if yes {
                            format!("The user closed {label} ({target}).")
                        } else {
                            format!("The user said not now to closing {label} ({target}).")
                        },
                        crate::room::TeamNote {
                            what: if yes {
                                "session_closed"
                            } else {
                                "session_close_no"
                            }
                            .into(),
                            worktree: None,
                            name: Some(label.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1099 panel 4: the live-seat card. The yes writes the cap as Settings > Team does (`Ledger::set_cap`);
            // a yes that cannot be written keeps the card, as the role card's. The lead hears the answer.
            if let Some(queue::OwnerAsk::Cap { place, cap, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a live-seat card takes allow_once or deny".into()),
                };
                if yes {
                    crate::ledger::Ledger::open(&self.home).set_cap(place, *cap)?;
                    crate::events::tasks(place);
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let team = crate::team::Team::open(&self.home);
                if let Some(lead) = team.lead_of(team.place(place).as_deref()) {
                    let body = if yes {
                        format!("The user changed the live seats here to {cap}.")
                    } else {
                        format!("The user said not now to {cap} live seats.")
                    };
                    self.team_note(
                        place,
                        &lead.id,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "cap_yes" } else { "cap_no" }.into(),
                            worktree: None,
                            name: Some(cap.to_string()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 993: the schedule card. Only this yes adds or changes the entry; the lead that asked hears the
            // answer in one line. A yes that cannot be applied (the teammate is gone, the date has passed) is an
            // error and the card stays, as the role card's.
            if let Some(queue::OwnerAsk::Schedule {
                change,
                id: entry,
                run,
                when,
                place,
                line,
                ..
            }) = &item.owner
            {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a schedule card takes allow_once or deny".into()),
                };
                // Look 11-17 v8 (Home S2-B): a failed run's card. Yes: it runs again now, off this lock (the schedule
                // timer takes it within a second; a new failure is a new card). No: only the card goes; the entry
                // keeps its failed run until its next good run or an edit.
                if change == "failed" {
                    self.queue.answer_owner(|i| i.id == id)?;
                    let entry = entry.clone().unwrap_or_default();
                    if yes {
                        if !self.schedules.list()?.iter().any(|e| e.id == entry) {
                            return Err("no such schedule".into());
                        }
                        self.schedule_reruns.push(entry);
                    }
                    return Ok(Reply::Ack);
                }
                let (now, offset) = (queue::now_ms(), &crate::usage::local_offset);
                let done = match (change.as_str(), entry) {
                    ("add", None) => "added",
                    ("pause", Some(_)) => "paused",
                    ("resume", Some(_)) => "resumed",
                    ("remove", Some(_)) => "removed",
                    _ => return Err("unknown schedule change".into()),
                };
                match entry {
                    _ if !yes => {}
                    None => {
                        let known = self.known_projects();
                        self.schedules.add_on(
                            run.clone(),
                            when.clone(),
                            None,
                            &known,
                            now,
                            offset,
                        )?;
                    }
                    Some(entry) if done == "removed" => self.schedules.remove(entry)?,
                    Some(entry) => self.schedules.pause(entry, done == "paused", now, offset)?,
                }
                if let (true, "paused", Some(entry)) = (yes, done, entry) {
                    self.drop_failed_card(entry);
                }
                if yes {
                    self.schedules_changed();
                }
                self.queue.answer_owner(|i| i.id == id)?;
                let team = crate::team::Team::open(&self.home);
                if let Some(lead) = team.lead_of(team.place(place).as_deref()) {
                    let body = if yes {
                        format!("The user {done} the schedule: {line}")
                    } else {
                        format!("The user said not now to the schedule ({change}): {line}")
                    };
                    self.team_note(
                        place,
                        &lead.id,
                        None,
                        body,
                        crate::room::TeamNote {
                            what: if yes { "schedule_yes" } else { "schedule_no" }.into(),
                            worktree: None,
                            name: Some(run.label.clone()),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1005: the tidy card. A yes asks the seat to tidy the file (opened when it is not running, as a sent
            // goal); a no only dismisses it.
            if let Some(queue::OwnerAsk::Tidy { teammate, file, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a tidy card takes allow_once or deny".into()),
                };
                self.queue.answer_owner(|i| i.id == id)?;
                if yes {
                    self.goal_wakes.push((
                        teammate.clone(),
                        format!(
                            "The user asks you to tidy {file} now: it is over the 6 KB your brief quotes, so the rest does not reach you. Keep the user's rules and lasting facts, merge or drop old log lines, and bring it under 6 KB. Then say in one line what you removed."
                        ),
                    ));
                }
                return Ok(Reply::Ack);
            }
            // Home view change 4: the goal card. Send writes the goal into the project's room, marked as from Home and
            // approved by the user, and wakes the project's lead with it; Not now tells the Home lead.
            if let Some(queue::OwnerAsk::Goal {
                place,
                lead,
                from,
                text,
            }) = &item.owner
            {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("a goal card takes allow_once or deny".into()),
                };
                let team = crate::team::Team::open(&self.home);
                let name = place
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !yes {
                    self.queue.answer_owner(|i| i.id == id)?;
                    if let Some(home_lead) = team.lead_of(None) {
                        self.team_note(
                            &team.home(),
                            &home_lead.id,
                            None,
                            format!(
                                "The user said not now to the goal for {name}'s lead: \"{text}\""
                            ),
                            crate::room::TeamNote {
                                what: "goal_no".into(),
                                worktree: None,
                                name: Some(name),
                                branch: None,
                                merged: None,
                                seat: None,
                            },
                        );
                    }
                    return Ok(Reply::Ack);
                }
                // The card goes only once the goal is in the room: a refusal here (another lead, a full room, a write
                // that failed) leaves it waiting, so the user can try again or say Not now (security look 11-17).
                // The lead it was asked for, still the place's lead: a lead changed meanwhile gets no goal unasked.
                if team.lead_of(Some(place)).is_none_or(|l| l.id != *lead) {
                    return Err(format!(
                        "{name} has another leader or none now: the goal was not sent"
                    ));
                }
                // Look 1117 home S3: "(Steward)" after "the user" read as if Steward were the user.
                let body =
                    format!("Goal from {from} (the Home lead), approved by the user: {text}");
                let to = self.seat_of(lead);
                if let Err(e) = crate::room::Log::open(&self.home, place).team(
                    to.as_deref().unwrap_or(crate::room::PERSON),
                    body.clone(),
                    crate::room::TeamNote {
                        what: "goal".into(),
                        worktree: None,
                        name: Some(from.clone()),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                ) {
                    return Err(format!("the goal was not sent: {e}"));
                }
                self.goal_wakes
                    .push((lead.clone(), format!("{body}\n\n{GOAL_NEXT}")));
                self.queue.answer_owner(|i| i.id == id)?;
                // Look 1117 home S2-6: the Home lead hears Send as it hears Not now.
                if let Some(home_lead) = team.lead_of(None) {
                    self.team_note(
                        &team.home(),
                        &home_lead.id,
                        None,
                        format!("The user sent your goal to {name}'s lead: \"{text}\""),
                        crate::room::TeamNote {
                            what: "goal_yes".into(),
                            worktree: None,
                            name: Some(name),
                            branch: None,
                            merged: None,
                            seat: None,
                        },
                    );
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1003: an open-loop card. A yes keeps the row ("add") or closes it ("close", "overdue"); a no
            // changes nothing in the rows. The Home lead hears the answer to a card it asked for.
            if let Some(queue::OwnerAsk::Loop { change, row, .. }) = &item.owner {
                let yes = match &answer {
                    queue::Answer::AllowOnce => true,
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => false,
                    _ => return Err("an open-loop card takes allow_once or deny".into()),
                };
                let loops = crate::loops::Loops::open(&self.home);
                let now = queue::now_ms();
                let words = crate::loops::words(row);
                // The card goes only once the row is written: a refusal leaves it waiting.
                let (body, what) = match (change.as_str(), yes) {
                    ("add", true) => {
                        let kept = loops.add(row.clone(), now)?;
                        self.loops_checked = 0; // a row kept with a past date is asked about at the next tick
                        (
                            format!(
                                "The user said yes: open loop {} is kept ({words}).",
                                kept.id
                            ),
                            "loop_yes",
                        )
                    }
                    ("add", false) => (
                        format!("The user said no to keeping the open loop: {words}."),
                        "loop_no",
                    ),
                    (_, true) => {
                        // Closed meanwhile (the user's shell, another card): the card just goes.
                        if loops.list()?.iter().any(|r| r.id == row.id) {
                            loops.close(&row.id, now)?;
                        }
                        self.retire_loop_cards(&row.id)?;
                        (
                            format!("The user closed open loop {} ({words}).", row.id),
                            "loop_closed",
                        )
                    }
                    (_, false) => (
                        format!("The user keeps open loop {} open ({words}).", row.id),
                        "loop_no",
                    ),
                };
                self.queue.answer_owner(|i| i.id == id)?;
                if change != "overdue" || yes {
                    self.loop_note(body, what, row);
                }
                return Ok(Reply::Ack);
            }
            // Ticket 1002 lane 2: the Outbox card. Send (allow_once) starts its 10 s undo; Undo (deny within it) puts it
            // back; Discard (deny) is No; Open by hand (choose 1) opens a new message or event from the same arguments.
            if let Some(queue::OwnerAsk::Outward {
                tool,
                args,
                hash,
                yes_at,
                ..
            }) = &item.owner
            {
                let now = queue::now_ms();
                if crate::approval::outward_call_hash(tool, args) != *hash {
                    return Err(
                        "this card's call does not match its hash: nothing was approved".into(),
                    );
                }
                let shown = crate::outbox::check(tool, args)?;
                let what = crate::outbox::words(&shown);
                // Look v20 S1: Undo is honoured until the tick approves the card (`expire_outbox`, under this same
                // lock), not by the clock alone: a card still here is not approved, however late the Undo.
                if yes_at.is_some() {
                    return match answer {
                        queue::Answer::Deny | queue::Answer::DenyWith { .. } => {
                            self.queue.outbox_yes(id, None);
                            Ok(Reply::Ack)
                        }
                        _ => Err("it is already sending: only Undo answers it now".into()),
                    };
                }
                return match answer {
                    queue::Answer::AllowOnce => {
                        self.queue.outbox_yes(id, Some(now));
                        Ok(Reply::Ack)
                    }
                    queue::Answer::Deny | queue::Answer::DenyWith { .. } => {
                        self.queue.answer_owner(|i| i.id == id)?;
                        self.outbox_note(
                            format!("The user said no to {what}. Do not send it another way."),
                            "outbox_no",
                            &shown,
                        );
                        Ok(Reply::Ack)
                    }
                    queue::Answer::Choose { index: 1 } => {
                        let target = match shown.kind {
                            "event" => {
                                let dir = self.home.join("outbox");
                                store::private_dir(&dir)?;
                                // shortcut: one small file per opened event is kept; clean the folder if it ever grows.
                                let file = dir.join(format!("{id}.ics"));
                                store::atomic_write(
                                    &file,
                                    crate::outbox::ics(id, &shown, now)?.as_bytes(),
                                )?;
                                file.to_string_lossy().into_owned()
                            }
                            _ => crate::outbox::mailto(&shown),
                        };
                        crate::outbox::open(target)?;
                        self.queue.answer_owner(|i| i.id == id)?;
                        self.keep_domains(&shown);
                        let app = if shown.kind == "event" {
                            "Calendar"
                        } else {
                            "Mail"
                        };
                        self.outbox_note(
                            format!("The user opened {what} in {app} to send or save it themselves. Do not send it."),
                            "outbox_hand",
                            &shown,
                        );
                        Ok(Reply::Ack)
                    }
                    _ => Err("an Outbox card takes allow_once, deny or choose 1".into()),
                };
            }
            return match (answer, item.owner) {
                (queue::Answer::Deny, _) => {
                    self.queue.answer_owner(|i| i.id == id)?;
                    Ok(Reply::Ack)
                }
                (
                    queue::Answer::AllowOnce,
                    Some(queue::OwnerAsk::PermissionAnswers { project }),
                ) => self.permission_answers(&project, true),
                (queue::Answer::AllowOnce, Some(queue::OwnerAsk::LeadAccounts)) => {
                    let on = [(crate::accounts::LEADS_ANY.to_string(), true.into())];
                    self.quit_settings(LifetimePatch {
                        features: Some(on.into()),
                        ..Default::default()
                    })?;
                    self.queue.answer_owner(|i| i.id == id)?;
                    Ok(Reply::Ack)
                }
                // r2 (S2): a widget or integration source is approved only in the permission sheet, at the hash the
                // sheet shows (its `approval_grant` / `board_source_grant` clears the item).
                (
                    queue::Answer::AllowOnce,
                    Some(queue::OwnerAsk::Approval { .. } | queue::OwnerAsk::Setup { .. }),
                ) => Err("review it in the permission sheet to approve it".into()),
                _ => Err("an owner item takes allow_once or deny".into()),
            };
        }
        // Look v20 S1: an Undo that came after the approval says so, not "decision not found".
        if self.queue.outbox_approved(id) {
            return Err(OUTBOX_TOO_LATE.into());
        }
        let item = self.queue.decision(id)?;
        // Seventh look (B S2-1): an answered prompt stays on the agent's screen until the agent draws again. The
        // re-read of a still screen (`tick`) waits that out, so the prompt just answered is never a card a second time
        // (its answer would be typed into whatever the agent shows next).
        if let Some(entry) = self.entries.get_mut(&item.session_id) {
            entry.observer.reread = Some(std::time::Instant::now() + REREAD_AFTER_ANSWER);
        }
        if !item.actionable || item.reconciled || !self.entry(&item.session_id)?.agent_live() {
            return Err("decision needs live reconciliation".into());
        }
        // V2-8e r3: a permission takes allow once or deny only, from every caller: a raw `choose` would type an option's
        // keys past the risky gate below (the window never sends one).
        if item.kind == queue::Kind::Permission && matches!(answer, queue::Answer::Choose { .. }) {
            return Err(
                "a permission takes allow once or deny only (other options: answer in the terminal)".into(),
            );
        }
        // V2-8e: a risky permission is allowed only from the panel card, which confirms it (focus, then Enter); the
        // strip, the chat card, the phone and keys get this refusal.
        if matches!(answer, queue::Answer::AllowOnce)
            && item.kind == queue::Kind::Permission
            && !confirmed
            && self.annotated(item.clone()).risky
        {
            return Err("risky: allow it in the decision card (focus, then Enter)".into());
        }
        // V2-4a: an ACP agent's request is answered over its protocol, never typed.
        if item.sources.contains("acp") {
            let entry = self
                .entries
                .get_mut(&item.session_id)
                .ok_or("session not found")?;
            let acp = entry
                .acp
                .as_mut()
                .ok_or("decision needs live reconciliation")?;
            return acp.answer(&entry.meta, &mut self.queue, &item, &answer);
        }
        if item.kind == queue::Kind::Dialog && !matches!(answer, queue::Answer::Deny) {
            return Err(
                "dialog choices must be answered in the agent terminal; only deny/Esc is allowed"
                    .into(),
            );
        }
        // Ticket 1030: "Allow for this session" goes through the hook with Claude's own rules kept to this session, and
        // only those no broader than the request; the screen's option 2 would write them to its settings.
        let cwd = self.entry(&item.session_id)?.meta.cwd.clone();
        if matches!(answer, queue::Answer::AllowAlways)
            && item.kind == queue::Kind::Permission
            && self.annotated(item.clone()).allow_always.is_some()
            && self.queue.answer_hook_session(&item, &cwd, now)?
        {
            return Ok(Reply::Ack);
        }
        if matches!(answer, queue::Answer::AllowOnce | queue::Answer::Deny)
            && item.kind == queue::Kind::Permission
            && self.queue.answer_hook_with(
                &item,
                matches!(answer, queue::Answer::AllowOnce),
                note,
                interrupt,
                now,
            )?
        {
            return Ok(Reply::Ack);
        }
        // Look 11-17 N20: Codex's async question takes its answer as the user's next message; Cancel only drops the card.
        if queue::answered_by_message(&item) {
            let text = match answer {
                queue::Answer::Choose { index } => Some(
                    item.choices
                        .get(index)
                        .ok_or("invalid answer option")?
                        .label
                        .clone(),
                ),
                queue::Answer::Deny => None,
                _ => return Err("a question takes one of its choices".into()),
            };
            if let Some(text) = &text {
                crate::delivery::check_text(AgentKind::Codex, text)?; // the label is the agent's own text
            }
            let mut queued = None;
            if let Some(text) = text {
                // Queued, never written here: the tick writes it once the input box is on the screen (`steers`).
                // Q9 tt-J4-3: queued before the card goes, so a failed save never drops the card with its answer.
                let send =
                    self.begin_send("user", &item.session_id, text, vec![], true, "queued")?;
                self.steers.insert(send.id.clone());
                queued = Some(send.id);
            }
            if let Err(e) = self.queue.remove(id) {
                // Codex round 2: the card stays, so its answer goes too; a second press would queue a second copy.
                if let Some(send) = queued {
                    self.steers.remove(&send);
                    self.entry(&item.session_id)?
                        .meta
                        .send_queue
                        .retain(|s| s.id != send);
                    if let Err(undo) = self.save() {
                        eprintln!("queued answer {send} not taken back on disk: {undo}");
                    }
                }
                return Err(e);
            }
            return Ok(Reply::Ack);
        }
        self.current(&item.session_id)?; // v1a-19 r2
        // v1b-30: an item the screen never proved (its hook has returned) is never typed; the card shows this.
        if item.screen_text.is_none() {
            return Err("the screen cannot prove this request; answer in the terminal".into());
        }
        // Ticket 396: a blank screen inside the resize grace is the agent's redraw still to come; nothing is typed until
        // the prompt is detected again (the checks below run on the redrawn screen).
        // Seventh look (B S1-1): so is a screen a resize blanked that the tick has not given back yet (`restore_undrawn`,
        // at most one tick after the grace): the answer waits for it, and does not depend on when that tick runs.
        let redrawing = self.queue.redrawing(&item.session_id);
        let entry = self.entry(&item.session_id)?;
        let gone = if redrawing || entry.observer.unredrawn.is_some() {
            SCREEN_REDRAWING
        } else {
            NOT_ON_SCREEN
        };
        let current = entry.observer.screen.detect(entry.meta.kind).ok_or(gone)?;
        if current.kind != item.kind || item.screen_text.as_ref() != Some(&current.text) {
            return Err("decision screen changed; refresh before answering".into());
        }
        let mut typed = None;
        let keys = match answer {
            queue::Answer::Deny => vec!["esc".into()],
            queue::Answer::AllowOnce => {
                if item.kind != queue::Kind::Permission {
                    return Err("allow_once requires a permission request".into());
                }
                let choice = item
                    .choices
                    .iter()
                    .find(|c| c.allows_once()) // v1b-12: one rule, queue::Choice::allows_once
                    .ok_or("no verified allow-once screen option")?;
                choice.keys.clone()
            }
            // V2-8e: only the option `annotate` offered: session-only, on a request that is not risky.
            queue::Answer::AllowAlways => {
                const NONE: &str = "no session-only \"don't ask again\" option for this request";
                let mut view = item.clone();
                let meta = &self.entry(&item.session_id)?.meta;
                let (cwd, lock) = (meta.cwd.clone(), meta.home_lock);
                self.queue.annotate(&mut view, &cwd, lock);
                let label = view.allow_always.ok_or(NONE)?;
                let choice = item
                    .choices
                    .iter()
                    .find(|c| c.label == label && c.session_only())
                    .ok_or(NONE)?;
                choice.keys.clone()
            }
            queue::Answer::DenyWith { .. } => return Err("invalid answer".into()),
            // Home look S2-7 (real Claude 2.1.326): the row's digit opens the dialog's text field; the words and Enter
            // follow there. Only that row takes words, and only from the card.
            queue::Answer::ChooseWith { index, ref text } => {
                let choice = item.choices.get(index).ok_or("invalid answer option")?;
                let text = queue::deny_note(text);
                if item.kind != queue::Kind::Question || !choice.takes_text() || text.is_empty() {
                    return Err("only a question's Type something choice takes words".into());
                }
                typed = Some(text);
                // The row's Enter would send the empty field, which Claude reads as a rejection: the digit alone.
                let mut keys = choice.keys.clone();
                keys.retain(|k| k != "enter");
                keys
            }
            queue::Answer::Choose { index } => {
                let choice = item.choices.get(index).ok_or("invalid answer option")?;
                if choice.changes_settings {
                    if !confirmed {
                        return Err("confirmation_required: option changes user settings".into());
                    }
                    return Err("persistent user configuration changes must be answered in the agent terminal".into());
                }
                // Home look S2-7: its digit and Enter send an empty field, which Claude reads as a rejection.
                if item.kind == queue::Kind::Question && choice.takes_text() {
                    return Err("only a question's Type something choice takes words".into());
                }
                choice.keys.clone()
            }
        };
        let mut bytes = vec![];
        for key in keys {
            if key.bytes().all(|b| b.is_ascii_digit()) && key.len() <= 3 {
                bytes.extend(key.as_bytes());
            } else {
                bytes.extend(key_bytes(&key)?);
            }
        }
        // Remove durably before sending: a crash can lose an answer but can never replay it.
        self.queue.remove(id)?;
        self.live(&item.session_id)?.write(&bytes)?;
        if let Some(text) = typed {
            // Claude reads "3words" in one chunk as the digit alone, so the words wait for its text field: a later tick
            // types them once the screen shows it (`advance_typed`), never a pause under the registry lock.
            let digit = bytes.iter().map(|b| *b as char).collect();
            self.typed_answers.insert(
                item.session_id.clone(),
                TypedAnswer {
                    digit,
                    text,
                    since: std::time::Instant::now(),
                    typed: None,
                },
            );
        }
        Ok(Reply::Ack)
    }
    /// Look 11-17 w10 item 1: a question's "Type something" answer. Its digit is written; the words follow once the
    /// screen shows the text field (the cursor row `❯ <digit>.`), Enter once the field shows the words. Under load
    /// Claude opens the field later, and words typed into the option list pick a row by a leading digit. Bounded by
    /// `TYPED_WAIT`: a field that never shows gets no words, and the question, still on the screen, is a card again.
    fn advance_typed(&mut self) {
        let now = std::time::Instant::now();
        for id in self.typed_answers.keys().cloned().collect::<Vec<_>>() {
            let Some(entry) = self.entries.get_mut(&id) else {
                self.typed_answers.remove(&id);
                continue;
            };
            let answer = &self.typed_answers[&id];
            if now.duration_since(answer.since) > TYPED_WAIT || !entry.agent_live() {
                eprintln!(
                    "session {id}: the question's text field did not open; its words were not typed"
                );
                self.typed_answers.remove(&id);
                continue;
            }
            if entry.observer.behind {
                continue;
            }
            let screen = entry.observer.screen.text();
            let field = typed_field(&screen, &answer.digit);
            let step: Option<Vec<u8>> = match (answer.typed, field) {
                (None, Some(_)) => Some(answer.text.as_bytes().to_vec()),
                (Some(at), Some(shown))
                    if now.duration_since(at) >= std::time::Duration::from_millis(100)
                        && shown.to_lowercase().starts_with(
                            &answer
                                .text
                                .chars()
                                .take(20)
                                .collect::<String>()
                                .to_lowercase(),
                        ) =>
                {
                    Some(b"\r".to_vec())
                }
                _ => None,
            };
            let Some(bytes) = step else { continue };
            let enter = bytes == b"\r";
            if let Some(pty) = entry.pty.as_mut()
                && let Err(e) = pty.write(&bytes)
            {
                eprintln!("session {id}: the question's answer was not typed: {e}");
                self.typed_answers.remove(&id);
                continue;
            }
            if enter {
                self.typed_answers.remove(&id);
            } else if let Some(answer) = self.typed_answers.get_mut(&id) {
                answer.typed = Some(now);
            }
        }
    }
    /// Ticket 358: every session on account `folder`, and its own Login and Logout tabs, now carry the name `to`. Matched
    /// by folder, never by the old name, so a row a crash left on an earlier name is put right too.
    pub(crate) fn account_relabel(&mut self, folder: &Path, to: &str) {
        for meta in self.entries.values_mut().map(|e| &mut e.meta) {
            if meta.config_dir.as_deref() == Some(folder) {
                meta.account = Some(to.into());
            }
            if meta.account_tab && meta.project == folder {
                for word in ["Login", "Logout"] {
                    if meta.label.starts_with(&format!("{word}: ")) {
                        meta.label = format!("{word}: {to}");
                    }
                }
            }
        }
    }
    /// Ticket 358: an account's new name reaches what the sessions keep. A failed save puts `old` back.
    pub(crate) fn account_renamed(
        &mut self,
        folder: &Path,
        old: &str,
        new: &str,
    ) -> Result<(), String> {
        self.account_relabel(folder, new);
        let saved = self.save();
        if saved.is_err() {
            self.account_relabel(folder, old);
        }
        saved
    }
    /// Ticket 76: remember the logout tab of `folder` across a core restart.
    pub(crate) fn logout_mark(&mut self, folder: &Path, tab: &str) {
        self.logouts.insert(folder.into(), tab.into());
        self.save_logouts();
    }
    pub(crate) fn logout_clear(&mut self, folder: &Path) {
        if self.logouts.remove(folder).is_some() {
            self.save_logouts();
        }
    }
    // The tab already started (or the account moved), so a write error cannot refuse anything: print it.
    fn save_logouts(&self) {
        let bytes = serde_json::json!({"version": 1, "logouts": self.logouts}).to_string();
        if let Err(e) = store::atomic_write(&self.home.join("logouts.json"), bytes.as_bytes()) {
            eprintln!("logouts.json not saved: {e}");
        }
    }
    /// A missing file is empty; an unreadable, wrong-version or malformed one is empty and counted.
    fn load_logouts(home: &Path) -> (BTreeMap<PathBuf, String>, usize) {
        #[derive(serde::Deserialize)]
        struct File {
            version: u32,
            logouts: BTreeMap<PathBuf, String>,
        }
        match fs::read(home.join("logouts.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (BTreeMap::new(), 0),
            Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
                Ok(file) if file.version == 1 => (file.logouts, 0),
                _ => (BTreeMap::new(), 1),
            },
            Err(_) => (BTreeMap::new(), 1),
        }
    }
    fn begin_send(
        &mut self,
        sender: &str,
        id: &str,
        content: String,
        keys: Vec<String>,
        submit: bool,
        status: &str,
    ) -> Result<crate::delivery::Send, String> {
        self.touch_input(id); // ticket 992: a prompt or keys on their way into the box
        let attention = self.queue.attention(id);
        let send = crate::delivery::Send {
            completion_seq: attention.completion_seq,
            last_activity: attention.last_activity,
            id: store::new_id()?,
            sender: sender.into(),
            at: queue::now_ms(),
            content,
            keys,
            submit,
            status: status.into(),
            settle: None, // v1a-15
            // Ticket 76: the flush reads this, not the lasting set (a peer may later forward under the same id).
            remote: (sender != "user").then(|| self.grants.remote.contains(sender)),
        };
        // Ticket 1056: the user's words go ahead of every queued worker wake line, whatever its age.
        let wake_rows = &self.wake_rows;
        let ahead = (sender == "user")
            .then(|| {
                self.entries
                    .get(id)?
                    .meta
                    .send_queue
                    .iter()
                    .position(|s| s.status == "queued" && wake_rows.contains(&s.id))
            })
            .flatten();
        let queue = &mut self.entry(id)?.meta.send_queue;
        let at = ahead.unwrap_or(queue.len());
        queue.insert(at, send.clone());
        if let Err(e) = self.save() {
            self.entry(id)?.meta.send_queue.remove(at);
            return Err(e);
        }
        Ok(send)
    }
    fn finish_send(&mut self, id: &str, send: &str, status: &str) -> Result<(), String> {
        self.mark_send(id, send, status)?;
        self.save()
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

    /// ticket 115, 123 and composer text gate: refuse Stop or composer input unless the screen is current and the window has drawn every pending
    /// request (`seen`, empty when the caller sent none): the tick queues a dialog well before the window renders it.
    /// A hook permission whose dialog the screen has not drawn yet also blocks. An Esc on a dialog the window showed
    /// stays the owner's raw deny.
    fn key_gate(&mut self, id: &str, seen: &[String]) -> Result<(), String> {
        let e = self.entry(id)?;
        // Ticket 286: the shell an agent left has no dialog; its closed items guard nothing.
        if e.meta.kind == AgentKind::Shell || e.acp.is_some() || e.agent_ended {
            return Ok(());
        }
        self.current(id)?;
        for p in self.queue.items() {
            if p.session_id != id
                || !matches!(
                    p.kind,
                    queue::Kind::Dialog | queue::Kind::Permission | queue::Kind::Question
                )
            {
                continue;
            }
            if !seen.contains(&p.id) {
                return Err("a request you have not seen is pending: answer it in the Decisions widget, then try again".into());
            }
            if p.kind == queue::Kind::Permission && p.screen_text.is_none() {
                // Ticket 991 B3: a held hook draws no dialog until its card is answered, so "try again" would be wrong.
                // shortcut: reuses the unseen-request words ("answer it first"); give it its own line if people trip.
                if self.queue.hook_live(&p, queue::now_ms()) {
                    return Err("a request you have not seen is pending: answer it in the Decisions widget, then try again".into());
                }
                return Err("a permission request is not on the screen yet: try again".into());
            }
        }
        Ok(())
    }
    /// Look 11-17 v5 item 1: a start question (folder trust, an added folder, any choice prompt the core reads as a
    /// dialog) is on this session's current screen or held as its card. Text typed into one would answer it.
    /// Look 11-17 v11 N11-S2-1: so would an agent's question (Claude's AskUserQuestion): the text went into its "Type
    /// something" row. Look 1117 v13 N13-S2-3: so would a permission prompt (the text rejected Claude's Write): only its
    /// card answers it.
    fn dialog_on_screen(&mut self, id: &str) -> Result<bool, String> {
        let entry = self.entry(id)?;
        if entry.acp.is_some() || !matches!(entry.meta.kind, AgentKind::Claude | AgentKind::Codex) {
            return Ok(false);
        }
        self.current(id)?;
        let entry = self.entry(id)?;
        let on_screen = entry
            .observer
            .screen
            .detect(entry.meta.kind)
            .is_some_and(|d| {
                matches!(
                    d.kind,
                    queue::Kind::Dialog | queue::Kind::Question | queue::Kind::Permission
                )
            });
        // The kinds the delivery queue waits behind, so a held send goes in once they are answered.
        Ok(on_screen || crate::delivery::blocked(&self.queue.items_of(id)))
    }
    /// Ticket 990 (fourth real-app look): a hook returned with no answer while the agent's dialog stood on a still
    /// screen. The queue passes over frames while the hook is live, and the screen is fed only on new output, so the
    /// card would stay unpaired until the screen next changes (seen: a question at 62 columns). Read it once more.
    pub(crate) fn reread_screen(&mut self, id: &str) {
        let Some(entry) = self.entries.get(id) else {
            return;
        };
        if entry.meta.state != SessionState::Running
            || entry.agent_ended
            || entry.switch.is_some()
            || entry.meta.kind == AgentKind::Shell
        {
            return;
        }
        let Some(item) = entry.observer.screen.detect(entry.meta.kind) else {
            return;
        };
        if let Err(error) =
            self.queue
                .screen(id, item.kind, item.text, item.choices, queue::now_ms())
        {
            eprintln!("screen reread failed: {error}");
        }
    }
    /// Ticket 286 item 1 (card C-20261106-03): the composer writes to the agent only; once the agent ended its text and
    /// Enter would run in the shell it left. Refused before any write; the terminal's own keys (`composer: false`) pass.
    fn composer_live(&mut self, id: &str) -> Result<(), String> {
        if self.entry(id)?.agent_ended {
            return Err(crate::delivery::AGENT_ENDED.into());
        }
        Ok(())
    }
    /// Ticket 372: the limit session `id`'s screen shows while its reset is ahead of `now`, for a live session only.
    fn session_limit(&self, id: &str, live: bool, now: i64) -> Option<SessionLimit> {
        let (resets, until, shown) = crate::usage::session_mark(&self.home, id).filter(|_| live)?;
        (shown && until > now).then(|| SessionLimit {
            resets,
            until,
            armed: self.limit_resumes.contains_key(id),
        })
    }
    /// Ticket 372 (owner 11-09): the owner's Resume at <time> on one session (`on`), or its Cancel. Arms only a live session
    /// whose screen shows a limit with a reset still ahead; arming again changes nothing, so one press sends at most once.
    fn limit_resume(&mut self, id: &str, on: bool, now: i64) -> Response {
        if !on {
            self.limit_resumes.remove(id);
            return Ok(Reply::Ack);
        }
        let live = self.entry(id)?.agent_live();
        let limit = self
            .session_limit(id, live, now)
            .ok_or("no usage limit with a reset time ahead is on this session's screen")?;
        self.limit_resumes.insert(id.into(), limit.until);
        Ok(Reply::Ack)
    }
    /// Ticket 372: each armed session, once, in the tick after `observe` read its screen. Disarmed without a send when its
    /// agent ended, or its limit line left the screen or changed before the reset (the person moved on). At the reset it
    /// is disarmed first, then sent only with nothing pending (T3 UsageLimitRecoveryWorker.ts:17-33,56-70): the fixed
    /// text alone, through the ordinary delivery path, as the owner.
    fn fire_resumes(&mut self, now: i64) {
        let armed: Vec<(String, i64)> = self
            .limit_resumes
            .iter()
            .map(|(id, at)| (id.clone(), *at))
            .collect();
        for (id, at) in armed {
            let live = self.entries.get(&id).is_some_and(|e| e.agent_live());
            // Decided by time first: an ended mark may already be gone, since another session's screen pass in the
            // reset's own tick drops it (`observe_limit`), so the mark is asked about only before the reset.
            if now < at {
                let same = crate::usage::session_mark(&self.home, &id)
                    .is_some_and(|(_, until, shown)| shown && until == at);
                if !live || !same {
                    self.limit_resumes.remove(&id);
                }
                continue;
            }
            self.limit_resumes.remove(&id);
            if !live {
                continue;
            }
            let meta = self.entries[&id].meta.clone();
            if !self.snapshot_session(&meta).pending.is_empty()
                || !meta.send_queue.is_empty()
                || self.pending_enter.contains_key(&id)
            {
                continue;
            }
            match self.send("user", &id, CONTINUE_TEXT.into(), vec![], true) {
                // Q9 pin-J5-3: the observer behind at the reset tick passes; armed again, the next tick sends.
                Err(error) if error == "screen not current, try again" => {
                    self.limit_resumes.insert(id, at);
                }
                Err(error) => eprintln!("resume at reset not sent: {error}"),
                Ok(_) => {}
            }
        }
    }
    // v1a-19 r2: fail closed while the observer is behind the output: the screen and queue may hide a dialog.
    fn current(&mut self, id: &str) -> Result<(), String> {
        if self.entry(id)?.observer.behind {
            return Err("screen not current, try again".into());
        }
        Ok(())
    }
    fn send(
        &mut self,
        sender: &str,
        id: &str,
        text: String,
        keys: Vec<String>,
        submit: bool,
    ) -> Response {
        let said = (!text.trim().is_empty()).then(|| text.clone());
        // Look v20 S2: words another send typed and nobody submitted are in the box. A prompt pasted behind them had its
        // Enter dropped (the box shows more than the paste), was reported failed, and went in with the next Enter. Now
        // it is refused before anything is written. (Words typed by hand: `Input::submit` refuses with `EDITED`.)
        if submit
            && said.is_some()
            && sender != "user"
            && !self.pending_enter.contains_key(id)
            && self.entries.get(id).is_some_and(|e| {
                e.acp.is_none()
                    && e.meta.kind != AgentKind::Shell
                    && e.input.pending()
                    && !e.input.edited()
            })
        {
            return Err(UNSENT_WORDS.into());
        }
        let reply = self.send_inner(sender, id, text, keys, submit, false)?;
        if let Some(said) = said {
            let row = match &reply {
                Reply::Delivery { send } => Some(send.id.clone()),
                _ => None,
            };
            self.typed(sender, id, &said, crate::room::By::Agent, row);
        }
        Ok(reply)
    }
    /// Ticket 990: the room keeps what one seat typed into another's terminal: a lead's prompt to its worker, a
    /// worker's finish line to its lead (the core types that one for it). Only between two sessions of one room; the
    /// room's own notice (a seat is its own sender there) and the user's prompts are not such lines. Masked as the
    /// logs are, and cut: the terminal has the whole text.
    fn typed(
        &mut self,
        sender: &str,
        id: &str,
        text: &str,
        by: crate::room::By,
        send: Option<String>,
    ) {
        if sender == id || !self.entries.contains_key(sender) {
            return;
        }
        let Some(room) = self
            .room_project(id)
            .filter(|r| self.room_project(sender).as_ref() == Some(r))
        else {
            return;
        };
        let line = String::from_utf8_lossy(&crate::logs::mask(text.trim().as_bytes())).into_owned();
        let cut: String = line.chars().take(2000).collect();
        let body = if cut.len() < line.len() {
            cut + "…"
        } else {
            cut
        };
        if let Err(e) = crate::room::Log::open(&self.home, &room).typed(sender, id, body, by, send)
        {
            eprintln!("typed line not kept in the room: {e}");
        }
    }
    /// A line the core itself types into an agent's input box: a worker's finish line, the room's notice. Claude's box
    /// refuses another session's line while it holds words or keys typed by hand (`delivery::EDITED`). Such a line is
    /// never typed there and never lost: it waits in that session's queue, and `deliver` writes it once the mark is
    /// gone (the user's next Enter there, or the box cleared after a Stop).
    pub(crate) fn send_line(&mut self, sender: &str, id: &str, text: String) -> Response {
        if !self.box_edited(id) {
            return self.send_inner(sender, id, text, vec![], true, false);
        }
        crate::delivery::check_text(AgentKind::Claude, &text)?;
        let send = self.begin_send(sender, id, text, vec![], true, "queued")?;
        Ok(Reply::Delivery { send })
    }
    /// A running Claude whose input box is marked as edited by hand.
    pub(crate) fn box_edited(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.meta.kind == AgentKind::Claude && e.agent_live() && e.input.edited())
    }
    /// `walking`: this is the mode walk's own Shift+Tab (`set_mode`, `advance_walks`, `end_walk`), the one send a
    /// running walk lets through. Every other send queues behind the walk, as behind a model switch, and a second mode
    /// key is refused: a turn must not start while the footer sits in a mode the owner only passes through.
    fn send_inner(
        &mut self,
        sender: &str,
        id: &str,
        text: String,
        keys: Vec<String>,
        submit: bool,
        walking: bool,
    ) -> Response {
        self.refresh()?;
        self.observe()?;
        let meta = self.entry(id)?.meta.clone();
        // Ticket 286: never into the shell an ended agent left; only the user's own terminal keys go there.
        if !self.entry(id)?.agent_live() {
            return Err("agent is not running".into());
        }
        crate::delivery::check_text(meta.kind, &text)?;
        // Ticket 1002 lane 1 (Fable check M5d): agent-sent text never opens a locked seat's bash mode (`!`), a slash
        // command, a memory line or a background run.
        if sender != "user" && meta.home_lock && text.trim_start().starts_with(['!', '/', '#', '&'])
        {
            return Err("text for the chief of staff's seat may not start with ! / # or &".into());
        }
        if keys.len() > 100 {
            return Err("too many keys".into());
        }
        for key in &keys {
            check_key(sender, meta.kind, key)?;
        }
        // CHAT-PERMCHIP r2: a mode change is never queued (it would land after the owner moved on), never mixed with
        // other input, and needs the composer on screen.
        let mode_key = keys.iter().any(|k| k.eq_ignore_ascii_case("shift+tab"));
        let held = !walking && self.walk_hold(id);
        if mode_key {
            if held {
                return Err(MODE_BUSY.into());
            }
            if keys.len() != 1 || !text.is_empty() || submit {
                return Err("shift+tab is sent alone".into());
            }
            if composer(&self.entry(id)?.observer.screen.text(), meta.kind).is_none() {
                return Err("agent is not at its composer; shift+tab not sent".into());
            }
        }
        let snapshot = self.snapshot_session(&meta);
        let interrupt = interrupt_key(&keys);
        if !interrupt {
            self.current(id)?; // v1a-19 r2
        }
        if !interrupt && crate::delivery::blocked(&snapshot.pending) {
            return Err("agent_blocked".into());
        }
        // v1a-15: an interrupt cancels a pending Enter; any other send queues behind it.
        if interrupt && let Some(enter) = self.pending_enter.remove(id) {
            self.finish_send(id, &enter.send, "canceled")?;
        }
        let waiting = self.pending_enter.contains_key(id);
        // Ticket 1121: nor a paste into a box the screen does not read while the core's dropped copy may be in it (the
        // clear would write no Ctrl+U): it waits in the queue for a read box (the delivery walk's guard).
        let unread = submit && !text.is_empty() && self.unread_copy(id);
        let ready = interrupt
            || self.send_ready(&meta.id, &snapshot)?
                && self.delivery_open(id, &snapshot)
                && self.entry(&meta.id)?.switch.is_none() // v1a-10: no typing into the picker
                && !held // CHAT-MODELIST r2: nor into a walk's passing modes
                && !waiting
                && !unread;
        if mode_key && !ready {
            return Err("agent is not at its composer (busy); shift+tab not queued".into());
        }
        let mut send = self.begin_send(
            sender,
            id,
            text,
            keys,
            submit,
            if ready { "attempting" } else { "queued" },
        )?;
        if ready {
            let result = self.write_send(id, &send);
            if interrupt && result.is_ok() {
                self.interrupted(id)?;
            }
            // v1a-15: a pasted submit stays attempting until a later tick writes its Enter.
            if result == Ok(true) {
                return Ok(Reply::Delivery { send });
            }
            send.status = if result.is_ok() {
                "delivered"
            } else {
                "failed"
            }
            .into();
            self.finish_send(id, &send.id, &send.status)?;
            result?;
        }
        Ok(Reply::Delivery { send })
    }
    /// An interrupt key reached a Claude session: for a while its screen may end the turn (see `observe`).
    fn interrupted(&mut self, id: &str) -> Result<(), String> {
        let entry = self.entry(id)?;
        if entry.meta.kind == AgentKind::Claude {
            entry.observer.interrupted =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(30));
            entry.observer.clear_box = true;
        }
        Ok(())
    }
    /// Look 11-17 v3 P3: Claude 2.1.326 puts a prompt stopped before any output back into its input box; the next send
    /// was typed after it and both went as one prompt. The first submit after the core's own interrupt clears the box
    /// (Ctrl+U deletes a line, a second one the line break before it) so only the new message goes in.
    /// shortcut: text the user typed into the terminal between the Stop and this send is cleared too; tell it apart
    /// only if that bites.
    fn clear_box_first(&mut self, id: &str) -> Result<(), String> {
        // Ticket 1085: an automatic line left typed after its dropped Enter is the core's own words; words typed by hand
        // since then (`edited`) are the owner's, and nothing is cleared.
        let left = self.left_typed.remove(id) && !self.entry(id)?.input.edited();
        let entry = self.entry(id)?;
        if !std::mem::take(&mut entry.observer.clear_box) && !left {
            return Ok(());
        }
        let rows = box_rows(&entry.observer.screen.text());
        if rows == 0 {
            return Ok(());
        }
        self.live(id)?.write(&b"\x15".repeat(2 * rows + 1))?;
        self.copy_gone(id); // Ticket 1094 r5: a dropped copy left in the box is gone
        self.entry(id)?.input = Default::default();
        Ok(())
    }
    /// v25-sendkeys: Ctrl+Enter. Ticket 1056: a working Claude takes the text into its running turn (no Esc). For
    /// other kinds, and for an empty Ctrl+Enter, the turn is interrupted with the Stop key (Esc, through Stop's gate)
    /// and the text is then submitted through the ordinary `send`, so it is written once, after the turn unwinds. A kind with no turn to interrupt refuses with
    /// `NO_INTERRUPT` and keeps the queue; a failed Esc returns before any text is written, so nothing is sent twice.
    fn steer_now(&mut self, sender: &str, id: &str, text: String, seen: &[String]) -> Response {
        self.refresh()?;
        self.observe()?;
        let meta = self.entry(id)?.meta.clone();
        // Ticket 286: never into the shell an ended agent left; only the user's own terminal keys go there.
        if !self.entry(id)?.agent_live() {
            return Err("agent is not running".into());
        }
        // A kind with no interrupt to press keeps the queue and says so: an ACP agent takes keys only to cancel, the
        // delivery path refuses more than one prompt, and a shell has no turn to interrupt.
        if self.entry(id)?.acp.is_some() || meta.kind == AgentKind::Shell {
            return Err(crate::delivery::NO_INTERRUPT.into());
        }
        crate::delivery::check_text(meta.kind, &text)?;
        self.current(id)?;
        // Nothing to interrupt: the queue already goes in now.
        let snapshot = self.snapshot_session(&meta);
        if !snapshot.attention.working {
            if text.is_empty() {
                return Err("nothing to send now".into()); // an interrupt alone has nothing to break
            }
            return self.send(sender, id, text, vec![], true);
        }
        if crate::delivery::blocked(&snapshot.pending) {
            return Err("agent_blocked".into());
        }
        // Ticket 1056: Claude takes text typed while it works and adds it at its next step (the chat's
        // `queued_command`); the turn goes on, as in Claude Code and Orca. No Esc: the tick writes the text once the
        // input box shows (`steers`), never while a request waits. An interrupt alone still presses Esc below.
        if meta.kind == AgentKind::Claude && !text.is_empty() {
            let reply = self.send(sender, id, text, vec![], true)?;
            if let Reply::Delivery { send } = &reply
                && send.status == "queued"
            {
                self.steers.insert(send.id.clone());
            }
            return Ok(reply);
        }
        // Stop's gate: the Esc below answers whatever is focused, so the window must have drawn every request.
        self.key_gate(id, seen)?;
        // The interrupt first, as Claude Code's send-now does; its own Esc refuses when the screen cannot be trusted.
        let esc = self.send(sender, id, String::new(), vec!["esc".into()], false)?;
        if let Reply::Delivery { send } = &esc
            && send.status == "failed"
        {
            return Ok(esc);
        }
        if text.is_empty() {
            return Ok(esc); // an interrupt alone: the agent's own queued input is what goes in now
        }
        // Queued while the turn unwinds, then written once by `flush_delivery` when the agent is at its prompt.
        self.send(sender, id, text, vec![], true)
    }
    // v1b-20: a script widget act (widgets::act) enters the V1A-04 delivery path as `widget:<name>`.
    pub(crate) fn widget_send(
        &mut self,
        name: &str,
        id: &str,
        text: String,
        submit: bool,
        hash: &str,
    ) -> Response {
        // The grant is checked again here, under the lock that also writes: launch preparation can take seconds.
        let sender = format!("widget:{name}");
        self.widget_act_current(&sender, hash)?;
        let reply = self.send(&sender, id, text, vec![], submit)?;
        if let Reply::Delivery { send } = &reply
            && send.status == "queued"
        {
            self.widget_hashes.insert(send.id.clone(), hash.into());
        }
        Ok(reply)
    }
    // v1b-20: an act is sent only while the setting is on and the act grant is the one whose content (`hash`)
    // rendered its text; a re-approval with another template in between refuses it.
    fn widget_act_current(&self, sender: &str, hash: &str) -> Result<(), String> {
        let name = sender.strip_prefix("widget:").unwrap_or_default();
        let proof = crate::approval::check(&self.home, name)
            .ok()
            .filter(|p| {
                p.level() == crate::approval::Level::Act
                    // v1b-22: the setting and [act] rule per kind
                    && match p.manifest().kind.as_str() {
                        "web" => self.settings.web_widgets, // v1b-22: a web widget has no [act] table
                        _ => self.settings.script_widgets && p.manifest().act.is_some(),
                    }
            })
            .ok_or("act grant changed before the send; nothing sent")?;
        if proof.hash() != hash {
            return Err(crate::widgets::act::CHANGED.into());
        }
        Ok(())
    }
    /// v1a-15: `Ok(true)` when the text is written and its Enter is pending.
    fn write_send(&mut self, id: &str, send: &crate::delivery::Send) -> Result<bool, String> {
        if self.entry(id)?.acp.is_some() {
            return self.acp_send(id, send).map(|()| false); // V2-4a
        }
        self.submitted.remove(id); // N1: new words or keys (an interrupt) are on their way into the box
        if send.submit && !send.content.is_empty() {
            self.clear_box_first(id)?;
            self.copy_gone(id); // Ticket 1094 r5: pasted over, an Enter now sends this paste as well
        }
        let mut bytes = send.content.as_bytes().to_vec();
        for key in &send.keys {
            bytes.extend(key_bytes(key)?);
        }
        let entry = self.entry(id)?;
        let restricted = send.sender != "user" && entry.meta.kind == AgentKind::Claude;
        let input = entry
            .input
            .prepare(&entry.observer.screen.text(), send, restricted)?;
        // v1a-15: an agent with bracketed paste on gets the text as one paste and Enter as a later write, so
        // a long text is not taken as a paste that swallows the Enter. check_text refuses ESC and C1 controls,
        // so the text cannot end the paste early.
        let paste = send.submit
            && entry.meta.kind != AgentKind::Shell
            && entry.pty.as_ref().is_some_and(Pty::bracketed_paste);
        if paste {
            let typed = entry.input.prepare(
                &entry.observer.screen.text(),
                &crate::delivery::Send {
                    submit: false,
                    ..send.clone()
                },
                restricted,
            )?;
            let bytes = [b"\x1b[200~", &bytes[..], b"\x1b[201~"].concat();
            let pty = self.live(id)?;
            let offset = pty.end();
            if let Err(error) = pty.write(&bytes) {
                // A partial write must not leave the agent inside the paste; best effort, the send fails anyway.
                let _ = pty.write(b"\x1b[201~");
                self.entry(id)?.input.mark_uncertain();
                return Err(error);
            }
            self.entry(id)?.input = typed;
            self.pending_enter.insert(
                id.into(),
                PendingEnter {
                    send: send.id.clone(),
                    input,
                    offset,
                    written: std::time::Instant::now(),
                    last: offset,
                    quiet: std::time::Instant::now(),
                    held: false,
                },
            );
            return Ok(true);
        }
        if send.submit {
            bytes.push(b'\r');
        }
        // Ticket 1137: read before the write, whose echo is output too.
        let waiting = self.live(id)?.end() == 0;
        if let Err(error) = self.live(id)?.write(&bytes) {
            self.entry(id)?.input.mark_uncertain();
            return Err(error);
        }
        // Ticket 1137: the line waits in the terminal's input (written once, never again); the shell starts now and
        // reads it. shortcut: a shell that started but has drawn nothing yet keeps an empty `<id>.go` file; harmless.
        if let Some(go) = self.size_waits.remove(id)
            && waiting
        {
            // create_new: never opens what is already there (a FIFO would block this open under the registry lock,
            // a symlink would be followed); anything already there ends the wait the same way.
            let _ = fs::OpenOptions::new().write(true).create_new(true).open(go);
        }
        self.entry(id)?.input = input;
        if send.submit && send.keys.is_empty() {
            self.submitted(id, &send.content);
        }
        if self.entry(id)?.meta.kind != AgentKind::Shell
            && (send.submit || send.keys.iter().any(|k| k.eq_ignore_ascii_case("enter")))
        {
            self.delivery_inflight
                .insert(id.into(), self.queue.attention(id).completion_seq);
            self.inflight_at
                .insert(id.into(), std::time::Instant::now());
        }
        Ok(false)
    }
    fn agent_keys(&mut self, sender: &str, id: &str, keys: Vec<String>, enabled: bool) -> Response {
        self.refresh()?;
        self.observe()?;
        self.touch_input(id); // ticket 992: keys from any caller may change the input box
        // V2-4a: an ACP agent has no screen: keys never answer its items (Esc cancels the turn).
        if self.entry(id)?.acp.is_some() {
            return self.send(sender, id, String::new(), keys, false);
        }
        self.current(id)?; // v1a-19 r2
        let decision = self
            .queue
            .items()
            .into_iter()
            .find(|p| {
                p.session_id == id
                    && matches!(
                        p.kind,
                        queue::Kind::Dialog | queue::Kind::Permission | queue::Kind::Question
                    )
            })
            .map(|d| self.annotated(d)); // V2-8e
        if let Some(item) = decision {
            let answer =
                if keys.len() == 1 && matches!(keys[0].to_lowercase().as_str(), "esc" | "escape") {
                    queue::Answer::Deny
                } else {
                    let index = item
                        .choices
                        .iter()
                        .position(|c| c.keys == keys && !c.changes_settings)
                        .ok_or("agent_blocked: unverified answer keys")?;
                    if item.kind == queue::Kind::Permission {
                        // v1b-12: one rule, queue::Choice::allows_once (changes_settings is excluded above).
                        if !item.choices[index].allows_once() {
                            return Err("permission requires verified allow_once or Esc".into());
                        }
                        queue::Answer::AllowOnce
                    } else {
                        queue::Answer::Choose { index }
                    }
                };
            crate::grants::check_answer(&item, &answer, enabled)?;
            let send = self.begin_send(sender, id, String::new(), keys, false, "attempting")?;
            let result = self.answer(&item.id, answer, false);
            self.finish_send(
                id,
                &send.id,
                if result.is_ok() {
                    "delivered"
                } else {
                    "failed"
                },
            )?;
            return result;
        }
        self.send(sender, id, String::new(), keys, false)
    }
    /// v1a-24 r4: the pending-Enter pass of `flush_delivery`, run on the screen its `observe` just fed; gives the
    /// sessions it handled (they take no other queued send this tick).
    fn flush_enters(&mut self) -> Result<std::collections::BTreeSet<String>, String> {
        let mut delivered = std::collections::BTreeSet::new();
        // v1a-15: write each pending Enter once the agent echoed the paste into its composer, or at the settle
        // deadline when nothing was drawn since the paste; the session takes no other queued send this tick.
        // The override has a floor: an Enter right behind the paste is the bug this exists to avoid.
        let settle = std::env::var("NUNCHIRO_SETTLE_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map_or(SETTLE, |ms: u64| {
                std::time::Duration::from_millis(ms.max(250))
            });
        for id in self.pending_enter.keys().cloned().collect::<Vec<_>>() {
            delivered.insert(id.clone());
            let Some(meta) = self.entries.get(&id).map(|e| e.meta.clone()) else {
                self.pending_enter.remove(&id);
                continue;
            };
            let snapshot = self.snapshot_session(&meta);
            let offset = self.entries[&id].observer.output_offset;
            let enter = self.pending_enter.get_mut(&id).unwrap();
            if offset != enter.last {
                (enter.last, enter.quiet) = (offset, std::time::Instant::now());
            }
            // v1a-24 r3: the screen is read only once the output stayed quiet; a frame may land in more than one
            // read (the box first, a dialog under it after).
            let settled = enter.quiet.elapsed() >= SWITCH_SETTLE;
            let entry = &self.entries[&id];
            let live = entry.agent_live(); // ticket 286: an Enter is never written into the shell an agent left
            let enter = &self.pending_enter[&id];
            // Echo counts once observe fed it, so the activity it caused is behind the baseline below.
            let echoed = entry.observer.output_offset > enter.offset;
            let late = enter.written.elapsed() >= settle;
            let screen = entry.observer.screen.text();
            // v1a-20: only the composer showing this paste counts; a dialog cursor row (`❯ 1. Yes`) does not.
            let paste = meta
                .send_queue
                .iter()
                .find(|s| s.id == enter.send)
                .map_or("", |s| s.content.as_str());
            // An answer that goes into a running turn (`steers`): a working Codex redraws about 30 times a second, so
            // its output is never quiet. The input box showing the paste on an earlier pass and on this one stands in
            // for the quiet: a frame cut in two by a read is whole by the next pass.
            let steer = self.steers.contains(&enter.send);
            // Ticket 1121: the box showed the paste on an earlier pass and now shows exactly it, every row, past the
            // settle time: the Enter goes though the output is never quiet (an animated footer row redraws while
            // the agent is idle; the paste was dropped after PASTE_WAIT and sat typed in the box). Output not read yet
            // still holds it back (review r2): a dialog or a draft drawn in it would take the Enter.
            let proven = enter.held
                && late
                && box_text(&screen, meta.kind).is_some_and(|t| same_words(&t, paste));
            let holding = (settled || steer && enter.held || proven)
                && composer(&screen, meta.kind).is_some_and(|c| holds_paste(&c, paste));
            // The composer shows words that are not this paste. An empty composer, or none on the screen, is a paste
            // not drawn yet: on a loaded machine Claude drew it after the settle deadline, the Enter was dropped and
            // the prompt sat unsent (real run 11-17), so that case waits `PASTE_WAIT` settle times.
            let other = settled
                && composer(&screen, meta.kind)
                    .is_some_and(|c| !c.trim().is_empty() && !holds_paste(&c, paste));
            let shows = composer(&screen, meta.kind).is_some_and(|c| holds_paste(&c, paste));
            let held = enter.held || shows;
            // The agent began a turn between the paste and its Enter (a wake line that followed another by a
            // moment): nothing is judged while it works. The screen of a working agent is not its composer, so the
            // paste read as lost and the Enter was dropped; the words then stayed in the lead's composer, every later
            // wake line was pasted behind them and dropped too, and the lead heard nothing more (real runs 11-17, six
            // workers ending together). The Enter goes when the turn has ended and the composer holds the paste.
            if live && snapshot.attention.working && !steer {
                continue;
            }
            // Enter on anything but the composer answers it: a dialog's default choice (approve), the picker's
            // model. Such a send is never submitted later.
            let dropped = if !live {
                None
            } else if crate::delivery::blocked(&snapshot.pending) {
                Some("enter_dropped_blocked")
            } else if entry.switch.is_some() {
                Some("enter_dropped_switch")
            } else if screen.lines().any(|l| l.trim() == "Select model") {
                Some("enter_dropped_picker")
            } else if entry.observer.behind {
                // v1a-19 r2: the screen is not current; a dialog may sit in the unfed output.
                (enter.written.elapsed() >= ENTER_CATCH_UP).then_some(BEHIND)
            } else if echoed
                && !holding
                && late
                && (other
                    || held && settled && !shows
                    // A dialog is on the screen: the paste will not show under it (as before, same mark).
                    || dialog_up(&screen, meta.kind)
                    || enter.written.elapsed() >= settle * PASTE_WAIT)
            {
                // The composer holds other words, showed the paste and lost it, or the paste never showed.
                Some("enter_dropped_composer")
            } else if late && dialog_up(&screen, meta.kind) {
                // Ticket 991 (B1): no echo and a dialog on the screen: the deadline's Enter would answer it.
                Some("enter_dropped_blocked")
            } else {
                None
            };
            // v1a-24 r4: output that arrived after this pass's read is unread; the next pass decides on it. What is
            // left is the time from this check to the write below (no screen work between).
            let unread = entry
                .pty
                .as_ref()
                .is_some_and(|pty| pty.end() != entry.observer.output_offset);
            if live
                && dropped.is_none()
                && (entry.observer.behind
                    || unread
                    || !(echoed && holding) && !late
                    // Echo of something, the paste not in the composer yet: wait for it (the drop above ends the wait).
                    || echoed && !holding)
            {
                if shows {
                    self.pending_enter.get_mut(&id).unwrap().held = true;
                }
                continue;
            }
            let enter = self.pending_enter.remove(&id).unwrap();
            let entry = self.entry(&id)?;
            // A stop or restore already finished the row; nothing is left to write.
            let Some(row) = entry
                .meta
                .send_queue
                .iter_mut()
                .find(|s| s.id == enter.send)
            else {
                continue;
            };
            if !live {
                // Ticket 999: nothing is written, so the cancel waits for the delivery pass's one save.
                self.mark_send(&id, &enter.send, "canceled")?;
                self.unsaved
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                continue;
            }
            if let Some(reason) = dropped {
                eprintln!("session {id} Enter dropped: {reason}");
                // Ticket 1085: an automatic line (a wake line, the room's notice, the core's heartbeat) stays typed in the
                // box. It is cleared before the next submit, and the row waits in the queue once more: the owner's next
                // message was typed behind it and both went in as one.
                let automatic = row.sender != "user";
                // Ticket 1094 r3: only a mark every core loads is saved (an unknown one stopped the next start). BEHIND is
                // logged only; the user's row then reads as a composer drop, which the composer shows the same way.
                row.settle = crate::delivery::saved_mark(reason)
                    .or_else(|| (!automatic).then(|| "enter_dropped_composer".into()));
                self.left_typed.insert(id.clone());
                let again = automatic && self.retried.insert(enter.send.clone());
                // Ticket 1094: the user's own message is never left failed out of sight with its words typed in the
                // box (his next send went in glued behind them, three copies at once), whatever the reason of the
                // drop. It waits in the queue, which the composer shows (`settle` names the drop). The first drop
                // tries again at the next ready pass; each later one waits RETRY_FIRST, doubling up to RETRY_MAX, so
                // it is never pasted again and again into a box that keeps refusing it, and never waits for ever.
                if !automatic {
                    self.copy_left.insert(id.clone(), enter.send.clone());
                    self.hand_typed.insert(id.clone(), Some(String::new()));
                    let n = self.drops.entry(enter.send.clone()).or_insert(0);
                    *n = n.saturating_add(1);
                    if *n > 1 {
                        let wait = RETRY_FIRST
                            .saturating_mul(1 << (*n - 2).min(8))
                            .min(RETRY_MAX);
                        self.retry_at
                            .insert(enter.send.clone(), std::time::Instant::now() + wait);
                    }
                }
                let project = self.entry(&id)?.meta.project.clone();
                crate::events::send_dropped(&project, &id, reason, again || !automatic); // ticket 1130 C-C3
                self.finish_send(
                    &id,
                    &enter.send,
                    if again || !automatic {
                        "queued"
                    } else {
                        "failed"
                    },
                )?;
                continue;
            }
            if let Err(error) = self.live(&id)?.write(b"\r") {
                eprintln!("session {id} Enter write failed: {error}");
                self.entry(&id)?.input.mark_uncertain();
                self.finish_send(&id, &enter.send, "failed")?;
                continue;
            }
            let attention = self.queue.attention(&id);
            let entry = self.entry(&id)?;
            entry.input = enter.input;
            // The turn starts at the Enter: the paste's echo is not the agent working on it.
            if let Some(row) = entry
                .meta
                .send_queue
                .iter_mut()
                .find(|s| s.id == enter.send)
            {
                row.completion_seq = attention.completion_seq;
                row.last_activity = attention.last_activity;
                if !echoed {
                    row.settle = crate::delivery::saved_mark("settle_timeout");
                }
            }
            self.delivery_inflight
                .insert(id.clone(), attention.completion_seq);
            self.inflight_at
                .insert(id.clone(), std::time::Instant::now());
            self.submitted(&id, paste);
            self.finish_send(&id, &enter.send, "delivered")?;
        }
        Ok(delivered)
    }
    /// Ticket 1094: the core's own evidence over a lost signal. A Claude the queue reads as working whose screen shows
    /// its input box with no "esc to interrupt" footer, that drew nothing and reported nothing for IDLE_SETTLE_MS, and
    /// that asks nothing, has ended its turn: a hook the core refused, a prompt replayed from the journal after a
    /// restart (its Stop never journaled), a turn end in a shape this build does not read. A working Claude draws its
    /// spinner many times a second, so it never stays still that long.
    fn settle_idle(&mut self) -> Result<(), String> {
        let now = queue::now_ms();
        let idle: Vec<String> = self
            .entries
            .iter()
            .filter(|(id, e)| {
                let a = self.queue.attention(id);
                e.meta.kind == AgentKind::Claude
                    && e.acp.is_none()
                    && e.agent_live()
                    && !e.observer.behind
                    && a.working
                    && now.saturating_sub(a.last_activity) >= IDLE_SETTLE_MS
                    && !self.pending_enter.contains_key(*id)
                    && !crate::delivery::blocked(&self.queue.items_of(id))
                    && interrupted_at_prompt(&e.observer.screen.text())
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            self.queue
                .observe(&id, "Interrupted", &serde_json::json!({}), "screen", now)?;
        }
        Ok(())
    }
    /// Ticket 1094 r4: the user's queued row whose dropped paste the core left in session `id`'s box (r5:
    /// `copy_left`, not cleared or pasted over since) and that the box still shows, word for word. His own Enter in the
    /// terminal sends it with his words; sent again by the core, the agent got his message twice. A screen that is
    /// behind proves nothing, so then none: the row goes once more, never lost.
    fn taken_by_hand(&self, id: &str) -> Vec<String> {
        let Some(e) = self.entries.get(id) else {
            return vec![];
        };
        let Some(left) = self.copy_left.get(id) else {
            return vec![];
        };
        let Some(Some(typed)) = self.hand_typed.get(id) else {
            return vec![];
        };
        if e.meta.kind != AgentKind::Claude || e.observer.behind {
            return vec![];
        }
        let Some(c) = composer(&e.observer.screen.text(), e.meta.kind) else {
            return vec![];
        };
        e.meta
            .send_queue
            .iter()
            .filter(|s| {
                &s.id == left
                    && s.status == "queued"
                    && s.sender == "user"
                    && proven_copy(&c, &s.content, typed)
            })
            .map(|s| s.id.clone())
            .collect()
    }
    /// Ticket 1121: the core's dropped copy may be in session `id`'s box (`left_typed`, `copy_left`) and the screen
    /// reads no box, so a clear before a paste would write no Ctrl+U.
    fn unread_copy(&self, id: &str) -> bool {
        (self.left_typed.contains(id) || self.copy_left.contains_key(id))
            && self
                .entries
                .get(id)
                .is_some_and(|e| composer(&e.observer.screen.text(), e.meta.kind).is_none())
    }
    /// Ticket 1094 r5: the dropped copy can no longer be in session `id`'s box.
    fn copy_gone(&mut self, id: &str) {
        self.copy_left.remove(id);
        self.hand_typed.remove(id);
    }
    /// Ticket 1094 r6: a dropped row his own Enter sent with a proven box is delivered once a turn starts after that
    /// Enter (its start time, or more turn ends than the one running then). With no such turn by the time the agent is
    /// idle HAND_PROOF after the Enter, the proof failed: the row stays queued and goes again (one extra copy at worst,
    /// never a message shown delivered that the agent did not get).
    fn settle_hand_sent(&mut self) -> Result<(), String> {
        for id in self.hand_sent.keys().cloned().collect::<Vec<_>>() {
            let (send, seq, working, at_ms, at) = self.hand_sent[&id].clone();
            let queued = self.entries.get(&id).is_some_and(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .any(|s| s.id == send && s.status == "queued")
            });
            let a = self.queue.attention(&id);
            let started = a.working && a.working_since >= at_ms
                || a.completion_seq > seq + u64::from(working);
            if !queued || started || !a.working && at.elapsed() >= HAND_PROOF {
                self.hand_sent.remove(&id);
            }
            if queued && started {
                self.finish_send(&id, &send, "delivered")?;
            }
        }
        Ok(())
    }
    /// Ticket 1094 r4: session `id`'s screen shows its input box, and the box is empty.
    fn box_empty(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| {
            composer(&e.observer.screen.text(), e.meta.kind).is_some_and(|c| c.trim().is_empty())
        })
    }
    /// Ticket 1094: whether session `id` may take its next queued send. A delivery is in flight until a turn ends
    /// after it, or until the agent, with no turn running, shows its input box INFLIGHT_IDLE after the write: an idle
    /// agent that took no turn from it (a dropped or refused submit) never holds every later send for ever.
    fn delivery_open(&self, id: &str, snapshot: &Session) -> bool {
        let now = std::time::Instant::now();
        self.delivery_inflight
            .get(id)
            .is_none_or(|seq| snapshot.completion_seq > *seq)
            || !snapshot.attention.working
                && self
                    .inflight_at
                    .get(id)
                    .is_some_and(|t| now.duration_since(*t) >= INFLIGHT_IDLE)
                && self
                    .entries
                    .get(id)
                    .is_some_and(|e| composer(&e.observer.screen.text(), e.meta.kind).is_some())
    }
    /// N1: the core wrote `text` and its Enter into session `id`'s input box; `verify_submits` looks once more.
    fn submitted(&mut self, id: &str, text: &str) {
        let agent = self.entries.get(id).is_some_and(|e| {
            e.acp.is_none() && matches!(e.meta.kind, AgentKind::Claude | AgentKind::Codex)
        });
        if !agent || text.trim().is_empty() {
            return;
        }
        let now = std::time::Instant::now();
        self.submitted.insert(
            id.into(),
            Submitted {
                text: text.into(),
                seq: self.queue.attention(id).completion_seq,
                at: now,
                tries: 0,
                last: 0,
                quiet: now,
            },
        );
    }
    /// Look 11-17 v8 N1: a submit is checked, not assumed. `SUBMIT_CHECK` after its Enter, with no turn begun (no hook,
    /// no finished turn) and the input box on a still, current screen holding exactly the words the core sent, Enter
    /// goes once more; `SUBMIT_TRIES` times at most. The words are never typed again. Anything else ends the check: a
    /// turn, a question, an empty box or one with other words (the user's own), a key or text from the user or an agent
    /// (`write_send`, `SendText`, `SendKeys` drop it), a model switch or mode walk.
    fn verify_submits(&mut self) {
        for id in self.submitted.keys().cloned().collect::<Vec<_>>() {
            let a = self.queue.attention(&id);
            let blocked = crate::delivery::blocked(&self.queue.items_of(&id));
            let hold = self.walk_hold(&id);
            let check = self.submitted.get_mut(&id).unwrap();
            let Some(entry) = self.entries.get(&id) else {
                self.submitted.remove(&id);
                continue;
            };
            if !entry.agent_live()
                || a.working
                || a.completion_seq != check.seq
                || blocked
                || hold
                || entry.switch.is_some()
                || self.pending_enter.contains_key(&id)
            {
                self.submitted.remove(&id);
                continue;
            }
            let offset = entry.observer.output_offset;
            if offset != check.last {
                (check.last, check.quiet) = (offset, std::time::Instant::now());
            }
            if check.at.elapsed() < SUBMIT_CHECK {
                continue;
            }
            let current = !entry.observer.behind
                && entry.pty.as_ref().is_some_and(|pty| pty.end() == offset)
                && check.quiet.elapsed() >= SWITCH_SETTLE;
            if !current {
                // An agent that never stops drawing: the check ends unread (as before this check existed).
                if check.at.elapsed() >= SUBMIT_CHECK * 5 {
                    self.submitted.remove(&id);
                }
                continue;
            }
            let holds = box_text(&entry.observer.screen.text(), entry.meta.kind)
                .is_some_and(|shown| same_words(&shown, &check.text));
            if !holds {
                self.submitted.remove(&id);
                continue;
            }
            if check.tries == SUBMIT_TRIES {
                eprintln!(
                    "session {id}: the prompt is still in the input box after {SUBMIT_TRIES} more Enters"
                );
                self.submitted.remove(&id);
                continue;
            }
            (check.tries, check.at) = (check.tries + 1, std::time::Instant::now());
            eprintln!(
                "session {id}: Enter not taken, pressed again ({})",
                check.tries
            );
            if self.live(&id).and_then(|pty| pty.write(b"\r")).is_err() {
                self.submitted.remove(&id);
            }
        }
    }
    /// One delivery pass on freshly read state, as a tick runs it (tests drive it directly; ticket 1081's resend).
    fn flush_delivery(&mut self) -> Result<(), String> {
        self.refresh()?;
        self.observe()?;
        self.deliver()?;
        self.save_unsaved()
    }
    /// The delivery step of `flush_delivery`, on state already read; true when it wrote, held an Enter or canceled.
    /// A cancel is left `unsaved` for the caller's save (ticket 999).
    fn deliver(&mut self) -> Result<bool, String> {
        // Ticket 300 step 2: each session's queued sends, in queue order, worked as that session's own queue (as each
        // herdr pane's actor owns its input queue): an ended session's cancel walks its own rows only.
        // V2.5-85: only the ids of sessions with a queued row are collected; rows are read in place where the walk
        // reaches them (herdr's `flush_pending_writes_once` peeks at its queue's front), and only the row being
        // written is copied. The tick runs every 50 ms and most ticks write nothing.
        let ids: Vec<String> = self
            .entries
            .values()
            .filter(|e| e.meta.send_queue.iter().any(|s| s.status == "queued"))
            .map(|e| e.meta.id.clone())
            .collect();
        let entries = &self.entries;
        self.deny_notes.retain(|send| {
            entries.values().any(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .any(|s| s.status == "queued" && &s.id == send)
            })
        });
        let waits = |send: &String| {
            entries
                .values()
                .any(|e| e.meta.send_queue.iter().any(|s| &s.id == send))
        };
        self.steers.retain(waits);
        self.wake_rows.retain(waits);
        self.core_rows.retain(waits);
        self.joined_rows.retain(|send, _| waits(send));
        self.retried.retain(waits);
        self.drops.retain(|send, _| waits(send));
        self.retry_at.retain(|send, _| waits(send));
        self.copy_left.retain(|_, send| waits(send));
        self.spent.retain(waits);
        self.clean_wait.retain(|send, _| waits(send));
        // Round 6: in-flight times of sessions that are gone (one per session ever started otherwise).
        let live = &self.entries;
        self.inflight_at.retain(|id, _| live.contains_key(id));
        let left = &self.copy_left;
        self.hand_typed.retain(|id, _| left.contains_key(id));
        self.settle_hand_sent()?;
        self.verify_submits();
        let mut delivered = self.flush_enters()?;
        let mut canceled = false;
        for id in ids {
            // v1a-10: queued sends wait until a model switch has finished.
            // CHAT-MODELIST r2: and until a mode walk has ended.
            if delivered.contains(&id) || self.entry(&id)?.switch.is_some() || self.walk_hold(&id) {
                continue;
            }
            if !self.entry(&id)?.agent_live() {
                // Ticket 286: also the queue of an agent that quit and left its shell.
                // Ticket 300: out of the queue now, in queue order; saved once by the caller (ticket 999: the tick's one
                // save, or `flush_delivery`'s), or sooner by the "attempting" save of a later send. A save per row held
                // the registry lock for seconds when an agent exited with a long queue. Until that save lands (a crash),
                // the file still lists them queued, and a restart cancels queued rows anyway (`cancel_queue`).
                self.cancel_own_queue(&id)?;
                canceled = true;
                continue;
            }
            // Ticket 300: the session's readiness, read once from one snapshot (a copy per send was quadratic in the
            // queue): nothing below changes it before a write, and a write ends the session's turn this tick.
            let mut ready = None;
            // The row under the walk; a canceled row leaves the queue, so the next one moves into its place.
            let mut at = 0;
            while let Some(send) = self.entries[&id].meta.send_queue.get(at) {
                if send.status != "queued" {
                    at += 1;
                    continue;
                }
                let refused = self.send_refused(&id, send);
                // V2-8e: a deny instruction is never typed while any prompt shows (the denied one may not have redrawn
                // yet, and an answered prompt is not filed again): typed there, its Enter would pick an option.
                let note = self.deny_notes.contains(&send.id);
                let steer = self.steers.contains(&send.id);
                // Another session's line waits while the box holds words or keys typed by hand: written, it would be
                // refused (`delivery::EDITED`) and lost. After a Stop the next submit clears the box itself.
                // Ticket 1094 r3: so does the user's own row once its Enter was dropped: pasted again behind his hand-typed
                // words (the box is not cleared then), it went in glued to its own earlier copy.
                // r4: an empty box holds none of his words (a raw key such as a dialog's digit also marks it edited).
                let edited = (send.sender != "user"
                    || self.drops.contains_key(&send.id) && !self.box_empty(&id))
                    && send.submit
                    && self.box_edited(&id)
                    && !self.entries[&id].observer.clear_box;
                // Ticket 1094 r3: a user row dropped again waits out its own retry time; his newer messages go meanwhile.
                let later = self
                    .retry_at
                    .get(&send.id)
                    .is_some_and(|t| std::time::Instant::now() < *t)
                    // r6: his own Enter may have sent it; it waits for the proof (`settle_hand_sent`).
                    || self.hand_sent.get(&id).is_some_and(|h| h.0 == send.id);
                // Ticket 1121: the drops so far of a row whose Enter was dropped, and its words (the guard below).
                let again = (self.drops.get(&send.id).copied())
                    .or_else(|| self.retried.contains(&send.id).then_some(1))
                    .map(|n| (n, send.content.clone()));
                // The guard also holds any later submit while the box may still hold the core's dropped copy: pasted
                // into a box the screen does not read, the clear writes no Ctrl+U and the new words glue to that copy.
                // A stopped row stays stopped though a later send cleared the copy tracking (review r2).
                let guard = (again.is_some()
                    || self.spent.contains(&send.id)
                    || send.submit
                        && (self.left_typed.contains(&id) || self.copy_left.contains_key(&id)))
                .then(|| (send.id.clone(), send.sender != "user"));
                if refused {
                    let send_id = send.id.clone();
                    self.mark_send(&id, &send_id, "canceled")?;
                    canceled = true;
                    continue; // no `at += 1`: the row left the queue and the next one moved into its slot
                }
                let entry = self.entry(&id)?;
                if edited
                    || later
                    || note
                        && entry.acp.is_none()
                        && entry.observer.screen.detect(entry.meta.kind).is_some()
                {
                    at += 1;
                    continue;
                }
                if ready.is_none() {
                    let snapshot = self.snapshot_session(&self.entries[&id].meta);
                    ready = Some(
                        !self.entry(&id)?.observer.behind // v1a-19 r2
                            && self.send_ready(&id, &snapshot)?
                            && self.delivery_open(&id, &snapshot),
                    );
                }
                // An answer to an async question needs only the input box: its turn runs while it waits for the answer.
                if ready == Some(false) && !(steer && self.steer_ready(&id)?) {
                    at += 1;
                    continue;
                }
                // Ticket 1121: a row whose Enter was dropped goes again only into a box the screen reads, free of its
                // earlier copy. Pasted while the box was unread (the clear then wrote no Ctrl+U), the agent got it glued
                // behind that copy, six times over. The copy is cleared and the paste waits for a pass that reads the
                // box without it. A row past REPASTES drops, or with no clean box read for CLEAN_WAIT, is stopped:
                // never pasted again; the user's row waits in the queue (the composer says so), an automatic one fails.
                if let Some((send_id, automatic)) = guard {
                    let (n, content) = again.unwrap_or_default();
                    let shown = composer(
                        &self.entries[&id].observer.screen.text(),
                        self.entries[&id].meta.kind,
                    );
                    let copy = n > 0 && shown.as_ref().is_some_and(|c| holds_paste(c, &content));
                    if copy {
                        self.entry(&id)?.observer.clear_box = true;
                        self.clear_box_first(&id)?;
                    }
                    let clean = shown.is_some() && !copy;
                    if n > REPASTES {
                        self.spent.insert(send_id.clone());
                    } else if !clean {
                        // The wait counts while the row keeps reaching this guard; a pause (a turn, a dialog) starts it again.
                        let now = std::time::Instant::now();
                        let wait = self.clean_wait.entry(send_id.clone()).or_insert((now, now));
                        *wait = if now.duration_since(wait.1) > CLEAN_GAP {
                            (now, now)
                        } else {
                            (wait.0, now)
                        };
                        if now.duration_since(wait.0) >= CLEAN_WAIT {
                            self.spent.insert(send_id.clone());
                        }
                    }
                    if self.spent.contains(&send_id) && automatic {
                        self.mark_send(&id, &send_id, "failed")?;
                        canceled = true;
                        continue; // no `at += 1`: the row left the queue
                    }
                    if self.spent.contains(&send_id) || !clean {
                        at += 1;
                        continue;
                    }
                    self.clean_wait.remove(&send_id);
                }
                let mut row = self.entries[&id].meta.send_queue[at].clone();
                // Ticket 1056: queued wake lines go out together as one message, one line per worker; a line whose
                // worker was closed, or whose task is closed, is dropped.
                let mut joined = Vec::new();
                if self.wake_rows.contains(&row.id) {
                    if self.row_gone(&id, &row) {
                        self.mark_send(&id, &row.id, "canceled")?;
                        canceled = true;
                        continue;
                    }
                    let rest: Vec<_> = self.entries[&id]
                        .meta
                        .send_queue
                        .iter()
                        .filter(|s| {
                            s.id != row.id
                                && s.status == "queued"
                                && self.wake_rows.contains(&s.id)
                                && !self.send_refused(&id, s)
                        })
                        .cloned()
                        .collect();
                    for s in rest {
                        let (send, content) = (s.id.clone(), s.content.clone());
                        if self.row_gone(&id, &s) {
                            self.mark_send(&id, &send, "canceled")?;
                            canceled = true;
                            continue;
                        }
                        // The batch stays inside the send limit; the lines after it go in the next one, in order.
                        if row.content.len() + 1 + content.len() > crate::delivery::SEND_LIMIT {
                            break;
                        }
                        row.content.push('\n');
                        row.content.push_str(&content);
                        joined.push(send);
                    }
                    // The queue row carries the whole text: the paste check of its Enter reads it there.
                    if let Some(queued) = self
                        .entry(&id)?
                        .meta
                        .send_queue
                        .iter_mut()
                        .find(|s| s.id == row.id)
                    {
                        queued.content = row.content.clone();
                    }
                    for send in &joined {
                        self.mark_send(&id, send, "attempting")?;
                    }
                    // A row put back in the queue (an edited box) keeps the lines it already carries.
                    self.joined_rows
                        .entry(row.id.clone())
                        .or_default()
                        .extend(joined);
                }
                #[cfg(test)]
                self.send_clones
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.finish_send(&id, &row.id, "attempting")?;
                let result = self.write_send(&id, &row);
                // v1a-15: a pasted submit stays attempting until a later tick writes its Enter.
                if result != Ok(true) {
                    let status = match &result {
                        Ok(_) => "delivered",
                        // Refused for the box as it is, before a byte was written: it waits on (the hold above).
                        Err(e) if e == crate::delivery::EDITED && self.box_edited(&id) => "queued",
                        Err(_) => "failed",
                    };
                    self.finish_send(&id, &row.id, status)?;
                }
                // One send per session per tick leaves time for the agent to report it is working.
                delivered.insert(id.clone());
                break;
            }
        }
        if canceled {
            self.unsaved
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(canceled || !delivered.is_empty())
    }
    /// A queued row the flush cancels: its sender no longer owns the target, or a widget act lost its grant.
    fn send_refused(&self, id: &str, send: &crate::delivery::Send) -> bool {
        // Ticket 1081: the core's own line has no sender to check; `core_may` checks its target right before the write.
        if self.core_rows.contains(&send.id) {
            return false;
        }
        let caller = self
            .entries
            .get(&send.sender)
            // Ticket 286: a sender whose agent quit sends nothing more (its finish line is the core's).
            .filter(|e| e.agent_live() || self.wake_rows.contains(&send.id))
            // Ticket 573 round 6 (review r5 NOTE 3): a token session's send, while its token is live.
            .filter(|e| {
                self.token_origin(&e.meta)
                    .is_none_or(|t| crate::tokens::by_caller(&self.home, &t).is_some())
            })
            .map(|e| crate::grants::Caller {
                id: send.sender.clone(),
                project: e.meta.project.clone(),
            })
            // v1a-06: SSH callers have no PTY entry in this core. Ticket 76: a local stamp is never satisfied by
            // a peer that forwards under the same id after the local session is gone.
            // Ticket 573: an outside token's send, while the token is live.
            .or_else(|| self.token_sender(&send.sender))
            .or_else(|| {
                if send.remote == Some(false) {
                    return None;
                }
                self.remote
                    .callers
                    .get(&send.sender)
                    .map(|c| crate::grants::Caller {
                        id: c.id.clone(),
                        project: c.project.clone(),
                    })
            });
        // v1b-20
        let widget = crate::delivery::widget_sender(&send.sender).then(|| {
            self.widget_hashes
                .get(&send.id)
                .is_some_and(|hash| self.widget_act_current(&send.sender, hash).is_ok())
        });
        widget == Some(false)
            || (widget.is_none()
                        && send.sender != "user"
                        // Ticket 76: the flag stamped at queue time decides; a row without one fails closed.
                        && caller.as_ref().is_none_or(|c| {
                            send.remote.is_none_or(|remote| {
                                !self.grants.owns_as(remote, c, &self.entries[id].meta)
                            })
                        }))
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
    pub(crate) fn transcript_read(
        &mut self,
        id: &str,
        lines: usize,
    ) -> Result<crate::delivery::TranscriptRead, String> {
        if lines == 0 || lines > 10000 {
            return Err("lines must be 1..10000".into());
        }
        let entry = self.entry(id)?;
        Ok(crate::delivery::TranscriptRead {
            session: entry.meta.clone(),
            path: entry.observer.transcript.clone(),
            lines,
        })
    }
    pub(crate) fn transcript_read_current(&self, plan: &crate::delivery::TranscriptRead) -> bool {
        self.entries.get(&plan.session.id).is_some_and(|entry| {
            entry.meta.project == plan.session.project
                && entry.meta.cwd == plan.session.cwd
                && entry.meta.agent_session_id == plan.session.agent_session_id
                && entry.observer.transcript == plan.path
        })
    }
    fn agent_read(&mut self, id: &str, source: &str, lines: usize) -> Response {
        if lines == 0 || lines > 10000 {
            return Err("lines must be 1..10000".into());
        }
        let text = match source {
            "screen" => self.entry(id)?.observer.screen.text(),
            "transcript" => return Err("transcript read requires off-lock preparation".into()),
            _ => return Err("unknown read source".into()),
        };
        let rows: Vec<_> = text.trim_end().lines().collect();
        Ok(Reply::Text {
            text: rows[rows.len().saturating_sub(lines)..].join("\n"),
        })
    }
    /// Q10: a row of this core (a pushed remote row of the same id never takes its place).
    pub(crate) fn is_local(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
    fn entry(&mut self, id: &str) -> Result<&mut Entry, String> {
        self.entries
            .get_mut(id)
            .ok_or_else(|| "session not found".into())
    }
    fn live(&mut self, id: &str) -> Result<&mut Pty, String> {
        self.entry(id)?
            .pty
            .as_mut()
            .ok_or_else(|| "session is not running".into())
    }
    /// Window terminal stream: replay bytes only, without the refresh and screen observation that
    /// `handle` runs (the core tick already does both every 50 ms).
    pub(crate) fn output(&self, id: &str, after: u64) -> Response {
        read_replay(
            &self.home,
            self.entries.get(id).ok_or("session not found")?,
            after,
        )
    }
    /// v1a-27: lets a window loop see new output for `id` without taking the registry.
    pub(crate) fn tail(&self, id: &str) -> Option<crate::pty::Tail> {
        let entry = self.entries.get(id)?;
        match &entry.pty {
            Some(pty) => Some(pty.tail()),
            None => entry.saved.get()?.as_ref().map(|s| s.tail()), // v1a-40
        }
    }
    /// Ticket 1113: a current local lead reaches only its own place, including Home. Nothing a lead
    /// says about a target counts as no-work evidence; only this registry's untouched startup state does.
    fn tidy_session(
        &mut self,
        caller: &crate::grants::Caller,
        id: &str,
        why: &str,
        now: u64,
    ) -> Response {
        let reach = self
            .schedule_reach(caller)?
            .unwrap_or_else(|| crate::team::Team::open(&self.home).home());
        let target = self.entries.get(id).ok_or("session not found")?;
        if target.meta.machine.is_some() || self.room_project(id).as_ref() != Some(&reach) {
            return Err("a lead tidies only local sessions in its place".into());
        }
        let why = queue::deny_note(why);
        if why.trim().is_empty() {
            return Err("say why this session should close (--why)".into());
        }
        let (label, place) = (target.meta.label.clone(), target.meta.project.clone());
        let who = self.task_caller(Some(caller), None)?;
        let lead = who.lead.ok_or("no lead for this session")?;
        let room = who.place.ok_or("no place for this session")?;
        let from = who.name;
        if self.empty_session(id, now) {
            self.close(id, false, false)?;
            let body = format!(
                "Closed empty session {label} ({id}) · {}: {why}",
                place.display()
            );
            self.team_note(
                &room,
                &lead,
                Some(&caller.id),
                body.clone(),
                crate::room::TeamNote {
                    what: "session_empty_closed".into(),
                    worktree: None,
                    // The room renders this field; keep the reason visible as well as in its stored body.
                    name: Some(format!("{label}: {why}")),
                    branch: None,
                    merged: None,
                    seat: None,
                },
            );
            return Ok(Reply::Text { text: body });
        }
        let card = self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::SessionClose {
                from,
                target: id.into(),
                label: label.clone(),
                place,
                why,
            },
        )?;
        Ok(Reply::Text {
            text: format!(
                "Asked the owner to close {label} ({id}), card {card}. It stays open until their Close."
            ),
        })
    }
    /// Positive evidence only: a first-run theme picker in a fresh Claude start with no input or conversation.
    /// The lead approved ten minutes idle instead of adding a focused-pane feed (plan checkpoint m1576).
    /// After a restart `before_box` is false, so missing in-memory evidence always takes the card path.
    fn empty_session(&self, id: &str, now: u64) -> bool {
        let Some(e) = self.entries.get(id) else {
            return false;
        };
        let a = self.queue.attention(id);
        let registered = self.queue.registered(id);
        let screen = e.observer.screen.text();
        e.meta.kind == AgentKind::Claude
            && e.meta.machine.is_none()
            && e.agent_live()
            && e.pty.is_some()
            && e.stale.is_none()
            && e.observer.before_box
            && !e.observer.behind
            && e.observer.unredrawn.is_none()
            && screen.contains("Choose the text style")
            && screen.contains("/theme")
            && screen.contains("Dark mode")
            && screen.contains("Light mode")
            && e.meta.agent_session_id.is_none()
            && e.observer.transcript.is_none()
            && a.completion_seq == 0
            && !a.working
            && a.background == 0
            && a.observer_error.is_none()
            && registered > 0
            && now.saturating_sub(registered.max(a.last_activity)) >= 10 * 60_000
            && !self.touched.contains_key(id)
            && !self.composed.contains_key(id)
            && !self.submitted.contains_key(id)
            && !self.pending_enter.contains_key(id)
            && !self.delivery_inflight.contains_key(id)
            && e.meta.send_log.is_empty()
            && e.meta.send_queue.is_empty()
    }
    /// Ends session `id`. V2-1b: the queue is closed only once the agent is stopped (a refused close leaves its
    /// waiting items as they are). For the owner, an agent whose holder no longer answers is ended by the core
    /// itself, only as the recorded process (an agent could stop its own holder to keep a close failing).
    /// `window`: the window's own Close (http), which keeps a running session's row and so its done tab; any other
    /// close marks the row `closed_by_command` (ticket 1013 F6).
    pub(crate) fn close(&mut self, id: &str, owner: bool, window: bool) -> Response {
        self.held_enter.remove(id);
        self.composed.remove(id); // ticket 990: typed and never entered; nothing keeps it after the close
        self.touched.remove(id);
        self.acp_loading.remove(id); // a resume closed before its load ended: the rows it continued stay
        let project = self.entry(id)?.meta.project.clone();
        // An account's Login or Logout tab runs in the account's config folder, which is no project (nightly 11-19:
        // closing the login filed that folder in the tree, accounts-login-filing).
        let account_tab = self.entry(id)?.meta.account_tab;
        // V2-6d: a stopped or done session goes in two phases (its turn is over, so nothing is lost by waiting).
        let reply = if !self.entry(id)?.meta.side_chat
            && self.entry(id)?.meta.state != SessionState::Running
        {
            self.close_later(id, owner)
        } else {
            let before = std::mem::replace(&mut self.entry(id)?.meta.closed_by_command, !window);
            let reply = self.close_now(id, owner);
            if reply.is_err() {
                self.entry(id)?.meta.closed_by_command = before;
            }
            reply
        };
        if reply.is_ok() && !account_tab {
            self.keep_project_head(&project);
        }
        reply
    }
    /// Look 1117 v10 N5: a project stays in the tree until it is removed. The tree drops the head of an unfiled project
    /// whose rows are all closed (web `withoutClosedHeads`, for Remove from tree), so closing its last live session files
    /// it as added. Remove from tree closes every session first and un-adds it last. The Home folder is no project row.
    /// Q9 en-b-J6-1: a pinned, grouped or named project is filed as added too, else the row's removal (close_later,
    /// finish_close) leaves it unknown and the next edit's or start's prune drops its pin, group and name.
    fn keep_project_head(&mut self, project: &Path) {
        let Some(name) = project.to_str() else {
            return;
        };
        let Ok(tree) = &self.tree else {
            return;
        };
        let added = tree.added.iter().any(|p| p == name);
        let live = self
            .entries
            .values()
            .any(|e| e.meta.project == project && e.meta.state != SessionState::Closed);
        if added || live || crate::team::Team::open(&self.home).home() == project {
            return;
        }
        let add = crate::tree::TreeEdit::Add {
            project: name.into(),
            added: true,
        };
        // No folder check here (Q9 en-b-J6-2: under the registry lock; the path came from a session). A full tree is
        // refused: the head then goes as before.
        if let Ok(next) = tree.edited(&add, None)
            && next.save(&self.home).is_ok()
        {
            self.tree = Ok(next);
        }
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
    /// F24: what `leave` would lose, so an automatic swap waits for it: a running ACP chat (a child of this core), a
    /// queued send (`leave` cancels it), a holder below the next core's protocol floor, a sign-in, a sandbox run.
    fn exit_blockers(&self, holder_floor: u16) -> usize {
        let sessions = self
            .entries
            .values()
            .filter(|e| {
                e.acp.is_some()
                    || !e.meta.send_queue.is_empty()
                    || e.holder().is_some_and(|(h, _)| h.protocol < holder_floor)
            })
            .count();
        sessions
            + usize::from(self.launching.is_some()) // F24 r3: an agent mid-launch has no holder record to reattach yet
            + crate::account_signin::running()
            + crate::projects::clone::running()
            + crate::sandbox::running(&self.home)
    }
    /// V2-1b (`exit`): lets go of every session without ending it. The store keeps each live session's holder and
    /// token hash for the next core, which reattaches; queued sends and widget runs end with this core.
    pub fn leave(&mut self) -> Result<(), String> {
        crate::account_signin::stop_all(); // round 2: no headless login outlives the core
        crate::projects::clone::stop_all(); // ticket 370: ends its group, removes its folder
        for entry in self.entries.values_mut() {
            cancel_queue(&mut entry.meta);
            cap_log(&mut entry.meta.send_log);
        }
        self.save()?;
        self.left = true;
        for entry in self.entries.values_mut() {
            if let Some(pty) = entry.pty.take() {
                pty.leave();
            }
            // V2-4a: no holder keeps an ACP agent; the next core restores its row stopped.
            if let Some(mut acp) = entry.acp.take() {
                acp.stop();
            }
        }
        crate::sandbox::stop_all(&self.home); // v1b-21 r2: no run outlives the core
        Ok(())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        crate::account_signin::stop_all(); // round 2: no headless login outlives the core
        crate::projects::clone::stop_all(); // ticket 370: ends its group, removes its folder
        self.finish_close(u64::MAX); // V2-6d: a full quit ends the window; nothing waits for a next start
        self.note_asks_ending_at_stop(); // look 11-17 v5 item 3: before the stop closes the items
        // v1b-15. S9: the last read before the stop always runs, never held back by the idle board clock.
        self.board_observed = None;
        self.observe_board();
        let mut errors = vec![];
        let mut scrollback = vec![]; // v1a-40
        let mut known = std::collections::BTreeSet::new(); // V2-1b: holders stopped through the registry
        for entry in self.entries.values_mut() {
            if let Some(pty) = entry.pty.as_mut() {
                known.insert(pty.holder().socket.clone());
                match pty.stop() {
                    Ok(()) => {
                        scrollback.push((entry.meta.id.clone(), pty.snapshot()));
                        entry.pty = None;
                        entry.meta.pid = None;
                        if let Err(error) = self.queue.close(&entry.meta.id, false) {
                            eprintln!("queue stop persistence: {error}");
                        }
                        entry.meta.ended_at.get_or_insert(queue::now_ms());
                        entry.meta.state = if entry.meta.kind != AgentKind::Shell
                            && entry.meta.agent_session_id.is_some()
                        {
                            SessionState::Resumable
                        } else {
                            SessionState::Exited
                        };
                        // v1a-14: cancel queued sends under the one save below; left to the next tick, each
                        // would save on its own (seconds for a long queue) and outlast `serve restart`'s wait.
                        cancel_queue(&mut entry.meta);
                        cap_log(&mut entry.meta.send_log);
                        if let Err(e) = remove_hooks(&self.home, &entry.meta.id) {
                            errors.push(e);
                        }
                    }
                    Err(e) => errors.push(e),
                }
            }
        }
        // V2-4a: ACP agents end with the core; a restart restores them stopped (resumable when declared).
        for entry in self.entries.values_mut() {
            if let Some(mut acp) = entry.acp.take() {
                acp.stop();
                entry.meta.pid = None;
                entry.meta.state = resumable(&entry.meta);
                cancel_queue(&mut entry.meta);
                if let Err(error) = self.queue.close(&entry.meta.id, false) {
                    eprintln!("queue stop persistence: {error}");
                }
            }
        }
        // V2-1b: unattached holders too, and then every holder still listening in this data folder (socket scan),
        // so a full quit leaves none, whatever the registry knows.
        for entry in self.entries.values_mut() {
            let Some(stale) = entry.stale.take() else {
                continue;
            };
            known.insert(stale.record.socket.clone());
            if !stop_stale(&stale, true) {
                errors.push("session holder did not stop; the agent still runs".into());
                entry.stale = Some(stale);
                continue;
            }
            entry.meta.pid = None;
            entry.meta.holder_status = None;
            entry.meta.state = resumable(&entry.meta);
            if let Err(error) = self.queue.close(&entry.meta.id, false) {
                eprintln!("queue stop persistence: {error}");
            }
        }
        for socket in crate::holder::sockets(&self.home) {
            if known.contains(&socket) {
                continue;
            }
            if let Err(e) = crate::holder::stop_at(&socket, None) {
                eprintln!("stopping holder {}: {e}", socket.display());
            }
        }
        crate::sandbox::stop_all(&self.home); // v1b-21 r2: no run outlives the core
        // v1a-40: written before the Stop reply so the next core's resume finds them; the server drains them after
        // releasing the registry lock (`drain_scrollback`).
        for (id, bytes) in scrollback {
            self.queue_save(id, bytes);
        }
        // v1b-21: cancel_queue bypasses finish_send; keep only the hashes of sends still queued.
        let queued: std::collections::BTreeSet<String> = self
            .entries
            .values()
            .flat_map(|e| e.meta.send_queue.iter().map(|s| s.id.clone()))
            .collect();
        self.widget_hashes.retain(|id, _| queued.contains(id));
        self.save()?;
        if errors.is_empty() {
            self.halted = true; // only a stop that went through: after a failed one the core keeps serving
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    pub(crate) fn reserve_worktree(
        &mut self,
        plan: &WorktreePlan,
    ) -> Result<Option<PathBuf>, String> {
        if self.removing_worktrees.iter().any(|path| {
            plan.path.as_ref().is_some_and(|p| p.starts_with(path))
                || plan.project.as_ref().is_some_and(|p| p.starts_with(path))
        }) {
            return Err("worktree removal in progress".into());
        }
        if plan.operation != "remove" {
            return Ok(None);
        }
        let path = plan.path.clone().ok_or("remove requires --path")?;
        self.reserve_path(&path)?;
        Ok(Some(path))
    }
    /// Ticket 259: whether `reserve_path` would refuse for a running session; asked before the cleanup script, which
    /// must not run for a remove that is then refused.
    pub(crate) fn live_in(&self, path: &Path) -> bool {
        self.entries
            .values()
            .any(|e| e.meta.cwd.starts_with(path) && e.meta.state == SessionState::Running)
    }
    /// A folder about to be removed: refused while a session runs in it; a start there waits until released.
    pub(crate) fn reserve_path(&mut self, path: &Path) -> Result<(), String> {
        // One reservation per folder: a second holder's release would end the first one's.
        if self
            .removing_worktrees
            .iter()
            .any(|p| p.starts_with(path) || path.starts_with(p))
        {
            return Err("worktree removal in progress".into());
        }
        if self
            .entries
            .values()
            .any(|e| e.meta.cwd.starts_with(path) && e.meta.state == SessionState::Running)
        {
            return Err("close live worktree sessions first".into());
        }
        self.removing_worktrees.insert(path.to_path_buf());
        Ok(())
    }
    /// V2-CF5: whether any session is working right now, read-only. `attention.working` is set by the queue's hook
    /// and transcript paths; this only filters it, exactly as `snapshot_session` reports it.
    pub fn any_working(&self) -> bool {
        self.entries
            .keys()
            .any(|id| self.queue.attention(id).working)
    }
    /// V2-CF5: what the keep-awake ticker needs: the setting and whether any session works.
    pub(crate) fn keep_awake_view(&self) -> (bool, bool) {
        (self.settings.keep_awake, self.any_working())
    }
    /// V2-8a: what the auto-clean pass needs: the setting, the worktree root and the folders sessions run in.
    pub(crate) fn auto_clean_view(&self) -> (bool, PathBuf, Vec<PathBuf>) {
        (
            self.settings.auto_clean_worktrees,
            self.worktree_root(),
            self.entries
                .values()
                .filter(|e| e.meta.state == SessionState::Running)
                .map(|e| e.meta.cwd.clone())
                .collect(),
        )
    }
    /// Ticket 335: while `git.auto_pull` is on, the project checkouts and where sessions are running now.
    pub(crate) fn auto_pull_view(
        &self,
    ) -> Option<(std::collections::BTreeSet<String>, Vec<PathBuf>)> {
        self.settings.feature::<bool>("git.auto_pull")?.then(|| {
            let running = self
                .entries
                .values()
                .filter(|e| e.meta.state == SessionState::Running)
                .map(|e| e.meta.cwd.clone())
                .collect();
            (self.project_roots(), running)
        })
    }
    /// v25f: the root of records made before a record kept its own (the auto-clean pass and a plan start from it).
    fn worktree_root(&self) -> PathBuf {
        self.settings.legacy_worktree_root(&self.home)
    }
    /// Ticket 259: whether a running session matches `f` (the setup and cleanup tabs).
    pub(crate) fn tab_running(&self, f: impl Fn(&Session) -> bool) -> bool {
        self.entries
            .values()
            .any(|e| e.meta.state == SessionState::Running && f(&e.meta))
    }
    pub(crate) fn home(&self) -> &Path {
        &self.home
    }
    /// True once the owner's Stop or an exit ran: nothing starts after it.
    pub(crate) fn stopped(&self) -> bool {
        self.left || self.halted
    }
    /// Ticket 990: the live session that is this teammate's seat, by the id the core stored on it when it opened the
    /// seat (a renamed tab is still the seat; a tab that only shares the name is not).
    pub(crate) fn seat_of(&self, teammate: &str) -> Option<String> {
        self.entries
            .values()
            .find(|e| e.agent_live() && e.meta.teammate.as_deref() == Some(teammate))
            .map(|e| e.meta.id.clone())
    }
    /// Ticket 992: the level of the teammate's newest seat when only its run ended (see `seat_to_resume`).
    pub(crate) fn last_seat_level(&self, teammate: &str) -> Option<crate::team::Level> {
        self.entries
            .values()
            .filter(|e| e.meta.teammate.as_deref() == Some(teammate))
            .max_by_key(|e| {
                let a = self.queue.attention(&e.meta.id);
                (a.last_activity, a.completion_seq)
            })
            .filter(|e| e.meta.state == SessionState::Resumable)
            .and_then(|e| e.meta.level)
    }
    /// The conversation a plain open of this teammate continues: its newest seat's, when that seat ended without being
    /// closed (a core restart leaves it Resumable) and can resume in `start`'s agent and folder. Claude writes its
    /// transcript at the first finished turn, so before that there is nothing to resume (as `handoff_target`).
    /// Ticket 992: only a seat that ran at `level`, the level this open uses, so the model never changes inside a
    /// conversation.
    /// Ticket 1130 B-L3: `undo` names the seat instead (the window's Undo of a new conversation): any seat of this
    /// teammate that no longer runs, a closed one too.
    pub(crate) fn seat_to_resume(
        &self,
        teammate: &str,
        start: &StartSession,
        level: Option<crate::team::Level>,
        undo: Option<&str>,
    ) -> Option<String> {
        let project = fs::canonicalize(&start.project).ok();
        let newest = |e: &&Entry| {
            let a = self.queue.attention(&e.meta.id);
            (a.last_activity, a.completion_seq)
        };
        let mut seats = self
            .entries
            .values()
            .filter(|e| e.meta.teammate.as_deref() == Some(teammate));
        let last = match undo {
            Some(old) => seats.find(|e| e.meta.id == old && !e.agent_live())?,
            None => seats.max_by_key(newest)?,
        };
        let meta = &last.meta;
        ((meta.state == SessionState::Resumable || undo.is_some())
            && meta.kind == start.kind
            && (meta.level.is_none() || meta.level == level) // a seat from before levels has none
            && Some(&meta.project) == project.as_ref()
            && (meta.kind == AgentKind::Codex || self.queue.attention(&meta.id).completion_seq > 0))
            .then(|| meta.agent_session_id.clone())
            .flatten()
    }
    /// Ticket 992: text or keys go to this session's input box now (see `touched`).
    fn touch_input(&mut self, id: &str) {
        let a = self.queue.attention(id);
        self.touched
            .insert(id.to_string(), a.completion_seq + u64::from(a.working));
    }
    /// Ticket 992 rule 4: a seat with no turn running, no question waiting, nothing queued or on its way, and a turn
    /// finished since the last text or key went to its input box (so no draft and no just-sent task is in it: ending
    /// the seat would drop them). Only such a seat is ended for a task at another level.
    pub(crate) fn seat_idle(&self, id: &str) -> bool {
        let a = self.queue.attention(id);
        !a.working
            && !a.waiting
            && !self.composed.contains_key(id)
            && self
                .delivery_inflight
                .get(id)
                .is_none_or(|seq| a.completion_seq > *seq)
            && self
                .touched
                .get(id)
                .is_some_and(|mark| a.completion_seq > *mark)
            && self
                .entries
                .get(id)
                .is_some_and(|e| e.meta.send_queue.is_empty() && !e.input.pending())
    }
    /// Ticket 1130 B-L3: a turn runs or waits at a question: "New conversation" stops such a seat at once. One between
    /// turns is not busy (a Lead then hands over first).
    pub(crate) fn seat_busy(&self, id: &str) -> bool {
        let a = self.queue.attention(id);
        a.working || a.waiting
    }
    /// Ticket 1130 B-L3 round 2: ends a seat for a new conversation; its row always stays (History). A seat whose run
    /// ended a moment ago is left as it is: `close` takes the two-phase path for such a row (`close_later`), and the
    /// row with its conversation id would be gone ten seconds later.
    /// Round 5: otherwise it is the ordinary close, as the window's Close and ticket 1096 make it. An ACP seat's chat
    /// feed ends with its run there too (`acp_chat`'s shortcut: kept in memory only), and an agent without
    /// `loadSession` leaves no conversation id; neither is changed here.
    pub(crate) fn end_seat(&mut self, id: &str) -> Result<(), String> {
        if self.entry(id)?.meta.state != SessionState::Running {
            return Ok(());
        }
        self.close(id, true, false).map(|_| ())
    }
    /// Ticket 1130 B-L3 round 5: holds row `id` out of the Closed-row bound while an Undo that continues it runs.
    pub(crate) fn hold_row(&mut self, id: &str, on: bool) {
        if on {
            self.held_rows.insert(id.into());
        } else {
            self.held_rows.remove(id);
        }
    }
    /// Ticket 1130 B-L3 round 2: a teammate's new conversation keeps the session that started its old seat (its Lead),
    /// as a resumed run does (V2.5-30), so its wake lines and questions still reach that Lead.
    pub(crate) fn seat_parent(&mut self, id: &str, parent: &str) -> Result<Session, String> {
        self.entry(id)?.meta.parent = Some(parent.into());
        self.grants.parents.insert(id.into(), parent.into());
        if let Err(e) = self.save() {
            eprintln!("parent link not saved yet: {e}");
        }
        let meta = self.entry(id)?.meta.clone();
        Ok(self.snapshot_session(&meta))
    }
    /// Ticket 1081 (security look 4): a seat the core started that nothing went into since: no text or key ever reached
    /// its input box, nothing composed, queued or on its way, no turn and no question. Only such a seat is closed when
    /// its first prompt was not typed.
    pub(crate) fn seat_untouched(&self, id: &str) -> bool {
        let a = self.queue.attention(id);
        !a.working
            && !a.waiting
            && !self.touched.contains_key(id)
            && !self.composed.contains_key(id)
            && !self.delivery_inflight.contains_key(id)
            && self
                .entries
                .get(id)
                .is_some_and(|e| e.meta.send_queue.is_empty() && !e.input.pending())
    }
    /// Ticket 990: the teammate a lead may open: the caller is the live seat of its place's lead, and `name` is another
    /// teammate of that place. Gives the teammate's id.
    pub(crate) fn lead_may_open(
        &self,
        caller: &crate::grants::Caller,
        name: &str,
    ) -> Result<String, String> {
        let all = crate::team::Team::open(&self.home).list()?;
        let seat = self
            .entries
            .get(&caller.id)
            .filter(|e| e.agent_live())
            .and_then(|e| e.meta.teammate.as_deref());
        let lead = all
            .iter()
            .find(|t| t.lead && Some(t.id.as_str()) == seat)
            .ok_or("only the lead of a place opens its teammates")?;
        all.iter()
            .find(|t| {
                t.id != lead.id
                    && t.project == lead.project
                    && t.name.to_lowercase() == name.trim().to_lowercase()
            })
            .map(|t| t.id.clone())
            .ok_or_else(|| format!("no teammate named {} in this place", name.trim()))
    }
    /// Ticket 990: the lead (teammate id) a session works for: itself when it is a lead's seat, else the first lead's
    /// seat up its parent chain. A worktree such a session makes joins that lead's team.
    pub(crate) fn team_lead_of(&self, id: &str) -> Option<String> {
        let leads: Vec<String> = crate::team::Team::open(&self.home)
            .list()
            .ok()?
            .into_iter()
            .filter(|t| t.lead)
            .map(|t| t.id)
            .collect();
        let mut meta = &self.entries.get(id)?.meta;
        for _ in 0..32 {
            if let Some(t) = meta.teammate.as_ref().filter(|t| leads.contains(t)) {
                return Some(t.clone());
            }
            meta = &self.entries.get(meta.parent.as_ref()?)?.meta;
        }
        None
    }
    /// Ticket 1081: what advance.rs reads of a seat's session; a session the registry does not hold is not live.
    pub(crate) fn seat_facts(&self, id: &str) -> crate::advance::Facts {
        let Some(e) = self.entries.get(id) else {
            return Default::default();
        };
        let s = self.snapshot_session(&e.meta);
        crate::advance::Facts {
            live: e.agent_live(),
            working: s.attention.working,
            waits: s.attention.asking || crate::delivery::blocked(&s.pending),
            last: s.attention.last_activity,
            since: s.attention.working_since,
            queued: e
                .meta
                .send_queue
                .iter()
                .filter(|r| r.status == "queued")
                .min_by_key(|r| r.at)
                .map(|r| (r.id.clone(), r.at)),
            cwd: e.meta.cwd.clone(),
        }
    }
    /// Ticket 1081 (security look 2): the one check an auto-advance line passes, before it is written now and again
    /// before its queued row is written. The line is the core's, sent under no seat's or token's identity, so it goes
    /// only to a live session that is a seat (or the lead's seat) of an open task, in a place that still exists with
    /// auto-advance on, and whose own token (or the token it was started under) is not revoked.
    pub(crate) fn core_may(&self, id: &str) -> Result<(), String> {
        let meta = &self
            .entries
            .get(id)
            .filter(|e| e.agent_live())
            .ok_or("skipped: the seat is not running")?
            .meta;
        if self
            .token_origin(meta)
            .is_some_and(|t| crate::tokens::by_caller(&self.home, &t).is_none())
        {
            return Err("skipped: the seat's token was revoked".into());
        }
        let ledger = crate::ledger::Ledger::open(&self.home);
        ledger
            .list()?
            .iter()
            .filter(|t| t.closed.is_none())
            .filter(|t| {
                t.seats.iter().any(|s| s.session == id)
                    || t.lead.is_some() && t.lead == meta.teammate
            })
            .any(|t| t.place.is_dir() && ledger.place(&t.place).auto)
            .then_some(())
            .ok_or_else(|| {
                "skipped: the seat is on no open task of a place with auto-advance on".into()
            })
    }
    /// Ticket 1056 + 1081: a queued wake or core line no longer to be written: a wake line's worker was closed or its
    /// task closed; a core line's target fails `core_may` now.
    fn row_gone(&self, id: &str, row: &crate::delivery::Send) -> bool {
        if self.core_rows.contains(&row.id) {
            return self.core_may(id).is_err();
        }
        self.wake_gone(&row.sender)
    }
    /// Ticket 1081: a line the core itself types into `id` through the normal send path, as `CORE` (no seat's or
    /// token's identity is borrowed). `core_may` decides before the write here and before a queued row is written
    /// (`row_gone`). A queued one waits behind the user's own rows as a worker's wake line does (ticket 1056), and
    /// replaces an older queued core line there.
    pub(crate) fn core_line(&mut self, id: &str, text: String) -> Result<(), String> {
        self.core_may(id)?;
        let older: Vec<String> = self
            .entries
            .get(id)
            .map(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .filter(|s| s.status == "queued" && self.core_rows.contains(&s.id))
                    .map(|s| s.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        if let Reply::Delivery { send } = self.send_line(CORE, id, text)?
            && send.status == "queued"
        {
            self.wake_rows.insert(send.id.clone());
            self.core_rows.insert(send.id);
            for old in older {
                self.finish_send(id, &old, "canceled")?;
            }
        }
        Ok(())
    }
    /// Ticket 1081: the stalled row `row` of `id` goes through the delivery tick's own pass once more (fresh reads,
    /// then the tick's checks on the original row: its sender's liveness and token, ownership, its local or remote
    /// stamp). Nothing new is typed for another sender (security look: a re-sent copy skipped those checks). False when
    /// the checks canceled the row.
    pub(crate) fn resend_queued(&mut self, id: &str, row: &str) -> Result<bool, String> {
        let status = |s: &Self| {
            s.entries.get(id).and_then(|e| {
                e.meta
                    .send_queue
                    .iter()
                    .chain(&e.meta.send_log)
                    .find(|s| s.id == row)
                    .map(|s| s.status.clone())
            })
        };
        if status(self).as_deref() != Some("queued") {
            return Ok(true);
        }
        self.flush_delivery()?;
        Ok(status(self).as_deref() != Some("canceled"))
    }
    /// Ticket 990 slice g: what the registry knows about a session now, for a task's state word.
    pub(crate) fn seat_now(&self, id: &str) -> crate::ledger::SeatNow {
        let Some(e) = self.entries.get(id) else {
            return Default::default();
        };
        let live = e.agent_live();
        let asks = if live {
            self.queue.items_of(id)
        } else {
            vec![]
        };
        crate::ledger::SeatNow {
            live,
            state: crate::events::state(
                e.meta.state,
                e.agent_ended,
                live && self.queue.attention(id).working,
                asks.iter().map(|i| &i.kind),
            ),
        }
    }
    /// Ticket 990 slice h: the merge card for the owner, from the lead's seat.
    pub(crate) fn ask_merge(
        &mut self,
        session: &str,
        task: &crate::ledger::Task,
        revision: &str,
    ) -> Result<String, String> {
        let id = self.queue.ask_owner(
            session,
            queue::OwnerAsk::Merge {
                task: task.id.clone(),
                title: task.title.clone(),
                place: task.place.clone(),
                revision: revision.into(),
                learned: task.learned.clone(),
            },
        )?;
        // Look 11-17 v5 item 8: the task's board cards wait with the card, in the needs-decision column.
        if let Err(e) = crate::board::park_task(&self.home, task, true) {
            eprintln!(
                "board: task {} cards not moved to needs-decision: {e}",
                task.id
            );
        }
        Ok(id)
    }
    /// A closed task has no merge card: a task the user dropped kept its card, and a yes there would have kept
    /// lessons of a dropped branch (real look 11-17).
    pub(crate) fn retire_merge_card(&mut self, task: &str) -> Result<(), String> {
        // N24: its board cards leave Needs you too.
        let ledger = crate::ledger::Ledger::open(&self.home);
        if let Some(t) = ledger.list()?.into_iter().find(|t| t.id == task)
            && let Some(closed) = &t.closed
        {
            let seats: Vec<String> = t.seats.iter().map(|s| s.session.clone()).collect();
            if let Err(e) = crate::board::retire_task(&self.home, &seats, &closed.how) {
                eprintln!("board: task {task} cards not retired: {e}");
            }
        }
        // Ticket 1004: nor a stall card.
        self.queue.answer_owner(|i| {
            matches!(&i.owner, Some(queue::OwnerAsk::Merge { task: t, .. } | queue::OwnerAsk::Stall { task: t, .. }) if t == task)
        })
    }
    /// Ticket 1004: a check-in's answer (`ledger::CheckIn::stalled`), on the task's card: raised once per stall,
    /// taken away when the task moved again.
    pub(crate) fn stall_card(&mut self, c: &crate::ledger::CheckIn, stalled: bool) {
        let task = &c.task;
        let done = if stalled {
            let ask = queue::OwnerAsk::Stall {
                task: task.id.clone(),
                title: task.title.clone(),
                place: task.place.clone(),
                seat: c.name.clone(),
                error: c.error.clone(),
            };
            self.queue.ask_owner(&c.session, ask).map(|_| ())
        } else {
            self.queue.answer_owner(
                |i| matches!(&i.owner, Some(queue::OwnerAsk::Stall { task: t, .. }) if *t == task.id),
            )
        };
        if let Err(e) = done {
            eprintln!("task {}: stall card not changed: {e}", task.id);
        }
    }
    /// Ticket 1004: a check-in waits for the judge. One per task: a newer one takes the place of one not judged yet,
    /// so what waits is bounded by the open tasks however many turns end while the judge is busy (they count as one).
    pub(crate) fn check_in_due(&mut self, c: crate::ledger::CheckIn) {
        self.check_ins.retain(|o| o.task.id != c.task.id);
        self.check_ins.push(c);
    }
    /// Ticket 1004: the server's loop after a tick. One judge at a time (`busy`), on its own thread: it takes what
    /// waits, judges each check-in with no lock held (git) and sets its card under the lock, until nothing waits.
    /// While it runs, a tick starts no other: one thread, one worktree read at a time.
    pub(crate) fn start_judge(
        registry: &std::sync::Arc<std::sync::Mutex<Sessions>>,
        home: &Path,
        busy: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        use std::sync::atomic::Ordering::SeqCst;
        let waits = registry.lock().is_ok_and(|s| !s.check_ins.is_empty());
        if !waits || busy.swap(true, SeqCst) {
            return;
        }
        let (registry, home, running) = (registry.clone(), home.to_path_buf(), busy.clone());
        let spawned = std::thread::Builder::new().spawn(move || {
            // Cleared on the way out even if a judge panics, so a later tick starts one again.
            struct Done(std::sync::Arc<std::sync::atomic::AtomicBool>);
            impl Drop for Done {
                fn drop(&mut self) {
                    self.0.store(false, SeqCst);
                }
            }
            let _done = Done(running);
            loop {
                let due = match registry.lock() {
                    Ok(mut sessions) => std::mem::take(&mut sessions.check_ins),
                    Err(_) => return,
                };
                if due.is_empty() {
                    return;
                }
                for c in due {
                    if let Some(stalled) = c.stalled(&home)
                        && let Ok(mut sessions) = registry.lock()
                    {
                        sessions.stall_card(&c, stalled);
                    }
                }
            }
        });
        if let Err(e) = spawned {
            eprintln!("check-ins: no thread ({e}); trying at the next tick");
            busy.store(false, SeqCst);
        }
    }
    /// The lessons on the task's open merge card, as the user sees them; `None` with no card.
    pub(crate) fn merge_lessons(&self, task: &str) -> Option<Vec<crate::ledger::Lesson>> {
        self.queue
            .owner_items()
            .into_iter()
            .find_map(|i| match i.owner {
                Some(queue::OwnerAsk::Merge {
                    task: t, learned, ..
                }) if t == task => Some(learned),
                _ => None,
            })
    }
    /// Ticket 990 slice h: the notes a seat reads, in front of the first prompt a lead sends it. Once per seat.
    pub(crate) fn with_notes(&self, id: &str, text: String) -> String {
        let ledger = crate::ledger::Ledger::open(&self.home);
        let Some(task) = ledger.of_seat(id) else {
            return text;
        };
        let Some(seat) = task.seats.iter().find(|s| s.session == id && !s.briefed) else {
            return text;
        };
        if let Err(e) = ledger.briefed(id) {
            eprintln!("ledger: seat not marked as briefed: {e}");
        }
        // Slice i: the seat's role and its task open the prompt, so a seat needs no brief of its own to know them.
        let mut head = String::new();
        if let Some(role) = crate::roles::Roles::open(&self.home).get(&seat.role) {
            head += &format!("You sit on a task as {}. {}\n", role.name, role.job);
        }
        head += &format!("Task {}: {}\n", task.id, task.title);
        for a in &task.accept {
            head += &format!("- accept: {a}\n");
        }
        for n in &task.told {
            head += &format!("- the user told {}: \"{}\"\n", n.name, n.text);
        }
        let notes =
            crate::notes::Notes::open(&self.home).for_seat(Some(&task.place), Some(&seat.role));
        head += &crate::notes::quote(&notes);
        format!("{head}\n{text}")
    }
    /// Ticket 990 slice i: a lead's proposal of a new role, as a card for the owner.
    pub(crate) fn ask_role(
        &mut self,
        session: &str,
        role: crate::roles::Role,
        why: String,
        place: PathBuf,
    ) -> Result<String, String> {
        self.queue
            .ask_owner(session, queue::OwnerAsk::Role { role, why, place })
    }
    /// Ticket 1099 panel 4: a lead's ask to change its place's live seats, as a card for the owner.
    pub(crate) fn ask_cap(
        &mut self,
        session: &str,
        place: PathBuf,
        was: u32,
        cap: u32,
        why: String,
    ) -> Result<String, String> {
        self.queue.ask_owner(
            session,
            queue::OwnerAsk::Cap {
                place,
                was,
                cap,
                why,
            },
        )
    }
    /// Home view change 4: the Home lead's goal for a project's lead, as a card for the owner.
    pub(crate) fn ask_goal(
        &mut self,
        session: &str,
        place: PathBuf,
        lead: String,
        from: String,
        text: String,
    ) -> Result<String, String> {
        self.queue.ask_owner(
            session,
            queue::OwnerAsk::Goal {
                place,
                lead,
                from,
                text,
            },
        )
    }
    /// Ticket 1002 lane 2: `nunchiro outbox stage`. Only the Home lead's live seat stages (a scheduled run of it too:
    /// a routine may draft, never answer). The call is checked as it is, never cleaned (`outbox::check`), so the call
    /// approved is the call the seat makes; then only the card.
    fn outbox_stage(&mut self, caller: &crate::grants::Caller, request: &Request) -> Response {
        let Request::OutboxStage { tool, args, source } = request else {
            return Err("not an outbox request".into());
        };
        let from = self.home_lead_caller(caller)?;
        let shown = crate::outbox::check(tool, args)?;
        let waiting = self.outbox_count();
        if waiting >= crate::outbox::CARDS_MAX {
            return Err(format!(
                "{waiting} Outbox cards already wait for the user: stage more once they answer"
            ));
        }
        let mut new_domains: Vec<String> = shown
            .recipients()
            .map(|a| crate::outbox::domain(a).to_string())
            .filter(|d| !self.queue.outbox_domain_known(d))
            .collect();
        new_domains.sort();
        new_domains.dedup();
        let source = source
            .as_deref()
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .map(|s| {
                s.chars()
                    .filter(|c| !c.is_control() && !crate::board::rights::hidden(*c))
                    .take(crate::outbox::SOURCE_MAX)
                    .collect::<String>()
            })
            .filter(|s| !s.is_empty());
        let id = self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Outward {
                tool: tool.clone(),
                args: args.clone(),
                source,
                new_domains,
                from,
                hash: crate::approval::outward_call_hash(tool, args),
                yes_at: None,
            },
        )?;
        Ok(Reply::Text {
            text: format!("{} as card {id}", crate::outbox::words(&shown)),
        })
    }
    /// Ticket 1002 lane 2: the Home lead's name, when `caller` is its live seat (a token or a remote caller never is).
    fn home_lead_caller(&self, caller: &crate::grants::Caller) -> Result<String, String> {
        let refused = || "only the Home lead's seat stages or sends an Outbox card".to_string();
        if !matches!(self.schedule_reach(caller), Ok(None)) {
            return Err(refused());
        }
        crate::team::Team::open(&self.home)
            .lead_of(None)
            .map(|l| l.name)
            .ok_or_else(refused)
    }
    /// Ticket 1002 lane 2: `Request::OutboxSpend`, asked by the Home lead seat's hook before an outward call runs.
    /// Fail closed: only an approved, unspent card with exactly this call lets it through, once.
    fn outbox_spend(
        &mut self,
        caller: &crate::grants::Caller,
        tool: &str,
        args_hash: &str,
    ) -> Response {
        self.home_lead_caller(caller)?;
        let spent = self
            .queue
            .outbox_spend(&caller.id, tool, args_hash, queue::now_ms())
            .ok_or(
                "no approved Outbox card of this session has exactly this call: it must not run",
            )?;
        if let Err(e) = self.queue.keep_outbox_domains(&spent.domains) {
            eprintln!("outbox: recipient domains not kept: {e}");
        }
        // Ticket 1003: the waiting-for row is made once the connector reports the mail sent (`outbox_sent`).
        if spent.mail.is_some() {
            let now = queue::now_ms();
            let before = self.outbox_sending.len();
            self.outbox_sending
                .retain(|(at, _)| now.saturating_sub(*at) < OUTBOX_SENDING_MS);
            let over = (self.outbox_sending.len() + 1).saturating_sub(OUTBOX_SENDING_MAX);
            self.outbox_sending.drain(..over);
            if self.outbox_sending.len() < before {
                eprintln!(
                    "open loops: {} spent Outbox mail(s) never reported sent, no waiting row made",
                    before - self.outbox_sending.len()
                );
            }
            self.outbox_sending.push((now, spent.clone()));
        }
        let team = crate::team::Team::open(&self.home);
        if let Some(lead) = team.lead_of(None) {
            self.team_note(
                &team.home(),
                &lead.id,
                None,
                // Final review S8: the spend allows the call; whether the connector then sent it is not known here.
                format!(
                    "Outbox card {} was allowed to send, as the user approved.",
                    spent.id
                ),
                crate::room::TeamNote {
                    what: "outbox_sent".into(),
                    worktree: None,
                    name: Some(spent.id.clone()),
                    branch: None,
                    merged: None,
                    seat: None,
                },
            );
        }
        Ok(Reply::Text { text: spent.id })
    }
    /// Ticket 1003: the user's yes went out as a mail (its PostToolUse came back without an error), so the user now
    /// waits for its reply. A row that cannot be kept never holds anything back.
    fn outbox_sent(&mut self, session: &str, event: &str, payload: &serde_json::Value) {
        if !payload["agent_id"].as_str().is_none_or(str::is_empty)
            || !matches!(event, "PostToolUse" | "Stop")
        {
            return;
        }
        // The turn's Stop drops what is left of this session's sends (none of them reported back).
        if event == "Stop" {
            self.outbox_sending.retain(|(_, a)| a.session != session);
            return;
        }
        // The call is matched by the content its card was bound to (the hook's spend hashed the same `tool_input`),
        // never by tool name alone: two sends of one session may end in any order.
        let Some(tool) = payload["tool_name"].as_str() else {
            return;
        };
        let hash = crate::approval::outward_call_hash(tool, &payload["tool_input"]);
        let Some(at) = self.outbox_sending.iter().position(|(_, a)| {
            a.session == session && a.tool == tool && crate::schedule::same(&a.hash, &hash)
        }) else {
            return;
        };
        let (_, spent) = self.outbox_sending.remove(at);
        let response = &payload["tool_response"];
        if response["isError"] == true || response["is_error"] == true {
            return;
        }
        let Some((who, subject)) = &spent.mail else {
            return;
        };
        let kept = crate::loops::draft(
            "waiting",
            who,
            &format!("a reply to \"{subject}\""),
            None,
            &format!("Outbox card {}", spent.id),
        )
        .and_then(|row| crate::loops::Loops::open(&self.home).add(row, queue::now_ms()));
        if let Err(e) = kept {
            eprintln!(
                "open loops: the waiting row of card {} not kept: {e}",
                spent.id
            );
        }
    }
    /// Ticket 1003: the Home lead asks the user, on a card, to keep a new open loop (`change` "add") or to close one
    /// ("close", with `why`). Nothing is stored before the yes.
    pub(crate) fn ask_loop(
        &mut self,
        session: &str,
        change: &str,
        row: crate::loops::Row,
        from: String,
        why: Option<String>,
    ) -> Result<String, String> {
        self.queue.ask_owner(
            session,
            queue::OwnerAsk::Loop {
                change: change.into(),
                row,
                from,
                why,
            },
        )
    }
    /// Ticket 1003: the open-loop cards waiting for the user.
    pub(crate) fn loop_card_count(&self) -> usize {
        self.queue
            .owner_items()
            .iter()
            .filter(|i| matches!(i.owner, Some(queue::OwnerAsk::Loop { .. })))
            .count()
    }
    /// Ticket 1003: the rows changed, so the next tick reads them for overdue ones.
    pub(crate) fn loops_changed(&mut self) {
        self.loops_checked = 0;
    }
    /// Ticket 1003: a closed loop has no close or overdue card left.
    pub(crate) fn retire_loop_cards(&mut self, loop_id: &str) -> Result<(), String> {
        self.queue.answer_owner(|i| {
            matches!(&i.owner, Some(queue::OwnerAsk::Loop { change, row, .. }) if change != "add" && row.id == loop_id)
        })
    }
    /// Ticket 1003, each tick (the store is read once a minute; no timer of its own): an open loop whose due date
    /// passed gets one card (`loops::raise_overdue`).
    fn loops_overdue(&mut self, now: u64) {
        if now < self.loops_checked + 60_000 {
            return;
        }
        self.loops_checked = now;
        crate::loops::raise_overdue(&self.home, &mut self.queue, &crate::loops::today(now));
    }
    /// Ticket 1003: the Home lead hears what became of its open-loop card, in its room.
    fn loop_note(&mut self, body: String, what: &str, row: &crate::loops::Row) {
        let team = crate::team::Team::open(&self.home);
        let Some(home_lead) = team.lead_of(None) else {
            return;
        };
        self.team_note(
            &team.home(),
            &home_lead.id,
            None,
            body,
            crate::room::TeamNote {
                what: what.into(),
                worktree: None,
                name: Some(row.who.clone()),
                branch: None,
                merged: None,
                seat: None,
            },
        );
    }
    /// Ticket 1002 lane 2 (check M7f): whether `id` is an Outbox card, which only the owner's window answers.
    pub(crate) fn outward_card(&self, id: &str) -> bool {
        matches!(
            self.queue.owner_decision(id).and_then(|i| i.owner),
            Some(queue::OwnerAsk::Outward { .. })
        )
    }
    /// Ticket 1002 lane 2: the Outbox cards waiting for the user.
    pub(crate) fn outbox_count(&self) -> usize {
        self.queue
            .owner_items()
            .iter()
            .filter(|i| matches!(i.owner, Some(queue::OwnerAsk::Outward { .. })))
            .count()
    }
    fn keep_domains(&mut self, shown: &crate::outbox::Shown) {
        let domains: Vec<String> = shown
            .recipients()
            .map(|a| crate::outbox::domain(a).to_string())
            .collect();
        if let Err(e) = self.queue.keep_outbox_domains(&domains) {
            eprintln!("outbox: recipient domains not kept: {e}");
        }
    }
    /// Ticket 1002 lane 2, each tick: a yes past its undo time is approved and wakes the Home lead to send it; an
    /// approved card unspent for 10 minutes lapses; a card unanswered for 24 h expires. Each is a line in Home's room.
    fn expire_outbox(&mut self, now: u64) {
        let shown_of = |i: &queue::Decision| match &i.owner {
            Some(queue::OwnerAsk::Outward { tool, args, .. }) => {
                crate::outbox::check(tool, args).ok()
            }
            _ => None,
        };
        let ripe =
            self.queue
                .outbox_ripe(now, crate::outbox::UNDO_MS, crate::outbox::SPEND_MS, |i| {
                    shown_of(i).map_or(vec![], |s| {
                        s.recipients()
                            .map(|a| crate::outbox::domain(a).to_string())
                            .collect()
                    })
                });
        let team = crate::team::Team::open(&self.home);
        for item in ripe.unwrap_or_else(|e| {
            eprintln!("outbox: approved cards not moved: {e}");
            vec![]
        }) {
            let (Some(shown), Some(queue::OwnerAsk::Outward { tool, .. })) =
                (shown_of(&item), &item.owner)
            else {
                continue;
            };
            let what = crate::outbox::words(&shown);
            // Final review S7: only the run that staged it can spend it, so a gone run is not woken (that would open a
            // new seat as a window open); the owner's line below says so.
            let live = self
                .entries
                .get(&item.session_id)
                .is_some_and(|e| e.agent_live());
            // Fable round 3 review S3: and it is still the Home lead's seat.
            let lead = team.lead_of(None).filter(|lead| {
                live && self.seat_of(&lead.id).as_deref() == Some(item.session_id.as_str())
            });
            // Round 4 S-r4a: straight into that run (never `open_seat`, which could open a new seat if it ended).
            let woken = lead.is_some()
                && self
                    .prompt_as_user(&item.session_id, format!(
                        "The user approved Outbox card {}: {what}. Send it now: call {tool} once, with exactly the arguments you staged for this card. It is allowed once, within 10 minutes; any other call is refused."
                        , item.id
                    ))
                    .is_ok();
            self.outbox_note(
                format!("The user approved {what}; send it now."),
                "outbox_yes",
                &shown,
            ); // Fable lane 2 review S5: only the staging session may spend it; when that run is gone, the owner hears it
            // in the window too (the card then lapses as No), not only a lead that cannot send it.
            if !woken {
                // S-r4b: a live run that is no longer the lead's seat has not ended.
                let why = if live {
                    "is no longer the lead's seat"
                } else {
                    "has ended"
                };
                let line = format!(
                    "You approved {what}, but the chief of staff's run that staged it {why}, so it cannot be sent; it will lapse as No. Ask the chief to stage it again."
                );
                if let Err(e) = crate::room::Log::open(&self.home, &team.home()).team(
                    crate::room::PERSON,
                    line,
                    crate::room::TeamNote {
                        what: "outbox_orphan".into(),
                        worktree: None,
                        name: Some(item.id.clone()),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                ) {
                    eprintln!("outbox: the owner's line not written: {e}");
                }
            }
        }
        for lapsed in self.queue.outbox_lapsed(now) {
            if let Some(lead) = team.lead_of(None) {
                self.team_note(
                    &team.home(),
                    &lead.id,
                    None,
                    format!("Outbox card {} was not sent within 10 minutes of the user's yes: it counts as No. Do not send it another way.", lapsed.id),
                    crate::room::TeamNote {
                        what: "outbox_lapsed".into(),
                        worktree: None,
                        name: Some(lapsed.id),
                        branch: None,
                        merged: None,
                        seat: None,
                    },
                );
            }
        }
        let gone = match self.queue.expire_owner(now, crate::outbox::EXPIRE_MS, |i| {
            matches!(i.owner, Some(queue::OwnerAsk::Outward { yes_at: None, .. }))
        }) {
            Ok(gone) => gone,
            Err(e) => return eprintln!("outbox: expired cards not dropped: {e}"),
        };
        for item in gone {
            if let Some(shown) = shown_of(&item) {
                let what = crate::outbox::words(&shown);
                self.outbox_note(
                    format!("The user did not answer {what} within 24 hours: it counts as No. Do not send it another way."),
                    "outbox_expired",
                    &shown,
                );
            }
        }
    }
    /// Ticket 1002 lane 2: the Home lead hears what became of its Outbox card, in its room.
    fn outbox_note(&mut self, body: String, what: &str, shown: &crate::outbox::Shown) {
        let team = crate::team::Team::open(&self.home);
        let Some(home_lead) = team.lead_of(None) else {
            return;
        };
        let name = match shown.kind {
            "event" => shown.subject.clone(),
            _ => shown.to.join(", "),
        };
        self.team_note(
            &team.home(),
            &home_lead.id,
            None,
            body,
            crate::room::TeamNote {
                what: what.into(),
                worktree: None,
                name: Some(name),
                branch: None,
                merged: None,
                seat: None,
            },
        );
    }
    /// Home view change 1: what the digest reads of the registry, per project (a worktree session's is its main
    /// checkout): its working seats, its pending decisions as the tree and Decisions count them (its sessions' asks
    /// and the owner cards about it) and its newest activity (ms, with the session's name). With the registered projects.
    pub(crate) fn digest_facts(&self) -> (Vec<PathBuf>, BTreeMap<PathBuf, DigestFacts>) {
        let mut by: BTreeMap<PathBuf, DigestFacts> = BTreeMap::new();
        // The owner cards about one project (a merge, a role, a goal) are its decisions too, as in Decisions.
        for i in self.queue.owner_items() {
            let place = match &i.owner {
                Some(
                    queue::OwnerAsk::Merge { place, .. }
                    | queue::OwnerAsk::Role { place, .. }
                    | queue::OwnerAsk::Goal { place, .. }
                    | queue::OwnerAsk::Schedule { place, .. } // ticket 993
                    | queue::OwnerAsk::Stall { place, .. } // ticket 1004
                    | queue::OwnerAsk::Tidy { place, .. } // ticket 1005
                    | queue::OwnerAsk::Cap { place, .. } // ticket 1099
                    | queue::OwnerAsk::SessionClose { place, .. }, // ticket 1113
                ) => place.clone(),
                _ => continue,
            };
            by.entry(place)
                .or_default()
                .pending
                .push((i.id, i.observed_at, i.session_id));
        }
        for e in self.entries.values() {
            if e.meta.state == SessionState::Closed || e.meta.machine.is_some() {
                continue;
            }
            let f = by.entry(e.meta.project.clone()).or_default();
            let live = e.agent_live();
            let attention = self.queue.attention(&e.meta.id);
            let asks = f.pending.len();
            // Look 11-17 v4f N-B: only a live session's asks, as the snapshot's `pending` (Decisions, the tree) counts
            // them; an ended one's items stay on disk as resume evidence only and answer nothing.
            for i in self.queue.items_of(&e.meta.id).into_iter().filter(|_| live) {
                if !matches!(
                    i.kind,
                    queue::Kind::Stale | queue::Kind::Background | queue::Kind::Owner
                ) {
                    f.pending.push((i.id, i.observed_at, e.meta.id.clone()));
                }
            }
            // As the tree reads a session: one that waits for the user is not working (look 1117 v3 N2: a row said
            // "1 working" while its only session sat at a permission card).
            if crate::ledger::working_now(live, &attention, f.pending.len() - asks) {
                f.working += 1;
            }
            if attention.last_activity > f.last.0 {
                f.last = (attention.last_activity, e.meta.label.clone());
            }
            // Look 11-17 v5 item 4: a seat whose session failed, unless another of its sessions runs.
            if let Some(mate) = &e.meta.teammate {
                if live {
                    f.seats_live.insert(mate.clone());
                } else if e.meta.state == SessionState::Failed {
                    f.seats_failed.insert(mate.clone());
                }
            }
        }
        let roots = self
            .project_roots()
            .into_iter()
            .map(PathBuf::from)
            .collect();
        (roots, by)
    }
    /// Ticket 990 slice g: who asks the ledger. The owner names a project (none: every place); a session's place is
    /// its lead's, or its own room's project when it works for no lead.
    pub(crate) fn task_caller(
        &self,
        caller: Option<&crate::grants::Caller>,
        project: Option<&Path>,
    ) -> Result<crate::ledger::Who, String> {
        let team = crate::team::Team::open(&self.home);
        let Some(caller) = caller else {
            let place = project
                .map(fs::canonicalize)
                .transpose()
                .map_err(|e| e.to_string())?;
            let lead = place
                .as_ref()
                .and_then(|p| team.lead_of(team.place(p).as_deref()))
                .map(|t| t.id);
            return Ok(crate::ledger::Who {
                place,
                lead,
                decides: true,
                session: None,
                name: "user".into(),
            });
        };
        let meta = &self.entries.get(&caller.id).ok_or("unknown session")?.meta;
        let lead = self.team_lead_of(&caller.id);
        let place = match &lead {
            Some(lead) => team
                .list()?
                .into_iter()
                .find(|t| t.id == *lead)
                .map(|t| t.project.unwrap_or_else(|| team.home())),
            None => self.room_project(&caller.id),
        };
        Ok(crate::ledger::Who {
            place: Some(place.ok_or("no place for this session")?),
            decides: lead
                .as_ref()
                .is_some_and(|l| self.seat_of(l).as_deref() == Some(caller.id.as_str())),
            lead,
            session: Some(caller.id.clone()),
            name: meta.label.clone(),
        })
    }
    /// Ticket 990: the recorded worktree at `path` (canonical), with its team.
    pub(crate) fn recorded_worktree(&self, path: &Path) -> Option<Worktree> {
        recorded_worktree(&self.home, &self.settings, path)
    }
    /// Ticket 990: one line in the project's room about a lead's team, to the lead's live seat (the person when the
    /// lead is not running, or did it itself): the window draws the lead's list of delegated work from these, and the
    /// lead hears what it did not do itself.
    /// Look 1117 v12 S2-B: a yes on a merge card while the lead's seat was not running went to the room log only, and
    /// a resumed conversation gets no brief, so the lead never heard it. The yes is kept in the ledger: a resumed run
    /// of a lead's seat hears each yes still waiting on it, as its next prompt.
    fn merge_yes_on_resume(&mut self, id: &str) {
        let Some(lead) = self.entries.get(id).and_then(|e| e.meta.teammate.clone()) else {
            return;
        };
        let tasks = match crate::ledger::Ledger::open(&self.home).list() {
            Ok(tasks) => tasks,
            Err(e) => {
                eprintln!("merge yes for {id} not read: {e}");
                return;
            }
        };
        for t in tasks
            .iter()
            .filter(|t| t.closed.is_none() && t.lead.as_deref() == Some(lead.as_str()))
        {
            if let Some(yes) = &t.merge
                && let Err(e) =
                    self.prompt_as_user(id, merge_yes_line(&t.id, &t.title, &yes.revision))
            {
                eprintln!("merge yes for task {} not sent to {id}: {e}", t.id);
            }
        }
    }
    pub(crate) fn team_note(
        &mut self,
        project: &Path,
        lead: &str,
        actor: Option<&str>,
        body: String,
        note: crate::room::TeamNote,
    ) {
        let seat = self.seat_of(lead).filter(|s| Some(s.as_str()) != actor);
        let to = seat.as_deref().unwrap_or(crate::room::PERSON);
        match crate::room::Log::open(&self.home, project).team(to, body, note) {
            Ok(_) => {
                if let Some(seat) = seat {
                    self.room_told(&seat);
                }
            }
            Err(e) => eprintln!("team note not written: {e}"),
        }
    }
    /// Ticket 990: the user spoke to a sub-bot directly (the window's prompt to a session that works for a lead):
    /// the lead learns it in one line. A prompt to the lead itself, or with no lead running, says nothing.
    fn told(&mut self, id: &str, text: &str) {
        // Ticket 993: the user is here now, so the session is no unattended scheduled run any more.
        if self
            .entries
            .get_mut(id)
            .is_some_and(|e| e.meta.schedule.take().is_some())
            && let Err(e) = self.save()
        {
            eprintln!("scheduled-run mark not cleared on disk yet: {e}");
        }
        let Some(meta) = self.entries.get(id).map(|e| &e.meta) else {
            return;
        };
        let lead = self
            .recorded_worktree(&meta.cwd)
            .and_then(|w| w.team)
            .or_else(|| self.team_lead_of(id));
        let (label, project, cwd) = (meta.label.clone(), meta.project.clone(), meta.cwd.clone());
        // After one Codex look: the line goes into the room's log and to another agent, so what the logs mask (known
        // tokens, key-like values) is masked here too, before the cut.
        let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let line = String::from_utf8_lossy(&crate::logs::mask(line.as_bytes())).into_owned();
        let name = if label.is_empty() {
            id[..id.len().min(6)].to_string()
        } else {
            label
        };
        // Ticket 990 slice g: the task's record takes the user's words whether a lead runs or not, so a lead's next
        // conversation reads them.
        match crate::ledger::Ledger::open(&self.home).told(id, &cwd, &name, &line, queue::now_ms())
        {
            Ok(true) => {
                if let Some(task) = crate::ledger::Ledger::open(&self.home).of_seat(id) {
                    crate::events::tasks(&task.place);
                }
            }
            Ok(false) => {}
            Err(e) => eprintln!("ledger: what the user told {name} was not recorded: {e}"),
        }
        let Some(lead) = lead else { return };
        let Some(seat) = self.seat_of(&lead).filter(|s| s != id) else {
            return;
        };
        let Some(room) = self.room_project(&seat).filter(|r| *r == project) else {
            return;
        };
        let cut: String = line.chars().take(300).collect();
        let more = if cut.len() < line.len() { "…" } else { "" };
        self.team_note(
            &room,
            &lead,
            None,
            format!("The user told {name} directly: \"{cut}{more}\""),
            crate::room::TeamNote {
                what: "told".into(),
                worktree: None,
                name: None,
                branch: None,
                merged: None,
                seat: Some(id.into()),
            },
        );
    }
    pub(crate) fn session_of(&mut self, id: &str) -> Result<Session, String> {
        let meta = self.entry(id)?.meta.clone();
        Ok(self.snapshot_session(&meta))
    }
    /// Ticket 994: an ACP seat's model and thinking level, set once its agent has listed its options.
    pub(crate) fn seat_wants(&mut self, id: &str, model: Option<String>, effort: Option<String>) {
        if let Some(acp) = self.entries.get_mut(id).and_then(|e| e.acp.as_mut()) {
            acp.want(model, effort);
        }
    }
    /// Look v9 B N-S3-6: the level a role's seat on a task opened at (`task staff`), as a teammate's seat has it. A
    /// teammate's own seat keeps the level its teammate opened it at.
    pub(crate) fn role_seat_level(
        &mut self,
        id: &str,
        level: crate::team::Level,
    ) -> Result<(), String> {
        let meta = &mut self.entry(id)?.meta;
        if meta.teammate.is_some() || meta.level == Some(level) {
            return Ok(());
        }
        meta.level = Some(level);
        self.save()
    }
    /// Ticket 990: marks a session as a teammate's seat. The session already runs, so a failed save is logged; the
    /// next save writes it.
    pub(crate) fn seat_session(
        &mut self,
        id: &str,
        teammate: &str,
        level: Option<crate::team::Level>,
    ) -> Result<Session, String> {
        self.entry(id)?.meta.teammate = Some(teammate.into());
        self.entry(id)?.meta.level = level; // ticket 992
        self.adopt_workers(id, teammate);
        if let Err(e) = self.save() {
            eprintln!("teammate seat not saved yet: {e}");
        }
        let meta = self.entry(id)?.meta.clone();
        Ok(self.snapshot_session(&meta))
    }
    /// Ticket 990 slice g (seen in the recovery experiment with real Claude: reviewers finished and the lead's new
    /// conversation never heard it, because their wake lines went to the closed session that had started them). A
    /// teammate's new seat takes over the running sessions its earlier seats started, and the seats of its tasks:
    /// their parent is this seat from now, so wake lines, unaddressed room messages and the room's project follow.
    fn adopt_workers(&mut self, seat: &str, teammate: &str) {
        let ledger = crate::ledger::Ledger::open(&self.home)
            .list()
            .unwrap_or_default();
        let earlier = |parent: &str| {
            parent != seat
                && self
                    .entries
                    .get(parent)
                    .is_none_or(|p| !p.agent_live() && p.meta.teammate.as_deref() == Some(teammate))
        };
        let adopted: Vec<String> = self
            .entries
            .values()
            .filter(|e| e.meta.id != seat && e.agent_live())
            .filter(|e| match e.meta.parent.as_deref() {
                // Started by an earlier seat of this teammate that no longer runs.
                Some(parent) if self.entries.contains_key(parent) => earlier(parent),
                // Its starter's row is gone: it is this teammate's when it sits on one of its tasks.
                Some(_) => ledger.iter().any(|t| {
                    t.closed.is_none()
                        && t.lead.as_deref() == Some(teammate)
                        && t.seats.iter().any(|s| s.session == e.meta.id)
                }),
                None => false,
            })
            .map(|e| e.meta.id.clone())
            .collect();
        for child in adopted {
            if let Some(entry) = self.entries.get_mut(&child) {
                entry.meta.parent = Some(seat.into());
            }
            self.grants.parents.insert(child, seat.into());
        }
    }
    /// Ticket 981: a schedule's task, sent as the owner's own prompt (the schedule is the owner's).
    /// A session at a question refuses a send (a new seat may show a startup question at once: a seat's Open failed
    /// with "agent_blocked" 1 to 3 times in 16 under load, look 11-17). The prompt then waits in the session's queue
    /// and goes in once the agent takes input, as the window's held message does.
    pub(crate) fn prompt_as_user(&mut self, id: &str, text: String) -> Result<(), String> {
        match self.send("user", id, text.clone(), vec![], true) {
            Err(e) if e == "agent_blocked" || e == "screen not current, try again" => self
                .begin_send("user", id, text, vec![], true, "queued")
                .map(|_| ()),
            sent => sent.map(|_| ()),
        }
    }
    pub(crate) fn feature<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.settings.feature(key)
    }
    /// Ticket 993: whose schedules a session reads. Only the live seat of a place's lead reads any: `Some(place)`
    /// for a project's lead, `None` (every place) for the Home lead. A token, a session on another machine and every
    /// other session get the refusal a schedule request always gave.
    pub(crate) fn schedule_reach(
        &self,
        caller: &crate::grants::Caller,
    ) -> Result<Option<PathBuf>, String> {
        let refused = || "operation not granted".to_string();
        if self.grants.remote.contains(&caller.id) || tokens::is_token(caller) {
            return Err(refused());
        }
        let who = self
            .task_caller(Some(caller), None)
            .map_err(|_| refused())?;
        let place = who.place.filter(|_| who.decides).ok_or_else(refused)?;
        Ok((place != crate::team::Team::open(&self.home).home()).then_some(place))
    }
    /// The schedules of `place` (`None`: all). A teammate's schedule is of the place the teammate is in now; any
    /// other is of the folder it runs in.
    pub(crate) fn schedules_in(
        &self,
        place: Option<&Path>,
    ) -> Result<Vec<crate::schedule::Entry>, String> {
        let all = self.schedules.shown()?;
        let Some(place) = place else {
            return Ok(all);
        };
        let team = crate::team::Team::open(&self.home);
        let (mates, home) = (team.list()?, team.home());
        let of = |e: &crate::schedule::Entry| match &e.run.teammate {
            Some(id) => mates
                .iter()
                .find(|t| t.id == *id)
                .map(|t| t.project.clone().unwrap_or_else(|| home.clone())),
            None => Some(e.run.project.clone()),
        };
        Ok(all
            .into_iter()
            .filter(|e| of(e).as_deref() == Some(place))
            .collect())
    }
    /// Ticket 993: who may propose a schedule or a change: the live seat of a place's lead that is not doing a
    /// scheduled run (an unattended run must not make more runs). Gives its reach (`schedule_reach`) and its place's
    /// folder.
    fn schedule_proposer(
        &self,
        caller: &crate::grants::Caller,
    ) -> Result<(Option<PathBuf>, PathBuf), String> {
        let reach = self
            .schedule_reach(caller)
            .map_err(|_| "only the lead of a place proposes or changes a schedule".to_string())?;
        if self
            .entries
            .get(&caller.id)
            .is_some_and(|e| e.meta.schedule.is_some())
        {
            return Err(
                "a scheduled run cannot propose or change schedules: say it in your report, and the user can add it"
                    .into(),
            );
        }
        let place = reach
            .clone()
            .unwrap_or_else(|| crate::team::Team::open(&self.home).home());
        Ok((reach, place))
    }
    /// A schedule in one sentence, as its card says it: who, when, the model and effort its seat opens with (ticket
    /// 994: the level's own pair, never the level's word), the task in one line.
    fn schedule_line(&self, run: &crate::schedule::Run, when: &crate::schedule::When) -> String {
        let mate = run.teammate.as_ref().and_then(|id| {
            let all = crate::team::Team::open(&self.home).list().ok()?;
            all.into_iter().find(|t| t.id == *id)
        });
        let mut line = format!("{} · {}", run.label, when.words());
        if let Some(mate) = mate
            && let Some((level, _)) = crate::team::seat_level(&mate, run.level)
        {
            let table = self.feature::<serde_json::Value>(crate::team::LEVELS_KEY);
            let pick = crate::team::level_pick(table.as_ref(), &mate.agent_key(), level);
            let pair =
                crate::team::pick_words(mate.kind, pick.model.as_deref(), pick.effort.as_deref());
            line += &format!(" · {pair}");
        }
        if let Some(task) = &run.task {
            // One line, no hidden characters (they reorder or hide what the user reads on the card), what the logs
            // mask is masked (the card and the room keep it), and cut.
            let shown: String = task
                .chars()
                .filter(|c| !crate::board::rights::hidden(*c))
                .collect();
            let flat = shown.split_whitespace().collect::<Vec<_>>().join(" ");
            let flat = String::from_utf8_lossy(&crate::logs::mask(flat.as_bytes())).into_owned();
            let cut: String = flat.chars().take(160).collect();
            let more = if cut.len() < flat.len() { "…" } else { "" };
            line += &format!(": {cut}{more}");
        }
        line
    }
    /// Ticket 993: `nunchiro schedule propose`. Checked as the owner's add checks it (the teammate is of the caller's
    /// place, the time, a date still to come, the task's limits), so the card can be applied; then only the card.
    fn schedule_propose(
        &mut self,
        caller: &crate::grants::Caller,
        who: &str,
        when: &str,
        task: String,
        level: Option<crate::team::Level>,
    ) -> Response {
        let (reach, place) = self.schedule_proposer(caller)?;
        let name = who.trim().to_lowercase();
        let mate = crate::team::Team::open(&self.home)
            .list()?
            .into_iter()
            .find(|t| t.project == reach && t.name.to_lowercase() == name)
            .ok_or_else(|| format!("no teammate named {} in this place", who.trim()))?;
        let when = crate::schedule::When::parse(when)?;
        // No level asked is Light, as a schedule made by hand starts (ticket 993 rule 3); a custom model has no levels.
        let level = level.or(mate.model.is_none().then_some(crate::team::Level::Light));
        let run = crate::schedule::Run {
            kind: mate.kind,
            project: place.clone(),
            label: mate.name,
            model: None,
            effort: None,
            task: Some(task),
            teammate: Some(mate.id),
            level,
        };
        let entry = self.schedules.checked(
            run,
            when.clone(),
            None,
            &self.known_projects(),
            queue::now_ms(),
            &crate::usage::local_offset,
        )?;
        let line = self.schedule_line(&entry.run, &when);
        self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Schedule {
                change: "add".into(),
                id: None,
                run: entry.run,
                when,
                place,
                line: line.clone(),
                reason: None,
            },
        )?;
        Ok(Reply::Text { text: line })
    }
    /// Ticket 993: `nunchiro schedule change <id> pause|resume|remove`, for an entry the caller may read; a card.
    fn schedule_change(
        &mut self,
        caller: &crate::grants::Caller,
        id: &str,
        change: &str,
    ) -> Response {
        let (reach, place) = self.schedule_proposer(caller)?;
        let entry = self
            .schedules_in(reach.as_deref())?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| {
                format!("no schedule {id} in this place (`nunchiro schedule list` shows them)")
            })?;
        match (change, entry.paused) {
            ("pause", false) | ("remove", _) => {}
            ("resume", true) => {
                crate::schedule::resume_ms(&entry, queue::now_ms(), &crate::usage::local_offset)?;
            }
            ("pause", true) => return Err("that schedule is already off".into()),
            ("resume", false) => return Err("that schedule is already on".into()),
            _ => return Err("a schedule change is pause, resume or remove".into()),
        }
        let when = entry.when();
        let line = self.schedule_line(&entry.run, &when);
        self.queue.ask_owner(
            &caller.id,
            queue::OwnerAsk::Schedule {
                change: change.into(),
                id: Some(entry.id),
                run: entry.run,
                when,
                place,
                line: line.clone(),
                reason: None,
            },
        )?;
        Ok(Reply::Text { text: line })
    }
    /// Ticket 993 rule 6: the schedules whose last run failed, for the Home digest. Look 11-17 v9 (Home S2-1): only
    /// while the failure's card waits: a dismissed one is gone from Home too (the schedule row keeps its red dot).
    pub(crate) fn failed_runs(&self) -> Vec<crate::ledger::FailedRun> {
        let all = self.schedules.list().unwrap_or_default();
        let cards = self.queue.owner_items();
        let carded = |entry: &str| {
            cards.iter().any(|i| {
                matches!(&i.owner, Some(queue::OwnerAsk::Schedule { change, id: Some(id), .. })
                    if change == "failed" && id == entry)
            })
        };
        all.iter()
            .filter_map(|e| {
                let last = e.last.as_ref()?;
                (last.result == Some(crate::schedule::Outcome::Failed) && carded(&e.id)).then(
                    || crate::ledger::FailedRun {
                        schedule: e.id.clone(),
                        line: self.schedule_line(&e.run, &e.when()),
                        reason: last.reason.clone().unwrap_or_default(),
                        at: last.at,
                        session: last.session.clone(),
                    },
                )
            })
            .collect()
    }
    /// Look 11-17 v8 (Home S2-B): the owner's card for entry `id`, whose run just failed: one per entry, replaced by
    /// a newer failure. It is counted wherever owner cards are (the Decisions pane, the Team badge, the lead's chip),
    /// so a failed run is the same number everywhere. `place` is the entry's place (`schedules_in`).
    pub(crate) fn failed_run_card(&mut self, id: &str, reason: &str) {
        let Some(entry) = self
            .schedules
            .list()
            .ok()
            .and_then(|all| all.into_iter().find(|e| e.id == id))
        else {
            return;
        };
        let team = crate::team::Team::open(&self.home);
        let place = match &entry.run.teammate {
            Some(mate) => team
                .list()
                .ok()
                .and_then(|all| all.into_iter().find(|t| t.id == *mate))
                .map(|t| t.project.unwrap_or_else(|| team.home())),
            None => None,
        }
        .unwrap_or_else(|| entry.run.project.clone());
        let when = entry.when();
        // Ticket 1002 lane 4: the run before this one (a skip is no run) failed too: the card names the streak.
        let twice = entry
            .earlier
            .iter()
            .find(|l| l.result != Some(crate::schedule::Outcome::Skipped))
            .is_some_and(|l| l.result == Some(crate::schedule::Outcome::Failed));
        let reason = if twice {
            format!("{reason} · second time in a row")
        } else {
            reason.into()
        };
        let ask = queue::OwnerAsk::Schedule {
            change: "failed".into(),
            id: Some(entry.id.clone()),
            line: self.schedule_line(&entry.run, &when),
            run: entry.run,
            when,
            place,
            reason: Some(reason),
        };
        // No session asked. The stored item needs an id in `session_id` (`queue::validate`, and a core from before
        // this card must still load the file), so it carries the schedule's own id.
        if let Err(e) = self.queue.ask_owner(id, ask) {
            eprintln!("schedule {id}: no card for its failed run: {e}");
        }
    }
    fn drop_failed_card(&mut self, entry: &str) {
        self.drop_failed_cards(|id| id == entry);
    }
    /// Ticket 1034: a renamed teammate's seats (open, or resumable) take the new name as their label, which the tab,
    /// the header and the room read. A seat whose tab the user renamed no longer carries the old name and keeps its own.
    pub(crate) fn teammate_renamed(
        &mut self,
        teammate: &str,
        old: &str,
        new: &str,
    ) -> Result<(), String> {
        let mut changed = false;
        for e in self.entries.values_mut() {
            if e.meta.teammate.as_deref() == Some(teammate)
                && e.meta.state != SessionState::Closed
                && e.meta.label == old
            {
                e.meta.label = new.to_string();
                changed = true;
            }
        }
        if changed { self.save() } else { Ok(()) }
    }
    /// Look 1117 v11 (C NC3): a removed teammate leaves nothing running as it. Its seat closes as Close session does
    /// (a running one is stopped, then its Closed row goes, so no tab or Resume is left), and its schedules switch off:
    /// they stay listed, and one switched on again after a teammate of the same name was added runs as that teammate
    /// (`schedule::teammate_of`).
    /// Codex look of wave 18 (NOTE): what could not be stopped is returned, so the owner is told instead of a success.
    /// Look 1117 v13 Home S3-1: the room keeps each closed seat's `name`, as its row goes while its lines stay.
    pub(crate) fn teammate_removed(&mut self, teammate: &str, name: &str) -> Result<(), String> {
        let mut left: Vec<String> = vec![];
        let seats: Vec<String> = self
            .entries
            .values()
            .filter(|e| {
                e.meta.teammate.as_deref() == Some(teammate) && e.meta.state != SessionState::Closed
            })
            .map(|e| e.meta.id.clone())
            .collect();
        for id in seats {
            if let Some(room) = self.room_project(&id)
                && let Err(e) = crate::room::Log::open(&self.home, &room).name_seat(&id, name)
            {
                eprintln!("teammate {teammate} removed: the room keeps no name for seat {id}: {e}");
            }
            let running = self.entries[&id].meta.state == SessionState::Running;
            let closed = self.close(&id, true, false).and_then(|r| {
                if running && self.entries.contains_key(&id) {
                    self.close(&id, true, false)
                } else {
                    Ok(r)
                }
            });
            if let Err(e) = closed {
                eprintln!("teammate {teammate} removed: seat {id} not closed: {e}");
                left.push(format!(
                    "its seat could not be stopped ({e}); stop it from its row"
                ));
            }
        }
        let listed = self.schedules.list().unwrap_or_else(|e| {
            left.push(format!(
                "its schedules could not be read ({e}); switch them off in Schedules"
            ));
            vec![]
        });
        let on: Vec<String> = listed
            .into_iter()
            .filter(|e| e.run.teammate.as_deref() == Some(teammate) && !e.paused)
            .map(|e| e.id)
            .collect();
        for id in &on {
            match self.schedules.pause(
                id,
                true,
                crate::queue::now_ms(),
                &crate::usage::local_offset,
            ) {
                Ok(()) => self.drop_failed_card(id),
                Err(e) => {
                    eprintln!("teammate {teammate} removed: schedule {id} not switched off: {e}");
                    left.push(format!(
                        "a schedule could not be switched off ({e}); switch it off in Schedules"
                    ));
                }
            }
        }
        if !on.is_empty() {
            self.schedules_changed();
        }
        if left.is_empty() {
            Ok(())
        } else {
            Err(format!("The teammate is removed, but {}.", left.join("; ")))
        }
    }
    fn drop_failed_cards(&mut self, gone: impl Fn(&str) -> bool) {
        let failed = |i: &queue::Decision| {
            matches!(&i.owner, Some(queue::OwnerAsk::Schedule { change, id: Some(id), .. })
                if change == "failed" && gone(id))
        };
        if self.queue.owner_items().iter().any(failed)
            && let Err(e) = self.queue.answer_owner(failed)
        {
            eprintln!("a failed run's card not dropped: {e}");
        }
    }
    /// The schedule list changed (an add, an edit, a remove, a switch, a run or its result). The card of a failed run
    /// goes by itself once its entry is gone (removed, or edited: an edit is a new id) or it ran again (its last run
    /// is no failure and no skip: ticket 1002, a slot skipped as too late is no run); a switch-off drops it where the
    /// user switches (`drop_failed_card`). Readers hear of the change (`events::schedules_changed`).
    pub(crate) fn schedules_changed(&mut self) {
        crate::events::schedules_changed();
        // An unreadable schedule file says nothing about any entry: the cards stay.
        let Ok(all) = self.schedules.list() else {
            return;
        };
        self.drop_failed_cards(|id| {
            !all.iter().any(|e| {
                e.id == id
                    && e.last.as_ref().is_some_and(|l| {
                        matches!(
                            l.result,
                            Some(
                                crate::schedule::Outcome::Failed
                                    | crate::schedule::Outcome::Skipped
                            )
                        )
                    })
            })
        });
    }
    /// Ticket 993: a scheduled run started this session or sent its task to it (`Session::schedule`). The session
    /// already runs, so a failed save is logged; the next save writes it.
    pub(crate) fn scheduled_run(&mut self, id: &str, schedule: &str) {
        if let Some(entry) = self.entries.get_mut(id) {
            entry.meta.schedule = Some(schedule.into());
            if let Err(e) = self.save() {
                eprintln!("scheduled run not marked on its session yet: {e}");
            }
        }
    }
    /// Ticket 259: the project of the recorded worktree at `path` (canonical), read from the store without its lock.
    pub(crate) fn recorded_worktree_project(&self, path: &Path) -> Option<PathBuf> {
        recorded_worktree_project(&self.home, &self.settings, path)
    }
    /// Ticket 991 A2: a removed worktree's ended sessions close with it (their rows and tabs would offer a Restart
    /// in a folder that is gone). No Undo window: the folder they would come back to is gone.
    /// After one Codex look: `caller` (a session that asked for the remove) closes only what it may close anyway,
    /// itself and the sessions it started; another session's ended row stays for the owner. The owner closes all.
    pub(crate) fn close_ended_in(&mut self, path: &Path, caller: Option<&crate::grants::Caller>) {
        let ended: Vec<String> = self
            .entries
            .values()
            .filter(|e| {
                caller.is_none_or(|c| e.meta.id == c.id || self.started_by(&e.meta, &c.id))
                    && e.meta.cwd.starts_with(path)
                    && matches!(
                        e.meta.state,
                        SessionState::Exited
                            | SessionState::Failed
                            | SessionState::Resumable
                            | SessionState::Closed
                    )
            })
            .map(|e| e.meta.id.clone())
            .collect();
        if ended.is_empty() {
            return;
        }
        for id in ended {
            // A row the remove dialog's own "Stop N sessions and remove" closed a moment ago is Closed already (seen
            // in the real app: such rows and tabs stayed and offered a Restart): it goes as an ended one does. A
            // token-started row stays Closed, as in `close_and_drop` (ticket 621).
            if self.entries[&id].meta.state == SessionState::Closed {
                if self.token_origin(&self.entries[&id].meta).is_none() {
                    self.entries.remove(&id);
                    self.closed_views.retain(|other| other != &id);
                    if let Err(e) = self.queue.retain_sessions(|other| other != id) {
                        eprintln!("close {id}: queue state not dropped: {e}");
                    }
                }
                continue;
            }
            self.close_and_drop(&id, true);
        }
        if let Err(e) = self.save() {
            eprintln!("close after worktree remove: record not saved: {e}");
        }
    }
    /// Ticket 991 (Q7 point 1): session `id` just took its title from its first prompt. In a folder of its own (a
    /// worktree) the title is kept for the next worktree request, which runs git off this lock.
    fn title_names_branch(&mut self, id: &str) {
        let Some(meta) = self.entries.get(id).map(|e| &e.meta) else {
            return;
        };
        if meta.cwd != meta.project && meta.machine.is_none() {
            // shortcut: a title waits for the next worktree request (a window lists every 30 s) and at most 64 are kept, rename at the title itself if a core with no window must do it.
            if self.branch_titles.len() >= 64 {
                self.branch_titles.remove(0);
            }
            self.branch_titles
                .push((meta.cwd.clone(), meta.label.clone()));
        }
    }
    pub(crate) fn take_branch_titles(&mut self) -> Vec<(PathBuf, String)> {
        std::mem::take(&mut self.branch_titles)
    }
    pub(crate) fn release_worktree(&mut self, path: Option<PathBuf>) {
        if let Some(path) = path {
            self.removing_worktrees.remove(&path);
        }
    }
    pub(crate) fn worktree_plan(
        &self,
        caller: Option<&crate::grants::Caller>,
        request: Request,
    ) -> Result<WorktreePlan, String> {
        if let Some(caller) = caller {
            self.check_token(caller, &request)?; // ticket 573: `server::worktree` runs no `check_agent`
        }
        let Request::Worktree {
            operation,
            project,
            path,
            branch,
            base,
            label,
            from,
            confirm,
        } = request
        else {
            return Err("expected worktree request".into());
        };
        if ![
            "create", "open", "list", "remove", "forget", "rename", "restore", "adopt", "branches",
            "team",
        ]
        .contains(&operation.as_str())
            || label.len() > 256
            || from.as_ref().is_some_and(|f| f.len() > 2048)
        {
            return Err("invalid worktree request".into());
        }
        // V2-8a: every op this ticket adds is the owner's (the window's) alone: discarding unsaved work, the label,
        // Undo, the record clean-up, and the one-field create (it can run the user's gh).
        if caller.is_some()
            && (confirm.is_some()
                || from.is_some()
                || ["rename", "restore", "forget", "adopt", "team"].contains(&operation.as_str()))
        {
            return Err("operation not granted".into());
        }
        // Ticket 990: the owner hands a worktree to the lead of its project (`label` is that teammate's id), or takes
        // it back (no label).
        if operation == "team" && !label.is_empty() {
            let at = path.as_ref().ok_or("requires --path")?;
            let at = fs::canonicalize(at).map_err(|e| e.to_string())?;
            let project = self
                .recorded_worktree(&at)
                .map(|w| w.project)
                .ok_or("worktree not managed")?;
            let leads = crate::team::Team::open(&self.home).lead_of(Some(&project));
            if leads.is_none_or(|t| t.id != label) {
                return Err("a worktree is handed to the lead of its project".into());
            }
        }
        // V2.5-61 B8: `branches` reads one project's refs and takes nothing else; a session caller reads only its own
        // session's project (none named means that one).
        let branches = operation == "branches";
        if branches
            && (path.is_some()
                || branch.is_some()
                || !(base.is_empty() || base == "HEAD")
                || !label.is_empty()
                || from.is_some()
                || confirm.is_some())
        {
            return Err("invalid worktree request".into());
        }
        let project = match caller {
            Some(caller) if branches => {
                let own = fs::canonicalize(&caller.project).map_err(|e| e.to_string())?;
                let named = project.map(fs::canonicalize).transpose();
                if named
                    .as_ref()
                    .is_ok_and(|p| p.as_ref().is_none_or(|p| *p == own))
                {
                    Some(own)
                } else {
                    return Err("operation not granted".into());
                }
            }
            _ if branches => Some(project.ok_or("branches requires a project")?),
            _ => project,
        };
        let path = path
            .map(|path| match fs::canonicalize(&path) {
                Ok(path) => Ok(path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
                Err(e) => Err(e.to_string()),
            })
            .transpose()?;
        let project = project
            .map(fs::canonicalize)
            .transpose()
            .map_err(|e| e.to_string())?;
        if operation == "remove"
            && path.as_ref().is_some_and(|p| {
                self.entries
                    .values()
                    .any(|e| e.meta.cwd == *p && e.meta.state == SessionState::Running)
            })
        {
            return Err("close live worktree sessions first".into());
        }
        Ok(WorktreePlan {
            home: self.home.clone(),
            root: self.worktree_root(),
            operation,
            project,
            path,
            branch,
            base,
            label,
            creator: caller.map(|c| c.id.clone()), // v1a-16; v1a-23: shown, no longer a limit
            token: caller.is_some_and(|c| self.token_of(c).is_some()),
            team: caller.and_then(|c| self.team_lead_of(&c.id)), // ticket 990
            from,
            confirm,
            dir: self.settings.worktrees_dir.clone(),
            user_home: self.settings.user_home.clone(),
            prefix: self
                .settings
                .feature::<String>("git.branch_prefix")
                .unwrap_or_default(),
            titles: vec![],
        })
    }
    pub fn launch(&self, start: StartSession) -> Launch {
        let project = fs::canonicalize(&start.project).ok();
        let prior = start.resume.as_ref().and_then(|id| {
            self.entries.values().find(|e| {
                e.meta.kind == start.kind
                    && e.meta.agent_session_id.as_ref() == Some(id)
                    && Some(&e.meta.project) == project.as_ref()
            })
        });
        let start_resume_cwd = prior.map(|e| e.meta.cwd.clone()).filter(|cwd| cwd.is_dir());
        let resume_config = prior.map(|e| e.meta.config_dir.clone()); // v2-2b
        let ran_mode = prior.and_then(|e| e.meta.ran_mode.clone());
        let home_lock = prior
            .into_iter()
            .chain(side_parent(&start).and_then(|p| self.entries.get(&p)))
            .any(|e| e.meta.home_lock);
        Launch {
            home: self.home.clone(),
            settings: self.settings.clone(),
            start,
            id: String::new(),
            project: PathBuf::new(),
            cwd: PathBuf::new(),
            version: None,
            version_probe: Default::default(), // V1A-89
            worktree_created: false,
            committed: false,
            codex_read_only: None,
            codex_hooks_clear: None,
            ultracode: None,
            // v1a-09: a resumed conversation lives in the folder it ran in (a worktree), not the project's.
            folder: None,
            resume_cwd: start_resume_cwd,
            start_commit: None, // v1b-11
            config: None,       // v2-2a
            resume_config,      // v2-2b
            carry_from: None,
            account: None,        // v2-2b
            without_hooks: false, // v2-5b
            no_history: false,
            account_tab: false,
            owner: false,
            owner_terminal: false,
            home_lock,
            home_mode: None,
            permission: vec![],
            ran_mode,
            command: None,
            approved_args: vec![],
            bypass_disabled: false,
            env: BTreeMap::new(),
            origin: None,
        }
    }
    /// ACCOUNTPICK: a session caller (token or remote) starts sessions on its own session's account only: none given
    /// means the caller's; another label is refused before anything is created. The owner (`None`) picks any; none
    /// given means the owner's default (ticket 1126).
    /// `remote`: as in `start_granted`.
    pub(crate) fn launch_as(
        &self,
        caller: Option<&crate::grants::Caller>,
        mut start: StartSession,
        remote: bool,
    ) -> Result<Launch, String> {
        if let Some(caller) = caller {
            let own = self.caller_account(caller, remote);
            match &start.account {
                Some(label)
                    if Some(label) != own.as_ref()
                        && Some(label) != self.place_account(caller, remote).as_ref()
                        && Some(label)
                            != self.default_account(start.kind, remote).flatten().as_ref()
                        && !self.lead_any(caller, remote) =>
                {
                    return Err("a session can start sessions only on its own account".into());
                }
                // Ticket 451 (security look, reproduced): naming its own account on a resume would carry a conversation
                // that ran on another account into the caller's. Only the owner continues a conversation elsewhere.
                Some(_)
                    if start.resume.as_ref().is_some_and(|id| {
                        self.entries.values().any(|e| {
                            e.meta.agent_session_id.as_ref() == Some(id) && e.meta.account != own
                        })
                    }) =>
                {
                    return Err("a session can start sessions only on its own account".into());
                }
                // A resume keeps the account it ran on; `start_granted` checks that it is the caller's.
                // V2-4a (needs 87): an ACP session has no account.
                // Ticket 1126: a new one starts on its place's account (1120) where its agent has one by that label,
                // else on the owner's default (an explicit "Your own" is no label), else on the caller's own.
                None if !matches!(start.kind, AgentKind::Shell | AgentKind::Acp)
                    && start.resume.is_none() =>
                {
                    let agent = crate::accounts::agent_of(start.kind);
                    start.account = self
                        .place_account(caller, remote)
                        .filter(|l| {
                            agent.is_some_and(|a| {
                                crate::accounts::folder_by_label(&self.home, a, l).is_ok()
                            })
                        })
                        .map(Some)
                        .or_else(|| self.default_account(start.kind, remote))
                        .unwrap_or(own);
                }
                _ => {}
            }
        } else if start.account.is_none()
            && start.resume.is_none()
            && !matches!(start.kind, AgentKind::Shell | AgentKind::Acp)
        {
            // Codex security look P2 (1126 round 3): the owner's start with no account named (`session start`, a
            // schedule, a team start) takes the status bar's pick too. The window names its account itself.
            start.account = self.default_account(start.kind, remote).flatten();
        }
        self.check_side_resume(&start)?;
        let mut launch = self.launch(start);
        launch.origin = caller.and_then(|c| self.token_of(c));
        // Ticket 1002 lane 1 (check MUST 1): a session a locked one starts, in any folder, is locked too.
        launch.home_lock |= caller
            .and_then(|c| self.entries.get(&c.id))
            .is_some_and(|e| e.meta.home_lock);
        Ok(launch)
    }
    /// Ticket 1120: the account the user set for the caller's place (`nunchiro task account`, `ledger::Place`). A
    /// session of that place may start sessions on it as on its own (ACCOUNTPICK widened by the user, per place); a
    /// remote caller never.
    fn place_account(&self, caller: &crate::grants::Caller, remote: bool) -> Option<String> {
        if remote {
            return None;
        }
        let place = self.task_caller(Some(caller), None).ok()?.place?;
        crate::ledger::Ledger::open(&self.home)
            .place(&place)
            .account
    }
    /// Owner 2026-11-25 ("적용하고"): with "Leads may use any of my accounts" on (`accounts::LEADS_ANY`), a team lead's own
    /// seat may start sessions on any registered account and continue itself on one (ticket 451 carry). Never a session
    /// under a lead (a worker or reviewer), a remote caller, an outside token or an ACP session.
    fn lead_any(&self, caller: &crate::grants::Caller, remote: bool) -> bool {
        !remote
            && self.token_of(caller).is_none()
            && self.settings.feature::<bool>(crate::accounts::LEADS_ANY) == Some(true)
            && self.entries.get(&caller.id).is_some_and(|e| {
                matches!(e.meta.kind, AgentKind::Claude | AgentKind::Codex)
                    && e.meta.teammate.is_some()
                    && self.team_lead_of(&caller.id) == e.meta.teammate
            })
    }
    /// The room line of a start or move that only `lead_any` admitted, in the lead's place, to the lead. Written
    /// before the start; an error refuses it.
    fn lead_any_line(
        &self,
        caller: &crate::grants::Caller,
        launch: &Launch,
        account: &str,
    ) -> Result<(), String> {
        let refused = |why: &str| format!("a start on another account needs its room line ({why})");
        let lead = self
            .team_lead_of(&caller.id)
            .ok_or_else(|| refused("no lead"))?;
        let team = crate::team::Team::open(&self.home);
        let mate = team
            .list()
            .ok()
            .and_then(|l| l.into_iter().find(|t| t.id == lead))
            .ok_or_else(|| refused("the lead is not in the team"))?;
        let label = match launch.start.label.as_str() {
            "" => "a session",
            l => l,
        };
        let place = mate.project.clone().unwrap_or_else(|| team.home());
        let moved = launch.start.resume.is_some()
            && launch.start.resume
                == self
                    .entries
                    .get(&caller.id)
                    .and_then(|e| e.meta.agent_session_id.clone());
        let line = if moved {
            format!(
                "{} continues itself on account {account} (Leads may use any of my accounts)",
                mate.name
            )
        } else {
            format!(
                "{} starts {label} on account {account} (Leads may use any of my accounts)",
                mate.name
            )
        };
        let note = crate::advance::team_note(&line, None);
        crate::room::Log::open(&self.home, &place)
            .team(&lead, line, note)
            .map(|_| ())
            .map_err(|e| refused(&e))
    }
    /// Ticket 1126: the owner's default account for new sessions of `kind` (`accounts::default_label`); a session caller
    /// may start on it as on its own. A remote caller never gets it, as it never gets a place account.
    fn default_account(&self, kind: AgentKind, remote: bool) -> Option<Option<String>> {
        if remote {
            return None;
        }
        crate::accounts::default_pick(&self.home, crate::accounts::agent_of(kind)?)
    }
    /// The account label of the caller's own session. A remote caller chooses its id (it may be a local session's), so
    /// it never has one: it counts as "Your own".
    fn caller_account(&self, caller: &crate::grants::Caller, remote: bool) -> Option<String> {
        if remote {
            return None;
        }
        self.entries
            .get(&caller.id)
            .and_then(|e| e.meta.account.clone())
    }
    /// V2-2d: the sessions on account folder `folder`: the labels of those that block its removal (live or resumable on
    /// it, or running inside it, as its login and logout tabs do), and how many others (closed, or ended without a
    /// conversation to resume) lose their history with it.
    pub(crate) fn account_users(&self, folder: &Path) -> (Vec<String>, usize) {
        let mut blocking = vec![];
        let mut others = 0;
        // V2-6d: a close-pending row can still come back by Undo, so it counts like `snapshot` shows it.
        let pending = self.closing.as_ref().map(|c| &c.entry);
        for (meta, closing) in self
            .entries
            .values()
            .map(|e| (&e.meta, false))
            .chain(pending.map(|e| (&e.meta, true)))
        {
            let on = meta.config_dir.as_deref() == Some(folder);
            let live = meta.state == SessionState::Running;
            let inside = meta.cwd.starts_with(folder) || meta.project.starts_with(folder);
            if (on || live && inside)
                && (live
                    || meta.state != SessionState::Closed
                        && resumable(meta) == SessionState::Resumable)
            {
                let name = if meta.label.is_empty() {
                    &meta.id
                } else {
                    &meta.label
                };
                blocking.push(if closing {
                    format!("{name} (closing, Undo window)")
                } else {
                    name.clone()
                });
            } else if on {
                others += 1;
            }
        }
        (blocking, others)
    }
    /// V2-2a: an account's login tab. The override is set here only, never from a `StartSession`.
    pub(crate) fn launch_account(
        &self,
        start: StartSession,
        variable: &'static str,
        folder: PathBuf,
    ) -> Launch {
        let mut launch = self.launch(start);
        launch.config = Some((variable, folder));
        launch
    }
    fn check_side_resume(&self, start: &StartSession) -> Result<(), String> {
        if let Some(resume) = &start.resume
            && self.entries.values().any(|entry| {
                entry.meta.side_chat && entry.meta.agent_session_id.as_ref() == Some(resume)
            })
        {
            return Err("Side chat is temporary; open a new side chat".into());
        }
        Ok(())
    }
    pub fn start(&mut self, launch: &Launch) -> Result<Session, String> {
        // Ticket 1122 B: a start served after the Stop (the window's, in the stop's wake) spawned a holder the stopped
        // core never stops; it outlived the core and wrote into the data folder.
        if self.stopped() {
            return Err("core is stopping; nothing starts".into());
        }
        self.check_side_resume(&launch.start)?;
        let (command, account) = self.start_checks(launch)?; // claude_modes.rs, also a restart's before it stops
        self.refresh()?;
        // Ticket 286 S3: the parent's agent, not its row: never from a shell left after the agent quit.
        if let Some(parent) = side_parent(&launch.start)
            && !self
                .entries
                .get(&parent)
                .is_some_and(|e| self.agent_running(e))
        {
            return Err("Side chat parent is not running".into());
        }
        // Ticket 1002 lane 1: a Home seat, or a session a locked one started, runs only as a Claude start with the lock
        // `prepare` built; a path that skipped it is refused here, under the lock that starts.
        let claude = launch.start.kind == AgentKind::Claude;
        if (launch.home_lock || (claude && crate::home_lock::in_home(&self.home, &launch.cwd)))
            && !(claude
                && launch.home_mode.is_some()
                && crate::home_lock::locked(&launch.permission))
        {
            return Err(if claude {
                "the Home seat lock is missing from this start".into()
            } else {
                "a Home seat starts only Claude sessions (they carry its lock)".into()
            });
        }
        if launch.start.kind == AgentKind::Acp {
            return self.spawn_acp(launch); // V2-4a
        }
        if self.entries.values().filter(|e| e.pty.is_some()).count() >= 32 {
            return Err("maximum 32 retained PTYs; close an exited session first".into());
        }
        let session = self.spawn(
            &launch.id,
            &launch.project,
            &launch.cwd,
            &launch.start,
            launch.version.clone(),
            launch.start_commit.clone(), // v1b-11
            launch.config.as_ref(),      // v2-2a
            account,                     // v2-2b
            launch.without_hooks,        // v2-5b
            launch.no_history,
            launch.account_tab,
            &launch.permission,
            launch.bypass_disabled,
            command.as_ref(),
            &launch.approved_args,
            &launch.env,
            launch.origin.clone(),
            launch.codex_read_only,
            launch.codex_hooks_clear,
            launch
                .home_mode
                .filter(|_| launch.start.kind == AgentKind::Claude),
            launch.owner || launch.owner_terminal, // ticket 1008 round 2
            launch.ultracode,
        )?;
        self.entry(&session.id)?.version_probe = launch.version_probe.take(); // V1A-89
        if launch.start.resume.is_some() {
            self.merge_yes_on_resume(&session.id);
        }
        // Look 11-17 v3 P5: a resume knows its mode before Claude draws its footer.
        self.entry(&session.id)?.meta.ran_mode = launch.ran_mode.clone();
        // Ticket 991 (B6 chip): Codex draws no footer to read it from again, so it is stored now.
        if launch.start.kind == AgentKind::Codex && launch.ran_mode.is_some() {
            if let Err(e) = self.save() {
                eprintln!("start {}: permission mode not saved: {e}", session.id);
            }
            let meta = self.entry(&session.id)?.meta.clone();
            return Ok(self.snapshot_session(&meta));
        }
        Ok(session)
    }
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &mut self,
        id: &str,
        project: &Path,
        cwd: &Path,
        start: &StartSession,
        version: Option<String>,
        start_commit: Option<crate::diff::Base>,  // v1b-11
        config: Option<&(&'static str, PathBuf)>, // v2-2a
        account: Option<String>,                  // v2-2b
        without_hooks: bool,                      // v2-5b
        no_history: bool,
        account_tab: bool,
        permission: &[String], // ticket 362
        bypass_disabled: bool,
        command: Option<&crate::approval::CommandProof>, // ticket 358
        approved: &[String], // never in `start.args`, which a session stores and replays
        env: &BTreeMap<String, String>, // ticket 573: checked by `Launch::with_env`
        origin: Option<String>, // ticket 573: the caller's token
        codex_read_only: Option<bool>, // Q9 en-b-J7-1: read by `Launch::prepare`, off the lock
        codex_hooks_clear: Option<bool>, // Q9 en-b-J7-2: the same
        home_mode: Option<crate::home_lock::Mode>, // ticket 1002 lane 1: a locked Claude start
        by_owner: bool,      // ticket 1008 round 2: the window or the owner's terminal
        ultracode: Option<bool>, // ticket 1018: as Claude's settings start it
    ) -> Result<Session, String> {
        let agent;
        let program = match start.kind {
            AgentKind::Claude => {
                agent = agent_program("claude", command);
                agent.as_str()
            }
            AgentKind::Codex => {
                agent = agent_program("codex", command);
                agent.as_str()
            }
            // The user's own shell (fish, bash, ...), as the shell an ended agent leaves (`AGENT_WRAPPER`); it was
            // always zsh until ticket 991.
            AgentKind::Shell => {
                agent = std::env::var("SHELL")
                    .ok()
                    .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
                    .unwrap_or_else(|| "/bin/zsh".into());
                start.args.first().map_or(agent.as_str(), String::as_str)
            }
            AgentKind::Acp => return Err("an ACP agent has no PTY".into()), // V2-4a: `spawn_acp`
        };
        // v1b-02: one version list for launch and chat.
        let tested =
            crate::chat::tested(start.kind, version.as_deref(), crate::chat::TESTED_VERSIONS);
        let agent_session_id = match start.kind {
            AgentKind::Claude => Some(start.resume.clone().unwrap_or(store::new_id()?)),
            AgentKind::Codex => start.resume.clone(),
            AgentKind::Shell | AgentKind::Acp => None,
        };
        if agent_session_id
            .as_deref()
            .is_some_and(|s| !store::valid_id(s))
        {
            return Err("invalid resume session id".into());
        }
        // v1b-07: found before the command is built, which needs the prior run's artifact folder.
        let prior_ids: Vec<String> = self
            .entries
            .values()
            .filter(|entry| {
                start.resume.is_some()
                    && entry.meta.kind == start.kind
                    && entry.meta.project == project
                    && entry.meta.agent_session_id == start.resume
            })
            .map(|entry| entry.meta.id.clone())
            .collect();
        // V2-1a r3: or its agent may still run (a holder that stopped answering or died): never a second one.
        if prior_ids.iter().any(|id| {
            let entry = &self.entries[id];
            entry.meta.state == SessionState::Running
                || entry.pty.as_ref().is_some_and(Pty::agent_running)
        }) {
            return Err("conversation is already running".into());
        }
        // v1b-07: the artifact folder; a resumed conversation keeps the one of the run it continues.
        let artifacts = (start.kind != AgentKind::Shell)
            .then(|| -> Result<(Option<String>, PathBuf), String> {
                let folder_id = prior_ids.first().map(|old| {
                    let meta = &self.entries[old].meta;
                    meta.artifacts.clone().unwrap_or_else(|| meta.id.clone())
                });
                let parent = self.home.join("artifacts");
                store::private_dir(&parent)?;
                let folder = parent.join(folder_id.as_deref().unwrap_or(id));
                store::private_dir(&folder)?;
                Ok((
                    folder_id,
                    fs::canonicalize(&folder).map_err(|e| e.to_string())?,
                ))
            })
            .transpose()?;
        // end v1b-07
        // v2-2b: an agent session's account folder (a login tab is a shell and records none).
        let config_dir = config
            .filter(|_| start.kind != AgentKind::Shell)
            .map(|(_, folder)| folder.clone());
        // w10 item 13: see the Shell arm below.
        let wait_size =
            start.kind == AgentKind::Shell && start.args.is_empty() && self.window_size.is_none();
        let mut cmd = CommandBuilder::new(if wait_size { "/bin/sh" } else { program });
        // Ticket 260: the login shell's variables (held by `user_env`, never set on the core) come first, so every
        // value set or removed below (parent session, account, approved `env`, Nunchiro's own) wins over them.
        self.seat_env(&mut cmd, home_mode.is_some());
        // Ticket 1008: a shell keeps the owner's environment only when the owner opened it; one an agent, a schedule or
        // a peer starts (`nunchiro session start --kind shell`) is stripped like an agent.
        if start.kind != AgentKind::Shell || !by_owner {
            self.strip_secret_env(&mut cmd, start.kind);
        }
        // Keep user config locations and credentials; clear the launching session's identity and messaging channel.
        for (key, _) in std::env::vars_os().filter(|(key, _)| is_parent_session_env(key)) {
            cmd.env_remove(key);
        }
        // V2-2a: an account login sees its own folder only, never the core's inherited one for either agent.
        // Nor an API key or token the core inherited, which would sign the login in as someone else. V2-2b: the same
        // for an agent session on an account.
        if let Some((variable, folder)) = config {
            for key in ACCOUNT_ENV {
                cmd.env_remove(key);
            }
            cmd.env(variable, folder);
        }
        // Before the core's own values, so none of those can be replaced even if the check missed one.
        for (key, value) in env {
            cmd.env(key, value);
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("NUNCHIRO_HOME", &self.home);
        // Ticket 990: `nunchiro` typed in a session is this core's own CLI, so its folder leads the session's PATH. In
        // a trial with real Claude an installed older `nunchiro` came first: it could not read this core's worktree
        // reply ("unknown field team"), and the lead fell back to plain `git worktree add`.
        if let Some(own) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
        {
            let rest = std::env::var_os("PATH").unwrap_or_default();
            let parts = std::iter::once(own.clone())
                .chain(std::env::split_paths(&rest).filter(|p| *p != own));
            if let Ok(path) = std::env::join_paths(parts) {
                cmd.env("PATH", path);
            }
        }
        let token = store::new_id()? + &store::new_id()?;
        crate::logs::register(&token, "session"); // v2-13a
        cmd.env("NUNCHIRO_SESSION", id);
        cmd.env("NUNCHIRO_TOKEN", &token);
        // v1b-07
        if let Some((_, folder)) = &artifacts {
            cmd.env("NUNCHIRO_ARTIFACTS", folder);
        }
        // Ticket 991 (fifth look, S2): zsh marks its prompts, see `ZSH_MARKS`. Only a shell session whose program is
        // zsh; a failed write starts the shell without marks.
        if start.kind == AgentKind::Shell
            && Path::new(program).file_name().is_some_and(|n| n == "zsh")
            && std::env::var_os("NUNCHIRO_SHELL_INTEGRATION").is_none_or(|v| v != "0")
            && let Ok(dir) = zsh_marks_dir(&self.home)
        {
            if let Some(own) = std::env::var_os("ZDOTDIR") {
                cmd.env("NUNCHIRO_USER_ZDOTDIR", own);
            }
            cmd.env("ZDOTDIR", dir);
        }
        match start.kind {
            // V2-4a: an ACP start returned above (`AgentKind::Acp` has no PTY).
            AgentKind::Shell | AgentKind::Acp => {
                // w10 item 13: a plain shell started before any window gave a size (a new home: none stored) would
                // build its prompt for the PTY's first 160 columns, and the window's narrower first open then shows it
                // twice. It waits for the window's size before it starts (the PTY's size changes when a window opens
                // it), for at most `shell_size_wait_tenths` tenths of a second, then starts anyway. Nothing is typed into
                // it: the wait reads only the terminal's size. Ticket 1001: a first size of exactly 160x50 changes
                // nothing, so the wait also ends once the window's first Resize writes `WINDOW_SIZE` ($1). Ticket 1137:
                // and once the core writes into it ($2, see `write_send`): a lead's first prompt runs at once, not 8 s later.
                if wait_size {
                    let sized = self.home.join(WINDOW_SIZE);
                    store::private_dir(&self.home.join("shell"))?;
                    let go = self.home.join("shell").join(format!("{id}.go"));
                    cmd.args([
                        "-c",
                        &format!(
                            "i=0; while [ \"$(stty size 2>/dev/null)\" = \"50 160\" ] && [ ! -e \"$1\" ] && [ ! -e \"$2\" ] && [ $i -lt {} ]; do sleep 0.1; i=$((i+1)); done; rm -f \"$2\"; exec \"$0\"",
                            shell_size_wait_tenths()
                        ),
                        program,
                        &sized.to_string_lossy(),
                        &go.to_string_lossy(),
                    ]);
                    self.size_waits.insert(id.into(), go);
                } else {
                    cmd.args(start.args.iter().skip(1));
                }
            }
            AgentKind::Claude => {
                // v1b-07: Claude's `--add-dir` takes several values (`<directories...>`); ticket 276 round 3: it goes
                // first, so the `--session-id`/`--resume` that always follows ends the list, never the user's prompt.
                if let Some((_, folder)) = &artifacts {
                    cmd.arg("--add-dir");
                    cmd.arg(folder);
                }
                cmd.arg(if start.resume.is_some() {
                    "--resume"
                } else {
                    "--session-id"
                });
                cmd.arg(agent_session_id.as_ref().unwrap());
                if let Some(model) = &start.model {
                    cmd.args(["--model", model]);
                }
                if let Some(effort) = &start.effort {
                    cmd.args(["--effort", effort]);
                }
                cmd.args(permission); // ticket 362
                cmd.args(extension_flags(
                    &self.home,
                    &self.settings,
                    AgentKind::Claude,
                    home_mode.is_some(),
                )?); // ticket 276
            }
            AgentKind::Codex => {
                // Ticket 692 r2 (security): a later `-c` wins in Codex, so an approved or typed argument that names the
                // key could turn the update screen back on; any argument naming it is refused, a prompt that says it too.
                if approved
                    .iter()
                    .chain(&start.args)
                    .any(|arg| arg.contains("check_for_update_on_startup"))
                {
                    return Err("Codex arguments cannot set check_for_update_on_startup; Nunchiro keeps Codex's update screen off".into());
                }
                cmd.arg("--no-daemon");
                // Ticket 692: Codex's update screen preselects "Update now", so one Enter (the person's, a lead's
                // `agent send`, a script's) runs a machine-wide `brew upgrade` under every running worker. No seat
                // shows it; the person updates Codex outside Nunchiro (Orca does the same for its automated starts).
                cmd.args(["-c", "check_for_update_on_startup=false"]);
                cmd.args(permission); // ticket 362: global options, so before `resume`
                cmd.args(approved); // ticket 358: the same
                // V2.5-31: Codex has no plugin folder; the pointer to the guide rides on this launch only (a global option, so before `resume`).
                // Ticket 276: so do Nunchiro's own MCP servers.
                cmd.args(extension_flags(
                    &self.home,
                    &self.settings,
                    AgentKind::Codex,
                    false,
                )?);
                if let Some(resume) = &start.resume {
                    cmd.args(["resume", resume]);
                }
                if let Some(model) = &start.model {
                    cmd.args(["-m", model]);
                }
                if let Some(effort) = &start.effort {
                    cmd.arg("-c");
                    cmd.arg(format!(
                        "model_reasoning_effort={}",
                        serde_json::to_string(effort).unwrap()
                    ));
                }
                // v1b-07: a writable root. v1b-35: Codex 0.161.0 exits at start on `--add-dir` under a read-only
                // sandbox, so a read-only session gets none (the folder and variable stay; it cannot write there).
                // v1b-38: read-only from the launch args or Codex's config layers.
                if let Some((_, folder)) = artifacts.as_ref().filter(|_| {
                    !codex_read_only.unwrap_or_else(|| {
                        crate::codex_sandbox::read_only(
                            &[permission, approved, &start.args[..]].concat(),
                            cwd,
                            config_dir.as_deref(),
                        )
                    })
                }) {
                    cmd.arg("--add-dir");
                    cmd.arg(folder);
                }
            }
        }
        // v1b-07: the per-session settings file also carries the artifact folder's permission rules, with or without
        // hooks.
        let mut settings = serde_json::Map::new();
        if let Some(m) = self
            .start_modes
            .as_ref()
            .filter(|_| start.kind == AgentKind::Claude)
        {
            claude_modes::settings(&mut settings, m); // W35
        }
        if let Some(rules) = artifacts
            .as_ref()
            .filter(|_| start.kind == AgentKind::Claude)
            .and_then(|(_, folder)| folder_permissions(folder))
        {
            settings.insert("permissions".into(), rules);
        }
        // end v1b-07
        // Round 4 (security MUST 1): a run that continues a token session (a resume by anyone, a problem restart) or a
        // side chat of one is a token session too.
        // Round 6 (security r5 MUST 1): the origin is stored on the record, so a later close or resume of a parent
        // changes nothing.
        // Ticket 621 round 3: a token row is never removed without a replacement that keeps its origin (only marked
        // Closed, replaced by its resume below, or dropped with a `token_conversations` record, ticket 752), so its
        // conversation's origin is found on a row, on the row inside its Undo window (`closing`), or in that record. Round 4: by conversation id and agent kind in every project, not `prior_ids`
        // (same project only): a worktree's conversation resumed from its main folder keeps the token too. A caller
        // acting for another token is refused: the run would carry that token instead of the one it ran under.
        let prior_origin = self
            .entries
            .values()
            .map(|e| &e.meta)
            .chain(self.closing.as_ref().map(|c| &c.entry.meta))
            .filter(|m| {
                start.resume.is_some() && m.kind == start.kind && m.agent_session_id == start.resume
            })
            .find_map(|m| self.token_origin(m))
            .or_else(|| {
                // Ticket 752: a dropped token row's conversation keeps its origin in sessions.json.
                self.token_conversations
                    .iter()
                    .find(|t| {
                        t.kind == start.kind && start.resume.as_ref() == Some(&t.conversation)
                    })
                    .map(|t| t.origin.clone())
            });
        if let (Some(caller), Some(prior)) = (&origin, &prior_origin)
            && caller != prior
        {
            return Err("this conversation ran under another token; it can be resumed only by that token or the owner".into());
        }
        if origin.is_some() && prior_origin.is_none() && start.resume.is_some() && self.origins_lost
        {
            return Err("a set-aside session store could not be read, so this conversation's token is unknown; only the owner can resume it".into());
        }
        let origin = origin.or(prior_origin).or_else(|| {
            side_parent(start)
                .and_then(|p| self.entries.get(&p))
                .and_then(|e| self.token_origin(&e.meta))
        });
        let outside = origin.is_some();
        if outside && start.kind != AgentKind::Claude {
            return Err("a token session runs only Claude".into());
        }
        if outside {
            tokens::keep_out(&self.home, &mut settings)?;
        }
        if start.kind != AgentKind::Shell && !self.settings.disable_hook_injection && !without_hooks
        {
            let lines = nunchiro_hooks()?;
            if start.kind == AgentKind::Claude {
                let hooks: serde_json::Map<String, serde_json::Value> = lines.into_iter().map(|line| {
                    // Ticket 991 B3: Claude's permission hook may wait for the card's answer (`queue::HOLD_MS`).
                    let handler = if line.event == "PermissionRequest" {
                        serde_json::json!({"type":"command","command":format!("{} --hold", line.command),"timeout":queue::HOLD_MS / 1000 + 10})
                    } else {
                        serde_json::json!({"type":"command","command":line.command,"timeout":2})
                    };
                    let block = if line.matcher.is_empty() { serde_json::json!([{"hooks":[handler]}]) } else { serde_json::json!([{"matcher":line.matcher,"hooks":[handler]}]) };
                    (line.event, block)
                }).collect();
                settings.insert("hooks".into(), hooks.into()); // v1b-07
                // Ticket 1036: Claude Code hands its status line command `rate_limits`; ours keeps them for the usage
                // bar and runs the user's own status line command with the same input, so their line is unchanged.
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                settings.insert(
                    "statusLine".into(),
                    serde_json::json!({"type": "command", "command": format!("{} hook statusline", shell_quote(&exe.to_string_lossy()))}),
                );
            } else if start.args.is_empty()
                && approved.is_empty()
                && codex_hooks_clear
                    .unwrap_or_else(|| codex_hooks_exclusive(cwd, project, config_dir.as_deref()))
            {
                cmd.args(["--enable", "default_mode_request_user_input"]);
                for line in lines {
                    cmd.arg("-c");
                    cmd.arg(format!(
                        "hooks.{}=[{{hooks=[{{type=\"command\",command={},timeout=2}}]}}]",
                        line.event,
                        serde_json::to_string(&line.command).unwrap()
                    ));
                }
                cmd.arg("--dangerously-bypass-hook-trust");
            }
        }
        // Ticket 1002 lane 1, layer 2: the Home seat lock's own PreToolUse hook, decided in the hook process without the
        // core (a core that is down never opens it), with or without Nunchiro's other hooks (Fable check M2: a locked seat
        // never runs hook-less, whatever `without_hooks` or the hook setting says). M1: a failed or timed-out run blocks
        // the call (`onFailure`, probe 2026-11-20). M3: no settings layer may turn hooks or skill shell lines back on.
        if let Some(mode) = home_mode {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = format!(
                "{} hook home-lock --mode {}",
                shell_quote(&exe.to_string_lossy()),
                crate::home_lock::name(mode)
            );
            let block = serde_json::json!({"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": 10, "onFailure": "block"}]});
            settings.insert("disableAllHooks".into(), false.into());
            settings.insert("disableSkillShellExecution".into(), true.into());
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}));
            match hooks.as_object_mut().map(|h| {
                h.entry("PreToolUse")
                    .or_insert_with(|| serde_json::json!([]))
            }) {
                Some(serde_json::Value::Array(pre)) => pre.push(block),
                _ => return Err("the Home seat lock hook could not be written".into()),
            }
        }
        // Ticket 1130 S1: outward actions ask in every Claude session, with or without Nunchiro's other hooks, decided in
        // the hook process (`nunchiro_core::outward`); a failed run blocks the call, as the lock's does. Round 2 (Codex 3):
        // no project, local or user layer may turn it off; `--settings` outranks them all but managed settings.
        if start.kind == AgentKind::Claude {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let lock = if home_mode.is_some() {
                " --home-lock"
            } else {
                ""
            };
            let command = format!("{} hook outward{lock}", shell_quote(&exe.to_string_lossy()));
            let block = serde_json::json!({"matcher": "Bash|mcp__.*", "hooks": [{"type": "command", "command": command, "timeout": 10, "onFailure": "block"}]});
            settings.insert("disableAllHooks".into(), false.into());
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}));
            match hooks.as_object_mut().map(|h| {
                h.entry("PreToolUse")
                    .or_insert_with(|| serde_json::json!([]))
            }) {
                Some(serde_json::Value::Array(pre)) => pre.push(block),
                _ => return Err("the outward hook could not be written".into()),
            }
        }
        // v1b-07
        if !settings.is_empty() {
            let path = self.home.join(format!("hooks-{id}.json"));
            store::atomic_write(&path, &serde_json::to_vec(&settings).unwrap())?;
            cmd.arg("--settings");
            cmd.arg(path);
        }
        if start.kind == AgentKind::Claude {
            cmd.args(approved); // ticket 358: where typed arguments go, after `--session-id` ends `--add-dir`'s list
        }
        if start.kind != AgentKind::Shell {
            cmd.args(
                start
                    .args
                    .iter()
                    .take_while(|arg| arg.as_str() != SIDE_CHAT_ARG),
            );
        }
        // Ticket 286 (needs 207, herdr's pane): an agent that quits leaves a shell in its folder on the same PTY leader
        // and group. A side chat ends with its parent and a missing binary must fail the start, so neither is wrapped.
        if start.kind != AgentKind::Shell
            && !start.args.iter().any(|arg| arg == SIDE_CHAT_ARG)
            && resolved(program).is_some()
        {
            let marker = ended_marker(&self.home, id);
            cmd.get_argv_mut().splice(
                0..0,
                ["/bin/sh", "-c", AGENT_WRAPPER, "nunchiro-agent"]
                    .map(std::ffi::OsString::from)
                    .into_iter()
                    .chain([marker.into_os_string()]),
            );
        }
        let resumed = prior_ids
            .iter()
            .max_by_key(|old| {
                let a = self.queue.attention(old);
                (a.completion_seq, a.last_activity)
            })
            .cloned();
        // v1a-40: the reopened terminal shows the continued run's scrollback above the new output: the replay of a
        // run that exited in this core, else the copy saved when it stopped (read at `open`, not under this lock).
        // A run whose PTY was dropped unsaved (a Codex model switch) seeds nothing.
        let seed = match resumed.as_deref().map(|old| &self.entries[old]) {
            Some(Entry { pty: Some(pty), .. }) => pty.snapshot(),
            Some(entry) => entry
                .saved
                .get_or_init(|| load_saved(&self.home, &entry.meta.id))
                .as_ref()
                .map(|saved| saved.bytes())
                .unwrap_or_default(),
            None => vec![],
        };
        let seed = if seed.is_empty() {
            seed
        } else {
            [seed, RESUMED_MARKER.to_vec()].concat()
        };
        // V2-1a: the token's hash is on disk before the agent can use the token.
        self.launching = Some((id.to_string(), store::token_sha256(&token)));
        if let Err(e) = self.save() {
            self.launching = None;
            return Err(e);
        }
        let pty = match Pty::spawn(&self.home, id, cmd, &seed) {
            Ok(pty) => pty,
            Err(e) => {
                self.launching = None;
                if let Err(e) = self.save() {
                    eprintln!("launch record cleanup failed: {e}");
                }
                // F15: the caller names an unreadable folder off the lock (`refused_start`).
                return Err(e);
            }
        };
        self.launching = None;
        // v1a-33: the agent starts either way; a refused or silent folder only marks the session.
        // Past PROBES_MAX parked probe threads new starts go unprobed (shown as today); see `spawn_probe`.
        let probe = spawn_probe(&self.probes, self.folder_probe, cwd)
            .ok()
            .map(|receiver| (std::time::Instant::now(), receiver));
        if start.kind == AgentKind::Codex && agent_session_id.is_none() {
            crate::identity::watch(
                self.home.clone(),
                id.into(),
                token.clone(),
                pty.pid(),
                cwd.into(),
                pty.lifetime(),
            );
        }
        if let Some(old) = &resumed {
            self.queue.prepare_resume(old, id)?;
        } else {
            self.queue.register(id, start.kind, queue::now_ms())?;
        }
        if let Some(v) = &version {
            crate::agent_canary::version_seen(&self.home, start.kind, v); // ticket 1100
        }
        let meta = Session {
            side_chat: start.args.iter().any(|arg| arg == SIDE_CHAT_ARG),
            stopped_sends: Vec::new(),
            side_parent: side_parent(start),
            side_split: side_split(start),
            machine: None, // v1a-06
            id: id.into(),
            kind: start.kind,
            project: project.into(),
            cwd: cwd.into(),
            label: start.label.clone(),
            closed_by_command: false,
            // Ticket 1017: a resume that keeps the first message's name keeps it numbered as one.
            auto_label: prior_ids.iter().any(|id| {
                let m = &self.entries[id].meta;
                m.auto_label && m.label == start.label
            }),
            state: SessionState::Running,
            agent_session_id,
            agent_version: version,
            untested: !tested,
            pid: Some(pty.pid()),
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            // v1a-10
            model: start
                .model
                .clone()
                .or_else(|| claude_modes::named_model(start)), // W35-picker2 S3
            effort: start.effort.clone(),
            // v1b-11: a resumed conversation keeps the start of the conversation it continues.
            start_commit: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.start_commit.clone())
                .or(start_commit),
            artifacts: artifacts.and_then(|(folder_id, _)| folder_id), // v1b-07
            blocked: None,                                             // v1a-33
            holder_status: None,                                       // V2-1b
            account: account.filter(|_| config_dir.is_some()),         // v2-2b
            config_dir,                                                // v2-2b
            // v2-3b: a resumed run stays in its conversation (a Codex model switch, a handoff back).
            conversation: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.conversation.clone()),
            problem: None,                                                  // v2-5b
            without_hooks: without_hooks && start.kind != AgentKind::Shell, // v2-5b
            home_lock: home_mode.is_some(),                                 // ticket 1002
            home_mode: home_mode.map(|m| crate::home_lock::name(m).to_string()),
            no_history,
            account_tab,
            permission_mode: None, // CHAT-PERMCHIP
            starting: false,
            ran_mode: None,
            mode_state: None, // CHAT-MODELIST
            // V2.5-30: a resumed run keeps the session that started the run it continues.
            parent: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.parent.clone()),
            // Ticket 990: a resumed run stays the teammate's seat.
            teammate: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.teammate.clone()),
            // Look 1117 v10 N10-S2-3: the room still names the seat by these ids.
            // shortcut: the newest 64 only, so a seat resumed hundreds of times does not grow its row; more if a room outlives that.
            resumed_from: prior_ids
                .iter()
                .flat_map(|id| {
                    std::iter::once(id.clone())
                        .chain(self.entries[id].meta.resumed_from.iter().cloned())
                })
                .take(64)
                .collect(),
            // `start_granted` clears it: an agent's resume of another run's conversation inherits no close rights.
            owned_from: prior_ids
                .iter()
                .flat_map(|id| {
                    std::iter::once(id.clone())
                        .chain(self.entries[id].meta.owned_from.iter().cloned())
                })
                .take(64)
                .collect(),
            level: prior_ids.iter().find_map(|id| self.entries[id].meta.level),
            // Ticket 993: a resumed run of a scheduled run is still that run until the user speaks to it.
            schedule: prior_ids
                .iter()
                .find_map(|id| self.entries[id].meta.schedule.clone()),
            started_at: Some(queue::now_ms()),
            token_origin: origin, // ticket 573 round 6
            closed_at: None,      // ticket 621
            ended_at: None,       // lane w59: stamped when the run ends
            acp_agent: None,      // V2-4a
            agent_ended: false,   // ticket 286: set per snapshot
            limit: None,          // ticket 372: set per snapshot
            folder_gone: false,   // look 1117 v13: set per snapshot
            ended_ask: None,      // look 1117 v10 N10-S3-3: set per snapshot
            // Ticket 1018: Ultracode as Claude starts it when Nunchiro set none; Claude's answer to a toggle reads later.
            modes: {
                let mut modes = self.start_modes.clone();
                if let Some(on) = ultracode
                    && modes.as_ref().and_then(|m| m.ultracode).is_none()
                {
                    modes.get_or_insert_default().ultracode = Some(on);
                }
                modes.filter(|_| start.kind == AgentKind::Claude)
            },
        };
        // Ticket 990 slice g: a seat is its session; the resumed run takes the seat of the run it continues.
        if let Err(e) = crate::ledger::Ledger::open(&self.home).reseat(&prior_ids, id) {
            eprintln!("ledger seat not moved: {e}");
        }
        // Ticket 621: the resumed run replaces its prior rows; a token row's origin is on the new row (`origin` above).
        let prior: Vec<_> = prior_ids
            .into_iter()
            .filter_map(|id| self.entries.remove(&id).map(|entry| (id, entry)))
            .collect();
        self.entries.insert(
            id.into(),
            Entry {
                meta: meta.clone(),
                pty: Some(pty),
                pty_size: Some((160, 50)),
                token_hash: Some(store::token_sha256(&token)), // V2-1b
                token: Some(token),
                stale: None, // V2-1b
                // v1a-40: prompt detection starts after the seed, so an old screen in it is never taken as current.
                observer: waiting::Observer {
                    output_offset: seed.len() as u64,
                    // A new Claude start may ask about the artifact folder the core adds: see `observe`.
                    own_folder: (start.kind == AgentKind::Claude).then(std::time::Instant::now),
                    before_box: start.kind == AgentKind::Claude,
                    silent_since: Some(std::time::Instant::now()),
                    ..Default::default()
                },
                input: crate::delivery::Input::default(),
                // v1a-10
                switch: None,
                walk: None,
                walk_error: None,
                // Launched in it by the owner's arguments or stored choice.
                skip_chosen: start
                    .args
                    .iter()
                    .chain(permission)
                    .any(|a| a == START_IN_SKIP),
                skip_hold: None,
                args: (start.resume.is_none() && env.is_empty()).then(|| start.args.clone()), // W35: env is not kept
                launch: env.is_empty().then(|| start.args.clone()),
                permission: permission.to_vec(),
                bypass_disabled,
                saved: Default::default(), // v1a-40
                probe,                     // v1a-33
                version_probe: None,       // V1A-89: `start` hands over a pending one
                acp: None,                 // V2-4a
                agent_ended: false,
                card_due: None,
            },
        );
        if let Err(e) = self.save() {
            self.entries.remove(id);
            self.entries.extend(prior);
            return Err(e);
        }
        // A shell only: an agent keeps its 160 columns until a terminal view shows it, so its prompts and its model
        // picker are read unwrapped while the chat is in front.
        if let Some((cols, rows)) = self.window_size.filter(|_| start.kind == AgentKind::Shell) {
            // Best effort: a failed resize leaves the PTY at 160x50, as before; the window's own resize follows.
            let _ = self.resize_pty(id, cols, rows);
        }
        for (prior_id, entry) in prior {
            if let Err(e) = remove_hooks(&self.home, &prior_id) {
                eprintln!("old hook cleanup failed: {e}");
            }
            // v1a-40: its row is gone; the seeded replay now holds the text.
            self.forget_write(&prior_id);
            if let Err(e) = crate::scrollback::remove(&self.home, &prior_id) {
                eprintln!("old scrollback cleanup failed: {e}");
            }
            if let Err(e) = crate::scrollback_edit::remove(&self.home, &prior_id) {
                eprintln!("old export cleanup failed: {e}"); // v1a-38b
            }
            // v2-13a: the replaced row's token and log go with it.
            if let Some(token) = &entry.token {
                crate::logs::unregister(token);
            }
            if let Err(e) = crate::logs::remove_session(&self.home, &prior_id) {
                eprintln!("old session log cleanup failed: {e}");
            }
        }
        Ok(self.snapshot_session(&meta))
    }
    // v1b-15
    fn observe_board(&mut self) {
        // S9: the tick reads twice per 50 ms. With no row moved and no board file changed, the board is observed once
        // per BOARD_IDLE: its integration sources are read no faster than its decisions refresh anyway.
        let key = self.board_key();
        if self
            .board_observed
            .is_some_and(|(k, at)| k == key && at.elapsed() < BOARD_IDLE)
        {
            return;
        }
        self.board_observed = Some((key, std::time::Instant::now()));
        // Rows are built again only when what the board reads of them moved.
        let mut cached = self.board_rows.take().filter(|(k, _)| *k == key);
        let error = crate::board::observe(&self.home, || {
            let rows = cached.get_or_insert_with(|| {
                let rows = self
                    .board_entries()
                    .map(|e| {
                        let mut row = self.snapshot_session(&e.meta);
                        // The board never reads these; the cache keeps rows cheap to hand out.
                        (row.send_log, row.send_queue, row.pending) = (vec![], vec![], vec![]);
                        row
                    })
                    .collect();
                (key, rows)
            });
            rows.1.clone()
        })
        .err();
        self.board_rows = cached;
        if error != self.board_error {
            if let Some(error) = &error {
                eprintln!("board observation: {error}");
            } else {
                eprintln!("board observation recovered");
            }
            self.board_error = error;
        }
    }
    /// V2-6d: the closing row's drags hold until the close is final, so the board reads it too.
    fn board_entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries
            .values()
            .chain(self.closing.as_ref().map(|c| &c.entry))
    }
    /// S9: a hash of what the board reads: board.json and board.toml as stamped (any edit reads at once), and of each
    /// row (`board::session_state`, `manual_card`, `release_drags`, `reconcile_sessions`) its id, label, project,
    /// lifecycle, agent ended, and the queue's attention for it; and its parent, which `board::rights` reads (it gets
    /// fresh rows from `Sessions::board`, never these, but the key stays a superset).
    fn board_key(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        use std::os::unix::fs::MetadataExt;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for file in ["board.json", "board.toml"] {
            fs::symlink_metadata(self.home.join(file))
                .ok()
                .map(|m| {
                    (
                        m.ino(),
                        m.len(),
                        m.mtime(),
                        m.mtime_nsec(),
                        m.ctime(),
                        m.ctime_nsec(),
                    )
                })
                .hash(&mut h);
        }
        // S9 r3: a changed integration source moves the key too, so the idle board clock never delays it.
        crate::board::sources::key(&self.home).hash(&mut h);
        for e in self.board_entries() {
            let m = &e.meta;
            (
                &m.id,
                &m.label,
                &m.project,
                &m.parent,
                m.state as u8,
                e.agent_ended,
            )
                .hash(&mut h);
            let a = self.queue.attention(&m.id);
            (
                a.completion_seq,
                a.working,
                a.waiting,
                a.failed,
                a.background,
            )
                .hash(&mut h);
        }
        h.finish()
    }
    /// V2.5-17: the snapshot of the state `tick` keeps current, without another refresh and observe pass; each open
    /// window reads one every 100 ms.
    /// Ticket 991: the sessions in the order they were started (the queue's registration time, then the id, which was
    /// the whole order before: random). A window that first sees several sessions together opens their tabs in this
    /// order; it used the pid, which is not the start order once the system's pids wrap around.
    fn started_order(&self) -> impl Iterator<Item = &Entry> {
        let mut entries: Vec<&Entry> = self.entries.values().collect();
        entries.sort_by_key(|e| self.queue.registered(&e.meta.id));
        entries.into_iter()
    }
    pub(crate) fn snapshot(&self) -> Response {
        if self.left {
            return Err("core is stopping".into());
        }
        Ok(Reply::Snapshot {
            sessions: self
                .started_order()
                .map(|e| self.snapshot_session(&e.meta))
                .collect(),
            keep_awake_held: crate::keep_awake::held(), // V2-CF5
            board_decisions: crate::board::decisions(&self.home), // v1b-18
            owner_decisions: self.queue.owner_items(),  // v1a-23
            // v2-5b; ticket 1100: else the canary's card
            problem: crate::problems::set_aside(&self.home)
                .or_else(|| crate::agent_canary::problem(&self.home)),
        })
    }
    fn snapshot_session(&self, meta: &Session) -> Session {
        #[cfg(test)]
        self.snapshots
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut meta = meta.clone();
        meta.send_log.extend(meta.send_queue.iter().cloned());
        meta.send_log.sort_by_key(|s| s.at);
        cap_log(&mut meta.send_log);
        meta.attention = Box::new(self.queue.attention(&meta.id));
        // Ticket 1121: shown only, so an older core never meets it in a store.
        meta.stopped_sends = (meta.send_queue.iter())
            .filter(|s| s.status == "queued" && self.spent.contains(&s.id))
            .map(|s| s.id.clone())
            .collect();
        if self.recovery_warnings > 0 {
            let warning = format!(
                "hook journal: {} recovery events quarantined or unavailable",
                self.recovery_warnings
            );
            meta.attention.observer_error = Some(match meta.attention.observer_error.take() {
                Some(error) => format!("{warning}; {error}"),
                None => warning,
            });
        }
        // Look 1117 v9 (A S3-3): a shell has no turns; a command it runs in the foreground reads as working. Shown
        // only, not stored, so the queue's stale clock and turn alerts stay an agent's. A program on the alternate screen
        // (vim, less) stays working too (look 1117 v11 A-S3-7 left open): the window closes an idle shell without asking,
        // and an editor may hold unsaved work (Codex w25-b MUST).
        if meta.kind == AgentKind::Shell
            && meta.state == SessionState::Running
            && let Some(pty) = self.entries.get(&meta.id).and_then(|e| e.pty.as_ref())
            && crate::peer::foreground_job(pty.pid())
        {
            meta.attention.working = true;
        }
        // Look 1117 v12 B N11-S2-3: a turn blocked in `agent ask --wait` reads as waiting for its answer at once (tab,
        // tree row, status bar); shown only, so the turn's own clock, alerts and held messages still see it working.
        meta.attention.asking = meta.attention.working && self.asks_waiting(&meta.id);
        // v19-Q9-cx: shown only, like `asking`.
        meta.attention.input_blocked = meta.state == SessionState::Running
            && self
                .entries
                .get(&meta.id)
                .and_then(|e| e.pty.as_ref())
                .is_some_and(|p| p.input_blocked());
        meta.completion_seq = meta.attention.completion_seq;
        // Ticket 286: a shell left after its agent quit has no agent footer and answers nothing.
        let shell_left = self.entries.get(&meta.id).is_some_and(|e| e.agent_ended);
        meta.agent_ended = shell_left;
        let live = meta.state == SessionState::Running && !shell_left;
        // CHAT-PERMCHIP: read from the live screen, never stored. S9: read once per screen change, not per snapshot.
        meta.starting = live
            && self.entries.get(&meta.id).is_some_and(|e| {
                e.observer.before_box
                    && e.observer
                        .quiet_since
                        .is_none_or(|t| t.elapsed() < waiting::startup_quiet())
                    && e.observer
                        .silent_since
                        .is_none_or(|t| t.elapsed() < waiting::STARTUP_SILENT)
            });
        meta.permission_mode = self
            .entries
            .get(&meta.id)
            .filter(|_| live && meta.kind == AgentKind::Claude)
            .and_then(|e| {
                e.observer
                    .screen
                    .read_once(|screen| permission_mode(screen, meta.kind))
            })
            // Look 11-17 v3 P5: a resume, before this core read any footer of it, shows the mode it ran in. From the first
            // footer on, a screen without one (a dialog over it) gives none, as before.
            .or_else(|| {
                meta.ran_mode.clone().filter(|_| {
                    live && meta.kind == AgentKind::Claude
                        && self
                            .entries
                            .get(&meta.id)
                            .is_some_and(|e| !e.observer.footer_seen)
                })
            })
            // Ticket 991 (B6 chip): Codex cannot change its mode in a running session; its chip reads the mode this
            // start gave it (`agent_permission::codex_mode`, the names of Settings > Providers).
            .or_else(|| {
                meta.ran_mode
                    .clone()
                    .filter(|_| live && meta.kind == AgentKind::Codex)
            });
        meta.modes = self.shown_modes(&meta, live); // W35
        meta.mode_state = self
            .entries
            .get(&meta.id)
            .filter(|_| live && meta.kind == AgentKind::Claude)
            .map(|e| ModeState {
                skip: skip_state(e, meta.permission_mode.as_deref(), self.claude_asks()),
                walk: e
                    .walk
                    .as_ref()
                    .map(|w| ModeWalk {
                        target: w.target.clone(),
                        error: None,
                    })
                    .or_else(|| e.walk_error.clone()),
            }); // CHAT-MODELIST
        meta.limit = self.session_limit(&meta.id, live, queue::now_ms() as i64 / 1000); // ticket 372
        // Look 1117 v13 (Home S3-5): only an ended local row is looked at, so a live one costs no stat per snapshot.
        meta.folder_gone = !live
            && meta.state != SessionState::Closed
            && meta.machine.is_none()
            && fs::metadata(&meta.cwd).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
        // Look 1117 v10 N10-S3-3: an ask the stop (or the agent's end) closed unanswered stays in the queue as resume
        // evidence; an ended row names it so the person learns it is gone. Only ended rows are read.
        meta.ended_ask = (!live && meta.state != SessionState::Closed)
            .then(|| {
                self.queue.items_of(&meta.id).into_iter().find(|i| {
                    matches!(
                        i.kind,
                        queue::Kind::Permission | queue::Kind::Question | queue::Kind::Dialog
                    )
                })
            })
            .flatten()
            .map(|ask| room::ask_words(&ask));
        // V2.5-87: an ended session answers nothing; its closed items stay on disk only as resume evidence (V1A-03).
        // S9: so only a live session's own items are read, not a clone of every item of every row.
        meta.pending = (if live {
            self.queue.items_of(&meta.id)
        } else {
            vec![]
        })
        .into_iter()
        .map(|mut i| {
            self.queue.annotate(&mut i, &meta.cwd, meta.home_lock); // V2-8e
            i
        })
        .collect();
        // V2-5b: the cards of states v1a-33 and V2-1b keep.
        if meta.problem.is_none() {
            meta.problem = crate::problems::kept(&meta);
        }
        meta
    }
}
/// Look 11-17 v8 (area B S2-1): how long a question a hook or the transcript made is kept from the window while the
/// screen has not brought its choices yet (Claude and Codex draw their dialog a moment after the hook; the choices'
/// keys are read there). Past it the question is a card with Cancel only, as before.
const QUESTION_HOLD_MS: u64 = 1000;
/// A question with no choices yet that the screen is about to pair. Only the snapshot a window is pushed leaves it
/// out (http/mod.rs): the core's own gates and the owner socket's snapshot (`nunchiro agent wait` reads "blocked"
/// from it) still see the item, so nothing is typed into its dialog meanwhile and no caller reads the agent as idle.
pub(crate) fn question_held(item: &queue::Decision, now: u64) -> bool {
    item.kind == queue::Kind::Question
        && item.choices.is_empty()
        && !item.sources.contains("screen")
        && item.sources.iter().any(|s| s == "hook" || s == "transcript")
        // A Codex async question is answered by a message: no dialog brings it choices.
        && !queue::answered_by_message(item)
        && now.saturating_sub(item.observed_at) < QUESTION_HOLD_MS
}
/// S9: how often the board is observed while no row it reads moves and no board file changed. r3: 1 s, not 100 ms: what
/// else moves its decisions is an integration source's read, which comes at most every 30 s (`INTERVAL_FLOOR_SECS`).
const BOARD_IDLE: std::time::Duration = std::time::Duration::from_secs(1);
// v1a-33: how long a new session's folder probe may take before the session reads as blocked. macOS file access
// (Removable Volumes, Desktop, Documents, Downloads) refuses with EPERM or, for an app-started core, never answers.
pub(crate) const PROBE_BOUND: std::time::Duration = std::time::Duration::from_secs(2);
const PROBES_MAX: usize = 32;
type Probes = std::sync::Arc<std::sync::atomic::AtomicUsize>;
/// The one probe count of the process: session starts and refused starts (`refused_start`) both count against it.
fn shared_probes() -> &'static Probes {
    static PROBES: std::sync::OnceLock<Probes> = std::sync::OnceLock::new();
    PROBES.get_or_init(Default::default)
}
/// Frees a probe's slot when its thread ends (a panic included), or when no thread was spawned.
struct ProbeSlot(Probes);
impl Drop for ProbeSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
enum ProbeSkip {
    Full,
    NoThread,
}
/// Probes `folder` off this thread if `probes` has room (at most PROBES_MAX threads not yet answered). A probe stuck
/// in open() cannot be cancelled: it parks its thread, and its slot, until the folder answers or the core exits.
// shortcut: a shared prober thread would bound this at one; move to it if starts into such folders get frequent.
fn spawn_probe(
    probes: &Probes,
    probe: fn(&Path) -> std::io::Result<()>,
    folder: &Path,
) -> Result<std::sync::mpsc::Receiver<std::io::Result<()>>, ProbeSkip> {
    let taken = probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let slot = ProbeSlot(probes.clone());
    if taken >= PROBES_MAX {
        return Err(ProbeSkip::Full);
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let folder = folder.to_path_buf();
    // A thread the OS refuses only skips the probe (the closure and its slot drop); a panic here would poison the lock.
    std::thread::Builder::new()
        .name("folder-probe".into())
        .spawn(move || {
            let _slot = slot;
            let _ = sender.send(probe(&folder));
        })
        .map(|_| receiver)
        .map_err(|_| ProbeSkip::NoThread)
}
/// F15: the refusal prefix of a start whose folder the agent could not enter (web/src/PermissionNeeded.tsx). The rest
/// starts with `FILE_MODE` for a folder whose owner or mode refuses (EACCES), else it is macOS privacy (EPERM, no answer).
pub(crate) const FILE_ACCESS: &str = "file_access:";
pub(crate) const FILE_MODE: &str = "file_access: no permission to read";
/// F15: a refused start, as the window is told it and one core.log line. Called off the registry lock: the folder probe
/// waits at most `PROBE_BOUND`, and one that does not answer is the macOS privacy case (an app-started core's TCC wait).
pub(crate) fn refused_start(
    probe: fn(&Path) -> std::io::Result<()>,
    kind: AgentKind,
    cwd: &Path,
    e: String,
) -> String {
    refused_start_capped(shared_probes(), probe, kind, cwd, e)
}
fn refused_start_capped(
    probes: &Probes,
    probe: fn(&Path) -> std::io::Result<()>,
    kind: AgentKind,
    cwd: &Path,
    e: String,
) -> String {
    // The probe counts against the starts' cap. A full cap spawns nothing and reads as a probe that did not answer;
    // a thread the OS refuses only skips the probe.
    let answer = match spawn_probe(probes, probe, cwd) {
        Ok(receiver) => receiver
            .recv_timeout(PROBE_BOUND)
            .unwrap_or_else(|_| Err(std::io::ErrorKind::TimedOut.into())),
        Err(ProbeSkip::Full) => Err(std::io::ErrorKind::TimedOut.into()),
        Err(ProbeSkip::NoThread) => Ok(()),
    };
    let e = match answer {
        Err(f) if f.raw_os_error() == Some(libc::EACCES) => {
            format!("{FILE_MODE} {}: {e}", cwd.display())
        }
        Err(f)
            if matches!(
                f.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::TimedOut
            ) =>
        {
            format!("{FILE_ACCESS} cannot read {}: {e}", cwd.display())
        }
        _ => e,
    };
    // One log line: a newline in the folder or the reason must not start a second one.
    let line = format!("start refused: {kind:?} in {}: {e}", cwd.display());
    eprintln!("{}", escape_line(&line));
    e
}
fn escape_line(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}
pub(crate) fn probe_folder(path: &Path) -> std::io::Result<()> {
    fs::read_dir(path)?.next().transpose().map(|_| ())
}
// v1a-10: model and effort switch. The Claude catalog matches web/src/picker/catalog.ts (a web test compares them);
// ticket 1100: the Codex one is Codex's own (`agent_models`), served to the window by `agent_models`.
// v1a-19: the most terminal output one observer pass feeds the waiting screen per session; the rest waits for the
// next pass, so a session that floods its terminal never holds the registry lock for long.
pub(crate) const OBSERVE_BYTES: usize = 64 * 1024;
/// Seventh look (B S2-1): how long a working session's screen has been still before a question on it with no card is
/// read again (`tick`).
const REREAD_STILL_MS: u64 = 1000;
/// How long that re-read leaves a session's screen alone after one of its requests was answered.
const REREAD_AFTER_ANSWER: std::time::Duration = std::time::Duration::from_secs(5);
const CLAUDE_MODELS: &[(&str, &str)] = &[
    ("fable", "Fable"),
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
];
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const PICKER_OPEN: &[u8] = b"\x1bp"; // Claude's `meta+p` (chat:modelPicker); never `/model`
// A step reads the screen only after the agent redrew it and then stayed quiet, never a stale frame. v1a-24 r3:
// an echoed Enter waits for the same quiet.
const SWITCH_SETTLE: std::time::Duration = std::time::Duration::from_millis(100);

// v1a-15: the Enter goes this long after the pasted text at the latest, echoed or not.
const SETTLE: std::time::Duration = std::time::Duration::from_secs(3);
// v1a-19 r2: a pending Enter waits this long after the paste for the observer to catch up, then is dropped.
const ENTER_CATCH_UP: std::time::Duration = std::time::Duration::from_secs(10);
/// How long a pasted prompt may take to show in the composer before its Enter is dropped, in settle times
/// (3 s each: 21 s; a test's shorter settle shortens it alike).
const PASTE_WAIT: u32 = 7;
// Logged only: the persisted settle marks are a fixed list (`delivery::SETTLE_MARKS`), so the row has none.
const BEHIND: &str = "enter_dropped_behind";
/// Ticket 1094 r6: how long an idle agent may show no turn after his own Enter before the dropped row goes again.
const HAND_PROOF: std::time::Duration = std::time::Duration::from_secs(15);
/// Ticket 1094: an idle agent that shows its input box this long after a write took no turn from it.
const INFLIGHT_IDLE: std::time::Duration = std::time::Duration::from_secs(15);
/// Ticket 1094: the wait before a user message whose Enter was dropped twice is tried again, doubled each time.
const RETRY_FIRST: std::time::Duration = std::time::Duration::from_secs(15);
const RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(300);
/// Ticket 1121: how many times a row whose Enter was dropped is pasted again; after that it waits in the queue.
const REPASTES: u32 = 2;
/// Ticket 1121: how long a guarded row waits for a box the screen reads clean before it is stopped, and the pause
/// between two passes that starts that wait again.
const CLEAN_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
const CLEAN_GAP: std::time::Duration = std::time::Duration::from_secs(5);
/// Ticket 1094: a Claude the queue reads as working that shows its idle input box and drew nothing this long has
/// ended its turn (ms), whatever signal was lost.
pub(crate) const IDLE_SETTLE_MS: u64 = 30_000;
/// Look 11-17 v8 N1: how long after an Enter the core looks at the input box again, and how many more Enters it
/// writes for one message.
const SUBMIT_CHECK: std::time::Duration = std::time::Duration::from_secs(2);
const SUBMIT_TRIES: u8 = 2;
/// A submit the core wrote: its words and its Enter. Real run 11-18: Claude was sent its first message while it still
/// drew its first screen; the Enter was read in one piece with the words (a paste, to Claude) and the message sat in
/// the input box with the session "running" for minutes.
struct Submitted {
    text: String,
    /// The turns finished when the Enter went: one more, or a turn running, is the message taken.
    seq: u64,
    at: std::time::Instant,
    tries: u8,
    /// The output offset last seen and when it last changed (the box is read from a still screen only).
    last: u64,
    quiet: std::time::Instant,
}
struct PendingEnter {
    send: String,
    // The composer state once the Enter is written; the text-only state is in effect until then.
    input: crate::delivery::Input,
    offset: u64,
    written: std::time::Instant,
    /// v1a-24 r3: the output offset last seen and when it last changed.
    last: u64,
    quiet: std::time::Instant,
    /// The composer showed this paste at some pass: a composer that stops showing it took something else in.
    held: bool,
}
struct Switch {
    send: String,
    model: Option<String>,
    effort: Option<String>,
    confirming: bool,
    keys: usize,
    /// When the last key went out, and the output offset at that moment.
    sent: std::time::Instant,
    seen: u64,
    /// The output offset last observed, and since when it has not moved.
    last: u64,
    quiet: std::time::Instant,
    /// The screen the last key was sent on; an unchanged screen has not answered it yet.
    before: String,
}

/// CHAT-MODELIST: Claude's footer names, least to most access (the list's order; not the cycle's). Claude 2.1.318 cycles
/// auto, manual, accept edits, plan, [bypass permissions], auto, ...: `bypass permissions` is in the cycle only for a
/// session launched with `--allow-dangerously-skip-permissions` (checked against the real CLI), and `auto` only where the
/// account has it. A pick is found by pressing and reading the footer, one key at a time.
const MODES: [&str; 5] = [
    "manual",
    "accept edits",
    "plan",
    "auto",
    "bypass permissions",
];
const BYPASS: &str = "bypass permissions";
const MODE_BUSY: &str = "mode change in progress";
/// A full cycle is at most `MODES.len()` presses; one more would only repeat the start.
const WALK_KEYS: u8 = MODES.len() as u8;
/// Claude redraws its footer within a frame of the key; this long without a change means the key did nothing.
const WALK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// A walk whose output viewer stays behind the PTY this long ends (and releases the hold): the footer cannot be trusted.
const WALK_BEHIND: std::time::Duration = std::time::Duration::from_secs(10);
/// CHAT-MODELIST r4: see `Entry::skip_hold`. `unreadable_since`: when the footer last stopped being readable (a transient
/// notice over the mode row); the hold gives up on an unreadable footer after `WALK_BEHIND`, never on a readable one.
struct SkipHold {
    unreadable_since: Option<std::time::Instant>,
}
/// CHAT-MODELIST: a pick in flight. Each press is an ordinary logged `shift+tab` send; the next one goes only after
/// the footer showed the last one's effect.
struct Walk {
    target: String,
    /// The footer when the walk began: seeing it again before the target means the cycle has no target.
    start: String,
    /// The footer at the last press.
    before: String,
    /// The owner picked Bypass permissions itself; that counts only if the walk gets there.
    chosen: bool,
    /// Set on the walk that brings a failed walk's session back to its start mode: the first walk's target and why it failed.
    failure: Option<(String, String)>,
    sent: std::time::Instant,
    keys: u8,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Step {
    Wait,
    Keys(&'static [u8]),
    Done,
    Fail(&'static str),
}

pub(crate) fn check_model(
    kind: AgentKind,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    let efforts: &[&str] = match kind {
        AgentKind::Shell => return Err("a shell session has no model picker".into()),
        // V2-4a: an ACP agent's model and effort are its own Session Config Options.
        AgentKind::Acp => return Err("an ACP agent has no model picker here".into()),
        AgentKind::Claude => {
            if model.is_some_and(|m| !CLAUDE_MODELS.iter().any(|(alias, _)| *alias == m)) {
                return Err("unknown model".into());
            }
            CLAUDE_EFFORTS
        }
        AgentKind::Codex => match model {
            None => crate::agent_models::CODEX_DEFAULT_EFFORTS,
            Some(m) => {
                // A model Codex dropped from its list since a schedule, role or team row saved it still passes when
                // the fixed list has it (the cache can change at any Codex fetch, not only at a Nunchiro update).
                let listed = crate::agent_models::codex();
                let fixed = crate::agent_models::fallback();
                let efforts = &listed
                    .iter()
                    .chain(&fixed)
                    .find(|row| row.value == m)
                    .ok_or("unknown model")?
                    .efforts;
                return match effort {
                    Some(e) if !efforts.iter().any(|x| x == e) => {
                        Err("unknown effort for this model".into())
                    }
                    _ => Ok(()),
                };
            }
        },
    };
    if effort.is_some_and(|e| !efforts.contains(&e)) {
        return Err("unknown effort for this model".into());
    }
    Ok(())
}

/// Ticket 994: a model as its agent names it in short: Claude's alias by its name ("Opus"), any other by its own id.
pub(crate) fn model_name(kind: AgentKind, model: &str) -> String {
    CLAUDE_MODELS
        .iter()
        .find(|(alias, _)| kind == AgentKind::Claude && *alias == model)
        .map_or(model, |(_, name)| name)
        .to_string()
}

/// Ticket 358: the web's `MODEL_NAME` (newDefaults.ts): one argv word that cannot read as a flag.
pub(crate) fn model_word(m: &str) -> bool {
    m.len() <= 128
        && m.starts_with(|c: char| c.is_ascii_alphanumeric())
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}
impl Sessions {
    /// Ticket 358: `check_model`, also passing an id the owner stored in Settings > Accounts for this agent. A stored
    /// id has no effort list of its own, so it takes the no-model one.
    fn check_stored_model(
        &self,
        kind: AgentKind,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let agent = match kind {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            _ => return check_model(kind, model, effort),
        };
        let stored = self
            .settings
            .feature::<serde_json::Value>("agents.custom_models");
        let listed = stored
            .as_ref()
            .and_then(|v| v.get(agent)?.as_array())
            .is_some_and(|list| {
                list.iter()
                    .any(|m| m.get("id").and_then(|i| i.as_str()) == model)
            });
        check_model(kind, model, effort).or_else(|e| {
            if listed && model.is_some_and(model_word) {
                check_model(kind, None, effort)
            } else {
                Err(e)
            }
        })
    }
}

/// V2-1b: stops an unattached holder through the frozen stop (only the recorded process) and waits briefly for its
/// agent; for the owner, an agent still running is then ended by the core. `true` once the agent is gone.
/// Peer item 2 (ticket 991): a session title from a prompt's first line, cut to about 40 characters at a word boundary.
/// None for a prompt that is not the user's own words (a slash command, a tagged or handoff message).
/// Look 11-17 N6: a Codex session's title, from the first own message in its transcript records.
fn codex_title(records: &[serde_json::Value]) -> Option<String> {
    records.iter().find_map(|record| {
        crate::chat::project(AgentKind::Codex, record)
            .iter()
            .find(|e| e["kind"] == "message" && e["role"] == "user")
            .and_then(|e| e["text"].as_str())
            .and_then(|text| auto_title(crate::chat::after_codex_context(text)))
    })
}
/// Ticket 1042: the last title Claude Code wrote for the session (`{"type":"ai-title","aiTitle":…}`), held to the
/// rules of a first-message title (one line, masked, cut to about 40 characters).
fn claude_ai_title(records: &[serde_json::Value]) -> Option<String> {
    records
        .iter()
        .rev()
        .find(|r| r["type"] == "ai-title")
        .and_then(|r| r["aiTitle"].as_str())
        .and_then(auto_title)
}
fn auto_title(prompt: &str) -> Option<String> {
    let first = prompt.lines().map(str::trim).find(|l| !l.is_empty())?;
    // Typed words hold no control character: a line with one (a pasted colour code) gives no title. Stripping it
    // would leave its letters joined to the next word, which hid a token from the mask below (after two Codex looks).
    if first.chars().any(char::is_control) {
        return None;
    }
    // A title is stored and shown wider than the conversation (sessions.json, the tree, events): a key-like value in
    // the first line is masked as in the logs.
    let line = String::from_utf8_lossy(&crate::logs::mask(first.as_bytes())).into_owned();
    let line = line.trim();
    if line.is_empty()
        || line.starts_with(['/', '<', '\u{1b}'])
        || line.starts_with("Handoff from ")
    {
        return None;
    }
    const MAX: usize = 40;
    if line.chars().count() <= MAX {
        return Some(line.to_string());
    }
    let cut: String = line.chars().take(MAX).collect();
    let words = cut
        .rfind(' ')
        .filter(|&i| i >= MAX / 2)
        .map_or(cut.as_str(), |i| &cut[..i]);
    Some(format!(
        "{}…",
        words.trim_end_matches([' ', ',', '.', ':', ';'])
    ))
}

fn stop_stale(stale: &Stale, owner: bool) -> bool {
    let holder = Some((stale.record.pid, stale.record.started));
    if let Err(e) = crate::holder::stop_at(&stale.record.socket, holder) {
        eprintln!("holder {}: {e}", stale.record.socket.display());
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while crate::peer::running_since(stale.pid, stale.started) && std::time::Instant::now() < until
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    !crate::peer::running_since(stale.pid, stale.started)
        || (owner && end_group(stale.pid, stale.started, &stale.record))
}
/// V2-1b: the owner ends an agent whose holder does not answer: its group, then the holder, each only when the
/// process table shows exactly the recorded process. `true` once the agent is gone.
fn end_group(pid: u32, started: Option<u64>, holder: &crate::holder::Record) -> bool {
    let Some(started) = started else {
        return false;
    };
    if crate::peer::is_same(pid, started) {
        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
    }
    if crate::peer::is_same(holder.pid, holder.started) && holder.pid != std::process::id() {
        unsafe { libc::kill(holder.pid as i32, libc::SIGKILL) };
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while crate::peer::running_since(pid, Some(started)) && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    !crate::peer::running_since(pid, Some(started))
}
fn side_parent(start: &StartSession) -> Option<String> {
    let at = start.args.iter().position(|arg| arg == SIDE_CHAT_ARG)?;
    start.args.get(at + 1).cloned()
}
fn side_split(start: &StartSession) -> Option<String> {
    let at = start.args.iter().position(|arg| arg == SIDE_CHAT_ARG)?;
    start.args.get(at + 2).cloned()
}
/// V2-1b: the state a session takes when its run ended without an exit of its own (a stop, a holder that died).
fn resumable(meta: &Session) -> SessionState {
    if !meta.side_chat && meta.kind != AgentKind::Shell && meta.agent_session_id.is_some() {
        SessionState::Resumable
    } else {
        SessionState::Exited
    }
}
/// V2-1b: whether `token` is this session's: its agent's token (by hash, in constant time) or the in-memory alias an
/// inside peer's owner token is swapped for.
fn token_matches(entry: &Entry, token: &str) -> bool {
    let presented = store::token_sha256(token);
    entry
        .token_hash
        .as_ref()
        .is_some_and(|h| crate::server::token_equal(presented.as_bytes(), h.as_bytes()))
        || entry
            .token
            .as_ref()
            .is_some_and(|t| crate::server::token_equal(token.as_bytes(), t.as_bytes()))
}
/// V2-1b: takes a session whose holder outlived the last core back; `true` when it runs (attached, or kept unattached
/// while its agent runs). A holder of this protocol is attached; one of another protocol keeps its agent with a status
/// line. A holder that is gone took its agent (killed here as the holder would, only the recorded process); one that
/// is alive but not answering is tried again while its agent runs. Nothing else ends an agent.
fn reattach(
    entry: &mut Entry,
    record: &crate::holder::Record,
    pid: u32,
    started: Option<u64>,
    run_start: u64,
    wait: std::time::Duration,
    retry: bool,
) -> bool {
    // V1A-79: only `open` waits out a holder that has not yet noticed the last core leave; `refresh` runs under the
    // registry lock and stays single-shot.
    let attached = if retry {
        Pty::attach_retrying(record, wait)
    } else {
        Pty::attach(record, wait)
    };
    let busy_before = entry.stale.as_ref().map_or(0, |s| s.busy);
    let mut busy = busy_before;
    let status = match attached {
        // The holder's agent must be the recorded one (a store that names another is never trusted with it).
        Attach::Attached(pty) if pty.pid() != pid || pty.agent_started() != started => {
            eprintln!(
                "session {}: its holder runs another agent; not attached",
                entry.meta.id
            );
            pty.leave();
            None
        }
        Attach::Attached(mut pty) => {
            pty.set_run_start(run_start);
            // Detection starts after what the ring held: only output after the reattach can prove a request.
            entry.observer = waiting::Observer::default();
            entry.observer.screen.feed(&pty.snapshot());
            entry.observer.output_offset = pty.end();
            entry.meta.pid = Some(pty.pid());
            entry.meta.state = SessionState::Running;
            entry.meta.holder_status = None;
            entry.pty = Some(*pty);
            entry.pty_size = None;
            entry.stale = None;
            entry.saved = Default::default();
            return true;
        }
        Attach::Older(version) => {
            eprintln!(
                "session {}: holder speaks protocol {version}; needs restart",
                entry.meta.id
            );
            Some(HolderStatus::NeedsRestart)
        }
        Attach::Newer(version) => {
            eprintln!(
                "session {}: holder speaks protocol {version}; update Nunchiro",
                entry.meta.id
            );
            Some(HolderStatus::UpdateNunchiro)
        }
        // Ticket 385: one line, when it is given up; a status stops the retries in `refresh`.
        Attach::Gone(why) if why == crate::holder::PEER_CHECK_BUSY => {
            busy += 1;
            (busy >= BUSY_TRIES).then(|| {
                eprintln!(
                    "session {}: holder stayed busy; needs restart",
                    entry.meta.id
                );
                HolderStatus::NeedsRestart
            })
        }
        Attach::Gone(why) => {
            // Ticket 385: retried every few seconds while its agent runs, so only the first failure is logged.
            if entry.stale.is_none() {
                eprintln!("session {}: holder not reattached: {why}", entry.meta.id);
            }
            if !crate::peer::is_same(record.pid, record.started)
                && let Some(started) = started
                && crate::peer::is_same(pid, started)
            {
                unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                let until = std::time::Instant::now() + std::time::Duration::from_millis(200);
                while crate::peer::running_since(pid, Some(started))
                    && std::time::Instant::now() < until
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            None
        }
    };
    // Without a recorded start time the pid cannot be told from a later process on it: not reattached.
    if started.is_none() || !crate::peer::running_since(pid, started) {
        return false;
    }
    entry.meta.pid = Some(pid);
    entry.meta.state = SessionState::Running;
    entry.meta.holder_status = status;
    entry.stale = Some(Stale {
        record: record.clone(),
        pid,
        started,
        run_start,
        retry: std::time::Instant::now() + STALE_RETRY * 2u32.pow(busy.saturating_sub(1)),
        busy,
    });
    true
}
/// A stop error counts only while the agent still lives: Darwin's killpg can say EPERM after the
/// leader was killed and reaped (a group left with a zombie), and then the restart must still happen.
fn agent_stopped(result: Result<(), String>, pid: u32, started: Option<u64>) -> Result<(), String> {
    let Err(error) = result else { return Ok(()) };
    // A zombie or a reaped leader counts as dead. V2-1a r2: read from the process table, since the agent is its
    // holder's child, not the core's. V2-1b: another start time on the pid is another process, so the agent is gone.
    let gone = !crate::peer::running_since(pid, started);
    if gone {
        eprintln!("switch: stopping {pid} reported {error}; the agent is gone, restarting");
        Ok(())
    } else {
        Err(format!("Codex did not stop ({error}); nothing changed"))
    }
}

/// The launch args a Codex restart may pass again: Codex 0.161.0 `resume` options that neither name a model
/// or effort nor carry a prompt. Anything else (`--`, a positional, an unknown flag) refuses the switch.
fn carried_codex_args(args: Option<&[String]>) -> Result<Vec<String>, String> {
    let args = args.ok_or(
        "this Codex session was resumed or restored, so its launch arguments are not known; restart it by hand",
    )?;
    let refuse = || {
        format!(
            "the session's launch arguments ({}) cannot be passed to a restart: only -s, -a, --add-dir, \
             --enable, --disable, -c without model keys and the sandbox, approval and search flags carry \
             over; restart it by hand",
            args.join(" ")
        )
    };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (arg.as_str(), None),
        };
        let flag = [
            "--search",
            "--no-alt-screen",
            "--approve-for-me",
            "--dangerously-bypass-approvals-and-sandbox",
            "--no-daemon",
        ];
        if flag.contains(&name) && inline.is_none() {
            continue;
        }
        let value = match name {
            "-s" | "--sandbox" | "-a" | "--ask-for-approval" | "-c" | "--config" | "--add-dir"
            | "--enable" | "--disable" => inline
                .or(rest.next().map(String::as_str))
                .ok_or_else(refuse)?,
            _ => return Err(refuse()),
        };
        let ok = match name {
            "-s" | "--sandbox" => {
                ["read-only", "workspace-write", "danger-full-access"].contains(&value)
            }
            "-a" | "--ask-for-approval" => ["on-request", "never"].contains(&value),
            // A model, or a profile that may name one; TOML quotes around the key do not hide it.
            "-c" | "--config" => value.split_once('=').is_some_and(|(key, _)| {
                let key = key.trim().trim_matches(['"', '\'']);
                !key.starts_with("model") && !key.starts_with("profile")
            }),
            _ => !value.is_empty() && !value.starts_with('-'),
        };
        if !ok {
            return Err(refuse());
        }
    }
    Ok(args.to_vec())
}

fn switch_log(
    id: &str,
    kind: Option<AgentKind>,
    model: &Option<String>,
    effort: &Option<String>,
    result: &str,
) {
    eprintln!(
        "switch session={id} agent={} model={} effort={} result={result}",
        kind.map_or("?".into(), |k| format!("{k:?}").to_lowercase()),
        model.as_deref().unwrap_or("default"),
        effort.as_deref().unwrap_or("default"),
    );
}

/// v1a-24: the text in the agent's input box, or `None` when the screen does not show one. Claude 2.1.310 frames
/// its `❯` row (column 0) with full-width `─` rules, any wrapped or further lines indented between them; Codex
/// 0.161.0 draws `›` (column 0), indented lines, one blank row, then one or two indented footer rows to the end of
/// the screen, the first `<model> <effort> · <cwd>`. v1a-24 r2: a box with a choice under it (a row led by a
/// cursor or radio mark at any indent, a numbered option, both as `waiting::screen::choice_row` reads them; a
/// detected decision) or a mark row inside it is `None`: a dialog may be up. A Codex `›` row or line reading as a
/// numbered option is a menu. Known limits: a highlight-only cursor (no mark, number or phrase) or an unknown mark
/// (`▸`) is not seen, rows above the box are not read (a stale dialog in the transcript would block every
/// Enter), and a dialog drawn more than `SWITCH_SETTLE` after its box, with no output between, meets a settled box. The text is the mark row's (a paste shows its start
/// there); empty-box placeholders count as empty: Claude `Try "…"`, Codex "Ask Codex to do anything" and "Ask a
/// follow-up question".
fn composer(screen: &str, kind: AgentKind) -> Option<String> {
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let codex = kind == AgentKind::Codex;
    let mark = if codex { '›' } else { '❯' };
    let at = rows.iter().rposition(|r| r.starts_with(mark))?;
    let below = &rows[at + 1..];
    let inner = below
        .iter()
        .take_while(|r| r.starts_with("  ") || !codex && r.is_empty())
        .count();
    // v1a-24 r3: the same marks and option rows `detect` reads as choices.
    let cursor = |r: &&str| r.trim_start().starts_with(waiting::screen::CHOICE_MARKS);
    let numbered = |r: &&str| waiting::screen::choice_row(r).is_some();
    let choice =
        |rows: &[&str]| rows.iter().any(|r| cursor(r) || numbered(r)) || decision(rows).is_some();
    // Ticket 1121: under the box, a usage ring row (`○ 6%`, `● 100%`: the mark, then a number with `%`) is no
    // choice; read as one, no box showed, every Enter was dropped and the next paste glued behind the last copy. Any
    // other marked row (`● Continue`) is a choice, as before.
    let ring = |r: &&str| {
        r.trim_start()
            .strip_prefix(['○', '●'])
            .map(str::trim_start)
            .is_some_and(|t| t.starts_with(|c: char| c.is_ascii_digit()) && t.contains('%'))
    };
    let footer_choice = |rows: &[&str]| {
        rows.iter().any(|r| cursor(r) && !ring(r) || numbered(r)) || decision(rows).is_some()
    };
    // The footer's own words, as Claude draws them in every permission mode.
    let footer_words = |r: &&str| {
        [
            "(shift+tab to cycle)",
            "? for shortcuts",
            "esc to interrupt",
        ]
        .iter()
        .any(|w| r.contains(w))
    };
    let rule = |r: &&str| !r.is_empty() && r.chars().all(|c| c == '─');
    // Look 11-17 v11 N11-S2-2: Claude 2.1.327 writes a named session's name (a resumed one has one) into the rule over
    // the box (`──── add-plan-txt-file ─`); the rule under it stays plain. Read as no box, a Stop never ended the turn.
    let top = |r: &str, bottom: &str| r == bottom || r.starts_with("──") && r.ends_with(" ─");
    let boxed = if codex {
        let footer = below.get(inner + 1..).unwrap_or_default();
        !numbered(&rows[at])
            && !choice(&below[..inner])
            && below.get(inner).is_some_and(|r| r.is_empty())
            && (1..=2).contains(&footer.len())
            && footer
                .iter()
                .all(|r| r.starts_with("  ") && !r.trim().is_empty())
            && footer[0].contains(" · ")
            && !choice(footer)
    } else {
        // Ticket 1121: a real 2.1.331 seat's screen as the core read it kept the top rule and the `❯` row but lost the
        // bottom rule (blank rows, then footer pieces: `◔ 30%  2  8`, `(shift+tab to cycle) · ← 2 agents`). With
        // the rule right above, an unnumbered row, nothing under it but indented or blank rows that hold no option, and
        // Claude's footer words among them, it is the box: read as none, every Enter there was dropped.
        let lost = at > 0
            && below.get(inner).is_none()
            && (rule(&rows[at - 1])
                || rows[at - 1].starts_with("──") && rows[at - 1].ends_with(" ─"))
            && !numbered(&rows[at])
            && below.iter().any(footer_words)
            && !footer_choice(below);
        at > 0
            && (below
                .get(inner)
                .is_some_and(|r| rule(r) && top(rows[at - 1], r))
                || lost)
            // With the rule lost the rows under the `❯` row are the footer: a ring there (`○ 6%`) is no cursor.
            && !below[..inner].iter().any(|r| cursor(r) && !(lost && ring(r)))
            && !footer_choice(below.get(inner + 1..).unwrap_or_default())
    };
    if !boxed {
        return None;
    }
    let line = rows[at][mark.len_utf8()..].trim();
    let placeholder = match kind {
        AgentKind::Codex => {
            ["Ask Codex to do anything", "Ask a follow-up question"].contains(&line)
        }
        _ => line.starts_with("Try \"") && line.ends_with('"'),
    };
    Some(if placeholder { "" } else { line }.into())
}

/// N1: every row of the text in the agent's input box, joined by spaces; `None` when `composer` reads no box.
fn box_text(screen: &str, kind: AgentKind) -> Option<String> {
    let first = composer(screen, kind)?;
    let codex = kind == AgentKind::Codex;
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let at = rows
        .iter()
        .rposition(|r| r.starts_with(if codex { '›' } else { '\u{276f}' }))?;
    let more = rows[at + 1..].iter().take_while(|r| {
        if codex {
            r.starts_with("  ")
        } else {
            r.is_empty() || !r.chars().all(|c| c == '\u{2500}')
        }
    });
    Some(
        std::iter::once(first.as_str())
            .chain(more.map(|r| r.trim()))
            .collect::<Vec<_>>()
            .join(" "),
    )
}
/// N1: the box shows exactly the sent words (wrapped as the agent likes), or the placeholder of exactly that paste.
fn same_words(shown: &str, sent: &str) -> bool {
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let shown = words(shown);
    shown == words(sent)
        || (shown.starts_with("[Pasted ") || shown.starts_with("[Image #"))
            && holds_paste(&shown, sent)
}

/// The rows of text in Claude's input box (0 when it shows none or only its placeholder): from its `❯` row down to the
/// rule under it.
fn box_rows(screen: &str) -> usize {
    if composer(screen, AgentKind::Claude).is_none_or(|t| t.is_empty()) {
        return 0;
    }
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let Some(at) = rows.iter().rposition(|r| r.starts_with('\u{276f}')) else {
        return 0;
    };
    rows[at..]
        .iter()
        .take_while(|r| r.is_empty() || !r.chars().all(|c| c == '\u{2500}'))
        .count()
}

/// aS2-1: the terminal size a window last gave a session, kept for PTYs that open with no window attached.
const WINDOW_SIZE: &str = "terminal-size";
fn saved_window_size(home: &Path) -> Option<(u16, u16)> {
    let text = String::from_utf8(store::read_regular(&home.join(WINDOW_SIZE)).ok()?).ok()?;
    let (cols, rows) = text.trim().split_once(' ')?;
    let (cols, rows) = (cols.parse().ok()?, rows.parse().ok()?);
    // The PTY's own bounds (`Pty::resize`).
    (1..=500).contains(&cols).then_some(())?;
    (1..=300).contains(&rows).then_some((cols, rows))
}

/// A session's metadata and its observed transcript path, if any, for the sub-agent view to fold off the lock.
pub(crate) type KidsFold = (Session, Option<PathBuf>);

/// Look 11-17 w10 item 1: a "Type something" answer between its digit and its Enter.
struct TypedAnswer {
    digit: String,
    text: String,
    since: std::time::Instant,
    /// When the words were written.
    typed: Option<std::time::Instant>,
}
/// w10 item 13: how long (tenths of a second) a plain shell started before any window waits for one's size: 8 s (the
/// app opens its window within a few seconds of a CLI start). NUNCHIRO_SHELL_SIZE_WAIT_MS sets it (test fixtures that
/// read a shell no window shows set it to 0).
fn shell_size_wait_tenths() -> u64 {
    std::env::var("NUNCHIRO_SHELL_SIZE_WAIT_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
        .map_or(80, |ms| ms / 100)
}
/// How long a typed answer waits for Claude's text field.
const TYPED_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// The text in Claude's question text field for option `digit`, when the cursor row `❯ <digit>. …` shows it (its
/// placeholder "Type something." counts as empty).
fn typed_field(screen: &str, digit: &str) -> Option<String> {
    screen.lines().rev().find_map(|l| {
        let rest = l.trim_start().strip_prefix('\u{276f}')?.trim_start();
        let text = rest.strip_prefix(digit)?.strip_prefix('.')?.trim();
        Some(if text == "Type something." {
            String::new()
        } else {
            text.to_string()
        })
    })
}

fn interrupt_key(keys: &[String]) -> bool {
    matches!(keys, [k] if matches!(k.to_ascii_lowercase().as_str(), "esc" | "escape" | "ctrl+c"))
}

/// Look 11-17 N0: after an interrupt key, Claude is back at its input box and its footer no longer offers "esc to
/// interrupt" (the working footer of 2.1.326): the interrupted turn is over.
fn interrupted_at_prompt(screen: &str) -> bool {
    composer(screen, AgentKind::Claude).is_some() && !screen.contains("esc to interrupt")
}

/// Ticket 991 (B1, C1): a dialog the queue may not know (Claude's "Switch model?", a trust question just drawn) is
/// on the screen: no input box, and in the last rows an indented cursor row, a marked numbered option, or a decision
/// the detector reads. A send typed now goes into the dialog and its Enter answers it, so it waits.
fn dialog_up(screen: &str, kind: AgentKind) -> bool {
    if !matches!(kind, AgentKind::Claude | AgentKind::Codex) || composer(screen, kind).is_some() {
        return false;
    }
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let tail = &rows[rows.len().saturating_sub(12)..];
    tail.iter().any(|r| {
        waiting::screen::choice_row(r).is_some_and(|(_, _, marked)| marked)
            || r.starts_with(' ') && r.trim_start().starts_with(['❯', '›'])
    }) || decision(tail).is_some()
}

/// v1a-24: the decision (permission, question or dialog) `lines` show, as Claude's detection reads it. A
/// background line ("1 shell still running") is none, and it does not hide one beside it: the lines are read
/// again without it.
fn decision(lines: &[&str]) -> Option<waiting::screen::Detection> {
    let detect = |lines: &[&str]| {
        let mut part = waiting::screen::Screen::new(500, lines.len().max(1)); // wider than any observer row
        part.feed(lines.join("\r\n").as_bytes());
        part.detect(AgentKind::Claude).filter(|d| {
            matches!(
                d.kind,
                queue::Kind::Permission | queue::Kind::Question | queue::Kind::Dialog
            )
        })
    };
    detect(lines).or_else(|| {
        let rest: Vec<&str> = lines
            .iter()
            .copied()
            .filter(|l| {
                let l = l.to_lowercase();
                !l.contains("shell still running") && !l.contains("shells still running")
            })
            .collect();
        (rest.len() < lines.len()).then(|| detect(&rest)).flatten()
    })
}

/// v1a-20: the composer row holds the paste when, whitespace collapsed and a `…` elision mark trimmed, it is the
/// start of the paste (truncated or wrapped). v1a-24: the agents echo a paste's start, never its end, so a row
/// matching only the end (`Continue` for a prompt ending so) is a menu cursor.
/// v1a-20 r2: Claude 2.1.310 collapses a paste over 800 UTF-16 units or `max(0, min(rows - 10, 2))` newlines into
/// `[Pasted text #N]` (no newline) or `[Pasted text #N +L lines]` (L = its newlines); that exact row holds it. Any
/// newline counts as collapsible, since a short terminal collapses even one.
/// v1a-24: Codex 0.161.0 collapses a paste over 1000 chars into `[Pasted Content C chars]` (C = its chars,
/// newlines included); that exact row holds it.
/// Ticket 1094 r6: the box `row` is the dropped `paste` with exactly the words he typed since (`typed`) after or
/// before it, or alone. The paste shows as its own words or as Claude's placeholder for it ("[Pasted text #n +k
/// lines]", "[Pasted Content n chars]", "[Image #n]"). Words are whole: "hi" is not in "this", and a word he typed
/// glued to the paste ("hix") proves nothing.
fn proven_copy(row: &str, paste: &str, typed: &str) -> bool {
    let box_words: Vec<&str> = row.split_whitespace().collect();
    let typed: Vec<&str> = typed.split_whitespace().collect();
    let paste_words = paste.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = typed.len();
    let rest = |r: &[&str]| {
        let r = r.join(" ");
        !r.is_empty()
            && (r == paste_words
                || r.starts_with('[') && r.ends_with(']') && holds_paste(&r, paste))
    };
    box_words.len() > n
        && (box_words.ends_with(&typed) && rest(&box_words[..box_words.len() - n])
            || box_words.starts_with(&typed) && rest(&box_words[n..]))
}
fn holds_paste(row: &str, paste: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some(chars) = row
        .strip_prefix("[Pasted Content ")
        .and_then(|r| r.strip_suffix(" chars]"))
    {
        return digits(chars) && chars.parse() == Ok(paste.chars().count());
    }
    if let Some(rest) = row
        .strip_prefix("[Pasted text #")
        .and_then(|r| r.strip_suffix(']'))
    {
        let lines = paste.matches('\n').count();
        return match rest.split_once(" +") {
            None => digits(rest) && lines == 0 && paste.encode_utf16().count() > 800,
            Some((n, count)) => {
                digits(n)
                    && lines > 0
                    && count
                        .strip_suffix(" lines")
                        .is_some_and(|c| digits(c) && c.parse() == Ok(lines))
            }
        };
    }
    // Ticket 1087: a paste that is one image path and nothing else (the composer's image-only message) is drawn as
    // "[Image #N]" by Claude 2.1.330 and Codex 0.161; text with a path, or two paths, stays as typed. Unknown here, the
    // Enter was dropped and the message sat in the agent's box.
    if let Some(n) = row
        .strip_prefix("[Image #")
        .and_then(|r| r.strip_suffix(']'))
    {
        let path = paste.trim();
        return digits(n) && path.starts_with('/') && !path.contains('\n');
    }
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let (row, paste) = (words(row.trim_matches('…')), words(paste));
    !row.is_empty() && paste.starts_with(&row)
}

/// v1a-22: a decision on `screen` other than the picker itself (its "Select model" line through its own
/// "Enter to set as default … Esc to cancel" hint), which a failing switch's Esc would answer. v1a-24: a background
/// line is no decision (it does not keep the picker open) and hides none (see `decision`).
fn dialog_beside_picker(screen: &str) -> Option<waiting::screen::Detection> {
    let mut lines: Vec<&str> = screen.lines().collect();
    if let Some(top) = lines.iter().rposition(|l| l.trim() == "Select model")
        && let Some(end) = lines[top..].iter().position(|l| {
            let l = l.to_lowercase();
            // 2.1.310 ends the picker with its key hints, 2.1.318 draws none and ends it with the effort line.
            l.contains("enter to set as default") && l.contains("esc to cancel")
                || l.contains("effort") && l.contains("to adjust")
        })
    {
        // The picker alone reads as an unclassified prompt; anything else inside it is a dialog.
        let picker: Vec<&str> = lines.drain(top..=top + end).collect();
        if let Some(found) = decision(&picker).filter(|d| d.kind != queue::Kind::Dialog) {
            return Some(found);
        }
    }
    decision(&lines)
}

/// The lines' words in one lower-case run, so a sentence the terminal wrapped still reads whole.
fn flat_words(lines: &[&str]) -> String {
    lines
        .iter()
        .flat_map(|l| l.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// One step of driving Claude's model picker, read from the current screen only.
pub(crate) fn picker_step(
    screen: &str,
    model: Option<&str>,
    effort: Option<&str>,
    confirming: bool,
) -> Step {
    let lines: Vec<&str> = screen.lines().collect();
    let top = lines.iter().rposition(|l| l.trim() == "Select model");
    let target = model
        .map_or("default", |m| {
            CLAUDE_MODELS
                .iter()
                .find(|(a, _)| *a == m)
                .map_or(m, |(_, label)| label)
        })
        .to_lowercase();
    if confirming {
        // Claude says e.g. "Set model to Sonnet 5.5 for this session only with low effort".
        // Ticket 991 B2 (seen with Claude 2.1.325 at 62 columns): a narrow terminal wraps that line, or cuts it to
        // "Model set to sonnet (claude-sonnet-5-5) for this session…". The screen is read as one run of words; the
        // sentence is what stands between its start and "for this session". Without a start in view, only the whole
        // ending counts (a permission option also says "for this session").
        let flat = flat_words(&lines);
        let confirmed = flat.match_indices("for this session").any(|(at, _)| {
            let said: String = {
                let mut tail: Vec<char> = flat[..at].chars().rev().take(100).collect();
                tail.reverse();
                tail.into_iter().collect()
            };
            let start = ["set model to", "model set to"]
                .iter()
                .filter_map(|k| said.rfind(k))
                .max();
            let whole = flat[at..].starts_with("for this session only");
            let said = start.map_or(said.as_str(), |i| &said[i..]);
            (start.is_some() || whole)
                && !said.contains("currently using")
                && (target == "default" || said.contains(&target))
        }) || {
            // Look 11-17 N3 (Claude 2.1.326 at 44 columns, a narrow Terminal pane): the line is cut before "for this
            // session": "Model set to sonnet (claude-sonnet-5-5)…". Its start, the target and the cut, within one line.
            ["model set to ", "set model to "].iter().any(|start| {
                flat.match_indices(start).any(|(at, _)| {
                    let rest = &flat[at + start.len()..];
                    target != "default"
                        && rest.starts_with(&target)
                        && rest
                            .find('\u{2026}')
                            .is_some_and(|cut| cut < 60 && !rest[..cut].contains("currently using"))
                })
            })
        };
        return if top.is_none() && confirmed {
            Step::Done
        } else {
            Step::Wait
        };
    }
    let Some(top) = top else { return Step::Wait };
    let body = &lines[top + 1..];
    let text = flat_words(body); // ticket 991 B2: the key hints wrap in a narrow terminal
    // A block left in view above the input box is not the live picker (which replaces the box), and without the
    // 2.1.310 key hints a block must carry one 2.1.318 picker line: no key goes to a screen that only looks like it.
    if composer(&lines[top..].join("\n"), AgentKind::Claude).is_some()
        || !(text.contains("to set as default")
            || text.contains("switch between claude models")
            || text.contains("to adjust"))
    {
        return Step::Wait;
    }
    if text.contains("type to search") {
        return Step::Keys(b"\x1b[B"); // leave search mode for the list; letters would filter
    }
    // Rows are `❯ 2. Sonnet   description`; only the focused one carries the cursor.
    let rows: Vec<(usize, bool, String)> = body
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let bare = l.trim_start();
            let rest = bare.strip_prefix('❯').unwrap_or(bare).trim_start();
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            let rest = rest[digits..].strip_prefix('.').filter(|_| digits > 0)?;
            let label = rest
                .trim()
                .split("  ")
                .next()?
                .trim_end_matches([' ', '✔', '✓']);
            Some((i, bare.starts_with('❯'), label.to_lowercase()))
        })
        .collect();
    // Ticket 287: Claude 2.1.318 labels rows with versions ("Sonnet 5.5") and lists older ones below ("Sonnet 5"), so
    // an alias names the family and its first row, the newest.
    let is_target = |label: &str| {
        label == target
            || target == "default" && label.starts_with("default")
            || label.split(' ').next() == Some(target.as_str())
    };
    let Some(focused) = rows.iter().position(|(_, f, _)| *f) else {
        return Step::Fail("the picker shows no focused model row");
    };
    let wanted = rows.iter().position(|(_, _, l)| is_target(l));
    if wanted != Some(focused) {
        return match wanted {
            Some(at) if at < focused => Step::Keys(b"\x1b[A"),
            _ => Step::Keys(b"\x1b[B"),
        };
    }
    if let Some(want) = effort {
        // The effort line sits under the list; a row description may say "effort" too.
        let after = rows.last().map_or(0, |(i, _, _)| i + 1);
        let shown = body[after..].iter().find_map(|l| {
            let words: Vec<String> = l.split_whitespace().map(str::to_lowercase).collect();
            let at = words.iter().position(|w| w == "effort")?;
            Some(if at == 0 {
                "unsupported".to_string()
            } else {
                words[at - 1].clone()
            })
        });
        let Some(shown) = shown else {
            return Step::Fail("the picker shows no effort line");
        };
        let order = |e: &str| CLAUDE_EFFORTS.iter().position(|x| *x == e);
        match (order(&shown), order(want)) {
            (Some(a), Some(b)) if a < b => return Step::Keys(b"\x1b[C"),
            (Some(a), Some(b)) if a > b => return Step::Keys(b"\x1b[D"),
            (Some(_), Some(_)) => {}
            _ => return Step::Fail("the picker does not offer that effort for this model"),
        }
    }
    // Claude 2.1.310 draws "s to use this session only" under the list, 2.1.318 draws no key hints; only the
    // confirmation ("... for this session only") proves the key. A hint line that omits `s` is another picker.
    if text.contains("to set as default") && !text.contains("use this session only") {
        return Step::Fail("the picker offers no session-only choice");
    }
    Step::Keys(b"s")
}

impl Sessions {
    fn switch_model(
        &mut self,
        id: &str,
        model: Option<String>,
        effort: Option<String>,
    ) -> Response {
        let meta = self.entry(id)?.meta.clone();
        // Ticket 358: an ACP agent's model is its own config option, set over ACP and only to a value it reported.
        // Ticket 994: its thinking level likewise, only to a value it listed (any other keeps the old refusal).
        if meta.kind == AgentKind::Acp {
            if model.is_none() && effort.is_none() {
                return Err("pick one of the agent's models".into());
            }
            let acp = self.entry(id)?.acp.as_mut().ok_or("agent is not running")?;
            acp.switch(&meta, model, effort)?;
            return Ok(Reply::Ack);
        }
        // Ticket 358: Claude's own picker, which this switch walks, lists only its models, so a custom id starts a
        // new Claude session and never switches one; Codex restarts with `--model` and can take it.
        if meta.kind == AgentKind::Codex {
            self.check_stored_model(meta.kind, model.as_deref(), effort.as_deref())?;
        } else {
            check_model(meta.kind, model.as_deref(), effort.as_deref())?;
        }
        let (snapshot, screen) = self.switch_checks(id, meta.kind)?; // W35: claude_modes.rs
        if meta.kind == AgentKind::Codex {
            let args = carried_codex_args(self.entry(id)?.args.as_deref())?;
            return self.restart_resumed(id, args, model, effort, None); // claude_modes.rs, shared with fast mode
        }
        if !crate::delivery::ready(meta.kind, &snapshot.attention, &snapshot.pending, &screen) {
            return Err("Claude is not at its prompt".into());
        }
        let content = format!(
            "model picker: {} · effort {} · this session only",
            model.as_deref().unwrap_or("default"),
            effort.as_deref().unwrap_or("unchanged")
        );
        let send = self.begin_send("user", id, content, vec![], false, "attempting")?;
        if let Err(error) = self.live(id)?.write(PICKER_OPEN) {
            self.finish_send(id, &send.id, "failed")?;
            return Err(error);
        }
        let now = std::time::Instant::now();
        let entry = self.entry(id)?;
        let seen = entry.observer.output_offset;
        entry.switch = Some(Switch {
            send: send.id.clone(),
            model,
            effort,
            confirming: false,
            keys: 1,
            sent: now,
            seen,
            last: seen,
            quiet: now,
            before: screen.clone(),
        });
        Ok(Reply::Delivery { send })
    }
    /// CHAT-MODELIST: whether other input to this session is held (see `send_inner`).
    /// Held while a walk runs, and after a walk that failed with the footer in (or last seen in) Skip permissions the
    /// owner never confirmed: until a mode other than that is positively read (`settle_walks`), so neither a refused
    /// pick nor a footer notice over the mode row lifts it. A turn must not start in a mode the owner only passed through.
    fn walk_hold(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|e| {
            e.walk.is_some()
                || e.skip_hold.is_some() && !e.skip_chosen && e.meta.state == SessionState::Running
        })
    }
    /// CHAT-MODELIST (ticket 285): starts the walk to `mode`. Only the owner's click gets here (`check_agent` refuses a
    /// session caller, the server's remote list a forwarded one); `sender` is checked again because Skip permissions
    /// turns off every permission prompt. The first press is the same logged `shift+tab` send the chip used, so every
    /// refusal of that path (a dialog on screen, not at the composer, busy, queue blocked) holds here too.
    /// Ticket 362: the stored Claude choice is Ask, whose sessions leave Bypass permissions out of the cycle.
    fn claude_asks(&self) -> bool {
        let stored = self
            .settings
            .features
            .get(crate::agent_permission::FEATURE_KEY);
        crate::agent_permission::stored_choice(stored, "claude") == PermissionChoice::Ask
    }
    /// Ticket 362: each agent's stored permission; absent is full access.
    fn agent_permissions(&self) -> Reply {
        let stored = self
            .settings
            .features
            .get(crate::agent_permission::FEATURE_KEY);
        Reply::AgentPermission {
            claude: crate::agent_permission::stored_choice(stored, "claude"),
            codex: crate::agent_permission::stored_choice(stored, "codex"),
            // The owner's own Claude settings and the managed ones; a project's can still turn it off at its launch.
            claude_bypass_disabled: crate::agent_permission::claude_limits(None, &self.home)
                .bypass_disabled,
        }
    }
    fn set_agent_permission(&mut self, agent: AgentKind, choice: PermissionChoice) -> Response {
        let name = crate::agent_permission::agent_key(agent)
            .ok_or("only Claude and Codex have a permission setting")?;
        let path = self.home.join("settings.json");
        let mut file = settings_file(&path)?;
        let key = crate::agent_permission::FEATURE_KEY;
        let mut stored = match self.settings.features.get(key) {
            Some(serde_json::Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        };
        stored.insert(
            name.into(),
            serde_json::to_value(choice).map_err(|e| e.to_string())?,
        );
        let stored = serde_json::Value::Object(stored);
        if !file
            .get("features")
            .is_some_and(serde_json::Value::is_object)
        {
            file["features"] = serde_json::json!({});
        }
        file["features"][key] = stored.clone();
        store::write_capped(
            &path,
            &serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?,
            store::SETTINGS_READ_MAX,
        )?;
        self.settings.features.insert(key.into(), stored);
        Ok(self.agent_permissions())
    }
    fn set_mode(&mut self, sender: &str, id: &str, mode: &str) -> Response {
        if sender != "user" {
            return Err("operation not granted".into());
        }
        if !MODES.contains(&mode) {
            return Err(format!("unknown mode: {mode}"));
        }
        self.refresh()?;
        self.observe()?;
        let meta = self.entry(id)?.meta.clone();
        if meta.kind != AgentKind::Claude {
            return Err("only Claude sessions have a live permission-mode cycle".into());
        }
        if self.entry(id)?.walk.is_some() {
            return Err("a mode change is already running for this session".into());
        }
        if self.entry(id)?.switch.is_some() {
            return Err("model switch in progress".into());
        }
        self.current(id)?;
        let screen = self.entry(id)?.observer.screen.text();
        let Some(current) = permission_mode(&screen, meta.kind) else {
            return Err("agent is not at its composer; mode not changed".into());
        };
        // Ticket 362: Claude's own settings say no: refused before any key, so the walk never goes looking for it. Read
        // again here because a restored session has no launch to have read them, off this lock's patience (a folder
        // that does not answer counts as no setting; the walk then stops with its usual reason).
        if mode == BYPASS && current != BYPASS {
            let (config, cwd) = (meta.config_dir.clone(), meta.cwd.clone());
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(crate::agent_permission::claude_limits(
                    config.as_deref(),
                    &cwd,
                ));
            });
            let limits = rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .unwrap_or_default();
            self.entry(id)?.bypass_disabled = limits.bypass_disabled;
            if limits.bypass_disabled {
                return Err("bypass permissions is turned off by Claude's settings (disableBypassPermissionsMode)".into());
            }
        }
        if mode == BYPASS {
            let asks = self.claude_asks();
            let what = match skip_state(self.entry(id)?, Some(&current), asks) {
                SkipPermissions::Unavailable => "start a new session to use it",
                SkipPermissions::NeedsSetting => {
                    "change the permission setting and start a new session"
                }
                _ => "",
            };
            if !what.is_empty() {
                return Err(format!(
                    "skip permissions is not in this session's mode cycle: {what}"
                ));
            }
        }
        if current == mode {
            let entry = self.entry(id)?;
            entry.skip_chosen |= mode == BYPASS; // the owner's pick, with the footer already there
            entry.walk_error = None;
            return Ok(Reply::Ack);
        }
        let reply = self.send_inner(
            "user",
            id,
            String::new(),
            vec!["shift+tab".into()],
            false,
            true,
        )?;
        // The pick counts once the walk has reached Bypass permissions (`advance_walks`), not when it starts. The last
        // failure shows until here: a pick refused before its first press leaves it (and the hold) as they were.
        let entry = self.entry(id)?;
        entry.walk_error = None;
        entry.walk = Some(Walk {
            target: mode.into(),
            chosen: mode == BYPASS,
            failure: None,
            start: current.clone(),
            before: current,
            sent: std::time::Instant::now(),
            keys: 1,
        });
        Ok(reply)
    }
    /// CHAT-MODELIST: one verified step per tick: the footer shows the target (done), moved to another mode (press
    /// again), came back to where it started (the cycle has no target), or did not move for `WALK_WAIT` (stop). Never
    /// a key from a stale screen, and never a key while no composer shows.
    fn advance_walks(&mut self) {
        let ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.walk.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let Some(entry) = self.entries.get_mut(&id) else {
                continue;
            };
            let walk = entry.walk.as_ref().unwrap();
            let seen = permission_mode(&entry.observer.screen.text(), entry.meta.kind);
            let outcome: Result<bool, String> = if !entry.agent_live() {
                Err("the session ended".into())
            } else if entry.observer.behind {
                if walk.sent.elapsed() > WALK_BEHIND {
                    Err("the terminal output is behind: the footer cannot be trusted; mode not confirmed".into())
                } else {
                    continue;
                }
            } else {
                match seen.as_deref() {
                    Some(m) if m == walk.target => Ok(true),
                    Some(m) if m != walk.before && m == walk.start => {
                        Err(format!("this session's mode cycle has no {}", walk.target))
                    }
                    Some(m) if m != walk.before && walk.keys >= WALK_KEYS => {
                        Err(format!("did not reach {} in a full cycle", walk.target))
                    }
                    Some(m) if m != walk.before => Ok(false),
                    _ if walk.sent.elapsed() > WALK_WAIT => {
                        Err("the footer did not change; mode not changed".into())
                    }
                    _ => continue,
                }
            };
            match outcome {
                Ok(true) => finish_walk(entry),
                Ok(false) => {
                    let m = seen.clone().unwrap();
                    match self.send_inner(
                        "user",
                        &id,
                        String::new(),
                        vec!["shift+tab".into()],
                        false,
                        true,
                    ) {
                        Ok(_) => {
                            let walk = self.entry(&id).unwrap().walk.as_mut().unwrap();
                            walk.before = m;
                            walk.sent = std::time::Instant::now();
                            walk.keys += 1;
                        }
                        Err(error) => self.end_walk(&id, seen, error),
                    }
                }
                Err(error) => self.end_walk(&id, seen, error),
            }
        }
    }
    /// A walk is over the moment the footer the observer has read shows its target: ending it here (every request
    /// observes first) means a pick right after the footer reached the target is not refused as busy, and the confirm
    /// that came with it is already kept.
    fn settle_walks(&mut self) {
        for entry in self.entries.values_mut() {
            let reached = entry.walk.as_ref().is_some_and(|w| {
                entry.agent_live()
                    && !entry.observer.behind
                    && permission_mode(&entry.observer.screen.text(), entry.meta.kind).as_deref()
                        == Some(w.target.as_str())
            });
            if reached {
                finish_walk(entry);
            }
            // The hold after a failed walk: lifted by a positive read of another mode (or the owner's confirm, or the
            // session ending); an unreadable footer (or a stale screen: the observer is behind) keeps it, up to
            // `WALK_BEHIND`.
            if entry.skip_hold.is_some() {
                let seen = (!entry.observer.behind)
                    .then(|| permission_mode(&entry.observer.screen.text(), entry.meta.kind))
                    .flatten();
                let over = !entry.agent_live()
                    || entry.skip_chosen
                    || seen.as_deref().is_some_and(|m| m != BYPASS);
                if over {
                    entry.skip_hold = None;
                } else if let Some(hold) = entry.skip_hold.as_mut() {
                    if seen.is_some() {
                        hold.unreadable_since = None;
                    } else {
                        let since = *hold
                            .unreadable_since
                            .get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() > WALK_BEHIND {
                            entry.skip_hold = None;
                        }
                    }
                }
            }
        }
    }
    /// A walk that stopped short. Crossing Skip permissions on the way to another mode must not leave the session
    /// there unconfirmed: a walk back to the start mode follows (its first press is the walk's own key, never held back
    /// by the walk it ends; the hold stays until the footer has left Skip permissions). If even that press fails, the
    /// reason says where the session is left.
    fn end_walk(&mut self, id: &str, seen: Option<String>, error: String) {
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        let walk = entry.walk.take().unwrap();
        let in_skip = seen.as_deref() == Some(BYPASS) && !entry.skip_chosen;
        // Last read in Skip permissions and now unreadable: it may still be there. Hold either way.
        let maybe_in_skip =
            in_skip || (seen.is_none() && walk.before == BYPASS && !entry.skip_chosen);
        if maybe_in_skip {
            entry.skip_hold = Some(SkipHold {
                unreadable_since: None,
            });
        }
        let (target, mut reason) = match walk.failure.clone() {
            Some((first, why)) => (first, format!("{why}; {error}")),
            None => (walk.target.clone(), error),
        };
        if in_skip {
            if walk.failure.is_none() && walk.start != BYPASS {
                match self.send_inner(
                    "user",
                    id,
                    String::new(),
                    vec!["shift+tab".into()],
                    false,
                    true,
                ) {
                    Ok(_) => {
                        if let Some(entry) = self.entries.get_mut(id) {
                            entry.walk = Some(Walk {
                                target: walk.start.clone(),
                                start: BYPASS.into(),
                                before: BYPASS.into(),
                                chosen: false,
                                failure: Some((target, reason)),
                                sent: std::time::Instant::now(),
                                keys: 1,
                            });
                        }
                        return;
                    }
                    Err(left) => {
                        reason = format!(
                            "{reason}; the session is still in Skip permissions (leaving it failed: {left})"
                        );
                    }
                }
            } else {
                reason = format!("{reason}; the session is still in Skip permissions");
            }
        }
        if let Some(entry) = self.entries.get_mut(id) {
            entry.walk_error = Some(ModeWalk {
                target,
                error: Some(reason),
            });
        }
    }
    fn advance_switches(&mut self) -> Result<(), String> {
        let now = std::time::Instant::now();
        let ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.switch.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let entry = self.entry(&id)?;
            let offset = entry.observer.output_offset;
            let ended = !entry.agent_live() || entry.pty.is_none();
            let behind = entry.observer.behind; // v1a-19 r3
            let screen = entry.observer.screen.text();
            let switch = entry.switch.as_mut().unwrap();
            if offset != switch.last {
                (switch.last, switch.quiet) = (offset, now);
            }
            let fresh = offset > switch.seen
                && now - switch.quiet >= SWITCH_SETTLE
                && screen != switch.before;
            let elapsed = now - switch.sent;
            let mut step = if ended {
                Step::Fail("the session ended")
            } else if behind {
                // v1a-19 r3: no key from a stale screen, not even the failure's Esc; the deadline waits too.
                continue;
            } else if !fresh {
                Step::Wait
            } else {
                picker_step(
                    &screen,
                    switch.model.as_deref(),
                    switch.effort.as_deref(),
                    switch.confirming,
                )
            };
            if step == Step::Wait
                && elapsed > std::time::Duration::from_secs(if switch.confirming { 10 } else { 4 })
            {
                step = Step::Fail("the picker did not show what was expected in time");
            }
            if matches!(step, Step::Keys(_)) && switch.keys >= 40 {
                step = Step::Fail("the picker did not reach the choice");
            }
            match step {
                Step::Wait => {}
                Step::Keys(bytes) => {
                    let switch = self.entry(&id)?.switch.as_mut().unwrap();
                    switch.keys += 1;
                    (switch.sent, switch.seen) = (now, offset);
                    switch.before = screen.clone();
                    if bytes == b"s" {
                        switch.confirming = true;
                    }
                    if let Err(error) = self.live(&id)?.write(bytes) {
                        eprintln!("switch write failed: {error}");
                    }
                }
                Step::Done | Step::Fail(_) => {
                    let switch = self.entry(&id)?.switch.take().unwrap();
                    let result = if let Step::Fail(reason) = step {
                        // v1a-22: the key closes the picker or takes back the typed `p`/`s` (meta+p rebound); a dialog
                        // on this tick's screen gets no key and becomes a card, an ended session gets nothing.
                        if ended {
                        } else if let Some(item) = dialog_beside_picker(&screen) {
                            // The send still closes below; a card error must not leave it attempting.
                            if let Err(error) = self.queue.screen(
                                &id,
                                item.kind,
                                item.text,
                                item.choices,
                                queue::now_ms(),
                            ) {
                                eprintln!("switch dialog card failed: {error}");
                            }
                        } else {
                            // Ticket 287: every key the switch can have typed into the box (`p` when meta+p is
                            // rebound, then `s`) is taken back with one Backspace each; otherwise Esc closes the picker.
                            let typed = composer(&screen, AgentKind::Claude)
                                .filter(|t| ["p", "s", "ps"].contains(&t.as_str()));
                            if let Ok(pty) = self.live(&id) {
                                let _ = match typed {
                                    Some(t) => pty.write(&b"\x7f".repeat(t.len())),
                                    None => pty.write(b"\x1b"),
                                };
                            }
                        }
                        format!("failed: {reason}")
                    } else {
                        let entry = self.entry(&id)?;
                        // Default effort leaves Claude's effort alone unless the model changed.
                        if switch.effort.is_some() || entry.meta.model != switch.model {
                            entry.meta.effort = switch.effort.clone();
                        }
                        entry.meta.model = switch.model.clone();
                        "switched".into()
                    };
                    let status = if step == Step::Done {
                        "delivered"
                    } else {
                        "failed"
                    };
                    self.finish_send(&id, &switch.send, status)?;
                    switch_log(
                        &id,
                        Some(AgentKind::Claude),
                        &switch.model,
                        &switch.effort,
                        &result,
                    );
                }
            }
        }
        Ok(())
    }
}
/// v1a-68 r3 (needs 2, 78): the closed shells whose view the core holds, at most `REPLAY_BYTES` each (16 MiB).
const CLOSED_VIEWS: usize = 16;
// v1a-40
const RESUMED_MARKER: &[u8] =
    "\r\n\x1b[0;2m— resumed; earlier output above —\x1b[0m\r\n".as_bytes();
/// v2-9a: the projects some session record names, as the tree keeps them.
impl Sessions {
    /// V2.5-11: the projects of the sessions this core knows, as `project_set`.
    pub(crate) fn known_projects(&self) -> std::collections::BTreeSet<String> {
        project_set(&self.entries)
    }
    /// F15: the session projects and the ones added from the tree (`Open in editor`, `Set icon`).
    fn project_roots(&self) -> std::collections::BTreeSet<String> {
        let known = project_set(&self.entries);
        match &self.tree {
            Ok(tree) => tree.known(&known),
            Err(_) => known,
        }
    }
    /// Ticket 375: what Open in editor may open: the project roots, each local session's folder and each project's
    /// managed worktree folder (`<root>/<project folder name>`, never the whole root, which may be a shared folder).
    /// Editor only: project icons and schedules keep `project_roots`.
    fn editor_roots(&self) -> std::collections::BTreeSet<String> {
        let mut roots = self.project_roots();
        let worktrees: Vec<String> = roots
            .iter()
            .flat_map(|p| {
                let p = Path::new(p);
                // Ticket 1061: worktrees made before the default moved still lie under the old root.
                let roots = [
                    self.settings.worktree_root_for(p).ok(),
                    worktree_root_for(
                        Some(Path::new(PREVIOUS_DEFAULT_DIR)),
                        p,
                        &self.settings.user_home,
                    )
                    .ok(),
                    Some(self.settings.legacy_worktree_root(&self.home)),
                ];
                roots
                    .into_iter()
                    .flatten()
                    .filter_map(|root| Some(root.join(p.file_name()?)))
                    .collect::<Vec<_>>()
            })
            // Codex look 11-20: a link there would make its target a root; only a real folder counts.
            .filter(|r| std::fs::symlink_metadata(r).is_ok_and(|m| m.is_dir()))
            .filter_map(|r| r.to_str().map(String::from))
            .collect();
        roots.extend(worktrees);
        roots.extend(
            self.entries
                .values()
                .filter(|e| e.meta.machine.is_none())
                .filter_map(|e| e.meta.cwd.to_str().map(String::from)),
        );
        roots
    }
}
/// Look 11-17 v4 Home N4: a project lead that needed the user's words asked in chat, where nothing counts it as waiting
/// for the user; the goal's prompt says how to ask, as the Home lead's brief does.
// Look 11-17 v4 Home N10: "The line is also in this project's room" was read as a line of the goal's file.
pub(crate) const GOAL_NEXT: &str = "This goal is also posted as a message in this project's room. Plan it as tasks (`nunchiro task new`). If you need the user to decide or tell you something first, ask with your question tool, one question with its options, so the user sees a card that waits for them; never only as a line in chat.";
/// Home view change 1: one project's registry facts for the digest (`Sessions::digest_facts`).
#[derive(Default)]
pub(crate) struct DigestFacts {
    pub working: usize,
    /// (decision id, observed at ms, session id).
    pub pending: Vec<(String, u64, String)>,
    pub last: (u64, String),
    /// Teammate ids with a failed seat session, and with a running one (which wins).
    pub seats_failed: std::collections::BTreeSet<String>,
    pub seats_live: std::collections::BTreeSet<String>,
}
/// Ticket 621: how many Closed rows stay in `entries`, sessions.json and the snapshot, newest first.
const CLOSED_KEEP: usize = 50;
/// Ticket 621: the Closed rows older than the newest CLOSED_KEEP that nothing still shows. Kept: a shell whose
/// read-only view is held (`closed_views`), every ancestor (parent or side parent, 16 deep) of a live row, a row that
/// shares a conversation with a live row (the chat chain), and the newest row of each project tree.toml files (a pin,
/// a group or a name; else `Tree::prune` drops that filing at the next `open`). `filed` None (tree.toml unreadable)
/// files every project. Rows in `tokens` (token rows while their records would not fit, ticket 752) are neither dropped
/// nor counted. Their files went at Close.
fn droppable(
    entries: &BTreeMap<String, Entry>,
    views: &std::collections::VecDeque<String>,
    filed: Option<&std::collections::BTreeSet<String>>,
    tokens: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    let closed = |e: &&Entry| e.meta.state == SessionState::Closed && !tokens.contains(&e.meta.id);
    if entries.values().filter(closed).count() <= CLOSED_KEEP {
        return vec![];
    }
    let mut needed: std::collections::BTreeSet<&str> = views.iter().map(String::as_str).collect();
    let mut conversations = std::collections::BTreeSet::new();
    for meta in entries
        .values()
        .map(|e| &e.meta)
        .filter(|m| m.state != SessionState::Closed)
    {
        let mut up: Vec<&str> = [&meta.parent, &meta.side_parent]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        for _ in 0..16 {
            let next: Vec<&str> = up
                .iter()
                .filter(|id| needed.insert(id))
                .filter_map(|id| entries.get(*id))
                .flat_map(|e| {
                    [&e.meta.parent, &e.meta.side_parent]
                        .into_iter()
                        .flatten()
                        .map(String::as_str)
                })
                .collect();
            up = next;
        }
        conversations.extend(meta.conversation.as_deref());
    }
    // Oldest first; a row closed before ticket 621 (no time) is older than any timed one.
    let mut old: Vec<&Session> = entries.values().filter(closed).map(|e| &e.meta).collect();
    old.sort_by_key(|m| (m.closed_at, &m.id));
    let mut newest_of_project = BTreeMap::new();
    for meta in &old {
        let project = meta.project.to_string_lossy();
        if filed.is_none_or(|f| f.contains(project.as_ref())) {
            newest_of_project.insert(project, meta.id.as_str());
        }
    }
    needed.extend(newest_of_project.into_values());
    let over = old.len() - CLOSED_KEEP;
    old[..over]
        .iter()
        .filter(|m| {
            !needed.contains(m.id.as_str())
                && m.conversation
                    .as_ref()
                    .is_none_or(|c| !conversations.contains(c.as_str()))
        })
        .map(|m| m.id.clone())
        .collect()
}
/// Ticket 621: the projects tree.toml files by a pin, a group or a name.
fn filed_projects(tree: &crate::tree::Tree) -> std::collections::BTreeSet<String> {
    let groups = tree.groups.iter().flat_map(|g| g.projects.iter());
    groups
        .chain(&tree.pins)
        .chain(tree.names.keys())
        .cloned()
        .collect()
}
impl Sessions {
    /// Ticket 621: drops the `droppable` rows, and their queue state (ticket 750). Ticket 752: a token row counts and
    /// drops like any other, and leaves its conversation and origin in `token_conversations` (saved with the rows in
    /// one write), so a resume of the conversation keeps the token's limits. When every token row's record would not
    /// fit under TOKEN_CONVERSATIONS, no token row is dropped and none counts against CLOSED_KEEP (ticket 621 round 3),
    /// so an origin is never lost.
    fn drop_closed(&mut self) {
        let filed = self.tree.as_ref().ok().map(filed_projects);
        let origins: BTreeMap<String, String> = self
            .entries
            .values()
            .filter_map(|e| Some((e.meta.id.clone(), self.token_origin(&e.meta)?)))
            .collect();
        let room = self.token_conversations.len() + origins.len() <= store::TOKEN_CONVERSATIONS;
        let mut kept: std::collections::BTreeSet<String> = match room {
            true => Default::default(),
            false => origins.keys().cloned().collect(),
        };
        // Ticket 1130 B-L3 round 5: nor a row a resume still loads from or an Undo is about to continue (neither
        // dropped nor counted, as the token rows above): a load that fails must find it in History.
        kept.extend(self.acp_loading.values().flatten().cloned());
        kept.extend(self.held_rows.iter().cloned());
        let gone: std::collections::BTreeSet<String> =
            droppable(&self.entries, &self.closed_views, filed.as_ref(), &kept)
                .into_iter()
                .collect();
        if gone.is_empty() {
            return;
        }
        // A row from before round 6 finds its origin only through its parent chain, which a drop can cut: stored now.
        for (id, origin) in &origins {
            let meta = &mut self.entries.get_mut(id).unwrap().meta;
            meta.token_origin.get_or_insert_with(|| origin.clone());
        }
        for id in &gone {
            let meta = &self.entries[id].meta;
            if let (Some(origin), Some(conversation)) = (origins.get(id), &meta.agent_session_id) {
                let record = store::TokenConversation {
                    kind: meta.kind,
                    conversation: conversation.clone(),
                    origin: origin.clone(),
                };
                if !self.token_conversations.contains(&record) {
                    self.token_conversations.push(record);
                }
            }
        }
        self.entries.retain(|id, _| !gone.contains(id));
        // A failed queue save is retried at the next `open`, which drops every state no row owns.
        if let Err(e) = self.queue.retain_sessions(|id| !gone.contains(id)) {
            eprintln!("queue state of dropped sessions not dropped: {e}");
        }
    }
}
fn project_set(entries: &BTreeMap<String, Entry>) -> std::collections::BTreeSet<String> {
    entries
        .values()
        .filter_map(|e| e.meta.project.to_str().map(String::from))
        .collect()
}
/// v1a-40: a thread per file, at most `WRITERS` at once, so the fsyncs overlap without a thread (and a masked copy)
/// per saved file when masking turns on. A failure is logged, never fatal: the stop goes on.
/// v1b-38: a thread that cannot start saves its file inline (logged) instead of panicking.
fn write_scrollback(
    home: &Path,
    batch: &[(String, Write)],
    thread: impl Fn() -> std::thread::Builder,
) {
    let save = |id: &str, write: &Write| {
        let result = match write {
            Write::Save { bytes, mask } => crate::scrollback::save(home, id, bytes, *mask),
            Write::Remask => crate::scrollback::remask(home, id),
        };
        if let Err(e) = result {
            eprintln!("scrollback save {id}: {e}");
        }
    };
    const WRITERS: usize = 4;
    for writes in batch.chunks(WRITERS) {
        std::thread::scope(|scope| {
            for (id, write) in writes {
                if let Err(e) = thread().spawn_scoped(scope, || save(id, write)) {
                    eprintln!("scrollback save {id}: no thread ({e}); saving inline");
                    save(id, write);
                }
            }
        });
    }
}
/// v1b-38 (V1A-40 review): the most saved scrollback `open` holds in memory at once (64 sessions at the full
/// `REPLAY_BYTES`). A row past it seeds nothing and its terminal reads "no live replay"; its file stays for the next
/// core. Reading it lazily would put file IO under the registry lock.
const PRELOAD_BYTES: usize = 64 * 1024 * 1024;
/// Each id's saved scrollback in order, until the total would pass `cap`; that row and the rest get None.
fn preload(home: &Path, ids: &[String], cap: usize) -> Vec<Option<crate::pty::Saved>> {
    let mut left = Some(cap);
    ids.iter()
        .map(|id| {
            let room = left?;
            let bytes = match crate::scrollback::load(home, id) {
                Ok(bytes) => bytes,
                Err(e) => {
                    eprintln!("scrollback load {id}: {e}");
                    None
                }
            }?;
            left = room.checked_sub(bytes.len());
            if left.is_none() {
                eprintln!("scrollback preload: over {cap} bytes; {id} and later rows seed nothing");
                return None;
            }
            Some(crate::pty::Saved::new(bytes))
        })
        .collect()
}
fn load_saved(home: &Path, id: &str) -> Option<crate::pty::Saved> {
    match crate::scrollback::load(home, id) {
        Ok(bytes) => bytes.map(crate::pty::Saved::new),
        Err(e) => {
            eprintln!("scrollback load {id}: {e}");
            None
        }
    }
}
/// v1a-40: the live PTY's replay, else the scrollback saved when it stopped.
fn read_replay(home: &Path, entry: &Entry, after: u64) -> Response {
    if let Some(pty) = &entry.pty {
        return pty.read(after);
    }
    // Rows restored at `open` were read there; this reads only for a row that lost its PTY in this core.
    entry
        .saved
        .get_or_init(|| load_saved(home, &entry.meta.id))
        .as_ref()
        .ok_or("session has no live replay after restart")?
        .read(after)
}
/// V2-6d: a close the last core left pending dropped its row first; the hooks file and holder log it kept go now.
fn sweep_rowless(home: &Path, row: impl Fn(&str) -> bool) {
    let names = |dir: PathBuf| {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
    };
    let hooks = names(home.to_path_buf()).filter_map(|n| {
        n.strip_prefix("hooks-")
            .and_then(|n| n.strip_suffix(".json"))
            .or_else(|| n.strip_prefix("agent-ended-")) // ticket 286
            .map(str::to_string)
    });
    let logs = names(home.join("logs").join("sessions"))
        .filter_map(|n| n.split_once(".log").map(|(id, _)| id.to_string()));
    let ids: std::collections::BTreeSet<String> = hooks.chain(logs).collect();
    for id in ids {
        if !store::valid_id(&id) || row(&id) {
            continue;
        }
        if let Err(e) =
            remove_hooks(home, &id).and_then(|()| crate::logs::remove_session(home, &id))
        {
            eprintln!("files of closed session {id}: {e}");
        }
    }
}
/// The session's own files in the core home: its hooks settings and its agent-ended marker (ticket 286).
/// Q9 psn-J4-2: a queue save that fails in `refresh` is logged, as Close's: the pass still saves the scrollback, the
/// rows and the ended card.
/// Ticket 1090: a seat that ends or closes also takes away the owner cards that are its alone: a stall card raised on
/// its check-in and a Codex reset it asked for. Its questions and permissions already leave Decisions (a session that
/// is not live sends no `pending`). Task cards (merge) and cards about other things stay. Not called for the core's own
/// stop or start, where a seat is resumed and its cards still hold.
fn close_queue(queue: &mut Queue, id: &str, failed: bool) {
    let seat_only = |i: &queue::Decision| {
        i.session_id == id
            && matches!(
                i.owner,
                Some(queue::OwnerAsk::Stall { .. } | queue::OwnerAsk::CodexReset { .. })
            )
    };
    if let Err(error) = queue
        .close(id, failed)
        .and_then(|()| queue.answer_owner(seat_only))
    {
        eprintln!("queue close persistence: {error}");
    }
}
fn remove_hooks(home: &Path, id: &str) -> Result<(), String> {
    for path in [
        home.join(format!("hooks-{id}.json")),
        ended_marker(home, id),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
/// Ticket 286: what an agent session runs, as `sh -c AGENT_WRAPPER nunchiro-agent <marker> <agent argv>`. `sh` stays
/// the PTY leader: it survives the Ctrl+C that ends the agent (the agent keeps the default), prints `ENDED_MARK` and
/// writes the agent's exit code to the marker `refresh` reads. It waits until the core answers `seen <code>` there
/// (from then on nothing but the user's keys is written), drops what reached the terminal before that (a send the core
/// wrote to the dead agent), puts back the terminal modes the agent changed, then becomes the user's shell in the same
/// folder. A marker it cannot write, or no answer within 30 s, ends the session instead: no shell the core does not
/// know of.
/// Ticket 507: the drain is POSIX (`read -t/-n` are bash's) and silent. `stty -echo -icanon min 0 time 10` makes each
/// `dd` return what is pending, or nothing after a quiet second, and echoes nothing: `read -n 1` in canonical mode had
/// the terminal reprint the pending line for each byte (one typed line became ~30). It stops at a quiet second or
/// once 3 s have passed, so keys that keep coming cannot hold the shell back. It runs only when `stty` took the
/// terminal (with none, `dd` would wait on whatever stdin is), and the saved modes come back either way. Ticket 512
/// r2: a Ctrl-C kills `dd`, `wc` and `date` (the INT trap is not inherited), so an empty count reads as 0 and an
/// empty time as the bound: the loop ends without a `[` error on the screen.
/// Ticket 991: zsh's first start file for a shell session (the core points ZDOTDIR at its folder). It hands ZDOTDIR
/// back before any other start file is read (so the user's files, and macOS's HISTFILE default, see the user's own
/// value), reads the user's .zshenv, and marks each prompt's start and each command's start with OSC 133. The window
/// erases a marked prompt before its pane narrows and zsh redraws it once (`fitPrompt` in web/src/Terminal.tsx);
/// without marks a prompt row that fills the width (oh-my-posh, powerlevel10k, starship) stayed on screen twice. The
/// mark sits in PS1, so every redraw of the prompt carries it; a hook that runs later may build PS1 again, so the
/// mark is also printed once and the hook moves to the end. The command mark matters as much: it drops the prompt's
/// mark, so the output of a running command is never erased. Kitty's and Orca's zsh integrations work the same way.
/// shortcut: a prompt drawn right after output with no line end takes that row with it when it is erased (first
/// prompt only, or with a hook that always runs after this one); mark in a line-init widget if that is ever seen.
const ZSH_MARKS: &str = r#"# Written by Nunchiro at each shell start; edits are lost. It gives ZDOTDIR back to you, reads your own .zshenv,
# and marks where each prompt starts (OSC 133), so a prompt is drawn once when its pane gets narrower.
# Off: start Nunchiro with NUNCHIRO_SHELL_INTEGRATION=0 in its environment.
if [[ -n ${NUNCHIRO_USER_ZDOTDIR+x} ]]; then
  export ZDOTDIR=$NUNCHIRO_USER_ZDOTDIR
  unset NUNCHIRO_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -o interactive ]]; then
  _nunchiro_prompt_mark() {
    builtin emulate -L zsh
    [[ $PS1 == *$'\e]133;A\a'* ]] || PS1=$'%{\e]133;A\a%}'$PS1
    if [[ ${precmd_functions[-1]} != _nunchiro_prompt_mark ]]; then
      builtin print -n '\e]133;A\a'
      precmd_functions=(${precmd_functions:#_nunchiro_prompt_mark} _nunchiro_prompt_mark)
    fi
  }
  _nunchiro_command_mark() { builtin print -n '\e]133;C\a' }
  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(_nunchiro_prompt_mark)
  preexec_functions+=(_nunchiro_command_mark)
fi
[[ ! -r ${ZDOTDIR:-$HOME}/.zshenv ]] || builtin source ${ZDOTDIR:-$HOME}/.zshenv
"#;

/// The folder `ZSH_MARKS` lives in, written when it is missing or differs (an older core's file). Read and written as
/// the core's other files are (Codex look, wave 12): a link, a FIFO or a file over the read limit at its place is
/// never followed or waited on, it is replaced.
fn zsh_marks_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join("shell").join("zsh");
    store::private_dir(&home.join("shell"))?;
    store::private_dir(&dir)?;
    let file = dir.join(".zshenv");
    if store::read_regular(&file).ok().as_deref() != Some(ZSH_MARKS.as_bytes()) {
        store::atomic_write(&file, ZSH_MARKS.as_bytes())?;
    }
    Ok(dir)
}

const AGENT_WRAPPER: &str = r#"trap : INT; m=$1; shift; s=$(stty -g 2>/dev/null); "$@"; c=$?; printf '\033]7700;nunchiro-agent-ended\007'; echo $c > "$m" || exit; i=0; while [ "$(cat "$m" 2>/dev/null)" = "$c" ]; do [ $i -lt 600 ] || exit; sleep 0.05; i=$((i+1)); done; [ -n "$s" ] && stty -echo -icanon min 0 time 10 2>/dev/null && { t=$(($(date +%s)+3)); while n=$(dd bs=4096 count=1 2>/dev/null | wc -c); d=$(date +%s); [ "${n:-0}" -gt 0 ] && [ "${d:-$t}" -lt $t ]; do :; done; }; [ -n "$s" ] && stty "$s" 2>/dev/null; exec "${SHELL:-/bin/zsh}" -i"#;
/// Ticket 488: what `AGENT_WRAPPER` prints into the terminal after the agent exits and before it writes the marker, an
/// OSC terminals ignore. In the replay it follows all the agent's output, as the marker file cannot.
const ENDED_MARK: &[u8] = b"\x1b]7700;nunchiro-agent-ended\x07";
/// Ticket 488: the longest an ended agent's card waits for `ENDED_MARK`, from when the core saw its marker; it is
/// usually in within a few milliseconds. A wrapper from before 488 (a core restarted on old sessions) never prints it.
/// No pass sleeps for it: the card is judged on the first pass that finds the mark or this time gone.
const ENDED_MARK_WAIT: std::time::Duration = std::time::Duration::from_millis(300);
/// Ticket 488: whether the replay's last 4 KiB hold `ENDED_MARK` (keys echoed after it stay within that). An agent that
/// prints the mark itself only gets the read it had before 488. Ticket 505: only this run's output counts; a resumed
/// session's seed holds the earlier run's mark.
fn ended_mark_in(pty: &crate::pty::Pty) -> bool {
    let from = pty.end().saturating_sub(4096).max(pty.run_start());
    matches!(pty.read_at_most(from, 4096), Ok(crate::api::Reply::Output { data, .. })
        if data.windows(ENDED_MARK.len()).any(|w| w == ENDED_MARK))
}
/// Ticket 488: raises an ended agent's pending card once its last output is in (`ENDED_MARK`), its wait is over, or
/// `now` (the session is ending); `true` when it judged one.
fn card_judged(entry: &mut Entry, now: bool) -> bool {
    let (Some((due, code)), Some(pty)) = (entry.card_due, &entry.pty) else {
        return false;
    };
    if !now && std::time::Instant::now() < due && !ended_mark_in(pty) {
        return false;
    }
    entry.card_due = None;
    // Ticket 512 (488 review): a card raised meanwhile (a sign-in or start failure) says more than how it ended.
    if entry.meta.problem.is_some() {
        return true;
    }
    // Ticket 505: this run's output only, so a card judged before this run's mark never cuts at an earlier run's.
    let run = match pty.read_at_most(pty.run_start(), usize::MAX) {
        Ok(crate::api::Reply::Output { data, .. }) => data,
        _ => pty.snapshot(),
    };
    entry.meta.problem = crate::problems::ended(entry.meta.kind, agent_output(&run), code, false);
    true
}
/// Ticket 505: the replay up to the last `ENDED_MARK`, the agent's own output. What follows is the wrapper's and the
/// shell's: keys typed into the dead agent, reprinted once per byte the wrapper drains, pushed the agent's sign-in line
/// out of the card's bottom lines when the card was judged after them. With no mark (a pre-488 wrapper), all of it.
fn agent_output(replay: &[u8]) -> &[u8] {
    let end = replay
        .windows(ENDED_MARK.len())
        .rposition(|w| w == ENDED_MARK);
    &replay[..end.unwrap_or(replay.len())]
}
/// The lead's line for the user's yes on a merge card. The exact commit: a lead that merges what it is told merges what
/// was reviewed, whatever the worktree holds by now. Look 11-17 v3 (N31): merging a commit id, git's own message is
/// "Merge commit '704fffb…'", which names no task; the line says what to write.
fn merge_yes_line(task: &str, title: &str, revision: &str) -> String {
    let short: String = revision.chars().take(7).collect();
    format!(
        "The user said yes: merge task {task} ({title}) as reviewed at {short}. Merge exactly that commit (`git merge \
         {revision}`), not the branch as it is now, and name the task in the merge's message (\"Merge task {task}: \
         {title}\") instead of git's default; if anything changed since, have it reviewed and ask again."
    )
}

fn ended_marker(home: &Path, id: &str) -> PathBuf {
    home.join(format!("agent-ended-{id}"))
}
/// Ticket 436: `refresh` runs under the registry mutex, so the marker is read only as a regular file (a FIFO or device
/// there is refused by a non-blocking open, never waited on), and at most 64 bytes of it (an exit code line).
fn read_marker(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut code = String::new();
    crate::store::open_regular(path)
        .ok()?
        .take(64)
        .read_to_string(&mut code)
        .ok()?;
    Some(code)
}
/// Ticket 436: the wrapper's go-ahead, written as `read_marker` reads: a non-blocking open (a FIFO swapped in without
/// a reader fails at once instead of waiting for one) and a regular file only. A link at the path is refused, never
/// written through (v37-store-nofollow), and the old text is cut only once the handle is known to be a regular file.
fn answer_marker(path: &Path, code: &str) -> std::io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    file.set_len(0)?;
    file.write_all(format!("seen {code}\n").as_bytes())
}
pub struct Launch {
    home: PathBuf,
    settings: Settings,
    start: StartSession,
    id: String,
    project: PathBuf,
    pub(crate) cwd: PathBuf,
    version: Option<String>,
    // V1A-89: a `--version` probe that outlived `VERSION_WAIT`; `start` hands it to the session's entry.
    version_probe: std::cell::Cell<Option<VersionProbe>>,
    worktree_created: bool,
    folder: Option<PathBuf>, // V2-8f: an existing managed worktree, not a new checkout
    resume_cwd: Option<PathBuf>,
    start_commit: Option<crate::diff::Base>, // v1b-11
    // v2-2a: (variable, account folder) for a login tab; v2-2b: or an agent session on an account.
    config: Option<(&'static str, PathBuf)>,
    // v2-2b: the account folder of the run a resume continues (inner None: "Your own"); None when nothing is resumed.
    resume_config: Option<Option<PathBuf>>,
    /// Ticket 451: the account folder a resumed conversation ran on, when the resume names another (None: "Your own").
    carry_from: Option<Option<PathBuf>>,
    // v2-2b: the label of the account `config` names for an agent session.
    account: Option<String>,
    // V2-5b: "Start without Nunchiro hooks" (this launch only; the setting stays).
    without_hooks: bool,
    // Round 3: a sign-in tab; its output is never saved as scrollback (`Session::no_history`).
    no_history: bool,
    account_tab: bool,
    /// Ticket 362: started by the owner in the app (`owner_start`).
    owner: bool,
    /// Ticket 1008 round 2: started from the owner's own terminal (the socket without a session token).
    owner_terminal: bool,
    /// Ticket 1002 lane 1: this start carries the Home seat lock whatever its folder: it resumes a locked run, is a side
    /// chat of one, or a locked session starts it (`launch_as`). `prepare` also sets it for a Claude start in Home.
    home_lock: bool,
    /// Ticket 1002 lane 1: the lock's mode for this start (`home_lock::effective`), set by `prepare`; the hook gets it.
    home_mode: Option<crate::home_lock::Mode>,
    permission: Vec<String>,
    /// Look 11-17 N2: the mode a resumed Claude row last showed (`Session::ran_mode`).
    ran_mode: Option<String>,
    bypass_disabled: bool,
    /// Ticket 1018: a Claude start's Ultracode as its settings and arguments start it, read by `prepare` off the lock.
    ultracode: Option<bool>,
    // Ticket 358: the approved command read by `prepare`, and the arguments this start takes from it.
    command: Option<crate::approval::CommandProof>,
    approved_args: Vec<String>,
    env: BTreeMap<String, String>, // ticket 573: never stored with the session
    /// Ticket 573: the token the caller of this start acts for (round 6: its stored origin); its settings keep the
    /// agent out of the Nunchiro folder.
    origin: Option<String>,
    pub committed: bool,
    /// Q9 en-b-J7-1: a Codex start's sandbox is read-only (`codex_sandbox::read_only`), read by `prepare` off the
    /// registry lock; None when this launch was not prepared, and `spawn` reads it then.
    codex_read_only: Option<bool>,
    /// Q9 en-b-J7-2: `codex_hooks_exclusive` for a plain Codex start (no args), read with the sandbox.
    codex_hooks_clear: Option<bool>,
}
/// The recorded worktree at `path` (canonical), read from the store without its lock.
fn recorded_worktree(home: &Path, settings: &Settings, path: &Path) -> Option<Worktree> {
    let plan = WorktreePlan::owner(home, &settings.legacy_worktree_root(home), "list", None);
    let (disk, _, _) = plan.load(&home.join("worktrees.json")).ok()?;
    disk.worktrees.into_iter().find(|w| w.path == path)
}
/// Its project, for a worktree whose folder is there.
fn recorded_worktree_project(home: &Path, settings: &Settings, path: &Path) -> Option<PathBuf> {
    recorded_worktree(home, settings, path)
        .filter(|w| !w.missing)
        .map(|w| w.project)
}
fn managed_start_folder(
    home: &Path,
    settings: &Settings,
    project: &Path,
    folder: &Path,
) -> Result<PathBuf, String> {
    let root = settings.legacy_worktree_root(home);
    let mut plan = WorktreePlan::owner(home, &root, "list", None);
    plan.project = Some(project.to_path_buf());
    let (worktrees, _, _) = plan.run()?;
    worktrees
        .into_iter()
        .find(|w| w.path == folder && !w.missing)
        .map(|w| w.path)
        .ok_or_else(|| "start folder is not a managed worktree of this project".into())
}

impl Launch {
    /// Ticket 362 (owner 11-09): a start the owner made in the app runs with the owner's stored permission (`prepare`).
    /// Opt-in per call site, so a scheduled run, a widget act, a session caller or a remote one never gets it.
    /// Full access is same-user trust: an agent under it can edit Nunchiro's settings file, and no file guard is claimed.
    pub(crate) fn owner_start(mut self) -> Self {
        self.owner = true;
        self
    }
    /// Ticket 1008 round 2: a start from the owner's own terminal; only a shell's environment depends on it.
    pub(crate) fn owner_terminal(mut self) -> Self {
        self.owner_terminal = true;
        self
    }
    /// Ticket 322: a login or logout tab the core starts for an account; the window files it on Settings > Accounts.
    pub(crate) fn with_account_tab(mut self) -> Self {
        self.account_tab = true;
        self
    }
    /// Round 3: a sign-in tab keeps no saved scrollback, whatever the Terminal History setting says.
    pub(crate) fn without_history(mut self) -> Self {
        self.no_history = true;
        self
    }
    pub(crate) fn with_folder(mut self, folder: Option<PathBuf>) -> Self {
        self.folder = folder;
        self
    }
    /// Ticket 573: `agent start --env`, checked here so every caller (socket, window, forwarded) gets one rule.
    pub(crate) fn with_env(mut self, env: BTreeMap<String, String>) -> Result<Self, String> {
        // `spawn_acp` never reads it: refused, not dropped without a word.
        if self.start.kind == AgentKind::Acp && !env.is_empty() {
            return Err(
                "--env: an ACP agent does not take --env yet; set its environment in agents.toml"
                    .into(),
            );
        }
        check_start_env(&env)?;
        self.env = env;
        Ok(self)
    }
    pub(crate) fn prepare_existing(self, path: &Path) -> Result<Self, String> {
        let mut launch = self.prepare()?;
        launch.cwd = fs::canonicalize(path).map_err(|e| e.to_string())?;
        launch.start_commit = Some(crate::diff::start(&launch.cwd)); // v1b-11
        launch.read_codex_sandbox(); // for this folder
        Ok(launch)
    }
    /// V1A-89: Start waits `VERSION_WAIT` for `--version`; a slower probe goes on under `VERSION_CEILING` and
    /// `refresh` fills the version in, so host load alone never fails a start.
    fn version_of(&mut self, program: &str) -> Result<Option<String>, String> {
        let probe = version_probe(program, VERSION_CEILING)?;
        match probe.recv_timeout(VERSION_WAIT) {
            Ok(version) => version.map(Some),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.version_probe = std::cell::Cell::new(Some(probe));
                Ok(None)
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(format!(
                "{program} --version: probe ended without an answer"
            )),
        }
    }
    pub fn prepare(mut self) -> Result<Self, String> {
        if self.start.args.iter().any(|arg| arg == SIDE_CHAT_ARG) {
            let expected = match self.start.kind {
                AgentKind::Claude => ["--permission-mode", "plan", SIDE_CHAT_ARG],
                AgentKind::Codex => ["--sandbox", "read-only", SIDE_CHAT_ARG],
                _ => return Err("Side chat requires Claude or Codex".into()),
            };
            if self.start.resume.is_some()
                || !matches!(self.start.args.len(), 3..=5)
                || self.start.args[..3] != expected
            {
                return Err("invalid temporary Side chat launch".into());
            }
        }
        #[cfg(test)]
        if let Some(hook) = IN_PREPARE.take() {
            hook();
        }
        if self.start.label.len() > 256 {
            return Err("label exceeds 256 bytes".into());
        }
        // Ticket 358: refused here, before any worktree exists; `start` reads it again under the lock.
        self.command = crate::approval::check_command(&self.home, self.start.kind)?;
        // v1a-10: a model or effort is one argv value after `--model`/`-m`; it can never read as a flag.
        if [&self.start.model, &self.start.effort]
            .into_iter()
            .flatten()
            .any(|v| {
                v.is_empty()
                    || v.len() > 100
                    || v.starts_with('-')
                    || v.chars().any(|c| c.is_whitespace() || c.is_control())
            })
        {
            return Err("invalid model or effort".into());
        }
        // v25f F10: a shell needs no project; none given starts it in the user's home (the window does not know $HOME).
        if self.start.kind == AgentKind::Shell && self.start.project.as_os_str().is_empty() {
            self.start.project = std::env::var_os("HOME").ok_or("no HOME")?.into();
        }
        self.project = fs::canonicalize(&self.start.project).map_err(|e| e.to_string())?;
        if !self.project.is_dir() {
            return Err("project is not a directory".into());
        }
        // Ticket 990: a start in a recorded worktree (`agent start --project <worktree>`, the orchestration guide's way)
        // belongs to that worktree's project, as one the window starts there with `folder`. Without this the tree drew
        // the worker as a project of its own, named by the worktree's folder.
        // The record is read without worktrees.lock, so a start never waits on a create that holds it (v1a-23).
        let mut recorded = false;
        if self.folder.is_none()
            && !self.start.worktree
            && self.start.resume.is_none()
            && self.config.is_none()
            && let Some(project) =
                recorded_worktree_project(&self.home, &self.settings, &self.project)
        {
            self.folder = Some(std::mem::replace(&mut self.project, project));
            self.start.project = self.project.clone();
            recorded = true;
        }
        // v2-2a: the folder the override names is the one the tab runs in (a link swapped in since is refused).
        if let Some((_, folder)) = &self.config
            && (self.start.kind != AgentKind::Shell
                || self.start.worktree
                || &self.project != folder)
        {
            return Err("invalid account login launch".into());
        }
        // v2-2b: an account by label from the registry only; a resumed conversation keeps the account it ran on.
        if self.config.is_none() {
            let agent = crate::accounts::agent_of(self.start.kind);
            let chosen = match (&self.start.account, agent) {
                (None, _) => None,
                (Some(_), None) => {
                    return Err("an account is only for claude or codex sessions".into());
                }
                // Ticket 451: "Your own", named (absent keeps a resumed conversation's account).
                (Some(label), Some(_)) if label.is_empty() => None,
                (Some(label), Some(agent)) => {
                    Some(crate::accounts::folder_by_label(&self.home, agent, label)?)
                }
            };
            let folder = match (self.resume_config.take(), agent) {
                // Ticket 451 step 2: a resume that names another account continues the conversation there. Its record
                // is copied below, once the conversation id has been checked.
                (Some(prior), Some(_))
                    if self.start.account.is_some()
                        && prior.as_ref() != chosen.as_ref().map(|(folder, _)| folder) =>
                {
                    self.carry_from = Some(prior);
                    chosen
                }
                (Some(Some(prior)), Some(agent)) => {
                    Some(crate::accounts::folder_again(&self.home, agent, &prior)?)
                }
                _ => chosen,
            };
            if let Some(((folder, label), agent)) = folder.zip(agent) {
                self.config = Some((crate::accounts::variable(agent), folder));
                self.account = Some(label);
            }
        } else if self.start.account.is_some() {
            return Err("invalid account login launch".into());
        }
        if self
            .start
            .resume
            .as_deref()
            .is_some_and(|s| !store::valid_id(s))
        {
            return Err("invalid resume session id".into());
        }
        if let Some(prior) = self.carry_from.take() {
            if self.start.kind != AgentKind::Claude {
                return Err("continuing on another account is for Claude sessions for now".into());
            }
            let id = self
                .start
                .resume
                .as_deref()
                .ok_or("no conversation to continue")?;
            let from = crate::accounts::config_home(self.start.kind, prior.as_deref())
                .ok_or("HOME missing")?;
            let to = crate::accounts::config_home(
                self.start.kind,
                self.config.as_ref().map(|(_, folder)| folder.as_path()),
            )
            .ok_or("HOME missing")?;
            crate::account_carry::claude(&from, &to, id)?;
        }
        self.id = store::new_id()?;
        self.cwd = self.project.clone();
        if let Some(folder) = &self.folder {
            if self.start.worktree || self.start.resume.is_some() {
                return Err("folder cannot be combined with worktree or resume".into());
            }
            self.cwd = if recorded {
                folder.clone()
            } else {
                managed_start_folder(&self.home, &self.settings, &self.project, folder)?
            };
        } else if let Some(cwd) = self.resume_cwd.clone() {
            self.cwd = cwd;
        } else if self.start.worktree {
            let repo = self.project.file_name().ok_or("invalid repository name")?;
            let root = self.settings.worktree_root_for(&self.project)?;
            let parent = worktree_parent(&root, repo, self.settings.default_base().as_deref())?;
            // Security (ticket 1061): the resolved folder, so a link swapped in after check_token_reach is still caught.
            if self.origin.is_some() {
                tokens::outside_home(&self.home, &parent)?;
            }
            self.cwd = start_worktree::folder(&parent, &self.id);
            self.worktree_created = true;
            // Ticket 403 item 4: the same checkout helper as a create.
            let cwd = self.cwd.to_string_lossy();
            let (base, branch) = start_worktree::target(&self.project, &self.cwd);
            let add = ["worktree", "add", "-b", &branch, "--", &cwd, &base];
            crate::process::git_worktree_add(&self.project, &add, GIT_WORKTREE)
                .map_err(|e| format!("worktree start failed: {e}"))?;
            self.cwd = fs::canonicalize(&self.cwd).map_err(|e| e.to_string())?;
        }
        self.version = match self.start.kind {
            AgentKind::Shell => None,
            AgentKind::Claude => {
                let program = agent_program("claude", self.command.as_ref());
                self.version_of(&program)?
            }
            AgentKind::Codex => {
                let program = agent_program("codex", self.command.as_ref());
                self.version_of(&program)?
            }
            AgentKind::Acp => None, // V2-4a
        };
        // v1b-11: HEAD of the folder the agent runs in, read here because prepare runs off the lock.
        self.start_commit = Some(crate::diff::start(&self.cwd));
        // Ticket 362: read here, off the lock. The row's reason needs it for every Claude session, owner's or not.
        let limits = if self.start.kind == AgentKind::Claude {
            let config = self.config.as_ref().map(|(_, folder)| folder.as_path());
            crate::agent_permission::claude_limits(config, &self.cwd)
        } else {
            Default::default()
        };
        self.bypass_disabled = limits.bypass_disabled;
        if self.start.kind == AgentKind::Claude {
            let config = self.config.as_ref().map(|(_, folder)| folder.as_path());
            self.ultracode = claude_modes::launched_ultracode(&self.start)
                .then_some(true)
                .or_else(|| crate::agent_permission::claude_ultracode(config, &self.cwd));
        }
        // Ticket 991 (B6 chip): a Codex start says its own mode below; a resumed row's earlier one is not this start's.
        if self.start.kind == AgentKind::Codex {
            self.ran_mode = None;
        }
        // Ticket 1002 lane 1 (owner E1, E2): a Claude seat in the Home folder, or a start that carries the lock, runs in the
        // Settings > Assistants mode with the lock's deny list and hook, on every path (window, resume, schedule, lead,
        // a session's child). A resume takes the chosen mode, never the footer's last one.
        let in_home = crate::home_lock::in_home(&self.home, &self.cwd);
        self.home_lock |= self.start.kind == AgentKind::Claude && in_home;
        // Fable review R6: v1's Home seats are Claude only (a Codex or ACP seat there would sit unlocked in the locked
        // seat's room). A shell (the owner's own terminal there) stays.
        if in_home && matches!(self.start.kind, AgentKind::Codex | AgentKind::Acp) {
            return Err(
                "Home seats are Claude in v1 (the chief of staff's lock is for Claude seats)"
                    .into(),
            );
        }
        // Fable review R1a: every locked session is in the Home folder, so a child cannot edit a folder of its choice.
        if self.home_lock && !in_home {
            return Err("a session the chief of staff starts stays in the Home folder".into());
        }
        if self.home_lock {
            if self.start.kind != AgentKind::Claude {
                return Err("a Home seat starts only Claude sessions (they carry its lock)".into());
            }
            let side = self.start.args.iter().any(|a| a == SIDE_CHAT_ARG);
            let approved = match &self.command {
                Some(command) if self.owner && !side => command.args().to_vec(),
                _ => vec![],
            };
            if let Some(flag) = crate::home_lock::widening(&approved)
                .or_else(|| crate::home_lock::widening(&self.start.args).filter(|_| !side))
            {
                return Err(format!(
                    "{flag}: a Home seat runs with the mode in Settings > Assistants and its lock; this argument is not taken"
                ));
            }
            self.approved_args = approved;
            let user_home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            let user = crate::extensions::agent_servers(&user_home)
                .0
                .into_iter()
                .filter(|s| s.agent == "claude")
                .map(|s| s.name)
                .chain(crate::extensions::sealed_names(&self.home)) // owner R2: not loaded, denied too
                .collect();
            let servers = crate::home_lock::deny_servers(
                user,
                crate::extensions::claude_connectors(&user_home),
            );
            let stored = self.settings.features.get(crate::home_lock::MODE_KEY);
            let mode = match side {
                true => crate::home_lock::Mode::Ask, // its plan mode stays
                false => crate::home_lock::effective(crate::home_lock::mode(stored), self.owner),
            };
            let args = crate::home_lock::args(mode, &servers);
            self.permission = if side { args[2..].to_vec() } else { args };
            self.home_mode = Some(mode);
            self.ran_mode = (!side)
                .then(|| crate::agent_permission::claude_start_mode(&self.permission))
                .flatten()
                .map(String::from);
        } else if self.owner
            && let Some(agent) = crate::agent_permission::agent_key(self.start.kind)
        {
            let stored = self
                .settings
                .features
                .get(crate::agent_permission::FEATURE_KEY);
            let side = self.start.args.iter().any(|a| a == SIDE_CHAT_ARG);
            // Owner starts only, as with the stored permission: an approved argument may be a skip flag, which a session
            // caller's child must not reach (`reaches_skip`), and a side chat stays read-only.
            if !side && let Some(command) = &self.command {
                self.approved_args = command.args().to_vec();
            }
            let choice = crate::agent_permission::stored_choice(stored, agent);
            let user = [&self.approved_args[..], &self.start.args[..]].concat();
            let resumed = self
                .ran_mode
                .as_deref()
                .filter(|_| self.start.kind == AgentKind::Claude && !side)
                .and_then(|ran| {
                    crate::agent_permission::claude_resume_args(ran, choice, &user, limits)
                });
            self.permission = resumed.unwrap_or_else(|| {
                crate::agent_permission::launch_args(self.start.kind, choice, &user, side, limits)
            });
            if self.start.kind == AgentKind::Codex && !side {
                self.ran_mode =
                    crate::agent_permission::codex_mode(choice, &user).map(String::from);
            }
            // Look 1117 v9 N-S3-3: a new Claude start names its mode before the first footer (a trust question, then a
            // turn, can hide it for the whole first turn).
            if self.start.kind == AgentKind::Claude && !side && self.ran_mode.is_none() {
                self.ran_mode =
                    crate::agent_permission::claude_start_mode(&self.permission).map(String::from);
            }
        }
        self.read_codex_sandbox();
        Ok(self)
    }
    /// Q9 en-b-J7-1: canonical path, ancestor stats and config reads; a hung mount must not hold the registry lock.
    fn read_codex_sandbox(&mut self) {
        if self.start.kind == AgentKind::Codex {
            let args = [
                &self.permission[..],
                &self.approved_args[..],
                &self.start.args[..],
            ]
            .concat();
            let config = self.config.as_ref().map(|(_, folder)| folder.as_path());
            self.codex_read_only = Some(crate::codex_sandbox::read_only(&args, &self.cwd, config));
            self.codex_hooks_clear = (self.start.args.is_empty() && self.approved_args.is_empty())
                .then(|| codex_hooks_exclusive(&self.cwd, &self.project, config));
        }
    }
}
impl Drop for Launch {
    fn drop(&mut self) {
        if self.committed {
            // Ticket 573: a `--worktree` start's folder is a worktree created, as `worktree create`'s is.
            if self.worktree_created {
                crate::events::worktree("created", &self.project, &self.cwd);
            }
            return;
        }
        let _ = fs::remove_file(self.home.join(format!("hooks-{}.json", self.id)));
        if self.worktree_created {
            let cwd = self.cwd.to_string_lossy();
            let remove = ["worktree", "remove", "--force", "--", &cwd];
            if let Err(e) =
                crate::process::git_worktree_remove(&self.project, &self.cwd, &remove, GIT_WORKTREE)
            {
                eprintln!("worktree rollback failed: {e}");
            }
        }
    }
}
/// Ticket 209: what a parent Claude Code or Codex session exports to its children. A started agent, shell or login that
/// inherits it would act as that conversation (`CLAUDE_CODE_CHILD_SESSION` also turns its transcript off) or hold its
/// messaging token.
pub(crate) const PARENT_SESSION_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "TRACEPARENT",
    "TRACESTATE",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
];
/// Ticket 209: a name in `PARENT_SESSION_ENV`, or any `CLAUDE_CODE_MESSAGING_*` (socket, token, and whatever follows).
pub(crate) fn is_parent_session_env(name: &std::ffi::OsStr) -> bool {
    let name = name.as_encoded_bytes();
    name.starts_with(b"CLAUDE_CODE_MESSAGING_")
        || PARENT_SESSION_ENV.iter().any(|n| n.as_bytes() == name)
}
/// Ticket 595: what `agent start --env` may set, as an allow list (ticket 573's deny list missed any name nobody thought
/// of, such as `SSL_CERT_FILE` or `PERL5OPT`). The 11-14 survey found no guide, skill, spec or loop script passing any
/// name; the list is the task context a lead hands a worker (`TASK_*`, `LANE_*`) and the log, colour, CI and locale
/// names a test run reads. A secret word is refused even inside those prefixes. cmux takes any name; this does not.
pub(crate) fn check_start_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    const ALLOW: &[&str] = &[
        "RUST_LOG",
        "RUST_BACKTRACE",
        "NO_COLOR",
        "FORCE_COLOR",
        "CI",
        "TZ",
        "LANG",
        "LC_ALL",
    ];
    const ALLOW_PREFIX: &[&str] = &["TASK_", "LANE_", "CLAUDE_CODE_EXPERIMENTAL_"];
    if env.len() > 64 {
        return Err("at most 64 --env values".into());
    }
    for (key, value) in env {
        let upper = key.to_ascii_uppercase();
        let well_formed = key.len() <= 128
            && key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !well_formed || value.len() > 4096 || value.contains('\0') {
            return Err(format!("--env {key}: invalid name or value"));
        }
        if ["TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL", "AUTH"]
            .iter()
            .any(|word| upper.contains(word))
            || crate::start_secrets::is_secret(key)
        {
            return Err(format!("--env {key}: secrets are not passed this way"));
        }
        if !ALLOW.contains(&upper.as_str()) && !ALLOW_PREFIX.iter().any(|p| upper.starts_with(p)) {
            return Err(format!(
                "--env {key}: not on the allow list (TASK_*, LANE_*, CLAUDE_CODE_EXPERIMENTAL_*, RUST_LOG, RUST_BACKTRACE, NO_COLOR, FORCE_COLOR, CI, TZ, LANG, LC_ALL); pass task context as a TASK_ name, or ask the owner to add the name (docs/cli.md)"
            ));
        }
    }
    Ok(())
}
/// V2-2a: what a login tab never inherits from the core: either agent's config folder and the credentials that
/// override a folder's login.
pub(crate) const ACCOUNT_ENV: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    // Claude Code 2.1.311 names its Keychain item from this one first (accounts.rs, REPORT r2).
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
];
/// Ticket 1003: how long a spent Outbox mail waits for its PostToolUse, and how many may wait at once (an approval
/// lives 10 minutes; a send runs in seconds).
const OUTBOX_SENDING_MS: u64 = 15 * 60 * 1000;
const OUTBOX_SENDING_MAX: usize = 16;
const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];
/// Ticket 455: Nunchiro's own hooks as a launch passes them; the extensions list shows these same lines.
pub(crate) fn nunchiro_hooks() -> Result<Vec<crate::extensions::HookLine>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hook = format!("{} hook", shell_quote(&exe.to_string_lossy()));
    Ok(HOOK_EVENTS
        .iter()
        .map(|event| crate::extensions::HookLine {
            event: (*event).into(),
            matcher: if ["PermissionRequest", "PreToolUse", "PostToolUse"].contains(event) {
                "*".into()
            } else {
                String::new()
            },
            command: format!("{hook} {event}"),
        })
        .collect())
}
fn codex_hooks_exclusive(cwd: &Path, project: &Path, config_dir: Option<&Path>) -> bool {
    #[cfg(test)]
    if let Some(answer) = IN_HOOKS_CHECK.take() {
        return answer(); // Q9 en-b-J7-2: a test answers without the owner's ~/.codex
    }
    // Require absence rather than interpret evolving Codex config/plugin schemas.
    let absent = |path: PathBuf| matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let home = crate::accounts::config_home(AgentKind::Codex, config_dir); // v2-2b
    let Some(home) = home.filter(|home| home.is_absolute()) else {
        return false;
    };
    let clear = |dir: PathBuf| {
        absent(dir.join("hooks.json"))
            && absent(dir.join("plugins"))
            && (absent(dir.join("config.toml")) || codex_written_config(&dir.join("config.toml")))
    };
    clear(home)
        && [cwd, project]
            .iter()
            .all(|path| path.ancestors().all(|parent| clear(parent.join(".codex"))))
}
/// Ticket 690 r2: the `[tui]` and `[notice]` keys of Codex 0.161.0 (the `Tui` and `Notice` field lists in its binary); a
/// key a later Codex adds there withholds the hooks until it is checked and listed here.
const CODEX_TUI_KEYS: [&str; 27] = [
    "notifications",
    "notification_method",
    "notification_condition",
    "animations",
    "screen_reader_detection_done",
    "effects",
    "rendering",
    "show_tooltips",
    "show_server_version_notice",
    "auto_recap",
    "disable_paste_burst",
    "question_esc_back",
    "raw_output_mode",
    "fullscreen_transcript",
    "copy_on_select",
    "right_click_paste",
    "status_line",
    "status_line_use_colors",
    "terminal_title",
    "theme",
    "pet",
    "pet_anchor",
    "session_picker_view",
    "resume_cwd",
    "keymap",
    "model_availability_nux",
    "terminal_resize_reflow_max_rows",
];
const CODEX_NOTICE_KEYS: [&str; 8] = [
    "hide_full_access_warning",
    "hide_world_writable_warning",
    "fast_default_opt_out",
    "hide_rate_limit_model_nudge",
    "hide_gpt5_1_migration_prompt",
    "hide_gpt-5.1-codex-max_migration_prompt",
    "model_migrations",
    "external_config_migration_prompts",
];
/// Ticket 760 r2: every key path Codex 0.161's config schema (`codex-rs/core/config.schema.json` at `rust-v0.161.0`, the
/// `RawMcpServerConfig` and `ModelProviderInfo` field counts match the binary's) defines under the six usual keys. `*`
/// is a name the person picks (a server, a provider, a header), `[]` an entry of a list of tables. A path not listed
/// here, such as a field a later Codex adds, withholds the hooks until it is checked and listed.
const CODEX_USUAL_KEYS: [&str; 88] = [
    "approval_policy",
    "approval_policy.granular.mcp_elicitations",
    "approval_policy.granular.request_permissions",
    "approval_policy.granular.rules",
    "approval_policy.granular.sandbox_approval",
    "approval_policy.granular.skill_approval",
    "mcp_servers.*.args",
    "mcp_servers.*.auth",
    "mcp_servers.*.bearer_token_env_var",
    "mcp_servers.*.command",
    "mcp_servers.*.cwd",
    "mcp_servers.*.default_tools_approval_mode",
    "mcp_servers.*.disabled_tools",
    "mcp_servers.*.enabled",
    "mcp_servers.*.enabled_tools",
    "mcp_servers.*.env.*",
    "mcp_servers.*.env_http_headers.*",
    "mcp_servers.*.env_vars",
    "mcp_servers.*.env_vars.[]",
    "mcp_servers.*.env_vars.[].name",
    "mcp_servers.*.env_vars.[].source",
    "mcp_servers.*.environment_id",
    "mcp_servers.*.http_headers.*",
    "mcp_servers.*.http_headers_helper",
    "mcp_servers.*.name",
    "mcp_servers.*.oauth.authorization_server_issuer",
    "mcp_servers.*.oauth.callback_port",
    "mcp_servers.*.oauth.callback_url",
    "mcp_servers.*.oauth.client_id",
    "mcp_servers.*.oauth.client_secret",
    "mcp_servers.*.oauth_resource",
    "mcp_servers.*.omit_tools_from",
    "mcp_servers.*.required",
    "mcp_servers.*.scopes",
    "mcp_servers.*.startup_readiness",
    "mcp_servers.*.startup_timeout_ms",
    "mcp_servers.*.startup_timeout_sec",
    "mcp_servers.*.supports_parallel_tool_calls",
    "mcp_servers.*.tool_input_schema_max_bytes",
    "mcp_servers.*.tool_timeout_sec",
    "mcp_servers.*.tools.*.approval_mode",
    "mcp_servers.*.tools.*.output_token_limit",
    "mcp_servers.*.url",
    "model_provider",
    "model_providers.*.auth.args",
    "model_providers.*.auth.command",
    "model_providers.*.auth.cwd",
    "model_providers.*.auth.refresh_interval_ms",
    "model_providers.*.auth.timeout_ms",
    "model_providers.*.aws.auth_refresh.args",
    "model_providers.*.aws.auth_refresh.command",
    "model_providers.*.aws.auth_refresh.timeout_ms",
    "model_providers.*.aws.credential_export.args",
    "model_providers.*.aws.credential_export.command",
    "model_providers.*.aws.credential_export.timeout_ms",
    "model_providers.*.aws.profile",
    "model_providers.*.aws.region",
    "model_providers.*.base_url",
    "model_providers.*.env_http_headers.*",
    "model_providers.*.env_key",
    "model_providers.*.env_key_instructions",
    "model_providers.*.experimental_bearer_token",
    "model_providers.*.gateway_oauth.authorization_url",
    "model_providers.*.gateway_oauth.client_id",
    "model_providers.*.gateway_oauth.delivery.kind",
    "model_providers.*.gateway_oauth.delivery.name",
    "model_providers.*.gateway_oauth.delivery.scheme",
    "model_providers.*.gateway_oauth.redirect_port",
    "model_providers.*.gateway_oauth.resource",
    "model_providers.*.gateway_oauth.scopes",
    "model_providers.*.gateway_oauth.token_url",
    "model_providers.*.http_headers.*",
    "model_providers.*.model_catalog_url",
    "model_providers.*.name",
    "model_providers.*.query_params.*",
    "model_providers.*.request_max_retries",
    "model_providers.*.requires_openai_auth",
    "model_providers.*.stream_idle_timeout_ms",
    "model_providers.*.stream_max_retries",
    "model_providers.*.supports_standalone_web_search",
    "model_providers.*.supports_websockets",
    "model_providers.*.websocket_connect_timeout_ms",
    "model_providers.*.wire_api",
    "sandbox_mode",
    "sandbox_workspace_write.exclude_slash_tmp",
    "sandbox_workspace_write.exclude_tmpdir_env_var",
    "sandbox_workspace_write.network_access",
    "sandbox_workspace_write.writable_roots",
];
/// Ticket 760 r2: `value` at `path` holds only key paths listed in `CODEX_USUAL_KEYS`; an empty table or list counts as
/// its key too, so even an empty unknown one withholds.
fn usual_keys(path: &[&str], value: &toml::Value) -> bool {
    let listed = |leaf: bool| {
        CODEX_USUAL_KEYS.iter().any(|known| {
            let n = known.split('.').count();
            (if leaf {
                n == path.len()
            } else {
                n > path.len()
            }) && known.split('.').zip(path).all(|(k, p)| k == "*" || k == *p)
        })
    };
    let deeper = |key: &str, value: &toml::Value| {
        let mut next = path.to_vec();
        next.push(key);
        usual_keys(&next, value)
    };
    match value {
        toml::Value::Table(table) => {
            listed(false) && table.iter().all(|(key, value)| deeper(key, value))
        }
        toml::Value::Array(items) => {
            listed(true)
                && items
                    .iter()
                    .all(|item| !item.is_table() || deeper("[]", item))
        }
        _ => listed(true),
    }
}
fn sub_keys(value: &toml::Value, known: &[&str]) -> bool {
    value
        .as_table()
        .is_some_and(|table| table.keys().all(|key| known.contains(&key.as_str())))
}
/// Ticket 690: Codex writes `config.toml` itself at the first folder trust (`[projects."<dir>"] trust_level`) and for
/// its screens (`[tui]`, `[notice]`), and keeps a `/model` choice there. A regular file of at most 1 MiB that holds only
/// those keys (and, under `[tui]` and `[notice]`, only the 0.161 keys) cannot add a hook, so it does not withhold
/// Nunchiro's; any other key (`hooks`, `plugins`, `profile`, `features` and every key a later Codex adds) still does.
/// Ticket 760: nor do the keys a person's own file usually holds, `mcp_servers`, `model_provider`, `model_providers`,
/// `approval_policy`, `sandbox_mode` and `sandbox_workspace_write`: in Codex 0.161 hooks come only from `hooks` (its
/// events and `hooks.state` trust), `hooks.json` and plugins, and none of these six fields' types (`McpServerConfig`,
/// `ModelProviderInfo`, `SandboxWorkspaceWrite`, two enums) holds a hook, so Codex reads no hook under them whatever
/// they hold. Ticket 760 r2: only with the key paths 0.161 defines under them (`CODEX_USUAL_KEYS`), so a hook field a
/// later Codex adds there cannot pass unread.
fn codex_written_config(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > 1 << 20 {
        return false;
    }
    let Some(table) = fs::read_to_string(path)
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
    else {
        return false;
    };
    table.iter().all(|(key, value)| match key.as_str() {
        "projects" => value.as_table().is_some_and(|projects| {
            projects.values().all(|project| {
                project.as_table().is_some_and(|keys| {
                    keys.iter()
                        .all(|(key, value)| key == "trust_level" && value.is_str())
                })
            })
        }),
        "tui" => sub_keys(value, &CODEX_TUI_KEYS),
        "notice" => sub_keys(value, &CODEX_NOTICE_KEYS),
        "model" | "model_reasoning_effort" => value.is_str(),
        "mcp_servers"
        | "model_provider"
        | "model_providers"
        | "approval_policy"
        | "sandbox_mode"
        | "sandbox_workspace_write" => usual_keys(&[key.as_str()], value),
        _ => false,
    })
}
/// v1b-07: Claude permission rules for the artifact folder; `//` marks an absolute path. Only `Edit(path)` rules
/// govern writes, the Write tool's too (Claude Code 2.1.318 warns "Write(path) ... is not matched by file permission
/// checks, only Edit(path) rules are" for a `Write(path)` rule, ticket 287), so no `Write` twin is written. Deny (checked before allow) covers every file Claude Code loads
/// configuration from inside an `--add-dir` folder (same doc, "Additional directories grant file access, not
/// configuration": `.claude/` skills, commands, agents and settings; `CLAUDE.md` and `CLAUDE.local.md`), at any depth
/// and in any letter case, since macOS folders are case-insensitive; otherwise an agent could write itself a skill whose
/// `allowed-tools` runs Bash unprompted. The plain lowercase twins hold if a Claude version drops bracket classes.
/// No allow rule when the folder already holds such a file. None when the path holds a character the rule syntax
/// could read as a pattern or a delimiter, so a rule never widens: the folder is still added and writes there ask.
fn folder_permissions(folder: &Path) -> Option<serde_json::Value> {
    let path = folder.to_str()?;
    if path
        .chars()
        .any(|c| "*?[]{}()\\!".contains(c) || c.is_control())
    {
        return None;
    }
    let rule = |p: &str| format!("Edit(/{path}/{p})");
    let deny: Vec<String> = [
        "**/.claude/**",
        "**/.[cC][lL][aA][uU][dD][eE]/**",
        "**/CLAUDE.md",
        "**/[cC][lL][aA][uU][dD][eE].[mM][dD]",
        "**/CLAUDE.local.md",
        "**/[cC][lL][aA][uU][dD][eE].[lL][oO][cC][aA][lL].[mM][dD]",
    ]
    .iter()
    .map(|p| rule(p))
    .collect();
    let planted = fs::read_dir(folder).ok()?.any(|e| {
        e.is_ok_and(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            [".claude", "claude.md", "claude.local.md"].contains(&name.as_str())
        })
    });
    Some(if planted {
        serde_json::json!({"deny": deny})
    } else {
        serde_json::json!({"allow": [rule("**")], "deny": deny})
    })
}
/// v25f (F7): `worktrees_dir` is an absolute path without `..`, or a relative one inside the project or one level up
/// beside it (`.worktrees`, `../.worktrees`): an optional leading `.` or `..`, then plain names. Anything else is refused
/// with the reason, so a typo never scatters worktrees somewhere odd.
fn check_worktrees_dir(d: &Path) -> Result<(), String> {
    use std::path::Component::{CurDir, Normal, ParentDir, RootDir};
    let text = d.to_string_lossy();
    if text.is_empty() || text.len() > 1024 || text.chars().any(char::is_control) {
        return Err("the worktree folder must be a path of at most 1024 characters".into());
    }
    if text.starts_with('~') {
        return Err(format!("{text}: write the full path instead of ~"));
    }
    let mut parts = d.components().peekable();
    if d.is_absolute() {
        return if parts.all(|c| matches!(c, RootDir | Normal(_))) {
            Ok(())
        } else {
            Err(format!(
                "{text}: an absolute worktree folder may not contain .."
            ))
        };
    }
    if matches!(parts.peek(), Some(CurDir | ParentDir)) {
        parts.next();
    }
    let rest: Vec<_> = parts.collect();
    if !rest.is_empty() && rest.iter().all(|c| matches!(c, Normal(_))) {
        Ok(())
    } else {
        Err(format!(
            "{text} leaves the repository's folder: a relative worktree folder is inside the repository or beside it, like ../.worktrees; use an absolute path for anywhere else"
        ))
    }
}
/// Ticket 1061 (security): `<root>/<repo>`, the folder a project's new worktrees go in, made (0700) and canonical. The
/// root may be a link (the owner's own choice; resolved here, and a token checks the result), but `<repo>` must be a
/// real folder: whoever can write the repository's parent could plant `.worktrees/<repo>` as a link to any folder,
/// the Nunchiro folder included.
fn worktree_parent(
    root: &Path,
    repo: &std::ffi::OsStr,
    base: Option<&Path>,
) -> Result<PathBuf, String> {
    let root = make_root(root, base)?;
    let parent = root.join(repo);
    let refused = || {
        format!(
            "worktree folder {} is a link or not a folder; Nunchiro does not follow links there{WORKTREES_DIR_HINT}",
            parent.display()
        )
    };
    if fs::symlink_metadata(&parent).is_ok_and(|m| !m.is_dir()) {
        return Err(refused());
    }
    store::private_dir(&parent).map_err(|e| {
        format!(
            "worktree folder {}: {e}{WORKTREES_DIR_HINT}",
            parent.display()
        )
    })?;
    if fs::canonicalize(&parent).ok().as_ref() != Some(&parent) {
        return Err(refused());
    }
    Ok(parent)
}
/// Ticket 1083: makes the worktrees root (0700) and returns it canonical. `base` is `<user home>/nunchiro` when the root is
/// the unset default: made 0755 (it may hold other things later) and refused when it is a link or not a folder, as
/// the 1061 checks refuse a planted `<repo>` link.
fn make_root(root: &Path, base: Option<&Path>) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let fail = |e: String| {
        format!(
            "worktree folder {}: {e}{WORKTREES_DIR_HINT}",
            root.display()
        )
    };
    if let Some(base) = base {
        match fs::symlink_metadata(base) {
            Ok(m) if !m.is_dir() => {
                return Err(fail(format!(
                    "{} is a link or not a folder; Nunchiro does not follow links there",
                    base.display()
                )));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o755)
                    .create(base)
                    .and_then(|()| fs::set_permissions(base, fs::Permissions::from_mode(0o755)))
                    .map_err(|e| fail(e.to_string()))?;
            }
            Err(e) => return Err(fail(e.to_string())),
        }
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)
        .and_then(|()| fs::canonicalize(root))
        .map_err(|e| fail(e.to_string()))
}
/// Ticket 1083: what the unset default was called from ticket 1061 until 1083 (beside the repository); its records keep working.
const PREVIOUS_DEFAULT_DIR: &str = "../.worktrees";
/// Ticket 1061: appended to a worktree folder error, so the line names the setting that moves the folder.
const WORKTREES_DIR_HINT: &str = "; set Settings > Git & Worktrees > Folder for new worktrees (worktrees_dir) to a folder you can write";
/// v25f: the root `project`'s worktrees go under: the setting, a relative one joined to the project (lexically: the
/// check above allows only one leading `..`). Ticket 1083: unset is `<user home>/nunchiro/worktrees`: visible, not a `.nunchiro*` name (peer.rs owner_home()
/// reads those as the data folder), and never inside the data folder (a debug core there refuses the window).
pub(crate) fn worktree_root_for(
    dir: Option<&Path>,
    project: &Path,
    user_home: &Path,
) -> Result<PathBuf, String> {
    let default = user_home.join("nunchiro/worktrees");
    if dir.is_none() && !user_home.is_absolute() {
        return Err(format!(
            "the user's home folder is not known{WORKTREES_DIR_HINT}"
        ));
    }
    let d = dir.unwrap_or(&default);
    check_worktrees_dir(d)?;
    if d.is_absolute() {
        return Ok(d.to_path_buf());
    }
    let mut parts = d.components();
    let base = match d.components().next() {
        Some(std::path::Component::ParentDir) => {
            parts.next();
            project
                .parent()
                .ok_or("the repository has no parent folder")
                .map_err(|e| format!("{e}{WORKTREES_DIR_HINT}"))?
        }
        Some(std::path::Component::CurDir) => {
            parts.next();
            project
        }
        _ => project,
    };
    Ok(base.join(parts.as_path()))
}
/// Ticket 250: the largest serialised feature value `quit_settings` stores.
const FEATURE_VALUE_MAX: usize = 4096;
/// V2.5-77: the most keys `features` holds; a file already past it loads whole and can only shrink or rewrite.
const FEATURE_KEYS_MAX: usize = 256;
/// Ticket 250: `^[a-z0-9]+(\.[a-z0-9_]+)+$`: a lowercase first part, then one or more `.part`s that may hold `_`.
fn feature_key(k: &str) -> bool {
    let mut parts = k.split('.');
    let first = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let ok = |p: &str, under: bool| {
        !p.is_empty()
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || (under && b == b'_'))
    };
    ok(first, false) && !rest.is_empty() && rest.iter().all(|p| ok(p, true))
}
// v1a-09 (v1a-23: shared): `settings.json` as it is now, a JSON object; missing reads as empty.
fn settings_file(path: &Path) -> Result<serde_json::Value, String> {
    match crate::store::read_settings(path) {
        Ok(b) => serde_json::from_slice::<serde_json::Value>(&b)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or_else(|| "invalid settings: expected a JSON object".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(e.to_string()),
    }
}
/// Ticket 276: the launch flags for the enabled extensions (core `features` `extensions.enabled`; absent = the shipped
/// skill alone, a custom folder stays off until switched on). Everything points into Nunchiro's own data folder:
/// nothing here writes the agents' home folders. Ticket 362's `agent_permission::claude_limits` is the one read of them,
/// of Claude's settings files only, read-only.
/// `locked` (ticket 1002, owner R2): a Home seat lock gets the shipped skill only: no custom plugin folder (its hooks
/// could rewrite a call after the lock hashed it) and no own MCP server.
fn extension_flags(
    home: &Path,
    settings: &Settings,
    kind: AgentKind,
    locked: bool,
) -> Result<Vec<std::ffi::OsString>, String> {
    let on = crate::extensions::enabled(settings.feature(crate::extensions::ENABLED_KEY));
    let default_on = crate::extensions::default_on(&on);
    let mut out: Vec<std::ffi::OsString> = vec![];
    match kind {
        AgentKind::Claude => {
            if default_on {
                out.push("--plugin-dir".into());
                out.push(skill::install(home, settings.orchestration.enabled)?.into_os_string());
            }
            if !locked {
                out.extend(crate::extensions::claude_flags(home, &on));
            }
        }
        AgentKind::Codex => {
            if default_on && settings.orchestration.enabled {
                out.push("-c".into());
                out.push(skill::CODEX_INSTRUCTION.into());
            }
            out.extend(crate::extensions::codex_flags(home));
        }
        AgentKind::Shell | AgentKind::Acp => {}
    }
    Ok(out)
}
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
type VersionProbe = std::sync::mpsc::Receiver<Result<String, String>>;
const VERSION_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
// The probe's own bound: a hung binary's process group is killed here and the session reads `unknown`.
const VERSION_CEILING: std::time::Duration = std::time::Duration::from_secs(60);
/// V1A-91: a program as given and the file it resolves to; probes of one key share one child.
type FlightKey = (String, Option<PathBuf>);
type Flights = BTreeMap<FlightKey, Vec<std::sync::mpsc::Sender<Result<String, String>>>>;
static VERSION_FLIGHTS: std::sync::Mutex<Flights> = std::sync::Mutex::new(BTreeMap::new());
fn flights() -> std::sync::MutexGuard<'static, Flights> {
    VERSION_FLIGHTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
/// Frees its flight's slot when the probe answers, fails, or its thread panics or never starts; a freed slot's
/// waiters get the answer, or a closed channel (which reads as "probe ended without an answer").
struct Flight(Option<FlightKey>);
impl Flight {
    fn finish(mut self) -> Vec<std::sync::mpsc::Sender<Result<String, String>>> {
        let key = self.0.take().unwrap();
        flights().remove(&key).unwrap_or_default()
    }
}
impl Drop for Flight {
    fn drop(&mut self) {
        if let Some(key) = self.0.take() {
            flights().remove(&key);
        }
    }
}
/// The program a Claude or Codex session runs: the approved path (ticket 358), else `name` on PATH. Ticket 32: unit tests point it at fake agents instead of
/// changing the process PATH, which other threads read.
fn agent_program(name: &'static str, approved: Option<&crate::approval::CommandProof>) -> String {
    if let Some(approved) = approved {
        return approved.path().to_string();
    }
    #[cfg(test)]
    if let Some((claude, codex)) = FAKE_AGENTS.get() {
        return if name == "claude" { claude } else { codex }.clone();
    }
    name.to_string()
}
/// The file `program` runs, found as `execvp` finds it on the core's PATH (which it never changes), through
/// symlinks; `None` when there is none (the spawn then fails on its own).
fn resolved(program: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    if program.contains('/') {
        return fs::canonicalize(program).ok();
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
        .and_then(|p| fs::canonicalize(p).ok())
}
/// Runs `agent_version` on its own thread; the answer, or the error naming the program, arrives on the receiver.
/// V1A-91: a call while a probe of the same program and file is in flight waits on that probe's answer instead.
// shortcut: a core that dies mid-probe leaves the probe child running until it exits on its own (its own process
// group, no ceiling left to kill it); record probe pids for the next core to kill if hung `--version` binaries show up.
fn version_probe(program: &str, ceiling: std::time::Duration) -> Result<VersionProbe, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let key = (program.to_string(), resolved(program));
    {
        let mut flights = flights();
        if let Some(waiting) = flights.get_mut(&key) {
            waiting.push(sender);
            return Ok(receiver);
        }
        flights.insert(key.clone(), vec![sender]);
    }
    // Moved into the thread; a spawn that fails drops it, which frees the slot.
    let flight = Flight(Some(key));
    let program = program.to_string();
    std::thread::Builder::new()
        .name("version-probe".into())
        .spawn(move || {
            let answer = agent_version(&program, ceiling);
            let answer = answer.map_err(|e| format!("{program} --version: {e}"));
            for sender in flight.finish() {
                let _ = sender.send(answer.clone());
            }
        })
        .map_err(|e| format!("version probe thread: {e}"))?;
    Ok(receiver)
}
fn agent_version(program: &str, ceiling: std::time::Duration) -> Result<String, String> {
    let mut command = crate::process::command(program);
    command.arg("--version");
    let output = match crate::process::output(command, ceiling) {
        // Ticket 424 round 2: a run killed before it printed stays "unknown", as any other failed run.
        Err(e) if e.ends_with(crate::process::KILLED_SILENT) => return Ok("unknown".into()),
        result => result?,
    };
    if !output.status.success() {
        return Ok("unknown".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
/// ticket 115: any key that resolves to a bare Esc byte (`esc`, `escape`, inside a longer send); arrows only start with one.
fn has_bare_esc(keys: &[String]) -> Result<bool, String> {
    for key in keys {
        if key_bytes(key)? == [27] {
            return Ok(true);
        }
    }
    Ok(false)
}
fn key_bytes(key: &str) -> Result<Vec<u8>, String> {
    Ok(match key.to_ascii_lowercase().as_str() {
        "enter" => b"\r".to_vec(),
        "esc" | "escape" => vec![27],
        "tab" => vec![9],
        "backspace" => vec![127],
        "up" => b"\x1b[A".to_vec(),
        "down" => b"\x1b[B".to_vec(),
        "right" => b"\x1b[C".to_vec(),
        "left" => b"\x1b[D".to_vec(),
        "ctrl+c" => vec![3],
        "ctrl+d" => vec![4],
        "ctrl+space" => vec![0],
        "shift+left" => b"\x1b[1;2D".to_vec(),
        "shift+right" => b"\x1b[1;2C".to_vec(),
        "shift+tab" => b"\x1b[Z".to_vec(), // CHAT-PERMCHIP: Claude's permission-mode cycle
        // Lane w102: a choice's number (docs/cli.md names `1`), so send-keys answers a start question send-text holds for.
        d @ ("0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9") => d.as_bytes().to_vec(),
        _ => return Err(format!("unsupported key: {key}")),
    })
}

/// CHAT-PERMCHIP: Shift+Tab cycles Claude's permission mode (it can reach bypass), so only the user's own click
/// presses it, and only into Claude; every other key keeps today's rule.
fn check_key(sender: &str, kind: AgentKind, key: &str) -> Result<(), String> {
    key_bytes(key)?;
    if key.eq_ignore_ascii_case("shift+tab") && (sender != "user" || kind != AgentKind::Claude) {
        return Err(format!("unsupported key: {key}"));
    }
    Ok(())
}

/// CHAT-PERMCHIP: the permission mode in the footer Claude draws under its input box ("⏸ manual mode on",
/// "⏵⏵ accept edits on (shift+tab to cycle)", ...), or `None` when there is no box (see `composer`: a dialog or
/// choice also gives none), no footer row names a mode, or the name is one this build does not know. Claude 2.1.310.
fn permission_mode(screen: &str, kind: AgentKind) -> Option<String> {
    if kind != AgentKind::Claude || composer(screen, kind).is_none() {
        return None;
    }
    let rows: Vec<&str> = screen.trim_end().lines().collect();
    let rule = rows
        .iter()
        .rposition(|r| !r.is_empty() && r.chars().all(|c| c == '─'))?;
    rows[rule + 1..].iter().find_map(|r| {
        let r = r.trim_start();
        let r = r.strip_prefix("⏵⏵ ").or_else(|| r.strip_prefix("⏸ "))?;
        let name = r.split(" on").next()?;
        [
            "manual",
            "accept edits",
            "plan",
            "auto",
            "bypass permissions",
        ]
        .into_iter()
        .find(|m| name == *m || name.strip_suffix(" mode") == Some(m))
        .map(String::from)
    })
}

/// A walk reached its target: it ends, its Skip confirm is kept, and a walk back from a failure says so.
fn finish_walk(entry: &mut Entry) {
    let Some(walk) = entry.walk.take() else {
        return;
    };
    entry.skip_chosen |= walk.chosen;
    entry.walk_error = walk.failure.map(|(target, why)| ModeWalk {
        target,
        error: Some(format!("{why}; back in {}", walk.target)),
    });
}
use crate::agent_permission::{ALLOW_SKIP, START_IN_SKIP};
/// Ticket 362: launch args that put Claude in Skip permissions or in reach of it. `--settings` counts: such a file can set
/// `permissions.defaultMode`.
fn reaches_skip(args: &[String]) -> bool {
    args.iter().enumerate().any(|(i, a)| {
        a.starts_with(ALLOW_SKIP)
            || a.starts_with(START_IN_SKIP)
            || a == "--settings"
            || a.starts_with("--settings=")
            || a == "--permission-mode=bypassPermissions"
            || a == "--permission-mode" && args.get(i + 1).is_some_and(|m| m == "bypassPermissions")
    })
}
/// Ticket 362: the Codex half of `reaches_skip`: launch args that turn off its approvals or its sandbox.
fn reaches_codex_bypass(args: &[String]) -> bool {
    let next = |i: usize| args.get(i + 1).map(String::as_str);
    args.iter().enumerate().any(|(i, a)| match a.as_str() {
        "--dangerously-bypass-approvals-and-sandbox"
        | "--yolo"
        | "--full-auto"
        | "--ask-for-approval=never"
        | "-a=never"
        | "-anever"
        | "--sandbox=danger-full-access"
        | "-s=danger-full-access"
        | "-sdanger-full-access" => true,
        "-a" | "--ask-for-approval" => next(i) == Some("never"),
        "-s" | "--sandbox" => next(i) == Some("danger-full-access"),
        // Q9 tt-J5-1: `-c approval_policy=never` and `-c sandbox_mode=danger-full-access` (also `--config`, `=` or
        // attached, a quoted key or value, a profile's key) set the same through Codex's config overrides.
        "-c" | "--config" => next(i).is_some_and(bypass_override),
        a => a
            .strip_prefix("--config=")
            .or_else(|| {
                a.strip_prefix("-c")
                    .map(|v| v.strip_prefix('=').unwrap_or(v))
            }) // `-c=k=v` as `-a=never`
            .is_some_and(bypass_override),
    })
}
/// One `-c key=value` override that turns off Codex's approvals or its sandbox. The value is read as Codex reads it: a
/// TOML value (escapes, an inline table such as `profiles={x={approval_policy="never"}}`), else the bare text.
fn bypass_override(kv: &str) -> bool {
    // The whole override as one TOML line decodes a quoted or escaped key (`"approval\u005fpolicy"="never"`) and dotted
    // keys; a bare value (`never`) does not parse as TOML and is read below.
    if kv
        .parse::<toml::Table>()
        .is_ok_and(|doc| doc.iter().any(|(k, v)| bypasses(k, v)))
    {
        return true;
    }
    let Some((key, value)) = kv.split_once('=') else {
        return false;
    };
    let value = value.trim();
    let value = format!("v = {value}")
        .parse::<toml::Table>()
        .ok()
        .and_then(|mut t| t.remove("v"))
        .unwrap_or_else(|| toml::Value::String(value.into()));
    let key = key.rsplit('.').next().unwrap_or_default();
    bypasses(key.trim().trim_matches(['"', '\'']), &value)
}
fn bypasses(key: &str, value: &toml::Value) -> bool {
    match value {
        toml::Value::String(v) => matches!(
            (key, v.as_str()),
            ("approval_policy", "never") | ("sandbox_mode", "danger-full-access")
        ),
        toml::Value::Table(table) => table.iter().any(|(k, v)| bypasses(k, v)),
        _ => false,
    }
}
/// CHAT-MODELIST: Claude puts `bypass permissions` into its Shift+Tab cycle only for a session launched with
/// `--allow-dangerously-skip-permissions` (or in it already, `--dangerously-skip-permissions`). `current` is the footer.
fn skip_state(entry: &Entry, current: Option<&str>, asks: bool) -> SkipPermissions {
    // A resumed or restored session has no launch args (`None`): its cycle may hold Skip permissions, so it is offered
    // and the walk finds out from the footer, one key at a time (it stops with a reason when the cycle has none).
    let lists = |args: &[String]| args.iter().any(|a| a == ALLOW_SKIP || a == START_IN_SKIP);
    let launched = entry.args.as_deref().is_none_or(lists) || lists(&entry.permission);
    if current == Some(BYPASS) {
        SkipPermissions::Available
    } else if entry.bypass_disabled {
        SkipPermissions::Disabled
    } else if launched {
        SkipPermissions::Available
    } else if asks {
        SkipPermissions::NeedsSetting
    } else {
        SkipPermissions::Unavailable
    }
}

/// Interrupted sends are never replayed: every queued or attempting send is logged as canceled.
fn cancel_queue(meta: &mut Session) {
    for mut send in meta.send_queue.drain(..) {
        send.status = "canceled".into();
        meta.send_log.push(send);
    }
}
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
/// The worktree store's bytes, None when there is none. Follow-ups 1112: judged and read on one handle
/// (`store::read_regular`: no link followed, a non-blocking open, at most 1 MiB). It used to check the path's metadata
/// and then open the path again, so a link or FIFO swapped in between was followed or waited on, under worktrees.lock.
fn read_worktree_store(file: &Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::ErrorKind;
    match crate::store::read_regular(file) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        // Not a regular file (a link, FIFO, device or folder), or over the cap.
        Err(e) if matches!(e.kind(), ErrorKind::InvalidInput | ErrorKind::InvalidData) => {
            Err("invalid worktree store".into())
        }
        Err(e) => Err(e.to_string()),
    }
}
/// Keeps the newest rows; callers that order by time sort first.
fn cap_log(log: &mut Vec<crate::delivery::Send>) {
    let excess = log.len().saturating_sub(crate::delivery::SEND_LOG_LIMIT);
    log.drain(..excess);
}

#[cfg(test)]
mod tests; // 2026-11-20: moved out for the 1 MiB publish scan

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorktreeStore {
    version: u32,
    worktrees: Vec<Worktree>,
}
const WORKTREE_BUSY: &str = "worktree operation in progress"; // v1a-21
/// A worktree's git calls (add, remove, ref reads) end after this.
const GIT_WORKTREE: std::time::Duration = std::time::Duration::from_secs(10);
const NOT_ON_SCREEN: &str = "decision is no longer on screen";
const SCREEN_REDRAWING: &str = "decision is redrawing after a resize; answer again"; // ticket 396
/// V2-8a: the listed worktrees (with facts), the opened one, and a remove's loss when it removed nothing for it.
pub(crate) type WorktreeRun = (Vec<Worktree>, Option<Worktree>, Option<WorktreeLoss>);
/// Ticket 991 A13: a new worktree's folder is named after it (its label, else its branch's last part), as a plain
/// folder name, so the shell prompt shows the name and not an id. A taken name gets "-2", "-3" and so on.
fn worktree_folder_name(
    label: &str,
    branch: &str,
    free: impl Fn(&str) -> bool,
) -> Result<String, String> {
    let plain = |source: &str| {
        let mut name = String::new();
        for c in source.chars() {
            let c = if c.is_alphanumeric() || c == '.' || c == '_' {
                c
            } else {
                '-'
            };
            if !(c == '-' && name.ends_with('-')) {
                name.push(c);
            }
        }
        let name: String = name
            .trim_start_matches(['.', '-'])
            .chars()
            .take(60)
            .collect();
        name.trim_end_matches(['-', '.']).to_string()
    };
    let name = [label, branch.rsplit('/').next().unwrap_or(branch)]
        .into_iter()
        .map(plain)
        .find(|n| !n.is_empty());
    let Some(name) = name else {
        return store::new_id();
    };
    if free(&name) {
        return Ok(name);
    }
    (2..100)
        .map(|n| format!("{name}-{n}"))
        .find(|n| free(n))
        .map_or_else(store::new_id, Ok)
}

pub(crate) struct WorktreePlan {
    home: PathBuf,
    root: PathBuf,
    operation: String,
    project: Option<PathBuf>,
    path: Option<PathBuf>,
    branch: Option<String>,
    base: String,
    label: String,
    creator: Option<String>,       // v1a-16
    token: bool, // ticket 1061: a token's create stays outside the Nunchiro folder
    team: Option<String>, // ticket 990: the lead whose team a created worktree joins
    from: Option<String>, // V2-8a
    confirm: Option<WorktreeLoss>, // V2-8a
    // v25f: the `worktrees_dir` setting (where a create puts a new folder) and the branch prefix the one-field create uses.
    dir: Option<PathBuf>,
    user_home: PathBuf, // ticket 1083: where an unset `dir` lies
    prefix: String,
    /// Ticket 991 (Q7 point 1): `Sessions::take_branch_titles`, applied under worktrees.lock before the operation.
    titles: Vec<(PathBuf, String)>,
}
impl WorktreePlan {
    pub(crate) fn name_branches(&mut self, titles: Vec<(PathBuf, String)>) {
        self.titles = titles;
    }
    /// V2-8a: an owner plan for the auto-clean pass (`list`, or `remove` without a confirm).
    pub(crate) fn owner(home: &Path, root: &Path, operation: &str, path: Option<PathBuf>) -> Self {
        Self {
            home: home.to_path_buf(),
            root: root.to_path_buf(),
            operation: operation.into(),
            project: None,
            path,
            branch: None,
            base: "HEAD".into(),
            label: String::new(),
            creator: None,
            token: false,
            team: None,
            from: None,
            confirm: None,
            dir: None,
            user_home: PathBuf::new(),
            prefix: String::new(),
            titles: vec![],
        }
    }
    /// V2-8a auto-clean: a confirm the core itself gives for merged commits on the kept branch (no uncommitted files).
    pub(crate) fn excuse(&mut self, loss: Option<WorktreeLoss>) {
        self.confirm = loss.filter(|l| l.uncommitted_total == 0 && l.ignored_total == 0);
    }
    /// Ticket 259: what `server::worktree` runs the setup and cleanup scripts around.
    pub(crate) fn operation(&self) -> &str {
        &self.operation
    }
    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
    pub(crate) fn confirm(&self) -> Option<&WorktreeLoss> {
        self.confirm.as_ref()
    }
    /// Ticket 990: on `team`, the lead (teammate id) the worktree is handed to; empty takes it back.
    pub(crate) fn label(&self) -> &str {
        &self.label
    }
    /// V2.5-61 B8: the project of a `branches` read, which runs off the store (`worktree_clean::branches`), never `run`.
    pub(crate) fn branches_project(&self) -> Option<&Path> {
        self.project
            .as_deref()
            .filter(|_| self.operation == "branches")
    }
    pub(crate) fn execute(self) -> Result<(Vec<Worktree>, Option<Worktree>), String> {
        match self.run_waiting(false)? {
            (_, _, Some(_)) => Err("worktree has unsaved work".into()),
            (worktrees, opened, None) => Ok((worktrees, opened)),
        }
    }
    /// The window's, the CLI's and the auto-clean's ops wait up to 2 s for another op's lock (a list refresh) instead of
    /// failing as busy; `execute` (under the registry lock) never waits.
    pub(crate) fn run(self) -> Result<WorktreeRun, String> {
        self.run_waiting(true)
    }
    fn run_waiting(mut self, wait: bool) -> Result<WorktreeRun, String> {
        use std::os::{
            fd::AsRawFd,
            unix::fs::{DirBuilderExt, OpenOptionsExt},
        };
        if !self.root.is_absolute() {
            return Err("worktrees_dir must be absolute".into());
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
            .map_err(|e| e.to_string())?;
        self.root = fs::canonicalize(&self.root).map_err(|e| e.to_string())?;
        let file = self.home.join("worktrees.json");
        // Ticket 394: a PR link's fetch and gh call, and the default base's fetch, wait on the network, so they run
        // before worktrees.lock: a slow server never holds every other worktree operation. Ticket 403 item 13: only
        // once the store reads as valid (it is read again under the lock).
        let mut early = match self.operation.as_str() {
            "create" | "restore" => {
                self.load(&file)?;
                Some(self.early()?)
            }
            _ => None,
        };
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.home.join("worktrees.lock"))
            .map_err(|e| e.to_string())?;
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            if !wait || std::time::Instant::now() >= until {
                return Err(WORKTREE_BUSY.into());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (mut disk, paths, stamped) = self.load(&file)?;
        self.apply_titles(&mut disk, &file);
        let allowed = |w: &Worktree| self.project.as_ref().is_none_or(|p| *p == w.project);
        let mut opened = None;
        let mut created_note: Option<(PathBuf, String)> = None; // ticket 374: (created folder, stale default branch)
        let mut shared_note: Option<(PathBuf, Vec<String>)> = None; // ticket 253: (created folder, what failed)
        match self.operation.as_str() {
            "list" => {}
            // v25f: before the root setting changes (quit_settings), records without one keep the old root on disk. A
            // list never writes; any other write carries the stamps too.
            "stamp" => {
                if stamped {
                    store::atomic_write(
                        &file,
                        &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                    )?;
                }
                return Ok((vec![], None, None)); // no facts: this runs under the registry lock
            }
            "create" | "restore" => {
                let project = self.project.as_ref().ok_or("create requires --project")?;
                let (pr, branch, label, early_base) =
                    early.take().ok_or("create requires --project")?;
                if branch.starts_with('-') {
                    return Err("invalid branch name".into());
                }
                Self::git(
                    project,
                    &["check-ref-format".into(), "--branch".into(), branch.clone()],
                )?;
                // Ticket 403 item 18: a PR link's branch (derived or an Advanced name), checked under the lock.
                if let Some((_, sha)) = &pr {
                    crate::worktree_clean::pr_stale(project, &branch, sha)?;
                }
                // V2-8a: a kept branch (Undo, or Create reusing it) is checked out as it is; else a new one from base.
                let exists = Self::branch_exists(project, &branch);
                let folder = project.file_name().ok_or("invalid project")?;
                let mut root = self.root_for(project)?;
                let restore = self.operation == "restore";
                if restore && !exists {
                    return Err(format!("branch {branch} no longer exists"));
                }
                let path = match &self.path {
                    // Restore: the folder it was removed from. Ticket 573: a create's `--path` (as Orca's `--name`).
                    // Either is one new plain name right under one of this project's roots, never a folder that is
                    // there or a recorded worktree.
                    Some(path) => {
                        let name = path.file_name().ok_or("invalid worktree path")?;
                        // A folder not made yet is not canonical; its parent is, or (a project's first worktree) the
                        // parent's parent. Neither there: no root matches.
                        let parent = path.parent().and_then(|p| {
                            fs::canonicalize(p).ok().or_else(|| {
                                Some(fs::canonicalize(p.parent()?).ok()?.join(p.file_name()?))
                            })
                        });
                        // Ticket 1061: a create's `--path` may use the old default root only while a record of
                        // this project lies under it (load() stamps older records with it, so test the root).
                        let legacy = fs::canonicalize(self.home.join("worktrees")).ok();
                        let legacy_used = disk.worktrees.iter().any(|w| {
                            w.project == *project
                                && legacy.is_some()
                                && w.root.as_ref().and_then(|r| fs::canonicalize(r).ok()) == legacy
                        });
                        root = self
                            .known_roots(project, &disk.worktrees)?
                            .into_iter()
                            .filter(|r| {
                                restore || legacy_used || *r == root || legacy.as_ref() != Some(r)
                            })
                            .find(|r| parent.as_deref() == Some(r.join(folder).as_path()))
                            .filter(|r| {
                                let path = r.join(folder).join(name);
                                matches!(
                                    path.components().next_back(),
                                    Some(std::path::Component::Normal(_))
                                ) && !name.to_string_lossy().starts_with('.')
                                    && fs::symlink_metadata(&path).is_err()
                                    && !paths.contains(&path)
                            })
                            .ok_or(if restore {
                                "restore path is not a removed worktree of this project"
                            } else {
                                "worktree path must be a new folder right under this project's worktree folder"
                            })?;
                        root.join(folder).join(name)
                    }
                    None if restore => return Err("restore requires --path".into()),
                    None => {
                        let parent = root.join(folder);
                        let free = |name: &str| {
                            let p = parent.join(name);
                            fs::symlink_metadata(&p).is_err() && !paths.contains(&p)
                        };
                        parent.join(worktree_folder_name(&label, &branch, free)?)
                    }
                };
                // Ticket 1061 (security): `path` is right under this real, canonical folder.
                let parent = worktree_parent(&root, folder, self.default_base().as_deref())?;
                if self.token {
                    tokens::outside_home(&self.home, &parent)?;
                }
                let mut add: Vec<String> = vec!["worktree".into(), "add".into()];
                let mut stale_base = None;
                if !exists {
                    // Ticket 374: the PR's commit; else the owner's empty base is origin's default branch (fetched
                    // first), and a typed one (HEAD included) is used as it is. A session token never fetches: its
                    // empty base is refused as before (security r2).
                    let base = match &pr {
                        Some((_, commit)) => commit.clone(),
                        None if self.base.is_empty() && self.creator.is_none() => {
                            // Fetched before the lock for a branch that did not exist then.
                            let (base, stale) = early_base.ok_or(
                                "the branch changed while the worktree was made; try again",
                            )?;
                            stale_base = stale;
                            base
                        }
                        None => self.base.clone(),
                    };
                    let base = Self::git(
                        project,
                        &[
                            "rev-parse".into(),
                            "--verify".into(),
                            "--end-of-options".into(),
                            format!("{base}^{{commit}}"),
                        ],
                    )?;
                    add.extend([
                        "-b".into(),
                        branch.clone(),
                        "--".into(),
                        path.to_string_lossy().into(),
                        base.trim().into(),
                    ]);
                } else {
                    add.extend(["--".into(), path.to_string_lossy().into(), branch.clone()]);
                }
                // Ticket 403 items 1-2: create, restore and a PR head check out through one helper: no hook, no
                // submodules, no filter but lfs, scrubbed environment, redacted error.
                let add: Vec<&str> = add.iter().map(String::as_str).collect();
                crate::process::git_worktree_add(project, &add, GIT_WORKTREE)?;
                // Ticket 253: a create (not a restore) gets the project's sparse preset and shared files.
                if !restore {
                    let failed =
                        crate::worktree_shared::apply(&self.home, project, &path, GIT_WORKTREE);
                    shared_note = Some((path.clone(), failed));
                }
                disk.worktrees.push(Worktree {
                    project: project.clone(),
                    path: path.clone(),
                    branch: branch.clone(),
                    label,
                    missing: false,
                    creator: self.creator.clone(), // v1a-16
                    team: self.team.clone(),       // ticket 990
                    facts: None,
                    root: Some(root),
                    stale_base: None,
                    shared_failed: vec![],
                    // Ticket 991 (Q7 point 1): a new branch under the name `from_text` made up, not one the user typed.
                    auto_branch: !exists
                        && self.branch.is_none()
                        && pr.is_none()
                        && self
                            .from
                            .as_deref()
                            .is_some_and(crate::worktree_clean::generated),
                });
                created_note = stale_base.map(|b| (path.clone(), b));
                if let Err(e) = store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                ) {
                    // Ticket 403 item 3: the status git runs first gets a read's protection, as in Remove.
                    let shown = path.to_string_lossy();
                    let remove = ["worktree", "remove", "--", &shown];
                    let _ =
                        crate::process::git_worktree_remove(project, &path, &remove, GIT_WORKTREE);
                    return Err(format!(
                        "worktree metadata failed: {e}; inspect {}",
                        path.display()
                    ));
                }
                crate::events::worktree("created", project, &path); // ticket 573
            }
            "rename" => {
                // V2-8a: the label only; no git call, the folder and branch stay.
                let path = self.path.as_ref().ok_or("requires --path")?;
                let w = disk
                    .worktrees
                    .iter_mut()
                    .find(|w| &w.path == path && allowed(w))
                    .ok_or("worktree not managed or outside grants")?;
                w.label = self.label.clone();
                store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                )?;
            }
            // V2-CF3: a folder `session start --worktree` made (detached, so it has no record) joins the managed list,
            // so the row's Rename and Remove reach it. The record only: git is read, never written.
            "adopt" => {
                let project = self.project.as_ref().ok_or("adopt requires --project")?;
                let path = self.path.as_ref().ok_or("requires --path")?;
                if !paths.contains(path) {
                    let listing = Self::git(
                        project,
                        &[
                            "worktree".into(),
                            "list".into(),
                            "--porcelain".into(),
                            "-z".into(),
                        ],
                    )?;
                    // `-z`: fields end in NUL and a record in one more, so a path (which cannot hold NUL) keeps its newlines.
                    let mut blocks = listing.split("\0\0").map(|b| {
                        let at = |key: &str| b.split('\0').find_map(|l| l.strip_prefix(key));
                        let folder = at("worktree ").and_then(|p| fs::canonicalize(p).ok());
                        let branch = at("branch refs/heads/").unwrap_or("").to_string();
                        (folder, branch)
                    });
                    // The first block is the main checkout: `project` must be it, and `path` another of its worktrees.
                    let root = self
                        .known_roots(project, &disk.worktrees)?
                        .into_iter()
                        .find(|r| path.starts_with(r));
                    let branch = (blocks
                        .next()
                        .is_some_and(|(f, _)| f.as_ref() == Some(project))
                        && Self::missing_path(path) == Ok(false)
                        && root.is_some()
                        && path != project)
                        .then(|| blocks.find(|(f, _)| f.as_ref() == Some(path)))
                        .flatten()
                        .map(|(_, branch)| branch)
                        .ok_or("not a worktree of this project")?;
                    disk.worktrees.push(Worktree {
                        project: project.clone(),
                        path: path.clone(),
                        branch,
                        label: String::new(),
                        missing: false,
                        creator: None,
                        team: None,
                        facts: None,
                        root,
                        stale_base: None,
                        shared_failed: vec![],
                        auto_branch: false,
                    });
                    store::atomic_write(
                        &file,
                        &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                    )?;
                }
            }
            "open" | "remove" | "forget" => {
                let path = self.path.as_ref().ok_or("requires --path")?;
                let index = disk
                    .worktrees
                    .iter()
                    // v1a-23: any caller opens or removes any managed worktree (the v1a-21 creator rule is gone).
                    .position(|w| &w.path == path && allowed(w))
                    .ok_or("worktree not managed or outside grants")?;
                let mut worktree = disk.worktrees[index].clone();
                // V2-8a: the window's clean-up of a gone folder: the record only, refused once the folder is back.
                if self.operation == "forget" && !worktree.missing {
                    return Err("the worktree folder is there again; nothing was removed".into());
                }
                if self.operation == "forget" {
                    disk.worktrees.remove(index);
                    crate::events::worktree("removed", &worktree.project, path); // ticket 573
                } else if self.operation == "remove" {
                    if !worktree.missing {
                        // V2-8a: unsaved work is removed only with a confirm naming exactly what is there now.
                        let loss = crate::worktree_clean::loss(path, &worktree.project)?;
                        let lossy = loss.uncommitted_total > 0
                            || loss.unpushed_total > 0
                            || loss.ignored_total > 0;
                        if lossy && self.confirm.as_ref() != Some(&loss) {
                            let listed = disk.worktrees.into_iter().filter(allowed).collect();
                            drop(lock);
                            return Ok((Self::with_facts(listed), None, Some(loss)));
                        }
                        let mut remove: Vec<String> = vec!["worktree".into(), "remove".into()];
                        if loss.uncommitted_total > 0 {
                            remove.push("--force".into()); // confirmed above: the files listed are discarded
                        }
                        // Ticket 253: the shared links go first, so a plain remove passes and git's own refusal
                        // (a submodule, a file written since `loss`) still guards the rest.
                        crate::worktree_shared::unlink(path, &worktree.project, &loss.linked);
                        remove.extend(["--".into(), path.to_string_lossy().into()]);
                        // Ticket 394 round 4: the status git runs inside the worktree first gets a read's protection.
                        let remove: Vec<&str> = remove.iter().map(String::as_str).collect();
                        let ten = std::time::Duration::from_secs(10);
                        crate::process::git_worktree_remove(&worktree.project, path, &remove, ten)?;
                    }
                    disk.worktrees.remove(index);
                    crate::events::worktree("removed", &worktree.project, path); // ticket 573
                } else {
                    if worktree.missing {
                        return Err("managed worktree is missing".into());
                    }
                    if !self.label.is_empty() {
                        worktree.label = self.label.clone();
                        disk.worktrees[index].label = self.label.clone();
                    }
                    opened = Some(worktree);
                }
                store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                )?;
            }
            // Ticket 990: the team mark only; no git call.
            "team" => {
                let path = self.path.as_ref().ok_or("requires --path")?;
                let worktree = disk
                    .worktrees
                    .iter_mut()
                    .find(|w| &w.path == path && allowed(w))
                    .ok_or("worktree not managed or outside grants")?;
                worktree.team = (!self.label.is_empty()).then(|| self.label.clone());
                store::atomic_write(
                    &file,
                    &serde_json::to_vec_pretty(&disk).map_err(|e| e.to_string())?,
                )?;
            }
            _ => return Err("invalid worktree operation".into()),
        }
        let listed = disk.worktrees.into_iter().filter(allowed).collect();
        // The counts run `git` per worktree: after the lock, so a create or remove is not refused as busy meanwhile.
        drop(lock);
        let mut listed = Self::with_facts(listed);
        if let Some((path, branch)) = created_note {
            listed
                .iter_mut()
                .filter(|w| w.path == path)
                .for_each(|w| w.stale_base = Some(branch.clone()));
        }
        if let Some((path, failed)) = shared_note
            && let Some(w) = listed.iter_mut().find(|w| w.path == path)
        {
            w.shared_failed = failed;
        }
        Ok((listed, opened, None))
    }
    /// The store on disk, checked: (store, its paths, whether a record got this run's legacy root).
    fn load(
        &self,
        file: &Path,
    ) -> Result<(WorktreeStore, std::collections::BTreeSet<PathBuf>, bool), String> {
        let mut disk = match read_worktree_store(file)? {
            None => WorktreeStore {
                version: 1,
                worktrees: vec![],
            },
            Some(bytes) => serde_json::from_slice::<WorktreeStore>(&bytes)
                .map_err(|e| format!("invalid worktree store: {e}"))?,
        };
        let mut paths = std::collections::BTreeSet::new();
        if disk.version != 1 || disk.worktrees.len() > 4096 {
            return Err("invalid worktree store relationship/version".into());
        }
        let mut stamped = false;
        for worktree in &mut disk.worktrees {
            // v25f: a record lies under the root it was made in; one from before gets this run's legacy root.
            if worktree.root.is_none() {
                worktree.root = Some(self.root.clone());
                stamped = true;
            }
            let root = worktree.root.as_deref().unwrap_or(&self.root);
            // Q9 ja-J5-1: a project folder that is gone (deleted, or its drive unmounted) marks the record missing, as
            // a gone worktree folder does, so one record does not fail the store for every project and Forget clears it.
            let project = fs::canonicalize(&worktree.project);
            let project_gone =
                matches!(&project, Err(e) if e.kind() == std::io::ErrorKind::NotFound);
            if !worktree.path.is_absolute()
                || !worktree.project.is_absolute()
                || worktree.label.len() > 256
                || !paths.insert(worktree.path.clone())
                || !root.is_absolute()
                || root
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
                || !worktree.path.starts_with(root)
                || worktree
                    .path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
                || (!project_gone && project.map_or(true, |p| p != worktree.project))
            {
                return Err("invalid worktree store relationship/version".into());
            }
            worktree.missing = Self::missing_path(&worktree.path)? || project_gone;
        }
        Ok((disk, paths, stamped))
    }
    /// V2-8a: counts for present folders; a count that cannot be read leaves that worktree without facts.
    fn with_facts(mut worktrees: Vec<Worktree>) -> Vec<Worktree> {
        for w in worktrees.iter_mut().filter(|w| !w.missing) {
            w.facts = crate::worktree_clean::facts(&w.path, &w.project).ok();
        }
        worktrees
    }
    /// A create's or restore's (PR, branch, label, default base), every network call included; no lock is held.
    #[allow(clippy::type_complexity)]
    fn early(
        &self,
    ) -> Result<
        (
            Option<(String, String)>,
            String,
            String,
            Option<(String, Option<String>)>,
        ),
        String,
    > {
        let project = self.project.as_ref().ok_or("create requires --project")?;
        // Ticket 374: a pasted PR link fetches the PR's code first (with an Advanced branch name too); a refusal
        // makes nothing. `pr` is (branch, commit).
        let pr = match &self.from {
            Some(from) if self.operation == "create" => {
                crate::worktree_clean::pull_request(project, from)?
            }
            _ => None,
        };
        // V2-8a: the window's one field (text, a GitHub URL, or empty) when no branch is given.
        let (branch, label) = match (&self.branch, &self.from, &pr) {
            (Some(branch), _, _) => (branch.clone(), self.label.clone()),
            (None, _, Some((branch, _))) => {
                let label = if self.label.is_empty() {
                    branch.clone()
                } else {
                    self.label.clone()
                };
                (branch.clone(), label)
            }
            (None, Some(from), None) if self.operation == "create" => {
                let (branch, label) = crate::worktree_clean::from_text(from, &self.prefix)?;
                let label = if self.label.is_empty() {
                    label
                } else {
                    self.label.clone()
                };
                (branch, label)
            }
            _ => return Err("create requires --branch".into()),
        };
        // The default base is fetched only for a branch that does not exist yet.
        let base = (self.operation == "create"
            && pr.is_none()
            && self.base.is_empty()
            && self.creator.is_none()
            && !branch.starts_with('-')
            && !Self::branch_exists(project, &branch))
        .then(|| crate::worktree_clean::default_base(project));
        Ok((pr, branch, label, base))
    }
    /// Ticket 991 (Q7 point 1, as Orca names a new worktree's branch from the first message): each title names the
    /// generated branch of the worktree its session runs in, once: the mark goes whatever the checks say, so a later
    /// prompt or session never renames (a title no name can be made of is not a naming and leaves the mark). A label that is still the generated name follows; the folder stays where it is.
    /// A store that cannot be written fails no request: git goes back to the old names and `disk` stays as read.
    fn apply_titles(&mut self, disk: &mut WorktreeStore, file: &Path) {
        let last = |branch: &str| branch.rsplit('/').next().unwrap_or(branch).to_string();
        let mut next = WorktreeStore {
            version: disk.version,
            worktrees: disk.worktrees.clone(),
        };
        let mut renamed = vec![];
        let mut changed = false;
        for (path, title) in std::mem::take(&mut self.titles) {
            let marked = |w: &&mut Worktree| w.path == path && w.auto_branch;
            let Some(w) = next.worktrees.iter_mut().find(marked) else {
                continue;
            };
            // A title with no letter or digit (emoji only) names nothing and uses nothing up: the next title may.
            let name = crate::worktree_clean::title_slug(&title);
            if name.is_empty() {
                continue;
            }
            w.auto_branch = false;
            changed = true;
            if let Some(new) = Self::named_branch(w, &name) {
                let old = std::mem::replace(&mut w.branch, new.clone());
                if w.label == last(&old) {
                    w.label = last(&new);
                }
                renamed.push((w.project.clone(), old, new));
            }
        }
        if !changed {
            return;
        }
        let saved = serde_json::to_vec_pretty(&next)
            .map_err(|e| e.to_string())
            .and_then(|bytes| store::atomic_write(file, &bytes));
        match saved {
            Ok(()) => *disk = next,
            Err(e) => {
                eprintln!("worktree branch names not saved: {e}");
                for (project, old, new) in &renamed {
                    let _ = Self::rename_branch(project, new, old);
                }
            }
        }
    }
    /// The branch `w`'s generated one was renamed to `name` (`worktree_clean::title_slug`), or none: one of these does
    /// not hold: the worktree's HEAD is that branch (so it still has the generated name), it has no upstream and no
    /// remote has a branch of its name (never pushed, as far as this repository knows: a push by URL leaves no trace
    /// to read), no other worktree has it checked out, and git takes the new name (`check-ref-format`). The prefix of
    /// the generated name is kept; a taken name gets "-2", "-3" and so on.
    fn named_branch(w: &Worktree, name: &str) -> Option<String> {
        let git = |dir: &Path, args: &[&str]| {
            let out = crate::process::git_read(dir, args, GIT_WORKTREE).ok()?;
            Some(String::from_utf8_lossy(&out).trim().to_string())
        };
        let head = ["refs/heads/", &w.branch].concat();
        if git(&w.path, &["symbolic-ref", "--quiet", "HEAD"])? != head {
            return None;
        }
        let upstream = git(&w.project, &["for-each-ref", "--format=%(upstream)", &head])?;
        let remotes = ["refs/remotes/*/", &w.branch].concat();
        let pushed = git(
            &w.project,
            &["for-each-ref", "--count=1", "--format=%(refname)", &remotes],
        )?;
        let listing = git(&w.project, &["worktree", "list", "--porcelain"])?;
        let checkouts = listing
            .lines()
            .filter(|l| l.strip_prefix("branch ") == Some(&head))
            .count();
        if !upstream.is_empty() || !pushed.is_empty() || checkouts != 1 {
            return None;
        }
        let prefix = w.branch.rsplit_once('/').map_or("", |(prefix, _)| prefix);
        let under = |name: String| match prefix {
            "" => name,
            prefix => format!("{prefix}/{name}"),
        };
        let new = std::iter::once(under(name.to_string()))
            .chain((2..100).map(|n| under(format!("{name}-{n}"))))
            .find(|new| !Self::branch_exists(&w.project, new))?;
        git(&w.project, &["check-ref-format", "--branch", &new])?;
        Self::rename_branch(&w.project, &w.branch, &new).ok()?;
        Some(new)
    }
    /// `git branch -m`: no hook runs (reference-transaction), and git moves the HEAD of the worktree that has it.
    fn rename_branch(project: &Path, from: &str, to: &str) -> Result<(), String> {
        let rename = ["branch", "-m", "--", from, to];
        let args = [&crate::auto_pull::NO_HOOKS[..], &rename].concat();
        crate::process::git_update(project, &args, GIT_WORKTREE).map(drop)
    }
    fn branch_exists(project: &Path, branch: &str) -> bool {
        Self::git(
            project,
            &[
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                "--end-of-options".into(),
                ["refs/heads/", branch].concat(),
            ],
        )
        .is_ok()
    }
    /// v25f: the setting's root for `project`, made (0700) and canonical, as create, restore and adopt record it.
    fn root_for(&self, project: &Path) -> Result<PathBuf, String> {
        let root = worktree_root_for(self.dir.as_deref(), project, &self.user_home)?;
        make_root(&root, self.default_base().as_deref())
    }
    fn default_base(&self) -> Option<PathBuf> {
        self.dir.is_none().then(|| self.user_home.join("nunchiro"))
    }
    /// v25f: where a worktree of `project` may already be, since the setting can move after a removal or a CLI-made
    /// worktree: the setting's root, the root of any stored record of the project, the unset default, the old
    /// default. Canonical, setting first.
    // shortcut: a custom root whose only record was removed is forgotten, so Undo there is refused; store past roots if
    // that shows up.
    fn known_roots(&self, project: &Path, stored: &[Worktree]) -> Result<Vec<PathBuf>, String> {
        let mut roots = vec![self.root_for(project)?];
        roots.extend(
            stored
                .iter()
                .filter(|w| w.project == project)
                .filter_map(|w| w.root.clone()),
        );
        // Ticket 1061: the unset default (beside the repository) stays known after the setting moves; ticket 1083: so does the
        // folder it was called until then.
        for d in [None, Some(Path::new(PREVIOUS_DEFAULT_DIR))] {
            roots.extend(
                worktree_root_for(d, project, &self.user_home)
                    .and_then(|r| fs::canonicalize(r).map_err(|e| e.to_string()))
                    .ok(),
            );
        }
        roots.extend(fs::canonicalize(self.home.join("worktrees")).ok());
        Ok(roots)
    }
    fn missing_path(path: &Path) -> Result<bool, String> {
        match fs::canonicalize(path) {
            Ok(canonical) if canonical == path => Ok(false),
            Ok(_) => Err("invalid aliased worktree path".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                for ancestor in path.ancestors() {
                    match fs::symlink_metadata(ancestor) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(e) => return Err(e.to_string()),
                        Ok(meta) => {
                            if meta.file_type().is_symlink()
                                || fs::canonicalize(ancestor).map_err(|e| e.to_string())?
                                    != ancestor
                            {
                                return Err("invalid aliased worktree path".into());
                            }
                            return Ok(true);
                        }
                    }
                }
                Err("invalid worktree path".into())
            }
            Err(e) => Err(e.to_string()),
        }
    }
    /// Ticket 403 item 5: the ref reads go through `git_read` (scrubbed environment, no configured program, the error
    /// without a URL user part).
    fn git(project: &Path, args: &[String]) -> Result<String, String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::process::git_read(project, &args, GIT_WORKTREE)
            .map(|o| String::from_utf8_lossy(&o).into())
            .map_err(|e| format!("git worktree: {e}"))
    }
}

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
