// SPLITS (PEEKSPLIT amend, SPLITKEYS): split panes beside a session's chat. A split stays until the user closes it, per
// session, across session switches and restarts (this window's storage, keyed by session id); a broken store is ignored,
// never partially trusted, and a closed session's splits are dropped. Splits are never written into the layout preset:
// 📌 hands the widget to the layout (App) and the split goes.
import { useSyncExternalStore } from 'react';
import { isKind, kindOf, type Dir } from '../layout/model';

/** What a split shows: a widget item, the chooser, or a session started for it (`session:<id>`, a shell or an agent chat). */
export type What = string;
export interface Split {
  id: string;
  side: Dir;
  what: What;
  /** Ticket 1069: the session came from the tab strip, so closing the split puts it back there instead of closing it. */
  tab?: true;
}
export const CHOOSER = 'chooser';
export const SIDE_START = 'side-start';
export const sessionOf = (w: What): string | null => (w.startsWith('session:') ? w.slice(8) : null);

const KEY = 'nunchiro.splits.v1';
const SIDES: Dir[] = ['left', 'right', 'up', 'down'];
const ok = (s: unknown): s is Split => {
  const x = s as Record<string, unknown> | null;
  return !!x && typeof x.id === 'string' && x.id.length > 0 && SIDES.includes(x.side as Dir) && typeof x.what === 'string' && (x.what === CHOOSER || x.what === SIDE_START || /^session:.+/.test(x.what) || isKind(kindOf(x.what)));
};
export function parse(v: unknown): Record<string, Split[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const all = Object.values(v as Record<string, unknown>);
  if (!Object.entries(v).every(([k, l]) => Array.isArray(l) && l.every((x) => ok(x) && x.what !== `session:${k}`))) return {};
  // A split id, or a session started for a split, appears once in the whole store.
  const flat = (all as Split[][]).flat();
  const once = (l: string[]) => new Set(l).size === l.length;
  return once(flat.map((s) => s.id)) && once(flat.map((s) => s.what).filter((w) => w.startsWith('session:'))) ? (v as Record<string, Split[]>) : {};
}
const read = (): unknown => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};

let state: Record<string, Split[]> = parse(read());
const subs = new Set<() => void>();
function set(next: Record<string, Split[]>) {
  const was = state;
  state = Object.fromEntries(Object.entries(next).filter(([, l]) => l.length));
  try {
    // Windows share this storage: write only the sessions this change touched onto what is stored now, so another
    // window's splits stay. shortcut: the same session split in two windows is last-writer-wins, upgrade with a window id.
    const merged = parse(read());
    for (const k of new Set([...Object.keys(was), ...Object.keys(state)])) {
      if (state[k] === was[k]) continue;
      if (state[k]) merged[k] = state[k];
      else delete merged[k];
    }
    // A merge that breaks the store's rules (an id twice) is not trusted: this window's own splits are written.
    localStorage.setItem(KEY, JSON.stringify(Object.keys(parse(merged)).length === Object.keys(merged).length ? merged : state));
  } catch {
    // Storage blocked: the splits last for this window run.
  }
  subs.forEach((f) => f());
}

export const useSplits = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );
export const splitsOf = (session: string): Split[] => state[session] ?? [];
let n = 0;
const cancelled = new Set<string>();
export function add(session: string, side: Dir, what: What, tab?: true): string {
  const id = `${Date.now().toString(36)}-${n++}`;
  set({ ...state, [session]: [...splitsOf(session), { id, side, what, ...(tab ? { tab } : {}) }] });
  return id;
}
export const replace = (session: string, id: string, what: What, tab?: true) => set({ ...state, [session]: splitsOf(session).map((s) => (s.id === id ? { id, side: s.side, what, ...(tab ? { tab } : {}) } : s)) });
export const remove = (session: string, id: string) => {
  cancelled.add(id); // A failed storage write must not resurrect an explicitly closed pane.
  set({ ...state, [session]: splitsOf(session).filter((s) => s.id !== id) });
};
/** Sessions that are gone or closed lose their splits. Only called with a live snapshot (an empty list at start is not one). */
export function prune(live: { id: string; state: string }[]): { session: string; started: string[]; moved: string[] }[] {
  const keep = (id: string) => live.some((s) => s.id === id && s.state !== 'closed');
  const gone = Object.entries(state).filter(([id]) => !keep(id));
  if (gone.length) set(Object.fromEntries(Object.entries(state).filter(([id]) => keep(id))));
  // Per dropped session, the sessions started for its splits (the caller ends their shells) and, ticket 1069, the ones moved
  // in from the strip (the caller gives them their tab back; they are never ended with the host).
  const ids = (l: Split[]) => l.map((x) => sessionOf(x.what)).filter((x): x is string => !!x);
  return gone.map(([session, l]) => ({ session, started: ids(l.filter((x) => !x.tab)), moved: ids(l.filter((x) => x.tab)) }));
}
/** Sessions shown in a split (started for one): they are not also window tabs. */
export const splitSessions = (s = state): string[] => Object.values(s).flat().map((x) => sessionOf(x.what)).filter((x): x is string => !!x);
/** The session's own PTY is shown in one of its splits (the Terminal widget): the side pane shows it there instead. */
export const ptyInSplit = (session: string, s = state) => (s[session] ?? []).some((x) => kindOf(x.what) === 'terminal');

/** A split is reserved before Start. */
export function bindSideSplit(parent: string, slot: string, session: string): boolean {
  if (cancelled.has(slot)) return false;
  const merged = new Map([...(parse(read())[parent] ?? []), ...(state[parent] ?? [])].filter((s) => !cancelled.has(s.id)).map((s) => [s.id, s]));
  const split = merged.get(slot);
  if (!split || (split.what !== SIDE_START && split.what !== `session:${session}`)) return false;
  merged.set(slot, { ...split, what: `session:${session}` });
  set({ ...state, [parent]: [...merged.values()] });
  return true;
}

// Item M (needs 171/172): a split's share of its axis, in percent, per split id. Window memory only: a temporary split is
// temporary, so the ratio is not stored anywhere (not in `nunchiro.splits.v1`, not in the layout).
export const RATIO = { min: 15, max: 85, dflt: 40 };
const ratios = new Map<string, number>();
const rsubs = new Set<() => void>();
export const ratioOf = (id: string) => ratios.get(id) ?? RATIO.dflt;
export const setRatio = (id: string, v: number) => {
  const next = Math.min(RATIO.max, Math.max(RATIO.min, Math.round(v)));
  if (ratioOf(id) === next && ratios.has(id) === (next !== RATIO.dflt)) return;
  if (next === RATIO.dflt) ratios.delete(id);
  else ratios.set(id, next);
  rsubs.forEach((f) => f());
};
export const useRatios = () =>
  useSyncExternalStore(
    (f) => (rsubs.add(f), () => rsubs.delete(f)),
    () => ratios.size + ':' + [...ratios].join(),
  );
