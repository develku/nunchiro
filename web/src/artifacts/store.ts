// What Preview (▶) shows (ticket v1b-06): each session's last selected artifact or file. An unpinned Preview follows
// the focused session; `preview@<session>` keeps one. Selecting also opens the right dock when no Preview zone is
// placed, so a card reaches Preview in one click. Files (09) and Artifacts (13) call `select` the same way.
import { useSyncExternalStore } from 'react';
import type { Target } from './host';

export type Selection = Target;

let bySession: Record<string, Selection> = {};
let dock = false;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export function select(session: string, s: Selection) {
  bySession = { ...bySession, [session]: s };
  dock = true;
  changed();
}

export function setDock(open: boolean) {
  dock = open;
  changed();
}

export const useSelection = (session: string | null | undefined) =>
  useSyncExternalStore(subscribe, () => (session ? bySession[session] : undefined) ?? null);

export const useDock = () => useSyncExternalStore(subscribe, () => dock);
