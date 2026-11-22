// v25-quiet-chat (ticket 294 item 2, needs 213): a message sent while the agent still asks a startup question (trust,
// imports) is held here, not typed into the dialog. useComposerSend delivers it once the session has nothing pending;
// the composer shows it with a Cancel that gives the words back. Window memory only: a reload shows the box empty and
// the words are gone with it, as with any send in flight (ponytail: persist like composer-drafts if that bites).
import { useSyncExternalStore } from 'react';
import type { Session } from '../types';
import { userView } from './conversation';

const held = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** An unanswered dialog, permission or question (the kinds the core's key gate refuses on; not stale or background rows). */
export const asks = (s: Session) => s.pending.some((d) => d.kind === 'permission' || d.kind === 'question' || d.kind === 'dialog');
/** A startup prompt (trust, login, onboarding): something asks while the agent has completed no turn yet. The snapshot's
 *  `completion_seq` counts completed turns (core README), so a later permission wait is not one (ticket 294 item 2, review S2). */
export const asksFirst = (s: Session) => asks(s) && ((s as Session & { completion_seq?: number }).completion_seq ?? 0) === 0;
/** A first message waits: a startup prompt asks, or (look 11-17 v3 P1) a new Claude has not shown its input box yet
 *  (the core's `starting`; text typed before the box is lost). Only `asksFirst` tells the user to answer something. */
export const blocked = (s: Session) => asksFirst(s) || !!(s as Session & { starting?: boolean }).starting;

// A second Send while one message waits is not sent: the composer says why (review S3). Cleared with the held message.
const refused = new Set<string>();
export const refuseSecond = (id: string) => (refused.add(id), emit());
export const useRefused = (id: string | undefined) => useSyncExternalStore(subscribe, () => !!id && refused.has(id));

export const holdText = (id: string, text: string) => (held.set(id, text), emit());
export const heldText = (id: string) => held.get(id);
export const heldIds = () => [...held.keys()];
/** Takes the held text out (delivery or Cancel). */
export function takeHeld(id: string): string | undefined {
  const text = held.get(id);
  const had = held.delete(id);
  refused.delete(id);
  if (had) emit();
  return text;
}
export const useHeld = (id: string | undefined) => useSyncExternalStore(subscribe, () => (id ? held.get(id) : undefined));

type LogRow = { id: string; sender: string; status: string; content: string };
/** Look 1117 v14 N14-S3-1: a message the core holds while a card waits (sessions.rs SendText) is a queued row of the user's
 *  in its send log. Look 1117 v16 A S3: a seat's brief is queued as the user's too (team.rs open_seat), but the person did
 *  not write it: `own` leaves it out (shown, given back on Cancel), `brief` says one waits (shown as one line, kept). */
export const cardHeldRows = (log: readonly LogRow[] = []) => {
  const queued = log.filter((r) => r.sender === 'user' && r.status === 'queued');
  const isBrief = (r: LogRow) => userView(r.content).brief !== undefined;
  return { own: queued.filter((r) => !isBrief(r)), brief: queued.some(isBrief) };
};
