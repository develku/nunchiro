// Tree C model (spec Window (v1a), needs 34, 36, 49): pure, so placement rules are testable without a DOM.
import { tEn, type T } from './i18n';
import { agentState, blockedInput, shownStatus, status, type AgentKind, type Decision, type Session, type Status, type TreeState } from './types';
import { askTitle, asks } from './tree/decisions';
import { askedOn, promptPart } from './decisions/readable';
import { summary as askSummary } from './queue/answer';
import { leadOf, leadSeatMate, seatOf, workingFor, type Team } from './lead/lead';

export interface Worktree {
  path: string;
  name: string;
  sessions: Session[];
}

export interface Group {
  project: string;
  name: string;
  /** Most urgent state across the project's sessions; drives the 3 px group bar. */
  urgency: 'waiting' | 'limited' | 'stale' | 'working' | 'idle';
  counts: { working: number; waiting: number; attention: number };
  main: Session[];
  worktrees: Worktree[];
  /** Pending decisions (sessions and board), oldest first; the waiting rows and the head's waiting count. */
  items: Decision[];
}

export interface Machine {
  name: string;
  groups: Group[];
}

export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export function urgencyOf(statuses: Status[]): Group['urgency'] {
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('limited')) return 'limited'; // ticket 372
  if (statuses.includes('stale')) return 'stale';
  if (statuses.includes('working')) return 'working';
  return 'idle';
}

/**
 * Ticket 178: an account's own Login or Logout tab (accounts.rs `tab`, which sets the flag) is filed on the account's
 * row in Settings > Accounts, never as a tree project named after its folder. Anything else started in the folder (an
 * agent with tools among the credentials) stays in the tree with its asks, so the owner sees it. Ticket 322: the core's flag,
 * never a path and label, which any agent could start a shell with to hide it. The Accounts page shares this predicate.
 */
export const isAccountTab = (s: Pick<Session, 'kind' | 'account_tab'>) => s.kind === 'shell' && !!s.account_tab;
/** Opens a session's tab from outside the tree (the Accounts page's blocker rows); App listens. */
export const SESSION_OPEN = 'nunchiro:session.open';
export const openSession = (id: string) => window.dispatchEvent(new CustomEvent(SESSION_OPEN, { detail: { id } }));

/** Ticket 322: the new-session default changed; a cached account list reads again. */
export const ACCOUNTS_CHANGED = 'nunchiro:accounts.changed';

/** F15: a tree the core sent outside the tree's own edits (a folder picked in New session); the tree state listens. */
export const TREE_SET = 'nunchiro:tree.set';

/** Groups sessions by machine, then project, in first-seen order (never re-sorted); then the added projects with none. */
/** N10: a side chat that is no longer running (closed or ended): the tree and the Board leave it out. */
export const sideChatGone = (s: Session) => !!s.side_chat && s.state !== 'running';
/** Ticket 1067 (mockup 1): under a live lead a seat's asks are the lead row's one "N need you" pill, so the seat's row,
 *  its decision line and the project head leave them out. Stale flags and background notes stay (row states, not asks);
 *  with the asks gone, a failed seat reaches status()'s failed check and shows red. */
/** A seat is a session with parent or teammate set, not the lead itself, in a project whose lead's seat runs in `sessions`
 *  (review 1067 round 1: with no lead row drawn there, the seat keeps its own marks). `hushed`: the asks left out, by
 *  project; the head counts them. The lead's row reads as your turn while they wait, so a folded project or group, the
 *  strip and the "]" walk still reach them. */
/** `keep` (ticket 1115 step 1, review r2): workers whose own row shows under the drawn lead row (an open project and
 *  group). The approved 1115 mockup draws such a worker's ask on its own row, so it keeps its asks: no pill, no hush. */
