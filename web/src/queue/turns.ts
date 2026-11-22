// Needs 170 (2): the one definition of "a turn ended" and "the user is looking at it". The window's done cue and OS
// notification (App.tsx, notify.tsx) read these; a sub-agent is a `Kid` inside its parent, never a session, so only a
// `side_chat` session stands for one here.
import { status, type Session } from '../types';

/** Ids whose `attention.working` went true to false while the session runs and is not waiting or failed (those have their
 *  own alerts). A session missing from `prev` is a first sight, not an end. */
export function turnEnds(prev: Map<string, boolean>, sessions: Session[]): string[] {
  return sessions
    .filter((s) => prev.get(s.id) === true && !s.attention.working && s.state === 'running' && !['waiting', 'failed'].includes(status(s)))
    .map((s) => s.id);
}

/** Ticket 372: ids whose status turned 'failed' since `prev`. A session missing from `prev` is a first sight, not a failure
 *  (T3 ThreadNotificationCoordinator.tsx:141-144, MIT; rule only). */
export const failures = (prev: Map<string, string>, sessions: Session[]): string[] =>
  sessions.filter((s) => prev.has(s.id) && prev.get(s.id) !== 'failed' && status(s) === 'failed').map((s) => s.id);

/** The user can see this session now: the window has focus, is visible, and the session is the current tab. */
export const isViewed = (id: string, current: string | null) => document.hasFocus() && document.visibilityState === 'visible' && id === current;

/** A side chat stands for a sub-agent in the notification rule (settled with the brief): it never rings. */
export const isChild = (s: Session) => s.side_chat === true;
