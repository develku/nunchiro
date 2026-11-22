// Ticket 471: shots of each changed screen, dark and light (not assertions). Run with SHOTS=1; SHOT_TAG names the copy
// (before on the base, after on the lane's head).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { closeModal, openSettings } from './settings-modal';

const OUT = path.join(REPO, '.scratch/shots');

test('raw words screens', async ({ app, core }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });
  const tag = process.env.SHOT_TAG ?? 'after';
  core.shell(core.project('demo'), 'build');
  await openWindow(app, {}, core);
  for (const theme of ['dark', 'light']) {
    const shot = (name: string) => app.screenshot({ path: path.join(OUT, `471-${name}-${theme}-${tag}.png`) });
    await app.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await shot('status-bar');
    await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
    const board = app.locator('.board');
    await expect(board).toBeVisible();
    await board.getByRole('button', { name: 'Edit board widget' }).click();
    await expect(app.getByRole('dialog', { name: 'Edit board widget' })).toBeVisible();
    await shot('board-edit');
    await closeModal(app);
    await openSettings(app);
    const nav = app.getByRole('navigation', { name: 'Settings pages' });
    for (const id of ['general', 'terminal', 'history', 'keys', 'extensions']) {
      await nav.locator(`button[data-page="${id}"]`).click();
      await expect(app.locator('.spage h1').first()).toBeVisible();
      if (id === 'extensions') await app.locator('[data-mcp="own"]').scrollIntoViewIfNeeded();
      await shot(`settings-${id}`);
    }
    await closeModal(app);
  }
});