export function withoutSeatAsks(sessions: Session[], team: Team, keep: ReadonlySet<string> = new Set()) {
  const leadRuns = (s: Session) => !!s.teammate && s.teammate === leadOf(team, s.project)?.id && agentState(s) === 'running'; // no lead: both ids undefined
  const drawn = new Set(sessions.filter(leadRuns).map((s) => s.project));
  const hushed = new Map<string, number>();
  const quiet = sessions.map((s) => {
    if (!(s.parent || s.teammate) || leadSeatMate(s, team) || !drawn.has(s.project) || keep.has(s.id)) return s;
    const n = asks(s.pending).length;
    if (n) hushed.set(s.project, (hushed.get(s.project) ?? 0) + n);
    return { ...s, pending: s.pending.filter((d) => !asks([d]).length), attention: { ...s.attention, waiting: false } };
  });
  return { sessions: quiet.map((s) => (hushed.has(s.project) && leadRuns(s) ? { ...s, attention: { ...s.attention, waiting: true } } : s)), hushed };
}

/** Ticket 1115 step 1 (docs/design/workers-1115/mockup.html, panel 2): the seats a running lead staffed (a parent chain to
 *  its seat, another teammate of its place, or a session in its team's worktree that a seat started), by id. They fold
 *  under the lead's row. A session the owner started (no parent, no teammate) is none, wherever it runs. */
export function leadWorkers(sessions: Session[], team: Team, list: ListedWorktree[] = []): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    if (!(s.parent || s.teammate) || leadSeatMate(s, team)) continue;
    const lead = workingFor(s, team, sessions, list);
    if (lead && seatOf(sessions, lead.id)?.project === s.project) out.add(s.id);
  }
  return out;
}
/** A Reviewer seat is a stage of its task, with no row of its own under the lead. The core's own fallback (roles.rs `of`).
 *  shortcut: a custom role that does not write still gets a row; read the ledger's seats when the tree needs them. */
export const isReviewer = (s: Session) => s.label.trim().toLowerCase().startsWith('review');

export function buildTree(sessions: Session[], order: string[], board: Decision[] = [], added: string[] = [], hushed: ReadonlyMap<string, number> = new Map()): Machine[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  // N10 (look 1117): a side chat that has ended is no row and no "done" count; it lives in its session's chat.
  const sorted = sessions.filter((s) => !isAccountTab(s) && !sideChatGone(s)).sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  const groups = new Map<string, Group>();
  // Ticket 980: a session on an SSH machine sits under that machine, never among this Mac's projects (the same path can
  // exist on both).
  const remote = new Map<string, Map<string, Group>>();
  for (const s of sorted) {
    const groups_ = s.machine ? (remote.get(s.machine) ?? remote.set(s.machine, new Map()).get(s.machine)!) : groups;
    let g = groups_.get(s.project);
    if (!g) {
      g = { project: s.project, name: basename(s.project), urgency: 'idle', counts: { working: 0, waiting: 0, attention: 0 }, main: [], worktrees: [], items: [] };
      groups_.set(s.project, g);
    }
    if (s.cwd === s.project) g.main.push(s);
    else {
      let w = g.worktrees.find((w) => w.path === s.cwd);
      if (!w) g.worktrees.push((w = { path: s.cwd, name: s.label || basename(s.cwd), sessions: [] }));
      w.sessions.push(s);
    }
    const st = shownStatus(s);
    if (st === 'working') g.counts.working++;
    if (st === 'waiting') g.counts.waiting++;
    if (st === 'stale' || st === 'failed') g.counts.attention++;
    // A session that is not running is done (GLOSSARY "Stale badge"): its stale flag is no row state, so no line either.
    g.items.push(...s.pending.filter((d) => d.kind !== 'stale' || s.state === 'running'));
  }
  // F15: a project added from its folder and no session yet is a head with no rows.
  for (const project of added) if (!groups.has(project)) groups.set(project, { project, name: basename(project), urgency: 'idle', counts: { working: 0, waiting: 0, attention: 0 }, main: [], worktrees: [], items: [] });
  // v1b-18: board items sit in their project's rows; an unknown project shows in the strip only.
  for (const d of board) groups.get(d.scope)?.items.push(d);
  for (const g of [...groups.values(), ...[...remote.values()].flatMap((m) => [...m.values()])]) {
    g.urgency = urgencyOf([...g.main, ...g.worktrees.flatMap((w) => w.sessions)].map(status));
    g.items.sort((a, b) => a.observed_at - b.observed_at);
    // The head's waiting count is what the rows show (plus overflow), not the number of waiting sessions.
    g.counts.waiting = asks(g.items).length + (hushed.get(g.project) ?? 0); // N12-S2-4: a background note rides on a line but is not waiting; 1067: seat asks on the lead's pill
  }
  // This Mac is first, also when it has no project (`withListed` puts this Mac's worktrees in the first entry).
  return groups.size || remote.size ? [{ name: 'this Mac', groups: [...groups.values()] }, ...[...remote].map(([name, m]) => ({ name, groups: [...m.values()] }))] : [];
}

