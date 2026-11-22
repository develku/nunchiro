// needs 171 / 172 (Split basics): the gutter resizes a temporary split (drag, arrows, Home/End, double-click) and the header
// maximises and restores it. The ratio lives in window memory only. Real core, fake agent.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { drag, icon } from './d5b';

const agent = (core: Core, label: string) => core.agent(core.project(label), label, 'never-created');
const host = (p: Page) => p.locator('[data-split-host]');
const gutter = (p: Page) => p.locator('[data-split-gutter]');
const now = async (p: Page) => Number(await gutter(p).getAttribute('aria-valuenow'));
async function split(p: Page, core: Core, side: 'left' | 'right') {
  const a = agent(core, 'a');
  await openWindow(p, {}, core);
  await p.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(p.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
  const b = (await host(p).boundingBox())!;
  await drag(p, icon(p, 'right', 'Diff'), { x: side === 'left' ? b.x + 30 : b.x + b.width - 30, y: b.y + b.height / 2 });
  await expect(gutter(p)).toHaveCount(1);
  return a;
}

test('split_resize_by_pointer_and_keys', async ({ app, core }) => {
  await split(app, core, 'left');
  const g = gutter(app);
  await expect(g).toHaveAttribute('role', 'separator');
  await expect(g).toHaveAttribute('aria-orientation', 'vertical');
  await expect(g).toHaveAttribute('aria-valuemin', '15');
  await expect(g).toHaveAttribute('aria-valuemax', '85');
  expect(await now(app)).toBe(40);
  // Drag the gutter right by 20 % of the host: a left split grows from 40 to about 60.
  const hb = (await host(app).boundingBox())!;
  const gb = (await g.boundingBox())!;
  await app.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await app.mouse.down();
  await app.mouse.move(gb.x + gb.width / 2 + hb.width * 0.2, gb.y + gb.height / 2, { steps: 8 });
  await app.mouse.up();
  expect(Math.abs((await now(app)) - 60)).toBeLessThanOrEqual(2);
  const base = await now(app);
  await g.focus();
  await app.keyboard.press('ArrowRight');
  expect(await now(app)).toBe(base + 2);
  await app.keyboard.press('Shift+ArrowRight');
  expect(await now(app)).toBe(base + 12);
  await app.keyboard.press('ArrowLeft');
  expect(await now(app)).toBe(base + 10);
  await app.keyboard.press('Home');
  expect(await now(app)).toBe(15);
  await app.keyboard.press('End');
  expect(await now(app)).toBe(85);
  await g.dblclick();
  expect(await now(app)).toBe(40);
  // Window memory only: nothing about the ratio is stored.
  expect(await app.evaluate(() => JSON.stringify({ ...localStorage }))).not.toMatch(/ratio|valuenow/i);
  await expect(app.locator('[data-split-id]')).toHaveCSS('flex-basis', /%|px/);
});

test('split_right_mirrors: ArrowLeft grows a right split', async ({ app, core }) => {
  await split(app, core, 'right');
  await gutter(app).focus();
  await app.keyboard.press('ArrowLeft');
  expect(await now(app)).toBe(42);
});

test('split_maximise_and_restore', async ({ app, core }) => {
  const a = await split(app, core, 'right');
  const s = app.locator('[data-split-id]');
  const btn = s.getByRole('button', { name: 'Maximise split' });
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  const restore = s.getByRole('button', { name: 'Restore split' });
  await expect(restore).toHaveAttribute('aria-pressed', 'true');
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeHidden();
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toHaveCount(1); // hidden, not unmounted
  const sb = (await s.boundingBox())!;
  const hb = (await host(app).boundingBox())!;
  expect(sb.width).toBeGreaterThan(hb.width - 4);
  await restore.click();
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
  // Header double-click toggles; Escape inside the split restores; the pin and close buttons do not toggle.
  await s.locator('.sph b').dblclick();
  await expect(s.getByRole('button', { name: 'Restore split' })).toBeVisible();
  await s.locator('.sph').focus();
  await s.focus();
  await app.keyboard.press('Escape');
  await expect(s.getByRole('button', { name: 'Maximise split' })).toBeVisible();
  await s.getByRole('button', { name: 'Close split' }).dblclick();
  await expect(s).toHaveCount(0);
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible(); // closing resets it
});
