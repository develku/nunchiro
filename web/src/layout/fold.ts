// V1A-60 main-zone minimum (needs 68, 69): while the main zone has fewer than MAIN_MIN_COLS terminal columns, side
// panels fold to their icon bar one at a time, oldest shown first; the last folded comes back when the columns over the
// minimum can hold its width. View state only: layout.toml is untouched, and edit mode shows every zone.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { terminals } from '../Terminal';
import { defaultZone, MAIN_MIN_COLS, sidesOf, type Layout, type Node } from './model';

/** The window's sidebars (App renders them beside the layout; LAYOUT D5b replaced the docks). A fold key is one of
 *  these or a layout node id. */
export const DOCKS = { left: '.sbar.l', right: '.sbar.r' } as const;
const DOCK_KEYS: string[] = Object.values(DOCKS);

/** Width of one terminal cell for a font, when no xterm is on screen to measure. */
function cellOf(size: number, family: string) {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return size * 0.6;
  ctx.font = `${size}px ${family}`;
  return ctx.measureText('W').width;
}

/** `view` is what the main zone shows (the active tab): a change re-measures it. Only layout panels `foldable` picks
 *  fold: those with an icon that can show them again. */
export function useFold(body: RefObject<HTMLElement | null>, layout: Layout, editing: boolean, font: { size: number; family: string }, view: string | null, foldable: (n: Node) => boolean) {
  const [folded, setFolded] = useState<string[]>([]);
  // keys: folded, in fold order; recent: present panels, the longest shown first (the fold order).
  // parked: the folds set aside while the main zone shows Settings, put back as it shows a terminal or chat again.
  const st = useRef({ keys: [] as string[], recent: [] as string[], widths: new Map<string, number>(), cell: 0, parked: null as string[] | null });
  const main = defaultZone(layout);
  const sides = sidesOf(layout.root, main);
  // Base order for panels already shown together: the left sidebar, layout panels outermost first, the right sidebar.
  const base = sides ? [DOCKS.left, ...sides.filter(foldable).map((n) => n.id), DOCKS.right] : [];
  const baseKey = base.join('\n');
  const shown = editing ? [] : folded;
  const box = (k: string) => (k.startsWith('.') ? body.current?.querySelector(`:scope > ${k}`) : body.current?.querySelector(`:scope > .layout [data-node-id="${CSS.escape(k)}"]`));
  /** True when the folds changed. */
  const save = (keys: string[]) => {
    if (keys.join('\n') === st.current.keys.join('\n')) return false;
    st.current.keys = keys;
    setFolded(keys);
    return true;
  };

  // A layout effect, so a change of view (Settings back to the terminal) is measured before it paints.
  useLayoutEffect(() => {
    const el = body.current?.querySelector(':scope > .layout');
    if (!el) return;
    let frame = 0;
    /** Columns the main zone has now; null when it shows neither a terminal nor a chat (Settings, nothing open);
     *  undefined when it cannot tell yet. */
    const columns = () => {
      const s = st.current;
      const zone = el.querySelector(`[data-zone-id="${CSS.escape(main)}"]`);
      // AGENTVIEW: the side pane's terminal is a part of the session view, not the main zone's width.
      const term = zone?.querySelector<HTMLElement>('.term:not([hidden]):not([data-side-pane] *)');
      const xt = term && terminals.get(term.dataset.session!);
      const screen = term?.querySelector('.xterm-screen')?.getBoundingClientRect().width;
      if (xt && xt.cols > 0 && screen) {
        // The box's columns, counted as xterm's fit counts them, not xterm's own count: a burst of folds can leave a
        // refit behind, and a stale count would hold folding still. Its cell width is right even then.
        s.cell = screen / xt.cols;
        const pad = getComputedStyle(term.querySelector('.xterm') ?? term);
        const bar = xt.options.scrollback === 0 ? 0 : xt.options.overviewRuler?.width || 14;
        return Math.floor((parseInt(getComputedStyle(term).width) - parseInt(pad.paddingLeft) - parseInt(pad.paddingRight) - bar) / s.cell);
      }
      // A terminal on screen whose xterm is not built yet (a tab shown for the first time): hold the folds.
      if (term) return undefined;
      // A chat is measured by the whole session view (chat and side pane): the pane takes its share from the chat, and
      // opening it must not fold the sidebars.
      const chat = zone?.querySelector('.chat:not([data-off])') && (zone.querySelector('.sview') ?? zone.querySelector('.chat:not([data-off])'))?.getBoundingClientRect().width;
      if (!chat) return null;
      s.cell ||= cellOf(font.size, font.family);
      return Math.floor(chat / s.cell);
    };
    const check = () => {
      frame = 0;
      const s = st.current;
      const width = (k: string) => box(k)?.getBoundingClientRect().width ?? 0;
      const live = base.filter((k) => box(k) && (s.keys.includes(k) || width(k) > 0));
      // A panel that just appeared goes to the end: the one the user opened is the last to fold.
      s.recent = [...s.recent.filter((k) => live.includes(k)), ...live.filter((k) => !s.recent.includes(k))];
      let keys = s.keys.filter((k) => live.includes(k));
      const cols = editing ? undefined : columns();
      if (cols === null) {
        // Every fold, the sidebars Settings just dropped too: they come back folded with it (V1A-60 fold-settings).
        if (s.keys.length) s.parked = s.keys;
        keys = [];
      } else if (s.parked) {
        keys = s.parked.filter((k) => live.includes(k));
        s.parked = null;
      } else if (cols !== undefined) {
        // The newest panel (just opened, or unfolded from its icon) never folds. The one holding focus folds only when no
        // other can: Search focuses its field, and a palette unfold of Board must still get its room (rc2b-fb3 r3).
        const open = s.recent.slice(0, -1).filter((k) => !keys.includes(k) && width(k) > 0);
        const next = open.find((k) => !box(k)!.contains(document.activeElement)) ?? open[0];
        const last = keys.at(-1);
        if (cols < MAIN_MIN_COLS && next) {
          s.widths.set(next, width(next));
          keys = [...keys, next];
        } else if (last && (cols - MAIN_MIN_COLS - 1) * s.cell >= (s.widths.get(last) ?? Infinity)) {
          // One column of slack, so a restore never lands one column short and folds the same panel again.
          keys = keys.slice(0, -1);
        }
      }
      // One step per frame until nothing changes: a step whose layout change fires no resize (a dock swapped for one
      // of the same width in between) still settles.
      if (save(keys)) later();
    };
    const later = () => void (frame ||= requestAnimationFrame(check));
    const ro = new ResizeObserver(later);
    ro.observe(el);
    const zone = el.querySelector(`[data-zone-id="${CSS.escape(main)}"]`);
    if (zone) ro.observe(zone);
    check();
    return () => (ro.disconnect(), cancelAnimationFrame(frame));
    // `base` is keyed by baseKey; `folded` changes re-run nothing, the resize they cause does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main, baseKey, editing, font.size, font.family, view]);

  // The sidebars host any widget, so the fold flag goes on as an attribute, not a prop. After the measuring effect: Settings
  // drops the sidebars (CHROME), and its folds must be parked before a vanished sidebar's key is dropped here.
  useLayoutEffect(() => {
    const docks = DOCK_KEYS.flatMap((sel) => [...(body.current?.querySelectorAll(`:scope > ${sel}`) ?? [])].map((e) => [sel, e] as const));
    for (const [sel, e] of docks) e.toggleAttribute('data-folded', shown.includes(sel));
    // A sidebar closed while folded stops counting at once, so it opens unfolded.
    save(st.current.keys.filter((k) => !DOCK_KEYS.includes(k) || docks.some(([sel]) => sel === k)));
    return () => docks.forEach(([, e]) => e.removeAttribute('data-folded'));
  });

  return {
    folded: shown,
    /** The icon of a folded panel shows it again: it becomes the newest panel, so another one folds if needed. */
    unfold: (k: string) => {
      const s = st.current;
      s.recent = [...s.recent.filter((x) => x !== k), k];
      save(s.keys.filter((x) => x !== k));
    },
  };
}