/** 370: what a project reads as: the owner's name (tree.toml), else its folder name. */
export const projectName = (tree: TreeState, project: string) => tree.names?.[project] ?? basename(project);
/** 370: a close that ran while the session was live leaves a `closed` row in the core for good. Without a filing of its own (pin, group, added)
 * a project with only those has no head, so a removed one leaves; a filed one keeps its head and rows. */
export function withoutClosedHeads(machines: Machine[], tree: TreeState): Machine[] {
  const filed = (p: string) => tree.pins.includes(p) || tree.groups.some((g) => g.projects.includes(p)) || !!tree.added?.includes(p);
  const closedOnly = (g: Group) => [...g.main, ...g.worktrees.flatMap((w) => w.sessions)].every((s) => s.state === 'closed');
  return machines.map((m) => ({ ...m, groups: m.groups.filter((g) => filed(g.project) || !closedOnly(g)) })).filter((m) => m.groups.length);
}
/** Applied once over the finished tree, so every head gets it, the ones `withListed` adds too. */
export const withNames = (machines: Machine[], tree: TreeState): Machine[] => (tree.names ? machines.map((m) => ({ ...m, groups: m.groups.map((g) => ({ ...g, name: projectName(tree, g.project) })) })) : machines);

export interface Rows {
  items: { item: Decision; answered: boolean }[];
  /** Waiting items past the two rows. */
  more: number;
  /** Items that arrived while frozen; they wait as a chip on the head row. */
  fresh: number;
}

/**
 * Up to two waiting rows, nothing reserved (needs 49). Frozen, the rows are the ones shown at freeze: an item
 * answered since stays as an answered row, one that arrived since only counts as `fresh`.
 */
export function rows(live: Decision[], frozen: Decision[] | null): Rows {
  if (!frozen) return { items: live.slice(0, 2).map((item) => ({ item, answered: false })), more: Math.max(0, live.length - 2), fresh: 0 };
  const now = new Map(live.map((i) => [i.id, i]));
  const kept = frozen.map((f) => ({ item: now.get(f.id) ?? f, answered: !now.has(f.id) }));
  const was = new Set(frozen.map((f) => f.id));
  return { items: kept.slice(0, 2), more: Math.max(0, kept.length - 2), fresh: live.filter((i) => !was.has(i.id)).length };
}

// V2-9a project groups. A project group is a named folding row of projects (see GLOSSARY); `Group` above is one project.
export const EMPTY_TREE: TreeState = { groups: [], pins: [], folded: [] };
/** A folded group's key as the core stores it. */
export const foldGroup = (name: string) => `group:${name}`;

export interface ProjectGroup {
  /** null: the ungrouped part, drawn first and without a header. */
  name: string | null;
  urgency: Group['urgency'];
  counts: Group['counts'];
  /** Pinned, then the rest; each in first-seen order. A project is never folded away for being idle (ticket 370 item 361). */
  pinned: Group[];
  open: Group[];
  /** Pending decisions of every project in it, oldest first. */
  items: Decision[];
}

