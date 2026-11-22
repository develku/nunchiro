// v25-shell-chrome (ticket 282 item 1, last clause): a chat's scroll position comes back with the window. The shell watches the
// scrollers the chat view draws (`.cscroll` inside `.chat[data-session]`), so the chat view itself is untouched: a scroll that
// leaves the bottom is kept per session (chrome/windowState.ts); a chat that follows the newest message keeps nothing and
// opens at the bottom as before. A scroller that appears waiting for its history gets its saved place put back, and the first
// scroll by the user ends the attempt. A scroller whose history is there from its first frame was placed by the chat view itself
// (it keeps the place of the last eight chats it showed, ChatView `kept`) and is left alone, so a closed and reopened tab restores
// whenever the view lost its own memory (ticket 297 item 11).
//
// Deep places (ticket 297 item 10): a pixel offset cannot name a place in a history the view loads page by page (after a reload
// only the newest page is there, and rows it has not drawn count 36 px), so the saved place is the row at the top edge: its chat
// event (`data-key`, the event cursor the view keys rows by) and how far into the row the view starts. `windowState.scroll` holds
// one number per session, so both go in it: PLACE + key * ROW + offset. A smaller number is an older pixel offset and is ignored.
// The restore sits at the top of the list, which makes the view page older events in, until the saved row's page is there, then
// finds the row and lands on it. All of it is hidden from view.
import { useEffect, type RefObject } from 'react';
import { scrollOf, setScroll } from './windowState';

const BOTTOM = 8; // the chat view's own "at the bottom" margin (ChatView.tsx BOTTOM)
const SAVE_MS = 150;
const GIVE_UP_MS = 20_000;
const STALL = 90; // frames without the list changing before older pages are taken as all loaded
const PLACE = 2 ** 40; // marks a number as a place (a pixel offset is far below it)
const ROW = 4096; // room for the offset into the row (px); a row taller than this keeps its first 4095 px

const rowsOf = (sc: HTMLElement) => [...sc.querySelectorAll<HTMLElement>('.crow')].map((el) => ({ el, key: Number(el.dataset.key), index: Number(el.dataset.index) }));
const mainScroller = (e: Element): HTMLElement | null => (e instanceof HTMLElement && e.classList.contains('cscroll') && !e.parentElement?.closest('.cscroll') ? e : null);
const sessionOf = (sc: HTMLElement) => sc.closest<HTMLElement>('.chat[data-session]')?.dataset.session;

/** The place the view is at: the row at the top edge and how far into it the view starts; null when no row is drawn. */
function placeOf(sc: HTMLElement): number | null {
  const top = sc.getBoundingClientRect().top;
  const at = rowsOf(sc).find((r) => r.el.getBoundingClientRect().bottom > top + 1);
  return at ? PLACE + at.key * ROW + Math.min(ROW - 1, Math.max(0, Math.round(top - at.el.getBoundingClientRect().top))) : null;
}

export function useScrollKeep(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const timers = new Map<string, number>();
    /** Scrollers whose restore is running (our own writes must not be saved as the user's). */
    const restoring = new WeakSet<HTMLElement>();
    const onScroll = (e: Event) => {
      const sc = e.target instanceof Element ? mainScroller(e.target) : null;
      const id = sc && sessionOf(sc);
      if (!sc || !id || restoring.has(sc)) return;
      window.clearTimeout(timers.get(id));
      timers.set(id, window.setTimeout(() => setScroll(id, sc.scrollHeight - sc.scrollTop - sc.clientHeight < BOTTOM ? null : placeOf(sc)), SAVE_MS));
    };
    const restore = (sc: HTMLElement, id: string) => {
      if (restoring.has(sc)) return;
      const saved = scrollOf(id);
      // A chat that draws its history in its very first frame has its own memory of the place (ChatView `kept`); a fresh one starts busy.
      if (saved === undefined || saved < PLACE || sc.querySelector('.clist')?.getAttribute('aria-busy') === 'false') return;
      const key = Math.floor((saved - PLACE) / ROW);
      const offset = (saved - PLACE) % ROW;
      restoring.add(sc);
      const t0 = performance.now();
      const stop = () => (restoring.delete(sc), (sc.style.visibility = ''), sc.removeEventListener('wheel', stop), sc.removeEventListener('pointerdown', stop), sc.removeEventListener('keydown', stop));
      sc.addEventListener('wheel', stop, { once: true });
      sc.addEventListener('pointerdown', stop, { once: true });
      sc.addEventListener('keydown', stop, { once: true });
      let landed = 0; // frames spent on the row
      let stalled = 0;
      let height = -1;
      const tick = () => {
        if (!restoring.has(sc) || !sc.isConnected) return stop();
        if (performance.now() - t0 > GIVE_UP_MS) return (sc.scrollTop = sc.scrollHeight), stop(); // could not reach it: the bottom, as without a restore
        const rows = rowsOf(sc);
        if (!rows.length) return void requestAnimationFrame(tick); // the history has not arrived yet
        sc.style.visibility = landed ? '' : 'hidden';
        const top = sc.getBoundingClientRect().top;
        const first = rows.reduce((a, r) => (r.index < a.index ? r : a));
        // The row: the last one at or before the saved event (rows fold events, so the exact key may not be a row).
        const before = rows.filter((r) => r.key <= key);
        const row = before.length ? before.reduce((a, r) => (r.index > a.index ? r : a)) : undefined;
        const next = row && rows.find((r) => r.index === row.index + 1);
        if (row && (next || row.key === key || landed)) {
          // Found it (the next row is drawn too, so no earlier row hides between): put its top at the saved distance above the view's edge.
          const delta = row.el.getBoundingClientRect().top + offset - top;
          if (Math.abs(delta) > 1) sc.scrollTop += delta;
          if (++landed > 20) return stop(); // held a moment while the list measures its rows
        } else if (!row && first.index === 0 && !landed) {
          // The page holding the event is not loaded: the view pages older events in while it is within a screen of the top.
          sc.scrollTop = 0;
          stalled = sc.scrollHeight === height ? stalled + 1 : 0;
          height = sc.scrollHeight;
          if (stalled > STALL) return (sc.scrollTop = sc.scrollHeight), stop(); // all loaded and still not there: the history was cut
        } else {
          // Loaded but not drawn: move toward it by the distance in events (a row counts 36 px until it is drawn).
          const last = rows.reduce((a, r) => (r.index > a.index ? r : a));
          sc.scrollTop += key > last.key ? Math.max(sc.clientHeight * 0.5, Math.min(sc.clientHeight * 4, (key - last.key) * 36)) : -Math.max(sc.clientHeight * 0.5, Math.min(sc.clientHeight * 4, (first.key - key) * 36));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    /** A scroller is restored once, when it first appears: later DOM changes (an arriving message) must never pull it back. */
    const handled = new WeakSet<HTMLElement>();
    const find = () => el.querySelectorAll<HTMLElement>('.cscroll').forEach((sc) => {
      const id = !handled.has(sc) && mainScroller(sc) && sessionOf(sc);
      if (!id) return;
      handled.add(sc);
      restore(sc, id);
    });
    const mo = new MutationObserver(find);
    mo.observe(el, { childList: true, subtree: true });
    find();
    el.addEventListener('scroll', onScroll, true);
    return () => {
      mo.disconnect();
      el.removeEventListener('scroll', onScroll, true);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [root]);
}
