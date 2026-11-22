// v25-reopen-tab (ticket 299): the tabs closed in this window, newest last, at most 10. In memory only: a reload or quitting the
// app clears it (no stored state). `tab` entries are strip tabs (a session tab keeps a copy of its session, for a session the core
// has forgotten); `browser` entries are a session's Browser tab, closed with its page (Forget data), with its last address.
import { useSyncExternalStore } from 'react';
import type { Session } from '../types';

export const MAX_CLOSED = 10;
export type Closed = { tab: string; at: number; session?: Session } | { browser: string; url: string };

let list: Closed[] = [];
const subs = new Set<() => void>();
const set = (next: Closed[]) => ((list = next.slice(-MAX_CLOSED)), subs.forEach((f) => f()));

export const noteClosed = (...entries: Closed[]) => set([...list, ...entries]);
/** The newest entry, removed; undefined when nothing was closed. */
export function takeClosed(): Closed | undefined {
  const last = list.at(-1);
  if (last) set(list.slice(0, -1));
  return last;
}
/** Undo of a close puts the tabs back itself, so their entries go. */
export const forgetClosed = (ids: string[]) => set(list.filter((e) => !('tab' in e && ids.includes(e.tab))));
export const useClosed = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => list,
  );

/** Ticket 1013 F6: the ids of sessions in `list` a command closed (not the window's own Close) that `dropped` has not
 *  taken yet; `dropped` takes them, and forgets ids a non-empty `list` no longer names, so it never grows past the
 *  listed sessions (Codex note on w81). An empty list may be a core restarting (useCoreLink keeps the tabs then). */
export const commandClosed = (dropped: Set<string>, list: Session[]) => {
  if (list.length) for (const id of dropped) if (!list.some((s) => s.id === id)) dropped.delete(id);
  // Sixth look (Home S3): a seat a command ended for another level hands its tab to its new seat (lead.ts `useSeatFollow`).
  const replaced = (s: Session) => !!s.teammate && list.some((o) => o.id !== s.id && o.teammate === s.teammate && o.state === 'running');
  const first = list.filter((s) => s.state === 'closed' && !!s.closed_by_command && !dropped.has(s.id) && !replaced(s)).map((s) => s.id);
  first.forEach((id) => dropped.add(id));
  return new Set(first);
};
