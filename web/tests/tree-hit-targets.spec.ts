// Main reds 11-10, PRODUCT BUG 3: a project head's chevron, name and colour bars take the pointer over 24x24 px
// (WCAG 2.5.8) while their glyphs stay put; where two colours' hit boxes meet, a bar's own box wins over its neighbour's.
// Ticket 401: the layout's resize edges no longer reach into the sidebar (sidebar-edge-hit.spec.ts), so the chevron's box
// answers all 24px (the --hit token) at every sidebar width, and the edge strip's arrow (.gch) takes a 24x24 box too.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';

test('head_targets_take_24px: chevron, name and each colour bar answer the pointer 24px wide, a bar never loses its own glyph', async ({ app, core }) => {
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  core.shell(p, 'sh-1');
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go-a'), '');
  const head = app.locator('.grp[data-project="nunchiro"] .row.head');
  await expect(head.locator(':scope > .cstrip > .sg')).toHaveCount(2, { timeout: 10_000 }); // your turn (o) and idle (g)
  await expect(head.locator(':scope > .cstrip')).toHaveAttribute('data-dim', 'true'); // the open head's faded strip
  const hits = await head.evaluate((h) => {
    const at = (x: number, y: number) => {
      const b = document.elementFromPoint(x, y)?.closest('button');
      return b ? `${b.className}${b.dataset.tone ? ` ${b.dataset.tone}` : ''}` : '';
    };
    const r = (e: Element) => e.getBoundingClientRect();
    const row = r(h);
    const chev = r(h.querySelector(':scope > .chev svg')!);
    const name = r(h.querySelector(':scope > .n')!);
    const [o, g] = [...h.querySelectorAll(':scope > .cstrip > .sg')].map((e) => [...e.querySelectorAll('i')].map(r));
    const cy = chev.top + chev.height / 2;
    return {
      chev: [at(chev.left - 7, cy), at(chev.right + 5, cy), at(chev.left + 5, chev.top - 6), at(chev.left + 5, chev.bottom + 6)],
      name: [at(name.left + name.width / 2, row.top + 1), at(name.left + name.width / 2, row.bottom - 1)],
      // o's own last bar, then 9px left of its first; g's own first bar, then 4px right of its last (the edge of the sidebar's
      // 3px resize zone) and 3px over its button.
      o: [at(o.at(-1)!.right - 1, o.at(-1)!.bottom - 2), at(o[0].left - 9, o[0].bottom - 2)],
      g: [at(g[0].left + 1, g[0].bottom - 2), at(g.at(-1)!.right + 4, g.at(-1)!.bottom - 2), at(g[0].left + 1, r(h.querySelector(':scope > .cstrip > .sg[data-tone="g"]')!).top - 3)],
    };
  });
  expect(hits).toEqual({ chev: Array(4).fill('chev'), name: ['n', 'n'], o: ['sg o', 'sg o'], g: ['sg g', 'sg g', 'sg g'] });
});

test('chevron_and_strip_arrow_take_24px: the head chevron answers 24px wide at three sidebar widths; the edge strip arrow is a 24x24 box', async ({ app, core }) => {
  const ps = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b1'].map((n) => core.project(n));
  for (const p of ps) core.agent(p, `${path.basename(p)}-ag`, 'go');
  await openWindow(app);
  const head = app.locator('.tree .row.head').first();
  await expect(head).toBeVisible();
  const edge = app.getByRole('separator', { name: 'Resize the left sidebar' });
  const widths: number[] = [];
  for (const dx of [0, -40, 200]) {
    if (dx) {
      const e = (await edge.boundingBox())!;
      await app.mouse.move(e.x + e.width / 2, e.y + 100);
      await app.mouse.down();
      await app.mouse.move(e.x + e.width / 2 + dx, e.y + 100, { steps: 6 });
      await app.mouse.up();
    }
    widths.push(Number(await edge.getAttribute('aria-valuenow')));
    // Every whole pixel across the chevron's box, at its middle row, answers as the chevron; the pixel before it does not.
    const got = await head.evaluate((h) => {
      const c = h.querySelector(':scope > .chev')!.getBoundingClientRect();
      const cy = c.top + c.height / 2;
      const on = (x: number) => !!document.elementFromPoint(x, cy)?.closest('.row.head > .chev');
      const xs = Array.from({ length: Math.round(c.width) }, (_, i) => Math.round(c.left) + i);
      return { w: Math.round(c.width), h: Math.round(c.height), free: xs.filter(on).length, before: on(Math.round(c.left) - 1) };
    });
    expect(got).toEqual({ w: 24, h: 24, free: 24, before: false });
  }
  expect(new Set(widths).size).toBe(3);
  // A short window: the your-turn heads below the edge gather in the bottom strip, whose arrow scrolls to them.
  for (const p of ps) fs.writeFileSync(path.join(p, 'go'), '');
  await app.setViewportSize({ width: 1440, height: 300 });
  await app.mouse.move(900, 200);
  const gch = app.locator('.gat.bottom .gch');
  await expect(gch).toBeVisible({ timeout: 10_000 });
  const box = await gch.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const on = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('button') === b;
    const [l, t, rt, bt] = [Math.ceil(r.left), Math.ceil(r.top), Math.floor(r.right) - 1, Math.floor(r.bottom) - 1];
    return { w: r.width, h: r.height, corners: [on(l, t), on(rt, t), on(l, bt), on(rt, bt)] };
  });
  expect(box).toEqual({ w: 24, h: 24, corners: [true, true, true, true] });
});

// Ticket 991 A7: a lone one-bar colour (one idle shell) answers the pointer across 24px, not only its 5px button.
test('A7 lone_bar_takes_24px', async ({ app, core }) => {
  core.shell(core.project('solo'), 'sh-1');
  await openWindow(app);
  const g = app.locator('.grp[data-project="solo"] .row.head > .cstrip > .sg[data-tone="g"]');
  await expect(g).toHaveAttribute('data-n', '1', { timeout: 10_000 });
  const wide = await g.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const y = r.bottom - 2;
    return Array.from({ length: 60 }, (_, i) => Math.round(r.right) + 10 - i).filter((x) => document.elementFromPoint(x, y)?.closest('button') === b).length;
  });
  expect(wide).toBeGreaterThanOrEqual(24);
});
