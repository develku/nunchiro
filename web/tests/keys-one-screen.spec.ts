// FIDELITY bar (needs 130, replaced by needs 166 page A, owner 2026-11-01): the Keyboard page is one scrollable list, and the
// large keyboard is not on it (it stays on the Hints tab). What a 1440x900 window opens with is the frame's first screen:
// title, lede, search with Record, the four chips, the PREFIX header and row, and the first action rows.
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';

test('keyboard_first_screen_is_frame_a: the frame’s title, search, chips, PREFIX row and first rows sit in a 1440x900 window; one scroller, no clipping', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'ux-fix-2');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-keys-list]')).toBeVisible();
  // Top of the page, no scrolling.
  expect(await app.evaluate(() => document.querySelector('.sbody')!.scrollTop)).toBe(0);
  const view = app.viewportSize()!;
  const first = [
    app.getByRole('heading', { level: 1, name: 'Keyboard' }), // needs 192 (ticket 250): the page title is the h1
    app.locator('.ksearch'),
    app.getByRole('button', { name: 'Record' }),
    ...['All', 'Changed', 'Conflicts', 'No key'].map((n) => app.getByRole('group', { name: 'Filter actions' }).getByRole('button', { name: new RegExp(`^${n} \\d+$`) })),
    app.locator('[data-command="prefix"]'),
    ...[0, 1, 2].map((i) => app.locator('[data-keys-list] section[data-area="palette-and-window"] tr[data-command]').nth(i)),
  ];
  for (const [i, el] of first.entries()) {
    const box = (await el.boundingBox())!;
    expect(box.y, `first-screen item ${i}`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `first-screen item ${i}`).toBeLessThanOrEqual(view.height);
  }
  // The list is not clipped sideways, and .sbody is the only scroller on the page.
  expect(await app.locator('[data-keys-list]').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  const scrollers = await app.evaluate(() =>
    [...document.querySelectorAll('.keys-page, .keys-page *, .sbody')].filter((e) => {
      const oy = getComputedStyle(e).overflowY;
      return (oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight + 1;
    }).map((e) => e.className),
  );
  expect(scrollers).toEqual(['sbody']);
  const out = path.join(REPO, '.scratch/fix-diffspec-keys');
  await app.screenshot({ path: path.join(out, 'keys-app-1440x900.png') });
});
