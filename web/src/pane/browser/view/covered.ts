// F21: the native browser view is a child above all page content, so no z-index can cover it and it swallows the clicks over
// its rectangle. This is the one place that decides when it must step aside: hit-test the slot the way a click would, so
// anything that takes clicks above it (modal, top-layer dialog, popover, menu, one added later) counts without being listed.
// A modal counts even away from the slot: a press on the native page never reaches the window, so it could not be dismissed.
import { useEffect, useState, type RefObject } from 'react';

// ponytail: an overlay narrower than STEP that crosses no sample stays under the view; lower STEP if one ever ships.
const STEP = 48;
const INSET = 8; // off the edge: a neighbour's splitter handle straddling the slot's border is not an overlay
const GAP = 100; // ms between sweeps: an agent streaming beside the pane mutates the DOM every frame, a sweep is ~200 hit tests
// Only what can put an element on screen or stack it; `data-*`, `aria-*` churn and text never can.
const ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'popover', 'inert', 'aria-modal'];
// A toast comes and goes on its own and asks for nothing: hiding the page for its lifetime reads as the page blinking.
const PASSING = '.toast, .wtoast, .prefix-armed';

const samples = (from: number, to: number) => {
  const out = [];
  for (let at = from + INSET; at < to - INSET; at += STEP) out.push(at);
  return [...out, to - INSET];
};

/** Whether something that takes clicks sits over the slot now; synchronous, for a view about to be shown. */
export function isCovered(slot: HTMLElement) {
  if ([...document.querySelectorAll('[aria-modal="true"]')].some((m) => m.checkVisibility())) return true;
  const r = slot.getBoundingClientRect();
  if (r.width <= INSET * 2 || r.height <= INSET * 2) return false;
  // Hint labels take no clicks, so the grid cannot see them, but they exist to be read.
  const over = (e: Element) => {
    const b = e.getBoundingClientRect();
    return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
  };
  if ([...document.querySelectorAll('.hints-layer .hint')].some(over)) return true;
  const ys = samples(r.top, r.bottom);
  return samples(r.left, r.right).some((x) =>
    ys.some((y) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && !slot.contains(hit) && !hit.closest(PASSING);
    }),
  );
}

/** True while something that takes clicks sits over the slot. Measures at once when `on` turns true, then at most every GAP ms. */
export function useCovered(slot: RefObject<HTMLElement | null>, on: boolean) {
  const [is, set] = useState(false);
  useEffect(() => {
    if (!on) return void set(false);
    let frame = 0;
    let timer = 0;
    let last = 0;
    const measure = () => {
      frame = 0;
      last = performance.now();
      if (slot.current) set(isCovered(slot.current));
    };
    // The first change after a quiet spell is answered on the next frame; a stream of them waits out the gap.
    const check = () => {
      if (frame || timer) return;
      const wait = last + GAP - performance.now();
      if (wait <= 0) frame = requestAnimationFrame(measure);
      else
        timer = window.setTimeout(() => {
          timer = 0;
          frame = requestAnimationFrame(measure);
        }, wait);
    };
    const dom = new MutationObserver(check);
    dom.observe(document.documentElement, { subtree: true, childList: true, attributeFilter: ATTRIBUTES });
    // What changes the stack without touching the DOM: a popover opening, an overlay sliding in, the window resizing.
    const events = ['toggle', 'transitionend', 'animationend', 'resize'];
    events.forEach((e) => window.addEventListener(e, check, true));
    measure();
    return () => {
      dom.disconnect();
      events.forEach((e) => window.removeEventListener(e, check, true));
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [slot, on]);
  return is;
}
