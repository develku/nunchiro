// Layout model and command language (needs 37, 39; spec Window (v1a) Layout edit). Pure functions, no page.
import { expect, test } from '@playwright/test';
import { apply, defaultLayout, find, leaves, minOf, nearestZone, resizeStep, sidesOf, zoomHidden, type Layout, type Leaf } from '../src/layout/model';
import { complete, format, parse, tokenize } from '../src/layout/command';

/** The pre-D5b default (R7-1): the tree over AGENTS in a left column. D5b moved both out of the default zones, but the
 *  model still loads such a layout (an old layout.toml), so these tests keep their shape. */
const legacy = (): Layout => ({
  version: 1,
  root: {
    id: 'main',
    split: 'row',
    children: [
      { id: 'left', size: 256, split: 'column', children: [{ id: 'tree', widgets: ['tree'] }, { id: 'context', size: 190, widgets: ['context'] }] },
      { id: 'centre', split: 'column', children: [{ id: 'terminal', widgets: ['terminal'] }, { id: 'waiting', widgets: ['waiting'] }, { id: 'composer', widgets: ['composer'] }] },
    ],
  },
});
const run = (l: Layout, line: string, selected?: string) => apply(l, parse(tokenize(line), selected, l));
const ids = (l: Layout) => leaves(l.root).map((z) => `${z.id}:${z.widgets.join('+')}`);

test('default layout is the D5b centre column: terminal and composer (A22: no strip zone); no tree zone by default (needs 157: the Tree may be put in one)', () => {
  const l = defaultLayout();
  expect(l).toMatchObject({ version: 1 });
  expect('locked' in l).toBe(false); // ticket 1031: the Lock switch and its state are gone
  expect(ids(l)).toEqual(['terminal:terminal', 'composer:composer']);
  expect(ids(legacy())).toEqual(['tree:tree', 'context:context', 'terminal:terminal', 'waiting:waiting', 'composer:composer']);
});

test('split right inserts a sibling in a row, split down wraps a column; ids stay unique', () => {
  let l = run(legacy(), 'split right terminal --pin v1a-03 --zone terminal');
  // The centre is a column, so a right split wraps the terminal zone in a new row.
  const centre = find(l.root, 'centre')!;
  expect('children' in centre && centre.children[0]).toMatchObject({ split: 'row' });
  expect(ids(l)).toContain('terminal-2:terminal@v1a-03');
  l = run(l, 'split right waiting --zone terminal-2');
  expect(ids(l)).toContain('waiting-2:waiting');
  // Same axis: no extra nesting.
  const row = find(l.root, 'terminal')!;
  expect(ids(l).filter((x) => x.startsWith('terminal')).length).toBe(2);
  expect(row).toBeTruthy();
});

test('stack adds a tab and makes it active; edge adds a zone at the window edge with a fixed size', () => {
  let l = run(legacy(), 'stack context --zone terminal');
  expect((find(l.root, 'terminal') as Leaf).widgets).toEqual(['terminal', 'context']);
  expect((find(l.root, 'terminal') as Leaf).active).toBe(1);
  l = run(l, 'edge right waiting');
  expect(l.root).toMatchObject({ split: 'row' });
  const last = 'children' in l.root ? l.root.children.at(-1)! : null;
  expect(last).toMatchObject({ id: 'waiting-2', widgets: ['waiting'], size: 264 });
});

test('remove collapses empty zones and single-child splits; the last zone signal may go: the Tree always shows waiting', () => {
  let l = run(legacy(), 'remove context');
  expect(ids(l)).toEqual(['tree:tree', 'terminal:terminal', 'waiting:waiting', 'composer:composer']);
  // The left column had one child left, so it collapsed into that child (which keeps the column's width).
  expect(find(l.root, 'tree')).toMatchObject({ size: 256 });
  l = run(l, 'remove waiting');
  expect(() => run(l, 'remove tree')).not.toThrow(); // was toThrow(/menu bar/): A22 drops the zone-only signal rule
  expect(() => run(run(l, 'remove composer'), 'remove --zone terminal')).not.toThrow();
});

test('move takes a widget with its pin; pin and unpin name the session (Hangul too)', () => {
  let l = run(legacy(), 'pin 리뷰-03 --zone terminal');
  expect((find(l.root, 'terminal') as Leaf).widgets).toEqual(['terminal@리뷰-03']);
  l = run(l, 'move terminal edge left');
  expect(ids(l)[0]).toBe('terminal:terminal@리뷰-03');
  l = run(l, 'unpin --zone terminal');
  expect(ids(l)[0]).toBe('terminal:terminal');
  expect(() => run(l, 'move terminal stack --zone terminal')).toThrow(/itself/);
});

