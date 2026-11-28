// Mirrors crates/nunchiro-core/src/api.rs and queue/mod.rs (serde shapes).
import type { Key } from './i18n';
export type AgentKind = 'claude' | 'codex' | 'shell' | 'acp';
export type SessionState = 'running' | 'failed' | 'exited' | 'resumable' | 'closed';
export type DecisionKind = 'permission' | 'question' | 'dialog' | 'background' | 'stale' | 'board' | 'owner'; // v1a-23: owner

export interface Choice {
  label: string;
  keys: string[];
  changes_settings: boolean;
}

export interface Decision {
  id: string;
  session_id: string;
  scope: string;
  kind: DecisionKind;
  text: string;
  choices: Choice[];
  observed_at: number;
  actionable: boolean;
  // v1b-32: false with `actionable` false is a card shown beside another request still pending, not a restored item.
  reconciled?: boolean;
  // v1b-18: set on kind `board` items, which come from the snapshot's `board_decisions`, not a session.
  board?: BoardDecision;
  // v1a-23: set on kind `owner` items (the snapshot's `owner_decisions`): a human action a session asked for.
  owner?: OwnerAsk;
}

// v1a-23: crates/nunchiro-core/src/queue/mod.rs `OwnerAsk`. A widget is approved in the permission sheet; an
// integration source or the verified-yes option with `allow_once`; `deny` dismisses.
export type OwnerAsk =
  | { type: 'approval'; subject: 'widget' | 'source'; name: string; level: 'read' | 'act'; hash: string }
  | { type: 'permission_answers'; project: string }
  | { type: 'lead_accounts' } // owner 2026-11-25: "Leads may use any of my accounts", asked by a session
  // Ticket 259: a new worktree's repo setup script (`orca.yaml`) waits for approval in the setup sheet.
  | { type: 'setup'; path: string; hash: string }
  // Needs 225: an agent's ask to use one Codex reset ticket; `folder` null is "Your own". Allow or Deny, window only.
  | { type: 'codex_reset'; folder: string | null; account: string; reason: string }
  // Ticket 990 slice h: a lead asks to merge a reviewed task; `learned` (at most two) may each be kept as a note first.
  | { type: 'merge'; task: string; title: string; place: string; revision: string; learned?: Lesson[] }
  // Ticket 990 slice i: a lead proposes a new role for the user's roles; `place` is where it was proposed.
  | { type: 'bot'; name: string; job: string; why: string; from: string; place: string }
  | { type: 'role'; role: { name: string; job: string; kind: string; model?: string; effort?: string; writes: boolean }; why: string; place: string }
  // Home view change 4: the Home lead (`from`) asks to give the lead (teammate id) of `place` a goal; Send or Not now.
  | { type: 'goal'; place: string; lead: string; from: string; text: string }
  | { type: 'session_close'; from?: string; target: string; label: string; place: string; why: string } // ticket 1113
  | { type: 'cap'; place: string; was: number; cap: number; why: string } // ticket 1099 panel 4
  // Ticket 1004: the core's own card for a stalled task (two check-ins of its seats with nothing moved, or the same
  // error three times). `seat` is the name of the seat that checked in last (`session_id` its session); deny dismisses.
  | { type: 'stall'; task: string; title: string; place: string; seat: string; error?: string }
  // Ticket 1005: the core's own card for teammate `teammate`'s memory `file` (MEMORY.md or the shared USER.md), past the
  // 6 KB its brief quotes; `name` is the teammate's name. allow_once asks the seat to tidy it, deny dismisses.
  | { type: 'tidy'; teammate: string; name: string; file: string; place: string }
  // Ticket 993: a lead proposes a schedule (`change` add) or a change to one (`id`); `run` and `when` are the schedule's
  // (schedule/mod.rs `Run`, `When`), `line` the core's one sentence of them. Nothing is stored before the yes.
  // Eighth look (Home S2-B): `failed` is a run of schedule `id` that failed or could not start, with the core's `reason`;
  // allow_once runs it again now, deny dismisses the card.
  | { type: 'schedule'; change: 'add' | 'pause' | 'resume' | 'remove' | 'failed' | 'trigger'; id?: string; reason?: string; run: { kind: string; project: string; label: string; task?: string; teammate?: string; level?: 'light' | 'standard' | 'deep' }; when: { at: string; daily: boolean; days?: number[] }; place: string; line: string }
  // Ticket 1002 lane 2: the Home lead (`from`) stages one outward tool call (`tool`, every `args` key shown on the card).
  // allow_once starts its 10 s undo (`yes_at`, ms); deny then is Undo, before it Discard; choose 1 opens it by hand.
  | { type: 'outward'; tool: string; args: Record<string, unknown>; source?: string; new_domains?: string[]; from: string; hash: string; yes_at?: number }
  // Ticket 1003: a card about one open loop (crates/nunchiro-core/src/loops.rs `Row`). `add`: the Home lead (`from`) asks
  // to keep `row` (nothing is kept before allow_once). `close`: it says the row is done (`why`). `overdue`: the core's own
  // card for a row past its due date; allow_once closes the row, deny keeps it open and dismisses the card.
  | { type: 'loop'; change: 'add' | 'close' | 'overdue'; row: OpenLoop; from?: string; why?: string };

