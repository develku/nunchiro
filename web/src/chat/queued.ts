// Ticket 371 item 15: messages sent while the agent works wait here, one list per session, until the turn ends.
// localStorage is the only copy, so a reload keeps the list and a second window sees the same rows. Every change re-reads
// it first, and a row leaves storage before it is sent, so only one window can send it. Shape after held.ts (store and
// subscribe); the pause rule (a paused list makes no promise and does not drain) is Orca's; no peer code is copied.
import { useSyncExternalStore } from 'react';
import { agentState, type Session } from '../types';
import { asks } from './held';

const KEY = 'nunchiro.composer.queue.v1';
/** A release that starts no turn (a slash command, say) must not stall the list: an idle session frees it after this. */
const GATE_MS = 15_000;
/** A window that died during a send-now must not hold its row for good. */
const BUSY_MS = 30_000;

export type Row = { id: string; text: string };
/** A row just went in, so the next waits for that turn to finish: `seq` is the session's completion count at the send. */
type Gate = { seq: number; at: number };
export type Queue = { rows: Row[]; paused?: boolean; gate?: Gate; busy?: { row: string; at: number } };
type Store = Record<string, Queue>;

function parse(raw: string | null): Store {
  const out: Store = {};
  try {
    const all = JSON.parse(raw ?? '{}') as Record<string, Queue>;
    for (const [id, q] of Object.entries(all)) {
      const rows = Array.isArray(q?.rows) ? q.rows.filter((r) => typeof r?.id === 'string' && typeof r?.text === 'string' && r.text) : [];
      if (rows.length) out[id] = { ...q, rows };
    }
  } catch {
    /* not JSON: start empty */
  }
  return out;
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
// A spec that imports the app's modules in Node has no window: nothing to listen to there.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) emit();
  });

let seenRaw: string | null = null;
let seen: Store = {};
/** Always storage's current value; the same object while it has not changed, as useSyncExternalStore needs. */
function read(): Store {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return seen;
  }
  if (raw !== seenRaw) {
    seenRaw = raw;
    seen = parse(raw);
  }
  return seen;
}

/** Applies `fn` to the current list. False when storage refused, and then nothing changed. */
function change(id: string, fn: (q: Queue) => Queue): boolean {
  const all = { ...read() };
  const next = fn(all[id] ?? { rows: [] });
  if (next.rows.length) all[id] = next;
  else delete all[id]; // with its last row a list also loses its pause
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  emit();
  return true;
}

const without = (q: Queue, rowId: string) => q.rows.filter((r) => r.id !== rowId);
const seqOf = (s: Session) => (s as Session & { completion_seq?: number }).completion_seq ?? 0;
export const busyRow = (q: Queue | undefined, rowId: string) => q?.busy?.row === rowId && Date.now() - q.busy.at < BUSY_MS;

export const queueOf = (id: string): Queue | undefined => read()[id];
export const queueIds = () => Object.keys(read());
export const useQueue = (id: string | undefined) => useSyncExternalStore(subscribe, () => (id ? read()[id] : undefined));
export const useQueues = () => useSyncExternalStore(subscribe, read);

// Stop with no rows has no list to pause, so the session's completion count at the Stop is kept on its own, one number per
// session. Bounded like the drafts: the oldest goes first, so closed sessions' records cannot pile up.
const STOPS_KEY = 'nunchiro.composer.queue.stops.v1';
const MAX_STOPS = 50;
function readStops(): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(STOPS_KEY) ?? '{}') as unknown;
    return all && typeof all === 'object' && !Array.isArray(all) ? Object.fromEntries(Object.entries(all).filter(([, n]) => typeof n === 'number')) : {};
  } catch {
    return {};
  }
}
function writeStops(all: Record<string, number>) {
  try {
    localStorage.setItem(STOPS_KEY, JSON.stringify(all));
  } catch {
    /* the worst case is a row in the stop gap going in by itself; the Stop must not fail over it */
  }
}
/** Holds the list, and whatever joins it before the stopped turn ends. Returns the undo for an Esc that did not go out. */
export function recordStop(s: Session): () => void {
  const paused = !!read()[s.id]?.paused;
  const before = readStops();
  const { [s.id]: _, ...rest } = before; // re-added last, so the newest stays when the map is trimmed
  writeStops(Object.fromEntries(Object.entries({ ...rest, [s.id]: seqOf(s) }).slice(-MAX_STOPS)));
  setPaused(s.id, true);
  return () => {
    writeStops(before);
    setPaused(s.id, paused);
  };
}
/** The turn that was stopped has not finished yet: a finished turn raises the count past the record. */
const inStoppedTurn = (s: Session) => {
  const at = readStops()[s.id];
  return at !== undefined && seqOf(s) <= at;
};

