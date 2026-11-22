// Card drag with native pointer events, like 07b's drag layer (no drag library). The drop index uses bb's
// drop-position maths over the card centres of the column under the pointer; release outside a column cancels.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { dropIndexForPointer } from './drop';
import { keyOf, type Card } from './model';

type Target = { column: string; lane: string; index: number; line: { x: number; y: number; w: number } };
type Drag = { card: Card; x0: number; y0: number; x: number; y: number; on: boolean; target: Target | null };

function targetAt(root: HTMLElement, x: number, y: number, key: string): Target | null {
  const col = document.elementFromPoint(x, y)?.closest<HTMLElement>('.bcell[data-column]');
  if (!col || !root.contains(col)) return null;
  const list = col.querySelector<HTMLElement>('.bcards')!.getBoundingClientRect();
  const boxes = [...col.querySelectorAll<HTMLElement>('[data-card]')].filter((el) => el.dataset.card !== key).map((el) => el.getBoundingClientRect());
  const index = dropIndexForPointer(
    boxes.map((r) => r.top + r.height / 2),
    y,
  );
  const lineY = index < boxes.length ? boxes[index].top - 2 : boxes.length ? boxes[boxes.length - 1].bottom + 2 : list.top + 4;
  return { column: col.dataset.column!, lane: col.dataset.lane ?? '', index, line: { x: list.left + 4, y: Math.max(list.top, Math.min(lineY, list.bottom)), w: list.width - 8 } };
}

export function useCardDrag(root: RefObject<HTMLElement | null>, place: (card: Card, column: string, index: number, lane: string) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const moved = useRef(false);
  const placeRef = useRef(place);
  placeRef.current = place;

  const ref = useRef<Drag | null>(null);
  const set = (d: Drag | null) => ((ref.current = d), setDrag(d));

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = ref.current;
      if (!d || !root.current) return;
      const on = d.on || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4;
      set({ ...d, on, x: e.clientX, y: e.clientY, target: on ? targetAt(root.current, e.clientX, e.clientY, keyOf(d.card)) : null });
    };
    const up = (e: PointerEvent) => {
      const d = ref.current;
      set(null);
      if (!d?.on || !root.current) return;
      moved.current = true;
      const t = targetAt(root.current, e.clientX, e.clientY, keyOf(d.card));
      if (t) placeRef.current(d.card, t.column, t.index, t.lane);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), set(null));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    const cancel = () => set(null);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
  }, [drag !== null, root]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    key: drag?.on ? keyOf(drag.card) : null,
    start(e: ReactPointerEvent, card: Card) {
      if (e.button !== 0) return;
      moved.current = false;
      set({ card, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, target: null });
    },
    /** True once after a drag, so the release does not also open the card. */
    consumeClick() {
      const m = moved.current;
      moved.current = false;
      return m;
    },
    layer: drag?.on ? (
      <div className="bdrag" aria-hidden>
        <div className="bghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {drag.card.title}
        </div>
        {drag.target && <div className="bline" style={{ left: drag.target.line.x, top: drag.target.line.y, width: drag.target.line.w }} />}
      </div>
    ) : null,
  };
}