/** crates/nunchiro-core/src/loops.rs `Row`: a promise the user made or something the user waits for; `due` is YYYY-MM-DD. */
export interface OpenLoop {
  id: string;
  kind: 'promise' | 'waiting';
  who: string;
  what: string;
  due?: string;
  source: string;
}

/** crates/nunchiro-core/src/ledger.rs `Lesson`: one line a seat proposes on its task; `at` in ms. */
export interface Lesson {
  text: string;
  name: string;
  role: string;
  cites?: string;
  at: number;
}

// v1b-18: crates/nunchiro-core/src/board/decisions.rs. Answered with `board_resolve` (identity + updated_at).
export interface BoardDecision {
  identity: string;
  source: 'manual' | 'integration';
  source_name?: string;
  id: string;
  title: string;
  question: string;
  project: string | null;
  url: string | null;
  column: string;
  updated_at: number;
}

export interface Attention {
  working: boolean;
  waiting: boolean;
  stale: boolean;
  failed: boolean;
  last_activity: number;
  /** When the current turn began (ms); 0 or absent from an older core. */
  working_since?: number;
  observer_error?: string | null;
  /** Look 1117 v12 B N11-S2-3: the turn blocks in `agent ask --wait` on its open ask (sessions/room.rs `asks_waiting`). */
  asking?: boolean;
  /** v19-Q9-cx: the agent does not read its terminal; the last write to it was refused (pty.rs `input_blocked`). */
  input_blocked?: boolean;
}

