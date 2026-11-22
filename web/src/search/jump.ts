// V2-7: a Sessions search hit asks that session's chat to show one event (its chat cursor). The chat list takes the
// request once the event is loaded, pages back to reach it, and clears it; a newer request replaces an older one.
import { useSyncExternalStore } from 'react';

export interface Jump {
  cursor: number;
  seq: number;
}
const jumps = new Map<string, Jump>();
const subs = new Set<() => void>();
let seq = 0;
const tell = () => subs.forEach((f) => f());

export function jumpTo(session: string, cursor: number) {
  jumps.set(session, { cursor, seq: ++seq });
  tell();
}

/** Only the request it was given: one the user made since stays. */
export function doneJump(session: string, jump: Jump) {
  if (jumps.get(session) !== jump) return;
  jumps.delete(session);
  tell();
}

export function useJump(session: string): Jump | null {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => jumps.get(session) ?? null,
  );
}