const WORST: Group['urgency'][] = ['waiting', 'limited', 'stale', 'working', 'idle'];

/** Most urgent state and summed counts across projects. */
export function summary(projects: Group[]): Pick<ProjectGroup, 'urgency' | 'counts'> {
  const counts = { working: 0, waiting: 0, attention: 0 };
  for (const g of projects) (counts.working += g.counts.working), (counts.waiting += g.counts.waiting), (counts.attention += g.counts.attention);
  return { urgency: WORST.find((u) => projects.some((g) => g.urgency === u)) ?? 'idle', counts };
}

function gather(name: string | null, projects: Group[], pins: ReadonlySet<string>): ProjectGroup {
  return {
    name,
    ...summary(projects),
    pinned: projects.filter((g) => pins.has(g.project)),
    open: projects.filter((g) => !pins.has(g.project)),
    items: projects.flatMap((g) => g.items).sort((a, b) => a.observed_at - b.observed_at),
  };
}

/**
 * Projects into the ungrouped part and then each group in the core's order (creation order). A project in a group the
 * core lists but that has no session here is skipped; a group with none of its projects here is not drawn.
 */
export function place(projects: Group[], tree: TreeState): ProjectGroup[] {
  const pins = new Set(tree.pins);
  const byPath = new Map(projects.map((g) => [g.project, g]));
  const taken = new Set<string>();
  const grouped = tree.groups.flatMap((tg) => {
    const members = tg.projects.flatMap((p) => (byPath.has(p) && !taken.has(p) ? (taken.add(p), [byPath.get(p)!]) : []));
    return members.length ? [gather(tg.name, members, pins)] : [];
  });
  const loose = projects.filter((g) => !taken.has(g.project));
  return [...(loose.length ? [gather(null, loose, pins)] : []), ...grouped];
}

export interface PickerRow {
  group: Group;
  groupName: string | null;
}
const rank = (g: Group, unread: ReadonlySet<string>) => {
  const all = [...g.main, ...g.worktrees.flatMap((w) => w.sessions)].map(status);
  if (g.items.length || all.includes('waiting')) return 0;
  if (all.includes('failed') || all.includes('limited')) return 1; // ticket 372: stopped until its reset
  if (unread.has(g.project)) return 2;
  return all.includes('working') || all.includes('stale') ? 3 : 4;
};
const lastActivity = (g: Group) => Math.max(0, ...[...g.main, ...g.worktrees.flatMap((w) => w.sessions)].map((s) => s.attention.last_activity));

/** Every project, groups ignored: waiting, failed, unread result, working, then last activity (newest first). */
export function pickerList(projects: Group[], tree: TreeState, unread: ReadonlySet<string>): PickerRow[] {
  const home = new Map(tree.groups.flatMap((tg) => tg.projects.map((p) => [p, tg.name] as const)).reverse());
  return projects
    .map((group, i) => ({ group, groupName: home.get(group.project) ?? null, r: rank(group, unread), at: lastActivity(group), i }))
    .sort((a, b) => a.r - b.r || b.at - a.at || a.i - b.i)
    .map(({ group, groupName }) => ({ group, groupName }));
}

/** tree.toml `folded`: `group:<name>` listed = that group is folded. `quiet:` keys an older version wrote mean nothing now and stay in the file. */
export const groupFolded = (t: TreeState, name: string) => t.folded.includes(foldGroup(name));
/** The list that shows every project header: no folded group. */
export const expandedList = (t: TreeState) => t.folded.filter((k) => !k.startsWith('group:'));
export const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));

/** The palette command tree.expand-all reaches the tree through this event ({ detail: { deep } }). */
export const EXPAND_ALL = 'nunchiro:tree.expand-all';

// TREEROWS: one row per worktree, with one state, one icon and one tooltip. Pure; the clock is a parameter.
/** What the later lanes know about a worktree (V2-8a worktree facts, V2-8b PR chip); the sidebar takes a map by worktree path. */
export type WorktreeFact = {
  pr?: { number: number; state: 'draft' | 'open' | 'checks_pass' | 'checks_fail' | 'approved' | 'merged' | 'closed'; age?: number; failed?: string };
  gone?: boolean;
  branch?: string;
  newBranch?: boolean;
};

