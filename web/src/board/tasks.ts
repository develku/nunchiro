// V2.5-37 (ticket 185, draft B): what the task board derives from 184's snapshot fields: swimlanes, the stale badge,
// your turn / broken, receipt missing, filters and the coordinator. Pure, so the lane and badge rules test without a page.
import { sessionKids, type Linked } from '../tree/state';
import { status, type Session } from '../types';
import type { Card, Column, Filters, LaneKey } from './model';

/** needs 154: the stale badge shows after this many minutes without a column change; board.toml `[settings]` sets it (186). */
export const STALE_MIN = 10;

export const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
/** A card's `#id`: store ids are UUIDs, so the first seven characters, like a short commit. */
export const shortId = (id: string) => (id.length > 8 ? id.slice(0, 7) : id);

export type LaneKind = 'group' | 'project' | 'fallback' | 'role' | 'none' | 'all';
export interface Lane {
  key: string;
  name: string;
  kind: LaneKind;
  cards: Card[];
}

const PROJECT_LANE = { group: 'fallback', project: 'project' } as const;

function laneOf(card: Card, key: LaneKey): Omit<Lane, 'cards'> {
  if (key === 'none') return { key: 'all', name: '', kind: 'all' };
  if (key === 'group' && card.group) return { key: `g:${card.group}`, name: card.group, kind: 'group' };
  if (key === 'role') {
    const role = card.attachments?.find((a) => a.role)?.role;
    return role ? { key: `r:${role}`, name: role, kind: 'role' } : { key: '-', name: '', kind: 'none' };
  }
  // `group` falls back to the project lane (needs 154); `project` is that lane on purpose.
  if (card.project) return { key: `p:${card.project}`, name: base(card.project), kind: PROJECT_LANE[key] };
  return { key: '-', name: '', kind: 'none' };
}

const RANK: Record<LaneKind, number> = { group: 0, role: 0, project: 1, fallback: 1, all: 1, none: 2 };

/**
 * The lanes for the cards shown: named lanes first, newest name first (numeric-aware, so V2.5-35 before V2.5-34 as
 * in draft B), project fallbacks after them, "no group" last.
 */
export function lanes(cards: Card[], key: LaneKey): Lane[] {
  const out = new Map<string, Lane>();
  for (const card of cards) {
    const lane = laneOf(card, key);
    const have = out.get(lane.key) ?? out.set(lane.key, { ...lane, cards: [] }).get(lane.key)!;
    have.cards.push(card);
  }
  return [...out.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.name.localeCompare(a.name, undefined, { numeric: true }));
}

/** Columns a card counts as done in: the ones that take the done state or need proof. */
export const isDone = (c: Column) => c.states.includes('done') || !!c.proof;

/** Minutes since the card last changed column, when that is past the threshold; null otherwise or where it cannot go stale. */
export function staleMinutes(card: Card, column: Column | undefined, now: number, threshold = STALE_MIN): number | null {
  if (card.source === 'integration' || !column || !column.states.length || isDone(column)) return null;
  const at = card.last_moved_at ?? card.updated_at;
  const min = Math.floor((now - at) / 60_000);
  return at > 0 && min >= threshold ? min : null;
}

export const yourTurn = (card: Card, session?: Session) =>
  (session ? status(session) === 'waiting' : card.state === 'needs_decision') || !!card.attachments?.some((a) => a.state === 'needs_decision');

/** A result that starts with a failure word, or counts a non-zero failure ("ok. 12 passed; 0 failed" is a pass). */
const failed = (result: string) => /^\s*(fail|failed|failure|error)\b/i.test(result) || /\b[1-9]\d*\s+(failed|failures?|errors?)\b/i.test(result);
export const broken = (card: Card, session?: Session) => (session ? status(session) === 'failed' : false) || (!!card.receipt && failed(card.receipt.result));

const TODO_DOT = 'todo'; // a data token: the To do column claims no state

/** The task card's dot (draft B): red broken, orange your turn, else its column's state colour (To do: grey). */
export function taskDot(card: Card, session: Session | undefined, column: Column | undefined) {
  if (broken(card, session)) return 'bad';
  if (yourTurn(card, session)) return 'you';
  return column?.states[0] ?? TODO_DOT;
}

/**
 * The proof column an agent's move was refused into for want of a receipt, when that is the card's last change. Only a
 * refusal whose reason names the receipt counts: a rights refusal ("not your card") into Done is not this (ticket 183).
 */
export function receiptMissing(card: Card, columns: Column[]): Column | null {
  const last = card.history?.at(-1);
  if (!last || last.kind !== 'refused' || last.actor === 'owner' || card.receipt || !/receipt/i.test(last.reason ?? '')) return null;
  return columns.find((c) => c.id === last.to && c.proof) ?? null;
}

/** The card sits in a proof column and the owner put it there: no receipt is asked of the owner (draft B #19). */
export function ownerMoved(card: Card, column: Column | undefined) {
  if (!column?.proof || card.receipt) return false;
  const move = card.history?.findLast((h) => h.kind === 'move' || h.kind === 'create');
  return move?.actor === 'owner' && move.to === column.id;
}

export function passes(card: Card, f: Filters, column: Column | undefined, columns: Column[], session: Session | undefined, now: number, threshold = STALE_MIN) {
  if (f.you && !yourTurn(card, session)) return false;
  if (f.role.length && !card.attachments?.some((a) => f.role.includes(a.role))) return false;
  const idle = staleMinutes(card, column, now, threshold) !== null;
  if (f.stale && !idle) return false;
  if (f.hideIdle && idle) return false;
  if (f.missing && !receiptMissing(card, columns)) return false;
  return true;
}

/** C7b: the board search. Case-insensitive substring over the title, note, ref, group and the project's folder name. */
export function matchesQuery(card: Card, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [card.title, card.note, card.ref, card.group, card.project && base(card.project)].some((f) => !!f && f.toLowerCase().includes(q));
}

/** needs 154: the coordinator is the session with child sessions (the most, in the filtered project). */
export function coordinator(sessions: Session[], project: string | null): { session: Session; children: number } | null {
  const kids = sessionKids(sessions as Linked[]);
  let best: { session: Session; children: number } | null = null;
  for (const s of sessions) {
    const n = kids.get(s.id)?.length ?? 0;
    if (n && (project === null || s.project === project) && (!best || n > best.children)) best = { session: s, children: n };
  }
  return best;
}

/** How much of one line the markdown patterns below look at; the rest of a longer line stays as it is (plain text,
 *  nothing dropped). An agent writes the note, so its length must never set how long the patterns run: per line they
 *  are bounded, so the whole note is linear (security looks on c1c4f8719 and 47f32f5b8). */
const LINE_MARKS_MAX = 200;
const unmarkLine = (line: string) =>
  line
    .replace(/!?\[([^[\]\n]{0,200})\]\([^()\s]{0,500}\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|[.,;:!?)]|$)/g, '$1$2');

/** Light markdown marks taken off (bold, italics, code, a heading's #, a link's target), line by line, the words kept:
 *  the Board and History show plain text. The whole note comes back (a card's tooltip and the detail show all of it). */
export const unmark = (text: string) =>
  text
    .replace(/^#{1,6}\s+/gm, '')
    .split('\n')
    .map((l) => (l.length > LINE_MARKS_MAX ? unmarkLine(l.slice(0, LINE_MARKS_MAX)) + l.slice(LINE_MARKS_MAX) : unmarkLine(l)))
    .join('\n');
