// Board: the Board's rail toggle (split out of App.tsx, needs 183; v25f: it opens the Board modal) and the count of cards that need the owner on its icon
// (V2.5-60, ticket 219 B13).
import { useEffect, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { CoreClient } from '../api';
import type { OverlayKind } from '../chrome/Overlay';
import { kindOf, leaves, type Node } from '../layout/model';
import type { Snapshot } from './model';
import { bucketOf } from './watch';
import { BOARD_OPEN } from '../decisions/useDecisionJump';

/** A node that holds a Board (the fold treats it as a side panel). */
export const hasBoard = (n: Node) => leaves(n).some((z) => z.widgets.some((w) => kindOf(w) === 'board'));

/** The cards the watch view puts in Needs you (the same `bucketOf` rule), over the whole board: no chip, project or search narrows it. */
export const needsYouCount = (snap: Pick<Snapshot, 'cards' | 'columns'>) => snap.cards.filter((c) => bucketOf(c, snap.columns) === 'attention').length;

// The icon bar reads the count from here, so the bar needs no new prop: the hook below writes it, `useNeedsYou` reads it.
// `narrowed`: the Board widget's chips, project or search hide a card that needs the owner, so its shown number is lower.
type Rail = { n: number; narrowed: boolean };
let rail: Rail = { n: 0, narrowed: false };
let sharedAt = 0; // when the Board widget last handed over its snapshot
let askedAt = 0; // when the rail last asked the core itself
/** The rail asks on its own at most this often (ms) while the Board widget is not polling: each ask reads the board files. */
export const RAIL_EVERY = 4000;
const listeners = new Set<() => void>();
const publish = (n: number, narrowed = false) => {
  if (n === rail.n && narrowed === rail.narrowed) return;
  rail = { n, narrowed };
  listeners.forEach((l) => l());
};
/** The count over the whole board (chips and search never change it) and whether the widget's view shows fewer. */
export const useNeedsYou = () => useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => rail);

/**
 * The Board widget hands over the snapshot it polled (V2.5-60 B13 follow-up): the rail counts it and does not ask the core
 * again while the widget keeps polling. `shown` is what the widget's chips, project and search leave on screen.
 */
export function shareBoard(snap: Pick<Snapshot, 'cards' | 'columns'>, shown: Snapshot['cards']) {
  sharedAt = Date.now();
  const n = needsYouCount(snap);
  publish(n, needsYouCount({ cards: shown, columns: snap.columns }) !== n);
}

type Deps = { core: CoreClient; setOverlay: Dispatch<SetStateAction<OverlayKind>> };

/** The Board's rail control (bar icon, palette `board.toggle`). */
export function useBoardRail({ core, setOverlay }: Deps) {
  // The Board widget polls only while it shows and hands its snapshot over (`shareBoard`); the rail icon is there with no
  // Board placed, or with it behind another tab, so it asks on its own once the widget and the rail itself have been quiet for
  // RAIL_EVERY (a hidden window does not). One timer wakes each second; only the quiet check lets an ask through.
  useEffect(() => {
    let live = true;
    let asking = false; // an ask the core has not answered holds the next one back
    const tick = () => {
      if (document.visibilityState !== 'visible' || Date.now() - Math.max(sharedAt, askedAt) < RAIL_EVERY || asking) return;
      askedAt = Date.now();
      asking = true;
      core.request({ op: 'board_snapshot' }).then(
        (r) => {
          asking = false;
          const board = (r as { board?: Snapshot }).board; // a reply without a board keeps the last count
          if (live && board) publish(needsYouCount(board));
        },
        () => void (asking = false), // keep the last count; the next tick tries again
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(timer);
      publish(0);
    };
  }, [core]);
  /** v25f (D-20261108-10): the Board icon and `board.toggle` open the Board modal over the workspace, or close it. */
  const toggleBoard = () => setOverlay((o) => (o === 'board' ? null : 'board'));
  // Ticket 197: a board item's jump with no strip card or tree row to land on.
  useEffect(() => {
    const open = () => setOverlay('board');
    window.addEventListener(BOARD_OPEN, open);
    return () => window.removeEventListener(BOARD_OPEN, open);
  }, [setOverlay]);
  return { toggleBoard };
}
