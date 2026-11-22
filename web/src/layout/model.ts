// Layout model (needs 35, 37, 39): a tree of zones that splits freely like tmux, minimum sizes only. The same
// shape is `~/.nunchiro/layout.toml` (the core validates and writes it: crates/nunchiro-core/src/http/layout.rs).
// A widget is "kind" or "kind@session" (pinned); unpinned widgets follow the focused session.

import { ENTRIES, type Kind } from './registry'; // v1b-28: the kinds, titles and minimum sizes are registry entries

export type { Kind };
export const WIDGETS: readonly Kind[] = ENTRIES.map((e) => e.kind);
export type Item = string;
export type Dir = 'up' | 'down' | 'left' | 'right';
export const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

export interface Leaf {
  id: string;
  /** Pixels along the parent split's axis; absent = share the rest. */
  size?: number;
  widgets: Item[];
  active?: number;
}
export interface Split {
  id: string;
  size?: number;
  split: 'row' | 'column';
  children: Node[];
}
export type Node = Leaf | Split;
export interface Layout {
  version: 1;
  root: Node;
}

// v1b-19: user widgets are `widget:<name>` (a folder under ~/.nunchiro/widgets/), named by syntax only, so a layout
// naming a missing one still loads and shows a placeholder. They share one title rule and one minimum size.
export const isUserKind = (k: string) => /^widget:[a-z0-9][a-z0-9_-]{0,63}$/.test(k);
const withUser = <T,>(base: Record<Kind, T>, user: (k: string) => T) =>
  new Proxy(base, { get: (t, k) => (typeof k === 'string' && isUserKind(k) ? user(k) : t[k as Kind]) });
/** V2.5-54 A12: the window's names for the widget kinds in the UI language. App sets it on every render; the pure specs
 *  never do, so TITLE and WIDGET_LABEL stay the registry's English there. */
let localName: (kind: string) => string | undefined = () => undefined;
export const setKindNames = (f: (kind: string) => string | undefined) => void (localName = f);
export const kindName = (kind: string) => localName(kind);
const ENGLISH = Object.fromEntries(ENTRIES.map((e) => [e.kind, e.title])) as Record<Kind, string>;
export const TITLE: Record<Kind, string> = new Proxy(ENGLISH, { get: (t, k) => (typeof k === 'string' ? (isUserKind(k) ? k.slice('widget:'.length) : (localName(k) ?? t[k as Kind])) : Reflect.get(t, k)) });
export const MIN: Record<Kind, { w: number; h: number }> = withUser(Object.fromEntries(ENTRIES.map((e) => [e.kind, e.min])) as Record<Kind, { w: number; h: number }>, () => ({ w: 200, h: 80 }));
// end v1b-19
/** Width or height of a zone added at a window edge. */
export const EDGE = { side: 264, band: 160 };
/** A zone added at a window edge, along `dir`: the Tree's column is 200 px wide as the approved placement frame draws it
 *  (needs 157 (2)); a width the user drags later is the zone's own size and stays. */
export const edgeSize = (widget: Item, dir: Dir) => (dir === 'left' || dir === 'right' ? (kindOf(widget) === 'tree' ? 200 : EDGE.side) : EDGE.band);

export const kindOf = (w: Item) => w.split('@')[0] as Kind;
export const pinOf = (w: Item): string | undefined => (w.includes('@') ? w.slice(w.indexOf('@') + 1) : undefined);
export const isLeaf = (n: Node): n is Leaf => 'widgets' in n;
export const isKind = (k: string): k is Kind => (WIDGETS as readonly string[]).includes(k) || isUserKind(k); // v1b-19: || isUserKind

/** LAYOUT D5b: main zones only. The tree and the other bar widgets live in the window shell (layout/bars.ts). No
 *  layout.toml means this one (the core's undo back to the start removes the file). */
export function defaultLayout(): Layout {
  return {
    version: 1,
    root: { id: 'centre', split: 'column', children: [{ id: 'terminal', widgets: ['terminal'] }, { id: 'composer', widgets: ['composer'] }] },
  };
}

