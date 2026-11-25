// Ticket 1084: every host of the Preview has a close button, also with nothing to preview: the side pane, a session split (its own
// chrome x, no second one) and a layout zone. The button and Escape (focus in the bar) remove that host. Real core, fake agents.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { showPreview } from './agent-pane';

const STORE = 'nunchiro.splits.v1';
const close = (page: Page) => page.locator('.preview .pv-top').getByRole('button', { name: 'Close Preview' });

// A split has one close: its own chrome's x (Close split), so the Preview draws no bar close there.
test('a Preview in a session split has exactly one close, the split\'s own, and it removes the split', async ({ app, core }) => {
  const a = core.agent(core.project('agents'), 'a', 'never-created');
  await openWindow(app, {}, core);
  await app.evaluate(([k, id]) => localStorage.setItem(k, JSON.stringify({ [id]: [{ id: 'sp1', side: 'right', what: 'preview' }] })), [STORE, a.id]);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const split = app.locator('[data-split-id="sp1"]');
  await expect(split.locator('.preview .empty')).toBeVisible();
  await expect(close(app)).toHaveCount(0);
  await split.getByRole('button', { name: 'Close split' }).click();
  await expect(app.locator('[data-split-id]')).toHaveCount(0);
});

for (const how of ['button', 'Escape'] as const) {
  test(`the empty Preview in the side pane closes by ${how}`, async ({ app, core }) => {
    const a = core.agent(core.project('agents'), 'a', 'never-created');
    await openWindow(app, {}, core);
    await app.locator(`.tab[data-tab="${a.id}"]`).click();
    await showPreview(app);
    await expect(app.locator('[data-side-pane] .preview .empty')).toBeVisible();
    if (how === 'button') await close(app).click();
    else (await close(app).focus(), await app.keyboard.press('Escape'));
    await expect(app.locator('.preview')).toHaveCount(0);
  });

  test(`the empty Preview in a layout zone closes by ${how}`, async ({ app, core }) => {
    const a = core.agent(core.project('agents'), 'a', 'never-created');
    await openWindow(app, {}, core);
    await app.locator(`.tab[data-tab="${a.id}"]`).click();
    core.cli('layout', 'split', 'right', 'preview');
    await expect(app.locator('[data-zone-id] .preview .empty')).toBeVisible();
    await expect(close(app)).toHaveCount(1); // one close per zone Preview
    const zones = await app.locator('[data-zone-id]').count();
    if (how === 'button') await close(app).click();
    else (await close(app).focus(), await app.keyboard.press('Escape'));
    await expect(app.locator('.preview')).toHaveCount(0);
    await expect(app.locator('[data-zone-id]')).toHaveCount(zones - 1);
  });
}
