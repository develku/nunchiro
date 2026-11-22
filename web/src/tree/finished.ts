// Ticket 1022 (mockup docs/design/tree-done-1121): when a session finished, for the tree's 10-minute "just finished" row,
// the project head's hollow bars (today's) and the History widget's days. The core stamps `closed_at` on a close; an
// agent that quit (exited, or ended inside its shell) has no stamp, so the window notes the moment it saw the end. A
// session already finished when the window first saw the core has no known time: it is no "just finished" row.
import { agentState, status, type Session } from '../types';

/** Ended, for the tree and History: closed, its agent quit, or resumable (owner 11-21: an agent whose run ended with the
 *  core at an app quit or a reboot kept its row for ever). A resumable one that waits for an answer keeps its row, and a
 *  team seat too (the lead's row stays first and findable, owner 11-17). */
export const ended = (s: Session) => s.state === 'closed' || agentState(s) === 'exited' || (s.state === 'resumable' && !s.teammate && status(s) !== 'waiting');

/** How long a finished session stays in the tree as a dimmed row. */
export const JUST_MS = 10 * 60_000;

/** `null`: finished before this window saw it. `'live'`: seen working, not finished yet. */
const seen = new Map<string, number | 'live' | null>();
let primed = false;

/** Notes every session's end as this render sees it; call once per tree render with the core's first snapshot drawn
 *  (`ready`), so the sessions already finished at load are not taken for ones that just ended. */
export function noteEnds(sessions: Session[], quiet: (s: Session) => boolean, ready: boolean, now = Date.now()) {
  if (!ready) return;
  for (const s of sessions) {
    const was = seen.get(s.id);
    if (!quiet(s)) seen.set(s.id, 'live');
    else if (was === 'live' || (was === undefined && primed)) seen.set(s.id, now);
    else if (was === undefined) seen.set(s.id, null);
  }
  primed = true;
}

/** When `s` finished (epoch ms) as the core stamped it or this window saw it, or null: what the 10 minutes run from. */
export const finishedAt = (s: Session): number | null => {
  const v = seen.get(s.id);
  return s.closed_at ?? (typeof v === 'number' ? v : null);
};

/** Finished less than JUST_MS ago. */
export const isJust = (s: Session, now: number) => {
  const at = finishedAt(s);
  return at !== null && now - at < JUST_MS;
};

/** When `s` ended, for its day and time in the head's count, the popover and History: the core's own stamp of the run's
 *  end (`ended_at`, lane w59: a quiet run that ended by itself read "<1 min"), else `finishedAt`, else its last output (a
 *  row that ended before the core kept the stamp has no other time; there the last output is the end within seconds for
 *  an agent, and too early for a quiet shell). */
export const endedAt = (s: Session): number | null => s.ended_at ?? finishedAt(s) ?? (s.attention.last_activity || null);

/** Ended today by the local clock; the count starts again at midnight. One with no time at all is not today's. */
export const isToday = (s: Session, now: number) => {
  const at = endedAt(s);
  return at !== null && new Date(at).toDateString() === new Date(now).toDateString();
};
/** The next local midnight after `now`. */
export const nextMidnight = (now: number) => new Date(now).setHours(24, 0, 0, 0);

/** Newest first; an unknown time last. */
export const byEnd = (a: Session, b: Session) => (endedAt(b) ?? 0) - (endedAt(a) ?? 0);

const lang = () => document.documentElement.lang || undefined;
const dayOf = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
/** Days between the local days of `at` and `now` (0 today, 1 yesterday). */
export const daysAgo = (at: number, now: number) => Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
/** "09:42", in the window's language. */
export const clock = (at: number) => new Date(at).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' });
/** "09:42" today, "yesterday" or "Nov 19" before, in the window's language. */
export function endText(at: number, now: number) {
  const days = daysAgo(at, now);
  if (days < 1) return clock(at);
  if (days === 1) return new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' }).format(-1, 'day');
  return new Date(at).toLocaleDateString(lang(), { month: 'short', day: 'numeric' });
}
