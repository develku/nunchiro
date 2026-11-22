// Window side of the loopback API (crates/nunchiro-core/src/http/mod.rs).
// The token arrives at launch in window.__NUNCHIRO__ (Tauri page-load script, or the test harness)
// and travels only in the WebSocket subprotocol header, never in a URL or a log line.
export class CoreRefusal extends Error {}

/** v25-sendkeys: the two refusal prefixes the window keys off (crates/nunchiro-core/src/delivery.rs). */
export const UNCERTAIN = 'uncertain:'; // a write that may have landed partway: never retyped
export const AGENT_ENDED = 'agent_ended:'; // ticket 286: the agent ended; the composer never types into its shell
export const NO_INTERRUPT = 'no_interrupt:'; // a kind with no running turn to break: stays queued

import type { Answer } from './queue/answer'; // V2-8e
import type { Layout } from './layout/model';
import type { BoardDecision, Decision, Session, TreeEdit, TreeState } from './types';
import type { ListedWorktree } from './tree';
import { makeT, type Language } from './i18n';

/** F24: the one place a core's refusal becomes window text. `malformed request` is the core's fixed answer to an op or
 *  field it does not know (http/mod.rs), so it can only mean this window is newer than the core. */
const refusalText = (error: string) =>
  error === 'malformed request' ? makeT((document.documentElement.lang || 'en') as Language, navigator.language)('core.tooOld') : error;

export interface Boot {
  port: number;
  token: string;
  /** macOS "Select the previous input source" holds Ctrl+Space (read by the app shell at launch). */
  ctrlSpaceTaken?: boolean;
  /** G2: this window is a build that updates itself: an RC or an official release (never set in any other build). */
  rcUpdates?: boolean;
  /** F24: an older core was left running because a live session could not survive replacing it. */
  coreKept?: boolean;
  /** 11-20 guard: this run does not update or stop the core (another copy started it, or no CLI of its own); `logs/core.log` says why. */
  coreForeign?: boolean;
  /** V2.5-15: a paired browser on the core's browser listener; the socket goes to this page's own host. */
  browser?: boolean;
}

/** V2.5-15: the Mac window's `browser` event: pairings waiting for Allow and what browsers did. */
export type PairRequest = { id: string; name: string; code: string; peer: string; loopback: boolean };
export type BrowserNotice = { seq: number; device: string; name: string; action: 'answer' | 'reply'; at_ms: number };
export type BrowserDevice = { id: string; name: string; last_used_ms: number; peer: string };
export type BrowserStatus = { enabled: boolean; port: number; addresses: string[]; tailscale: boolean; problem: string | null; devices: BrowserDevice[] };
export type BrowserOp =
  | { op: 'status' }
  | { op: 'set'; enabled: boolean; port?: number }
  | { op: 'answer'; id: string; allow: boolean }
  | { op: 'revoke'; device: string | null };

declare global {
  interface Window {
    __NUNCHIRO__?: Boot;
  }
}

/** Owner 11-16: an account's shown name. The agent's own account (`default`) reads "Default" in the window's language
 *  until the owner renames it (accounts.rs `OWN_LABEL`; "Your own" is its name in reset-log lines written before). */
export const accountName = (t: (key: 'usage.own') => string, a: { default?: boolean; label: string }) => (a.default && (a.label === 'Default' || a.label === 'Your own') ? t('usage.own') : a.label);

/** V2-2a: one row of Settings > Accounts; `default` marks "Your own" (id `own`, never removable). */
export type AccountAgent = 'claude' | 'codex';
/** CHAT-USAGE: the last reply's context tokens and model window; Unknown carries no numeric value. */
/** B15 (ticket 991): `model` is what the transcript last named; `session_model` has the model but no trusted window.
 *  Ticket 994: `effort` is what that model's last request ran at, when the agent wrote one. */
export type SessionContext = { type: 'session_context'; used: number; window: number; model?: string; effort?: string } | { type: 'session_model'; model: string; effort?: string } | { type: 'unknown' };

