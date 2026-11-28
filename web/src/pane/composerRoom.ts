// Ticket 991 C12 (5), 1062, 1093: the window's composer sits in a row under the centre. Every host of a view beside the chat
// (the side pane, and a Preview in a session split, a layout zone, a sidebar or the dock) registers here, and the part of the
// composer under any of them is kept clear (its padding: `--pane-room` right, `--pane-room-left` left), so the composer card
// stays in the chat column. One rule for every host: the room on a side is the widest any host needs.

type Box = { left: number; right: number };
/** The card's floor: below it the composer is not usable, so the room gives way (the right side first) and the card
 *  reaches under a pane instead. The composer row sits under the panes, so nothing covers it. Orca keeps its main area
 *  320 px; the card is that less the composer's own 20 px each side (chat.css). */
export const MIN_CARD = 280;
const PAD = 40;
/** The room each side of composer box `c` needs: the card takes the widest stretch of the composer that no host covers
 *  (the chat column), so two panes right of the chat (a Preview and a Diff split) both count on the right. A host as wide
 *  as the composer or wider (a split below the chat) takes none. Until the card has MIN_CARD, the room gives way. */
export function room(c: Box, hosts: Box[]): { left: number; right: number } {
  const cuts = hosts
    .filter((h) => !(h.left <= c.left && h.right >= c.right))
    .map((h) => [Math.max(h.left, c.left), Math.min(h.right, c.right)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let [best, at] = [[c.left, c.left], c.left];
  for (const [a, b] of [...cuts, [c.right, c.right]]) {
    if (a - at > best[1] - best[0]) best = [at, a];
    at = Math.max(at, b);
  }
  let [left, right] = [Math.round(best[0] - c.left), Math.round(c.right - best[1])];
  const short = MIN_CARD - (c.right - c.left - PAD - left - right);
  if (short > 0) {
    const r = Math.max(0, right - short);
    left = Math.max(0, left - (short - (right - r)));
    right = r;
  }
  return { left, right };
}

const hosts = new Set<Element>();
let watch: ResizeObserver | null = null;
let frame = 0;
const composerEl = () => document.querySelector('.composer:not([data-pinned])');

function fit() {
  const root = document.documentElement;
  // The composer's border box: the padding set here changes only its content box, so the measure does not feed back.
  const c = composerEl()?.getBoundingClientRect();
  const boxes = [...hosts].filter((h) => !h.hasAttribute('data-max')).map((h) => h.getBoundingClientRect()).filter((b) => b.width > 0); // a hidden zone tab is 0 wide
  const r = c ? room(c, boxes) : { left: 0, right: 0 };
  root.style.setProperty('--pane-room', `${r.right}px`);
  root.style.setProperty('--pane-room-left', `${r.left}px`);
  root.style.setProperty('--pane-over', `${r.right}px`); // ticket 1030: the card floating above the composer stays out of the host
  root.toggleAttribute('data-pane-room', r.left + r.right > 0); // the chips row stays one line only while the card is cut (chat.css)
}

/** Keeps the composer clear of `el` until the returned function runs. */
export function keepComposerClear(el: Element): () => void {
  hosts.add(el);
  // A frame later: `data-pane-room` can change the composer's height, which inside the callback is WebKit's
  // "ResizeObserver loop" page error.
  watch ??= new ResizeObserver(() => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(fit))));
  watch.observe(el);
  const composer = composerEl();
  if (composer) watch.observe(composer, { box: 'border-box' }); // a zone or window change that leaves the hosts alone
  fit();
  return () => {
    hosts.delete(el);
    watch?.unobserve(el);
    if (hosts.size) return fit();
    watch?.disconnect();
    watch = null;
    cancelAnimationFrame(frame);
    const root = document.documentElement;
    for (const p of ['--pane-room', '--pane-room-left', '--pane-over']) root.style.removeProperty(p);
    root.removeAttribute('data-pane-room');
  };
}
