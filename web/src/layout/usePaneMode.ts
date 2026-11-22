// Layout: pane mode (split out of App.tsx, needs 183).
import { docT, errorNote, notePlain, type Note } from '../errors';
import { useEffect, useRef } from 'react';
import { measureDom } from './DragLayer';
import { defaultZone, find, nearestZone, resizeStep, type Dir, type Layout, type Op } from './model';
import { LayoutStore } from './store';

// v1a-43: the pane mode resize step in px (its keys, PANE_DIRS and PANE_LEAVE, are in keys.ts for the Keys page).
const PANE_STEP = 16;

type Deps = {
  store: LayoutStore;
  layout: Layout;
  editing: boolean;
  pane: string | null;
  setPane: (zone: string | null) => void;
  paneNote: Note;
  setPaneNote: (note: Note) => void;
  setZoom: (zone: string | null) => void;
  toSink: () => void;
  fromSink: () => void;
  before: { current: HTMLElement | null };
  /** The tab in front: a failure's note belongs to it. */
  active: string | null;
};

/** v1a-43: pane mode (move, swap and resize zones from the keyboard), the last focused zone, and the mode's end and note. */
export function usePaneMode({ store, layout, editing, pane, setPane, paneNote, setPaneNote, setZoom, toSink, fromSink, before, active }: Deps) {
  const lastZone = useRef<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e.target as HTMLElement | null)?.closest?.('[data-zone-id]')?.getAttribute('data-zone-id');
      if (id) lastZone.current = id;
    };
    document.addEventListener('focusin', on);
    document.addEventListener('pointerdown', on, true);
    return () => (document.removeEventListener('focusin', on), document.removeEventListener('pointerdown', on, true));
  }, []);
  // v1a-43: edit mode and a removed zone end pane mode; a note shown outside the mode (direct commands) fades.
  useEffect(() => {
    if (pane && (editing || !find(layout.root, pane))) (setPane(null), setPaneNote(''), fromSink());
  }, [pane, editing, layout]);
  useEffect(() => {
    // Ticket 476: a failure's note stays until the next note or its × replaces it: its details may still be wanted. One about a
    // session fades too (v9-Home-S3-5), later than plain words so its details can still be copied.
    if (!paneNote || pane || (typeof paneNote !== 'string' && !paneNote.session)) return;
    const t = setTimeout(() => setPaneNote(''), typeof paneNote === 'string' ? 4000 : 10_000);
    return () => clearTimeout(t);
  }, [paneNote, pane]);
  // Look 1117 v9 Home S3-5: a failure's note goes when another tab comes to the front ("Not restarted" stayed over every
  // tab for minutes). One set in the same step as the switch is the new tab's and stays.
  const noteTab = useRef(active);
  useEffect(() => void (noteTab.current = active), [paneNote]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (typeof paneNote !== 'string' && noteTab.current !== active) setPaneNote('');
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // v1a-43: pane mode actions; `paneApi` is refreshed every render so the memoised command rows never go stale.
  const focusedZone = () => (lastZone.current && find(layout.root, lastZone.current) ? lastZone.current : defaultZone(layout));
  const paneFrom = () => pane ?? focusedZone();
  const paneRects = () =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-zone-id]')].map((el) => [el.dataset.zoneId!, el.getBoundingClientRect()] as const).filter(([, r]) => r.width > 0 && r.height > 0).map(([id, r]) => [id, { x: r.x, y: r.y, w: r.width, h: r.height }]),
    );
  const paneStart = useRef<string | null>(null);
  const focusZone = (id: string) => {
    const z = document.querySelector<HTMLElement>(`[data-zone-id="${CSS.escape(id)}"]`);
    // The shown terminal first (not the tab strip before it in the DOM); a zone with nothing to type into takes the focus itself.
    const term = [...(z?.querySelectorAll<HTMLElement>('.xterm-helper-textarea') ?? [])].find((t) => t.getClientRects().length > 0);
    (term ?? z?.querySelector<HTMLElement>(':is(textarea, input, button, [tabindex]):not([hidden])') ?? z)?.focus();
  };
  const paneEdit = async (op: Op | null, after?: () => void) => {
    if (!op) return;
    try {
      await store.run(op, measureDom);
      setPaneNote('');
      after?.();
    } catch (e) {
      setPaneNote(errorNote(notePlain(docT(), e), e));
    }
  };
  const paneApi = useRef({
    focus: (_d: Dir) => {},
    swap: (_d: Dir) => {},
    resize: (_d: Dir) => {},
    enter: () => {},
    leave: () => {},
  });
  paneApi.current = {
    focus: (d) => {
      const to = nearestZone(paneRects(), paneFrom(), d);
      setPaneNote('');
      if (!to) return;
      if (pane) return setPane(to);
      focusZone(to);
    },
    swap: (d) => {
      const [from, to] = [paneFrom(), nearestZone(paneRects(), paneFrom(), d)];
      if (to) void paneEdit({ op: 'swap', a: from, b: to }, () => pane && setPane(to));
    },
    resize: (d) => void paneEdit(resizeStep(store.current, paneFrom(), d, PANE_STEP, measureDom)),
    enter: () => (setZoom(null), (paneStart.current = paneFrom()), setPane(paneFrom()), setPaneNote(''), toSink()),
    // A zone picked with h/j/k/l keeps the focus; with no move the element focused before entry gets it back, unless a
    // swap remounted it (it left the DOM): then the zone does.
    leave: () => (
      pane && (pane !== paneStart.current || before.current?.isConnected === false) ? ((before.current = null), focusZone(pane)) : fromSink(), setPane(null), setPaneNote('')
    ),
  };
  return { focusedZone, paneApi };
}
