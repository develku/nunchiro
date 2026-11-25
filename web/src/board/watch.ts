// V2.5-69 (ticket 289, needs 208): the Board as a watch view. The columns are derived from state, never set by hand:
// Needs you, Working, Next, Done, and Idle (hidden unless the view shows it). Pure, so the rule tests without a page.
// Lifted and adapted (MIT) from Orca `src/renderer/src/components/dashboard-popout/` (the agent board component: the fixed bucket
// set and "the card that moved last is on top", `groupByBucket`) and `dashboard/dashboard-row-bucket.ts` (a state
// projects onto one bucket; a seen Done card is Idle), commit 0cee6cbd, Copyright (c) 2026 Lovecast Inc. The bucket rule
// is ours: Nunchiro's states are session states plus the columns that cards sit in.
// MIT License. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, including without
// limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
// Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of
// the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
// EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
import { flushSync } from 'react-dom';
import type { Card, Column, LaneKey } from './model';
import { agentState, type Session } from '../types';
import { seatWorking } from './tasks';
import type { WatchLanes } from './views';

export type Bucket = 'attention' | 'working' | 'next' | 'done' | 'idle';
/** The columns drawn, left to right; Idle is added at the end when the view asks for it. */
export const BUCKETS: Bucket[] = ['attention', 'working', 'next', 'done'];

/**
 * Where a card is watched.
 * - A session card by its live state: waiting on you -> Needs you; working -> Working; its finished turn not yet seen ->
 *   Done (Orca: an unseen Done card); an agent that ended -> Done; a finished turn already seen -> Idle. With its live
 *   `session` (ticket 407), a card the core calls working whose session is not working (an agent that has not run a
 *   turn yet, a quiet shell) is Idle, as the tree's dot says; without one the card's state alone decides.
 * - A task or integration card by what its column claims: a decision column or Review -> Needs you (it waits on you),
 *   Done (or a proof column), Working only while one of its seats is in a turn (ticket 1090, `seatWorking`), and else
 *   (To do, or Working with no seat in a turn) -> Next. A task card whose attached
 *   worker is asking is Needs you whatever its column says.
 * - A lead's task card (look v9 B N-S3-4) needs you by the Team view's rule only: a seat asks, or its merge card is open
 *   (the core parks it in the decision column, board `park_task`). In Review it is ready to merge and waits on nobody: Done.
 *   Look 1117 v11 B N11-S3-2: otherwise it works only while one of its seats works, as the Team view says; else it is Idle.
 * - A teammate's seat (a lead) that runs and has finished its turn is Idle, as the Team view says, not Done.
 */
export function bucketOf(card: Card, columns: Column[], session?: Session): Bucket {
  if (card.source === 'session') {
    switch (card.state) {
      case 'needs_decision':
        return 'attention';
      case 'review':
        return session?.teammate && agentState(session) === 'running' ? 'idle' : 'done';
      case 'idle':
        return 'idle'; // ticket 1092: a seat with no turn yet
      case 'done':
        return session && agentState(session) !== 'running' ? 'done' : 'idle';
      default:
        return session && !session.attention.working && !session.pending.some((d) => d.kind === 'background') ? 'idle' : 'working';
    }
  }
  const column = columns.find((c) => c.id === card.column);
  const claims = (s: Column['states'][number]) => !!column?.states.includes(s);
  if (column?.needs_decision || claims('needs_decision') || (claims('review') && !card.task)) return 'attention';
  if (claims('done') || column?.proof) return 'done';
  if (card.attachments?.some((a) => a.state === 'needs_decision')) return 'attention';
  if (claims('review') && card.task) return 'done';
  if (card.task) return seatWorking(card) ? 'working' : 'idle';
  // Ticket 1090: a Working column alone is not work; with no seat in a turn the card waits under Next.
  if (claims('working') && seatWorking(card)) return 'working';
  return 'next';
}

/** Most recently moved first (Orca): a card that just entered a column lands on top. */
export const byRecent = (cards: Card[]) => [...cards].sort((a, b) => (b.last_moved_at ?? b.updated_at) - (a.last_moved_at ?? a.updated_at));

/** Compact "N ago" parts for a card's time: the unit and the number, translated by the caller (Orca `formatStartedAgo`). */
export function elapsed(ms: number): { unit: 'now' | 'm' | 'h' | 'd'; n: number } {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return { unit: 'now', n: 0 };
  if (minutes < 60) return { unit: 'm', n: minutes };
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? { unit: 'h', n: hours } : { unit: 'd', n: Math.floor(hours / 24) };
}

/** The lane key of the watch view: a lane per project when asked, or by default when more than one project shows. */
export function watchLaneKey(setting: WatchLanes, projects: number): LaneKey {
  if (setting === 'project' || (setting === 'auto' && projects > 1)) return 'project';
  return 'none';
}

/**
 * The card's summary: the last thing its agent said, from the session's chat events (`chat_page`): the newest assistant
 * message or final text, its first non-empty line, cut at `max` characters. Null when the agent said nothing yet.
 */
export function summaryOf(events: { data?: Record<string, unknown> }[], max = 280): string | null {
  for (const { data } of [...events].reverse()) {
    const said = (data?.kind === 'message' && data.role === 'assistant') || data?.kind === 'final_text';
    const line = said && typeof data?.text === 'string' ? data.text.split('\n').map((l) => l.trim()).find(Boolean) : undefined;
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return null;
}

/** The name a card and its detail panel share for one view transition (Orca names each card `agentcard-…`; here one card morphs at a time). */
export const MORPH = 'watch-morph';

type Transitions = { startViewTransition?: (update: () => void) => { finished: Promise<unknown> } };

/**
 * Orca's card morph (`dashboard-popout/agent-board-transitions.css` and `AgentKanbanCard.tsx`, MIT, notice above): the element
 * the change starts from carries `view-transition-name` when the browser captures the old state, the element it ends at carries
 * it for the new state, and the browser animates one into the other. `update` runs inside the transition and is flushed there, so
 * the new DOM exists when the browser takes its picture; `to` finds the element the change ends at. No transition API, or reduced
 * motion, runs `update` at once and nothing is named (Orca's `prefers-reduced-motion` guard, also in watch.css).
 */
export function morph(from: HTMLElement | null, update: () => void, to: () => HTMLElement | null) {
  const doc = document as Document & Transitions;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!from || !doc.startViewTransition || reduced) return update();
  from.style.viewTransitionName = MORPH;
  let end: HTMLElement | null = null;
  const run = doc.startViewTransition(() => {
    from.style.viewTransitionName = '';
    flushSync(update);
    end = to();
    if (end) end.style.viewTransitionName = MORPH;
  });
  // Whatever way it ends (finished, skipped by a newer one), no element keeps the name: a second owner would cancel the next one.
  const clear = () => {
    from.style.viewTransitionName = '';
    end?.style.removeProperty('view-transition-name');
  };
  run.finished.then(clear, clear);
}

/** The detail panel's width in pixels: the default, the floor, and the key the window keeps its own choice under. */
export const DETAIL_W = 320;
export const DETAIL_MIN = 240;
/** The grid keeps at least this much room beside the panel. */
export const GRID_MIN = 200;
const WIDTH_KEY = 'nunchiro.board.watch.detailWidth';

/** The saved width, or null (the default) when nothing is saved, the value is not a sane number, or the storage throws. */
export function loadDetailWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= DETAIL_MIN && n <= 4000 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

export function saveDetailWidth(w: number | null) {
  try {
    if (w === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    // storage that throws leaves the width this window's for this run
  }
}
