//! Persistent decision queue. Answers are transient and never replayed.
// State precedence and 20-minute heartbeat ported from Synara kanban.ts, commit 29b11e1.
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
// Copyright (c) 2026 Emanuele Di Pietro
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
use crate::{api::AgentKind, store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

pub mod journal;
pub mod risk; // V2-8e
mod session_scope; // ticket 1030
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Answer {
    AllowOnce,
    Deny,
    Choose {
        index: usize,
    },
    /// V2-8e: deny, with a one-line instruction for the agent (`deny_note`); empty text is a plain deny.
    DenyWith {
        text: String,
    },
    /// V2-8e: the agent's own session-only "don't ask again" option (`Decision::allow_always`); never one that persists.
    AllowAlways,
    /// Home look S2-7 (11-17): a question's free-text choice (Claude's "Type something.", `Choice::takes_text`) with the
    /// words to type there, one line (`deny_note`'s rules).
    ChooseWith {
        index: usize,
        text: String,
    },
}
/// V2-8e: the longest deny instruction, in characters.
pub const DENY_NOTE_MAX: usize = 500;
/// V2-8e: a deny instruction as one line: control and hidden characters (newlines, `board::rights::hidden`: line and
/// paragraph separators, zero-width, bidi and tag marks) become spaces, then it is trimmed and cut to `DENY_NOTE_MAX` characters.
pub fn deny_note(text: &str) -> String {
    let hidden = |c: char| c.is_control() || crate::board::rights::hidden(c);
    let line: String = text
        .chars()
        .map(|c| if hidden(c) { ' ' } else { c })
        .collect();
    line.trim()
        .chars()
        .take(DENY_NOTE_MAX)
        .collect::<String>()
        .trim_end()
        .to_string()
}

pub const DEFAULT_STALE_MS: u64 = 20 * 60 * 1000;
const MAX_STORE: u64 = 8 * 1024 * 1024;
pub(crate) const OWNER_ITEMS: usize = 64; // v1a-23
/// v1a-71: how long after a resize of its session a screen item waits for the agent's redraw (one redraw only).
pub const RESIZE_GRACE_MS: u64 = 1500;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "QueueKind"))]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Permission,
    Question,
    Dialog,
    Background,
    Stale,
    /// v1a-23: a human action a session asked for (widget approval, verified yes); answered by the owner only.
    Owner,
}
/// v1a-23: what an owner item asks the owner to do, with what the core saw when the session asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OwnerAsk {
    /// Approve a widget or integration source folder at the hash shown when it was asked.
    Approval {
        subject: crate::approval::SubjectKind,
        name: String,
        level: crate::approval::Level,
        hash: String,
    },
    /// Turn the verified-yes option (`permission_answers`) on for this canonical project.
    PermissionAnswers { project: PathBuf },
    /// Owner 2026-11-25: turn "Leads may use any of my accounts" on (`accounts::LEADS_ANY`), asked by a session.
    LeadAccounts,
    /// Ticket 259: approve the repo setup script of this new worktree at the hash read when it was made.
    Setup { path: PathBuf, hash: String },
    /// Needs 225: spend one Codex reset ticket of this account (`folder` `None` = "Your own"; `account` its label)
    /// for the asking session, which gave `reason` (cleaned and capped by `codex_reset`).
    CodexReset {
        folder: Option<PathBuf>,
        account: String,
        reason: String,
    },
    /// Ticket 990 slice h: a lead asks to merge a task whose review passed at `revision`. The card shows the task and
    /// the lessons its seats proposed (`learned`, at most two); the user keeps a lesson as a note with its own
    /// request (`note keep`) before the yes.
    Merge {
        task: String,
        title: String,
        place: PathBuf,
        revision: String,
        #[serde(default)]
        learned: Vec<crate::ledger::Lesson>,
    },
    /// Ticket 990 slice i: a lead proposes a new role for the user's roles, with its reason (`why`). `place` is where
    /// it was proposed, so the lead there hears the answer.
    Role {
        role: crate::roles::Role,
        why: String,
        place: PathBuf,
    },
    /// Home view change 4 (11-17): the Home lead asks to give a project's lead a goal. Nothing reaches the project
    /// until the user's yes: then the core writes it into that project's room and wakes its lead (`lead`, a teammate
    /// id). `from` is the Home lead's name.
    Goal {
        place: PathBuf,
        lead: String,
        from: String,
        text: String,
    },
    /// Ticket 1004: the core's own card for a task that stalled (`ledger::Stall`): two check-ins of its seats in a
    /// row found nothing moved, or three in a row the same `error`. `seat` is the name of the seat that checked in
    /// last (the item's `session_id` is its session); `error` its error, when it had one. A no dismisses it; the
    /// core takes it away when the task moves again or closes.
    Stall {
        task: String,
        title: String,
        place: PathBuf,
        seat: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Ticket 993: a lead proposes a schedule (`change` "add": `run` and `when` are what a yes adds) or a change to
    /// one (`change` "pause", "resume" or "remove" of entry `id`; `run` and `when` are that entry's, for the card).
    /// `line` is the card's one sentence ("Lister · Every day 9:00 PM · Light: sort the mail"). Nothing is stored in
    /// the schedules before the yes. `place` is where it was proposed, so the lead there hears the answer.
    /// Look 11-17 v8 (Home S2-B): `change` "failed" is the core's own card for entry `id` whose last run failed
    /// (`reason`, as the entry's `last.reason`; `place` is the entry's place): a yes runs it again now, a no dismisses
    /// the card. No session asked for it: the item's `session_id` is the entry's id.
    Schedule {
        change: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        run: crate::schedule::Run,
        when: crate::schedule::When,
        place: PathBuf,
        line: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Ticket 1002 lane 2: the Home lead stages one outward tool call (`nunchiro outbox stage`): `tool` is the exact
    /// tool name and `args` the exact arguments it will call with, every one of them shown on the card
    /// (`outbox::check`). `hash` is `approval::outward_call_hash(tool, args)`. A yes sets `yes_at`; 10 s later, not
    /// undone, the card leaves the owner list as approved to spend once (`Queue::outbox_spend`). The card's second
    /// button opens a new message or event from the same arguments instead. `source` is the lead's own word for what it
    /// answers; `new_domains` the recipient domains the user never said yes to; `from` the Home lead's name. Unanswered
    /// for 24 h, the card expires as No.
    Outward {
        tool: String,
        args: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        new_domains: Vec<String>,
        from: String,
        hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        yes_at: Option<u64>,
    },
    /// Ticket 1003: a card about one open loop (`loops::Row`). `change` "add": the Home lead (`from`) heard a promise
    /// or a waiting-for item, and a yes keeps `row` (nothing is stored before it). "close": the lead says `row` is done
    /// (`why`: the reply it found), and a yes closes it. "overdue" is the core's own card for a row whose due date
    /// passed, raised once per row: a yes closes it, a no keeps it open and dismisses the card.
    Loop {
        change: String,
        row: crate::loops::Row,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        from: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
    /// Ticket 1005: the core's own card for teammate `teammate`'s memory `file` (`MEMORY.md` or the shared `USER.md`),
    /// past the 6 KB its brief quotes when its seat started. A yes asks the seat (`name`) to tidy it; a no dismisses.
    /// `place` is the teammate's place (the Home folder for a Home teammate).
    Tidy {
        teammate: String,
        name: String,
        file: String,
        place: PathBuf,
    },
    /// Ticket 1113: an owner-only request to close one foreign session.
    SessionClose {
        #[serde(default)]
        from: String,
        target: String,
        label: String,
        place: PathBuf,
        why: String,
    },
    /// Ticket 1099 panel 4: a place's lead asks to change its live seats (`Place.cap`) from `was` to `cap`, for its
    /// reason `why` (`nunchiro task ask-cap`). Nothing changes before the yes, which sets the cap as Settings does.
    Cap {
        place: PathBuf,
        was: u32,
        cap: u32,
        why: String,
    },
    /// A bot (`from`) offers a new bot for work it saw come back (`why`). Nothing is made before the yes, which makes
    /// the bot in the offering bot's `place` (`team::Team::make`).
    Bot {
        name: String,
        job: String,
        why: String,
        from: String,
        place: PathBuf,
    },
}
/// Ticket 1002 lane 2: every `OwnerAsk` tag this core reads. A stored owner item of another tag (a newer core's kind)
/// is left out at load, so a downgrade keeps the rest of the store.
const OWNER_KINDS: &[&str] = &[
    "approval",
    "permission_answers",
    "setup",
    "codex_reset",
    "merge",
    "role",
    "goal",
    "schedule",
    "outward",
    // Ticket 1004 (fable/w31-stall) adds `OwnerAsk::Stall`; listed early so whichever lands second shows stall cards.
    // Until that variant is here, a store holding a stall card fails to load (only a 1004 core writes one).
    "stall",
    "loop",          // ticket 1003
    "tidy",          // ticket 1005
    "session_close", // ticket 1113
    "cap",           // ticket 1099
    "bot",
];
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Choice {
    pub label: String,
    pub keys: Vec<String>,
    pub changes_settings: bool,
}
// v1b-12: the one allow-once rule (the window's `cardPlan` mirrors it; both are tested against
// tests/fixtures/allow-once-labels.json).
impl Choice {
    /// Home look S2-7: Claude's question dialog's free-text row; picking it opens a text field in the dialog.
    pub fn takes_text(&self) -> bool {
        let label = self.label.trim().trim_end_matches('.').to_lowercase();
        // Look 1117 v10 N10-S2-5: the plan approval's feedback row is a text field too.
        label == "type something" || label == "tell claude what to change"
    }
    /// A choice that allows once: it changes no settings and says "yes…" or "…this time".
    pub fn allows_once(&self) -> bool {
        let label = self.label.to_lowercase();
        !self.changes_settings && (label.starts_with("yes") || label.contains("this time"))
    }
    /// V2-8e: a "don't ask again" option the agent keeps for this session only ("…during this session"), so nothing is
    /// written to its settings (acceptance card: the user's agent config stays unchanged). A label that says nothing
    /// about the session, or mentions trust, is not one.
    pub fn session_only(&self) -> bool {
        let label = self.label.to_lowercase();
        label.starts_with("yes")
            && (label.contains("during this session") || label.contains("for this session"))
            && !label.contains("trust")
    }
    /// Ticket 1030: Claude's option 2, the "Yes, and …" that keeps allowing (not a mode switch, never a trust).
    pub fn option_two(&self) -> bool {
        let label = self.label.to_lowercase();
        self.keys.first().is_some_and(|k| k == "2")
            && label.starts_with("yes")
            && !label.contains("mode")
            && !label.contains("trust")
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "QueueDecision"))]
pub struct Decision {
    pub id: String,
    pub session_id: String,
    pub scope: String,
    pub kind: Kind,
    pub text: String,
    pub choices: Vec<Choice>,
    pub sources: BTreeSet<String>,
    /// When this item (this id) was first seen. Seeing the same prompt again keeps it, so the window's oldest-first
    /// order and "asked N ago" do not move when a resize redraws a prompt; a new id takes the new time.
    pub observed_at: u64,
    pub actionable: bool,
    pub reconciled: bool,
    pub hook_event_id: Option<String>,
    #[serde(default)]
    pub screen_text: Option<String>,
    // v1a-23: set on kind `owner` items only, which live in the owner list, not a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<OwnerAsk>,
    // V2-8e: set on the snapshot's copy only (`Queue::annotate`), never on stored items, so the queue file is unchanged.
    // `risky` is serialized only when false: a missing field means risky (fail-closed on both sides).
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    pub risky: bool,
    /// The deny may carry an instruction for the agent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deny_note: bool,
    /// The label of the agent's session-only "don't ask again" option, when the prompt offers one and it is not risky.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_always: Option<String>,
    /// Ticket 1030: what "Allow for this session" adds through the hook ("touch:*", a folder), for the card to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_scope: Option<String>,
    /// Look v31 a S2-1: the hook's tool name, when it is an MCP tool (`mcp__<server>__<tool>`): the card names the
    /// server and the tool. A built-in's request already says what it is ("Edit app.py").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Ticket 1130 S1: the kind of an outward call (`outward::Kind::name`: mail, calendar, post, publish), set on the
    /// snapshot's copy only; the card names it ("Send mail").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outward: Option<String>,
}
fn yes() -> bool {
    true
}
fn is_yes(b: &bool) -> bool {
    *b
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Attention {
    #[serde(default)]
    pub observer_error: Option<String>,
    pub completion_seq: u64,
    #[serde(default)]
    pub skipped_transcript_lines: u64,
    pub working: bool,
    pub waiting: bool,
    pub stale: bool,
    pub failed: bool,
    pub last_activity: u64,
    pub background: u64,
    /// Q7 item 12: when the current turn began (ms); the tree row shows how long it has been working. Left out while 0,
    /// so a session that never worked keeps the legacy wire byte for byte (tests/board_transport.rs).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub working_since: u64,
    /// Look 1117 v12 B N11-S2-3: the turn works, but it blocks in `agent ask --wait` on its open ask
    /// (`Sessions::asks_waiting`). Set per snapshot, never stored; left out while false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub asking: bool,
    /// v19-Q9-cx: the agent does not read its terminal: the last write was refused (`Pty::input_blocked`). Set per
    /// snapshot, never stored; left out while false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub input_blocked: bool,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    last_event_at: u64,
    #[serde(default)]
    tasks: BTreeSet<String>,
    kind: AgentKind,
    attention: Attention,
    items: Vec<Decision>,
    #[serde(default)]
    transcript_key: String,
    #[serde(default)]
    transcript_offset: u64,
    #[serde(default)]
    transcript_discarding: bool,
    #[serde(default)]
    turn: Option<String>,
    #[serde(default)]
    finished: BTreeSet<String>,
    #[serde(default)]
    stop_pending: bool,
    /// Ticket 1094: when the Stop that `stop_pending` holds arrived (core clock, ms); `tick` settles it after
    /// `HELD_STOP_MS`, so a background task's end that never reaches the core cannot hold the session for ever.
    #[serde(default, skip_serializing_if = "is_zero")]
    stop_at: u64,
    /// Ticket 991: when the session was registered (ms): the snapshot lists sessions in this order, so sessions a
    /// window first sees together open their tabs in the order they were started. 0 on a store from before this.
    #[serde(default)]
    registered: u64,
    /// W35 look v23 S2-1: the turn working now is a local slash command (`/effort ...`): Claude answers it on its screen
    /// and in its transcript (`<local-command-stdout>`) with no model turn and no Stop, which then ends it.
    #[serde(default)]
    local_command: bool,
}
/// A setup ask whose worktree is gone: only a gone folder whose parent is there counts, so a worktree on an unmounted
/// volume keeps its ask; a lookup that fails (permission, I/O) proves nothing either.
fn gone_setup(i: &Decision) -> bool {
    let Some(OwnerAsk::Setup { path, .. }) = &i.owner else {
        return false;
    };
    let gone = matches!(path.try_exists(), Ok(false))
        && path
            .parent()
            .is_some_and(|p| matches!(p.try_exists(), Ok(true)));
    if gone {
        eprintln!(
            "queue: setup ask {} dropped: worktree {} is gone",
            i.id,
            path.display()
        );
    }
    gone
}
/// Ticket 1133: `Disk` equality without `seen`. Destructured so a new field must be named here.
fn same_except_seen(a: &Disk, b: &Disk) -> bool {
    let Disk {
        version,
        sessions,
        seen: _,
        owner,
        outbox_domains,
    } = a;
    *version == b.version
        && *sessions == b.sessions
        && *owner == b.owner
        && *outbox_domains == b.outbox_domains
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Disk {
    version: u32,
    sessions: BTreeMap<String, State>,
    seen: BTreeMap<String, u64>,
    // v1a-23: owner items outlive sessions, the window and core restarts; omitted when empty (old bytes unchanged).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    owner: Vec<Decision>,
    /// Ticket 1002 lane 2: the recipient domains the user said yes to on Outbox cards, oldest first (at most
    /// `outbox::DOMAINS_MAX`); a card to any other domain says "New recipient".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    outbox_domains: Vec<String>,
}
/// Ticket 1002 lane 2: an approved Outbox card, in this core's memory only: its exact call (`tool`, `hash`), the
/// session that staged it (the only one that may spend it), until when, and the recipient domains a spend keeps.
#[derive(Debug, Clone, PartialEq)]
pub struct Approved {
    pub id: String,
    pub tool: String,
    pub hash: String,
    pub session: String,
    pub until: u64,
    pub domains: Vec<String>,
    /// Ticket 1003: a mail's recipients and subject, for the waiting-for row its spend makes.
    pub mail: Option<(String, String)>,
}
struct Evidence<'a> {
    source: &'a str,
    at: u64,
    hook: Option<String>,
}
/// Look 11-17 N18: the hook's message for a deny with no instruction (the window's chat reads "The user denied this").
pub const DENY_PLAIN: &str = "The user denied this. Do not retry it.";
pub struct Queue {
    home: PathBuf,
    disk: Disk,
    activity: BTreeMap<String, u64>,
    pub(crate) client_until: u64,
    pub(crate) hook_until: BTreeMap<String, u64>,
    /// Ticket 991 B3: the events whose hook has a long waiter (`hold_hook`).
    long: BTreeSet<String>,
    pub(crate) responses: BTreeMap<String, Value>,
    // v1b-30: hook permission items that replaced another still-pending hook permission of their scope (memory only:
    // a restart resets every item anyway).
    stacked: BTreeSet<String>,
    // v1b-32 r2: the tool of each hook item (memory only, like `stacked`): the tool, not its input fields, decides
    // which question its prompt asks.
    tools: BTreeMap<String, String>,
    /// One request, one card: until when a Claude session's permission frame waits for its held PermissionRequest
    /// hook, set by the PreToolUse hook before it (memory only). Claude draws its dialog before that hook runs.
    hook_expected: BTreeMap<String, u64>,
    /// When the wait first hid a permission frame of the session: the wait ends `HOOK_EXPECTED_MS` after it, however
    /// many PreToolUse hooks (a subagent's, a sibling call's) come meanwhile. Cleared once a card or hook item shows
    /// or the screen clears.
    hook_hidden: BTreeMap<String, u64>,
    // Ticket 1030 (look v33 R1): a hook item's tool, its input and Claude's own `permission_suggestions`, from which
    // "Allow for this session" forwards only those no broader than the request (`session_scope`; memory only).
    session_rules: BTreeMap<String, (String, Value, Vec<Value>)>,
    // v1a-71: when each session's terminal was last resized, and whether a frame without a prompt came in its grace
    // (memory only, like `stacked`).
    resized: BTreeMap<String, (u64, bool)>,
    // v1a-77: ids of screen items whose one grace is spent (memory only, pruned to the ids that still exist).
    graced: BTreeSet<String>,
    /// Ticket 1002 lane 2 (check M7f): the user's yes on an Outbox card (card id, when) and the approved cards. Memory
    /// only, never on disk: nothing written to the store can approve or spend a card, and a restart drops both.
    outbox_yes: BTreeMap<String, u64>,
    outbox_approved: Vec<Approved>,
    /// Round 2: owner items of a kind this core does not know (a newer core's), shown nowhere and written back as read.
    foreign_owner: Vec<Value>,
}
/// v1b-40 r2: the integer `version` of an over-cap queue file, streamed without keeping the rest; `None` unless the
/// file is one JSON object (as the in-cap path requires).
fn over_cap_version(file: &fs::File) -> Option<u64> {
    use std::io::{BufRead, Read};
    #[derive(Deserialize)]
    struct Head {
        version: u64,
    }
    let mut reader = std::io::BufReader::new(file);
    loop {
        let first = *reader.fill_buf().ok()?.first()?;
        if !first.is_ascii_whitespace() {
            if first != b'{' {
                return None;
            }
            break;
        }
        reader.consume(1);
    }
    serde_json::from_reader::<_, Head>(reader.by_ref())
        .ok()
        .map(|h| h.version)
}
/// Look 1117 v10 N10-S2-5: Claude's plan approval (`ExitPlanMode`) is its own dialog ("Ready to code?") whose options are
/// typed like a question's; a hook allow does not end it (Claude still asked after the card's Allow).
const QUESTION_TOOLS: [&str; 4] = [
    "AskUserQuestion",
    "request_user_input",
    "request_user_input_async",
    "ExitPlanMode",
];
/// Ticket 691: Codex 0.161's `request_user_input_async` returns `{"accepted":true}` at once and the answer comes later as
/// a user message, maybe mid-turn. Its question gets a scope of its own (per call id), so neither the tool result nor
/// the turn's end drops it; a prompt or a Codex user message (`Answered`) does, and so does a transcript tool result
/// that says the call was not accepted (`open: false`, a hook deny such as the room's redirect to a lead).
const ASYNC_SCOPE: &str = "async-question";
fn async_scope(call: &Value) -> String {
    // An id past the queue's scope limit would fail the whole batch, so it shares the plain scope.
    match call.as_str().filter(|call| call.len() <= 128) {
        Some(call) => format!("{ASYNC_SCOPE}:{call}"),
        None => ASYNC_SCOPE.into(),
    }
}
/// Look 11-17 N20: an async question is answered by a user message, never on a screen, so its card's choices come from
/// its tool input (`options` are plain strings, or `{label}` as Claude's).
fn async_choices(p: &Value) -> Vec<Choice> {
    if p["tool_name"] != "request_user_input_async" {
        return vec![];
    }
    p["tool_input"]["questions"][0]["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["label"].as_str().or(o.as_str()))
        .filter(|l| !l.trim().is_empty())
        .take(9)
        .map(|label| Choice {
            label: label.into(),
            keys: vec![],
            changes_settings: false,
        })
        .collect()
}
/// Whether `item` is Claude's plan approval (`ExitPlanMode`): its hook text carries the plan, its screen text is the
/// "Ready to code?" dialog. It is a question card for the owner, but approving it starts work, so an agent's answer is
/// held to a permission's rule (`grants::check_answer`; Codex look of wave 17, MUST).
pub fn is_plan(item: &Decision) -> bool {
    item.kind == Kind::Question
        && (serde_json::from_str::<Value>(&item.text).is_ok_and(|v| v["plan"].is_string())
            || crate::waiting::screen::plan_dialog(
                &item
                    .text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase(),
            ))
}
/// Whether `item` is an async question (answered by a user message).
pub fn answered_by_message(item: &Decision) -> bool {
    item.kind == Kind::Question && item.scope.starts_with(ASYNC_SCOPE)
}
fn question_scope<'a>(p: &Value, scope: &'a str) -> std::borrow::Cow<'a, str> {
    if p["tool_name"] == "request_user_input_async" {
        async_scope(&p["tool_use_id"]).into()
    } else {
        scope.into()
    }
}
/// V2.5-41 (audit B14): hooks are stamped at hook-process start and race each other to the core. A kind that
/// changes no turn or item state in `apply` neither moves the per-session hook clock nor is dropped by it; every
/// other kind (a new arm too) keeps the order, so a stale Stop can never finish a newer turn.
fn carries_no_turn_state(event: &str, p: &Value) -> bool {
    match event {
        // A kind listed here that gains turn or item handling in `apply` must leave this list (B14 review).
        "SessionStart" | "Notification" | "SubagentStart" | "SessionEnd" => true,
        "PreToolUse" => !QUESTION_TOOLS.contains(&p["tool_name"].as_str().unwrap_or("")),
        _ => false,
    }
}
/// The most replayed hook ids `queue.json` keeps (`validate`); `replay` drops the oldest quarter when full.
const SEEN_MAX: usize = 32768;
/// Ticket 1094: how long a Stop held for background work waits before `tick` ends its turn (ms).
pub const HELD_STOP_MS: u64 = 60_000;
/// Ticket 1094: a journaled prompt this old (ms) is not replayed as a turn start.
const REPLAY_PROMPT_STALE_MS: u64 = 5 * 60_000;
/// The most session states `queue.json` keeps (`validate`).
const MAX_SESSIONS: usize = 4096;
impl Queue {
    pub fn open(home: &Path) -> Result<Self, String> {
        Self::open_owned(home, |_| true)
    }
    /// Ticket 750: `open`, but a file over MAX_SESSIONS first loses the states `owned` refuses (sessions with no row),
    /// so a store an older core filled still opens. Under the limit nothing is dropped here: a journal event replayed
    /// at `Sessions::open` still finds its state, and `Sessions::open` drops the rowless ones after the replay.
    pub fn open_owned(home: &Path, owned: impl Fn(&str) -> bool) -> Result<Self, String> {
        store::private_dir(home)?;
        let path = home.join("queue.json");
        let empty = || Disk {
            version: store::VERSION as u32,
            sessions: BTreeMap::new(),
            seen: BTreeMap::new(),
            owner: vec![],
            outbox_domains: vec![],
        };
        // v1b-40 r2: one handle, never through a link, so the bytes judged and the metadata a set-aside checks are the
        // same file's (O_NONBLOCK: a FIFO in its place cannot hang the start).
        let file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
                return Err("invalid queue file".into());
            }
            Err(e) => return Err(e.to_string()),
            Ok(file) => Some(file),
        };
        // Round 2 (Codex note): a newer core's owner cards, kept untouched and written back on every save.
        let mut foreign_owner: Vec<Value> = vec![];
        let disk = match file {
            None => empty(),
            Some(mut file) => {
                let meta = file.metadata().map_err(|e| e.to_string())?;
                if !meta.is_file() {
                    return Err("invalid queue file".into());
                }
                // v1b-40 r2: of an over-cap file only `version` is kept; it is parsed streamed, so a newer core's
                // larger queue is set aside too.
                if meta.len() > MAX_STORE {
                    match over_cap_version(&file) {
                        Some(version) if !(1..=store::VERSION).contains(&version) => {
                            store::set_aside(&path, &meta, version)?;
                            empty()
                        }
                        _ => return Err("invalid queue file".into()),
                    }
                } else {
                    // A file that grew since `metadata` is read only to the cap, then refused as over it.
                    let mut bytes = vec![];
                    (&mut file)
                        .take(MAX_STORE + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                    if bytes.len() as u64 > MAX_STORE {
                        return Err("invalid queue file".into());
                    }
                    let mut value: Value = serde_json::from_slice(&bytes)
                        .map_err(|e| format!("invalid queue: {e}"))?;
                    // Ticket 1002 lane 2: a newer core's owner kind is set aside, not a reason to refuse the store; round 2:
                    // it is kept as it is and written back, never lost at the next save.
                    if let Some(owner) = value.get_mut("owner").and_then(Value::as_array_mut) {
                        owner.retain(|i| {
                            let known = i["owner"]["type"]
                                .as_str()
                                .is_none_or(|t| OWNER_KINDS.contains(&t));
                            if !known {
                                foreign_owner.push(i.clone());
                            }
                            known
                        });
                    }
                    if !value.is_object() {
                        return Err("invalid queue: expected an object".into());
                    }
                    // v1b-40: another version's items are kept on disk only; none is loaded, so none is answerable.
                    match store::other_version(&value) {
                        Some(version) => {
                            store::set_aside(&path, &meta, version)?;
                            empty()
                        }
                        None => {
                            let mut disk: Disk = serde_json::from_value(value)
                                .map_err(|e| format!("invalid queue: {e}"))?;
                            if disk.sessions.len() > MAX_SESSIONS {
                                disk.sessions.retain(|id, _| owned(id));
                            }
                            Self::validate(&disk)?;
                            // Ticket 1002 lane 2: a yes is never read from the store.
                            for i in &mut disk.owner {
                                if let Some(OwnerAsk::Outward { yes_at, .. }) = &mut i.owner {
                                    *yes_at = None;
                                }
                            }
                            // V2-1a: version 2 adds nothing the queue keeps; a v1 file is copied once, then
                            // written as 2.
                            if disk.version == 1 {
                                store::keep_v1(&path, &bytes)?;
                                disk.version = store::VERSION as u32;
                            }
                            disk
                        }
                    }
                }
            }
        };
        let mut queue = Self {
            home: home.into(),
            disk,
            activity: BTreeMap::new(),
            client_until: 0,
            hook_until: BTreeMap::new(),
            long: BTreeSet::new(),
            responses: BTreeMap::new(),
            stacked: BTreeSet::new(),
            tools: BTreeMap::new(),
            hook_expected: BTreeMap::new(),
            hook_hidden: BTreeMap::new(),
            session_rules: BTreeMap::new(),
            resized: BTreeMap::new(),
            graced: BTreeSet::new(),
            outbox_yes: BTreeMap::new(),
            outbox_approved: vec![],
            foreign_owner,
        };
        // Old evidence remains visible but cannot authorize input to a new process.
        for state in queue.disk.sessions.values_mut() {
            for item in &mut state.items {
                item.actionable = false;
                item.reconciled = true;
                item.hook_event_id = None;
            }
        }
        // Ticket 1109: a setup ask for a worktree removed while it waited opened the start-up sheet at every start.
        queue.disk.owner.retain(|i| !gone_setup(i));
        Ok(queue)
    }
    /// The same drop while the core runs (its auto-clean task calls this every 30 s): a worktree removed by the
    /// auto-clean, `git worktree remove` or `rm` takes its ask with it. A sweep that drops nothing writes nothing.
    pub fn drop_gone_setups(&mut self) -> Result<(), String> {
        self.answer_owner(gone_setup)
    }
    fn validate(disk: &Disk) -> Result<(), String> {
        // `version` is 1 or 2 here: `open` sets any other integer aside and the typed parse refuses the rest.
        if disk.sessions.len() > MAX_SESSIONS || disk.seen.len() > SEEN_MAX {
            return Err("queue limit exceeded".into());
        }
        let mut ids = BTreeSet::new();
        for (id, state) in &disk.sessions {
            if !store::valid_id(id) || state.items.len() > 64 {
                return Err("invalid queue session".into());
            }
            for item in &state.items {
                if item.session_id != *id
                    || !store::valid_id(&item.id)
                    || !ids.insert(&item.id)
                    || item.text.len() > 65536
                    || item.choices.len() > 100
                    || item.scope.len() > 256
                    || item.sources.is_empty()
                    || item.sources.iter().any(|s| {
                        !["hook", "screen", "transcript", "clock", "acp"].contains(&s.as_str())
                    })
                    || item.observed_at > state.attention.last_activity && item.kind != Kind::Stale
                    || item
                        .choices
                        .iter()
                        .any(|c| c.label.len() > 4096 || c.keys.len() > 32)
                {
                    return Err("invalid queue relationship".into());
                }
            }
        }
        if disk.seen.keys().any(|id| !store::valid_id(id)) {
            return Err("invalid event identity".into());
        }
        if disk.outbox_domains.len() > crate::outbox::DOMAINS_MAX
            || disk.outbox_domains.iter().any(|d| d.len() > 253)
        {
            return Err("invalid outbox domains".into());
        }
        // v1a-23
        if disk.owner.len() > OWNER_ITEMS
            || disk.owner.iter().any(|i| {
                i.kind != Kind::Owner
                    || i.owner.is_none()
                    || !store::valid_id(&i.id)
                    || !store::valid_id(&i.session_id)
                    || !ids.insert(&i.id)
                    || i.text.len() > 4096
                    || !i.choices.is_empty()
            })
        {
            return Err("invalid owner item".into());
        }
        Ok(())
    }
    pub fn save(&self) -> Result<(), String> {
        Self::validate(&self.disk)?;
        let bytes = if self.foreign_owner.is_empty() {
            serde_json::to_vec(&self.disk)
        } else {
            let mut value = serde_json::to_value(&self.disk).map_err(|e| e.to_string())?;
            let owner = value
                .as_object_mut()
                .ok_or("queue store is not an object")?
                .entry("owner")
                .or_insert_with(|| Value::Array(vec![]));
            if let Some(owner) = owner.as_array_mut() {
                owner.extend(self.foreign_owner.iter().cloned());
            }
            serde_json::to_vec(&value)
        }
        .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_STORE {
            return Err("queue store exceeds limit".into());
        }
        store::atomic_write(&self.home.join("queue.json"), &bytes)
    }
    /// Ticket 1133: writes the replayed ids `change` kept in memory (once, after the startup replay).
    pub fn flush(&self) -> Result<(), String> {
        self.save()
    }
    fn change(&mut self, f: impl FnOnce(&mut Self) -> Result<(), String>) -> Result<(), String> {
        let old = self.disk.clone();
        if let Err(e) = f(self).and_then(|()| {
            // Ticket 1133: a change of the replayed ids alone is not saved. Most hooks (every tool call) change
            // nothing else, and a full rewrite of a 1.6 MB queue.json per hook wrote 137 GB in 2.4 h on 11-23.
            // Safe: the hook deletes its journal file after the core's ack, startup deletes each file it replayed,
            // and the next real save (or `flush` after startup replay) writes the ids too.
            if !same_except_seen(&self.disk, &old) {
                self.save()
            } else {
                Ok(())
            }
        }) {
            self.disk = old;
            return Err(e);
        }
        let disk = &self.disk;
        self.graced.retain(|g| {
            disk.sessions
                .values()
                .any(|s| s.items.iter().any(|i| &i.id == g))
        }); // v1a-77
        Ok(())
    }
    /// Ticket 750: forgets the state of every session `keep` refuses (a row that left the registry for good), so the
    /// store stays under its session limit (`validate`).
    pub fn retain_sessions(&mut self, keep: impl Fn(&str) -> bool) -> Result<(), String> {
        self.activity.retain(|id, _| keep(id));
        self.resized.retain(|id, _| keep(id));
        self.change(|q| {
            q.disk.sessions.retain(|id, _| keep(id));
            Ok(())
        })
    }
    pub fn register(&mut self, id: &str, kind: AgentKind, now: u64) -> Result<(), String> {
        if !store::valid_id(id) {
            return Err("invalid session id".into());
        }
        if self.disk.sessions.contains_key(id) {
            return Ok(());
        }
        self.change(|q| {
            q.disk.sessions.insert(
                id.into(),
                State {
                    last_event_at: 0,
                    tasks: BTreeSet::new(),
                    kind,
                    attention: Attention {
                        last_activity: now,
                        ..Attention::default()
                    },
                    items: vec![],
                    transcript_key: String::new(),
                    transcript_offset: 0,
                    transcript_discarding: false,
                    turn: None,
                    finished: BTreeSet::new(),
                    stop_pending: false,
                    stop_at: 0,
                    registered: now,
                    local_command: false,
                },
            );
            Ok(())
        })
    }
    /// When `id` was registered (a resumed run keeps the time of the run it continues); 0 when unknown.
    pub fn registered(&self, id: &str) -> u64 {
        self.disk.sessions.get(id).map_or(0, |s| s.registered)
    }
    pub fn prepare_resume(&mut self, old: &str, new: &str) -> Result<(), String> {
        if !store::valid_id(new) || self.disk.sessions.contains_key(new) {
            return Err("invalid resume queue identity".into());
        }
        let mut state = self
            .disk
            .sessions
            .get(old)
            .cloned()
            .ok_or("prior queue session missing")?;
        for item in &mut state.items {
            item.id = store::new_id()?;
            item.session_id = new.into();
            item.actionable = false;
            item.reconciled = true;
            item.hook_event_id = None;
            item.screen_text = None;
            item.choices.clear();
        }
        state.attention.failed = false;
        state.attention.observer_error = None;
        state.attention.working = false;
        state.attention.waiting = false;
        state.attention.stale = false;
        state.attention.background = 0;
        state.attention.last_activity = now_ms();
        state.last_event_at = 0;
        state.tasks.clear();
        state.stop_pending = false;
        // shortcut: old mappings count toward store limits; prune them with a coordinated metadata/queue retention operation.
        self.change(|q| {
            q.disk.sessions.insert(new.into(), state);
            Ok(())
        })
    }
    pub fn items(&self) -> Vec<Decision> {
        self.disk
            .sessions
            .values()
            .flat_map(|s| s.items.clone())
            .collect()
    }
    /// S9: `items` of one session, without cloning the others'.
    pub fn items_of(&self, id: &str) -> Vec<Decision> {
        self.disk
            .sessions
            .values()
            .flat_map(|s| s.items.iter().filter(|i| i.session_id == id).cloned())
            .collect()
    }
    pub fn attention(&self, id: &str) -> Attention {
        self.disk
            .sessions
            .get(id)
            .map(|s| {
                let mut attention = s.attention.clone();
                attention.last_activity = self
                    .activity
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .max(attention.last_activity);
                attention
            })
            .unwrap_or_default()
    }
    pub fn observer_error(&mut self, id: &str, error: Option<String>) -> Result<(), String> {
        if self
            .disk
            .sessions
            .get(id)
            .ok_or("queue session missing")?
            .attention
            .observer_error
            == error
        {
            return Ok(());
        }
        self.change(|q| {
            q.disk
                .sessions
                .get_mut(id)
                .ok_or("queue session missing")?
                .attention
                .observer_error = error;
            Ok(())
        })
    }
    /// Whether the wait that hid the session's permission frame is over (`hook_hidden`). The tick then reads the
    /// screen again at once: the next read would otherwise wait for a second with no event, and the hooks of another
    /// agent's tool calls keep that second from coming.
    pub fn hide_over(&self, id: &str, now: u64) -> bool {
        self.hook_hidden
            .get(id)
            .is_some_and(|since| now.saturating_sub(*since) >= HOOK_EXPECTED_MS)
    }
    pub fn activity(&mut self, id: &str, now: u64) -> Result<(), String> {
        let state = self.disk.sessions.get(id).ok_or("queue session missing")?;
        self.activity
            .entry(id.into())
            .and_modify(|at| *at = (*at).max(now))
            .or_insert(now);
        // Keep exact live activity; checkpoint timestamps at most once per second.
        if !state.attention.stale && now.saturating_sub(state.attention.last_activity) < 1000 {
            return Ok(());
        }
        self.change(|q| {
            let s = q.disk.sessions.get_mut(id).ok_or("queue session missing")?;
            s.attention.last_activity = s.attention.last_activity.max(now);
            s.attention.stale = false;
            s.items.retain(|i| i.kind != Kind::Stale);
            Ok(())
        })
    }
    /// V2-1b: a reattached session's items (restored, or replayed from the hook journal) are shown and counted but
    /// answerable only after fresh proof, which gives them a new id; an old hook is never answered through.
    pub fn checking(&mut self, id: &str) -> Result<(), String> {
        self.change(|q| {
            if let Some(s) = q.disk.sessions.get_mut(id) {
                for i in &mut s.items {
                    i.actionable = false;
                    i.reconciled = true;
                    i.hook_event_id = None;
                }
            }
            Ok(())
        })
    }
    pub fn close(&mut self, id: &str, failed: bool) -> Result<(), String> {
        self.resized.remove(id);
        self.hook_expected.remove(id);
        self.hook_hidden.remove(id);
        self.change(|q| {
            if let Some(s) = q.disk.sessions.get_mut(id) {
                s.attention.failed = failed;
                s.attention.working = false;
                s.attention.waiting = false;
                s.attention.stale = false;
                for i in &mut s.items {
                    i.actionable = false;
                    i.reconciled = true;
                }
            }
            Ok(())
        })
    }
    pub fn tick(
        &mut self,
        now: u64,
        threshold: u64,
        live: &BTreeSet<String>,
    ) -> Result<(), String> {
        self.end_graces(now)?; // v1a-71
        // Ticket 1094: a turn that ended with background work still counted settles once its Stop is HELD_STOP_MS old.
        // The agent is at its prompt by then; a task whose end was lost (or that runs on) no longer holds every send.
        let held: Vec<_> = self
            .disk
            .sessions
            .iter()
            .filter(|(id, s)| {
                live.contains(*id)
                    && s.attention.working
                    && s.stop_pending
                    && now.saturating_sub(s.stop_at) >= HELD_STOP_MS
                    // Review r1 point 3: a turn Claude starts by itself (a task's end with another still running)
                    // sends no prompt; its records and output are activity, and a turn that shows any is not settled.
                    && now.saturating_sub(
                        self.activity
                            .get(*id)
                            .copied()
                            .unwrap_or(0)
                            .max(s.attention.last_activity),
                    ) >= HELD_STOP_MS
                    && !waits(&s.items)
            })
            .map(|(id, _)| id.clone())
            .collect();
        if !held.is_empty() {
            self.change(|q| {
                for id in &held {
                    if let Some(s) = q.disk.sessions.get_mut(id) {
                        Self::finish(s);
                        s.attention.waiting = waits(&s.items);
                    }
                }
                Ok(())
            })?;
        }
        let due: Vec<_> = self
            .disk
            .sessions
            .iter()
            .filter(|(id, s)| {
                // B14 (ticket 991): only a turn in progress can go stale; a shell or an agent at its prompt is idle.
                live.contains(*id)
                    && s.attention.working
                    // A background note keeps the turn from going stale, as before it stopped counting as waiting.
                    && !s.items.iter().any(|i| i.kind != Kind::Stale)
                    && !s.attention.stale
                    && now.saturating_sub(
                        self.activity
                            .get(*id)
                            .copied()
                            .unwrap_or(0)
                            .max(s.attention.last_activity),
                    ) >= threshold
            })
            .map(|(id, _)| id.clone())
            .collect();
        if due.is_empty() {
            return Ok(());
        }
        self.change(|q| {
            for id in due {
                q.upsert(
                    &id,
                    "main",
                    Kind::Stale,
                    "No output or state change".into(),
                    vec![],
                    Evidence {
                        source: "clock",
                        at: now,
                        hook: None,
                    },
                )?;
                q.disk
                    .sessions
                    .get_mut(&id)
                    .ok_or("queue session missing")?
                    .attention
                    .stale = true;
            }
            Ok(())
        })
    }
    pub fn observe(
        &mut self,
        id: &str,
        event: &str,
        payload: &Value,
        source: &str,
        now: u64,
    ) -> Result<(), String> {
        self.change(|q| q.apply(id, event, payload, source, now))
    }
    pub(crate) fn apply(
        &mut self,
        id: &str,
        event: &str,
        p: &Value,
        source: &str,
        now: u64,
    ) -> Result<(), String> {
        let s = self
            .disk
            .sessions
            .get_mut(id)
            .ok_or("queue session missing")?;
        // Seventh look (B S2-1): a transcript record is read some time after it was written (`at`). What was asked
        // after that is not ended by it: of two tool calls in one message, the first's result was read after the
        // second's permission request arrived and took its card, while Claude waited at the prompt for minutes.
        if source == "transcript"
            && matches!(
                event,
                "UserPromptSubmit" | "ToolResult" | "Stop" | "Interrupted"
            )
            && let Some(at) = p["at"].as_u64()
            && s.items.iter().any(|i| asked_after(i, at))
        {
            let (later, earlier) = std::mem::take(&mut s.items)
                .into_iter()
                .partition(|i| asked_after(i, at));
            s.items = earlier;
            let mut undated = p.clone();
            undated["at"] = Value::Null;
            let result = self.apply(id, event, &undated, source, now);
            let s = self
                .disk
                .sessions
                .get_mut(id)
                .ok_or("queue session missing")?;
            s.items.extend(later);
            s.attention.waiting = waits(&s.items);
            return result;
        }
        if source == "hook" && !carries_no_turn_state(event, p) {
            if now < s.last_event_at {
                return Ok(());
            }
            s.last_event_at = now;
        }
        s.attention.last_activity = s.attention.last_activity.max(now);
        s.attention.stale = false;
        s.items.retain(|i| i.kind != Kind::Stale);
        let scope = p["agent_id"].as_str().unwrap_or("main");
        // An item a transcript record makes was asked when the record was written, not when it was read: its own
        // result, read in the same batch, is later than it.
        let asked = p["at"]
            .as_u64()
            .filter(|_| source == "transcript")
            .map_or(now, |at| at.min(now));
        match event {
            "UserPromptSubmit" => {
                let turn = p["prompt_id"].as_str().or_else(|| p["turn_id"].as_str());
                if turn.is_some_and(|t| s.finished.contains(t)) {
                    return Ok(());
                }
                // Ticket 1094: a Stop held for background work, then a new prompt: Claude took the prompt at its input
                // box, so the held turn ended. Kept working, the turn never ended for the queue: every later Stop was
                // held again behind a task whose end was never seen.
                if s.stop_pending {
                    Self::finish(s);
                }
                if let Some(turn) = turn {
                    s.turn = Some(turn.into());
                }
                if !s.attention.working {
                    s.attention.working = true;
                    s.attention.working_since = now;
                    s.attention.background = 0;
                    // A hook's prompt that is a slash command may be one Claude answers locally (see `CommandDone`).
                    s.local_command = p["prompt"]
                        .as_str()
                        .is_some_and(|t| t.trim_start().starts_with('/'));
                }
                s.items
                    .retain(|i| i.scope != "main" && !i.scope.starts_with(ASYNC_SCOPE));
            }
            // W35 look v23 S2-1: Claude's transcript record of a slash command; a turn only when none runs (a command
            // typed while a model turn works, `/fast`, leaves that turn as it is).
            "CommandSubmit" => {
                if !s.attention.working {
                    s.attention.working = true;
                    s.attention.working_since = now;
                    s.attention.background = 0;
                    s.local_command = true;
                }
            }
            // Its local answer ends the command's turn as a Stop does (a finished turn: a send that waited for one goes
            // in); a command that went on to a model turn ends at that turn's Stop.
            "CommandDone" => {
                if s.local_command {
                    Self::finish(s);
                }
            }
            "Answered" => s.items.retain(|i| !i.scope.starts_with(ASYNC_SCOPE)),
            // Ticket 1054: a Stop from inside a subagent (it carries the subagent's agent_id) ends that subagent, not
            // the session's turn; it is handled as SubagentStop below.
            "Stop" if p["agent_id"].as_str().is_none_or(str::is_empty) => {
                if let Some(turn) = p["turn_id"].as_str().or_else(|| p["prompt_id"].as_str())
                    && (s.finished.contains(turn)
                        || s.turn.as_deref().is_some_and(|active| active != turn))
                {
                    return Ok(());
                }
                let background = if source == "transcript" {
                    s.attention.background
                } else {
                    p["background_tasks"]
                        .as_array()
                        .map(|a| a.iter().filter(|t| t["status"] == "running").count() as u64)
                        .unwrap_or(0)
                };
                if source == "hook"
                    && let Some(tasks) = p["background_tasks"].as_array()
                {
                    s.tasks = tasks
                        .iter()
                        .filter(|t| t["status"] == "running")
                        .filter_map(|t| {
                            t["id"]
                                .as_str()
                                .or_else(|| t["task_id"].as_str())
                                .or_else(|| t["agent_id"].as_str())
                        })
                        .map(str::to_string)
                        .collect();
                }
                s.attention.background = background;
                s.stop_pending = background > 0;
                if background > 0 {
                    s.stop_at = now;
                    self.upsert(
                        id,
                        "background",
                        Kind::Background,
                        "Background task still running".into(),
                        vec![],
                        Evidence {
                            source,
                            at: now,
                            hook: None,
                        },
                    )?;
                } else {
                    Self::finish(s);
                }
            }
            "BackgroundStarted" => {
                if let Some(task) = p["task_id"].as_str() {
                    s.tasks.insert(task.into());
                    s.attention.background = s.tasks.len() as u64;
                }
            }
            "Stop" | "SubagentStop" | "TaskCompleted" => {
                let task = p["task_id"].as_str().unwrap_or(scope);
                s.items.retain(|i| i.scope != task);
                if s.tasks.is_empty() || s.tasks.remove(task) {
                    s.attention.background = s.attention.background.saturating_sub(1);
                }
                if s.stop_pending && s.attention.background == 0 {
                    Self::finish(s);
                }
            }
            "PostToolUse" | "ToolResult" => {
                let refused = (p["open"] == false && p["tool_use_id"].is_string())
                    .then(|| async_scope(&p["tool_use_id"]));
                s.items.retain(|i| {
                    (i.scope != scope || i.kind == Kind::Background)
                        && refused.as_deref() != Some(i.scope.as_str())
                });
            }
            "Interrupted" => {
                if let Some(turn) = p["turn_id"].as_str()
                    && (s.finished.contains(turn)
                        || s.turn.as_deref().is_some_and(|active| active != turn))
                {
                    return Ok(());
                }
                Self::finish(s);
            }
            "PermissionRequest" | "Question" => {
                self.hook_hidden.remove(id); // its hook item is the card now
                let question = event == "Question"
                    || QUESTION_TOOLS.contains(&p["tool_name"].as_str().unwrap_or(""));
                let text = p
                    .get("tool_input")
                    .or_else(|| p.get("input"))
                    .unwrap_or(p)
                    .to_string();
                self.upsert(
                    id,
                    &question_scope(p, scope),
                    if question {
                        Kind::Question
                    } else {
                        Kind::Permission
                    },
                    text,
                    async_choices(p),
                    Evidence {
                        source,
                        at: asked,
                        hook: p["nunchiro_event_id"].as_str().map(str::to_string),
                    },
                )?;
                // v1b-32 r2
                if let Some(event) = p["nunchiro_event_id"].as_str() {
                    let sessions = &self.disk.sessions;
                    self.tools.retain(|item, _| {
                        sessions
                            .values()
                            .any(|s| s.items.iter().any(|i| i.id == *item))
                    });
                    self.session_rules
                        .retain(|item, _| self.tools.contains_key(item));
                    if let Some(item) = sessions[id]
                        .items
                        .iter()
                        .find(|i| i.hook_event_id.as_deref() == Some(event))
                    {
                        self.tools.insert(
                            item.id.clone(),
                            p["tool_name"].as_str().unwrap_or("").into(),
                        );
                        match p["permission_suggestions"].as_array() {
                            Some(all) if !all.is_empty() => {
                                let tool = p["tool_name"].as_str().unwrap_or("").to_string();
                                let input = p.get("tool_input").cloned().unwrap_or(Value::Null);
                                self.session_rules
                                    .insert(item.id.clone(), (tool, input, all.clone()));
                            }
                            _ => {
                                self.session_rules.remove(&item.id);
                            }
                        }
                    }
                }
            }
            "PreToolUse" if QUESTION_TOOLS.contains(&p["tool_name"].as_str().unwrap_or("")) => {
                self.upsert(
                    id,
                    &question_scope(p, scope),
                    Kind::Question,
                    p["tool_input"].to_string(),
                    async_choices(p),
                    Evidence {
                        source,
                        at: asked,
                        hook: None,
                    },
                )?;
            }
            "PreToolUse" if source == "hook" && s.kind == AgentKind::Claude => {
                self.hook_expected.insert(id.into(), now + HOOK_EXPECTED_MS);
            }
            _ => {}
        }
        let s = self
            .disk
            .sessions
            .get_mut(id)
            .ok_or("queue session missing")?;
        end_view_only(&mut s.items, &self.stacked); // v1b-32 r6
        s.attention.waiting = waits(&s.items);
        Ok(())
    }
    fn finish(s: &mut State) {
        // Stop with background work is not a finished turn; duplicate finish signals are inert.
        if s.attention.working {
            s.attention.completion_seq += 1;
        }
        if let Some(turn) = s.turn.take() {
            s.finished.insert(turn);
        }
        s.stop_pending = false;
        s.stop_at = 0;
        s.local_command = false;
        s.tasks.clear();
        s.attention.working = false;
        s.attention.background = 0;
        s.items
            .retain(|i| i.scope != "main" && i.kind != Kind::Background);
    }
    fn upsert(
        &mut self,
        id: &str,
        scope: &str,
        kind: Kind,
        text: String,
        choices: Vec<Choice>,
        evidence: Evidence<'_>,
    ) -> Result<(), String> {
        let Evidence {
            source,
            at: now,
            hook,
        } = evidence;
        // v1b-12: hook events still waiting for an answer (a window holds the lease; at most 1.4 s each).
        let live: BTreeSet<String> = self
            .hook_until
            .iter()
            .filter(|(_, until)| **until > now)
            .map(|(event, _)| event.clone())
            .collect();
        // v1b-32 r4: marks are pruned against the items of every session; another session's event never clears one.
        let sessions = &self.disk.sessions;
        self.stacked.retain(|i| {
            sessions
                .values()
                .any(|s| s.items.iter().any(|item| item.id == *i))
        });
        let s = self
            .disk
            .sessions
            .get_mut(id)
            .ok_or("queue session missing")?;
        let stacked = &mut self.stacked;
        let tools = &self.tools; // v1b-32 r2
        if text.len() > 65536 || scope.len() > 256 {
            return Err("decision exceeds limit".into());
        }
        // v1b-32: while the screen cannot prove which request a frame shows (a contended session, or an unprovable
        // hook item), the held items keep their cards untouched and a frame gets its own screen card (view-only or
        // Esc-only, r5) only when it provably shows none of their requests (`other_prompt`); any other frame ends
        // that card.
        if source == "screen" && holds(&s.items, stacked) {
            if kind == Kind::Background {
                return Ok(());
            }
            let held: Vec<(Option<&str>, &str)> = s
                .items
                .iter()
                .filter(|i| !i.reconciled && i.sources.contains("hook"))
                .map(|i| (tools.get(&i.id).map(String::as_str), i.text.as_str()))
                .collect();
            // v1b-32 r5 (scope cut after security reviews r1-r4): the queue cannot know every request still pending
            // (a stacked, answered or scope-cleared item loses its request), so `other_prompt` only decides whether
            // the frame shows as a card, never what it may answer: a dialog card answers only with Esc, any other
            // is view-only (not actionable: nothing to send, its answer writes nothing).
            let proven = other_prompt(s.kind, &kind, &text, &held);
            let esc = kind == Kind::Dialog;
            let choices = if esc { choices } else { vec![] };
            let shown = esc.then(|| text.clone());
            let card = s.items.iter().position(|i| {
                !i.sources.contains("hook")
                    && i.sources.contains("screen")
                    && !matches!(i.kind, Kind::Stale | Kind::Background)
            });
            match (proven, card) {
                (false, Some(at)) => {
                    s.items.remove(at);
                }
                (false, None) => {}
                (true, Some(at)) => {
                    let item = &mut s.items[at];
                    if item.kind != kind || item.text != text || item.actionable != esc {
                        item.id = store::new_id()?;
                        item.kind = kind;
                        item.text = text;
                        item.screen_text = shown;
                        item.observed_at = now;
                    }
                    item.choices = choices;
                    item.actionable = esc;
                    item.reconciled = false;
                }
                (true, None) => {
                    if s.items.len() >= 64 {
                        return Err("too many pending decisions".into());
                    }
                    s.items.push(Decision {
                        id: store::new_id()?,
                        session_id: id.into(),
                        scope: scope.into(),
                        kind,
                        text,
                        choices,
                        sources: BTreeSet::from([source.into()]),
                        observed_at: now,
                        actionable: esc,
                        reconciled: false,
                        hook_event_id: None,
                        screen_text: shown,
                        owner: None,
                        risky: true,
                        deny_note: false,
                        allow_always: None,
                        allow_scope: None,
                        tool: None,
                        outward: None,
                    });
                }
            }
            s.attention.waiting = waits(&s.items);
            return Ok(());
        }
        // v1b-32 r6: a view-only card is never continued, upgraded or re-keyed: past the hold it goes.
        s.items.retain(|i| !view_only(i));
        let screen_text = (source == "screen").then(|| text.clone());
        let agent = s.kind; // v1b-27
        if let Some(item) = s
            .items
            .iter_mut()
            .find(|i| i.scope == scope && i.kind != Kind::Stale)
        {
            // v1b-12 (security-reviewed): an agent draws its prompt in several frames, some reading as another kind
            // mid-draw. A hook-backed item keeps its id, kind and text (the hook's request) only for frames that show
            // that request in the prompt region (`own_request`); those become what a late answer is checked against.
            // While its hook still waits, other frames are ignored (the hook answers for its own request); after
            // that, any other frame ends the item as before, so a replaced prompt can never inherit this card.
            let mut other = false;
            if source == "screen" && !item.reconciled && item.sources.contains("hook") {
                if item.kind == kind && !choices.is_empty() && own_request(agent, &text, &item.text)
                {
                    item.sources.insert(source.into());
                    item.choices = choices;
                    item.screen_text = screen_text;
                    s.attention.waiting = waits(&s.items);
                    return Ok(());
                }
                if item
                    .hook_event_id
                    .as_ref()
                    .is_some_and(|e| live.contains(e))
                {
                    return Ok(());
                }
                // Look C N5, Home look S2-8 (11-17): while the hook's tool call waits (no tool result, no answer),
                // a permission frame the screen cannot match is its prompt redrawn (a narrower terminal wraps it),
                // not a new request: the hook's card stays and makes no screen card. Its screen answer stays the last
                // matched frame, which the answer checks against what is on screen now.
                if kind == Kind::Permission
                    && item.kind == Kind::Permission
                    && redrawn(&text, &item.text)
                {
                    return Ok(());
                }
                other = true;
            }
            // v1b-12: a permission hook landing on a screen-only item that shows some other prompt starts a new
            // item: it never inherits that prompt's screen (what a late answer would type into).
            let foreign = source != "screen"
                && kind == Kind::Permission
                && item.hook_event_id.is_none()
                && item
                    .screen_text
                    .as_ref()
                    .is_some_and(|t| !own_request(agent, t, &text));
            let stacks = kind == Kind::Permission
                && item.kind == Kind::Permission
                && hook.is_some()
                && item.hook_event_id.is_some()
                && hook != item.hook_event_id;
            if item.reconciled
                || other
                || foreign
                || (source == "screen" && item.screen_text.as_ref().is_some_and(|old| *old != text))
                || (source == "screen" && item.kind != kind)
                || (hook.is_some() && item.hook_event_id.is_some() && hook != item.hook_event_id)
            {
                let asked = (source == "screen" && asked_on_screen(&kind, &item.text, &text))
                    .then(|| item.text.clone());
                item.id = store::new_id()?;
                item.screen_text = None;
                item.hook_event_id = None;
                item.sources.clear();
                item.choices.clear();
                item.kind = kind.clone();
                item.text = asked.unwrap_or_else(|| text.clone());
                if stacks {
                    stacked.insert(item.id.clone()); // v1b-30
                }
                item.observed_at = now;
            }
            item.sources.insert(source.into());
            item.actionable = true;
            item.reconciled = false;
            if source != "screen" || item.text.is_empty() {
                item.text = text;
                item.kind = kind;
            }
            if !choices.is_empty() {
                item.choices = choices;
            }
            if hook.is_some() {
                item.hook_event_id = hook;
            }
        } else {
            if s.items.len() >= 64 {
                return Err("too many pending decisions".into());
            }
            s.items.push(Decision {
                id: store::new_id()?,
                session_id: id.into(),
                scope: scope.into(),
                kind,
                text,
                choices,
                sources: BTreeSet::from([source.into()]),
                observed_at: now,
                actionable: true,
                reconciled: false,
                hook_event_id: hook,
                screen_text: None,
                owner: None,
                risky: true,
                deny_note: false,
                allow_always: None,
                allow_scope: None,
                tool: None,
                outward: None,
            });
        }
        if let Some(text) = screen_text
            && let Some(item) = s
                .items
                .iter_mut()
                .find(|i| i.scope == scope && i.kind != Kind::Stale)
        {
            item.screen_text = Some(text);
        }
        // v1b-30: a second pending hook permission takes the screen from every hook item of the session.
        if contended(&s.items, stacked) {
            for item in s
                .items
                .iter_mut()
                .filter(|i| i.kind == Kind::Permission && i.hook_event_id.is_some())
            {
                item.screen_text = None;
            }
        }
        s.attention.waiting = waits(&s.items);
        Ok(())
    }
    /// Ticket 396: the session is inside its resize grace, so a blank screen may still be redrawn.
    pub fn redrawing(&self, id: &str) -> bool {
        self.resized
            .get(id)
            .is_some_and(|(at, _)| in_grace(*at, now_ms()))
    }
    /// v1a-71: the session's terminal was resized at `now`; its agent is about to redraw the prompt.
    /// v1a-77: one grace per prompt. An active grace is never moved or extended, and a session arms only while it
    /// holds a redrawable item whose grace is not spent, so resize spam cannot keep a gone prompt's card alive.
    pub fn resized(&mut self, id: &str, now: u64) {
        if self
            .resized
            .get(id)
            .is_some_and(|(at, _)| in_grace(*at, now))
        {
            return;
        }
        // An unfinished grace that is over before `end_graces` ran is spent; its clear (if any) stays for the tick.
        if self.resized.contains_key(id) {
            self.spend(id);
        }
        let fresh = self.disk.sessions.get(id).is_some_and(|s| {
            s.items
                .iter()
                .any(|i| redrawable(i) && !self.graced.contains(&i.id))
        });
        if fresh {
            self.resized.insert(id.into(), (now, false));
        }
    }
    /// v1a-77: the session's redrawable items have used (or missed) their one grace.
    fn spend(&mut self, id: &str) {
        if let Some(s) = self.disk.sessions.get(id) {
            let ids = s
                .items
                .iter()
                .filter(|i| redrawable(i))
                .map(|i| i.id.clone());
            self.graced.extend(ids);
        }
    }
    /// Seventh look (B S1-1): the agent drew nothing after the resize, so its prompt is still what the terminal shows
    /// (sessions.rs `restore_undrawn`), in the new size's layout. The grace starts again for the read that follows, so
    /// that read is "the same prompt redrawn" (`screen`): the card stays, with its id, and takes the new layout's text.
    pub fn undrawn(&mut self, id: &str, now: u64) {
        self.resized.insert(id.into(), (now, false));
    }
    /// v1a-71: ends the graces that are over; a session whose prompt went away during its grace is cleared now.
    fn end_graces(&mut self, now: u64) -> Result<(), String> {
        let over: Vec<_> = self
            .resized
            .iter()
            .filter(|(_, (at, _))| !in_grace(*at, now))
            .map(|(id, (_, cleared))| (id.clone(), *cleared))
            .collect();
        for (id, cleared) in over {
            self.resized.remove(&id);
            self.spend(&id); // v1a-77
            if cleared && self.disk.sessions.contains_key(&id) {
                self.clear_screen(&id)?;
            }
        }
        Ok(())
    }
    pub fn clear_screen(&mut self, id: &str) -> Result<(), String> {
        self.hook_hidden.remove(id);
        let items = &self
            .disk
            .sessions
            .get(id)
            .ok_or("queue session missing")?
            .items;
        // v1a-71: within the grace a blank or partial redraw keeps the item; the answer path still checks the screen.
        let keep = self
            .resized
            .get(id)
            .is_some_and(|(at, _)| in_grace(*at, now_ms()))
            && !holds(items, &self.stacked);
        let stale = |i: &Decision| {
            i.sources.contains("screen")
                && matches!(i.kind, Kind::Permission | Kind::Question | Kind::Dialog)
                && !(keep && redrawable(i))
        };
        let kept = keep && items.iter().any(redrawable);
        let any = items.iter().any(stale);
        if kept && let Some((_, cleared)) = self.resized.get_mut(id) {
            *cleared = true; // `end_graces` clears it unless the prompt comes back first
        }
        if !any {
            return Ok(());
        }
        self.change(|q| {
            let s = q.disk.sessions.get_mut(id).ok_or("queue session missing")?;
            s.items.retain(|i| !stale(i));
            s.attention.waiting = waits(&s.items);
            Ok(())
        })
    }
    pub fn screen(
        &mut self,
        id: &str,
        kind: Kind,
        text: String,
        choices: Vec<Choice>,
        now: u64,
    ) -> Result<(), String> {
        // v1a-71: the first prompt seen after a resize, if it is the same prompt redrawn (`same_prompt`, same kind
        // and choices), keeps its item and id; anything else, or any later frame, takes the usual rules.
        if let Some((at, _)) = self.resized.remove(id) {
            let items = &self
                .disk
                .sessions
                .get(id)
                .ok_or("queue session missing")?
                .items;
            if in_grace(at, now)
                && !holds(items, &self.stacked)
                && let Some(n) = items.iter().position(|i| {
                    redrawable(i)
                        && i.kind == kind
                        && i.choices == choices
                        && i.screen_text
                            .as_deref()
                            .is_some_and(|t| same_prompt(t, &text))
                })
            {
                return self.change(|q| {
                    let s = q.disk.sessions.get_mut(id).ok_or("queue session missing")?;
                    s.attention.last_activity = now;
                    let item = &mut s.items[n];
                    if !asked_on_screen(&item.kind, &item.text, &text) {
                        item.text = text.clone(); // the card shows what is on screen
                    }
                    item.screen_text = Some(text);
                    item.choices = choices;
                    let kept = item.id.clone();
                    q.graced.insert(kept); // v1a-77: its one redraw is used
                    Ok(())
                });
            }
            self.spend(id); // v1a-77: the mark is dropped without a match: that grace is used up
        }
        if self
            .disk
            .sessions
            .get(id)
            .ok_or("queue session missing")?
            .items
            .iter()
            .any(|i| {
                i.kind == kind
                    && !i.reconciled
                    && i.sources.contains("screen")
                    && if i.actionable {
                        i.screen_text.as_ref() == Some(&text) && i.choices == choices
                    } else {
                        // v1b-32 r5: a view-only card beside a held item, redrawn.
                        i.hook_event_id.is_none() && i.text == text
                    }
            })
        {
            return self.activity(id, now);
        }
        // One request, one card: a permission frame drawn between Claude's PreToolUse hook and its held
        // PermissionRequest hook makes no card of its own; the hook's item is the card, and its later frames pair with
        // it. With no permission item yet and the hook still expected, wait: the tick reads the screen again when the
        // wait is over (`hide_over`), so the frame becomes a card then (no hook installed, or it failed).
        let live_permission = self
            .disk
            .sessions
            .get(id)
            .ok_or("queue session missing")?
            .items
            .iter()
            .any(|i| i.kind == Kind::Permission && !i.reconciled);
        if kind == Kind::Permission
            && !live_permission
            && self.hook_expected.get(id).is_some_and(|until| *until > now)
        {
            let since = *self.hook_hidden.entry(id.into()).or_insert(now);
            if now.saturating_sub(since) < HOOK_EXPECTED_MS {
                return Ok(());
            }
        }
        self.hook_hidden.remove(id);
        self.change(|q| {
            q.disk
                .sessions
                .get_mut(id)
                .ok_or("queue session missing")?
                .attention
                .last_activity = now;
            let pending: Vec<_> = q
                .disk
                .sessions
                .get(id)
                .ok_or("queue session missing")?
                .items
                .iter()
                .filter(|i| i.kind == kind && i.kind != Kind::Stale)
                .collect();
            let scope = if pending.len() == 1 {
                pending[0].scope.clone()
            } else {
                "main".into()
            };
            q.upsert(
                id,
                &scope,
                kind,
                text,
                choices,
                Evidence {
                    source: "screen",
                    at: now,
                    hook: None,
                },
            )
        })
    }
    pub fn replay(&mut self, event: &journal::Event) -> Result<(), String> {
        if self.disk.seen.contains_key(&event.event_id) {
            return Ok(());
        }
        // Ticket 1094 (review r1 point 2): a prompt journaled long ago (a hook no core took, replayed at the next
        // start) says nothing about now; its Stop may never have been journaled, and replayed it set an idle seat
        // working for hours. Only the session's own evidence (its transcript, read from the saved cursor) starts a turn.
        let stale = matches!(event.event.as_str(), "UserPromptSubmit")
            && now_ms().saturating_sub(event.created) >= REPLAY_PROMPT_STALE_MS;
        self.change(|q| {
            q.disk
                .seen
                .retain(|_, at| event.created.saturating_sub(*at) <= journal::MAX_AGE_MS);
            // Ticket 1094: a full set refused every hook from then on (a day of tool calls from a few busy seats fills
            // 32768 ids), and no Stop reached the queue. The oldest quarter goes instead: an id is needed only while its
            // journal file may still be replayed, and the journal holds at most `journal::MAX_EVENTS` files.
            if q.disk.seen.len() >= SEEN_MAX {
                let mut ages: Vec<u64> = q.disk.seen.values().copied().collect();
                ages.sort_unstable();
                let cut = ages[SEEN_MAX / 4];
                q.disk.seen.retain(|_, at| *at > cut);
            }
            if !stale {
                q.apply(
                    &event.session_id,
                    &event.event,
                    &event.payload,
                    "hook",
                    event.created,
                )?;
            }
            q.disk.seen.insert(event.event_id.clone(), event.created);
            Ok(())
        })
    }
    pub fn transcript_cursor(&self, id: &str) -> (String, u64) {
        self.disk
            .sessions
            .get(id)
            .map(|s| (s.transcript_key.clone(), s.transcript_offset))
            .unwrap_or_default()
    }
    pub fn transcript_discarding(&self, id: &str) -> bool {
        self.disk
            .sessions
            .get(id)
            .is_some_and(|s| s.transcript_discarding)
    }
    pub fn transcript(
        &mut self,
        id: &str,
        key: String,
        end: u64,
        records: &[Value],
        now: u64,
    ) -> Result<(), String> {
        self.transcript_batch(
            id,
            crate::waiting::transcript::Batch {
                key,
                end,
                records: records.to_vec(),
                skipped: 0,
                discarding: false,
            },
            now,
        )
    }
    pub fn transcript_batch(
        &mut self,
        id: &str,
        batch: crate::waiting::transcript::Batch,
        now: u64,
    ) -> Result<(), String> {
        let crate::waiting::transcript::Batch {
            key,
            end,
            records,
            skipped,
            discarding,
        } = batch;
        self.change(|q| {
            let kind = q.disk.sessions.get(id).ok_or("queue session missing")?.kind;
            for record in &records {
                let events = crate::waiting::transcript::events(kind, record);
                if events.is_empty() {
                    continue;
                }
                // Q9 pin-J7-1: a record the queue refuses (an over-limit question) is skipped whole, not retried
                // every tick: failing the batch would hold the cursor before it and no later Stop would arrive.
                let before = q.disk.sessions.get(id).cloned();
                for (event, payload) in events {
                    if let Err(error) = q.apply(id, &event, &payload, "transcript", now) {
                        eprintln!("transcript record skipped for {id}: {error}");
                        if let Some(before) = before {
                            q.disk.sessions.insert(id.into(), before);
                        }
                        break;
                    }
                }
            }
            let state = q.disk.sessions.get_mut(id).ok_or("queue session missing")?;
            state.transcript_key = key;
            state.transcript_offset = end;
            state.transcript_discarding = discarding;
            state.attention.skipped_transcript_lines = state
                .attention
                .skipped_transcript_lines
                .saturating_add(skipped);
            Ok(())
        })
    }
    /// V2-4a: a request an ACP agent made of a person (`session/request_permission`, an elicitation), one item each,
    /// whether or not a prompt is in flight; its id is the answer's key. Scope `acp`, so a turn's end never drops it.
    pub fn acp_ask(&mut self, id: &str, kind: Kind, text: String) -> Result<String, String> {
        let item = store::new_id()?;
        let now = now_ms();
        let key = item.clone();
        self.change(|q| {
            let s = q.disk.sessions.get_mut(id).ok_or("queue session missing")?;
            if s.items.len() >= 64 {
                return Err("too many waiting items".into());
            }
            s.attention.last_activity = s.attention.last_activity.max(now);
            s.attention.stale = false;
            s.items.retain(|i| i.kind != Kind::Stale);
            s.items.push(Decision {
                id: key,
                session_id: id.into(),
                scope: "acp".into(),
                kind,
                text,
                choices: vec![],
                sources: BTreeSet::from(["acp".into()]),
                observed_at: now,
                actionable: true,
                reconciled: false,
                hook_event_id: None,
                screen_text: None,
                owner: None,
                risky: true,
                deny_note: false,
                allow_always: None,
                allow_scope: None,
                tool: None,
                outward: None,
            });
            s.attention.waiting = true;
            Ok(())
        })?;
        Ok(item)
    }
    /// V2-4a: an ACP turn started (`working`) or is done (the prompt answered and none of its requests open).
    pub fn acp_turn(&mut self, id: &str, working: bool) -> Result<(), String> {
        let now = now_ms();
        self.change(|q| {
            let s = q.disk.sessions.get_mut(id).ok_or("queue session missing")?;
            s.attention.last_activity = s.attention.last_activity.max(now);
            s.attention.stale = false;
            s.items.retain(|i| i.kind != Kind::Stale);
            if working {
                if !s.attention.working {
                    s.attention.working_since = now;
                }
                s.attention.working = true;
            } else {
                Self::finish(s);
            }
            s.attention.waiting = waits(&s.items);
            Ok(())
        })
    }
    // v1a-23: owner items. One per subject (a new hash replaces the old ask) or per project; never a session item,
    // so `decision` (the only lookup session callers reach) cannot find them.
    pub fn owner_items(&self) -> Vec<Decision> {
        self.disk.owner.iter().map(|i| self.with_yes(i)).collect()
    }
    pub fn owner_decision(&self, id: &str) -> Option<Decision> {
        self.disk
            .owner
            .iter()
            .find(|i| i.id == id)
            .map(|i| self.with_yes(i))
    }
    /// Ticket 1002 lane 2: an Outbox card's `yes_at` is this core's memory, never the store's.
    fn with_yes(&self, i: &Decision) -> Decision {
        let mut i = i.clone();
        if let Some(OwnerAsk::Outward { yes_at, .. }) = &mut i.owner {
            *yes_at = self.outbox_yes.get(&i.id).copied();
        }
        i
    }
    pub fn ask_owner(&mut self, session: &str, ask: OwnerAsk) -> Result<String, String> {
        let same = |i: &Decision| match (&i.owner, &ask) {
            (
                Some(OwnerAsk::Approval { subject, name, .. }),
                OwnerAsk::Approval {
                    subject: s,
                    name: n,
                    ..
                },
            ) => subject == s && name == n,
            (
                Some(OwnerAsk::PermissionAnswers { project }),
                OwnerAsk::PermissionAnswers { project: p },
            ) => project == p,
            (Some(OwnerAsk::LeadAccounts), OwnerAsk::LeadAccounts) => true,
            (Some(OwnerAsk::Setup { path, .. }), OwnerAsk::Setup { path: p, .. }) => path == p,
            // Needs 225: one waiting ask per session and account; a new reason replaces the old ask.
            (Some(OwnerAsk::CodexReset { folder, .. }), OwnerAsk::CodexReset { folder: f, .. }) => {
                i.session_id == session && folder == f
            }
            // One card per task: a new ask (a later revision, other lessons) replaces it.
            (Some(OwnerAsk::Merge { task, .. }), OwnerAsk::Merge { task: t, .. }) => task == t,
            // One card per role name.
            (Some(OwnerAsk::Role { role, .. }), OwnerAsk::Role { role: r, .. }) => {
                role.name.to_lowercase() == r.name.to_lowercase()
            }
            // One goal card per project: a newer goal for it replaces the one not yet answered.
            (Some(OwnerAsk::Goal { place, .. }), OwnerAsk::Goal { place: p, .. }) => place == p,
            // Ticket 1002 lane 2: one card per exact call; a changed byte is a card of its own (no batch, no reuse).
            (Some(OwnerAsk::Outward { hash, .. }), OwnerAsk::Outward { hash: h, .. }) => hash == h,
            // One card per entry (a later change replaces the earlier ask), and one per proposed teammate and time
            // (a reworded task replaces it). An entry's failed-run card is its own: a lead's change does not replace
            // it, a newer failure does.
            (
                Some(OwnerAsk::Schedule {
                    id,
                    run,
                    when,
                    change,
                    reason,
                    ..
                }),
                OwnerAsk::Schedule {
                    id: i,
                    run: r,
                    when: w,
                    change: c,
                    reason: why,
                    ..
                },
            ) => {
                id == i
                    && (change == "failed") == (c == "failed")
                    // A trigger's cards are one per subject (`reason`), so another subject never replaces one.
                    && (change != "trigger" || reason == why)
                    && (id.is_some() || (run.teammate == r.teammate && when == w))
            }
            // One card per stalled task.
            (Some(OwnerAsk::Stall { task, .. }), OwnerAsk::Stall { task: t, .. }) => task == t,
            // Ticket 1003: one card per loop and change; a loop not stored yet is known by its words.
            (
                Some(OwnerAsk::Loop { change, row, .. }),
                OwnerAsk::Loop {
                    change: c, row: r, ..
                },
            ) => {
                change == c
                    && if c == "add" {
                        crate::loops::same(row, r)
                    } else {
                        row.id == r.id
                    }
            }
            // Ticket 1005: one card per teammate and file, however often its seat starts.
            (
                Some(OwnerAsk::Tidy { teammate, file, .. }),
                OwnerAsk::Tidy {
                    teammate: m,
                    file: f,
                    ..
                },
            ) => teammate == m && file == f,
            // Ticket 1099: one card per place; a newer ask replaces the one not yet answered.
            (Some(OwnerAsk::Cap { place, .. }), OwnerAsk::Cap { place: p, .. }) => place == p,
            // One card per offered name and place; a reworded offer replaces it.
            (
                Some(OwnerAsk::Bot { name, place, .. }),
                OwnerAsk::Bot {
                    name: n, place: p, ..
                },
            ) => place == p && name.to_lowercase() == n.to_lowercase(),
            (
                Some(OwnerAsk::SessionClose { target, .. }),
                OwnerAsk::SessionClose { target: t, .. },
            ) => target == t,
            _ => false,
        };
        if let Some(i) = self
            .disk
            .owner
            .iter()
            // Ticket 1002 lane 2: the same call staged again keeps its card, a yes on it included.
            .find(|i| {
                same(i)
                    && (i.owner.as_ref() == Some(&ask) || matches!(ask, OwnerAsk::Outward { .. }))
            })
        {
            return Ok(i.id.clone());
        }
        let text = match &ask {
            OwnerAsk::Approval {
                subject,
                name,
                level,
                ..
            } => match crate::plugins::split(name) {
                // "approve plugin quiet-hours", not "approve widget plugin:quiet-hours for read"
                Some((id, _)) => format!("approve plugin {id}"),
                None => format!(
                    "approve {} {name} for {}",
                    subject.label(),
                    format!("{level:?}").to_lowercase()
                ),
            },
            OwnerAsk::Setup { path, .. } => {
                format!("approve the setup script of worktree {}", path.display())
            }
            OwnerAsk::PermissionAnswers { project } => format!(
                "turn on verified yes (answer permission prompts with allow once) for {}",
                project.display()
            ),
            OwnerAsk::LeadAccounts => {
                "let your team leads start sessions on any of your accounts and move themselves \
                 (each start or move is a line in the room)"
                    .into()
            }
            OwnerAsk::CodexReset {
                account, reason, ..
            } => format!("use one Codex reset ticket of {account}: {reason}"),
            OwnerAsk::Role { role, why, .. } => {
                format!("add the role {} to your roles: {why}", role.name)
            }
            OwnerAsk::Goal {
                place, from, text, ..
            } => format!(
                "{from} wants to give {}'s lead this goal: {text}",
                place
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ),
            OwnerAsk::Schedule {
                change,
                line,
                reason,
                ..
            } if change == "failed" => format!(
                "run the schedule again (it failed: {}): {line}",
                reason.as_deref().unwrap_or("no reason given")
            ),
            OwnerAsk::Schedule { change, line, .. } => format!("{change} the schedule: {line}"),
            OwnerAsk::Outward { tool, args, .. } => {
                let shown = crate::outbox::check(tool, args).unwrap_or_default();
                let words: String = crate::outbox::words(&shown).chars().take(1000).collect();
                format!("let the Home lead make {words}")
            }
            OwnerAsk::Merge {
                task,
                title,
                revision,
                ..
            } => format!(
                "merge task {task} ({title}), reviewed at {}",
                revision.chars().take(7).collect::<String>()
            ),
            OwnerAsk::Stall {
                task,
                title,
                seat,
                error,
                ..
            } => match error {
                Some(error) => {
                    format!("task {task} ({title}) is stuck: {seat} stopped on: {error}")
                }
                None => format!(
                    "task {task} ({title}) is stuck: nothing changed in the last two check-ins of {seat}"
                ),
            },
            OwnerAsk::Loop { change, row, .. } => {
                let words = crate::loops::words(row);
                match change.as_str() {
                    "add" => format!("keep this open loop: {words}"),
                    "close" => format!("close this open loop: {words}"),
                    _ => format!("overdue: {words}"),
                }
            }
            OwnerAsk::SessionClose {
                label, place, why, ..
            } => format!(
                "Close {label} · {}: {why}",
                place.file_name().unwrap_or_default().to_string_lossy()
            ),
            OwnerAsk::Cap {
                place,
                was,
                cap,
                why,
            } => format!(
                "change the live seats of {} from {was} to {cap}: {why}",
                place
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ),
            OwnerAsk::Bot {
                name,
                job,
                why,
                from,
                ..
            } => format!("{from} offers a new bot, {name} ({job}): {why}"),
            OwnerAsk::Tidy { name, file, .. } => format!(
                "{name}'s {file} is over the 6 KB its brief quotes, so the rest does not reach {name}: let {name} tidy it?"
            ),
        };
        let item = Decision {
            id: store::new_id()?,
            session_id: session.into(),
            scope: "owner".into(),
            kind: Kind::Owner,
            text,
            choices: vec![],
            sources: BTreeSet::from(["owner".into()]),
            observed_at: now_ms(),
            actionable: true,
            reconciled: false,
            hook_event_id: None,
            screen_text: None,
            owner: Some(ask.clone()),
            risky: true,
            deny_note: false,
            allow_always: None,
            allow_scope: None,
            tool: None,
            outward: None,
        };
        let id = item.id.clone();
        self.change(|q| {
            q.disk.owner.retain(|i| !same(i));
            if q.disk.owner.len() >= OWNER_ITEMS {
                return Err("too many waiting owner items".into());
            }
            q.disk.owner.push(item);
            Ok(())
        })?;
        Ok(id)
    }
    /// Ticket 1002 lane 2: drops the owner items `is` matches that were asked more than `max_age` ms before `now`, and
    /// returns them; a card with a yes waiting out its undo stays. Nothing is written when none is that old (the
    /// server's tick calls this each second).
    pub fn expire_owner(
        &mut self,
        now: u64,
        max_age: u64,
        is: impl Fn(&Decision) -> bool,
    ) -> Result<Vec<Decision>, String> {
        let yes = &self.outbox_yes;
        let old = |i: &Decision| {
            is(i) && !yes.contains_key(&i.id) && now.saturating_sub(i.observed_at) > max_age
        };
        let gone: Vec<Decision> = self.disk.owner.iter().filter(|i| old(i)).cloned().collect();
        if !gone.is_empty() {
            let ids: BTreeSet<String> = gone.iter().map(|i| i.id.clone()).collect();
            self.change(|q| {
                q.disk.owner.retain(|i| !ids.contains(&i.id));
                Ok(())
            })?;
        }
        Ok(gone)
    }
    /// Ticket 1002 lane 2: sets (`Some`) or clears (an undo) the user's yes on Outbox card `id`, in memory only.
    pub fn outbox_yes(&mut self, id: &str, at: Option<u64>) {
        match at {
            Some(at) if self.disk.owner.iter().any(|i| i.id == id) => {
                self.outbox_yes.insert(id.into(), at);
            }
            _ => {
                self.outbox_yes.remove(id);
            }
        }
    }
    /// Ticket 1002 lane 2: the Outbox cards whose yes is `undo` ms old leave the owner list and become approved (in
    /// memory), each spendable once by the session that staged it until `now + spend`, with `domains(card)`; returns
    /// them. Nothing is written when none is ripe.
    pub fn outbox_ripe(
        &mut self,
        now: u64,
        undo: u64,
        spend: u64,
        domains: impl Fn(&Decision) -> Vec<String>,
    ) -> Result<Vec<Decision>, String> {
        let ids: BTreeSet<String> = self
            .outbox_yes
            .iter()
            .filter(|(_, at)| now.saturating_sub(**at) >= undo)
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let gone: Vec<Decision> = self
            .disk
            .owner
            .iter()
            .filter(|i| ids.contains(&i.id))
            .map(|i| self.with_yes(i))
            .collect();
        self.change(|q| {
            q.disk.owner.retain(|i| !ids.contains(&i.id));
            Ok(())
        })?;
        self.outbox_yes.retain(|id, _| !ids.contains(id));
        for i in &gone {
            if let Some(OwnerAsk::Outward {
                tool, hash, args, ..
            }) = &i.owner
            {
                let mail = crate::outbox::check(tool, args)
                    .ok()
                    .filter(|s| s.kind == "mail")
                    .map(|s| (s.to.join(", "), s.subject));
                self.outbox_approved.push(Approved {
                    mail,
                    id: i.id.clone(),
                    tool: tool.clone(),
                    hash: hash.clone(),
                    session: i.session_id.clone(),
                    until: now + spend,
                    domains: domains(i),
                });
            }
        }
        Ok(gone)
    }
    /// Ticket 1002 lane 2: spends, in one step, the approved card whose call is exactly `tool` with `hash` and that
    /// `session` staged: it is gone after this. `None`: no such card, another session's, or it lapsed.
    pub fn outbox_spend(
        &mut self,
        session: &str,
        tool: &str,
        hash: &str,
        now: u64,
    ) -> Option<Approved> {
        let at = self.outbox_approved.iter().position(|a| {
            a.tool == tool
                && a.session == session
                && crate::schedule::same(&a.hash, hash)
                && now < a.until
        })?;
        Some(self.outbox_approved.remove(at))
    }
    /// Look v20 S1: card `id` is approved and not yet spent or lapsed.
    pub fn outbox_approved(&self, id: &str) -> bool {
        self.outbox_approved.iter().any(|a| a.id == id)
    }
    /// Ticket 1002 lane 2: drops and returns the approved cards not spent in time.
    pub fn outbox_lapsed(&mut self, now: u64) -> Vec<Approved> {
        let (gone, kept) = std::mem::take(&mut self.outbox_approved)
            .into_iter()
            .partition(|a| now >= a.until);
        self.outbox_approved = kept;
        gone
    }
    /// Ticket 1002 lane 2: whether the user said yes to an Outbox card to this recipient domain.
    pub fn outbox_domain_known(&self, domain: &str) -> bool {
        self.disk.outbox_domains.iter().any(|d| d == domain)
    }
    /// Ticket 1002 lane 2: keeps `domains` as ones the user said yes to (newest last, at most `DOMAINS_MAX`).
    pub fn keep_outbox_domains(&mut self, domains: &[String]) -> Result<(), String> {
        self.change(|q| {
            let list = &mut q.disk.outbox_domains;
            for domain in domains {
                list.retain(|d| d != domain);
                list.push(domain.clone());
            }
            let over = list.len().saturating_sub(crate::outbox::DOMAINS_MAX);
            list.drain(..over);
            Ok(())
        })
    }
    /// Drops the owner items `done` matches (the owner did what they asked, or dismissed one).
    pub fn answer_owner(&mut self, done: impl Fn(&Decision) -> bool) -> Result<(), String> {
        self.change(|q| {
            q.disk.owner.retain(|i| !done(i));
            Ok(())
        })
    }
    pub fn decision(&self, id: &str) -> Result<Decision, String> {
        self.items()
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| "decision not found".into())
    }
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.change(|q| {
            for s in q.disk.sessions.values_mut() {
                s.items.retain(|i| i.id != id);
                end_view_only(&mut s.items, &q.stacked); // v1b-32 r6
                s.attention.waiting = waits(&s.items);
            }
            Ok(())
        })
    }
    pub fn connect(&mut self, now: u64) {
        self.client_until = now + 3000;
    }
    pub fn begin_hook(&mut self, event_id: &str, now: u64) -> bool {
        if self.client_until <= now {
            return false;
        }
        // A second request for an event that has a long waiter (a replay) does not cut that waiter's time.
        if !self.long.contains(event_id) {
            self.hook_until.insert(event_id.into(), now + 1400);
        }
        true
    }
    /// Ticket 991 B3: a hook that can wait (`nunchiro hook --hold`, Claude's permission hook) is held for a present
    /// window up to `HOLD_MS`, not 1.4 s. The card's answer then goes through the hook, which names its own request,
    /// so nothing depends on the screen proof (a narrow terminal wraps Claude's prompt and the proof fails). Claude
    /// 2.1.325 draws its own dialog while the hook runs, so the terminal can answer too: Claude then ends the hook's
    /// client and the server's wait ends with it (`peer_gone`). One long
    /// waiter per event and at most `HOLDS` at once: each takes one of the server's connections. False: this caller
    /// waits its 1.4 s only.
    pub fn hold_hook(&mut self, event_id: &str, now: u64) -> bool {
        let live = &self.hook_until;
        self.long
            .retain(|e| live.get(e).is_some_and(|until| *until > now));
        if self.long.len() >= HOLDS
            || self.long.contains(event_id)
            || !self.hook_until.contains_key(event_id)
        {
            return false;
        }
        self.long.insert(event_id.into());
        self.hook_until.insert(event_id.into(), now + HOLD_MS);
        true
    }
    /// Whether another caller is the event's long waiter (a short waiter then leaves the event as it is).
    pub fn long_held(&self, event_id: &str) -> bool {
        self.long.contains(event_id)
    }
    /// Whether the hook still waits: inside its time, and a window is still there to answer it.
    pub fn hook_waits(&self, event_id: &str, now: u64) -> bool {
        self.client_until > now
            && self
                .hook_until
                .get(event_id)
                .is_some_and(|until| *until > now)
    }
    pub fn hook_response(&mut self, event_id: &str) -> Option<Value> {
        self.responses.remove(event_id)
    }
    pub fn end_hook(&mut self, event_id: &str) {
        self.hook_until.remove(event_id);
        self.long.remove(event_id);
        self.responses.remove(event_id);
    }
    pub fn answer_hook(&mut self, item: &Decision, allow: bool, now: u64) -> Result<bool, String> {
        self.answer_hook_with(item, allow, None, false, now)
    }
    /// `note`: V2-8e, a deny's instruction, sent as the hook's own `message` (what Claude reads as why it was denied).
    /// `interrupt`: a deny also stops the agent's turn (look 11-17 B13).
    pub fn answer_hook_with(
        &mut self,
        item: &Decision,
        allow: bool,
        note: Option<&str>,
        interrupt: bool,
        now: u64,
    ) -> Result<bool, String> {
        if !self.hook_live(item, now) {
            return Ok(false);
        }
        let event = item.hook_event_id.as_ref().expect("live hook");
        self.remove(&item.id)?;
        let mut decision = json!({"behavior":if allow {"allow"} else {"deny"}});
        // Look 11-17 N18: a plain deny names the user too. With no message Claude read it as "a permission hook denied
        // it", and the chat's turn summary could not tell the refused command from one that ran.
        if !allow {
            decision["message"] = json!(note.unwrap_or(DENY_PLAIN));
        }
        if !allow && interrupt {
            decision["interrupt"] = json!(true);
        }
        self.responses.insert(
            event.clone(),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":decision}}),
        );
        Ok(true)
    }
    /// Whether the item's hook is still waiting for an answer.
    pub fn hook_live(&self, item: &Decision, now: u64) -> bool {
        item.hook_event_id
            .as_ref()
            .is_some_and(|e| self.hook_until.get(e).is_some_and(|until| *until > now))
    }
    /// V2-8e: the window's copy of an item: whether it is risky (`risk::risky`, from the hook's tool and input; an item
    /// with no hook tool, or from an ACP agent, stays risky), whether its deny may carry an instruction, and the
    /// session-only "don't ask again" option it offers, if any (never on a risky item). `home_lock`: the session runs
    /// with the Home seat lock (`SessionMeta::home_lock`).
    pub fn annotate(&self, item: &mut Decision, cwd: &Path, home_lock: bool) {
        if item.kind != Kind::Permission {
            return;
        }
        let acp = item.sources.contains("acp");
        let tool = self.tools.get(&item.id).filter(|t| !t.is_empty() && !acp);
        item.tool = tool.filter(|t| t.starts_with("mcp__")).cloned();
        // A Codex approval prompt is known from the screen only (no hook), so it stays risky: the agent writes the
        // command, and a command can draw rows that read as a harmless prompt (Codex look, wave 10).
        // Look v31 a S2-1: a locked seat's call of a tool on the lock's read list (the owner's mail and calendar; its
        // hook refuses every other MCP tool) only reads. The window says "read only" of a safe MCP tool, so nothing
        // else may make one safe. Without the lock the name proves nothing: a project's own server may carry it.
        let read = home_lock && tool.is_some_and(|t| crate::home_lock::reads(t));
        let input = serde_json::from_str::<Value>(&item.text).unwrap_or_default();
        // Ticket 1149: an ACP card's text is the command it asks to run (`terminal/create`) or the agent's own title.
        item.outward = match acp {
            true => crate::outward::kind("Bash", &json!({"command": item.text})),
            false => tool.and_then(|t| crate::outward::kind(t, &input)),
        }
        .map(|k| k.name().to_string());
        // Ticket 1130 S1: an outward call is never one "allow always" may cover.
        item.risky = item.outward.is_some()
            || (!read && risk::risky(tool.map(String::as_str), &item.text, cwd));
        item.deny_note = item.actionable;
        let (rules, scope) = self.session_scope(item, cwd);
        item.allow_scope = (!rules.is_empty()).then(|| scope.join(", "));
        item.allow_always = (!item.risky && !acp && item.actionable)
            .then(|| {
                item.choices
                    .iter()
                    .find(|c| c.session_only())
                    .map(|c| c.label.clone())
                    // Ticket 1030: Claude's option 2 ("Yes, and always allow access to …", "… don't ask again …")
                    // writes to its settings, so it is never typed; its hook takes the same rules for this session.
                    .or_else(|| {
                        item.allow_scope.is_some().then(|| {
                            item.choices
                                .iter()
                                .find(|c| c.option_two())
                                .map_or_else(|| SESSION_ALLOW.into(), |c| c.label.clone())
                        })
                    })
            })
            .flatten();
        if item.allow_always.is_none() {
            item.allow_scope = None; // the scope names only what the button adds
        }
    }
    /// Ticket 1030: the suggested rules "Allow for this session" may forward for this item and the words for them;
    /// empty when none is no broader than the request (`session_scope::scoped`).
    fn session_scope(&self, item: &Decision, cwd: &Path) -> (Vec<Value>, Vec<String>) {
        self.session_rules
            .get(&item.id)
            .map(|(tool, input, all)| session_scope::scoped(all, tool, input, cwd))
            .unwrap_or_default()
    }
    /// Ticket 1030: "Allow for this session" through the item's live hook: allow, with only the suggested rules no
    /// broader than the request, each kept to this session. False when the hook is gone or no rule is valid (nothing
    /// is sent).
    pub fn answer_hook_session(
        &mut self,
        item: &Decision,
        cwd: &Path,
        now: u64,
    ) -> Result<bool, String> {
        let (rules, _) = self.session_scope(item, cwd);
        if rules.is_empty() || !self.hook_live(item, now) {
            return Ok(false);
        }
        let event = item.hook_event_id.clone().expect("live hook");
        self.remove(&item.id)?;
        self.responses.insert(
            event,
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":rules}}}),
        );
        Ok(true)
    }
}

