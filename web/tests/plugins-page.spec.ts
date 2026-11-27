// Settings > Plugins (docs/design/extensibility-m6): the example plugin from docs/api/examples, copied into a real core's
// home, is listed off and not approved; Review shows exactly what it runs; approving turns it on; a setting is saved by
// the core; the plugin's command is a palette row tagged with its name and its output shows as a note.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings, closeSettings } from './settings-modal';

const EXAMPLE = path.resolve(import.meta.dirname, '../../docs/api/examples/plugins/quiet-hours');

function install(core: Core) {
  const to = path.join(core.home, 'plugins/quiet-hours');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(EXAMPLE)) fs.copyFileSync(path.join(EXAMPLE, f), path.join(to, f));
}
async function page(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="plugins"]').click();
  const row = app.locator('.plg[data-plugin="quiet-hours"]');
  await expect(row).toBeVisible();
  return row;
}

test('plugins_page_review_approve_and_settings', async ({ app, core }) => {
  install(core);
  await openWindow(app);
  const row = await page(app);
  await expect(row).toContainText('Quiet hours');
  await expect(row).toContainText('1 panel · 1 command · 2 settings');
  await expect(row).toContainText('Not approved');
  await expect(row.getByRole('switch', { name: 'Turn Quiet hours on' })).not.toBeChecked();

  await row.getByRole('button', { name: 'Review Quiet hours' }).click();
  const sheet = app.locator('.ps');
  await expect(sheet.getByRole('heading')).toHaveText('Allow “quiet-hours”?');
  await expect(sheet.locator('[data-field="parts"]')).toContainText('/bin/sh panel.sh');
  await expect(sheet.locator('[data-field="parts"]')).toContainText('/bin/sh status.sh');
  await expect(sheet).toContainText('~/.nunchiro/plugins/quiet-hours/');
  await expect(sheet.locator('[data-field="part-rights"]').first()).toContainText('No network');
  await expect(sheet.locator('[data-field="read"]')).toBeVisible();
  await sheet.getByRole('button', { name: 'Allow read only' }).click();
  await expect(row).toContainText('Approved');
  await expect(row.getByRole('switch', { name: 'Turn Quiet hours on' })).toBeChecked();

  const from = row.getByRole('textbox', { name: 'Quiet hours: Quiet from' }).or(row.getByLabel('Quiet hours: Quiet from'));
  await expect(from).toHaveValue('22:00');
  await from.fill('21:30');
  await from.press('Enter');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'plugins.json'), 'utf8')).settings?.['quiet-hours']?.start).toBe('21:30');
});

test('plugins_page_says_which_switch_is_off', async ({ app, core }) => {
  install(core);
  await openWindow(app);
  const row = await page(app);
  await expect(row.locator('.swhy')).toContainText('Script widgets');
});

test('plugin_command_in_the_palette_shows_its_output', async ({ app, core }) => {
  install(core);
  core.run(['plugin', 'allow', 'quiet-hours']);
  core.run(['plugin', 'on', 'quiet-hours']);
  core.run(['serve', 'stop'], 10_000);
  const settings = JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8'));
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ ...settings, script_widgets: true }));
  await core.restart();
  await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(app);
  await closeSettings(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: /search/i }).fill('quiet time');
  const option = app.locator('[data-command="plugin.quiet-hours.status"]');
  await expect(option).toContainText('Quiet hours: am I in quiet time?');
  await expect(option.locator('.branch')).toHaveText('Quiet hours');
  await option.click();
  await expect(app.getByText(/Quiet hours: (Quiet time until|Not quiet time)/)).toBeVisible();
});

test('plugins_page_shots @shots', async ({ app, core }) => {
  install(core);
  await openWindow(app);
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    const row = await page(app);
    await expect(row).toBeVisible();
    await app.screenshot({ path: `../.scratch/shots/plugins-page-${scheme}.png` });
    await row.getByRole('button', { name: 'Review Quiet hours' }).click();
    await expect(app.locator('.ps [data-field="parts"]')).toContainText('status.sh');
    await app.screenshot({ path: `../.scratch/shots/plugins-sheet-${scheme}.png` });
    await app.getByRole('button', { name: 'Cancel' }).click();
  }
});

test('plugin_panel_placed_in_the_layout_runs_and_shows', async ({ app, core }) => {
  install(core);
  core.run(['plugin', 'allow', 'quiet-hours']);
  core.run(['plugin', 'on', 'quiet-hours']);
  core.run(['serve', 'stop'], 10_000);
  const settings = JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8'));
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ ...settings, script_widgets: true }));
  await core.restart();
  await openWindow(app, core.boot(), core);
  core.cli('layout', 'split', 'right', 'widget:plugin__quiet-hours__now', '--zone', 'terminal');
  await expect(app.locator('[data-user-widget="plugin__quiet-hours__now"]')).toContainText('quiet from');
  expect(fs.readFileSync(path.join(core.home, 'layout.toml'), 'utf8')).toContain('widget:plugin__quiet-hours__now');
});

test('plugin_sheet_reads_row_lists_a_declared_folder', async ({ app, core }) => {
  const dir = path.join(core.home, 'plugins/reader');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.toml'), 'id = "reader"\nname = "Reader"\nversion = "1.0.0"\n\n[[command]]\nname = "sync"\ncommand = ["/bin/sh", "s.sh"]\nshow = "send"\nread = ["~/notes"]\nnetwork = ["api.github.com"]\n');
  fs.writeFileSync(path.join(dir, 's.sh'), '#!/bin/sh\necho hi\n');
  await openWindow(app);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="plugins"]').click();
  await app.locator('.plg[data-plugin="reader"]').getByRole('button', { name: 'Review Reader' }).click();
  const sheet = app.locator('.ps');
  await expect(sheet.locator('[data-field="read"]')).toContainText('~/notes');
  await expect(sheet.locator('[data-field="part-rights"]')).toContainText('Network: api.github.com');
  await expect(sheet.locator('[data-field="part-rights"]')).toContainText("message box as a draft");
});

test('plugin_palette_row_shot @shots', async ({ app, core }) => {
  install(core);
  core.run(['plugin', 'allow', 'quiet-hours']);
  core.run(['plugin', 'on', 'quiet-hours']);
  core.run(['serve', 'stop'], 10_000);
  const settings = JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8'));
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ ...settings, script_widgets: true }));
  await core.restart();
  await openWindow(app, core.boot(), core);
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('combobox', { name: /search/i }).fill('quiet');
    await expect(app.locator('[data-command="plugin.quiet-hours.status"]')).toBeVisible();
    await app.screenshot({ path: `../.scratch/shots/plugins-palette-${scheme}.png` });
    await app.keyboard.press('Escape');
  }
});