export const enqueue = (s: Session, text: string) => change(s.id, (q) => ({ ...q, ...(inStoppedTurn(s) ? { paused: true } : {}), rows: [...q.rows, { id: crypto.randomUUID(), text }] }));

/** Removes one row and returns it; undefined when another window already took it or storage refused. With `sentAt`, it is going in. */
export function takeRow(id: string, rowId: string, sentAt?: Session): Row | undefined {
  const row = read()[id]?.rows.find((r) => r.id === rowId);
  if (!row) return undefined;
  const done = change(id, (q) => ({ ...q, rows: without(q, rowId), ...(sentAt ? { gate: { seq: seqOf(sentAt), at: Date.now() } } : {}) }));
  return done ? row : undefined;
}

/** Empties a list, returning its text in order, or '' when storage refused (the rows then stay for the next look). */
export function takeAll(id: string): string {
  const text = (read()[id]?.rows ?? []).map((r) => r.text).join('\n');
  return change(id, () => ({ rows: [] })) ? text : '';
}

/** A release the core refused goes back on top, paused: a refusal that repeats must not be retried on every snapshot. */
export const putBack = (id: string, row: Row) => change(id, (q) => ({ rows: [row, ...q.rows], paused: true }));

export const setPaused = (id: string, paused: boolean) => {
  if (read()[id]) change(id, (q) => ({ ...q, paused }));
};

/** Marks a row as being sent now, or says no if it is gone or already on its way. */
export function claimSteer(id: string, rowId: string): Row | undefined {
  const q = read()[id];
  const row = q?.rows.find((r) => r.id === rowId);
  if (!row || busyRow(q, rowId)) return undefined;
  return change(id, (cur) => ({ ...cur, busy: { row: rowId, at: Date.now() } })) ? row : undefined;
}
export const unclaimSteer = (id: string) => void (read()[id] && change(id, ({ busy: _, ...q }) => q));
/** The core accepted a send-now: the row goes, and the next waits for the turn it started. */
export const finishSteer = (id: string, rowId: string, s: Session) =>
  void change(id, ({ busy: _, ...q }) => ({ ...q, rows: without(q, rowId), gate: { seq: seqOf(s), at: Date.now() } }));

/** A row may be typed now: never into a question, where the text would be taken as the answer. */
const ready = (s: Session) => agentState(s) === 'running' && !s.attention.working && !asks(s);

/** The release decision for one session: the next row, already out of storage, or how long until it is worth asking again. */
export function nextRow(s: Session): { row?: Row; retryIn?: number } {
  let q = read()[s.id];
  if (!q) return {};
  if (q.gate) {
    const left = q.gate.at + GATE_MS - Date.now();
    // Not lifted by merely seeing "working": another window's snapshot can be older than the gate and still say so.
    const lifted = seqOf(s) > q.gate.seq || (!s.attention.working && left <= 0);
    if (!lifted) return s.attention.working ? {} : { retryIn: Math.max(left, 50) };
    change(s.id, ({ gate: _, ...rest }) => rest);
    q = read()[s.id];
    if (!q) return {};
  }
  if (q.paused || !ready(s)) return {};
  if (q.busy && busyRow(q, q.busy.row)) return { retryIn: q.busy.at + BUSY_MS - Date.now() };
  const top = q.rows[0];
  return { row: takeRow(s.id, top.id, s) };
}

// Q7 point 16: texts that went in as a steer, so their bubble says so. Per session, the newest few, in this window's storage.
// shortcut: matched by text, so the same text sent again normally in that session is marked too; store the transcript key if that bites.
const STEERS_KEY = 'nunchiro.composer.steers.v1';
const MAX_STEERS = 20;
function readSteers(): Record<string, string[]> {
  try {
    const all = JSON.parse(localStorage.getItem(STEERS_KEY) ?? '{}') as unknown;
    return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}
export function noteSteer(id: string, text: string) {
  const { [id]: mine = [], ...rest } = readSteers();
  try {
    localStorage.setItem(STEERS_KEY, JSON.stringify(Object.fromEntries(Object.entries({ ...rest, [id]: [...mine, text.trim()].slice(-MAX_STEERS) }).slice(-MAX_STOPS))));
  } catch {
    return; // the label is a nicety; the steer itself went in
  }
  emit();
}
export const useSteered = (id: string, text: string) => useSyncExternalStore(subscribe, () => Array.isArray(readSteers()[id]) && readSteers()[id].includes(text.trim()));
