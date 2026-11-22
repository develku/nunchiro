// V2-6a: the one pending Undo. A reversible action pushes {label, undo}; the status line offers it for 10 s and Cmd+Z runs it.
// A newer push replaces the pending one (one at a time); layout edits keep their own 3-step history behind `undo`.
import { docT, errorNote, notePlain, type Note } from '../errors';
import { useSyncExternalStore } from 'react';

export const UNDO_MS = 10_000;
/** `deadline` (absolute ms, Date.now()) is a hard end: a pause never holds the offer past it (a source whose own window is fixed). */
export type Entry = { label: string; undo: () => unknown; deadline?: number };
type State = { entry: Entry | null; failed: Note; n: number; paused: boolean };

let state: State = { entry: null, failed: '', n: 0, paused: false };
let timer: ReturnType<typeof setTimeout> | undefined;
let hard: ReturnType<typeof setTimeout> | undefined; // fires at the entry's deadline even while paused
let armedAt = 0; // when the timer was armed, and how long it was armed for: pause() works out the time left from them
let armedFor = UNDO_MS;
const subs = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  subs.forEach((f) => f());
};
const arm = (ms = UNDO_MS) => {
  clearTimeout(timer);
  armedAt = Date.now();
  armedFor = ms;
  timer = setTimeout(expire, ms);
};
function expire() {
  clearTimeout(timer);
  clearTimeout(hard);
  set({ entry: null, failed: '', paused: false });
}

export function push(e: Entry) {
  arm();
  clearTimeout(hard);
  if (e.deadline !== undefined) hard = setTimeout(expire, Math.max(0, e.deadline - Date.now()));
  set({ entry: e, failed: '', n: state.n + 1, paused: false });
}

/** Hover or focus on the line (WCAG 2.2.1): stops the countdown and keeps the time left; a no-op without an entry. */
export function pause() {
  if (!(state.entry || state.failed) || state.paused) return;
  clearTimeout(timer);
  armedFor = Math.max(0, armedFor - (Date.now() - armedAt));
  set({ paused: true });
}

/** Pointer and focus both left: the countdown goes on with the time that was left, never a fresh ten seconds. */
export function resume() {
  if (!state.paused) return;
  arm(armedFor);
  set({ paused: false });
}

/** Takes `e` away if it is still the pending entry (its own source undid it another way). */
export function drop(e: Entry) {
  if (state.entry !== e) return;
  clearTimeout(timer);
  clearTimeout(hard);
  set({ entry: null, paused: false });
}

/** Runs the pending Undo once; a refusal is said in the line for the rest of the ten seconds. */
export async function run() {
  const e = state.entry;
  if (!e) return;
  clearTimeout(hard); // the undo is under way: only the failed line is left to time
  set({ entry: null }); // `paused` stays: the pointer or focus may still be on the line
  try {
    await e.undo();
    clearTimeout(timer);
    set({ failed: '', paused: false });
  } catch (err) {
    const held = state.paused;
    if (held) {
      clearTimeout(timer);
      armedFor = UNDO_MS;
    } else arm();
    set({ failed: errorNote(docT()('err.note.undo', { error: notePlain(docT(), err) }), err), paused: held });
  }
}

/** Cmd+Z / Ctrl+Z outside the terminal, composer and any text field (they keep their own undo). */
export function onKey(e: KeyboardEvent) {
  if (e.code !== 'KeyZ' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.defaultPrevented || !state.entry) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, select, [contenteditable], .xterm') || t?.isContentEditable) return;
  e.preventDefault();
  void run();
}

export const useUndo = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );
