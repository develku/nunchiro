// Ticket 991 C12 (5), 1062, 1093: the window's composer sits in a row under the centre. Every host of a view beside the chat
// (the side pane, and a Preview in a session split, a layout zone, a sidebar or the dock) registers here, and the part of the
// composer under any of them is kept clear (its padding: `--pane-room` right, `--pane-room-left` left), so the composer card
// stays in the chat column. One rule for every host: the room on a side is the widest any host needs.

type Box = { left: number; right: number };
/** The room each side of composer box `c` needs. A host right of the composer's middle takes the part right of its left edge,
 *  one left of it the part left of its right edge (one side each: a right pane ending inside the composer is not also a left
 *  host, which grew the composer in a loop). A host as wide as the composer or wider (a split below the chat) takes none. */
export function room(c: Box, hosts: Box[]): { left: number; right: number } {
  let [left, right] = [0, 0];
  for (const h of hosts) {
    if (h.left <= c.left && h.right >= c.right) continue;
    if (h.left + h.right >= c.left + c.right) right = Math.max(right, Math.round(c.right - h.left));
    else left = Math.max(left, Math.round(h.right - c.left));
  }
  return { left, right };
}

const hosts = new Set<Element>();
let watch: ResizeObserver | null = null;
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
  watch ??= new ResizeObserver(fit);
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
    const root = document.documentElement;
    for (const p of ['--pane-room', '--pane-room-left', '--pane-over']) root.style.removeProperty(p);
    root.removeAttribute('data-pane-room');
  };
}
