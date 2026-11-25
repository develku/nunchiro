// Main reds 2 item 10: the layout's resize edges take no pixel of the tree. On main the sidebar handle lay 3 px over the
// tree's outer edge and the icon bar's divider 3 px over its inner edge, so the project head's 24 px chevron box lost 2 px.
// Each edge now starts at its border and reaches away from the tree: the left sidebar's handle into the main zone (ticket
// 1041 removed the icon bar's divider). The right sidebar's handle reaches into its own sidebar, so the main zone's
// scrollbar at that edge keeps its full width. All still drag and step with the arrow keys.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon, sidebar } from './d5b';

/** What answers a press at each x along one row of the page: 'side' (a sidebar handle), 'bar' (an icon bar's divider) or 'other'. */
const hits = (app: Page, xs: number[], y: number) =>
  app.evaluate(([xs, y]) => xs.map((x) => { const e = document.elementFromPoint(x, y); return e?.closest('.sdiv') ? 'side' : e?.closest('.bdiv') ? 'bar' : 'other'; }), [xs, y] as const);
/** Whole pixels: hit testing rounds a half. */
const span = (from: number, n: number) => Array.from({ length: n }, (_, i) => Math.round(from) + i);

test('sidebar_edge_takes_no_tree_pixel: the tree keeps its full width and its 24 px chevron; both edges reach away from it, drag and step', async ({ app, core }) => {
  core.shell(core.project('demo'), 'sh1');
  await openWindow(app);
  const head = app.locator('.tree .row.head').first();
  await expect(head).toBeVisible();
  const side = (await sidebar(app, 'left').boundingBox())!;
  const row = (await head.boundingBox())!;
  const y = row.y + row.height / 2;
  // The head row spans the sidebar inside its border; its first and last 3 px answer as the tree.
  expect(Math.round(row.x)).toBe(Math.round(side.x));
  expect(Math.round(row.x + row.width)).toBe(Math.round(side.x + side.width) - 1);
  const inner = [...span(row.x, 3), ...span(row.x + row.width - 3, 3)];
  expect(await hits(app, inner, y)).toEqual(Array(6).fill('other'));
  expect(await app.evaluate(([xs, y]) => xs.every((x) => !!document.elementFromPoint(x, y)?.closest('.tree .row.head')), [inner, y] as const)).toBe(true);
  // The collapse arrow's box answers as itself at both of its edges, 24 px apart.
  const chev = (await head.locator('.chev').boundingBox())!;
  expect(Math.round(chev.width)).toBe(24);
  const cy = chev.y + chev.height / 2;
  for (const x of [Math.round(chev.x), Math.round(chev.x + chev.width) - 1])
    expect(await app.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.row.head > .chev'), [x, cy] as const), `chevron at x=${x}`).toBe(true);
  // Ticket 1052 (e0405857d) gave the bar its widen edge back: 6 px inside the bar, none of it over the tree.
  const bar = (await app.locator('nav[data-bar="left"]').boundingBox())!;
  const barEdge = Math.round(bar.x + bar.width);
  expect(await hits(app, span(barEdge - 10, 14), cy)).toEqual([...Array(4).fill('other'), ...Array(6).fill('bar'), ...Array(4).fill('other')]);
  // The sidebar handle: at least 8 px, from the border outward into the main zone.
  const edgeX = Math.round(side.x + side.width);
  const xs = span(edgeX - 8, 24);
  const got = await hits(app, xs, y);
  expect(got.filter((h) => h === 'side').length).toBeGreaterThanOrEqual(8);
  expect(xs[got.indexOf('side')]).toBe(edgeX - 1); // its first pixel is the border, not the tree
  // Both still drag and step with the keys.
  const edge = app.getByRole('separator', { name: 'Resize the left sidebar' });
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 + 60, e.y + e.height / 2, { steps: 8 });
  await app.mouse.up();
  expect(Math.round((await sidebar(app, 'left').boundingBox())!.width)).toBe(Math.round(side.width) + 60);
  const w = Number(await edge.getAttribute('aria-valuenow'));
  await edge.focus();
  await app.keyboard.press('ArrowLeft');
  await expect.poll(async () => Number(await edge.getAttribute('aria-valuenow'))).toBeLessThan(w);
});

test('sidebar_edge_right: the main zone keeps its last pixels (its scrollbar); the right handle reaches 8 px into its sidebar and drags', async ({ app, core }) => {
  core.shell(core.project('demo'), 'sh1');
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  await expect(sidebar(app, 'right')).toHaveAttribute('data-widget', 'decisions');
  const side = (await sidebar(app, 'right').boundingBox())!;
  const y = side.y + side.height / 2;
  const left = Math.round(side.x);
  // The main zone's last 16 px, where its scroller draws a scrollbar, answer as the main zone.
  expect(await hits(app, span(left - 16, 16), y)).toEqual(Array(16).fill('other'));
  const xs = span(left - 4, 20);
  const got = await hits(app, xs, y);
  expect(got.filter((h) => h === 'side').length).toBeGreaterThanOrEqual(8);
  expect(xs[got.indexOf('side')]).toBe(left); // its first pixel is the border
  const edge = app.getByRole('separator', { name: 'Resize the right sidebar' });
  const e = (await edge.boundingBox())!;
  await app.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await app.mouse.down();
  await app.mouse.move(e.x + e.width / 2 - 60, e.y + e.height / 2, { steps: 8 });
  await app.mouse.up();
  expect(Math.round((await sidebar(app, 'right').boundingBox())!.width)).toBe(Math.round(side.width) + 60);
});
