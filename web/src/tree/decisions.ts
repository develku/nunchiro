// V2-8e (HIDEROWS, needs 95): what a decision row, its peek and the panel card may send. Pure, so the rules are
// testable without a DOM. The core decides risk (`risky`, absent = risky); the window only hides allow for it.
import { plan, screenCommand, summary, type Act } from '../queue/answer';
import { mcpLine, mcpTool } from '../decisions/readable';
import type { T } from '../i18n';
import { checking, type Decision, type OpenLoop, type Session } from '../types';

/** The snapshot fields V2-8e adds to an item (crates/nunchiro-core/src/queue/mod.rs `Decision`). */
export type Item = Decision & { risky?: boolean; deny_note?: boolean; allow_always?: string; allow_scope?: string; tool?: string };

/** A permission is risky unless the core said `risky: false` (fail-closed: an absent field is risky). */
export const isRisky = (d: Item) => d.kind === 'permission' && d.risky !== false;

export interface RowPlan {
  /** Allow once: never on a risky item, and never in a row or peek for several pending. */
  allow?: Act;
  deny?: Act;
  /** A question's choices (the row's "choose" menu); allow and deny are not shown for it. */
  choose: Act[];
  /** Nothing can be sent from here: only details (and the reason, when there is one). */
  note?: string;
}

/** What a row (and its peek) offers for the line's items: several items, or none answerable, give details only. */
export function rowPlan(items: Item[], session: Session | undefined, t: Parameters<typeof plan>[2]): RowPlan {
  if (items.length !== 1) return { choose: [] };
  const d = items[0];
  const p = plan(d, session, t);
  if (p.note || !p.acts.length) return { choose: [], note: p.note };
  // A question's Cancel is its deny (the card shows it; the row offers "choose" and details only, as in the mockup).
  if (d.kind === 'question') return { choose: p.acts.filter((a) => a.answer.type === 'choose'), deny: p.acts.find((a) => a.answer.type === 'deny') };
  return {
    allow: p.acts.find((a) => a.answer.type === 'allow_once'), // plan() gives none on a risky item
    deny: p.acts.find((a) => a.answer.type === 'deny'),
    choose: [],
  };
}

/** One line under a session row (or under the project header for a project-level item): that session's items. */
export interface Line {
  key: string;
  session: string;
  items: Item[];
  /** Every item of the line shown at freeze is answered: the line stays, dimmed, until the tree is released. */
  answered: boolean;
  /** Frozen, its items are gone but the session asks again (a redraw re-filed the prompt): it updates on release. */
  changed?: boolean;
}

// N25 (look 1117 v5): a lead's merges are each the user's own decision (one card each), so each has its own line.
const keyOf = (d: Decision) => (d.owner?.type === 'merge' ? `item:${d.id}` : d.session_id || `item:${d.id}`);
/** An owner item answered on its own card in Decisions (a lead's merge, role, goal or schedule, the Home lead's Outbox
 *  card, a stalled task, a memory past its brief's limit): the widget's icon gets a dot. Tickets 1002 ('outward'), 1004 ('stall')
 *  and 1005 ('tidy'); ticket 1003: an open loop's card ('loop'). */
export const hasCard = (d: Decision) => ['merge', 'role', 'goal', 'schedule', 'outward', 'stall', 'tidy', 'loop'].includes(d.owner?.type ?? '');
/** N25 (look 1117 v3, v4f): a board card whose task waits on a merge names that merge, as its card does; a merge with no
 *  board card still gets a line in its project's rows (answered on its card only: its plan has no row buttons). The line
 *  keeps the card's asker, not the board card's empty one, so it sits under the lead's row and names it (look v15 B). */