/** V2-2c: tokens (input + output + cache read + cache write) for the local day and the last 7 local days. */
export interface AccountUsage {
  agent: AccountAgent;
  id: string;
  today: number;
  week: number;
  /** The core's work cap ran out first: the numbers are a lower bound. */
  partial: boolean;
  /** V2-2c limit mark: the reset time a session on this account showed with its usage limit ("11pm"); absent otherwise. */
  limit_resets?: string;
  /** V2.5-10: rolling 24 h and 7 d; `cost_micro` is a list-price estimate in millionths of a US dollar over the priced tokens, `unpriced` the tokens of models with no price. */
  last_24h: UsageWindow;
  last_7d: UsageWindow;
  /** The agent's own record of its session and weekly limit still ahead (Codex); absent when no local source has one. */
  session?: UsageLimit;
  weekly?: UsageLimit;
  /** Ticket 1036: when Claude Code last handed this Claude account's limits to its status line (epoch seconds). */
  limits_at?: number;
}
export interface UsageWindow {
  tokens: number;
  cost_micro: number;
  unpriced: number;
}
export interface UsageLimit {
  left_pct: number;
  /** Epoch seconds. */
  resets_at: number;
}
/** Ticket 178 finding 20: one browser sign-in attempt (account_signin.rs `State`). */
/** Ticket 370: `projects::clone::State`. `detail` is only for `other`, with any credentials removed by the core. */
export interface CloneState {
  job: string;
  phase: 'cloning' | 'done' | 'failed' | 'cancelled';
  stage: string | null;
  percent: number;
  kind: 'auth' | 'ssh' | 'timeout' | 'exists' | 'refused' | 'other' | null;
  parent: boolean;
  path: string | null;
  detail: string | null;
  removed: boolean;
}
export interface SignInState {
  attempt: string;
  agent: AccountAgent;
  phase: 'starting' | 'waiting' | 'signed_in' | 'failed' | 'cancelled';
  /** Present once it passed the core's allowlist: the link the browser opened, for Copy link. */
  link: string | null;
  /** The login reads a pasted code (Claude). */
  paste: boolean;
  reason: 'code_rejected' | 'exited' | 'no_link' | 'bad_link' | 'timed_out' | 'not_signed_in' | 'start_failed' | 'unknown' | 'not_saved' | null;
  code: number | null;
  account: Account | null;
}
export interface Account {
  agent: AccountAgent;
  id: string;
  label: string;
  folder: string;
  signed_in: 'yes' | 'no' | 'unknown';
  default: boolean;
  /** Ticket 322: the owner picked this account for new sessions of its agent. */
  session_default?: boolean;
  /** Ticket 358: on "Your own" when the picked default's account is gone and new sessions fell back here. */
  fell_back?: boolean;
  /** Ticket 323: the plan word of a signed-in Claude account, from its status command. */
  plan?: string;
  /** Ticket 423 round 2: an account_check reply whose check still waits for a probe slot; the page asks again. */
  checking?: boolean;
}

/** V2-4b: the ACP agent rows and checks of Settings > Agents (crates/nunchiro-core/src/acp: `AcpRow`, `probe::Check`). */
export type AgentApproval = 'unapproved' | 'approved' | 'changed';
export interface AcpRow {
  name: string;
  label: string;
  command: string;
  args: string[];
  env: string[];
  source: 'known' | 'service' | 'custom';
  /** Per name in `env`: whether the core has a value to pass (never the value). */
  env_set?: Record<string, boolean>;
  /** False: a terminal-only CLI (no chat view or waiting detection). */
  acp: boolean;
  found_path: string | null;
  version: string | null;
  install_url: string | null;
  /** Null: not in agents.toml yet. */
  state: AgentApproval | null;
  hash: string | null;
  refused: string | null;
  /** Ticket 358: the owner's name for the entry, when set (`label` already shows it). */
  display?: string | null;
  docs_url?: string | null;
  source_url?: string | null;
  /** What 진단 복사 copies; never a variable's value. */
  diagnostics?: string;
  /** Ticket 358: the models this agent last reported; none: no 모델 section. */
  models?: { value: string; label: string }[];
  /** Ticket 994: the thinking levels it last reported, as it listed them; none: it has none. */
  efforts?: { value: string; label: string }[];
}
/** Ticket 358: crates/nunchiro-core/src/agent_update.rs `Row`. `run` is absent once an update worked or was cancelled. */
export interface ToolUpdate {
  tool: string;
  path: string;
  installed: string | null;
  latest: string | null;
  newer: boolean;
  can_update: boolean;
  /** Display text from the core's table, set only when `can_update`; a start sends the tool name alone. */
  command: string | null;
  /** Tools naming the same installer run one at a time; absent: the tool updates itself. */
  installer: string | null;
  run: { phase: 'running' | 'failed' | 'unchanged'; text: string; reason: 'exited' | 'timed_out' | 'start_failed' | null; code: number | null } | null;
}
export interface TerminalAgent {
  agent: AccountAgent;
  found: boolean;
  path?: string | null;
  version: string | null;
  sessions: number;
}
export interface AcpEntry {
  name: string;
  command: string;
  args: string[];
  env: string[];
  /** Ticket 358: outside the approval hash. */
  display?: string;
}
export interface AcpCheck {
  found_path: string | null;
  version: string | null;
  acp_v1_ms: number | null;
  capabilities: string[];
  signed_in: boolean | null;
  error: string | null;
  env_set?: Record<string, boolean>;
  auth_methods?: AcpAuthMethod[]; // ticket 358
  can_logout?: boolean;
  sign_in?: AcpSignIn | null;
}
/** Ticket 358: a sign-in method the agent reports; `env_var` never reaches the window. */
export interface AcpAuthMethod {
  id: string;
  name: string;
  kind: 'agent' | 'terminal';
}
export interface AcpSignIn {
  attempt: string;
  name: string;
  method: string;
  phase: 'starting' | 'waiting' | 'signed_in' | 'failed' | 'cancelled';
  link: string | null;
  reason: string | null;
}
/** Ticket 358: Claude's or Codex's own command; `state` null means no override (the agent on PATH runs). */
export interface CommandView {
  agent: string;
  state: 'approved' | 'changed' | 'unapproved' | null;
  approved: AcpEntry | null;
  pending: AcpEntry | null;
  env_set: Record<string, boolean>;
}
export interface CommandCheck {
  version: string | null;
  error: string | null;
  hash: string | null;
  env_set: Record<string, boolean>;
}
export interface AgentView {
  name: string;
  state: AgentApproval;
  hash: string;
  entry: AcpEntry;
  refused?: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
/** `replay` marks the first frame after a (re)watch: bytes the agent wrote while this window was not looking. */
export type Output = { session: string; start: number; end: number; truncated: boolean; data: Uint8Array; replay: boolean };
/** layout.toml as the core read it: `layout` null = no file (default) or invalid (`error` names the line). */
export type LayoutFile = { layout: Layout | null; error: string | null };
/** Gets each output frame; calls `parsed` once xterm parsed it (V1A-53: the core's pacing waits on that). */
type Listener = (o: Output, parsed: () => void) => void;

/** V2-8c: the core's live PR answer; `watched` and `live` are about the PR asked for. */
export interface PrLive {
  on: boolean;
  offered: boolean;
  watched: boolean;
  live: { state: string; url: string } | null;
  hint: string | null;
}

/** V2.5-8: the PR view as the core parsed it from the user's gh (crates/nunchiro-core/src/pr/mod.rs `View`). */
export interface PrView {
  url: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  author: string;
  body: string;
  created_at: string;
  head: string;
  head_ref: string;
  base_ref: string;
  review: string;
  mergeable: string;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  /** Ticket 373: the failing checks (outside text; `url` is https or empty). */
  failed?: PrFailed[];
  /** Ticket 373: false for a PR only the by-branch lookup found: shown, never merged here. */
  merge?: boolean;
  additions: number;
  deletions: number;
  labels: string[];
  reviewers: { who: string; state: string }[];
  timeline: { at: string; kind: 'commit' | 'review' | 'comment'; who: string; state: string; text: string }[];
  files: { path: string; additions: number; deletions: number }[];
  diff: string;
  diff_cut: boolean;
}
/** Ticket 373: one failing check (`pr::Failed`). */
export interface PrFailed {
  name: string;
  url: string;
}
/** Ticket 373: the PR of a worktree's own branch (`pr::BranchPr`), whoever opened it. */
export interface PrBranch {
  url: string;
  number: number;
  state: 'draft' | 'open' | 'checks_pass' | 'checks_fail' | 'approved' | 'merged' | 'closed';
  failed: PrFailed[];
}
/** V2.5-9: one row of the PR list (`Item`). */
export interface PrItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  updated_at: string;
  review: string;
  mergeable: string;
  checks: PrView['checks'];
}

