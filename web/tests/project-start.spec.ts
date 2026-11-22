// Ticket 370 item 6: Settings > Onboarding reaches Add project. The native folder panel is the only stand-in.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const panel = (app: Page, answer: string) =>
  app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, answer);
const step = (app: Page) => app.locator('.ob-step[data-step="project"]');
const count = (app: Page) => app.locator('[data-ob-count]');
const settings = (app: Page) => app.getByRole('dialog', { name: 'Settings' });
const chooser = (app: Page) => app.getByRole('dialog', { name: 'Add project', exact: true });
const browse = (app: Page) => chooser(app).getByRole('button', { name: /^Browse folder/ });
const addButton = (app: Page) => app.locator('.ob-panel').getByRole('button', { name: 'Add project' });

test.use({ firstRun: true });

test('onboarding_add_project_closes_settings: the chooser opens over the main window and holds the focus', async ({ app }) => {
  await openWindow(app);
  await expect(step(app)).toHaveAttribute('data-done', 'false');
  await expect(step(app)).toContainText('Add your first project');
  await expect(step(app)).toContainText('Projects');
  await step(app).click();
  await expect(app.locator('.ob-pill')).toHaveText('Not done');
  await app.screenshot({ path: `../.scratch/shots-v28-proj-start/onboard-${test.info().project.name}.png` });

  await addButton(app).click();
  await expect(settings(app)).toHaveCount(0);
  await expect(chooser(app)).toBeVisible();
  await expect(browse(app)).toBeFocused();
});

test('onboarding_project_done_follows_the_list: a folder added from the chooser flips the step and the count', async ({ app, core }) => {
  const picked = core.project('picked');
  await panel(app, picked);
  await openWindow(app);
  await expect(step(app)).toHaveAttribute('data-done', 'false');
  // Ticket 391 (79113197): six steps, seven with ticket 582's first-session step, eight with the keys step (owner 11-16), nine with the assistant step (ticket 1034), none done in a first-run window (the keys step is done only once shown or changed).
  await expect(count(app)).toHaveText('0/9');
  await step(app).click();
  await addButton(app).click();
  await browse(app).press('Enter');
  const tree = path.join(core.home, 'tree.toml'); // written by the first add
  await expect.poll(() => (fs.existsSync(tree) ? fs.readFileSync(tree, 'utf8') : '')).toContain(picked);

  await app.keyboard.press('Escape'); // the New tab popover the added folder opened
  await expect(app.getByRole('dialog', { name: 'New tab' })).toHaveCount(0);
  await app.keyboard.press('Meta+Comma');
  await expect(step(app)).toHaveAttribute('data-done', 'true');
  await expect(count(app)).toHaveText('1/9');
});
