// Ticket 410 (Diff half): the Diff options bar's collapse-unchanged toggle and Settings > Appearance > Diff's switch
// are one stored value (diff.collapse_unchanged): a change on either side shows on the other, live.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { closeSettings } from './settings-modal';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

const LINES = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
const body = (lines: string[]) => lines.join('\n') + '\n';
const stored = async (app: Page) => (await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'))).features ?? {};
const bar = (app: Page) => app.getByRole('region', { name: 'Diff view' }).locator('.dbar');
const diffButton = (app: Page) => app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
const appearance = async (app: Page) => {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(app.locator('.settings > nav')).toBeVisible();
  await app.locator('.settings > nav button[data-page="appearance"]').click();
  return app.locator('[data-setting="diffCollapse"]');
};
const backToDiff = async (app: Page) => {
  await closeSettings(app);
  if (!(await app.getByRole('complementary', { name: 'Diff', exact: true }).isVisible())) await diffButton(app).click();
};

test('diff_collapse_toggle_shares_settings_switch: the bar toggle and the Settings switch read and write one value', async ({ app, core }) => {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), body(LINES));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  core.shell(dir, 'core-serve');
  const l = [...LINES];
  l[9] = 'changed10';
  fs.writeFileSync(path.join(dir, 'a.txt'), body(l));

  await openWindow(app);
  await diffButton(app).click();
  await app.getByRole('list', { name: 'Changed files' }).locator('[data-path="a.txt"]').click();
  const view = app.getByRole('region', { name: 'Diff of a.txt' });
  await expect(view.locator('table.dl')).toBeVisible();
  const toggle = bar(app).getByRole('button', { name: 'Collapse unchanged lines' });
  const folds = view.getByRole('button', { name: 'Show 2 lines' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(folds).toHaveCount(0);

  // Keyboard: the toggle takes focus and Enter turns it on; the unchanged runs fold and the value is stored.
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(folds).toHaveCount(2);
  await expect.poll(async () => (await stored(app))['diff.collapse_unchanged']).toBe(true);

  // Settings shows the same state; turning it off there turns the bar toggle off and unfolds the file, without a reload.
  const sw = await appearance(app);
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await expect.poll(async () => (await stored(app))['diff.collapse_unchanged']).toBe(false);
  await backToDiff(app);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(folds).toHaveCount(0);
  await expect(view.locator('tr.context')).toHaveText([/line7/, /line8/, /line9/, /line11/, /line12/, /line13/]);

  // The reverse: on in Settings, on in the bar.
  await (await appearance(app)).check();
  await backToDiff(app);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(folds).toHaveCount(2);
  // And the bar's click turns the Settings switch off.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(await appearance(app)).not.toBeChecked();
});
