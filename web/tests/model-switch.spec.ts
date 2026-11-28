// Ticket 357: a model turned off leaves every list that offers one (380: the composer's too). A session running on it keeps its
// chip and its menu row, a stored default keeps working (marked) until changed, and "Default" and the typed name stay.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openRow } from './accounts-rows';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';
import { startOf } from './start-op';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
const start = (core: Core, ...flags: string[]) => core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude', ...flags).session as { id: string };
// Ticket 391: the old Accounts (model list) and Agents (default model) pages are both the Claude card on Providers.
const page = async (app: Page, _old: 'Accounts' | 'Agents') => {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
};
const models = (app: Page) => app.locator('#s-accounts [data-field="models"]');
const defaultModel = (app: Page) => app.getByRole('combobox', { name: 'Default model and effort · Claude' });
const labels = (app: Page) => defaultModel(app).locator('option').allTextContents();

test('model_switch_reaches_new_session_choices_and_not_a_running_session', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  const s = start(core, '--model', 'haiku');
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  await page(app, 'Accounts');
  await openRow(app, 'Claude');
  await expect(models(app)).toContainText('On 4/4');
  await models(app).getByRole('switch', { name: 'Haiku' }).click();
  await expect(models(app)).toContainText('On 3/4');
  await expect(models(app)).toContainText('A model that is turned off is not offered for new sessions.');

  // The defaults picker no longer offers it; Default and "Type a model" stay.
  await page(app, 'Agents');
  await expect.poll(() => labels(app)).not.toContain('Haiku');
  expect(await labels(app)).toEqual(expect.arrayContaining(['Fable', 'Opus', 'Sonnet']));
  await closeSettings(app);

  // The running session keeps its chip and can still pick it in its own menu.
  const chip = app.locator('[data-picker="model"]');
  await expect(chip).toHaveText('Claude · Haiku');
  await chip.click();
  await expect(app.locator('[data-menu="model"]')).toContainText('Haiku');
  await app.keyboard.press('Escape');

  // A new session in that project does not inherit the off model.
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: /^Claude/ }).first().click();
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; model?: string | null }[]).filter((x) => x.id !== s.id).map((x) => x.model ?? null)).toEqual([null]);
});

test('model_turned_off_leaves_the_composer_menu_and_returns_when_turned_on', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  const s = start(core);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  const chip = app.locator('[data-picker="model"]');
  const haiku = app.locator('[data-menu="model"]').getByRole('menuitemradio', { name: 'Haiku' });
  const toggle = async () => {
    await page(app, 'Accounts');
    await openRow(app, 'Claude');
    await models(app).getByRole('switch', { name: 'Haiku' }).click();
    await closeSettings(app);
  };
  await toggle();
  await chip.click();
  await expect(app.locator('[data-menu="model"]').getByRole('menuitemradio', { name: 'Sonnet' })).toBeVisible();
  await expect(haiku).toHaveCount(0);
  await app.keyboard.press('Escape');
  await toggle();
  await chip.click();
  await expect(haiku).toBeVisible();
});

test('a_default_model_session_passes_its_effort_on', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  const s = start(core, '--effort', 'high');
  const starts: { model?: string | null; effort?: string | null }[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const request = typeof f.payload === 'string' && f.payload.includes('"op":"start"') ? JSON.parse(f.payload).request : null;
      // Since #57 the New tab menu sends its start as `start_or_wait`, the start inside it.
      const start = startOf(request);
      if (start) starts.push(start.session);
    }),
  );
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: /^Claude/ }).first().click();
  await expect.poll(() => starts.at(-1)).toMatchObject({ model: null, effort: 'high' });
});

test('stored_default_keeps_working_marked_off_and_all_off_leaves_default', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await page(app, 'Agents');
  await defaultModel(app).selectOption('sonnet');
  await page(app, 'Accounts');
  await openRow(app, 'Claude');
  await models(app).getByRole('button', { name: 'Turn all off' }).click();
  await expect(models(app)).toContainText('On 0/4');
  await expect(models(app).getByRole('button', { name: 'Turn all on' })).toBeVisible();

  await page(app, 'Agents');
  await expect(defaultModel(app)).toHaveValue('sonnet');
  await expect.poll(() => labels(app)).toEqual(['Agent default', 'Sonnet (off)', 'Type a model…']);
  // Changing it away means it cannot be picked back.
  await defaultModel(app).selectOption('');
  await expect.poll(() => labels(app)).toEqual(['Agent default', 'Type a model…']);

  await page(app, 'Accounts');
  await openRow(app, 'Claude');
  await models(app).getByRole('button', { name: 'Turn all on' }).click();
  await expect(models(app)).toContainText('On 4/4');
});
