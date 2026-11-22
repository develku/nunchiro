// Settings > General > Language (V2-14a; needs 93; needs 144 amended by finding 22: one collapsed picker, v25-fix-settings moved it to
// the first page): the nine choices in their own script, persisted, reachable in 2 clicks, axe clean.
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, agentsZone } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => agentsZone(core));

const NAMES = ['System (English)', 'English', '한국어', '日本語', '简体中文', '繁體中文', 'Español', 'Français', 'Português'];
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const pick = (app: Page) => app.getByRole('combobox', { name: /Language/ });

test('language_list_complete: nine entries, each name in its own script, System checked by default', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const options = pick(app).locator('option');
  await expect(options).toHaveCount(9);
  for (const [i, n] of NAMES.entries()) await expect(options.nth(i)).toHaveText(n);
  await expect(pick(app)).toHaveValue('system');
  await expect(app.getByRole('region', { name: 'Settings' }).getByText(/follows your Mac/)).toBeVisible();
});

test('language_setting_persists: pick a language, reload, the choice is kept', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await pick(app).selectOption('ko');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: '연결됨' })).toBeVisible();
  await expect(app.getByRole('dialog', { name: '설정' })).toBeVisible(); // the modal a reload keeps open (v25f); its gear would shut it. V2.5-54 A12: the rail icon reads Korean now
  await expect(app.getByRole('combobox', { name: /언어/ })).toHaveValue('ko'); // the page was the last one shown
  // The stored choice also restores the translated window text.
  await expect(app.getByRole('navigation', { name: '설정 페이지' }).getByRole('button', { name: '화면과 테마', exact: true })).toBeVisible(); // needs 192 (ticket 250): the page's final name
});

test('language_reachable_in_2_clicks: Settings shows Language on General; the palette command opens it too', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click(); // click 1: the visible labelled control
  await expect(pick(app)).toBeVisible(); // Language sits on General, the first page; the picker is click 2
  await nav(app).getByRole('button', { name: 'Appearance' }).click();
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="settings.general.language"]').click();
  await expect(app.locator('[aria-current="page"]')).toHaveText('General');
  await expect.poll(() => app.evaluate(() => document.activeElement?.matches('select[data-setting="language"]'))).toBe(true);
});

test('language_page_axe_clean: 0 serious or critical', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const r = await new AxeBuilder({ page: app }).include('.settings').analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});

test('no_hardcoded_in_extracted_files: the Settings shell holds no English literal outside the catalogue', () => {
  const src = path.resolve(import.meta.dirname, '../src');
  const files = ['SettingsView.tsx', 'settings/appearance/AppearancePage.tsx'].map((f) => fs.readFileSync(path.join(src, f), 'utf8'));
  // The shell keeps GitBlock/AutoClean (a page body for the Lifetime page, out of this slice): cut them before the check.
  const shell = files[0].split('interface Props')[1] ?? files[0];
  for (const text of [shell, files[1]]) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
    expect([...code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])/g)].map((m) => m[1]), 'JSX text').toEqual([]);
    expect([...code.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)].map((m) => m[1]), 'attributes').toEqual([]);
  }
});