/// Ticket 1030: the label of a hook item's session allow when the screen shows no option 2 to name it.
pub const SESSION_ALLOW: &str = "Yes, allow for this session";

/// Ticket 991 B3: see `Queue::hold_hook`.
/// Look 11-17 v4f Home S2-8: 30 minutes. A Write card answered after the 5 minutes this was before went through the
/// screen, whose proof fails for a long body, and was refused. The hook names its own request, so the card answers
/// it however long it waited; the screen never has to prove a file prompt (rather than widening what the screen may
/// answer). The hold still ends when the window goes (`hook_waits`) or the terminal answers (`peer_gone`).
pub const HOLD_MS: u64 = 1_800_000;
const HOLDS: usize = 8;
/// How long after Claude's PreToolUse hook its PermissionRequest hook is expected (`hook_expected`), and the most a
/// permission frame stays hidden from its first hidden read (`hook_hidden`).
// shortcut: a fixed wait, measured on the trial agent only. Long enough for a hook a busy Mac starts 3.5 s late; with
// the tick's re-read when it ends (`hide_over`), short enough that a dialog with no hook is a card within the 5 s the
// accuracy trial allows. A hook later than this still makes a second card when the screen cannot prove the request.
const HOOK_EXPECTED_MS: u64 = 4000;

