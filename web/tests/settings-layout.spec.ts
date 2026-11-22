// V1A-54 item 7 (owner pass 2026-10-26): scrolling Settings to its end moves nothing but its own pane, and the density
// cards' tab-strip preview lines never run into each other at narrow widths.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const openSettings = async (app: Page) => {
  await app.keyboard.press('Meta+Comma');
  await expect(app.locator('.sbody')).toBeVisible();
};

/** Every element above the settings pane, with its scroll offset and on-screen top: a 4 px shift shows in one of them. */
const offsets = (app: Page) =>
  app.evaluate(() => {
    const out: string[] = [];
    for (let e: Element | null = document.querySelector('.sbody')!.parentElement; e; e = e.parentElement)
      out.push(`${e.tagName}.${e.className} top=${Math.round(e.getBoundingClientRect().top)} scroll=${e.scrollTop},${e.scrollLeft}`);
    return out;
  });

test('settings-no-window-shift: scrolling Settings to the bottom shifts no element outside its pane', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.setViewportSize({ width: 1440, height: 700 });
  await openWindow(app);
  await openSettings(app);
  const before = await offsets(app);
  const pane = (await app.locator('.sbody').boundingBox())!;
  await app.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  for (let i = 0; i < 12; i++) await app.mouse.wheel(0, 600);
  await expect.poll(() => app.locator('.sbody').evaluate((e) => Math.round(e.scrollTop + e.clientHeight) >= e.scrollHeight - 1)).toBe(true);
  // Tab through to the last control too: focus moving to the end must not scroll an ancestor either.
  await app.locator('.sbody').evaluate((e) => [...e.querySelectorAll<HTMLElement>('input, button, select')].at(-1)?.focus());
  expect(await offsets(app)).toEqual(before);
});

for (const width of [900, 1100, 1440]) {
  test(`settings-no-window-shift: at ${width} px the density preview lines stack and never overlap`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.setViewportSize({ width, height: 800 });
    await openWindow(app);
    await openSettings(app);
    const bad = await app.$$eval('.card .pv', (pvs) =>
      pvs.flatMap((pv, c) => {
        const box = pv.getBoundingClientRect();
        const rs = [...pv.children].map((s) => s.getBoundingClientRect());
        return rs.flatMap((r, i) => [
          ...(r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 ? [`card ${c} line ${i} leaves its preview`] : []),
          ...rs.slice(i + 1).filter((q) => r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom).map(() => `card ${c} line ${i} overlaps`),
          ...(i && Math.abs(r.left - rs[0].left) > 0.5 ? [`card ${c} line ${i} is beside line 0, not below`] : []),
        ]);
      }),
    );
    expect(bad).toEqual([]);
  });
}
