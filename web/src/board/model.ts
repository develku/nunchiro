// Board (spec-v1b B4): the core's `board_snapshot` shape, and the card order inside each column. The core keeps
// which column a card is in; the order inside a column is this window's (localStorage), like the tree's order.
import { dropNeighborsForIndex } from './drop';
import type { Key, T } from '../i18n';

export type State = 'working' | 'needs_decision' | 'review' | 'done';
export const STATES: State[] = ['working', 'needs_decision', 'review', 'done'];
export const STATE_WORD: Record<State, string> = { working: 'working', needs_decision: 'needs decision', review: 'review', done: 'done' };

export interface Column {
  id: string;
  title: string;
  states: State[];
  needs_decision: boolean;
  /** V2.5-36: moving a card here needs a Receipt (ticket 183 enforces it). */
  proof?: boolean;
}
// Ticket 871: the core's default titles (board/mod.rs `defaults`). The store keeps them in English; the window shows its
// own word while a column still holds its default title, and the stored title once the person renamed it.
const DEFAULT_TITLE: Record<string, [string, Key]> = {
  todo: ['To do', 'board.default.todo'],
  working: ['Working', 'board.default.working'],
  'needs-decision': ['Needs decision', 'board.default.needsDecision'],
  review: ['Review', 'board.default.review'],
  done: ['Done', 'board.default.done'],
};
/** A column's title as the window shows it. */
export const columnTitle = (t: T, c: Pick<Column, 'id' | 'title'>) => (DEFAULT_TITLE[c.id]?.[0] === c.title ? t(DEFAULT_TITLE[c.id]![1]) : c.title);
/** V2.5-36 task fields (crates/nunchiro-core/src/board/mod.rs, wire shape). Integration cards may lack them. */
export interface Receipt {
  sha: string;
  command: string;
  result: string;
}
export interface Attachment {
  session_id: string;
  role: string;
  label: string | null;
  state: State | null;
}
export interface Change {
  at: number;
  actor: string;
  kind: 'create' | 'move' | 'edit' | 'undo' | 'refused';
  from: string | null;
  to: string;
  reason: string | null;
}
export interface Card {
  id: string;
  /** `integration` cards come from ticket 17's sources; this widget shows them but does not move them. */
  source: 'session' | 'manual' | 'integration';
  title: string;
  note: string;
  /** The core's words for the card (w11-core): its note, else its own task's outcome, else its title. */
  text?: string;
  session_id: string | null;
  project: string | null;
  column: string;
  state: State | null;
  stale: boolean;
  updated_at: number;
  source_name?: string;
  group?: string;
  ref?: string;
  receipt?: Receipt | null;
  waits_on?: string[];
  attachments?: Attachment[];
  last_moved_at?: number;
  history?: Change[];
  can_undo?: boolean;
  /** The lead's ledger task this card is for (a manual card whose attached seats are that task's), else absent or null. */
  task?: string | null;
  /** An integration card's link (the core accepts http(s) with a host only). */
  url?: string | null;
}
export interface Snapshot {
  columns: Column[];
  cards: Card[];
  error: string | null;
  /** Opaque board.toml stamp; `board_columns_put` is refused unless it still matches. */
  revision: string;
  /** V2.5-38: board.toml `[settings]` (an older core sends none: the defaults apply). */
  settings?: BoardSettings;
}
/** V2.5-38 (ticket 186): board.toml `[settings]`, read by the core (board/config.rs). */
export interface BoardSettings {
  stale_minutes: number;
  turn_end_nudge: boolean;
}
export const SETTINGS: BoardSettings = { stale_minutes: 10, turn_end_nudge: true };

/** A whole number of minutes from 1 to 1440 (board.toml's rule, board/config.rs), else null. */
export function minutes(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 1440 ? n : null;
}

export const keyOf = (c: Card) => `${c.source}:${c.source_name ?? ''}:${c.id}`;
export const movable = (c: Card) => c.source !== 'integration';
/** needs 171: the http(s) link an integration card opens; any other scheme is no link (a second check after the core's). */
export const link = (c: Card) => (c.source === 'integration' && c.url && /^https?:\/\/[^/]/i.test(c.url) && hostOf(c.url) ? c.url : null);
/** The host a link goes to, shown before the click; none for a URL that does not parse. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};
/** needs 172: what a click on the card does: edit it, open its session, open its link, or nothing (then it is no button). */
export const actionable = (c: Card) => c.source === 'manual' || !!c.session_id || !!link(c);

