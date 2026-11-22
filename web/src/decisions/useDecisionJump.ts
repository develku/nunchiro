// Tree: the jump from a decision row (split out of App.tsx, needs 183).
import { useCallback, useEffect, useRef, useState } from 'react';
import { failedRunCard } from '../schedule/schedules';
import type { Decision, Session } from '../types';

/** `queue.focus <id>`: ticket 08's strip listens for this to focus the item's answer card. Ticket 197: an item with no
 * session tab (a board item) and no strip to land on (the default layout has none) focuses its tree row, or,
 * with no row either (no project), opens the Board. */
export function emitQueueFocus(d: Pick<Decision, 'id' | 'session_id'>) {
  window.dispatchEvent(new CustomEvent('nunchiro:queue.focus', { detail: { id: d.id, session: d.session_id } }));
  // A drawn strip shows the asked card itself (one at a time, so it may not be in the DOM yet).
  if (d.session_id || document.querySelector('.qstrip')) return;
  const row = document.querySelector<HTMLElement>(`.q[data-item="${CSS.escape(d.id)}"]`);
  if (row) row.focus();
  else window.dispatchEvent(new Event(BOARD_OPEN));
}
/** Ticket 197: opens the Board modal (useBoardRail), never closes it. */
export const BOARD_OPEN = 'nunchiro:board.open';

type Deps = { open: (id: string) => void; active: string | null; tabs: string[]; setActive: (id: string | null) => void; /** unused since the chat lost its decision line; App.tsx:311 stops passing it (seam, REPORT Handoff) */ sessions?: Session[] };

/** V2-8e: a decision row's action and its jump to the Decisions widget (and back). `onAnswer` stays in App (the answer path). */
export function useDecisionJump({ open, active, tabs, setActive }: Deps) {
  // V2-8e: a jump from a decision row to its session's item in the Decisions widget; the session tab it came from
  // (Esc, Cmd+[ return there), the tab the window was on, and a number that changes with each jump (the focus ask).
  const [jump, setJump] = useState<{ to: string; from: string | null; tab: string | null; n: number; asked: boolean } | null>(null);
  const showDecisions = useRef<() => void>(() => {});
  const onAction = useCallback(
    (d: Decision) => {
      // v1b-18: a board item has no session tab. Nor has a failed scheduled run's card: its `session_id` is the
      // schedule's id (the core's shape, eighth look), never a session to open.
      if (d.session_id && !failedRunCard(d)) open(d.session_id);
      emitQueueFocus(d);
    },
    [open],
  );
  const onDetails = useCallback(
    (d: Decision) => {
      if (!d.session_id || failedRunCard(d)) return onAction(d);
      const here = active && active !== d.session_id ? active : null;
      // A jump from a card to another keeps the first place to return to.
      setJump((j) => ({ to: d.session_id, from: j ? j.from : here, tab: active, n: (j?.n ?? 0) + 1, asked: false }));
      showDecisions.current();
    },
    [active, onAction],
  );
  const back = useCallback(() => {
    if (!jump) return;
    setJump(null);
    if (jump.from && tabs.includes(jump.from)) setActive(jump.from);
    // Focus goes back to the decision's row when it is still there (an answered one is gone).
    setTimeout(() => document.querySelector(`.q[data-line="${CSS.escape(jump.to)}"]`)?.closest('.sess')?.querySelector<HTMLElement>('.row.wt2, .q[tabindex]')?.focus(), 0);
  }, [jump, tabs]);
  // Going to another tab by any other way ends the jump.
  useEffect(() => {
    if (jump && active !== jump.tab) setJump(null);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return { onAction, onDetails, jump, setJump, back, showDecisions };
}