export function leaves(n: Node): Leaf[] {
  return isLeaf(n) ? [n] : n.children.flatMap(leaves);
}
function nodes(n: Node): Node[] {
  return isLeaf(n) ? [n] : [n, ...n.children.flatMap(nodes)];
}
export function find(n: Node, id: string): Node | undefined {
  return nodes(n).find((x) => x.id === id);
}
function parentOf(root: Node, id: string): Split | undefined {
  return nodes(root).find((x): x is Split => !isLeaf(x) && x.children.some((c) => c.id === id));
}
export function minOf(n: Node): { w: number; h: number } {
  if (isLeaf(n)) return n.widgets.map((w) => MIN[kindOf(w)]).reduce((a, b) => ({ w: Math.max(a.w, b.w), h: Math.max(a.h, b.h) }), { w: 0, h: 0 });
  const kids = n.children.map(minOf);
  const along = n.split === 'row' ? 'w' : 'h';
  const across = along === 'w' ? 'h' : 'w';
  return { [along]: kids.reduce((s, k) => s + k[along], 0), [across]: Math.max(...kids.map((k) => k[across])) } as { w: number; h: number };
}
/** The zone commands act on when none is named: the first terminal, else the first zone. */
export function defaultZone(l: Layout): string {
  const all = leaves(l.root);
  return (all.find((z) => z.widgets.some((w) => kindOf(w) === 'terminal')) ?? all[0]).id;
}

/** V1A-60: terminal columns the main zone keeps; below it, side panels fold to their icon bar (view state only). */
export const MAIN_MIN_COLS = 80;
/** V1A-60: the side panels beside `zone` across the window: fixed-width siblings in the row splits on its path,
 *  outermost first. Zones that share the rest with it are the user's own split, not panels. Null when `zone` sits in
 *  a fixed-width zone itself (pane mode moved a terminal into a sidebar), as folding could not widen it. */
export function sidesOf(n: Node, zone: string): Node[] | null {
  const inner = isLeaf(n) ? undefined : n.children.find((c) => find(c, zone));
  if (isLeaf(n) || !inner) return [];
  const inside = sidesOf(inner, zone);
  if (inside === null || n.split !== 'row') return inside;
  if (inner.size !== undefined) return null;
  return [...n.children.filter((c) => c !== inner && c.size !== undefined), ...inside];
}