export interface RowState {
  kind: 'hand' | 'ask' | 'fail' | 'work' | 'pr' | 'merge' | 'new' | 'gone' | 'stale' | 'idle' | 'limit';
  tone: 'you' | 'bad' | 'run' | 'ok' | 'done' | 'idle' | 'warn';
  /** First line bold, second line normal; also the row's aria-label. */
  tip: [string, string?];
  /** `#53` after the name: only a working row with a PR. */
  pr?: number;
  /** Observed time of the oldest decision on a your-turn row; orders those rows. */
  at?: number;
  /** CHAT-MODELIST (ticket 285): a running Claude session of this row is in Skip permissions, or (ticket 991) a Codex one in
   *  full access (named Bypass permissions as Claude's in English); the row wears the chip's warning mark, and this is the mark's name in the mode's own words. */
  skip?: string;
  /** Ticket 462: an `idle` row whose agent has ended (Finished, the mockup's resting row): the check icon (look 1117 v11 A-S3-6), not the dashed circle. */
  rest?: true;
}

const WHO: Record<AgentKind, (t: T) => string> = { claude: () => 'Claude', codex: () => 'Codex', shell: (t) => t('firstrun.shell'), acp: (t) => t('walk8.who.acp') }; // ticket 740: product names stay English
/** An age or a duration in the window's language ("2 min" / "2분"): minutes, hours, days; under a minute is
 *  `tree.age.subMinute`, since the mockup's samples start at 1분. The row's .tm, its tips and the Decisions card's age. */
export const age = (t: T, ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  const n = (base: 'tree.age.minutes' | 'tree.age.hours' | 'tree.age.days', v: number) => t(`${base}.${v === 1 ? 'one' : 'other'}`, { n: v });
  return m < 1 ? t('tree.age.subMinute') : m < 60 ? n('tree.age.minutes', m) : m < 1440 ? n('tree.age.hours', Math.floor(m / 60)) : n('tree.age.days', Math.floor(m / 1440));
};
const first = (text: string) => text.split('\n')[0].trim();
const QUESTION_MAX = 120;
/** Ticket 412: a question's words for its row (and so its accessible name), never its JSON: the first question's text,
 * cut to QUESTION_MAX; an unreadable payload gives '' (the row then says "Question"). Screen text (sixth look: a lead's
 * question was named by the terminal's rule above it, "Question · ─────…") gives the question the prompt asks, else the
 * line the row shows under it (`summary`), and '' when that has no word in it. */