export interface Session {
  side_chat?: boolean;
  side_parent?: string;
  side_split?: string;
  id: string;
  kind: AgentKind;
  project: string;
  cwd: string;
  label: string;
  /** Ticket 1017: `label` came from the first message, not the user (api.rs `auto_label`). */
  auto_label?: boolean;
  state: SessionState;
  /** Ticket 1013 F6: a command closed it (api.rs `closed_by_command`); its tab goes at once. */
  closed_by_command?: boolean;
  agent_session_id?: string | null;
  agent_version: string | null;
  untested: boolean;
  pid: number | null;
  attention: Attention;
  /** Finished turns (api.rs `completion_seq`); 0 before the agent's first reply. */
  completion_seq?: number;
  pending: Decision[];
  /** V2-1b: after a core restart, this session's holder speaks another protocol; its agent keeps running. */
  holder_status?: 'needs_restart' | 'update_nunchiro';
  /** V2-2b: the account this agent runs on, fixed at start; absent = "Your own". */
  config_dir?: string;
  account?: string;
  /** V2-4a: the `agents.toml` entry an `acp` session runs. */
  acp_agent?: string | null;
  /** V2-5b: why this session failed (crates/nunchiro-core/src/problems.rs); absent when nothing is wrong. */
  problem?: Problem;
  /** V2-5b: started by "Start without Nunchiro hooks". */
  without_hooks?: boolean;
  /** Ticket 322: a login or logout tab the core itself started for an account; filed on Settings > Accounts, not in the tree. */
  account_tab?: boolean;
  /** v1b-11: the folder's state when the session started (api.rs `start_commit`, diff/mod.rs `Base`); absent on old rows.
   *  Look 1117 v7 (S2-3): `not_git` is a folder under no repository: it has no checkout, so no "main" is shown for it. */
  start_commit?: { kind: 'commit' | 'no_commits' | 'not_git' };
  /** CHAT-PERMCHIP: Claude's permission mode as the footer on its screen shows it; absent when unknown. */
  permission_mode?: string;
  /** CHAT-MODELIST (ticket 285): what the mode list may offer a Claude session and how a walk to a picked mode stands
   * (crates/nunchiro-core/src/api.rs `ModeState`); absent for other kinds. */
  mode_state?: ModeState;
  /** W35 picker: Claude's fast mode (its ↯ read per snapshot) and ultracode (known when Nunchiro set it); absent: unknown. */
  modes?: {
    fast?: boolean;
    ultracode?: boolean;
    note?: string;
    /** Ticket 1010: Claude's own sentence when it turned fast mode off for the account. */
    fast_note?: string;
    /** Ticket 1010: fast mode is on but paused (Claude dims its ↯): its notice's words and end (epoch seconds), when read. */
    fast_cooldown?: { text?: string; until?: number };
  };
  /** v1a-06: the machine of a remote session; absent for this Mac. */
  machine?: string;
  /** Ticket 286: the agent quit and left its shell, still `running` for the user's terminal keys. */
  agent_ended?: boolean;
  /** Ticket 621: when the row went Closed (epoch ms, api.rs `closed_at`); absent on rows closed before it and on ended ones. */
  closed_at?: number;
  /** Ticket 1025: when this run started (epoch ms, api.rs `started_at`); absent on rows started before it. */
  started_at?: number;
  /** Lane w59: when this run ended (epoch ms, api.rs `ended_at`), stamped by the core that saw it end; absent on a run a
   *  close ended (`closed_at`) and on rows that ended before the core kept it. */
  ended_at?: number;
  /** Ticket 372: the usage limit a live session's screen shows while its reset is ahead (`resets` as the agent printed it,
   * `until` in epoch seconds), and whether the owner armed one resume at it. */
  limit?: { resets: string; until: number; armed?: boolean };
  /** Ticket 571: the session that started this one (its lead); absent for a root session. */
  parent?: string;
  /** Ticket 990: the teammate (Settings > Team) whose seat this session is; absent for any other session. */
  teammate?: string;
  /** Look 1117 v10 N10-S2-3: the ids of the runs a resumed run continues (their rows are gone; the room still names them). */
  resumed_from?: string[];
  /** The folders the owner gave the Assistant's run in a window message (read and write for this conversation). */
  folders?: string[];
  /** Ticket 992: the level the seat was started at; absent on a seat with a custom model and on any other session. */
  level?: 'light' | 'standard' | 'deep';
  /** Look 1117 v13 Home S3-5: an ended local session whose folder is no longer on disk (api.rs `folder_gone`). */
  folder_gone?: boolean;
  /** Look 1117 v10 N10-S3-3: an ended session's ask that ended with it unanswered, in its first words (api.rs `ended_ask`). */
  ended_ask?: string;
  /** The core's send queue (api.rs `send_queue`): rows not delivered yet, by any sender. */
  send_queue?: SendRow[];
  /** Why each queued row waits, by send id (api.rs `send_waits`, snapshot only). */
  send_waits?: Record<string, string>;
  /** The agent's input box is on a current screen and nothing asks (api.rs `at_box`, snapshot only). */
  at_box?: boolean;
  /** Words the core took out of the agent's box for this composer (api.rs `draft_home`); answered with `draft_taken`. */
  draft_home?: { words: string; at: number };
  /** Another sender's message sits in the agent's box waiting for its Enter (api.rs `take_back`): ⌘Z takes it back. */
  take_back?: boolean;
}
/** One row of a session's send queue or log (delivery.rs `Send`). `sender` is `user`, a session id, `core` or `widget:<name>`. */
export type SendRow = { id: string; sender: string; at: number; content: string; status: string; submit?: boolean; settle?: string | null; replaced?: { plugin: string; original: string } };
/** The session's folder was under no git repository when it started (the core's `start_commit`), or is gone from disk
 *  (look 1117 v13 Home S3-5: a removed project folder read "harbor / main"): it has no checkout to name. */
