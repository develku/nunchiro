// V2.5-61 (ticket 220 B9, ticket 194): the tree's arrow keys. `navMove` is the pure part (visible rows in, a move out);
// `treeRows` reads those rows from the drawn tree, so whatever is drawn (folds, held rows, waiting rows under a folded
// head) is what the keys walk. Idea: Orca's keyboard tree (no file lifted).

/** One visible row: its depth, and whether it is open (`undefined`: a leaf, nothing to fold). */
export type NavRow = { level: number; open?: boolean };
export type NavMove = { focus: number } | { toggle: number } | null;

const MOVES = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
/** What the tree does with a key: `move` (navMove takes it), `enter` (folds a project head), or `null` (not ours). */
export const navKey = (key: string): 'move' | 'enter' | null => (key === 'Enter' ? 'enter' : MOVES.includes(key) ? 'move' : null);

/** The move a key makes from row `at`; `null` for a key the tree does not take (typing included) or no move. */
export function navMove(rows: readonly NavRow[], at: number, key: string): NavMove {
  const row = rows[at];
  if (!row) return null;
  const focus = (i: number) => (i >= 0 && i < rows.length && i !== at ? { focus: i } : null);
  switch (key) {
    case 'ArrowDown':
      return focus(at + 1);
    case 'ArrowUp':
      return focus(at - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(rows.length - 1);
    case 'ArrowRight':
      if (row.open === false) return { toggle: at };
      return row.open && (rows[at + 1]?.level ?? -1) > row.level ? { focus: at + 1 } : null;
    case 'ArrowLeft': {
      if (row.open) return { toggle: at };
      for (let i = at - 1; i >= 0; i--) if (rows[i].level < row.level) return { focus: i };
      return null;
    }
    default:
      return null;
  }
}

/** The row elements, one per drawn row: the element that takes focus. */
export const ROW = [
  '.ghead > button.n', // group head
  'button.row.quiet', // ticket 392's past conversations
  'button.row.pitem', // ticket 392: a past conversation, or its "n more"
  '.row.head > button.n', // project head
  'button.row.wt2', // worktree or session row (the clean-up fold's rows too)
  '.q[tabindex]', // a decision line under a project head
  '.row.kid', // a sub-agent row
  'details.cleanup > summary', // "Ready to clean up"
  'button.more', // "+N"
  '.vt', // a sub-view toggle
].join(', ');

const isHead = (el: Element) => el.matches('.ghead > button.n, .row.head > button.n');

function level(el: Element, nav: Element): number {
  if (el.matches('.row.kid')) {
    // A session's children follow its row (or the project head, for a main-folder session's): one step in, then their depth.
    const box = el.closest('.kids');
    let prev = box?.previousElementSibling;
    while (prev?.matches('.kids')) prev = prev.previousElementSibling;
    // ponytail: the owner is the row drawn just before; a main-folder session's children after a waiting row read as that row's.
    const owner = prev?.matches('.wtwrap, .sess:not(.hl)') ? prev.querySelector('button.row.wt2') : box?.closest('.grp')?.querySelector(':scope > .row.head > button.n');
    return (owner ? level(owner, nav) : 0) + 1 + Number((el as HTMLElement).dataset.depth ?? 0);
  }
  let n = isHead(el) ? -1 : 0; // a head stands for its own container
  for (let a = el.parentElement; a && a !== nav; a = a.parentElement) {
    if (a.matches('.pgrp')) n++;
    if (a.matches('details.cleanup') && !el.matches('summary')) n++;
    if (a.matches('.grp')) n += Number(!!a.querySelector(':scope > .row.head'));
    if (a.matches('.pastlist')) n++; // ticket 392: under its past-conversations row
  }
  return n;
}

/** The control that folds or unfolds the row, and whether it is open now; none for a leaf. */
export function foldOf(el: Element): { open: boolean; toggle: () => void } | undefined {
  const click = (b: Element | null | undefined) => () => (b as HTMLElement | null | undefined)?.click();
  if (el.matches('.ghead > button.n')) return { open: !el.closest('.pgrp')?.hasAttribute('data-folded'), toggle: click(el) };
  if (el.matches('button.row.quiet')) return { open: el.getAttribute('aria-expanded') === 'true', toggle: click(el) };
  if (el.matches('.row.head > button.n')) {
    const chev = el.parentElement?.querySelector(':scope > .chev');
    return chev ? { open: chev.getAttribute('aria-expanded') === 'true', toggle: click(chev) } : undefined;
  }
  if (el.matches('summary')) return { open: (el.parentElement as HTMLDetailsElement).open, toggle: click(el) };
  if (el.matches('button.row.wt2')) {
    const kids = el.closest('.wtwrap')?.querySelector(':scope > .kidcount');
    return kids ? { open: kids.getAttribute('aria-expanded') === 'true', toggle: click(kids) } : undefined;
  }
  return undefined;
}

/** Roving tabindex: `active` (else the current session's row, else the first) is the one row in the Tab order. */
export function rove(nav: Element, active: Element | null): Element | null {
  const all = [...nav.querySelectorAll<HTMLElement>(ROW)];
  const on = (active && all.includes(active as HTMLElement) ? active : null) ?? all.find((e) => e.getAttribute('aria-current') === 'true') ?? all[0] ?? null;
  for (const e of all) {
    const want = e === on ? '0' : '-1';
    if (e.getAttribute('tabindex') !== want) e.setAttribute('tabindex', want);
  }
  return on;
}

/** Every drawn row element in order, and the visible ones with their depth and fold. */
export function treeRows(nav: Element) {
  const all = [...nav.querySelectorAll<HTMLElement>(ROW)];
  const els = all.filter((e) => e.getClientRects().length > 0); // a closed fold's rows have no box
  return { all, els, rows: els.map((e): NavRow => ({ level: level(e, nav), open: foldOf(e)?.open })) };
}