export function questionText(text: string): string {
  let q: unknown;
  if (/^\s*[{[]/.test(text))
    try {
      const v = JSON.parse(text);
      q = v?.questions?.[0]?.question ?? v?.questions?.[0]?.title ?? v?.question; // Codex async: `title` (look 11-17 N20)
    } catch {
      q = '';
    }
  else q = askedOn(promptPart(text)) || askSummary({ text } as Decision);
  const s = typeof q === 'string' && /[\p{L}\p{N}]/u.test(q) ? first(q) : '';
  return s.length > QUESTION_MAX ? `${s.slice(0, QUESTION_MAX - 1).trimEnd()}…` : s;
}

/**
 * `unread` is the window's words for an unread session on this row (needs 170 (1), "Finished · not seen yet"). It rides as the
 * tip's second line on a quiet row only (idle, stale or a PR open: the states whose tip is one line); a row that is asking,
 * broken or working says what it is, and merged or gone rows leave the list. No new colour or icon. `dialog` is the window's
 * title for an agent's own terminal dialog (queue kind `dialog`): a prompt to answer there, as its decision card says, not a permission.
 * `t` gives the tips' words (ticket 701); a caller that only reads `kind` may leave it out.
 */
export function rowState(w: Worktree, sessions: Session[], fact?: WorktreeFact, now = Date.now(), unread?: string, t: T = tEn): RowState {
  const base = baseRowState(w, sessions, fact, now, t);
  // Ticket 991: a Codex session started in full access (`permission_mode` full-access, perm-chip.ts) wears the mark too, under its own words.
  const skip = sessions.find((s) => s.state === 'running' && (s.permission_mode === 'bypass permissions' || (s.kind === 'codex' && s.permission_mode === 'full-access')));
  const r: RowState = skip ? { ...base, skip: t(skip.kind === 'codex' ? 'agents.new.permYolo' : 'mode.rowSkip') } : base;
  return unread && !r.tip[1] && ['idle', 'stale', 'pr'].includes(r.kind) ? { ...r, tip: [r.tip[0], unread] } : r;
}

function baseRowState(w: Worktree, sessions: Session[], fact: WorktreeFact | undefined, now: number, t: T): RowState {
  void w;
  const span = (ms: number) => age(t, ms);
  const by = (st: Status) => sessions.find((s) => status(s) === st);
  const who = (s: Session) => (s.account ? `${WHO[s.kind](t)} · ${s.account}` : WHO[s.kind](t)); // ticket 1070: the account the Agents widget showed
  // q67 look (new 6, 9): a state's word is the status bar's own (`mw.status.*`), in its form and case: the row said
  // "Idle · Shell" beside "idle · Shell", and in Spanish "Inactivo" beside "inactiva".
  const said = (st: 'working' | 'asked' | 'stale' | 'idle' | 'resumable' | 'done', rest: string) => `${t(`mw.status.${st}`)} · ${rest}`;
  const asks = sessions.flatMap((s) => s.pending.filter((d) => d.kind !== 'stale').map((d) => ({ s, d }))).sort((a, b) => a.d.observed_at - b.d.observed_at);
  const waiting = by('waiting');
  if (waiting) {
    const { s, d } = asks[0] ?? { s: waiting, d: undefined };
    // A waiting session with no pending item (the screen says it waits): ask-icon "Your turn".
    const hand = !!d && (d.kind === 'permission' || d.kind === 'dialog');
    // B20 (ticket 991): a permission names what it asks to do; a screen prompt's first line is no summary.
    const text = !d ? '' : d.kind === 'question' ? questionText(d.text) : (d.kind === 'permission' && askTitle(d, t)) || (d.kind === 'dialog' && /^\s*[❯>]?\s*\d+\.\s/m.test(d.text) ? '' : first(d.text));
    const head = t(!d ? 'palette.state.you' : d.kind === 'dialog' ? 'tree.status.dialogTip' : hand ? 'walk8.tip.permission' : 'walk8.tip.question');
    return { kind: hand ? 'hand' : 'ask', tone: 'you', tip: [text ? `${head} · ${text}` : head, t('walk8.tip.asked', { who: who(s), age: span(now - (d ? d.observed_at : s.attention.last_activity)) })], at: d?.observed_at ?? 0 };
  }
  // Ticket 372 (option A): a usage limit is a yellow clock right after your turn; its reset is the tip.
  const limited = by('limited');
  if (limited?.limit) return { kind: 'limit', tone: 'warn', tip: [t('walk8.tip.limit', { time: limited.limit.resets }), who(limited)] };
  // Look 1117 v12 B N11-S2-3: a turn blocked in `agent ask --wait` is no work on the row; it waits for its answer.
  const working = sessions.find((s) => shownStatus(s) === 'working');
  const asked = sessions.find((s) => shownStatus(s) === 'asked');
  // Merged and gone only apply when nobody is working or waiting.
  if (!working && !asked && fact?.gone) return { kind: 'gone', tone: 'idle', tip: [t('dialog.tidy.group.gone'), t('walk8.tip.goneWhy')] };
  if (!working && !asked && fact?.pr?.state === 'merged') return { kind: 'merge', tone: 'done', tip: [`${t('walk8.tip.merged', { n: fact.pr.number })}${fact.pr.age === undefined ? '' : ` · ${span(fact.pr.age)}`}`, t('walk8.tip.branchKept')] };
  const failed = by('failed');
  if (failed && blockedInput(failed)) return { kind: 'fail', tone: 'bad', tip: [`${t('mw.status.inputBlocked')} · ${who(failed)}`, t('mw.inputBlockedTip')] }; // v19-Q9-cx
  if (failed) return { kind: 'fail', tone: 'bad', tip: [t('walk8.tip.failed'), `${who(failed)} · ${span(now - failed.attention.last_activity)}`] };
  if (working) {
    const n = fact?.pr && !['merged', 'closed'].includes(fact.pr.state) ? fact.pr.number : undefined;
    // Q7 item 12: the row's time is how long this turn has been working.
    return { kind: 'work', tone: 'run', tip: [said('working', who(working)), ...(n ? [t('walk8.tip.prChecks', { n })] : [])] as RowState['tip'], pr: n, at: working.attention.working_since || undefined };
  }
  if (asked) return { kind: 'idle', tone: 'idle', tip: [said('asked', who(asked))] };
  if (fact?.pr?.state === 'checks_fail') return { kind: 'fail', tone: 'bad', tip: [t('walk8.tip.checksFail', { n: fact.pr.number }), fact.pr.failed] };
  const stale = by('stale');
  if (stale) return { kind: 'stale', tone: 'idle', tip: [said('stale', t('walk8.tip.stale', { age: span(now - stale.attention.last_activity) }))] };
  if (fact?.pr && fact.pr.state !== 'closed') return { kind: 'pr', tone: 'ok', tip: [t('walk8.tip.prOpen', { n: fact.pr.number })] };
  if (!sessions.length) return { kind: 'new', tone: 'idle', tip: [t('walk8.tip.new')] };
  // A restarted session joins its finished one on the row: the live one names the row (verify look, ticket 991 A7).
  const s = sessions.find((x) => agentState(x) === 'running') ?? sessions[0];
  const running = agentState(s) === 'running';
  return { kind: 'idle', tone: 'idle', ...(running ? {} : { rest: true as const }), tip: [said(running ? 'idle' : s.state === 'resumable' ? 'resumable' : 'done', who(s))] }; // look 1117 v4: a resumable row says so
}

// Ticket 991 A12 (two surveys): a row no longer moves when its session starts or stops working; only what needs the person
// (your turn, a limit, broken) moves to the top. Working, stale, PR and idle rows keep their first-seen order.
const TIER: Record<RowState['kind'], number> = { hand: 0, ask: 0, limit: 0.5, fail: 1, work: 2, stale: 2, pr: 2, idle: 2, new: 2, merge: 6, gone: 6 };
/** What needs the person first: your turn (oldest decision first), a limit, broken; then the rest. Stable: ties keep first-seen order. */
export const byUrgency = <T extends { state: RowState }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => TIER[a.state.kind] - TIER[b.state.kind] || (TIER[a.state.kind] === 0 ? (a.state.at ?? 0) - (b.state.at ?? 0) : 0));

/** Merged and gone rows leave the list for the clean-up line. */
export const leaves = (r: RowState) => r.kind === 'merge' || r.kind === 'gone';

export const BAR_MAX = 8;
/** The folded header's segments, one per row in urgency order; more than `BAR_MAX` become `+N`. */
export function barOf(rows: RowState[]): { tones: RowState['tone'][]; more: number } {
  const live = byUrgency(rows.filter((r) => !leaves(r)).map((state) => ({ state }))).map((r) => r.state);
  return { tones: live.slice(0, BAR_MAX).map((r) => r.tone), more: Math.max(0, live.length - BAR_MAX) };
}

/** Worktrees of a project whose fact says merged or gone (and that nobody is working in): the clean-up line's rows. */
export function cleanable(g: Group, facts: ReadonlyMap<string, WorktreeFact>, now = Date.now()) {
  return g.worktrees.map((w) => ({ w, state: rowState(w, w.sessions, facts.get(w.path), now) })).filter((x) => leaves(x.state));
}

/** What a head's count pill opens (needs 171): the first decision (oldest first), else the first session that waits with no
 *  item filed; for `failed`, the first failed session. A decision opens as a click on its row does; a session opens its tab. */
export type FirstRow = { item: Decision } | { session: string };
export function firstOf(kind: 'waiting' | 'failed', projects: Group[]): FirstRow | null {
  const sessions = projects.flatMap((g) => [...g.main, ...g.worktrees.flatMap((w) => w.sessions)]);
  if (kind === 'failed') {
    const s = sessions.find((x) => status(x) === 'failed');
    return s ? { session: s.id } : null;
  }
  const items = projects.flatMap((g) => g.items).sort((a, b) => a.observed_at - b.observed_at);
  const item = items.find((d) => d.kind !== 'stale' && d.kind !== 'background') ?? items[0];
  if (item) return { item };
  const s = sessions.find((x) => status(x) === 'waiting');
  return s ? { session: s.id } : null;
}

/** Failed sessions only: the red pill (stale is no longer in it). */
export const failedIn = (projects: Group[]) =>
  projects.reduce((n, g) => n + [...g.main, ...g.worktrees.flatMap((w) => w.sessions)].filter((s) => status(s) === 'failed').length, 0);

/** V2-8a: one row of the core's worktree list (`worktree list`), with its counts when the folder is there. */
export interface ListedWorktree {
  project: string;
  path: string;
  branch: string;
  label: string;
  missing: boolean;
  facts?: { uncommitted: number; unpushed: number; upstream: boolean };
  /** Ticket 990: the lead teammate whose team this worktree is in; absent for an independent worktree. */
  team?: string;
}
/** A folder `session start --worktree` made has neither label nor branch until renamed: its session's label names it. */
/** `session start --worktree` makes its branch `nunchiro/<folder>` (b3eb3ccf6, w35 F2): a made-up name, so the session's own
 *  label goes before it, as for the detached folders it replaced. */
export const ownBranch = (l: { branch: string; path: string }) => (l.branch === `nunchiro/${basename(l.path)}` ? '' : l.branch);
export const listedName = (l: ListedWorktree, sessions: { cwd: string; label: string }[] = []) => l.label || ownBranch(l) || sessions.find((s) => s.cwd === l.path && s.label)?.label || l.branch || basename(l.path);

/** V2-8a: the tree plus the managed worktrees no session runs in (a project with none of its own gets a group); a
 * listed worktree's row is named by its label or branch. Pure. */
export function withListed(machines: Machine[], listed: ListedWorktree[]): Machine[] {
  if (!listed.length) return machines;
  const out = machines.length ? machines.map((m) => ({ ...m, groups: m.groups.map((g) => ({ ...g, worktrees: [...g.worktrees] })) })) : [{ name: 'this Mac', groups: [] }];
  const local = out[0];
  for (const l of listed) {
    let g = local.groups.find((g) => g.project === l.project);
    if (!g) local.groups.push((g = { project: l.project, name: basename(l.project), urgency: 'idle', counts: { working: 0, waiting: 0, attention: 0 }, main: [], worktrees: [], items: [] }));
    const at = g.worktrees.findIndex((w) => w.path === l.path);
    if (at < 0) g.worktrees.push({ path: l.path, name: l.label || l.branch || basename(l.path), sessions: [] });
    else g.worktrees[at] = { ...g.worktrees[at], name: l.label || ownBranch(l) || g.worktrees[at].name }; // an adopted session folder has neither: the session's label stays
  }
  return out;
}

/** V2-8a: the TREEROWS facts the core list gives (PR state is added from the V2-8b chips). */
export const listedFact = (l: ListedWorktree): WorktreeFact => ({ gone: l.missing, branch: l.branch, newBranch: !!l.facts && !l.facts.upstream && l.facts.unpushed === 0 });