export const noCheckout = (s: Session) => s.start_commit?.kind === 'not_git' || !!s.folder_gone;

/** `unavailable`: Claude's Shift+Tab cycle has no Bypass permissions for this session; `available`: pickable;
 * `disabled`: Claude's own settings turn it off; `needs_setting`: the stored choice is Ask, so a new session would not list it. */
export type SkipPermissions = 'unavailable' | 'available' | 'disabled' | 'needs_setting';
export interface ModeState {
  skip: SkipPermissions;
  /** A walk to a picked mode: `error` is absent while it runs and the reason once it stopped short. */
  walk?: { target: string; error?: string };
}

/** V2-CF4: crates/nunchiro-core/src/chat/kids.rs. A child whose launch was seen but whose end was not is `unknown`;
 * `started_at` (epoch seconds, the launch record's own timestamp) is the only time a transcript states. */
export type KidState = 'working' | 'done' | 'failed' | 'unknown';
export interface Kid {
  id: string;
  label: string;
  state: KidState;
  started_at?: number;
}

/** V2-5b: crates/nunchiro-core/src/problems.rs `Case`; `core_unreachable` is the window's own. */
export type ProblemCase = 'not_installed' | 'logged_out' | 'usage_limit' | 'hook_trust' | 'machine_unreachable' | 'version_mismatch' | 'folder_permission' | 'holder_restart' | 'set_aside' | 'unexpected' | 'acp_no_answer' | 'acp_refused' | 'core_unreachable';
export interface Problem {
  case: ProblemCase;
  cause: string;
  /** The usage limit's reset time as the agent printed it. */
  reset?: string;
  details?: string;
}

/** V2-1b: an item restored after a core restart, not yet proved again by fresh evidence ("checking"). It still
 * counts as waiting everywhere; it is never answerable from the window. */
export const checking = (d: Decision) => !d.actionable && d.reconciled === true && !['stale', 'background', 'board', 'owner'].includes(d.kind);
/** V2-1b: how long a restored item waits for fresh evidence before the window offers its terminal. */
export const CHECK_MS = 10_000;

/** One word per state, so state never reads from colour alone. */
export type Status = 'waiting' | 'limited' | 'stale' | 'working' | 'idle' | 'done' | 'failed';

/** Ticket 286 item 1 r5 (card C-20261106-06): the session's state as its agent stands: an agent that quit reads
 * `exited` though the shell it left still runs. Every "done / ended" reading follows this; only the terminal and what
 * stops or quits the shell follow `state`. */
export const agentState = (s: Session): SessionState => (s.agent_ended && s.state === 'running' ? 'exited' : s.state);

/** Look 1117 v5 (C S3-6): the word for a session's state. A resumable one reads "Resumable" everywhere (tree, header, tab,
 *  status bar), not "done". */
export const statusKey = (s: Session): Key => (blockedInput(s) ? 'mw.status.inputBlocked' : s.state === 'resumable' && status(s) === 'done' ? 'mw.status.resumable' : (`mw.status.${shownStatus(s)}` as Key));

