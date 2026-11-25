// PEEKSPLIT: outside edit mode, a bar icon dragged over the session view shows the drop overlay (frame-ko-e `#dov`): the
// half nearest the pointer, with its caption. A release there opens the widget in a split on that side; Escape cancels and a
// release anywhere else changes nothing (over a bar it says how to move icons: that still needs Layout, A09). The session
// view is a drop target of the A36 list (bars.ts TARGETS), answering only these drags.
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { splitSessions } from './store';
import { TARGETS, targetAt } from '../layout/bars';
import type { Key } from '../i18n';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import type { Dir } from '../layout/model';

/** The nearest edge of `r` to the point (frame-ko-e `ovSide`). */
export function nearest(r: { left: number; top: number; width: number; height: number }, x: number, y: number): Dir {
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  return ([['left', fx], ['right', 1 - fx], ['up', fy], ['down', 1 - fy]] as [Dir, number][]).sort((a, b) => a[1] - b[1])[0][0];
}
TARGETS.push((x, y, d) => {
  if (!d.peek) return null;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-split-host][data-session]');
  return el ? { kind: 'split', side: nearest(el.getBoundingClientRect(), x, y), el } : null;
});

/** Ticket 1069: where a tab dragged from the strip lands: an existing split it replaces, or an edge of the session view.
 *  Ticket 1093: over the dragged tab's own view, or a view that shows no session (Room, Schedules), `fallback` hosts the
 *  split (the next session tab); with none the drop is refused. None anywhere else; a session already in a split never lands. */
export type TabHit = { host: string; box: DOMRect } & ({ side: Dir } | { side: 'replace'; split: string });
export function tabHit(x: number, y: number, tab: string, fallback: string | null): TabHit | { box: DOMRect; refused: true } | null {
  const at = document.elementFromPoint(x, y);
  const el = at?.closest<HTMLElement>('[data-split-host]');
  if (!el || splitSessions().includes(tab)) return null;
  const own = el.dataset.session;
  const host = own && own !== tab ? own : fallback;
  const box = el.getBoundingClientRect();
  if (!host) return { box, refused: true };
  const sp = own === host ? at!.closest<HTMLElement>('[data-split-id]') : null; // the shown tab's own splits leave with its view
  if (sp?.dataset.splitId) return { host, box: sp.getBoundingClientRect(), side: 'replace', split: sp.dataset.splitId };
  return { host, box, side: nearest(box, x, y) };
}

export const CAPTION: Record<Dir, Key> = { right: 'rest.st.splitRight', left: 'rest.st.splitLeft', up: 'rest.st.splitUp', down: 'rest.st.splitDown' };
const HALF: Record<Dir | 'replace', CSSProperties> = {
  replace: { left: 8, right: 8, top: 8, bottom: 8 },
  left: { left: 8, top: 8, bottom: 8, width: 'calc(50% - 12px)' },
  right: { right: 8, top: 8, bottom: 8, width: 'calc(50% - 12px)' },
  up: { left: 8, right: 8, top: 8, height: 'calc(50% - 12px)' },
  down: { left: 8, right: 8, bottom: 8, height: 'calc(50% - 12px)' },
};

interface Props {
  widget: string;
  onDrop: (side: Dir) => void;
  /** Released on a bar: moving icons still needs Layout. */
  onBar: () => void;
  onEnd: () => void;
}

export function Overlay({ widget, onDrop, onBar, onEnd }: Props) {
  const [hit, setHit] = useState<{ side: Dir; box: DOMRect } | null>(null);
  // Listening starts before the next pointer event, so a quick drag and release is not lost.
  useLayoutEffect(() => {
    const at = (e: PointerEvent) => targetAt(e.clientX, e.clientY, { w: widget, fromBar: true, peek: true });
    const move = (e: PointerEvent) => {
      const t = at(e);
      setHit(t?.kind === 'split' ? { side: t.side, box: t.el.getBoundingClientRect() } : null);
    };
    const up = (e: PointerEvent) => {
      const t = at(e);
      if (t?.kind === 'split') onDrop(t.side);
      else if (t?.kind === 'bar') onBar();
      onEnd();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onEnd());
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
  }, [widget, onDrop, onBar, onEnd]);
  return hit && <Preview box={hit.box} side={hit.side} />;
}

/** The drop preview over `box`: the half a release fills, or the whole split a release replaces (ticket 1069); or, ticket
 *  1093, only the caption saying why a release here does nothing. */
export function Preview({ box, side, refused }: { box: DOMRect; side?: Dir | 'replace'; refused?: Key }) {
  const t = useHtmlLangT();
  return (
    <div className="dov" data-split-overlay data-refused={refused ? '' : undefined} style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {side && (
        <div className="half" data-side={side} style={HALF[side]}>
          {t(side === 'replace' ? 'rest.st.splitReplace' : CAPTION[side])}
        </div>
      )}
      <div className="cap" role="status">
        {t(refused ?? 'rest.st.tempCaption')}
      </div>
    </div>
  );
}
