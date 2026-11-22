// TREEHEAD-FREEZE (owner 2026-11-02, tree4 r3): while the pointer is on a project head, or focus is inside it, arrivals do not reflow
// that head. Its counts and "new N" chip draw as they did when the hold began; the live values apply when the pointer and focus have
// both left. The head's live region keeps the real text, so an arrival is still announced at once.
//
// r4: the hold belongs to the mounted head. A head that is removed (its project changed section and is drawn anew) sends no
// pointerleave or blur, so the hold is released by the head's ref callback when it unmounts, not by an event. The map is only
// written from event handlers and that callback, never during render, so a double render (StrictMode) reads the same thing twice.
import { useReducer, useRef, type FocusEvent, type PointerEventHandler, type RefCallback } from 'react';
import type { Session } from '../types';

/** `strip`: the sessions the head's colour strip draws (ticket 388), held like the counts so no bar moves under the pointer. */
export type HeadCounts = { waiting: number; failed: number; fresh: number; strip?: Session[] };
type Hold = { snap: HeadCounts; ptr: boolean; foc: boolean };

/** The one ref callback of a project. On unmount it releases the hold and drops its own map entry (never a successor's). */
export function headRefOf(
  project: string,
  refs: Map<string, RefCallback<HTMLElement>>,
  release: (project: string) => void,
): RefCallback<HTMLElement> {
  let f = refs.get(project);
  if (!f) {
    const mine: RefCallback<HTMLElement> = (el) => {
      if (el !== null) return;
      release(project);
      if (refs.get(project) === mine) refs.delete(project);
    };
    refs.set(project, (f = mine));
  }
  return f;
}

export function useHeadHold() {
  const holds = useRef(new Map<string, Hold>());
  const refs = useRef(new Map<string, RefCallback<HTMLElement>>());
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const release = (project: string) => {
    if (holds.current.delete(project)) redraw(); // the live values apply
  };
  const set = (project: string, by: 'ptr' | 'foc', on: boolean, now: HeadCounts) => {
    const cur = holds.current.get(project);
    const next: Hold = { snap: cur?.snap ?? now, ptr: cur?.ptr ?? false, foc: cur?.foc ?? false, [by]: on };
    if (next.ptr || next.foc) holds.current.set(project, next);
    else release(project);
  };
  // One callback per project, so React calls it on mount and unmount only (a new function each render would be called every render).
  const refOf = (project: string) => headRefOf(project, refs.current, release);
  return {
    /** The counts to draw: the held ones, or the live ones. */
    shown: (project: string, live: HeadCounts): HeadCounts => holds.current.get(project)?.snap ?? live,
    /** Handlers and ref for the head row; `now` is what the head draws at this render (the snapshot when the hold starts). */
    bind: (project: string, now: HeadCounts) => ({
      ref: refOf(project),
      onPointerEnter: (() => set(project, 'ptr', true, now)) as PointerEventHandler,
      onPointerLeave: (() => set(project, 'ptr', false, now)) as PointerEventHandler,
      onFocus: () => set(project, 'foc', true, now),
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set(project, 'foc', false, now);
      },
    }),
  };
}
