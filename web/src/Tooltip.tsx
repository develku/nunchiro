// V1A-65 (needs 72): the app's one tooltip, replacing native `title` (about 1 s in WKWebView, plain) where applied.
// Targets opt in by attribute, so no element needs a wrapper:
//   data-tip="Files"            the name (a row's full name or path)
//   data-tip-cmd="files.show"   its command: the binding is added here, from the live bindings (V1A-57 item 7)
//   data-tip-clip               a row: shown only while its text is cut off (scrollWidth > clientWidth)
//   data-tip-below              a short word, not an icon: the tooltip goes below it, not beside it
// Shows after HOVER_MS on hover, at once on keyboard focus; moving to the next target while one shows (or just
// showed) skips the delay. Esc hides it and is consumed only then.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tip, type Bindings } from './keys';

export const HOVER_MS = 300;
const ID = 'app-tip';
const GAP = 6;

type Shown = { el: HTMLElement; text: string };

// A name clamped to one line at a word (`.wordcut`, look 1117 v11 A6) overflows downwards, not sideways.
export const isCut = (e: Element | null | undefined) => !!e && (e.scrollWidth > e.clientWidth || (e.scrollHeight > e.clientHeight + 1 && e.classList.contains('wordcut')));
const clipped = (el: HTMLElement) => [el, ...el.querySelectorAll<HTMLElement>(':not(.sr)')].some(isCut); // .sr: screen-reader text is never cut on screen

const textOf = (el: HTMLElement, bindings: Bindings) => {
  const name = el.dataset.tip;
  if (!name || (el.hasAttribute('data-tip-clip') && !clipped(el))) return null;
  return el.dataset.tipCmd ? tip(name, el.dataset.tipCmd, bindings) : name;
};