test('split minimum: a zone too small for both halves is refused with the sizes', () => {
  const sizes = new Map([['context', { w: 256, h: 190 }], ['terminal', { w: 900, h: 500 }]]);
  const l = legacy();
  expect(() => apply(l, parse(tokenize('split down terminal --zone context'), undefined, l), (id) => sizes.get(id))).toThrow(/context is 190 px .* needs 80 \+ 120/);
  expect(() => apply(l, parse(tokenize('split right terminal --zone terminal'), undefined, l), (id) => sizes.get(id))).not.toThrow();
});

test('resize and reset; lock is no command any more (ticket 1031); unknown widgets and zones are named', () => {
  let l = run(legacy(), 'resize left 300');
  expect(find(l.root, 'left')).toMatchObject({ size: 300 });
  expect(() => run(l, 'resize left 20')).toThrow(/minimum/);
  for (const gone of ['lock', 'unlock']) expect(() => run(l, gone)).toThrow(/unknown layout command/);
  expect(run(l, 'reset')).toEqual(defaultLayout());
  expect(() => run(l, 'split right chat')).toThrow(/unknown widget "chat"/);
  expect(() => run(l, 'split right files --zone nope')).toThrow(/no zone "nope"/); // needs 157: a second Tree is refused first, so another widget names the zone
});

test('parse and format round-trip: the drag echo is the typed command', () => {
  for (const line of ['split right terminal --pin v1a-03 --zone terminal', 'stack context --zone terminal', 'edge left waiting', 'add waiting', 'move terminal split down --zone tree', 'remove --zone context --tab 1', 'pin "my session" --zone terminal', 'resize left 300', 'reset', 'undo'])
    expect(format(parse(tokenize(line)))).toBe(line);
  // The default zone is the selected one.
  expect(format(parse(tokenize('split right context'), 'tree'))).toBe('split right context --zone tree');
});

test('add waiting puts the strip under the composer (needs 107)', () => {
  const l = run(run(legacy(), 'remove waiting'), 'add waiting');
  expect(ids(l)).toEqual(['tree:tree', 'context:context', 'terminal:terminal', 'composer:composer', 'waiting:waiting']);
});

test('completion offers commands, then their arguments', () => {
  expect(complete('sp', legacy(), []).map((c) => c.text)).toEqual(['split ']);
  expect(complete('split ', legacy(), []).map((c) => c.text)).toEqual(['split up ', 'split down ', 'split left ', 'split right ']);
  expect(complete('split right t', legacy(), []).map((c) => c.text)).toEqual(['split right tree ', 'split right terminal ']);
  expect(complete('pin ', legacy(), ['v1a-03']).map((c) => c.text)).toEqual(['pin v1a-03 ']);
  expect(complete('split right tree --zone con', legacy(), []).map((c) => c.text)).toEqual(['split right tree --zone context ']);
});

test('removing a tab before the active one keeps the same tab active', () => {
  let l = run(legacy(), 'stack context --zone terminal');
  l = run(l, 'stack files --zone terminal'); // needs 157: the legacy layout has its one Tree already
  l = apply(l, { op: 'pin', session: 'x', zone: 'terminal', tab: 2 });
  // Tabs: terminal, context@x, files; make context@x active, then remove the first tab.
  l = { ...l, root: JSON.parse(JSON.stringify(l.root).replace('"active":2', '"active":1')) };
  expect((find(l.root, 'terminal') as Leaf).active).toBe(1);
  l = run(l, 'remove --zone terminal --tab 1');
  const z = find(l.root, 'terminal') as Leaf;
  expect(z.widgets).toEqual(['context@x', 'files']);
  expect(z.active ?? 0).toBe(0);
  // Removing the active last tab falls back to the one before it.
  const m = run(run(legacy(), 'stack context --zone terminal'), 'remove --zone terminal --tab 2');
  expect((find(m.root, 'terminal') as Leaf).active ?? 0).toBe(0);
});

test('zoom: one visible zone, unzoom shows all, and the serialised layout never changes', () => {
  const l = legacy();
  const before = JSON.stringify(l);
  const hide = zoomHidden(l, 'terminal');
  expect(leaves(l.root).filter((z) => !hide(z)).map((z) => z.id)).toEqual(['terminal']);
  // Ancestors of the zoomed zone stay visible so it can fill the area; its siblings and the other branch go.
  expect(hide(find(l.root, 'centre')!)).toBe(false);
  expect(hide(find(l.root, 'left')!)).toBe(true);
  expect(leaves(l.root).filter((z) => !zoomHidden(l, null)(z))).toHaveLength(5);
  expect(JSON.stringify(l)).toBe(before);
});