/** V2-10c: one pinned artifact library (crates/nunchiro-core/src/libs/mod.rs `Entry`). */
export interface LibEntry {
  host: string;
  path: string;
  library: string;
  version: string;
  file: string;
  sha384: string;
  sha512: string;
  size: number;
  /** Unix seconds. */
  fetched_at: number;
  badge: 'verified' | 'unverified';
  first_requester: string;
}
/** `saved` false: the lockfile on disk was set aside; changes last until the core exits. */
export interface LibsList {
  entries: LibEntry[];
  auto_allow: { host: string; library: string }[];
  /** Ticket 366: the shipped default switches (on in a new lockfile); Settings marks them and keeps their rows. */
  defaults: { host: string; library: string }[];
  saved: boolean;
}
export type LibsOp =
  | { op: 'libs_list' }
  | { op: 'libs_allow'; url: string; integrity?: string; requester: string }
  | { op: 'libs_auto_allow'; host: string; library: string; on: boolean }
  | { op: 'libs_remove'; url: string };

/** V2-8a: the core's worktree op (crates/nunchiro-core/src/api.rs `Request::Worktree`). */
export type WorktreeLoss = { uncommitted: string[]; unpushed: string[]; uncommitted_total: number; unpushed_total: number; kept_on: string | null; ignored: string[]; ignored_total: number; too_large?: boolean; linked?: string[] };
export type WorktreeOp = {
  operation: 'list' | 'create' | 'open' | 'rename' | 'remove' | 'forget' | 'restore' | 'adopt' | 'branches' | 'team'; // ticket 990: team hands over (label = the lead's id) or takes back (label '')
  project?: string | null;
  path?: string | null;
  branch?: string | null;
  base?: string;
  label?: string;
  from?: string;
  confirm?: WorktreeLoss;
};
export type WorktreeCleaned = { id: number; project: string; path: string; branch: string; label: string; at_ms: number };
/** V2.5-61 B8: one branch of the `branches` op; `name` is short (`origin/x` for a remote ref), `branch` the name create
 * takes (after the remote). */
export type BranchRef = { name: string; branch: string; remote: boolean; in_worktree: boolean };
export type WorktreeReply = { worktrees?: ListedWorktree[]; loss?: WorktreeLoss; cleaned?: WorktreeCleaned[]; session?: Session; branches?: BranchRef[]; branches_dropped?: number; branches_truncated?: boolean };

/** Q4 job 1: a snapshot repeats what did not change, and a new object makes every memo and child below App draw again.
 *  Keeps the old object (and the old array when nothing changed) for each item whose JSON is the same; items match by
 *  `id` when they have one, else by place. */