/** Zoom is view state (acceptance 14): which nodes to hide so `zone` fills the layout; the layout itself is untouched. */
export function zoomHidden(l: Layout, zone: string | null): (n: Node) => boolean {
  const here = zone ? find(l.root, zone) : undefined;
  if (!here) return () => false;
  const keep = new Set([...nodes(l.root).filter((x) => !isLeaf(x) && find(x, zone!)).map((x) => x.id), ...nodes(here).map((x) => x.id)]);
  return (n) => !keep.has(n.id);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** v1a-43: the zone nearest `from` in a direction (rects are on-screen boxes by zone id): it must overlap `from` across
 *  the other axis; the smallest gap wins, then the largest overlap. Null at the edge. */
export function nearestZone(rects: Record<string, Rect>, from: string, dir: Dir): string | null {
  const a = rects[from];
  if (!a) return null;
  const row = dir === 'left' || dir === 'right';
  const [p, ps, q, qs] = row ? (['x', 'w', 'y', 'h'] as const) : (['y', 'h', 'x', 'w'] as const);
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  let best: { id: string; gap: number; overlap: number } | null = null;
  for (const [id, r] of Object.entries(rects)) {
    const gap = sign > 0 ? r[p] - (a[p] + a[ps]) : a[p] - (r[p] + r[ps]);
    const overlap = Math.min(a[q] + a[qs], r[q] + r[qs]) - Math.max(a[q], r[q]);
    if (id === from || gap < -1 || overlap <= 0) continue;
    if (!best || gap < best.gap - 1 || (Math.abs(gap - best.gap) <= 1 && overlap > best.overlap)) best = { id, gap, overlap };
  }
  return best?.id ?? null;
}

/** v1a-43: one pane-mode resize step as a `resize` op, or null when the size would not change. One edge moves in
 *  the `dir` direction: the right (bottom) edge, or the left (top) one for the last child; the node is the zone, or the
 *  nearest ancestor whose parent splits along that direction. */
export function resizeStep(l: Layout, zone: string, dir: Dir, step: number, measure: Measure): Op | null {
  const along = axis(dir);
  let n = find(l.root, zone);
  let parent = n && parentOf(l.root, n.id);
  while (n && parent && parent.split !== along) [n, parent] = [parent, parentOf(l.root, parent.id)];
  if (!n || !parent) return null;
  const at = measure(n.id);
  if (!at) return null;
  const k = parent.split === 'row' ? 'w' : 'h';
  const i = parent.children.findIndex((c) => c.id === n!.id);
  // The key moves one edge: the right (bottom) one, or the left (top) one for the last zone, so l then h cancels.
  const last = i === parent.children.length - 1;
  const outward = (dir === 'right' || dir === 'down') !== last;
  // The zone that shares the rest keeps doing so: its neighbour across that edge takes the step, not a far sibling.
  const nb = parent.children[last ? i - 1 : i + 1];
  if (n.size === undefined && nb?.size !== undefined) {
    const nbAt = measure(nb.id);
    if (!nbAt) return null;
    let size = Math.max(minOf(nb)[k], Math.round(Math.min(nbAt[k] + (outward ? -step : step), nbAt[k] + Math.max(0, at[k] - minOf(n)[k]))));
    if (outward) size = Math.min(size, Math.round(nbAt[k])); // a neighbour already under its minimum is never grown by a shrink
    return size === Math.round(nbAt[k]) ? null : { op: 'resize', zone: nb.id, size };
  }
  // Growing takes room from the others in the split, which keep their minimums.
  const total = measure(parent.id)?.[k];
  const room = total === undefined ? Infinity : total - parent.children.reduce((sum, c) => (c.id === n!.id ? sum : sum + minOf(c)[k]), 0);
  // Siblings already below their minimum leave `room` under the current size: growing then stays put, never shrinks.
  const size = Math.max(minOf(n)[k], Math.round(Math.min(at[k] + (outward ? step : -step), outward ? Math.max(at[k], room) : Infinity)));
  return size === Math.round(at[k]) ? null : { op: 'resize', zone: n.id, size };
}

export type Op =
  | { op: 'split'; dir: Dir; widget: Item; zone?: string; size?: number }
  | { op: 'stack'; widget: Item; zone?: string }
  | { op: 'edge'; dir: Dir; widget: Item }
  | { op: 'add'; widget: Item }
  | { op: 'move'; from: string; tab?: number; to: { op: 'split'; dir: Dir; zone?: string } | { op: 'stack'; zone?: string } | { op: 'edge'; dir: Dir } }
  | { op: 'remove'; kind?: Kind; zone?: string; tab?: number }
  | { op: 'pin'; session: string; zone?: string; tab?: number }
  | { op: 'unpin'; zone?: string; tab?: number }
  | { op: 'resize'; zone: string; size: number }
  | { op: 'swap'; a: string; b: string } // v1a-43: pane mode exchanges two zones' widgets
  | { op: 'reset' }
  | { op: 'undo' };

/** Size of a zone on screen, when known (the window passes it; then split minimums are checked). */
export type Measure = (id: string) => { w: number; h: number } | undefined;

const axis = (d: Dir) => (d === 'left' || d === 'right' ? 'row' : 'column');
const clone = (l: Layout): Layout => structuredClone(l);

function freshId(root: Node, base: string): string {
  base = base.replace(/[^A-Za-z0-9-]/g, '-'); // v1b-19: `widget:my_tool` gets zone `widget-my-tool` (ids are letters, digits, '-')
  const taken = new Set(nodes(root).map((n) => n.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
function leafAt(root: Node, id: string | undefined, l: Layout): Leaf {
  const z = find(root, id ?? defaultZone(l));
  if (!z) throw new Error(`no zone "${id}"`);
  if (!isLeaf(z)) throw new Error(`"${id}" holds other zones; name one of its zones`);
  return z;
}
function replace(root: Node, id: string, next: Node): Node {
  if (root.id === id) return next;
  if (isLeaf(root)) return root;
  return { ...root, children: root.children.map((c) => replace(c, id, next)) };
}

function checkSplit(target: Leaf, dir: Dir, widget: Item, measure?: Measure) {
  const at = measure?.(target.id);
  if (!at) return;
  const along = axis(dir) === 'row' ? 'w' : 'h';
  const need = [minOf(target)[along], MIN[kindOf(widget)][along]];
  if (at[along] < need[0] + need[1])
    throw new Error(`too small: ${target.id} is ${Math.round(at[along])} px ${along === 'w' ? 'wide' : 'high'}; split ${dir} needs ${need[0]} + ${need[1]} px`);
}

function insertSplit(root: Node, target: Leaf, dir: Dir, widget: Item, size?: number): Node {
  const fresh: Leaf = { id: freshId(root, kindOf(widget)), widgets: [widget], ...(size ? { size } : {}) };
  const before = dir === 'left' || dir === 'up';
  const parent = parentOf(root, target.id);
  if (parent && parent.split === axis(dir) && target.size === undefined) {
    const children = [...parent.children];
    children.splice(children.findIndex((c) => c.id === target.id) + (before ? 0 : 1), 0, fresh);
    return replace(root, parent.id, { ...parent, children });
  }
  const { size: kept, ...inner } = target;
  const wrap: Split = { id: freshId(root, 'split'), split: axis(dir), children: before ? [fresh, inner] : [inner, fresh], ...(kept !== undefined ? { size: kept } : {}) };
  return replace(root, target.id, wrap);
}

function insertEdge(root: Node, dir: Dir, widget: Item): Node {
  const fresh: Leaf = { id: freshId(root, kindOf(widget)), widgets: [widget], size: edgeSize(widget, dir) };
  const before = dir === 'left' || dir === 'up';
  if (!isLeaf(root) && root.split === axis(dir)) return { ...root, children: before ? [fresh, ...root.children] : [...root.children, fresh] };
  const { size: _drop, ...inner } = root;
  return { id: freshId(root, 'split'), split: axis(dir), children: before ? [fresh, inner] : [inner, fresh] };
}

/** Removes one widget; empty zones go, and a split left with one child becomes that child. */
function take(root: Node, zone: Leaf, tab: number): Node | null {
  if (zone.widgets.length > 1) {
    const widgets = zone.widgets.filter((_, i) => i !== tab);
    // The tab that was showing stays showing; removing it shows the one before it.
    const was = zone.active ?? 0;
    const active = tab < was ? was - 1 : Math.min(was, widgets.length - 1);
    return replace(root, zone.id, { ...zone, widgets, active: active || undefined });
  }
  const parent = parentOf(root, zone.id);
  if (!parent) return null;
  const children = parent.children.filter((c) => c.id !== zone.id);
  if (children.length > 1) return replace(root, parent.id, { ...parent, children });
  // The survivor takes the split's place and size; its own size was along the split's axis.
  const { size: _old, ...only } = children[0];
  return replace(root, parent.id, parent.size === undefined ? only : { ...only, size: parent.size });
}

function tabOf(z: Leaf, tab?: number) {
  const i = tab === undefined ? z.active ?? 0 : tab - 1;
  if (i < 0 || i >= z.widgets.length) throw new Error(`zone ${z.id} has no tab ${tab}`);
  return i;
}

// No "keep one of tree, agents, answer strip" rule (needs 26, 31): the Tree is required and always in the window and shows
// waiting (D5b), so removing the last zone signal hides nothing. Coordinator decision 2026-11-02, A22 / needs 107.

/** v25f (D-20261108-10): the layout without the Board tabs of its centre zone (`defaultZone`), or null when it has none. The
 *  Board opens as a modal over the workspace now; a Board placed at an edge or in a sidebar stays where it is. */
export function dropCentreBoard(l: Layout): Layout | null {
  const z = find(l.root, defaultZone(l));
  if (!z || !isLeaf(z) || !z.widgets.some((w) => kindOf(w) === 'board')) return null;
  const widgets = z.widgets.filter((w) => kindOf(w) !== 'board');
  if (!widgets.length) return null; // a zone of Boards only is not the centre's terminal: leave it
  const was = z.widgets[z.active ?? 0];
  const active = kindOf(was ?? '') === 'board' ? Math.max(0, widgets.findIndex((w) => kindOf(w) === 'terminal')) : Math.max(0, widgets.indexOf(was));
  return { ...l, root: replace(l.root, z.id, { ...z, widgets, active }) };
}

/** Applies one layout action; throws with a message the command line and the CLI show as is. */
export function apply(prev: Layout, op: Op, measure?: Measure): Layout {
  const l = clone(prev);
  const widget = 'widget' in op ? op.widget : null;
  if (widget && !isKind(kindOf(widget))) throw new Error(`unknown widget "${kindOf(widget)}"; widgets: ${WIDGETS.join(', ')}`);
  // needs 157 (2): the Tree may sit in a zone, but the window has one (a move, never a copy); `move` takes it out first.
  if (widget && kindOf(widget) === 'tree' && leaves(l.root).some((z) => z.widgets.some((w) => kindOf(w) === 'tree'))) throw new Error('There is only one Tree: move it from where it is');
  switch (op.op) {
    case 'split': {
      const z = leafAt(l.root, op.zone, l);
      checkSplit(z, op.dir, op.widget, measure);
      l.root = insertSplit(l.root, z, op.dir, op.widget, op.size);
      break;
    }
    case 'stack': {
      const z = leafAt(l.root, op.zone, l);
      l.root = replace(l.root, z.id, { ...z, widgets: [...z.widgets, op.widget], active: z.widgets.length });
      break;
    }
    case 'edge':
      l.root = insertEdge(l.root, op.dir, op.widget);
      break;
    case 'add': {
      // Home placement: the answer strip goes directly under the composer (needs 107: no bar above it, where App draws
      // none); anything else stacks in the default zone.
      const composer = leaves(l.root).find((z) => z.widgets.some((w) => kindOf(w) === 'composer'));
      if (kindOf(op.widget) === 'waiting' && composer) l.root = insertSplit(l.root, composer, 'down', op.widget);
      else return apply(prev, { op: 'stack', widget: op.widget }, measure);
      break;
    }
    case 'move': {
      const src = leafAt(l.root, op.from, l);
      const i = tabOf(src, op.tab);
      const item = src.widgets[i];
      const to = op.to;
      const target = to.op === 'edge' ? null : (to.zone ?? defaultZone(l));
      if (target === src.id && src.widgets.length === 1) throw new Error(`cannot drop zone ${src.id} on itself`);
      if (to.op === 'stack' && target === src.id) throw new Error(`cannot drop zone ${src.id} on itself`);
      const rest = take(l.root, src, i);
      if (!rest) throw new Error('the layout needs at least one widget');
      const next: Layout = { ...l, root: rest };
      const placed = to.op === 'edge' ? { op: 'edge' as const, dir: to.dir, widget: item } : to.op === 'stack' ? { op: 'stack' as const, widget: item, zone: target! } : { op: 'split' as const, dir: to.dir, widget: item, zone: target! };
      return apply(next, placed, measure);
    }
    case 'remove': {
      const z = op.kind ? leaves(l.root).find((x) => x.widgets.some((w) => kindOf(w) === op.kind)) : leafAt(l.root, op.zone, l);
      if (!z) throw new Error(`no ${op.kind} widget in the layout`);
      const i = op.kind ? z.widgets.findIndex((w) => kindOf(w) === op.kind) : tabOf(z, op.tab);
      const rest = take(l.root, z, i);
      if (!rest) throw new Error('the layout needs at least one widget');
      l.root = rest;
      break;
    }
    case 'pin':
    case 'unpin': {
      const z = leafAt(l.root, op.zone, l);
      const i = tabOf(z, op.tab);
      const widgets = [...z.widgets];
      widgets[i] = op.op === 'pin' ? `${kindOf(widgets[i])}@${op.session}` : kindOf(widgets[i]);
      l.root = replace(l.root, z.id, { ...z, widgets });
      break;
    }
    case 'resize': {
      const z = find(l.root, op.zone);
      const parent = z && parentOf(l.root, z.id);
      if (!z || !parent) throw new Error(z ? `${op.zone} fills the window; resize one of its zones` : `no zone "${op.zone}"`);
      const min = minOf(z)[parent.split === 'row' ? 'w' : 'h'];
      if (!(op.size >= min)) throw new Error(`${op.zone} minimum is ${min} px`);
      const children = parent.children.map((c) => (c.id === z.id ? { ...c, size: Math.round(op.size) } : c));
      // One child always shares the rest, or a wider window would leave a gap.
      if (children.every((c) => c.size !== undefined)) delete children[children.findIndex((c) => c.id !== z.id)].size;
      l.root = replace(l.root, parent.id, { ...parent, children });
      break;
    }
    case 'swap': {
      if (op.a === op.b) throw new Error(`cannot swap zone ${op.a} with itself`);
      const [a, b] = [leafAt(l.root, op.a, l), leafAt(l.root, op.b, l)];
      [a.widgets, b.widgets, a.active, b.active] = [b.widgets, a.widgets, b.active, a.active];
      break;
    }
    case 'reset':
      return defaultLayout();
    case 'undo':
      throw new Error('undo is handled by the layout history');
  }
  for (const z of leaves(l.root)) if (!z.active) delete z.active;
  return l;
}