/// v1b-30: more than one hook permission pending in this session: the screen shows one prompt while the card may
/// show another request (each hook still answers for its own request).
/// Look 1117 v12 N12-S2-4: only an ask makes a session wait; a stale flag or a background note is a row state (a lead
/// running its own `sleep` in the background read "waiting" and "needs you" with Decisions empty).
/// Look v33 S3-3: an item `close` (or a restart) set aside is evidence only: a failed session whose next queue change
/// counted its old dialog read "waiting" (orange) under "Session ended unexpectedly".
fn waits(items: &[Decision]) -> bool {
    items
        .iter()
        .any(|i| !i.reconciled && !matches!(i.kind, Kind::Stale | Kind::Background))
}
fn contended(items: &[Decision], stacked: &BTreeSet<String>) -> bool {
    let hooked: Vec<&Decision> = items
        .iter()
        .filter(|i| i.kind == Kind::Permission && i.hook_event_id.is_some())
        .collect();
    hooked.len() > 1 || hooked.iter().any(|i| stacked.contains(&i.id))
}

/// Whether `item` was asked after a transcript record written at `at` (epoch ms).
fn asked_after(item: &Decision, at: u64) -> bool {
    item.kind != Kind::Stale && item.observed_at > at
}

/// v1b-32: whether the session holds a hook item the screen cannot prove frames against (contended, or unprovable).
fn holds(items: &[Decision], stacked: &BTreeSet<String>) -> bool {
    contended(items, stacked)
        || items
            .iter()
            .any(|i| !i.reconciled && i.sources.contains("hook") && unprovable(&i.text))
}