export function withMerges(board: Decision[], owner: Decision[], t: T): Decision[] {
  const mergeOf = (d: Decision) => owner.find((o) => o.owner?.type === 'merge' && [d.board?.title, d.board?.question].includes(o.owner.title));
  const named = (d: Decision, m: Decision) => (m.owner?.type === 'merge' ? { ...d, owner: m.owner, session_id: m.session_id, text: t('notes.merge.title', { title: m.owner.title }) } : d);
  return [
    ...board.map((d) => ((m) => (m ? named(d, m) : d))(mergeOf(d))),
    ...owner.flatMap((o) => (o.owner?.type === 'merge' && !board.some((d) => mergeOf(d) === o) ? [{ ...named(o, o), scope: o.owner.place }] : [])),
  ];
}
/** Ticket 1030: an item of the session in front that Decisions keeps listing (it is answered above that session's composer
 *  too): anything but an ordinary permission request; a risky one stays in both places. */
export const alsoInDecisions = (d: Item) => d.kind !== 'permission' || isRisky(d);
/** Ticket 1030: what Decisions lists: the session in front (`front`) drops its ordinary permission requests. The Team
 *  view, its icon, tab and chip count the same list (`teamWaiting`), so the two never show two numbers (inventory N012). */
export const withoutFront = (sessions: Session[], front: string | null) =>
  // The session still waits (its card is above its composer): `waiting` keeps types.ts `status` as it was for the Team view's seats.
  front ? sessions.map((s) => (s.id === front ? { ...s, pending: s.pending.filter(alsoInDecisions), attention: { ...s.attention, waiting: s.attention.waiting || asks(s.pending).length > 0 } } : s)) : sessions;
/** Items that wait for the user: stale flags and background notes are row states, not decisions. */
export const asks = <D extends Decision>(items: D[]) => items.filter((d) => d.kind !== 'stale' && d.kind !== 'background');
/** What the Decisions pane counts as waiting ("2 waiting"): every session's asks, and the owner items it draws as cards.
 *  The Home lead's chip says the same number (seventh look, Home S2: two counts read as one being wrong). */
export const waitingCount = (sessions: Session[], owner: Decision[]) => waitingItems(sessions, owner).length;
/** The items `waitingCount` counts, oldest first: a session's ask (with its session) or an owner card. The Home Team view's
 *  "Needs you · N" lists exactly these under its number (look 1117 v11 Home S2-1). */
export type Waiting = { d: Decision; s?: Session };
export const waitingItems = (sessions: Session[], owner: Decision[]): Waiting[] =>
  [...sessions.flatMap((s) => asks(s.pending).map((d) => ({ d, s }))), ...owner.filter((d) => hasCard(d) || d.owner?.type === 'codex_reset').map((d) => ({ d }))].sort((a, b) => a.d.observed_at - b.d.observed_at);
/** The folder an owner card was filed in (a lead's merge, role, goal or schedule), as a session's `project` names it. */
export const placeOfCard = (d: Decision) => (d.owner as { place?: string } | undefined)?.place;
/** `waitingCount` for a lead's Team view (q67 look, new 2): its bar icon, its tab, the header chip and its "Needs you" heading
 *  say this one number. A project's view is about that place (`folder`): the asks of the sessions there and the cards
 *  filed there. The Home lead's (`home`) is about every place, so it says Decisions' own number. */
export const teamWaiting = (sessions: Session[], owner: Decision[], folder: string | null, home: boolean) =>
  folder === null ? 0 : home ? waitingCount(sessions, owner) : waitingCount(sessions.filter((s) => s.project === folder), owner.filter((d) => placeOfCard(d) === folder));

/**
 * Lines in arrival order (oldest item first). Frozen (pointer or focus in the tree, needs 49), the lines are the ones
 * shown at freeze: their items follow the live ones, a line whose items are all answered stays as answered, and an
 * item of a session with no line at freeze waits as `fresh` (the badge still counts it at once).
 */