export function Tooltip({ bindings }: { bindings: Bindings }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ bindings, shown, timer: 0, hidAt: -Infinity, pressed: null as HTMLElement | null });
  live.current.bindings = bindings;
  live.current.shown = shown;

  useEffect(() => {
    const st = live.current;
    const show = (el: HTMLElement) => {
      clearTimeout(st.timer);
      const text = textOf(el, st.bindings);
      if (text) setShown({ el, text });
      else hide();
    };
    const hide = () => {
      clearTimeout(st.timer);
      if (st.shown) st.hidAt = performance.now();
      setShown(null);
    };
    const target = (e: Event) => (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    const over = (e: PointerEvent) => {
      if (st.shown && !st.shown.el.isConnected) hide(); // its target went away (a tab closed, a row recycled)
      const el = target(e);
      // A clicked target stays quiet until the pointer leaves it (its icon swapping under the pointer fires pointerover again).
      if (!el || el === st.shown?.el || el === st.pressed) return;
      clearTimeout(st.timer);
      // Warm: one shows, or one hid a moment ago (pointerout comes first when moving between neighbours).
      if (st.shown || performance.now() - st.hidAt < HOVER_MS) show(el);
      else st.timer = window.setTimeout(() => el.isConnected && show(el), HOVER_MS);
    };
    const out = (e: PointerEvent) => {
      const el = target(e);
      if (!el || el.contains(e.relatedTarget as Node | null)) return;
      if (st.pressed === el) st.pressed = null;
      if (st.shown?.el === el || !st.shown) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = target(e);
      if (el && el === e.target && el.matches(':focus-visible')) show(el);
    };
    const blur = (e: FocusEvent) => st.shown?.el === e.target && hide();
    const key = (e: KeyboardEvent) => {
      // A hover still waiting out its delay ends too: it would show over what the keys open (the palette) and take its Esc.
      if (!st.shown) return void clearTimeout(st.timer);
      // Typing means reading is over: any other key hides it and goes on, so a later Esc is never taken.
      // v25f: so does a tooltip left on something behind the modal; that Esc is the modal's to close.
      // Ticket 1015: the "+" popover is such a layer too: a strip tooltip (shown while it is open) does not keep it open.
      const modal = document.querySelector('.newtab') ?? document.querySelector('.ovl-panel');
      if (e.key !== 'Escape' || !st.shown.el.isConnected || (modal && !modal.contains(st.shown.el))) return hide();
      e.preventDefault();
      e.stopImmediatePropagation();
      hide();
    };
    // A click, or a scroll that moves the target, ends it (terminal output scrolling elsewhere does not).
    const down = (e: PointerEvent) => {
      st.pressed = target(e);
      // A click before the hover delay ran out: the pending tip showed over what the click opened and took its Esc.
      clearTimeout(st.timer);
      if (st.shown) hide();
    };
    // A scroll is not "one just hid": WebKit sends the pointer over the row that scrolled under it, and that row (and
    // each next one while the list moves) showed its tooltip at once. After a scroll the delay starts again.
    const scroll = (e: Event) => st.shown && (e.target as Node).contains?.(st.shown.el) && (hide(), (st.hidAt = -Infinity));
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('scroll', scroll, true);
    // Capture on window: it runs before every other Esc handler, which then never sees the Esc it consumed.
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(st.timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);

  // Look 1117 v5 (A S3-4): a target that leaves the page with keyboard focus fires no event in WebKit ("Close split" kept
  // its tooltip): while one shows, a change in the page that took its target away hides it.
  // Eighth look (B S2-2): the text was read once, at show: the Team icon kept "1 needs you" under a resting pointer
  // after its badge went. While one shows it follows its target's `data-tip`.
  useEffect(() => {
    if (!shown) return;
    const mo = new MutationObserver(() => {
      if (!shown.el.isConnected) return setShown(null);
      const text = textOf(shown.el, live.current.bindings);
      // Only while it still shows: a scroll hides it and recycles the row under it in the same moment, and the new
      // row's text must not bring it back.
      if (text !== shown.text) setShown((now) => (now?.el !== shown.el ? now : text ? { el: shown.el, text } : null));
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip'] });
    return () => mo.disconnect();
  }, [shown]);

  // aria-describedby while it shows (a target's own value comes back after), unless its label already says the same (a
  // Search hit's label holds its whole line): read once. Then place it beside or below the target, before paint so it
  // never shows at its last spot.
  useLayoutEffect(() => {
    if (!shown) return;
    const { el, text } = shown;
    const before = el.getAttribute('aria-describedby');
    const said = (el.getAttribute('aria-label') ?? el.textContent ?? '').includes(text);
    if (!said) el.setAttribute('aria-describedby', before ? `${before} ${ID}` : ID);
    const t = box.current!;
    // Reset first: a box left near an edge last time measures squeezed (fixed position wraps it).
    t.style.left = '0px';
    t.style.top = '0px';
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const clamp = (v: number, max: number) => Math.max(GAP, Math.min(v, max - GAP));
    let x: number;
    let y: number;
    if (r.width < 60 && !el.hasAttribute('data-tip-below')) {
      // An icon: beside it, toward the window's middle. A short word that says so (`data-tip-below`: a schedule row's
      // name) is no icon: its tooltip goes below, off the text beside it (eighth look, Home).
      x = r.right + GAP + w <= vw ? r.right + GAP : r.left - GAP - w;
      y = r.top + r.height / 2 - h / 2;
    } else {
      x = r.left;
      y = r.bottom + GAP + h <= vh ? r.bottom + GAP : r.top - GAP - h;
    }
    t.style.left = `${clamp(x, vw - w)}px`;
    t.style.top = `${clamp(y, vh - h)}px`;
    return () => {
      if (before) el.setAttribute('aria-describedby', before);
      else el.removeAttribute('aria-describedby');
    };
  }, [shown]);

  return (
    <div ref={box} id={ID} className="apptip" role="tooltip" hidden={!shown}>
      {shown?.text}
    </div>
  );
}