/** V2.5-37: what the swimlanes follow (draft B header strip). */
export type LaneKey = 'group' | 'project' | 'role' | 'none';
export const LANE_KEYS: LaneKey[] = ['group', 'project', 'role', 'none'];
/** V2.5-37 filter chips: each one narrows the cards shown; `role` lists the roles shown (empty: all). */
export interface Filters {
  you: boolean;
  role: string[];
  stale: boolean;
  missing: boolean;
  /** B14: hides the cards that carry the stale badge (`staleMinutes`), whatever the stale chip says. */
  hideIdle: boolean;
}
export const NO_FILTERS: Filters = { you: false, role: [], stale: false, missing: false, hideIdle: false };

/**
 * Window-side board settings: the project filter and the card order (needs 3: one board for all projects). The lane
 * key and filters are each widget's saved view (views.ts, V2.5-38).
 */
export interface Prefs {
  project: string | null;
  order: string[];
}
const PREFS = 'nunchiro.board.v1';
export function loadPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
    const order = Array.isArray(v.order) && v.order.every((k: unknown) => typeof k === 'string') ? v.order : [];
    return { project: typeof v.project === 'string' ? v.project : null, order };
  } catch {
    return { project: null, order: [] };
  }
}
export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    // Storage blocked: the filter and order last for this window only.
  }
}

/**
 * The order with cards seen for the first time appended (the core lists sessions in no fixed order), and cards
 * that are gone pruned. Returns the same array when nothing changed.
 */
export function remember(order: string[], snap: Snapshot): string[] {
  const now = new Set(snap.cards.map(keyOf));
  const kept = order.filter((k) => now.has(k));
  const known = new Set(kept);
  const added = snap.cards
    .filter((c) => !known.has(keyOf(c)))
    .sort((a, b) => a.updated_at - b.updated_at || (keyOf(a) < keyOf(b) ? -1 : 1))
    .map(keyOf);
  return added.length || kept.length !== order.length ? [...kept, ...added] : order;
}

/** Cards per column, filtered by project, in the window's order; cards the order does not know yet go last. */
export function arrange(snap: Snapshot, order: string[], project: string | null): Map<string, Card[]> {
  const rank = new Map(order.map((k, i) => [k, i]));
  const out = new Map(snap.columns.map((c) => [c.id, [] as Card[]]));
  const first = snap.columns[0]?.id;
  for (const card of snap.cards) {
    if (project !== null && card.project !== project) continue;
    (out.get(card.column) ?? out.get(first))?.push(card);
  }
  for (const list of out.values()) list.sort((a, b) => (rank.get(keyOf(a)) ?? Infinity) - (rank.get(keyOf(b)) ?? Infinity));
  return out;
}

/**
 * The order after dropping `key` at `index` among the cards shown in `column`. The shown order of every card is
 * written out first, so the result does not depend on cards the filter hides; unknown keys are pruned.
 */
export function placeCard(snap: Snapshot, order: string[], project: string | null, key: string, column: string, index: number): string[] {
  const all = arrange(snap, order, null);
  const shown = (arrange(snap, order, project).get(column) ?? []).map(keyOf);
  const { beforeTaskId, afterTaskId } = dropNeighborsForIndex(shown, key, index);
  const next = [...all.values()].flat().map(keyOf).filter((k) => k !== key);
  let at: number;
  if (beforeTaskId !== null) at = next.indexOf(beforeTaskId) + 1;
  else if (afterTaskId !== null) at = next.indexOf(afterTaskId);
  else {
    // An empty column (as shown): after the last card the column holds, else at the end.
    const held = (all.get(column) ?? []).map(keyOf).filter((k) => k !== key);
    at = held.length ? next.indexOf(held[held.length - 1]) + 1 : next.length;
  }
  next.splice(at, 0, key);
  return next;
}

/** Moving a card into the snapshot locally, before the core's reply arrives. */
export function withColumn(snap: Snapshot, key: string, column: string): Snapshot {
  return { ...snap, cards: snap.cards.map((c) => (keyOf(c) === key ? { ...c, column } : c)) };
}

/** A column id for a new column: titles may be Hangul, ids are ASCII (letters, digits, `-`). */
export function freshColumnId(columns: Column[]): string {
  const taken = new Set(columns.map((c) => c.id));
  let i = columns.length + 1;
  while (taken.has(`column-${i}`)) i++;
  return `column-${i}`;
}