test('swap exchanges two zones\' widgets and active tab, sibling or not, and keeps ids and sizes', () => {
  let l = run(legacy(), 'stack context --zone terminal');
  l = apply(l, { op: 'pin', session: 'x', zone: 'terminal', tab: 1 });
  const before = ids(l);
  const s = apply(l, { op: 'swap', a: 'terminal', b: 'tree' });
  expect(ids(s)).toEqual(['tree:terminal@x+context', 'context:context', 'terminal:tree', 'waiting:waiting', 'composer:composer']);
  expect((find(s.root, 'tree') as Leaf).active).toBe(1);
  expect((find(s.root, 'terminal') as Leaf).active ?? 0).toBe(0);
  expect(find(s.root, 'tree')).toMatchObject({ id: 'tree' });
  expect(find(s.root, 'left')).toMatchObject({ size: 256 });
  expect(find(s.root, 'context')).toMatchObject({ size: 190 });
  // Siblings too, and swapping back restores the layout.
  expect(ids(apply(l, { op: 'swap', a: 'waiting', b: 'composer' }))).toContain('waiting:composer');
  expect(apply(s, { op: 'swap', a: 'terminal', b: 'tree' })).toEqual(l);
  expect(ids(l)).toEqual(before);
  expect(() => apply(l, { op: 'swap', a: 'terminal', b: 'terminal' })).toThrow(/itself/);
  expect(() => apply(l, { op: 'swap', a: 'left', b: 'terminal' })).toThrow(/holds other zones/);
  expect(() => apply(l, { op: 'swap', a: 'nope', b: 'terminal' })).toThrow(/no zone "nope"/);
});

test('nearest zone by direction: 2x2 picks the neighbour, none at the edge, overlap beats a closer corner', () => {
  const r = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });
  const grid = { a: r(0, 0), b: r(100, 0), c: r(0, 100), d: r(100, 100) };
  expect(nearestZone(grid, 'a', 'right')).toBe('b');
  expect(nearestZone(grid, 'a', 'down')).toBe('c');
  expect(nearestZone(grid, 'd', 'left')).toBe('c');
  expect(nearestZone(grid, 'd', 'up')).toBe('b');
  expect(nearestZone(grid, 'a', 'left')).toBeNull();
  expect(nearestZone(grid, 'a', 'up')).toBeNull();
  expect(nearestZone(grid, 'b', 'right')).toBeNull();
  // One tall zone left of two stacked ones: from the tall one, right goes to the one it overlaps most.
  const tall = { t: r(0, 0, 100, 200), u: r(100, 0, 100, 60), v: r(100, 60, 100, 140) };
  expect(nearestZone(tall, 't', 'right')).toBe('v');
  expect(nearestZone(tall, 'u', 'left')).toBe('t');
});

test('resize step: grows toward a neighbour, shrinks at the window edge, climbs to the split on that axis, stops at the minimum', () => {
  const l = legacy();
  const size = (w: number, h: number) => (id: string) => (id === 'left' || id === 'main' ? { w: 1200, h: 700 } : { w, h }); // splits have room; the zone is w x h
  // `left` (256 wide) has its neighbour on the right: l grows, h shrinks.
  expect(resizeStep(l, 'tree', 'right', 16, (id) => (id === 'main' ? { w: 1200, h: 700 } : id === 'left' ? { w: 256, h: 700 } : { w: 256, h: 300 }))).toEqual({ op: 'resize', zone: 'left', size: 272 });
  expect(resizeStep(l, 'tree', 'left', 16, (id) => (id === 'main' ? { w: 1200, h: 700 } : id === 'left' ? { w: 256, h: 700 } : { w: 256, h: 300 }))).toEqual({ op: 'resize', zone: 'left', size: 240 });
  // context (190 high, last in its column): up grows (neighbour above), down shrinks.
  expect(resizeStep(l, 'context', 'up', 16, size(256, 190))).toEqual({ op: 'resize', zone: 'context', size: 206 });
  expect(resizeStep(l, 'context', 'down', 16, size(256, 190))).toEqual({ op: 'resize', zone: 'context', size: 174 });
  // At the minimum nothing changes: no op.
  const min = 80; // context' minimum height (registry)
  expect(resizeStep(l, 'context', 'down', 16, size(256, min))).toBeNull();
  // A shrink never goes below the minimum, it clamps to it.
  expect(resizeStep(l, 'context', 'down', 16, size(256, min + 5))).toEqual({ op: 'resize', zone: 'context', size: min });
  // The only zone of a window has no split on any axis.
  expect(resizeStep({ ...l, root: { id: 'solo', widgets: ['terminal'] } }, 'solo', 'right', 16, size(900, 600))).toBeNull();
});

