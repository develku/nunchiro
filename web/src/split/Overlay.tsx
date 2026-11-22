// PEEKSPLIT: outside edit mode, a bar icon dragged over the session view shows the drop overlay (frame-ko-e `#dov`): the
// half nearest the pointer, with its caption. A release there opens the widget in a split on that side; Escape cancels and a
// release anywhere else changes nothing (over a bar it says how to move icons: that still needs Layout, A09). The session
// view is a drop target of the A36 list (bars.ts TARGETS), answering only these drags.
import { useLayoutEffect, useState, type CSSProperties } from 'react';
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

export const CAPTION: Record<Dir, Key> = { right: 'rest.st.splitRight', left: 'rest.st.splitLeft', up: 'rest.st.splitUp', down: 'rest.st.splitDown' };
const HALF: Record<Dir, CSSProperties> = {
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
  const t = useHtmlLangT();
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
  if (!hit) return null;
  const { box } = hit;
  return (
    <div className="dov" data-split-overlay style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <div className="half" data-side={hit.side} style={HALF[hit.side]}>
        {t(CAPTION[hit.side])}
      </div>
      <div className="cap" role="status">
        {t('rest.st.tempCaption')}
      </div>
    </div>
  );
}