export function share<T>(prev: T[], next: T[]): T[] {
  const key = (x: T, i: number) => (x as { id?: string }).id ?? i;
  const old = new Map(prev.map((x, i) => [key(x, i), x] as const));
  const out = next.map((x, i) => { const o = old.get(key(x, i)); return o !== undefined && JSON.stringify(o) === JSON.stringify(x) ? o : x; });
  return out.length === prev.length && out.every((x, i) => x === prev[i]) ? prev : out;
}

export class CoreClient {
  /** V2-8c: the window's own client (set by App.tsx), for views it does not pass one to: the PR chip. */
  static main: CoreClient | null = null;
  private ws: WebSocket | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  /** F22: requests made before the first connection opens (a view restored by a reload mounts before App connects) wait for it. */
  private waiting: { go: () => void; fail: () => void }[] = [];
  private everOpen = false;
  private closing = false;
  private outputs = new Map<string, Set<Listener>>();
  private cursors = new Map<string, number>();
  /** Listeners owed a whole replay: a session's first view (even an empty replay reaches it: a terminal waits for its
   *  replay to open and to tell the PTY its size), and one added to a session already watched (a pinned duplicate). */
  private fresh = new Map<string, Set<Listener>>();
  /** V1A-53: per session, output bytes parsed since the last watch's replay frame, acked to the core, which paces this
   * window by them and counts afresh from each watch. The core answers each watch with one replay frame, in order, so
   * counting starts when no sent watch is still `owed` its replay; a frame parsed after a newer watch is not counted. */
  private acks = new Map<string, { owed: number; live: boolean; bytes: number }>();
  /** V1A-53: each view's frames handed to it and not parsed yet; acked when the view closes, so every frame is acked once. */
  private unparsed = new Map<Listener, Set<() => void>>();
  private last = { s: [] as Session[], b: [] as BoardDecision[], o: [] as Decision[] };
  onSnapshot: (s: Session[], board: BoardDecision[], owner: Decision[]) => void = () => {}; // v1b-18: board; v1a-23: owner
  onStatus: (connected: boolean) => void = () => {};
  onLayout: (f: LayoutFile) => void = () => {};
  /** `nunchiro layout ...` forwarded by the core; answer with layoutDone. */
  onLayoutCommand: (seq: number, args: string[], file: LayoutFile) => void = () => {};
  /** Ticket 592: a room changed (a message or a pin); each Room panel reads what is new. Mac window only. */
  private rooms = new Set<() => void>();
  onRoom(f: () => void) {
    this.rooms.add(f);
    return () => void this.rooms.delete(f);
  }
  /** Every snapshot, changed or not: `share` keeps an unchanged one's arrays, so a reader that waits for any later snapshot
   *  (a held message the core's gate refused, useComposerSend) listens here. */
  private snaps = new Set<() => void>();
  onAnySnapshot(f: () => void) {
    this.snaps.add(f);
    return () => void this.snaps.delete(f);
  }
  /** The schedule list changed (the core's `{"event":"schedules"}`: an add, an edit, a switch, a run, a result), or the
   *  socket opened (a change while it was closed is not sent again). Mac window only. */
  private schedules = new Set<() => void>();
  onSchedules(f: () => void) {
    this.schedules.add(f);
    return () => void this.schedules.delete(f);
  }
  /** V2.5-15: Mac window only. */
  onBrowser: (pending: PairRequest[], notices: BrowserNotice[]) => void = () => {};
  /** 392: connections opened, and the last one whose first snapshot has arrived (`snapped === opened`: drawn), for loads
   * that wait until the window has drawn. */
  opened = 0;
  snapped = 0;

  constructor(private boot: Boot) {}