/// v1a-71: a screen-only item that can keep its id through a resize redraw: actionable, unreconciled and never
/// hook-backed (a hook item keeps its id through `own_request`).
fn redrawable(i: &Decision) -> bool {
    matches!(i.kind, Kind::Permission | Kind::Question | Kind::Dialog)
        && i.actionable
        && !i.reconciled
        && i.sources.contains("screen")
        && !i.sources.contains("hook")
        && i.hook_event_id.is_none()
        && i.screen_text.is_some()
}

fn in_grace(at: u64, now: u64) -> bool {
    now.checked_sub(at).is_some_and(|d| d <= RESIZE_GRACE_MS) // a mark from the future (clock moved back) is over
}

/// v1a-71: two screen texts of one prompt at different widths. Only layout may differ: where lines break, and the
/// whitespace and box-drawing glyphs (U+2500-257F) at line ends (rules, box sides, indents). Inside a line every
/// character counts, spaces included (security review r1: `./build/` vs `./build /`); case is kept.
fn same_prompt(old: &str, new: &str) -> bool {
    let words = |t: &str| {
        t.lines()
            .map(|l| {
                l.trim_matches(|c: char| {
                    c.is_whitespace() || ('\u{2500}'..='\u{257f}').contains(&c)
                })
            })
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    words(old) == words(new)
}

/// v1b-32 r5: a screen card made beside a held item that can send nothing (a restored item is reconciled instead).
fn view_only(i: &Decision) -> bool {
    !i.actionable && !i.reconciled && i.hook_event_id.is_none() && !i.sources.contains("hook")
}

/// v1b-32 r6: view-only cards exist only while the session holds; once it does not, they go.
fn end_view_only(items: &mut Vec<Decision>, stacked: &BTreeSet<String>) {
    if !holds(items, stacked) {
        items.retain(|i| !view_only(i));
    }
}

/// v1b-12: whether a screen frame shows the hook request whose tool input is `input` (the item text). Only the
/// prompt region counts: the lines below the last full-width rule Claude draws above every prompt, so scrollback and
/// agent prose never do; without a rule nothing matches. The region must hold the request's own prompt line (edit or
/// create/overwrite of that file, or a command prompt) and, between its dashed rules, exactly its body (every edit's
/// old and new text with no other change, the file content, or the command). Requests of any other shape never match.
/// v1b-27: a Codex screen is checked by `codex_request` instead.
/// v1b-30: a request the screen cannot prove (`unprovable`) never matches.
/// Look 11-17 N1: a question's own words (the tool input the transcript or a hook gave: the question and its
/// options) stay its card's text while a redraw of the screen still shows that question; the screen's text is the
/// dialog's tail (Claude 2.1.326 draws a rule above "4. Chat about this"), not the question.
/// Look 11-18 v9 B N-S2-1/2: a long question is wrapped inside Claude's box or cut short on screen, so the whole
/// question is never one run of the screen's words; its opening (the first 8 words, box gutters dropped) is enough.
fn asked_on_screen(kind: &Kind, input: &str, screen: &str) -> bool {
    const OPENING: usize = 8;
    let words = |t: &str| {
        t.split(|c: char| c.is_whitespace() || ('\u{2500}'..='\u{257f}').contains(&c))
            .filter(|w| !w.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    // Look 1117 v10 N10-S2-5: Claude draws the plan above a rule and its question below it ("Claude has written up a
    // plan … Would you like to proceed?"), so the prompt never shows the plan: the plan dialog is the plan's own. Claude
    // asks one plan at a time, and a newer plan's hook replaces the card's text.
    if *kind == Kind::Question
        && let Ok(v) = serde_json::from_str::<Value>(input)
        && v["plan"].is_string()
    {
        return crate::waiting::screen::plan_dialog(&words(screen).join(" ").to_lowercase());
    }
    *kind == Kind::Question
        && serde_json::from_str::<Value>(input).is_ok_and(|v| {
            v["questions"][0]["question"]
                .as_str()
                .or(v["question"].as_str())
                .is_some_and(|q| {
                    let q = words(q);
                    let n = q.len().min(OPENING);
                    let screen = words(screen);
                    // Codex look w16: from a matching opening the screen must go on with this question's words until
                    // it ends, is cut ("choose…") or leaves the text (a mark such as "❯" or "1."); another question
                    // that shares the opening differs at a word and is not this one.
                    n > 0
                        && (0..screen.len().saturating_sub(n - 1)).any(|i| {
                            screen[i..i + n] == q[..n] && {
                                let rest = &screen[i + n..];
                                let same =
                                    rest.iter().zip(&q[n..]).take_while(|(a, b)| a == b).count();
                                match rest.get(same) {
                                    None => true,
                                    Some(_) if same == q.len() - n => true,
                                    Some(w) => match w.strip_suffix('…') {
                                        Some(stem) => q[n + same].starts_with(stem),
                                        None => !w.starts_with(char::is_alphanumeric),
                                    },
                                }
                            }
                        })
                })
        })
}
/// Look C N5, Home look S2-8 (11-17): whether a permission frame `own_request` cannot prove still shows the hook's
/// command, wrapped by a narrower terminal: each command line is a run of whole screen lines that, without spaces and
/// the gutter, reads as that line without spaces. Another command (one with an extra flag) does not.
fn redrawn(screen: &str, input: &str) -> bool {
    let bare = |t: &str| {
        t.chars()
            .filter(|c| !c.is_whitespace() && *c != '\u{2502}')
            .collect::<String>()
    };
    let v = serde_json::from_str::<Value>(input).unwrap_or(Value::Null);
    // Look 11-17 v4 Home S2-8: a file tool's prompt (Write, Edit, NotebookEdit) whose body does not fit the screen. It
    // is its own when its question names the file and every body row it does show is a line of this request (a long
    // content cut short is fine; another content, or another line in it, is another request).
    if let Some(path) = v["file_path"].as_str().or(v["notebook_path"].as_str()) {
        let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
        let flat = screen
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let asks = [
            "do you want to create ",
            "do you want to overwrite ",
            "make this edit to ",
        ]
        .iter()
        .any(|q| flat.contains(&format!("{q}{name}?")));
        let known: std::collections::BTreeSet<&str> =
            ["content", "new_string", "old_string", "new_source"]
                .iter()
                .filter_map(|k| v[*k].as_str())
                .flat_map(str::lines)
                .collect();
        let dashed =
            |l: &str| l.trim().chars().count() >= 20 && l.trim().chars().all(|c| c == '\u{254c}');
        let lines: Vec<&str> = screen.lines().collect();
        let marks: Vec<usize> = (0..lines.len()).filter(|&i| dashed(lines[i])).collect();
        let body = match (marks.first(), marks.last()) {
            (Some(&top), Some(&bottom)) if top < bottom => &lines[top + 1..bottom],
            _ => &lines[..0],
        };
        let shown = |row: &str| {
            let t = row.trim_start();
            let rest = t.trim_start_matches(|c: char| c.is_ascii_digit());
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            let bare = rest.strip_prefix(['+', '-', ' ']).unwrap_or(rest);
            t.is_empty()
                // Claude's own cut marks.
                || rest.trim_start().starts_with('\u{2026}')
                || rest.trim() == "..."
                || known.contains(rest)
                || known.contains(bare)
        };
        return asks && body.iter().all(|r| shown(r));
    }
    let Some(command) = v["command"].as_str().map(str::to_string) else {
        return false;
    };
    let rows: Vec<String> = screen.lines().map(bare).collect();
    let mut wanted = command
        .lines()
        .map(bare)
        .filter(|l| !l.is_empty())
        .peekable();
    wanted.peek().is_some()
        && wanted.all(|want| {
            (0..rows.len()).any(|from| {
                let mut run = String::new();
                !rows[from].is_empty()
                    && rows[from..].iter().any(|row| {
                        run.push_str(row);
                        run == want
                    })
            })
        })
}
fn own_request(agent: AgentKind, screen: &str, input: &str) -> bool {
    if unprovable(input) {
        return false;
    }
    if agent == AgentKind::Codex {
        return codex_request(screen, input);
    }
    let flat = |t: &str| {
        t.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    let lines: Vec<&str> = screen.lines().collect();
    let Some(rule) = lines.iter().rposition(|l| {
        let t = l.trim();
        t.chars().count() >= 20 && t.chars().all(|c| c == '\u{2500}')
    }) else {
        return false;
    };
    let region_lines = &lines[rule + 1..];
    let Ok(v) = serde_json::from_str::<Value>(input) else {
        return false;
    };
    // The body sits between the first and last dashed rule of the region (Claude draws one above and one below it);
    // without both nothing matches.
    let dashed = |l: &str| {
        let t = l.trim();
        t.chars().count() >= 20 && t.chars().all(|c| c == '\u{254c}')
    };
    let marks: Vec<usize> = (0..region_lines.len())
        .filter(|&i| dashed(region_lines[i]))
        .collect();
    let (Some(&top), Some(&bottom)) = (marks.first(), marks.last()) else {
        return false;
    };
    // Exactly one rule above and one below the body; any other dashed line inside is not proven to be this request.
    if marks.len() != 2 {
        return false;
    }
    // v1b-27: the prompt's question is read whole from below the body; the body (the agent's own text) never decides
    // what kind of prompt this is. Ticket 991 B7: Claude 2.1.325 may put a note line between the body and the question
    // ("This command requires approval"), so it is the last line above the first option.
    let below = &region_lines[bottom + 1..];
    let options = below
        .iter()
        .position(|l| crate::waiting::screen::choice_row(l).is_some())
        .unwrap_or(below.len());
    let question = below[..options]
        .iter()
        .rfind(|l| !l.trim().is_empty())
        .map(|l| flat(l))
        .unwrap_or_default();
    // The block between the rules, without blank padding at its ends. Text is compared exactly (indentation and
    // blank lines count); only the screen's trailing spaces go, as it draws none (v1b-30: see `unprovable`).
    let mut inner: Vec<&str> = region_lines[top + 1..bottom]
        .iter()
        .copied()
        .filter(|l| !dashed(l))
        .collect();
    while inner.first().is_some_and(|l| l.trim().is_empty()) {
        inner.remove(0);
    }
    while inner.last().is_some_and(|l| l.trim().is_empty()) {
        inner.pop();
    }
    // v1b-30: request lines are taken as they are; one with trailing whitespace never reaches here.
    let lines = |t: &Value| -> Option<Vec<String>> {
        Some(t.as_str()?.lines().map(str::to_string).collect())
    };
    // Claude's diff gutter, by position: the line number, one space, one marker column (`+` new, `-` old, ` `
    // context in both files), then the line's own text. A line without that gutter (a fold marker such as `…`,
    // "+N lines", any other text) makes the block unproven.
    // v1b-27: the gutter is a column: every row's right-aligned number ends where the first row's does, so a
    // wrapped continuation whose text starts `12 +foo` is no row. Trailing spaces go (the screen draws none).
    let number_end = |l: &str| {
        let rest = l.trim_start_matches(' ');
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        (digits > 0).then_some(l.len() - rest.len() + digits)
    };
    let column = inner.first().and_then(|l| number_end(l));
    let gutter = |l: &str| -> Option<(char, String)> {
        let end = number_end(l).filter(|e| Some(*e) == column)?;
        let rest = &l[end..];
        if rest.is_empty() {
            return Some((' ', String::new()));
        }
        let mut chars = rest.strip_prefix(' ')?.chars();
        let mark = match chars.next() {
            None => ' ',
            Some(c @ ('+' | '-' | ' ')) => c,
            Some(_) => return None,
        };
        Some((mark, chars.as_str().trim_end().to_string()))
    };
    let block: Option<Vec<(char, String)>> = inner.iter().map(|l| gutter(l)).collect();
    if let Some(path) = v["file_path"].as_str() {
        let name = flat(path.rsplit('/').next().unwrap_or(path));
        let Some(block) = block else {
            return false;
        };
        if name.is_empty() {
            return false;
        }
        if v.get("content").is_some() {
            let Some(want) = lines(&v["content"]) else {
                return false;
            };
            // A create shows the new file's lines, and nothing removed.
            if question == format!("do you want to create {name}?") {
                return block.iter().all(|(m, _)| *m != '-')
                    && block.iter().map(|(_, t)| t.clone()).eq(want);
            }
            // v1b-27: an overwrite shows one old->new hunk with 3 context lines. Its new side (context and `+`) must
            // be the whole new file: the hunk starts at line 1 and ends with fewer than 3 context rows (3 could hide
            // more unchanged lines below). The removed lines are the old file's and do not change what is written.
            let trailing = block.iter().rev().take_while(|(m, _)| *m == ' ').count();
            return question == format!("do you want to overwrite {name}?")
                && inner
                    .first()
                    .is_some_and(|l| l.trim_start().starts_with("1 "))
                && trailing < 3
                && side_text(&block, '+') == want;
        }
        let edits: Vec<&Value> = match v["edits"].as_array() {
            Some(edits) if !edits.is_empty() => edits.iter().collect(),
            Some(_) => return false,
            None => vec![&v],
        };
        let mut want = vec![];
        for e in edits {
            let (Some(old), Some(new)) = (lines(&e["old_string"]), lines(&e["new_string"])) else {
                return false;
            };
            if old.is_empty() && new.is_empty() {
                return false;
            }
            want.push((old, new));
        }
        return question == format!("do you want to make this edit to {name}?")
            && edits_shown(&block, &want);
    }
    if v["command"].is_string() {
        // The command fills the block, line for line, after the one column Claude indents it by (its own
        // indentation counts: a heredoc or `python -c` shifted further is another command).
        let shown: Option<Vec<String>> = inner
            .iter()
            .map(|l| match l.trim_end() {
                "" => Some(String::new()),
                t => t.strip_prefix(' ').map(str::to_string),
            })
            .collect();
        let Some(shown) = shown else {
            return false;
        };
        return question == "do you want to proceed?"
            && lines(&v["command"]).is_some_and(|c| !c.is_empty() && shown == c);
    }
    false
}

/// v1b-30: whether the screen cannot prove this request whatever it shows, so a late answer is refused and the card
/// waits for its hook or the terminal: a line the screen must match (Edit old/new text, Write content, the command)
/// ends in whitespace (the screen drops it, so `a ` and `a` would look the same; `\r` of a CRLF counts), or the
/// command spans lines. Other fields (a Bash description) are not matched and do not count.
fn unprovable(input: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(input) else {
        return false;
    };
    let mut body: Vec<&Value> = vec![&v["content"], &v["old_string"], &v["new_string"]];
    if let Some(edits) = v["edits"].as_array() {
        body.extend(
            edits
                .iter()
                .flat_map(|e| [&e["old_string"], &e["new_string"]]),
        );
    }
    if v["command"]
        .as_str()
        .is_some_and(|c| c.contains(['\n', '\r']))
    {
        return true;
    }
    body.push(&v["command"]);
    body.iter()
        .filter_map(|t| t.as_str())
        .flat_map(|t| t.split('\n'))
        .any(|l| l.ends_with(char::is_whitespace))
}

/// v1b-32: whether a Claude frame provably shows a prompt that is none of these held hook requests (tool, input), by
/// the question Claude asks. The tool decides which question its own prompt asks: Edit, MultiEdit and Write name
/// their file, Bash asks "Do you want to proceed?"; any other tool may ask that, or name any string of its input,
/// however nested (r2, r3). A held name the screen cannot draw as it is (a mark the screen drops, a character outside
/// `delivery::shown`, a `\` path) proves nothing, nor does a held item whose tool was never recorded (r3). No line
/// anywhere on the screen may ask a held request's question, and every permission question on it must be read whole (cut off, another form, or a name cut short with `…`
/// refuse). A permission frame's prompt is a question below the last full-width rule. A dialog proves itself only
/// with no permission question, no dashed body rule and no tool header (it can only be answered with Esc), and so
/// does a question frame. Codex never proves it. r5: this decides only whether a frame shows as a card beside a held
/// item (its own prompt does not); the card never answers anything but a dialog's Esc (see `upsert`).
fn other_prompt(
    agent: AgentKind,
    kind: &Kind,
    screen: &str,
    held: &[(Option<&str>, &str)],
) -> bool {
    if agent != AgentKind::Claude || held.is_empty() {
        return false;
    }
    let flat = |t: &str| {
        t.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    let base = |name: &str| name.rsplit('/').next().unwrap_or(name).to_string();
    // v1b-32 r2: a held name, as the screen would draw it, or `None` when the screen could not draw it as it is.
    let name = |path: &str| {
        let drawn = path.chars().all(|c| {
            crate::delivery::shown(c) && !('\u{300}'..='\u{36f}').contains(&c) && c != '\\'
        });
        Some(base(&flat(path))).filter(|n| drawn && !n.is_empty())
    };
    // What each held request's question names: its file, or "" for "Do you want to proceed?".
    let mut own = vec![];
    for (tool, input) in held {
        let Ok(v) = serde_json::from_str::<Value>(input) else {
            return false;
        };
        // v1b-32 r3: a tool never recorded (no event id, restart, re-identified item) proves nothing.
        let Some(tool) = tool else {
            return false;
        };
        match *tool {
            "Edit" | "MultiEdit" | "Write" => {
                let Some(file) = v["file_path"].as_str().and_then(name) else {
                    return false;
                };
                own.push(file);
            }
            "Bash" => own.push(String::new()),
            _ => {
                own.push(String::new());
                // v1b-32 r3: every string of the input, however nested; past 8 levels or 256 values it may name
                // anything.
                let mut walk = vec![(&v, 0)];
                let mut seen = 0;
                while let Some((value, depth)) = walk.pop() {
                    seen += 1;
                    if depth > 8 || seen > 256 {
                        return false;
                    }
                    // v1b-32 r4: numbers, booleans and object keys are its own too.
                    let mut texts = vec![];
                    match value {
                        Value::String(text) => texts.push(text.clone()),
                        Value::Number(n) => texts.push(n.to_string()),
                        Value::Bool(b) => texts.push(b.to_string()),
                        Value::Array(items) => walk.extend(items.iter().map(|i| (i, depth + 1))),
                        Value::Object(fields) => {
                            texts.extend(fields.keys().cloned());
                            walk.extend(fields.values().map(|i| (i, depth + 1)))
                        }
                        Value::Null => {}
                    }
                    for text in texts {
                        let Some(file) = name(&text) else {
                            return false;
                        };
                        own.push(file);
                    }
                }
            }
        }
    }
    // A line's permission question: what it names, `Some(None)` when it asks one that cannot be read whole.
    let ask = |l: &str| -> Option<Option<String>> {
        if l.contains("do you want to proceed?") {
            return Some(Some(String::new()));
        }
        for p in [
            "do you want to make this edit to ",
            "do you want to create ",
            "do you want to overwrite ",
        ] {
            if let Some(at) = l.find(p) {
                return Some(
                    l[at + p.len()..]
                        .strip_suffix('?')
                        .filter(|n| !n.contains('\u{2026}'))
                        .map(base)
                        .filter(|n| !n.is_empty()),
                );
            }
        }
        // A question cut off mid-draw, or one of another form, is not read.
        ["do you want to", "would you like to run", "this time"]
            .iter()
            .any(|p| l.contains(p))
            .then_some(None)
    };
    let lines: Vec<String> = screen.lines().map(flat).collect();
    let mut asked = vec![];
    for l in &lines {
        match ask(l) {
            Some(Some(q)) => asked.push(q),
            Some(None) => return false,
            None => {}
        }
    }
    if asked.iter().any(|q| own.contains(q)) {
        return false;
    }
    if *kind != Kind::Permission {
        // v1b-32 r2: a held prompt in a wording not known here still shows its body rules or tool header.
        let prompt_part = |l: &String| {
            (l.chars().count() >= 20 && l.chars().all(|c| c == '\u{254c}'))
                || [
                    "bash command",
                    "edit file",
                    "create file",
                    "overwrite file",
                    "read file",
                    "tool use",
                ]
                .contains(&l.as_str())
        };
        return asked.is_empty() && !lines.iter().any(prompt_part);
    }
    let Some(rule) = screen.lines().collect::<Vec<_>>().iter().rposition(|l| {
        let t = l.trim();
        t.chars().count() >= 20 && t.chars().all(|c| c == '\u{2500}')
    }) else {
        return false;
    };
    lines[rule + 1..].iter().any(|l| ask(l).is_some())
}

/// v1b-27: one side of a diff block: its context lines and those with `mark` (`-` old file, `+` new file).
fn side_text(span: &[(char, String)], mark: char) -> Vec<String> {
    span.iter()
        .filter(|(m, _)| *m == ' ' || *m == mark)
        .map(|(_, t)| t.clone())
        .collect()
}

/// v1b-27: whether a Codex screen shows its approval prompt for exactly this one-line command. The region is what
/// follows the last "Would you like to run the following command?" line: its only `$ ` line, the last before the
/// choices, is the command; below the choices only choices and the confirm hint, which ends the screen. Anything
/// else (a multi-line or wrapped command, a second `$ ` line, another prompt drawn below) is unproven.
fn codex_request(screen: &str, input: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(input) else {
        return false;
    };
    let Some(command) = v["command"].as_str().map(str::trim_end) else {
        return false;
    };
    if command.is_empty() || command.contains('\n') {
        return false;
    }
    let lines: Vec<&str> = screen.lines().map(str::trim).collect();
    let Some(prompt) = lines
        .iter()
        .rposition(|l| *l == "Would you like to run the following command?")
    else {
        return false;
    };
    let region: Vec<&str> = lines[prompt + 1..]
        .iter()
        .copied()
        .filter(|l| !l.is_empty())
        .collect();
    let choice = |l: &str| {
        let l = l.trim_start_matches(['›', ' ']);
        let digits = l.len() - l.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        digits > 0 && l[digits..].starts_with(". ")
    };
    let Some(first) = region.iter().position(|l| choice(l)) else {
        return false;
    };
    let shown: Vec<&str> = region[..first]
        .iter()
        .filter(|l| l.starts_with("$ "))
        .copied()
        .collect();
    let (choices, hint) = region[first..].split_at(region.len() - first - 1);
    // One `$ ` line before the choices means `first` > 0.
    shown.len() == 1
        && region[first - 1] == shown[0]
        && shown[0] == format!("$ {command}")
        && choices.iter().all(|l| choice(l))
        && *hint == ["Press enter to confirm or esc to cancel"]
}

/// v1b-12: whether a diff block shows exactly these edits: each as one span, in order, whose old-file lines
/// (context and `-`) are its old text and whose new-file lines (context and `+`) are its new text; every `+` or `-`
/// line of the block belongs to one of the spans (only unchanged context may sit outside them). v1b-27: both sides come from `side_text`.
fn edits_shown(block: &[(char, String)], edits: &[(Vec<String>, Vec<String>)]) -> bool {
    let mut at = 0;
    let mut covered = vec![false; block.len()];
    for (old, new) in edits {
        let span = (at..block.len()).find_map(|p| {
            (p + 1..=block.len())
                .find(|&q| {
                    side_text(&block[p..q], '-') == *old && side_text(&block[p..q], '+') == *new
                })
                .map(|q| (p, q))
        });
        let Some((p, q)) = span else {
            return false;
        };
        covered[p..q].fill(true);
        at = q;
    }
    // Outside the edits only unchanged file context (a gutter row marked ` `): Claude 2.1.325 draws up to 3 lines of it
    // around each change (ticket 991 B3). Every `+`/`-` row still belongs to a span, and a fold marker or other text has
    // no gutter, so `block` already refused it.
    covered
        .iter()
        .zip(block)
        .all(|(inside, (mark, _))| *inside || *mark == ' ')
}

// v1a-23: owner items in the store.
#[cfg(test)]
mod turn_ends;
#[cfg(test)]
mod owner_tests {
    use super::*;

    fn home(tag: &str) -> PathBuf {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("queue-owner-{tag}-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        home
    }
    fn widget(hash: &str) -> OwnerAsk {
        OwnerAsk::Approval {
            subject: crate::approval::SubjectKind::Widget,
            name: "w".into(),
            level: crate::approval::Level::Read,
            hash: hash.into(),
        }
    }

    #[test]
    fn one_item_per_subject_survives_a_reopen() {
        let home = home("reopen");
        let mut q = Queue::open(&home).unwrap();
        let first = q.ask_owner("s1", widget("a")).unwrap();
        assert_eq!(q.ask_owner("s2", widget("a")).unwrap(), first);
        let second = q.ask_owner("s1", widget("b")).unwrap();
        assert_ne!(second, first, "a new hash replaces the ask");
        q.ask_owner(
            "s1",
            OwnerAsk::PermissionAnswers {
                project: "/p".into(),
            },
        )
        .unwrap();
        let items = Queue::open(&home).unwrap().owner_items();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.actionable && i.kind == Kind::Owner));
        assert_eq!(items[0].owner, Some(widget("b")));
        // Session callers' lookup never finds an owner item.
        assert!(q.decision(&second).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_setup_ask_for_a_gone_worktree_is_dropped_on_load() {
        let home = home("setup-gone");
        let setup = |name: &str| OwnerAsk::Setup {
            path: home.join("wt").join(name),
            hash: "h".into(),
        };
        fs::create_dir_all(home.join("wt/kept")).unwrap();
        fs::create_dir_all(home.join("wt/gone")).unwrap();
        let mut q = Queue::open(&home).unwrap();
        q.ask_owner("s1", setup("kept")).unwrap();
        q.ask_owner("s1", setup("gone")).unwrap();
        // A parent that is not there (an unmounted volume) is no proof the worktree went.
        let unmounted = OwnerAsk::Setup {
            path: home.join("no-volume/wt"),
            hash: "h".into(),
        };
        q.ask_owner("s1", unmounted.clone()).unwrap();
        // A folder that cannot be looked into (no search permission) is no proof either.
        use std::os::unix::fs::PermissionsExt;
        let locked = home.join("locked");
        fs::create_dir(&locked).unwrap();
        let unreadable = OwnerAsk::Setup {
            path: locked.join("wt"),
            hash: "h".into(),
        };
        q.ask_owner("s1", unreadable.clone()).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        fs::remove_dir(home.join("wt/gone")).unwrap();
        let owners: Vec<_> = Queue::open(&home)
            .unwrap()
            .owner_items()
            .into_iter()
            .filter_map(|i| i.owner)
            .collect();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(owners, vec![setup("kept"), unmounted, unreadable]);
        fs::remove_dir_all(home).unwrap();
    }

    // A worktree removed while the core runs (auto-clean, git worktree remove, rm): the core's sweep drops its ask too.
    #[test]
    fn a_setup_ask_for_a_gone_worktree_is_dropped_by_the_sweep() {
        let home = home("setup-sweep");
        let setup = |name: &str| OwnerAsk::Setup {
            path: home.join("wt").join(name),
            hash: "h".into(),
        };
        fs::create_dir_all(home.join("wt/kept")).unwrap();
        fs::create_dir_all(home.join("wt/gone")).unwrap();
        let mut q = Queue::open(&home).unwrap();
        q.ask_owner("s1", setup("kept")).unwrap();
        q.ask_owner("s1", setup("gone")).unwrap();
        fs::remove_dir(home.join("wt/gone")).unwrap();
        q.drop_gone_setups().unwrap();
        let owners: Vec<_> = q
            .owner_items()
            .into_iter()
            .filter_map(|i| i.owner)
            .collect();
        assert_eq!(owners, vec![setup("kept")]);
        fs::remove_dir_all(home).unwrap();
    }

    const SEND: &str = "mcp__gmail__send_message";
    fn outward(body: &str) -> OwnerAsk {
        let args = json!({"to":["a@b.co"],"subject":"s","body":body});
        OwnerAsk::Outward {
            hash: crate::approval::outward_call_hash(SEND, &args),
            tool: SEND.into(),
            args,
            source: None,
            new_domains: vec!["b.co".into()],
            from: "Chief".into(),
            yes_at: None,
        }
    }

    // Ticket 1002 lane 2: one card per exact copy; only Outbox cards older than the limit expire, and a tick with
    // none that old writes nothing.
    #[test]
    fn outbox_cards_bind_their_copy_and_expire() {
        let home = home("outbox");
        let mut q = Queue::open(&home).unwrap();
        let a = q.ask_owner("s1", outward("hi")).unwrap();
        assert_eq!(q.ask_owner("s1", outward("hi")).unwrap(), a);
        let b = q.ask_owner("s1", outward("hi!")).unwrap();
        assert_ne!(a, b);
        q.ask_owner("s1", widget("w")).unwrap();
        assert_eq!(q.owner_items().len(), 3);
        let file = home.join("queue.json");
        let saved = fs::metadata(&file).unwrap().modified().unwrap();
        let now = now_ms();
        let is = |i: &Decision| matches!(i.owner, Some(OwnerAsk::Outward { .. }));
        assert!(q.expire_owner(now, 60_000, is).unwrap().is_empty());
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), saved);
        let gone = q.expire_owner(now + 120_000, 60_000, is).unwrap();
        assert_eq!(gone.len(), 2);
        let left = Queue::open(&home).unwrap().owner_items();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].owner, Some(widget("w")));
        fs::remove_dir_all(home).unwrap();
    }

    // Ticket 1002 lane 2: a yes is spendable once, only after its undo time, only for the exact call and by the session
    // that staged it, until it lapses; neither the yes nor the approval is kept on disk.
    #[test]
    fn an_approved_card_is_spent_once() {
        let home = home("spend");
        let mut q = Queue::open(&home).unwrap();
        let id = q.ask_owner("s1", outward("hi")).unwrap();
        let Some(OwnerAsk::Outward { hash, .. }) = q.owner_decision(&id).unwrap().owner else {
            panic!()
        };
        let none = |_: &Decision| vec![];
        let (undo, spend) = (10_000, 600_000);
        assert!(
            q.outbox_spend("s1", SEND, &hash, 0).is_none(),
            "asked, not approved"
        );
        // A yes undone within its 10 s is never approved.
        q.outbox_yes(&id, Some(1_000));
        assert!(q.outbox_ripe(10_999, undo, spend, none).unwrap().is_empty());
        q.outbox_yes(&id, None);
        assert!(q.outbox_ripe(99_000, undo, spend, none).unwrap().is_empty());
        assert!(q.outbox_spend("s1", SEND, &hash, 99_000).is_none());
        assert_eq!(q.owner_items().len(), 1, "the undone card waits again");
        // The yes is memory only: the store never has it, and a reopened queue has none.
        q.outbox_yes(&id, Some(100_000));
        assert_eq!(
            q.owner_items()[0].owner.as_ref().map(|o| matches!(
                o,
                OwnerAsk::Outward {
                    yes_at: Some(_),
                    ..
                }
            )),
            Some(true)
        );
        assert!(
            !fs::read_to_string(home.join("queue.json"))
                .unwrap()
                .contains("yes_at")
        );
        assert!(
            Queue::open(&home)
                .unwrap()
                .outbox_ripe(999_999, undo, spend, none)
                .unwrap()
                .is_empty()
        );
        // Left alone: approved after 10 s, the card leaves the owner list.
        assert_eq!(q.outbox_ripe(110_000, undo, spend, none).unwrap().len(), 1);
        assert!(q.owner_items().is_empty());
        assert!(
            q.outbox_spend("s1", SEND, &"0".repeat(64), 110_001)
                .is_none(),
            "another call"
        );
        assert!(
            q.outbox_spend("s1", "mcp__gmail__reply", &hash, 110_001)
                .is_none(),
            "another tool"
        );
        assert!(
            q.outbox_spend("s2", SEND, &hash, 110_001).is_none(),
            "another session"
        );
        assert_eq!(q.outbox_spend("s1", SEND, &hash, 110_001).unwrap().id, id);
        assert!(
            q.outbox_spend("s1", SEND, &hash, 110_002).is_none(),
            "spent once"
        );
        // Another approved card lapses after 10 minutes unspent.
        let id2 = q.ask_owner("s1", outward("again")).unwrap();
        let Some(OwnerAsk::Outward { hash: h2, .. }) = q.owner_decision(&id2).unwrap().owner else {
            panic!()
        };
        q.outbox_yes(&id2, Some(200_000));
        q.outbox_ripe(210_000, undo, spend, none).unwrap();
        assert!(q.outbox_lapsed(809_999).is_empty());
        assert_eq!(q.outbox_lapsed(810_000)[0].id, id2);
        assert!(q.outbox_spend("s1", SEND, &h2, 800_000).is_none());
        fs::remove_dir_all(home).unwrap();
    }

    // Ticket 1002 lane 2: a newer core's owner kind is left out at load; the rest of the store opens, and the card is
    // written back untouched.
    #[test]
    fn an_unknown_owner_kind_is_left_out() {
        let home = home("unknown-kind");
        let mut q = Queue::open(&home).unwrap();
        q.ask_owner("s1", widget("a")).unwrap();
        q.ask_owner("s1", outward("x")).unwrap();
        drop(q);
        let mut disk: Value =
            serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
        disk["owner"][1]["owner"]["type"] = json!("from_the_future");
        fs::write(home.join("queue.json"), serde_json::to_vec(&disk).unwrap()).unwrap();
        let mut q = Queue::open(&home).unwrap();
        let items = q.owner_items();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].owner, Some(widget("a")));
        // Round 2: kept as it was, through a save that changes the store, for the newer core to read again.
        q.ask_owner("s1", widget("b")).unwrap();
        drop(q);
        let again: Value =
            serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
        let kept: Vec<&Value> = again["owner"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["owner"]["type"] == "from_the_future")
            .collect();
        assert_eq!(kept, [&disk["owner"][1]]);
        assert!(
            Queue::open(&home)
                .unwrap()
                .owner_items()
                .iter()
                .all(|i| i.owner.is_some())
        );
        // A known kind that is broken still refuses the store.
        disk["owner"][1]["owner"]["type"] = json!("outward");
        disk["owner"][1]["owner"]["hash"] = json!(7);
        fs::write(home.join("queue.json"), serde_json::to_vec(&disk).unwrap()).unwrap();
        assert!(Queue::open(&home).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    // Ticket 1002 lane 2: the kept recipient domains survive a reopen, newest last, at most DOMAINS_MAX.
    #[test]
    fn outbox_domains_are_kept_and_capped() {
        let home = home("domains");
        let mut q = Queue::open(&home).unwrap();
        for n in 0..crate::outbox::DOMAINS_MAX + 2 {
            q.keep_outbox_domains(&[format!("d{n}.co")]).unwrap();
        }
        q.keep_outbox_domains(&["d2.co".into()]).unwrap();
        let q = Queue::open(&home).unwrap();
        assert!(!q.outbox_domain_known("d0.co") && !q.outbox_domain_known("d1.co"));
        assert!(q.outbox_domain_known("d2.co") && q.outbox_domain_known("d65.co"));
        assert_eq!(q.disk.outbox_domains.len(), crate::outbox::DOMAINS_MAX);
        assert_eq!(q.disk.outbox_domains.last().unwrap(), "d2.co");
        fs::remove_dir_all(home).unwrap();
    }

    // Look v33 S3-3: a failed session's closed items never make it wait again when a later change recounts them.
    #[test]
    fn a_closed_sessions_old_item_never_waits_again() {
        let home = home("closed-waits");
        let mut q = Queue::open(&home).unwrap();
        q.register("s1", AgentKind::Claude, 1).unwrap();
        let ask = json!({"tool_name":"Bash","tool_input":{"command":"touch x"}});
        q.observe("s1", "PermissionRequest", &ask, "hook", 2)
            .unwrap();
        assert!(q.attention("s1").waiting);
        q.close("s1", true).unwrap();
        assert!(!q.attention("s1").waiting && q.attention("s1").failed);
        q.remove("another-item").unwrap(); // any later change recounts every session
        assert!(!q.attention("s1").waiting);
        fs::remove_dir_all(home).unwrap();
    }

    // Seeing the same request again keeps the item's id and its first time, so oldest-first order holds.
    #[test]
    fn a_repeated_sighting_keeps_the_first_time() {
        let home = home("first-time");
        let mut q = Queue::open(&home).unwrap();
        q.register("s1", AgentKind::Claude, 1).unwrap();
        let ask = json!({"tool_name":"Bash","tool_input":{"command":"touch x"}});
        q.observe("s1", "PermissionRequest", &ask, "hook", 2)
            .unwrap();
        let first = q.items()[0].clone();
        q.observe("s1", "PermissionRequest", &ask, "hook", 5)
            .unwrap();
        let again = &q.items()[0];
        assert_eq!(
            (again.id.as_str(), again.observed_at),
            (first.id.as_str(), 2)
        );
        fs::remove_dir_all(home).unwrap();
    }

    // v1b-40: owner items stay actionable across a reopen, so they are the item a set-aside file must not bring back.
    #[test]
    fn queue_newer_version_set_aside() {
        let home = home("aside");
        let mut q = Queue::open(&home).unwrap();
        q.register("s1", AgentKind::Claude, 1).unwrap();
        q.observe(
            "s1",
            "PermissionRequest",
            &json!({"tool_name":"Bash","tool_input":{"command":"touch x"}}),
            "hook",
            2,
        )
        .unwrap();
        q.ask_owner("s1", widget("a")).unwrap();
        drop(q);
        let mut disk: Value =
            serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
        // V2-1a: this core reads 1 and 2, so 3 is the newer core's.
        disk["version"] = json!(3);
        let bytes = serde_json::to_vec(&disk).unwrap();
        fs::write(home.join("queue.json"), &bytes).unwrap();
        let q = Queue::open(&home).unwrap();
        assert!(q.items().is_empty());
        assert!(q.owner_items().is_empty());
        assert!(!home.join("queue.json").exists());
        let kept = store::aside_fixture::asides(&home);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].0.starts_with("queue.json.v3."), "{}", kept[0].0);
        assert_eq!(kept[0].1, bytes);
        drop(q);
        // A later start does not find the kept items either.
        let q = Queue::open(&home).unwrap();
        assert!(q.items().is_empty() && q.owner_items().is_empty());
        fs::remove_dir_all(home).unwrap();
    }

    // v1b-40 r2: a newer core's queue past this core's 8 MiB cap is set aside too; an over-cap version 1 is still refused.
    #[test]
    fn an_over_cap_newer_queue_is_set_aside() {
        let home = home("over-cap");
        let pad = "x".repeat(MAX_STORE as usize + 1);
        let v1 = format!(r#"{{"version":1,"sessions":{{}},"seen":{{}},"pad":"{pad}"}}"#);
        fs::write(home.join("queue.json"), &v1).unwrap();
        assert_eq!(
            Queue::open(&home).err().as_deref(),
            Some("invalid queue file")
        );
        assert_eq!(fs::read(home.join("queue.json")).unwrap(), v1.as_bytes());
        // Only an object: an over-cap array or a version without its object stays malformed.
        for bad in [
            format!("[2{}]", " ".repeat(pad.len())),
            format!(" [{{\"version\":2,\"pad\":\"{pad}\"}}]"),
        ] {
            fs::write(home.join("queue.json"), &bad).unwrap();
            assert_eq!(
                Queue::open(&home).err().as_deref(),
                Some("invalid queue file")
            );
            assert_eq!(fs::read(home.join("queue.json")).unwrap(), bad.as_bytes());
        }
        let v2 = format!(r#"{{"pad":"{pad}","version":3}}"#);
        fs::write(home.join("queue.json"), &v2).unwrap();
        let q = Queue::open(&home).unwrap();
        assert!(q.items().is_empty() && q.owner_items().is_empty());
        let kept = store::aside_fixture::asides(&home);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].1 == v2.as_bytes());
        fs::remove_dir_all(home).unwrap();
    }

    // V2-1a: a v1 queue is read, copied once to `queue.json.v1`, and written as version 2.
    #[test]
    fn queue_v1_backup_kept() {
        let home = home("v1");
        let mut q = Queue::open(&home).unwrap();
        q.ask_owner("s1", widget("a")).unwrap();
        drop(q);
        let mut disk: Value =
            serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
        assert_eq!(disk["version"], 2);
        disk["version"] = json!(1);
        let v1 = serde_json::to_vec(&disk).unwrap();
        fs::write(home.join("queue.json"), &v1).unwrap();
        let mut q = Queue::open(&home).unwrap();
        assert_eq!(q.owner_items().len(), 1);
        assert_eq!(fs::read(home.join("queue.json.v1")).unwrap(), v1);
        // Replaces the item (same widget, new hash), so the queue is written.
        q.ask_owner("s1", widget("b")).unwrap();
        let written: Value =
            serde_json::from_slice(&fs::read(home.join("queue.json")).unwrap()).unwrap();
        assert_eq!(written["version"], 2);
        drop(q);
        assert_eq!(Queue::open(&home).unwrap().owner_items().len(), 1);
        assert_eq!(fs::read(home.join("queue.json.v1")).unwrap(), v1);
        fs::remove_dir_all(home).unwrap();
    }

    // v1b-40 r2: the queue is opened before it is judged; a FIFO in its place is refused, not waited on.
    #[test]
    fn a_fifo_queue_is_refused_without_hanging() {
        let home = home("fifo");
        let fifo = std::ffi::CString::new(
            home.join("queue.json")
                .into_os_string()
                .into_encoded_bytes(),
        )
        .unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(
            Queue::open(&home).err().as_deref(),
            Some("invalid queue file")
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_broken_owner_item_refuses_the_store_and_leaves_it_unchanged() {
        let home = home("broken");
        let mut q = Queue::open(&home).unwrap();
        q.ask_owner("s1", widget("a")).unwrap();
        let good = fs::read(home.join("queue.json")).unwrap();
        let mut disk: Value = serde_json::from_slice(&good).unwrap();
        for (field, bad) in [
            ("kind", json!("permission")),
            ("owner", Value::Null),
            ("session_id", json!("../x")),
            ("text", json!(7)),
        ] {
            let mut broken = disk.clone();
            broken["owner"][0][field] = bad;
            let bytes = serde_json::to_vec(&broken).unwrap();
            fs::write(home.join("queue.json"), &bytes).unwrap();
            assert!(Queue::open(&home).is_err(), "{field}");
            assert_eq!(fs::read(home.join("queue.json")).unwrap(), bytes);
        }
        disk["owner"] = json!([disk["owner"][0].clone(), disk["owner"][0].clone()]);
        fs::write(home.join("queue.json"), serde_json::to_vec(&disk).unwrap()).unwrap();
        assert!(Queue::open(&home).is_err(), "duplicate id");
        fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
mod resize_tests {
    use super::*;

    fn queue(tag: &str) -> (PathBuf, Queue) {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("queue-resize-{tag}-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        let mut q = Queue::open(&home).unwrap();
        q.register("s", AgentKind::Claude, 1).unwrap();
        (home, q)
    }
    fn choices(second: &str, key: &str) -> Vec<Choice> {
        [("Yes", "1"), (second, key)]
            .iter()
            .map(|(label, key)| Choice {
                label: (*label).into(),
                keys: vec![(*key).into()],
                changes_settings: false,
            })
            .collect()
    }
    /// Look 11-17 N1: Claude's question card keeps the question and its options through screen redraws (a new frame,
    /// a resize) while the screen still shows the question; a frame with another question takes the screen's text.
    /// Look 11-17 v4f Home S2-8: a held permission hook still waits 10 minutes later while the window is there, so the
    /// card's Allow and Deny go through the hook.
    #[test]
    fn s2_8_a_held_hook_still_waits_at_ten_minutes() {
        let (home, mut q) = queue("s2-8-hold");
        q.connect(1_000);
        assert!(q.begin_hook("ev", 1_000));
        assert!(q.hold_hook("ev", 1_000));
        let ten = 1_000 + 600_000;
        q.connect(ten - 1_000); // the window's lease, renewed as it is while it is open
        assert!(
            q.hook_waits("ev", ten),
            "10 minutes later the hook still answers the card"
        );
        fs::remove_dir_all(home).unwrap();
    }
    /// A Codex approval prompt is read from the screen only, so its card stays risky whatever command it shows.
    #[test]
    fn w10_codex_prompt_stays_risky() {
        let (home, mut q) = queue("w10-codex");
        q.register("c", AgentKind::Codex, 1).unwrap();
        let text = "  Would you like to run the following command?\n\n  $ ls -la\n\n\u{203a} 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n".to_string();
        q.screen("c", Kind::Permission, text, choices("No", "2"), 10)
            .unwrap();
        let mut item = q.items().into_iter().find(|i| i.session_id == "c").unwrap();
        q.annotate(&mut item, &home, false);
        assert!(item.risky);
        fs::remove_dir_all(home).unwrap();
    }
    /// Look v31 a S2-1: a read tool of the Home lock's allow list, asked by a locked seat, is not risky and carries its
    /// tool name for the card. The same tool from a session without the lock (a project's own server may take the
    /// connector's name), a send tool and an unknown MCP tool stay risky; each still carries its name.
    #[test]
    fn v31_a_home_seat_mail_read_is_not_risky_and_names_its_tool() {
        let (home, mut q) = queue("v31-a");
        for (n, (tool, locked, risky)) in [
            ("mcp__claude_ai_Gmail__search_threads", true, false),
            ("mcp__claude_ai_Google_Calendar__list_events", true, false),
            ("mcp__claude_ai_Gmail__search_threads", false, true),
            ("mcp__claude_ai_Gmail__send_message", true, true),
            ("mcp__claude_ai_Gmail__trash_thread", true, true),
            ("mcp__other__search_threads", true, true),
        ]
        .into_iter()
        .enumerate()
        {
            let event = format!("ev{n}");
            let ask = serde_json::json!({"tool_name": tool, "tool_use_id": event, "tool_input": {"query": format!("in:inbox {n}")}, "nunchiro_event_id": event});
            q.observe("s", "PermissionRequest", &ask, "hook", 10 + n as u64)
                .unwrap();
            let mut item = q
                .items()
                .into_iter()
                .find(|i| i.hook_event_id.as_deref() == Some(event.as_str()))
                .unwrap();
            q.annotate(&mut item, &home, locked);
            assert_eq!(item.risky, risky, "{tool} locked {locked}");
            assert_eq!(item.tool.as_deref(), Some(tool));
        }
        fs::remove_dir_all(home).unwrap();
    }
    /// Ticket 1130 S1: an outward call's card names its kind and is risky (no "allow always"); a read is no kind.
    #[test]
    fn t1130_outward_card_names_its_kind() {
        let (home, mut q) = queue("t1130");
        for (n, (tool, input, kind)) in [
            (
                "mcp__claude_ai_Gmail__send_message",
                serde_json::json!({"to": ["a@example.org"]}),
                Some("mail"),
            ),
            (
                "Bash",
                serde_json::json!({"command": "npm publish"}),
                Some("publish"),
            ),
            ("Bash", serde_json::json!({"command": "git push"}), None),
            (
                "mcp__claude_ai_Gmail__search_threads",
                serde_json::json!({"query": "x"}),
                None,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let event = format!("ev{n}");
            let ask = serde_json::json!({"tool_name": tool, "tool_use_id": event, "tool_input": input, "nunchiro_event_id": event});
            q.observe("s", "PermissionRequest", &ask, "hook", 10 + n as u64)
                .unwrap();
            let mut item = q
                .items()
                .into_iter()
                .find(|i| i.hook_event_id.as_deref() == Some(event.as_str()))
                .unwrap();
            q.annotate(&mut item, &home, false);
            assert_eq!(item.outward.as_deref(), kind, "{tool}");
            if kind.is_some() {
                assert!(item.risky && item.allow_always.is_none(), "{tool}");
            }
        }
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn n1_question_keeps_its_words_through_redraws() {
        let (home, mut q) = queue("n1");
        let input = serde_json::json!({"questions":[{"question":"Which name should go in the first-line comment of test_app.py?","options":[{"label":"alpha"},{"label":"beta"}]}]});
        let rule = "─".repeat(30);
        let frame = |tail: &str| {
            format!(
                "{rule}\n ☐ Name\n\nWhich name should go in the first-line comment\nof test_app.py?\n\n❯ 1. alpha\n  2. beta\n{rule}\n  4. Chat about this{tail}\n\nEnter to select"
            )
        };
        q.observe(
            "s",
            "Question",
            &serde_json::json!({"tool_input": input}),
            "transcript",
            900,
        )
        .unwrap();
        q.screen("s", Kind::Question, frame(""), choices("beta", "2"), 901)
            .unwrap();
        q.screen("s", Kind::Question, frame(" "), choices("beta", "2"), 902)
            .unwrap();
        q.resized("s", 1000);
        q.screen("s", Kind::Question, frame("  "), choices("beta", "2"), 1001)
            .unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, input.to_string());
        let other = format!("{rule}\nPick a colour?\n❯ 1. red\n  2. blue");
        q.screen(
            "s",
            Kind::Question,
            other.clone(),
            choices("blue", "2"),
            1500,
        )
        .unwrap();
        assert_eq!(q.items()[0].text, other);
        fs::remove_dir_all(home).unwrap();
    }
    /// Look 1117 v10 N10-S2-5: Claude's plan approval is a question (no risky permission): its hook makes a question
    /// item, the "Ready to code?" dialog (its question below a rule under the plan) is read as a question with Claude's own
    /// options, and the card keeps the plan.
    #[test]
    fn n10_s2_5_plan_approval_is_a_question_with_the_plan() {
        let (home, mut q) = queue("n10-plan");
        let input = serde_json::json!({"plan":"# Create plan.txt\n\n## Context\nThe user wants a new file `plan.txt` in the repo root."});
        q.observe(
            "s",
            "PermissionRequest",
            &serde_json::json!({"tool_name":"ExitPlanMode","tool_input":input,"nunchiro_event_id":"ev"}),
            "hook",
            900,
        )
        .unwrap();
        assert_eq!(q.items()[0].kind, Kind::Question);
        let rule = "─".repeat(40);
        let dash = "╌".repeat(40);
        let frame = format!(
            "{rule}\n Ready to code?\n\n Here is Claude's plan:\n{dash}\n Create plan.txt\n\n Context\n\n The user wants a new file plan.txt in the\n repo root.\n{dash}\n\n{rule}\n Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n ❯ 1. Yes, and switch to BYPASS PERMISSIONS\n   (no further prompts) for this session\n   2. Yes, manually approve edits\n   3. Tell Claude what to change\n      shift+tab to approve with this feedback\n"
        );
        let mut screen = crate::waiting::screen::Screen::new(100, 30);
        screen.feed(frame.replace('\n', "\r\n").as_bytes());
        let seen = screen.detect(AgentKind::Claude).unwrap();
        assert_eq!(seen.kind, Kind::Question);
        let labels: Vec<_> = seen.choices.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Yes, and switch to BYPASS PERMISSIONS",
                "Yes, manually approve edits",
                "Tell Claude what to change"
            ]
        );
        assert!(seen.choices[0].changes_settings && seen.choices[2].takes_text());
        q.screen("s", seen.kind, seen.text, seen.choices, 1000)
            .unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1);
        assert_eq!(
            (&items[0].kind, items[0].choices.len()),
            (&Kind::Question, 3)
        );
        assert_eq!(
            items[0].text,
            input.to_string(),
            "the card shows the plan, not the screen"
        );
        // Codex look of wave 17 (MUST): an agent never approves a plan, by the answer op or by keys; it may decline.
        assert!(is_plan(&items[0]));
        for yes in [Answer::Choose { index: 1 }, Answer::AllowOnce] {
            assert!(
                crate::grants::check_answer(&items[0], &yes, true).is_err(),
                "{yes:?}"
            );
        }
        assert!(crate::grants::check_answer(&items[0], &Answer::Deny, true).is_ok());
        fs::remove_dir_all(home).unwrap();
    }
    /// Look 11-18 v9 B N-S2-2: a 40-word question cut short inside a box is still the question; another one is not.
    #[test]
    fn v9_a_long_question_cut_on_screen_is_still_asked() {
        let q = "This is only a throwaway check of the question flow, so please choose either red or blue, and the Builder will then write your chosen word into the new file w3.txt inside its own worktree.";
        let input = serde_json::json!({"questions":[{"question":q}]}).to_string();
        let screen = "────\n ☐ Word\n│ This is only a throwaway check of the │\n│ question flow, so please choose…    │\n❯ 1. red";
        assert!(asked_on_screen(&Kind::Question, &input, screen));
        assert!(!asked_on_screen(
            &Kind::Question,
            &input,
            "────\nPick a colour?\n❯ 1. red"
        ));
        // Codex look w16: another question with the same eight opening words is not this one.
        let other = "────\n│ This is only a throwaway check of the │\n│ file names, so please pick one │\n❯ 1. a";
        assert!(!asked_on_screen(&Kind::Question, &input, other));
        let whole = format!("────\n{q}\n❯ 1. red\n  2. blue");
        assert!(asked_on_screen(&Kind::Question, &input, &whole));
    }
    const OLD: &str = "────────\n Bash command\n touch a b\n Do you want to proceed?";
    const NEW: &str = "────\n Bash command\n touch a\n b\n\n Do you want to proceed?";

    #[test]
    fn same_prompt_drops_only_layout() {
        assert!(same_prompt(OLD, NEW));
        assert!(
            same_prompt("│ a b │\n┃ c", "a\n b c ┃"),
            "box sides and wraps are layout"
        );
        // Inside a line every character counts.
        assert!(!same_prompt("rm -rf ./build/", "rm -rf ./build /"));
        assert!(!same_prompt("rm -rf /tmp/a b", "rm -rf /tmp/ab"));
        assert!(!same_prompt("touch a  b", "touch a b"));
        assert!(!same_prompt("echo a│b", "echo ab"));
        assert!(!same_prompt("x\u{a0}y", "xy"));
        assert!(!same_prompt(OLD, &NEW.replace("a\n b", "a\n c")));
        assert!(!same_prompt("Touch a", "touch a"), "case is kept");
        assert!(
            !same_prompt("touch a-b", "touch a b"),
            "a dash is no rule glyph"
        );
    }

    /// Detects `OLD`, resizes at 1000, then shows `text` with `next` choices at `at`; returns (old id, new id).
    fn redraw(text: &str, next: Vec<Choice>, at: u64, resize: bool) -> (String, String) {
        let (home, mut q) = queue("redraw");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let old = q.items()[0].id.clone();
        if resize {
            q.resized("s", 1000);
        }
        q.screen("s", Kind::Permission, text.into(), next.clone(), at)
            .unwrap();
        let items = q.items();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].screen_text.as_deref(), Some(text));
        assert_eq!(items[0].choices, next);
        fs::remove_dir_all(home).unwrap();
        (old, items[0].id.clone())
    }

    #[test]
    fn only_the_same_prompt_redrawn_within_the_grace_keeps_its_id() {
        let (old, new) = redraw(NEW, choices("No", "2"), 1000 + RESIZE_GRACE_MS, true);
        assert_eq!(old, new);
        let (old, new) = redraw(NEW, choices("No", "2"), 1000, false);
        assert_ne!(old, new, "no resize");
        let (old, new) = redraw(NEW, choices("No", "2"), 1001 + RESIZE_GRACE_MS, true);
        assert_ne!(old, new, "grace over");
        let (old, new) = redraw(NEW, choices("No, and tell Claude", "2"), 1000, true);
        assert_ne!(old, new, "changed label");
        let (old, new) = redraw(NEW, choices("No", "3"), 1000, true);
        assert_ne!(old, new, "changed key");
        let (old, new) = redraw(&NEW.replace("b\n", "c\n"), choices("No", "2"), 1000, true);
        assert_ne!(old, new, "changed command");
    }

    #[test]
    fn the_grace_covers_one_redraw() {
        let (home, mut q) = queue("once");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let old = q.items()[0].id.clone();
        q.resized("s", 1000);
        q.screen("s", Kind::Permission, "x".into(), choices("No", "2"), 1000)
            .unwrap();
        q.screen("s", Kind::Permission, NEW.into(), choices("No", "2"), 1001)
            .unwrap();
        assert_ne!(q.items()[0].id, old);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn clear_screen_keeps_a_screen_item_only_within_the_grace() {
        let (home, mut q) = queue("clear");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        q.resized("s", now_ms());
        q.clear_screen("s").unwrap();
        assert_eq!(q.items().len(), 1);
        // The prompt went away during the grace: it goes when the grace ends.
        q.tick(
            now_ms() + RESIZE_GRACE_MS + 1,
            DEFAULT_STALE_MS,
            &BTreeSet::new(),
        )
        .unwrap();
        assert!(q.items().is_empty());
        // v1a-77: a second resize inside the grace does not move the clear later (it used to: the old assertion
        // ticked after a mark moved forward; now the item goes when the FIRST grace ends).
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let t0 = now_ms();
        q.resized("s", t0);
        q.clear_screen("s").unwrap();
        q.resized("s", t0 + 1000);
        q.tick(t0 + RESIZE_GRACE_MS + 1, DEFAULT_STALE_MS, &BTreeSet::new())
            .unwrap();
        assert!(q.items().is_empty());
        // Past the grace a frame without the prompt clears it at once.
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        q.resized("s", now_ms() - RESIZE_GRACE_MS - 1);
        q.clear_screen("s").unwrap();
        assert!(q.items().is_empty());
        fs::remove_dir_all(home).unwrap();
    }

    fn tick_at(q: &mut Queue, now: u64) {
        q.tick(now, DEFAULT_STALE_MS, &BTreeSet::new()).unwrap();
    }

    #[test]
    fn a_used_grace_is_not_rearmed() {
        let (home, mut q) = queue("rearm");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let first = q.items()[0].id.clone();
        q.resized("s", 1000);
        q.screen("s", Kind::Permission, NEW.into(), choices("No", "2"), 1100)
            .unwrap();
        assert_eq!(q.items()[0].id, first, "the one redraw keeps the id");
        q.resized("s", now_ms());
        q.clear_screen("s").unwrap();
        assert!(q.items().is_empty(), "a used grace was re-armed");
        q.screen("s", Kind::Permission, NEW.into(), choices("No", "2"), 1200)
            .unwrap();
        assert_ne!(q.items()[0].id, first);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn two_resizes_before_the_redraw_keep_the_id() {
        for (redraw_at, kept) in [
            (1300, true),
            (1000 + RESIZE_GRACE_MS, true),
            (1001 + RESIZE_GRACE_MS, false),
        ] {
            let (home, mut q) = queue("two");
            q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
                .unwrap();
            let first = q.items()[0].id.clone();
            q.resized("s", 1000);
            q.resized("s", 1100); // does not move the mark: the grace runs from 1000
            q.screen(
                "s",
                Kind::Permission,
                NEW.into(),
                choices("No", "2"),
                redraw_at,
            )
            .unwrap();
            assert_eq!(q.items()[0].id == first, kept, "redraw at {redraw_at}");
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn a_new_prompt_after_a_used_grace_gets_a_grace() {
        let (home, mut q) = queue("newprompt");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        q.resized("s", 1000);
        q.screen("s", Kind::Permission, NEW.into(), choices("No", "2"), 1100)
            .unwrap();
        let first = q.items()[0].id.clone();
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "3"), 1500)
            .unwrap();
        let second = q.items()[0].id.clone();
        assert_ne!(first, second);
        q.resized("s", 2000);
        q.screen("s", Kind::Permission, NEW.into(), choices("No", "3"), 2100)
            .unwrap();
        assert_eq!(q.items()[0].id, second, "the new prompt got no grace");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_grace_that_ended_unused_is_spent() {
        let (home, mut q) = queue("unused");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let t0 = now_ms();
        q.resized("s", t0);
        tick_at(&mut q, t0 + RESIZE_GRACE_MS + 1);
        assert_eq!(q.items().len(), 1, "the prompt is still there");
        q.resized("s", now_ms());
        q.clear_screen("s").unwrap();
        assert!(q.items().is_empty(), "a spent grace was re-armed");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn graced_ids_are_pruned() {
        let (home, mut q) = queue("prune");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let first = q.items()[0].id.clone();
        q.resized("s", 1000);
        q.screen("s", Kind::Permission, NEW.into(), choices("No", "2"), 1100)
            .unwrap();
        assert_eq!(q.graced, BTreeSet::from([first]));
        q.clear_screen("s").unwrap();
        assert!(q.items().is_empty());
        assert!(q.graced.is_empty(), "{:?}", q.graced);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_dropped_mark_spends_its_items() {
        let (home, mut q) = queue("dropped");
        q.screen("s", Kind::Permission, OLD.into(), choices("No", "2"), 900)
            .unwrap();
        let first = q.items()[0].id.clone();
        q.resized("s", 1000);
        // The first frame after the resize comes after the grace and is the very same frame: the item keeps its id
        // through the usual rules and the mark is dropped without a match.
        q.screen(
            "s",
            Kind::Permission,
            OLD.into(),
            choices("No", "2"),
            1001 + RESIZE_GRACE_MS,
        )
        .unwrap();
        assert_eq!(q.items()[0].id, first);
        q.resized("s", now_ms());
        q.clear_screen("s").unwrap();
        assert!(
            q.items().iter().all(|i| i.id != first),
            "a later Resize armed a grace for a prompt whose mark was dropped"
        );
        fs::remove_dir_all(home).unwrap();
    }
}
#[cfg(test)]
mod order_tests {
    // V2.5-41 (audit B14): hooks carry the hook process's creation time; an event with no turn state must
    // neither move nor be dropped by the per-session hook clock. Fixed stamps, no clock reads.
    use super::*;

    fn queue(tag: &str) -> (PathBuf, Queue) {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("queue-order-{tag}-{}", store::new_id().unwrap()));
        fs::create_dir_all(&home).unwrap();
        let mut q = Queue::open(&home).unwrap();
        q.register("s", AgentKind::Codex, 1).unwrap();
        (home, q)
    }
    fn hook(q: &mut Queue, event: &str, p: Value, at: u64) {
        q.observe("s", event, &p, "hook", at).unwrap();
    }
    fn turn(q: &mut Queue, id: &str, at: u64) {
        hook(q, "UserPromptSubmit", json!({"turn_id": id}), at);
        hook(q, "Stop", json!({"turn_id": id}), at + 1);
    }

    #[test]
    fn sessionstart_does_not_order_out_turn_hooks() {
        let (home, mut q) = queue("start");
        // identity::watch path: core clock T2 lands before the turn's hooks stamped T1 < T2.
        hook(
            &mut q,
            "SessionStart",
            json!({"session_id": "agent-1"}),
            200,
        );
        hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
        assert!(q.attention("s").working, "the prompt was ordered out");
        hook(&mut q, "Stop", json!({"turn_id": "t1"}), 101);
        assert_eq!(q.attention("s").completion_seq, 1);
        hook(&mut q, "Stop", json!({"turn_id": "t1"}), 101);
        assert_eq!(q.attention("s").completion_seq, 1, "counted once");
        fs::remove_dir_all(home).unwrap();
    }

    /// Ticket 1054: a lead got "worker done" lines while its worker was mid-job: a subagent's Stop counted as the
    /// worker's turn end.
    #[test]
    fn a_subagents_stop_is_no_turn_end() {
        let (home, mut q) = queue("subagent-stop");
        hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
        hook(&mut q, "Stop", json!({"agent_id": "sub-1"}), 101);
        let a = q.attention("s");
        assert!(a.working, "a subagent's Stop ended the turn");
        assert_eq!(a.completion_seq, 0);
        hook(
            &mut q,
            "Stop",
            json!({"turn_id": "t1", "agent_id": ""}),
            102,
        );
        assert_eq!(q.attention("s").completion_seq, 1, "the main Stop ends it");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn working_since_is_the_turn_start() {
        let (home, mut q) = queue("since");
        hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
        hook(&mut q, "PreToolUse", json!({}), 150);
        assert_eq!(
            q.attention("s").working_since,
            100,
            "a later event in the turn kept the start"
        );
        hook(&mut q, "Stop", json!({"turn_id": "t1"}), 200);
        hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t2"}), 300);
        assert_eq!(q.attention("s").working_since, 300);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn stale_stop_after_newer_prompt_still_dropped() {
        let (home, mut q) = queue("stale");
        turn(&mut q, "a", 100);
        hook(&mut q, "UserPromptSubmit", json!({}), 300);
        // A Stop with no turn id stamped before the newer prompt is the earlier turn's.
        hook(&mut q, "Stop", json!({}), 200);
        let a = q.attention("s");
        assert!(a.working, "a stale Stop finished the current turn");
        assert_eq!(a.completion_seq, 1);
        hook(&mut q, "Stop", json!({}), 301);
        assert_eq!(q.attention("s").completion_seq, 2);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sessionstart_mid_turn_keeps_working_state() {
        let (home, mut q) = queue("mid");
        hook(&mut q, "UserPromptSubmit", json!({"turn_id": "t1"}), 100);
        hook(
            &mut q,
            "PermissionRequest",
            json!({"tool_name": "Bash", "tool_input": {"command": "touch x"}}),
            110,
        );
        let before = (q.attention("s"), q.items());
        // A late (resume) and an old (replayed) SessionStart.
        hook(
            &mut q,
            "SessionStart",
            json!({"session_id": "agent-1"}),
            120,
        );
        hook(&mut q, "SessionStart", json!({"session_id": "agent-1"}), 50);
        let after = (q.attention("s"), q.items());
        assert_eq!(after.0.working, before.0.working);
        assert_eq!(after.0.waiting, before.0.waiting);
        assert_eq!(after.0.completion_seq, before.0.completion_seq);
        assert_eq!(after.1, before.1, "items unchanged");
        // The turn it interrupted still completes, and a permission stamped between still applies.
        hook(&mut q, "Stop", json!({"turn_id": "t1"}), 115);
        assert_eq!(q.attention("s").completion_seq, 1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn persisted_clock_from_sessionstart_does_not_hide_next_turn() {
        let (home, mut q) = queue("persist");
        turn(&mut q, "a", 100);
        hook(
            &mut q,
            "SessionStart",
            json!({"session_id": "agent-1"}),
            500,
        );
        drop(q);
        let mut q = Queue::open(&home).unwrap();
        turn(&mut q, "b", 200);
        assert_eq!(q.attention("s").completion_seq, 2);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn non_turn_arms_decided() {
        // Kinds that fall to `_ => {}` carry no turn state: none orders a turn's hooks out.
        for (event, p) in [
            ("SessionStart", json!({"session_id": "agent-1"})),
            (
                "Notification",
                json!({"message": "Claude needs your permission"}),
            ),
            ("SubagentStart", json!({"agent_id": "sub-1"})),
            ("PreToolUse", json!({"tool_name": "Bash", "tool_input": {}})),
            ("SessionEnd", json!({})),
        ] {
            let (home, mut q) = queue("arms");
            hook(&mut q, event, p, 200);
            turn(&mut q, "t1", 100);
            assert_eq!(
                q.attention("s").completion_seq,
                1,
                "{event} ordered the turn out"
            );
            fs::remove_dir_all(home).unwrap();
        }
        // A question PreToolUse raises an item, so it is a turn event and keeps the ordering.
        let (home, mut q) = queue("question");
        hook(
            &mut q,
            "PreToolUse",
            json!({"tool_name": "AskUserQuestion", "tool_input": {}}),
            200,
        );
        hook(&mut q, "PostToolUse", json!({}), 100);
        assert!(
            q.attention("s").waiting,
            "an older PostToolUse cleared a newer question"
        );
        fs::remove_dir_all(home).unwrap();
    }

    // Ticket 691: Codex 0.161 rollout lines for `request_user_input_async` (shape from the ticket 589 live run: `title`
    // and plain-string options, `{"accepted":true}` at once, the answer later as a user message).
    /// Seventh look (B S2-1): Claude runs two Write calls of one message one after the other. The first's result is in
    /// the transcript before the second's permission request is asked, but the queue read it after that request
    /// arrived (the transcript is read every tick, a hook at once): it took the second request's card, and Claude
    /// waited at its prompt with the session "running" and nothing pending.
    #[test]
    fn w14_a_tool_result_written_before_a_request_leaves_its_card() {
        let (home, mut q) = queue("late-result");
        let ms = |t: &str| {
            crate::usage::epoch(t).unwrap() as u64 * 1000 + t[20..23].parse::<u64>().unwrap()
        };
        let result = |at: &str| {
            json!({"type":"user","timestamp":at,"uuid":at,
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}})
        };
        let ask = |q: &mut Queue, file: &str, event: &str, at: &str| {
            hook(
                q,
                "PermissionRequest",
                json!({"tool_name":"Write","tool_input":{"file_path":file},"nunchiro_event_id":event}),
                ms(at),
            );
        };
        q.disk.sessions.get_mut("s").unwrap().kind = AgentKind::Claude;
        hook(
            &mut q,
            "UserPromptSubmit",
            json!({"prompt_id":"t1"}),
            ms("2026-11-18T01:57:30.000Z"),
        );
        ask(
            &mut q,
            "/w/lane-slug/BRIEF.md",
            "e1",
            "2026-11-18T01:57:34.000Z",
        );
        let first = q.items_of("s")[0].id.clone();
        q.remove(&first).unwrap(); // allowed on its card
        hook(
            &mut q,
            "PostToolUse",
            json!({"tool_name":"Write"}),
            ms("2026-11-18T01:57:35.400Z"),
        );
        ask(
            &mut q,
            "/w/lane-greet/BRIEF.md",
            "e2",
            "2026-11-18T01:57:35.450Z",
        );
        // The first call's result, written before the second request, read after it.
        let read = ms("2026-11-18T01:57:35.500Z");
        q.transcript(
            "s",
            "k".into(),
            1,
            &[result("2026-11-18T01:57:35.412Z")],
            read,
        )
        .unwrap();
        let items = q.items_of("s");
        assert!(
            matches!(&items[..], [i] if i.text.contains("lane-greet") && i.hook_event_id.as_deref() == Some("e2")),
            "the second request lost its card: {items:?}"
        );
        assert!(q.attention("s").waiting && q.attention("s").working);
        // Its own result, written after it, ends it as before.
        q.transcript(
            "s",
            "k".into(),
            2,
            &[result("2026-11-18T01:57:41.000Z")],
            read + 6000,
        )
        .unwrap();
        assert!(q.items_of("s").is_empty() && !q.attention("s").waiting);
        // A question a transcript record made is as old as its record: its result in the same read ends it.
        let asks = json!({"type":"assistant","timestamp":"2026-11-18T01:58:00.000Z","message":{"role":"assistant",
            "content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[]}}]}});
        q.transcript(
            "s",
            "k".into(),
            3,
            std::slice::from_ref(&asks),
            read + 30_000,
        )
        .unwrap();
        assert_eq!(q.items_of("s").len(), 1);
        q.transcript(
            "s",
            "k".into(),
            4,
            &[asks, result("2026-11-18T01:58:05.000Z")],
            read + 60_000,
        )
        .unwrap();
        assert!(q.items_of("s").is_empty(), "{:?}", q.items_of("s"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_async_question_waits_until_answered() {
        let (home, mut q) = queue("async");
        let item = |payload: Value| json!({"timestamp":"2026-11-14T10:00:00.000Z","type":"response_item","payload":payload});
        let event = |payload: Value| json!({"timestamp":"2026-11-14T10:00:00.000Z","type":"event_msg","payload":payload});
        let ask = |call: &str| {
            item(
                json!({"type":"function_call","name":"request_user_input_async","call_id":call,
            "arguments":"{\"questions\":[{\"title\":\"Which port?\",\"options\":[\"8080\",\"9090\"]}]}"}),
            )
        };
        let output = |call: &str, out: &str| {
            item(json!({"type":"function_call_output","call_id":call,"output":out}))
        };
        let user = |text: &str| {
            item(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]}),
            )
        };
        let mut at = 100;
        let mut read = |q: &mut Queue, records: &[Value]| {
            at += 1;
            q.transcript("s", "k".into(), at, records, at).unwrap();
            q.attention("s").waiting
        };
        let turn = event(json!({"type":"task_started","turn_id":"t1"}));
        assert!(
            read(&mut q, &[turn, user("pick a port"), ask("call_1")]),
            "the question waits"
        );
        // Look 11-17 N20: its card offers the options as choices, answered by a message (no keys).
        let open = q.items_of("s");
        let labels: Vec<_> = open[0].choices.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["8080", "9090"]);
        assert!(answered_by_message(&open[0]) && open[0].choices[0].keys.is_empty());
        assert!(
            read(&mut q, &[output("call_1", "{\"accepted\":true}")]),
            "accepted is not answered"
        );
        assert!(
            read(
                &mut q,
                &[event(json!({"type":"task_complete","turn_id":"t1"}))]
            ),
            "the turn's end keeps it"
        );
        assert!(!read(&mut q, &[user("8080")]), "the answer clears it");
        // A call the room's hook denied (sent to the lead) is not a question for the person.
        let denied = "Tool call blocked by PreToolUse hook: sent as ask m1 to your lead";
        assert!(
            !read(&mut q, &[ask("call_2"), output("call_2", denied)]),
            "a denied call"
        );
        // Another tool's output while the question is open leaves it.
        assert!(read(&mut q, &[ask("call_3"), output("call_x", "ok")]));
        assert!(!read(&mut q, &[user("9090")]));
        // The hook path: the tool result and Stop keep it, the next prompt clears it.
        let tool =
            json!({"tool_name":"request_user_input_async","tool_use_id":"call_4","tool_input":{}});
        hook(&mut q, "PreToolUse", tool.clone(), 200);
        hook(&mut q, "PostToolUse", tool, 201);
        hook(&mut q, "Stop", json!({}), 202);
        assert!(
            q.attention("s").waiting,
            "hook: kept past the tool result and Stop"
        );
        hook(&mut q, "UserPromptSubmit", json!({}), 203);
        assert!(!q.attention("s").waiting, "hook: the prompt clears it");
        fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
mod type_something_tests;