export function decisionLines(live: Decision[], frozen: Decision[] | null): { lines: Line[]; fresh: number } {
  const group = (items: Decision[]) => {
    const out = new Map<string, Item[]>();
    // Stale flags and background notes ride on lines too (details only): a main-folder session has no row of its own.
    for (const d of [...items].sort((a, b) => a.observed_at - b.observed_at)) out.set(keyOf(d), [...(out.get(keyOf(d)) ?? []), d]);
    return out;
  };
  const now = group(live);
  if (!frozen) return { lines: [...now].map(([key, items]) => ({ key, session: items[0].session_id, items, answered: false })), fresh: 0 };
  const was = group(frozen);
  // A frozen line keeps the item ids it showed (a new item of that session never takes the place of the one under the
  // pointer or focus, so a key pressed for one never answers another); new ids wait as `fresh`.
  const liveById = new Map(live.map((d) => [d.id, d]));
  const shownIds = new Set(frozen.map((d) => d.id));
  const lines = [...was].map(([key, old]) => {
    const items = old.flatMap((d) => (liveById.has(d.id) ? [liveById.get(d.id)!] : []));
    return items.length ? { key, session: old[0].session_id, items, answered: false } : { key, session: old[0].session_id, items: old, answered: true, changed: now.has(key) };
  });
  const fresh = [...now.values()].flat().filter((d) => !shownIds.has(d.id)).length;
  return { lines, fresh };
}

/** Ticket 1004: what a stall card says: the task, then the seat's last error or that nothing changed. */
export const stallLine = (o: { title: string; seat: string; error?: string }, t: T) => `${t('stall.title', { title: o.title })} · ${o.error ? t('stall.error', { seat: o.seat, error: o.error }) : t('stall.quiet', { seat: o.seat })}`;

/** Ticket 1003: an open loop in the window's words ("Waiting for Mina Park: the signed contract"), and its card's one
 *  line ("Overdue · Waiting for …"), which is the card's name and its "Needs you" row. */
export const loopWords = (row: OpenLoop, t: T) => t(`loops.words.${row.kind}`, { who: row.who, what: row.what });
export const loopLine = (o: { change: 'add' | 'close' | 'overdue'; row: OpenLoop }, t: T) => t('loops.line', { title: t(`loops.title.${o.change}`), words: loopWords(o.row, t) });

/** The one-line "what" of an item, and a short "why" (the tool's own description, else what kind of ask it is). A flag
 * (stale, a background task) says its kind; an item restored after a restart says it is being checked. */
export function whatWhy(d: Item, t: T): { what: string; why: string } {
  // A screen permission's summary is "<tool header> · <command>": the line shows the command (the tool is the row's icon).
  const sum = summary(d);
  // Ticket 1004: a stalled task's line in the window's language (the core's `text` is English).
  const stall = d.owner?.type === 'stall' ? stallLine(d.owner, t) : d.owner?.type === 'loop' ? loopLine(d.owner, t) : null; // ticket 1003: an open loop's too
  const text = stall ?? (d.board || d.owner ? d.text : d.kind === 'permission' && !d.text.trimStart().startsWith('{') ? (sum.split(' · ').pop() ?? sum) : sum);
  const what = d.kind === 'stale' || d.kind === 'background' ? t(d.kind === 'stale' ? 'walk8.kind.stale' : 'walk8.kind.background') : checking(d) ? t('walk8.why.checking', { text }) : text;
  let why = '';
  // Look v31 a S2-1: the core marks an MCP tool safe only when it reads (a locked Home seat's mail or calendar read), so
  // its why says that. An MCP tool's `description` is its own input, never the reason for the ask.
  const mcp = mcpTool(d);
  try {
    const v = JSON.parse(d.text);
    if (!mcp && v && typeof v.description === 'string') why = v.description;
  } catch {
    // Screen text.
  }
  if (mcp && d.kind === 'permission' && !isRisky(d)) why = t('walk8.why.read', { server: mcp.server });
  if (!why) why = t(d.kind === 'question' ? 'walk8.why.question' : isRisky(d) ? 'walk8.why.risky' : 'walk8.why.permission');
  return { what, why };
}

/** B20 (ticket 991): what a permission asks to do, as a short title ("Edit app.py", "Run python -m pytest"), from the hook's
 *  tool input or the prompt's own sentence on screen; null when neither says it. */