test('resize step growing outward stops at the neighbours\' minimum and writes nothing past it', () => {
  const l = legacy();
  const room = minOf(find(l.root, 'centre')!).w; // the centre's minimum width
  const at = (main: number) => (id: string) => (id === 'main' ? { w: main, h: 800 } : id === 'left' ? { w: 256, h: 800 } : { w: 256, h: 300 });
  // 10 px of slack beside the centre: a 16 px step clamps to 266.
  expect(resizeStep(l, 'tree', 'right', 16, at(256 + room + 10))).toEqual({ op: 'resize', zone: 'left', size: 266 });
  // No slack: the step is a no-op, so no op (no write, no undo step).
  expect(resizeStep(l, 'tree', 'right', 16, at(256 + room))).toBeNull();
});

test('resize step growing outward never shrinks when the neighbours are already below their minimum', () => {
  const l = legacy();
  const room = minOf(find(l.root, 'centre')!).w;
  const at = (main: number) => (id: string) => (id === 'main' ? { w: main, h: 800 } : id === 'left' ? { w: 256, h: 800 } : { w: 256, h: 300 });
  // The window is 30 px narrower than left + centre minimum: room is 226 < 256, so growing must be a no-op, never a shrink.
  expect(resizeStep(l, 'tree', 'right', 16, at(256 + room - 30))).toBeNull();
});

test('pane-resize-ctrl-lh: the flexible zone between two neighbours moves its right edge, so l then h cancels and the sidebar keeps its size', () => {
  const l = apply(legacy(), { op: 'edge', dir: 'right', widget: 'board' }); // main: left 256 | centre (shares the rest) | board 264
  const at = (id: string) => (id === 'main' ? { w: 1440, h: 800 } : id === 'centre' ? { w: 920, h: 800 } : id === 'board' ? { w: 264, h: 800 } : { w: 256, h: 800 });
  expect(resizeStep(l, 'terminal', 'right', 16, at)).toEqual({ op: 'resize', zone: 'board', size: 248 });
  expect(resizeStep(l, 'terminal', 'left', 16, at)).toEqual({ op: 'resize', zone: 'board', size: 280 });
  // The last zone moves its left edge: l shrinks it, h grows it.
  expect(resizeStep(l, 'board', 'right', 16, at)).toEqual({ op: 'resize', zone: 'board', size: 248 });
  expect(resizeStep(l, 'board', 'left', 16, at)).toEqual({ op: 'resize', zone: 'board', size: 280 });
  // Shrinking the flexible zone stops at its own minimum.
  const room = minOf(find(l.root, 'centre')!).w;
  expect(resizeStep(l, 'terminal', 'left', 16, (id) => (id === 'centre' ? { w: room, h: 800 } : at(id)))).toBeNull();
  // A neighbour already under its minimum (a window too small) is never grown by a step that shrinks it.
  const boardMin = minOf(find(l.root, 'board')!).w;
  expect(resizeStep(l, 'terminal', 'right', 16, (id) => (id === 'board' ? { w: boardMin - 10, h: 800 } : at(id)))).toBeNull();
});

test('main-zone-min-width: the panels beside the main zone are the row-split siblings on its path, outermost first', () => {
  const l = run(run(run(legacy(), 'edge right board'), 'split right diff --zone terminal --size 300'), 'split right terminal --zone terminal');
  expect(sidesOf(l.root, 'terminal')!.map((n) => n.id)).toEqual(['left', 'board', 'diff']);
  // A terminal in a fixed-width zone (pane mode moved it into the sidebar) cannot be widened by folding.
  expect(sidesOf(run(legacy(), 'move terminal stack --zone tree').root, 'tree')).toBeNull();
  // Zones stacked above or below it (strip, composer) are not beside it; a zone nobody holds has none.
  expect(sidesOf(legacy().root, 'composer')!.map((n) => n.id)).toEqual(['left']);
  expect(sidesOf(legacy().root, 'nowhere')).toEqual([]);
});
