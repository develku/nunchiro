// Ticket 1052: the icon bars can be widened again (ticket 283's edge, removed by 1041); the 48 px icons-only bar stays the
// default and the narrowest, and the labels come back with the width: first letter, cut label, full label.
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { bar, stored } from './d5b';

const edge = (p: Page) => bar(p, 'left').getByRole('separator', { name: 'Resize the icon bars' });
const wide = async (l: Locator) => Math.round((await l.boundingBox())!.width);
const label = (p: Page) => bar(p, 'right').locator('button.ai[aria-label="Decisions"] .al');
async function dragTo(p: Page, w: number) {
  const b = (await edge(p).boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + w - (await wide(bar(p, 'left'))), y, { steps: 12 });
  await p.mouse.up();
}
const autoHide = async (p: Page) => {
  await p.keyboard.press('Meta+KeyK');
  await p.getByRole('combobox').fill('Auto-hide icon bars'); // ticket 1093: the window button's words
  await p.keyboard.press('Enter');
};

test('rail_width_default_is_todays_bar: 48 px, 32 px icons, no labels, no width written', async ({ app }) => {
  await openWindow(app);
  for (const side of ['left', 'right'] as const) {
    expect(await wide(bar(app, side))).toBe(48);
    expect(await bar(app, side).getAttribute('style')).toBeNull();
    expect(await bar(app, side).getAttribute('data-compact')).toBeNull();
    await expect(bar(app, side).locator('.al')).toHaveCount(0);
    const b = (await bar(app, side).locator('button.ai').first().boundingBox())!;
    expect([Math.round(b.width), Math.round(b.height)]).toEqual([32, 32]);
  }
  expect((await bar(app, 'left').boundingBox())!.x).toBe(0);
  expect((await stored(app)).bars?.barW).toBeUndefined();
});

test('rail_width_drag_steps_keys_reset_reload: wider shows letter, cut, full labels on both bars; never under the default', async ({ app }) => {
  await openWindow(app);
  const steps: [number, string][] = [[52, 'letter'], [60, 'ellipsis'], [76, 'full']];
  for (const [w, step] of steps) {
    await dragTo(app, w);
    for (const side of ['left', 'right'] as const) {
      expect(await wide(bar(app, side)), `${side} ${step}`).toBe(w);
      await expect(bar(app, side)).toHaveAttribute('data-compact', step);
    }
    if (step === 'letter') await expect(label(app)).toHaveText('D');
    else await expect(label(app)).toHaveText('Decisions');
    const cut = await label(app).evaluate((e) => e.scrollWidth > e.clientWidth);
    expect(cut, step).toBe(step === 'ellipsis');
    await app.mouse.move(700, 400);
    await bar(app, 'right').locator('button.ai[aria-label="Decisions"]').hover();
    await expect(app.locator('#app-tip')).toContainText('Decisions'); // the full name at every step
    await app.mouse.move(700, 400);
    await expect(app.locator('#app-tip')).toBeHidden();
  }
  await expect.poll(async () => (await stored(app)).bars.barW).toBe(76);
  await dragTo(app, 30); // past the default: it stops there
  expect(await wide(bar(app, 'left'))).toBe(48);
  await expect(bar(app, 'left').locator('.al')).toHaveCount(0);

  await edge(app).focus();
  await app.keyboard.press('ArrowLeft'); // already the narrowest
  expect(await wide(bar(app, 'left'))).toBe(48);
  await app.keyboard.press('ArrowRight');
  await app.keyboard.press('ArrowRight');
  expect(await wide(bar(app, 'left'))).toBe(56);
  await app.keyboard.press('Home');
  expect(await wide(bar(app, 'left'))).toBe(48);
  expect((await bar(app, 'left').getAttribute('style')) ?? '').toBe(''); // React leaves an empty style="" behind

  await dragTo(app, 68);
  await edge(app).dblclick();
  expect(await wide(bar(app, 'left'))).toBe(48);
  await expect.poll(async () => (await stored(app)).bars.barW).toBeUndefined();

  await dragTo(app, 68);
  await expect.poll(async () => (await stored(app)).bars.barW).toBe(68);
  await app.reload();
  await expect(bar(app, 'right')).toHaveAttribute('data-compact', 'full');
  expect(await wide(bar(app, 'right'))).toBe(68);
});

test('rail_width_with_autohide: the revealed bar has the saved width, the hidden edge is out of reach, a drag keeps the bar out', async ({ app }) => {
  await openWindow(app);
  await dragTo(app, 64);
  await autoHide(app);
  await expect.poll(async () => (await stored(app)).bars.barsAuto).toBe(true);
  await app.mouse.move(700, 400);
  await expect(bar(app, 'left')).not.toBeInViewport();
  await expect(edge(app)).toBeHidden();
  await app.mouse.move(2, 400);
  await expect(bar(app, 'left')).toBeInViewport({ ratio: 1 });
  expect(await wide(bar(app, 'left'))).toBe(64);
  const b = (await edge(app).boundingBox())!;
  await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await app.mouse.down();
  await app.mouse.move(700, 400, { steps: 12 }); // far from the bar while the drag runs
  await app.waitForTimeout(600); // twice the leave delay
  await expect(bar(app, 'left')).toBeInViewport({ ratio: 1 });
  expect(await wide(bar(app, 'left'))).toBe(76);
  await app.mouse.up();
  await app.mouse.move(710, 400);
  await expect(bar(app, 'left')).not.toBeInViewport();
});