  connect() {
    this.closing = false;
    this.boot = window.__NUNCHIRO__ ?? this.boot; // F24: a replaced core has a new port and token; the shell hands them over
    const host = this.boot.browser ? location.host : `127.0.0.1:${this.boot.port}`;
    const ws = new WebSocket(`ws://${host}/ws`, ['nunchiro.v1', `nunchiro.token.${this.boot.token}`]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.everOpen = true;
      this.opened++; // 392
      this.last = { s: [], b: [], o: [] }; // each link's first snapshot is new arrays, so it draws even when unchanged: 392's wait (PastChats) reads `snapped` on that render
      for (const w of this.waiting.splice(0)) w.go();
      this.onStatus(true);
      // Re-watch after a reconnect from each session's last byte, so nothing is replayed twice.
      this.acks.clear(); // V1A-53: a new connection is paced afresh; replays owed on the old one never come
      for (const id of this.outputs.keys()) this.watchFrame(id, this.cursors.get(id) ?? 0);
      for (const f of this.schedules) f();
    };
    ws.onclose = () => {
      this.onStatus(false);
      for (const w of this.waiting.splice(0)) w.fail();
      for (const p of this.pending.values()) p.reject(new Error('core disconnected'));
      this.pending.clear();
      if (this.ws === ws) setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return this.binary(new Uint8Array(ev.data as ArrayBuffer));
      const msg = JSON.parse(ev.data);
      if (msg.event === 'snapshot') {
        const l = this.last = { s: share(this.last.s, msg.sessions as Session[]), b: share(this.last.b, (msg.board_decisions ?? []) as BoardDecision[]), o: share(this.last.o, (msg.owner_decisions ?? []) as Decision[]) };
        this.onSnapshot(l.s, l.b, l.o); // v1b-18; v1a-23
        for (const f of this.snaps) f();
      }
      if (msg.event === 'snapshot') this.snapped = this.opened; // 392: after onSnapshot, so the render it causes sees it
      if (msg.event === 'layout') this.onLayout({ layout: msg.layout, error: msg.error });
      if (msg.event === 'layout_command') this.onLayoutCommand(msg.seq, msg.args, msg.file);
      if (msg.event === 'room') for (const f of this.rooms) f(); // ticket 592
      if (msg.event === 'schedules') for (const f of this.schedules) f();
      if (msg.event === 'browser') this.onBrowser(msg.pending as PairRequest[], msg.notices as BrowserNotice[]); // V2.5-15
      // V1A-53: the core refused an ack (our count drifted from its own): watch afresh from what we have, so both count again.
      if (msg.event === 'ack_refused' && this.outputs.has(msg.session)) this.watchFrame(msg.session, this.cursors.get(msg.session) ?? 0);
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        if ('Ok' in msg.response) p.resolve(msg.response.Ok);
        else p.reject(new CoreRefusal(refusalText(String(msg.response.Err))));
      }
    };
    this.ws = ws;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.closing = true;
    for (const w of this.waiting.splice(0)) w.fail();
    ws?.close();
  }

  private binary(b: Uint8Array) {
    const n = new DataView(b.buffer, b.byteOffset).getUint32(0);
    const head = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n)));
    const out: Output = { ...head, data: b.subarray(4 + n) };
    const before = this.cursors.get(out.session) ?? 0;
    this.cursors.set(out.session, out.end);
    const fresh = out.replay ? this.fresh.get(out.session) : undefined;
    if (fresh) this.fresh.delete(out.session);
    let ack = this.acks.get(out.session);
    if (ack && out.replay && ack.owed > 0 && --ack.owed === 0) {
      ack = { owed: 0, live: true, bytes: 0 };
      if (this.outputs.has(out.session)) this.acks.set(out.session, ack);
      else this.acks.delete(out.session); // the replay of a watch whose views all closed
    }
    // The frame counts once the first view that got it parsed it or closed, or at once when no view gets it: an unacked
    // frame would hold the session for this window for good.
    let parsed = !ack?.live;
    const done = () => {
      if (parsed || this.acks.get(out.session) !== ack || !ack) return;
      parsed = true;
      ack.bytes += out.data.length;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ack: out.session, bytes: ack.bytes }));
    };
    const give = (f: Listener, o: Output) => {
      const left = this.unparsed.get(f) ?? new Set();
      this.unparsed.set(f, left);
      const d = () => {
        left.delete(d);
        done();
      };
      left.add(d);
      f(o, d);
    };
    let given = false;
    // Views that already had the bytes up to `before` get only what is new in a replay: a duplicate's from byte 0, or one
    // after a rewatch from the cursor (V1A-53 ack_refused) that frames still in flight then had already moved.
    // A replay that starts past `before` is a jump for every view and stays one (truncated); one that starts at or
    // before it continues the views that had those bytes. A duplicate's replay is new output to the other views: they
    // answer the terminal queries in it, the duplicate does not.
    const after = (o: Output) =>
      o.start > before ? o : { ...o, start: before, truncated: false, data: o.data.subarray(before - o.start) };
    for (const f of this.outputs.get(out.session) ?? []) {
      if (!out.replay || fresh?.has(f)) give(f, out);
      else if (out.end > before) give(f, fresh ? { ...after(out), replay: false } : after(out));
      else continue;
      given = true;
    }
    if (!given) done();
  }

  private send(frame: object): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const go = () => {
        if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('core disconnected'));
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ id, ...frame }));
      };
      if (this.ws?.readyState !== WebSocket.OPEN && !this.everOpen && !this.closing) this.waiting.push({ go, fail: () => reject(new Error('core disconnected')) });
      else go();
    });
  }

  request(request: { op: string; [k: string]: unknown }) {
    return this.send({ request });
  }

  /** V2.5-15: Settings > Browser access and the pairing sheet (window only; a browser is refused). */
  async browserAccess(op: BrowserOp): Promise<BrowserStatus> {
    return ((await this.send({ browser: op })) as { status: BrowserStatus }).status;
  }

  /** V2-8e: one answer for a waiting item (callers go through `answerOnce`). */
  answer(item: string, answer: Answer, confirmed = false) {
    return this.request({ op: 'answer', item, answer, confirmed });
  }

  /** A watch frame; the core counts this window's acks for the session afresh from it, and so does the window. */
  private watchFrame(session: string, after: number) {
    this.acks.set(session, { owed: (this.acks.get(session)?.owed ?? 0) + 1, live: false, bytes: 0 });
    // A refused watch (or one lost with the socket) gets no replay frame.
    this.send({ watch: session, after }).catch(() => {
      const ack = this.acks.get(session);
      if (ack?.owed) ack.owed--;
    });
  }

  /** Streams a session's PTY bytes from byte 0 (scrollback replay), then live. */
  watch(session: string, f: Listener): () => void {
    let set = this.outputs.get(session);
    if (!set) {
      set = new Set();
      this.outputs.set(session, set);
      this.cursors.set(session, 0);
      // Look 1117 v4f A S2-2: a shell that has printed nothing yet has an empty replay, which binary() gives a fresh view only.
      this.fresh.set(session, new Set([f]));
      this.watchFrame(session, 0);
    } else {
      // A second view of the same session (v1a-07b duplicates): ask for the replay again; see binary().
      this.fresh.set(session, (this.fresh.get(session) ?? new Set()).add(f));
      this.watchFrame(session, 0);
    }
    set.add(f);
    return () => {
      set.delete(f);
      // An emptied set stays: it still marks the coming replay as one no view needs whole (binary() acks it at once).
      this.fresh.get(session)?.delete(f);
      if (set.size === 0) {
        this.outputs.delete(session);
        this.cursors.delete(session);
        // Replays owed to watches already sent still come; a later watch must not count them as its own.
        const owed = this.acks.get(session)?.owed ?? 0;
        if (owed) this.acks.set(session, { owed, live: false, bytes: 0 });
        else this.acks.delete(session);
        this.send({ unwatch: session }).catch(() => {});
      }
      const left = this.unparsed.get(f);
      this.unparsed.delete(f);
      left?.forEach((d) => d());
    };
  }

  sendText(id: string, text: string, seen: string[] = [], composer = false) {
    return this.request({ op: 'send_text', id, text, ...(composer ? { composer, seen } : {}) });
  }
  /** `seen`: the pending item ids the window has drawn for this session; core refuses a bare Esc past any other (ticket 115).
   *  `composer`: this Enter submits text the window just sent; gated the same way (ticket 123). */
  sendKeys(id: string, keys: string[], seen: string[] = [], composer = false) {
    return this.request({ op: 'send_keys', id, keys, seen, ...(composer ? { composer } : {}) });
  }
  /** CHAT-PERMCHIP: keys through the logged delivery path (a pending decision refuses them), as the user. */
  agentKeys(id: string, keys: string[]) {
    return this.request({ op: 'agent_keys', id, keys });
  }
  /** CHAT-MODELIST: walks Claude's permission-mode cycle to `mode` (a footer name), one logged key at a time. */
  setMode(id: string, mode: string) {
    return this.request({ op: 'set_mode', id, mode });
  }
  label(id: string, label: string) {
    return this.request({ op: 'label', id, label });
  }
  resize(id: string, cols: number, rows: number) {
    return this.request({ op: 'resize', id, cols, rows });
  }
  /** V2-9a: tree.toml (groups, pins, fold keys); window and owner only. */
  /** V2-8a: `worktree` list, create (`from` = the one field), open, rename, remove (`confirm` = the loss shown), restore. */
  worktree(op: WorktreeOp): Promise<WorktreeReply> {
    return this.request({ op: 'worktree', project: null, path: null, branch: null, base: 'HEAD', label: '', ...op }) as Promise<WorktreeReply>;
  }

  async tree(): Promise<TreeState> {
    return ((await this.request({ op: 'tree_get' })) as { tree: TreeState }).tree;
  }
  /** One edit, on disk before the reply; a refused edit rejects and changes nothing. */
  async treeEdit(edit: TreeEdit): Promise<TreeState> {
    return ((await this.request({ op: 'tree_edit', edit })) as { tree: TreeState }).tree;
  }
  /** V2-2a: every account, "Your own" first per agent, each probed for its signed-in state (up to 5 s). With `share`, a
   *  list already on its way is joined: the window's connect readers (split starts, the status bar's account switch) send
   *  one, not one each, as each holds one of the core's 6 probe places for seconds (MAX_PROBE_JOBS, http/mod.rs). A read
   *  after an account changed does not share, so it never gets a list asked for before the change. */
  accounts(share = false): Promise<{ accounts: Account[] }> {
    if (share && this.listing) return this.listing;
    const list = this.busyRetry({ op: 'account_list' }) as Promise<{ accounts: Account[] }>;
    const done = () => void (this.listing === list && (this.listing = null));
    list.then(done, done);
    this.listing = list;
    return list;
  }
  private listing: Promise<{ accounts: Account[] }> | null = null;
  /** CHAT-USAGE: this conversation's last context count and model window (window only). */
  sessionContext(id: string) {
    return this.request({ op: 'session_context', id }) as Promise<SessionContext>;
  }
  /** V2-2c: tokens per account counted from the agents' local transcripts (window only). */
  /** Ticket 1031: `limits` reads only the records that carry limits (Codex), not days of Claude transcripts: the status
   *  bar's usage block reads on a timer, so it must be cheap. The rows keep their shape; Claude's token counts are 0. */
  accountUsage(limits = false) {
    return this.request({ op: 'account_usage', ...(limits ? { limits } : {}) }) as Promise<{ rows: AccountUsage[] }>;
  }
  /** Ticket 98: the user's own commands, skills (Claude) or prompts (Codex), read only from their config folders. */
  userCommands(kind: 'claude' | 'codex') {
    return this.request({ op: 'user_commands', kind }) as Promise<{ rows: { name: string; description: string; source: 'command' | 'skill' | 'prompt' }[] }>;
  }
  /** V2-2a r2: probes "Your own" for `agent` on the owner's request (the core runs it at most once a minute, unless `force`:
   *  the owner pressed Check, accounts probe 11-10). */
  checkAccount(agent: AccountAgent, force = false) {
    return this.busyRetry(force ? { op: 'account_check', agent, force } : { op: 'account_check', agent }) as Promise<{ account: Account }>;
  }
  /** V2-2a: makes the account's folder and opens its login tab (the agent's own login with only that folder). */
  addAccount(agent: AccountAgent, label: string) {
    return this.request({ op: 'account_add', agent, label }) as Promise<{ account: Account; session: Session }>;
  }
  /** Ticket 178 finding 20: starts the agent's own login headless and opens its sign-in link in the browser; a new
   * account (or the signed-out account `id`) is listed once its status command says signed in. */
  signIn(agent: AccountAgent, label: string, id?: string) {
    return this.request({ op: 'account_sign_in', agent, label, id }) as Promise<{ attempt: string }>;
  }
  signInState(attempt: string) {
    return this.request({ op: 'account_sign_in_state', attempt }) as Promise<{ state: SignInState }>;
  }
  /** The pasted code goes to the login's stdin only. */
  signInCode(attempt: string, code: string) {
    return this.request({ op: 'account_sign_in_code', attempt, code });
  }
  signInCancel(attempt: string) {
    return this.request({ op: 'account_sign_in_cancel', attempt });
  }
  /** Ticket 358: each table tool found on the PATH, answered from memory; the core reads versions in the background. */
  agentUpdates() {
    return this.request({ op: 'agent_update_state' }) as Promise<{ rows: ToolUpdate[]; checked: boolean }>;
  }
  /** Runs the tool's one fixed command from the core's table; refused when its install path does not prove that command. */
  agentUpdateStart(tool: string) {
    return this.request({ op: 'agent_update_start', tool });
  }
  agentUpdateCancel(tool: string) {
    return this.request({ op: 'agent_update_cancel', tool });
  }
  /** Ticket 370: answers at once. A refused or existing target comes back as a failed state with no job. */
  cloneStart(url: string, parent: string) {
    return this.request({ op: 'project_clone', url, parent }) as Promise<{ state: CloneState }>;
  }
  cloneState(job: string) {
    return this.request({ op: 'project_clone_state', job }) as Promise<{ state: CloneState }>;
  }
  cloneCancel(job: string) {
    return this.request({ op: 'project_clone_cancel', job }) as Promise<{ state: CloneState }>;
  }
  /** V2-4b: terminal agents on the core's PATH and the ACP rows (bundled known list plus agents.toml). */
  acpAgents() {
    return this.busyRetry({ op: 'acp_agents' }) as Promise<{ terminal: TerminalAgent[]; acp: AcpRow[]; file: string }>;
  }
  /** Claude's and Codex's CLI on the core's PATH, and whether git answers (Settings > Onboarding). Walk 11: a busy refusal read as "No agent found". */
  firstRun() {
    return this.busyRetry({ op: 'first_run' }) as Promise<{ agents: { agent: AccountAgent; found: boolean; version: string | null }[]; git?: boolean }>;
  }
  // The core refuses a request past its in-flight cap (MAX_JOBS, http/mod.rs) while a burst (the window's connect, a
  // settings page's reads) is still running, and callers swallow a failed list: retry that refusal only, 3 tries over ~0.9 s.
  // Ticket 459: the account readers too (account_list, account_check), which take the core's probe places.
  private async busyRetry(req: { op: string; [k: string]: unknown }) {
    for (let tried = 1; ; tried++) {
      try {
        return await this.request(req);
      } catch (e) {
        if (tried >= 3 || !(e instanceof CoreRefusal) || !e.message.includes('too many requests in flight')) throw e;
        await new Promise((r) => setTimeout(r, 300 * tried));
      }
    }
  }
  /** V2-4b: the confined handshake check of a typed entry (before any approval; the core allows one at a time). */
  acpCheck(entry: AcpEntry, confirmed = false) {
    return this.request({ op: 'acp_agent_check', entry, ...(confirmed ? { confirmed: true } : {}) }) as Promise<AcpCheck & { type: 'acp_check' }>;
  }
  /** Ticket 358: Claude's or Codex's own command (owner only). */
  async commandStatus(agent: AccountAgent) {
    return ((await this.request({ op: 'agent_command_status', agent })) as { view: CommandView }).view;
  }
  /** Runs only `<path> --version`, confined; a pass holds the command and returns the hash the grant quotes. */
  async commandCheck(agent: AccountAgent, path: string, args: string[], env: string[]) {
    return ((await this.request({ op: 'agent_command_check', agent, path, args, env })) as { check: CommandCheck }).check;
  }
  async commandGrant(agent: AccountAgent, hash: string) {
    return ((await this.request({ op: 'agent_command_grant', agent, hash })) as { view: CommandView }).view;
  }
  /** Back to the PATH command; `draftOnly` drops just the held command. */
  async commandReset(agent: AccountAgent, draftOnly = false) {
    return ((await this.request({ op: 'agent_command_reset', agent, draft_only: draftOnly })) as { view: CommandView }).view;
  }
  /** V2-4b: appends one validated entry to agents.toml; never approves. */
  async acpAdd(entry: AcpEntry) {
    return ((await this.request({ op: 'acp_agent_add', entry })) as { view: AgentView }).view;
  }
  async acpStatus(name: string) {
    return ((await this.request({ op: 'acp_agent_status', name })) as { view: AgentView }).view;
  }
  async acpGrant(name: string, hash: string) {
    return ((await this.request({ op: 'acp_agent_grant', name, hash })) as { view: AgentView }).view;
  }
  /** V2-4b: a visible shell tab running the approved entry's own command (its login), in `project`. */
  acpLogin(name: string, project: string) {
    return this.request({ op: 'acp_agent_login', name, project }) as Promise<{ session: Session }>;
  }
  /** Ticket 358: an `agent` method starts an attempt to poll; a `terminal` method opens its tab in `project`. */
  acpSignIn(name: string, method: string, project?: string) {
    return this.request({ op: 'acp_agent_sign_in', name, method, ...(project ? { project } : {}) }) as Promise<{ state: AcpSignIn } | { session: Session }>;
  }
  async acpSignInState(attempt: string) {
    return ((await this.request({ op: 'acp_agent_sign_in_state', attempt })) as { state: AcpSignIn }).state;
  }
  acpSignInCancel(attempt: string) {
    return this.request({ op: 'acp_agent_sign_in_cancel', attempt });
  }
  acpSignOut(name: string) {
    return this.request({ op: 'acp_agent_sign_out', name });
  }
  /** V1A-47 Browse online: the core fetches and validates (window only); a name must be in the index. */
  themes(request: { op: 'theme_index' } | { op: 'theme_file'; name: string }) {
    return this.request(request);
  }
  /** V2-10c: the library cache. Window only (`libs::Op`): Allow, auto-allow and Remove are the owner's clicks, never an agent's. */
  libs(request: LibsOp) {
    return this.request(request);
  }
  saveLayout(layout: Layout) {
    return this.send({ layout_save: layout });
  }
  // V2-8c: live PR status (the core runs the user's gh; this window only reads what it parsed).
  prLive(req: { op: 'pr_live'; url?: string } | { op: 'pr_live_set'; on?: boolean; offered?: boolean } | { op: 'pr_watch'; url: string; on: boolean } | { op: 'pr_front'; front: boolean }) {
    return this.request(req) as Promise<PrLive>;
  }
  // V2.5-8/9: the PR view, list and merge (the core runs the user's gh; window only). A merge carries the head commit
  // the confirm step showed.
  prView(url: string) {
    return (this.request({ op: 'pr_view', url }) as Promise<{ view: PrView }>).then((r) => r.view);
  }
  prList() {
    return this.request({ op: 'pr_list' }) as Promise<{ prs: PrItem[]; hint: string | null }>;
  }
  prMerge(url: string, method: 'merge' | 'squash' | 'rebase', head: string) {
    return this.request({ op: 'pr_merge', url, method, head });
  }
  // Ticket 373: the PR of the branch checked out in `path` (live PR status on; window only); null when it has none.
  prBranch(path: string) {
    return (this.request({ op: 'pr_branch', path }) as Promise<{ pr: PrBranch | null }>).then((r) => r.pr);
  }
  /** This window is the one the user works in: `nunchiro layout` commands come here. */
  layoutFocus() {
    return this.send({ layout_focus: true });
  }
  layoutDone(seq: number, result: { text: string } | { error: string }) {
    return this.send({ layout_done: seq, ...result });
  }
}