export function askTitle(d: Item, t: T): string | null {
  const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
  const line = (c: string) => c.trim().split('\n')[0].trim();
  const mcp = mcpLine(d); // look v31 a S2-1: "Gmail · search threads · in:inbox", never "Run …" from an MCP tool's field
  if (mcp) return mcp;
  try {
    const v = JSON.parse(d.text);
    if (v && typeof v.command === 'string' && v.command.trim()) return t('walk8.line.run', { command: line(v.command) });
    if (v && typeof v.file_path === 'string') return t(typeof v.content === 'string' ? 'walk8.line.write' : 'walk8.line.edit', { file: base(v.file_path) });
    return null;
  } catch {
    // Screen text.
  }
  const edit = /make this edit to\s+(\S+?)\?/.exec(d.text);
  if (edit) return t('walk8.line.edit', { file: base(edit[1]) });
  const write = /(?:create|overwrite|write to)\s+(\S+?)\?/.exec(d.text);
  if (write) return t('walk8.line.write', { file: base(write[1]) });
  const cx = screenCommand(d.text); // Codex's "$ <command>" (look 1117 v9 B N-S3-8)
  if (cx) return t('walk8.line.run', { command: cx });
  const bash = /Bash command\s*\n\s*\n?\s*(\S[^\n]*)/.exec(d.text);
  return bash ? t('walk8.line.run', { command: bash[1].trim() }) : null;
}

/** B20: the tree's line under a session that asks names the ask ("Edit app.py"), never a cut of the terminal screen; the
 *  row's hand icon already says it needs approval. A dialog (a trust prompt) is answered in the terminal. */
export function stateLine(d: Item, t: T): string {
  const { what } = whatWhy(d, t);
  if (checking(d) || d.board || d.owner) return what;
  if (d.kind === 'permission') return askTitle(d, t) ?? what; // B20: a hook's (JSON) permission too, never a cut of its path
  if (d.kind === 'dialog') return t('walk8.line.dialog');
  return what;
}

/** One option of the prompt on screen (ticket 294 item 3, needs 213). `act` is what a click sends; an option the core never
 * types from the window (a dialog's choice, one that changes the agent's settings, one past the ninth) has none and is
 * listed disabled: shown, never guessed or mapped to a key. */
export interface Opt {
  /** The number the prompt shows. */
  n: string;
  label: string;
  act?: Act;
}

/** The prompt's number for choice `i`: its first key when that is a digit (what the core types), else its place. */
const numberOf = (d: Item, i: number) => (/^\d+$/.test(d.choices[i].keys[0] ?? '') ? d.choices[i].keys[0] : String(i + 1));

/**
 * Every option of the prompt, in its order. A question: all its choices, the sendable ones with their `choose` act. A
 * dialog (a folder-trust prompt): all of them, none sendable (the core answers a dialog with Esc only,
 * needs 44). A permission: the options the card's own Allow, Deny and "don't ask again" buttons do not stand for (they
 * keep their rules: a risky allow is focus + Enter only, needs 128). Nothing when `p` says nothing can be sent here.
 */
export function optionRows(d: Item, p: RowPlan): Opt[] {
  if (p.note || d.kind === 'owner' || d.kind === 'board') return [];
  if (d.kind === 'question')
    return d.choices.map((c, i) => ({ n: numberOf(d, i), label: c.label, act: p.choose.find((a) => a.answer.type === 'choose' && a.answer.index === i) }));
  if (d.kind === 'dialog') return d.choices.map((c, i) => ({ n: numberOf(d, i), label: c.label }));
  if (d.kind !== 'permission') return [];
  // Same reading as the core's `Choice::allows_once` and the card's buttons: Yes (allow), No (deny), the session-only "don't ask again".
  const covered = (c: Item['choices'][number]) => {
    const low = c.label.toLowerCase();
    return (!c.changes_settings && low.startsWith('yes')) || low.startsWith('no') || c.label === d.allow_always;
  };
  return d.choices.flatMap((c, i) => (covered(c) ? [] : [{ n: numberOf(d, i), label: c.label }]));
}

/** Look 1117 v11 S3-7: in a project lead's tab the Decisions pane is about its place, as its chip and Team view
 *  (teamWaiting): its sessions and the owner cards of that place only; elsewhere (`place` undefined) everything. */
export function scopeToPlace(place: string | null | undefined, sessions: Session[], owner: Decision[]) {
  return place ? { sessions: sessions.filter((s) => s.project === place), owner: owner.filter((d) => placeOfCard(d) === place) } : { sessions, owner };
}