/** Look 1117 v12 B N11-S2-3: the state as the tab, the tree and the status bar show it: a turn blocked in `agent ask --wait`
 *  reads "waiting for an answer". Only shown: what acts on a running turn (the composer, Stop, alerts) keeps `status`. */
export type Shown = Status | 'asked';
export const shownStatus = (s: Session): Shown => (s.attention.asking && status(s) === 'working' ? 'asked' : status(s));

/** Look 1117 v10 N10-S2-3: `byId` plus each resumed run under the ids of the runs it continues. A resume gives the seat a
 *  new id and drops the old rows, while the room's lines, a worker's parent and a lead's merge card (v13 B N13-S3-3) still
 *  name the old id. Every lookup of a session by an id something else kept goes through this. */
export function withResumed(byId: Map<string, Session>, sessions: Session[]) {
  const all = new Map(byId);
  for (const s of sessions) for (const old of s.resumed_from ?? []) if (!all.has(old)) all.set(old, s);
  return all;
}

/** v19-Q9-cx: a live session whose terminal refused the last write reads as broken, "not reading input", not idle. */
export const blockedInput = (s: Session) => !!s.attention.input_blocked && agentState(s) === 'running';

export function status(s: Session): Status {
  // v1a-08: a stale flag is a queue item too, but it reads as stale, not waiting; a background note (N12-S2-4) as working.
  // Look v33 S3-3: orange is "your turn" only; an ended or failed agent waits for nothing (the core sends no items for it).
  if (s.pending.some((d) => d.kind !== 'stale' && d.kind !== 'background') || (s.attention.waiting && agentState(s) === 'running')) return 'waiting';
  if (s.limit) return 'limited'; // ticket 372: the core sends it for a live session while its screen shows the limit
  if (s.state === 'failed' || s.attention.failed || s.problem || blockedInput(s)) return 'failed'; // V2-5b: a card is a failure
  if (agentState(s) !== 'running') return 'done';
  if (s.attention.stale) return 'stale';
  if (s.attention.working) return 'working';
  return 'idle';
}

export const kindIcon: Record<DecisionKind, string> = {
  permission: '▲',
  question: '◆',
  dialog: '▣',
  background: '⧗',
  stale: '◌',
  board: '◇', // v1b-18
  owner: '◎', // v1a-23
};

/** Ticket 740: the catalogue key of each kind's word (accessible names, notifications), never an English literal. */
export const kindKey: Record<DecisionKind, Key> = {
  permission: 'decisions.kindPermission',
  question: 'decisions.kindQuestion',
  dialog: 'decisions.kindDialog',
  background: 'walk8.kind.background',
  stale: 'walk8.kind.stale',
  board: 'walk8.kind.board', // v1b-18
  owner: 'walk8.kind.owner', // v1a-23
};

/** V2-9a: tree.toml as the core serves it (groups in creation order, pinned project paths, fold keys). */
export interface TreeState {
  groups: { name: string; projects: string[] }[];
  pins: string[];
  folded: string[];
  /** F15: projects added by picking their folder, shown with no session (absent when none). */
  added?: string[];
  /** 370: the names the owner chose, by project path (absent when none); a project not listed reads as its folder name. */
  names?: Record<string, string>;
}

/** One edit the core accepts; the reply is the whole tree after it. */
export type TreeEdit =
  | { op: 'group_create'; name: string; project: string }
  | { op: 'group_rename'; from: string; to: string }
  | { op: 'group_dissolve'; name: string }
  | { op: 'project_move'; project: string; group: string | null; index?: number }
  | { op: 'pin'; project: string; pinned: boolean }
  | { op: 'add'; project: string; added: boolean }
  | { op: 'project_name'; project: string; name: string }
  | { op: 'fold'; key: string; folded: boolean }
  | { op: 'fold_set'; folded: string[] };