/** Waits for the launch hand-off; the app shell may deliver it just after the page loads. */
export function waitForBoot(): Promise<Boot> {
  if (window.__NUNCHIRO__) return Promise.resolve(window.__NUNCHIRO__);
  return new Promise((resolve) =>
    window.addEventListener('nunchiro:boot', () => window.__NUNCHIRO__ && resolve(window.__NUNCHIRO__), { once: true }),
  );
}

/** Ticket 374: the `branches` reply names what a create with no base starts from (`origin/main`); a just-created worktree
 * names the default branch it used as last fetched when GitHub could not be reached. */
export type WorktreeBaseReply = WorktreeReply & { default_base?: string };
export type WorktreeStale = { stale_base?: string; shared_failed?: string[] }; // ticket 253: what a create did not share
/** Ticket 374: the core's PR-link refusals (worktree_clean.rs PR_FOREIGN, PR_FETCH), mapped to the window's words. */
export const PR_REFUSALS: Readonly<Record<string, 'wtbase.prForeign' | 'wtbase.prFetch' | 'wtbase.prStale'>> = {
  "this PR's repository is not a remote of this project": 'wtbase.prForeign',
  "could not fetch the PR's code; no branch or folder was made": 'wtbase.prFetch',
  "this PR's branch already exists at an older commit; delete it to check out the new head": 'wtbase.prStale',
};
