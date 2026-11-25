// UI language, V2-14b (needs 93; tickets 116, 117): palette titles and chrome, <html lang>, one Lifetime title, axe.
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, stripOnTop } from './fixtures';

const src = path.resolve(import.meta.dirname, '../src');
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const palette = (app: Page) => app.getByRole('dialog', { name: 'Command palette' });

test.describe('window', () => {
  test.beforeEach(({ core }) => stripOnTop(core));

  test('palette_settings_titles_follow_language (page): "Settings: Title bar" opens Appearance on the field', async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.keyboard.press('Meta+KeyK');
    await palette(app).getByRole('combobox').fill('Settings: Title bar');
    await expect(palette(app).getByRole('option', { name: /Settings: Title bar/ })).toBeVisible();
    await app.keyboard.press('Enter');
    await expect(app.locator('[aria-current="page"]')).toHaveText('Appearance');
    await expect.poll(() => app.evaluate(() => document.activeElement?.matches('input[name="titlebar"]'))).toBe(true);
  });

  test('html_lang_follows_choice (page): 한국어 sets lang to ko; English restores en', async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('combobox', { name: /Language/ }).selectOption('ko');
    await expect.poll(() => app.evaluate(() => document.documentElement.lang)).toBe('ko');
    await app.getByRole('combobox', { name: /언어/ }).selectOption('en');
    await expect.poll(() => app.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  test('language_still_reachable_in_2_clicks: Settings, Language; the palette entry "Settings: Language" too', async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(app.getByRole('combobox', { name: /Language/ })).toBeVisible(); // on General, the first page (v25-fix-settings)
    await nav(app).getByRole('button', { name: 'Appearance' }).click();
    await app.keyboard.press('Meta+KeyK');
    await palette(app).getByRole('option', { name: /^Settings: Language/ }).click();
    await expect(app.locator('[aria-current="page"]')).toHaveText('General');
  });

  test('lifetime_title_single_source (page): the old Lifetime page is now General (v25-fix-settings)', async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await nav(app).getByRole('button', { name: 'General' }).click();
    await expect(app.getByRole('region', { name: 'Settings' }).getByRole('heading', { level: 1 })).toHaveText(/^General/); // needs 192 (ticket 250): the page title is the h1
  });

  test('palette_axe_clean: 0 serious or critical on the open palette', async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.keyboard.press('Meta+KeyK');
    await expect(palette(app)).toBeVisible();
    const r = await new AxeBuilder({ page: app }).include('.palette').analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
});

test('lifetime_title_single_source (grep): LIFETIME_TITLE appears nowhere in web/src or web/tests', () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(e.name) && !p.endsWith('ui-language-b.spec.ts') && fs.readFileSync(p, 'utf8').includes('LIFETIME_' + 'TITLE')) hits.push(p);
    }
  };
  walk(src);
  walk(path.resolve(import.meta.dirname));
  expect(hits).toEqual([]);
});

test('palette_chrome_from_catalogue: Palette.tsx holds no English literal outside the catalogue', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  const code = strip(fs.readFileSync(path.join(src, 'Palette.tsx'), 'utf8'));
  expect([...code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])/g)].map((m) => m[1]), 'JSX text').toEqual([]);
  expect([...code.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)].map((m) => m[1]), 'attributes').toEqual([]);
  // The check sees a literal: a mutated copy fails it.
  const bad = strip(`<input aria-label="Command palette search" />`);
  expect([...bad.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)].length).toBe(1);
});
