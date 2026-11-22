// Ticket 200 follow-up (needs 171): the file viewer's Find panel speaks the window language, and the "Aa" toggle is named.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openFile, setup, view } from './fixtures/files/harness';
// The node runner has no import.meta.glob, so the merged catalogue holds no area: read the area files themselves.
import * as base from '../src/i18n/areas/fileview-find';

const LONG = Array.from({ length: 60 }, (_, i) => `line ${i + 1}${[5, 40].includes(i + 1) ? ' needle here' : ''}`).join('\n') + '\n';
const extra = (dir: string) => fs.writeFileSync(path.join(dir, 'long.txt'), LONG);
// The window opens in English (its test fixtures wait for that wording), then restarts in the stored language.
const inLanguage = async (app: Page, language: string) => {
  await app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), language);
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', language);
};
async function openPanel(app: Page, core: Parameters<typeof setup>[1], language?: string) {
  await setup(app, core, { extra });
  if (language) await inLanguage(app, language); // the reload keeps Files open on its bar
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click();
  await app.keyboard.press('Meta+KeyF');
  const panel = v.locator('.fv-find');
  await expect(panel).toBeVisible();
  return { v, panel };
}

// Every visible and accessible string of the panel, read from the page. "Aa" is the toggle's glyph and "esc" is the house's
// key label (keys.ts KEY_LABEL), so neither is a word to translate.
const panelStrings = (panel: Locator) =>
  panel.evaluate((root) => {
    const out: string[] = [];
    for (const e of [root, ...root.querySelectorAll('*')]) {
      for (const a of ['aria-label', 'placeholder', 'title', 'data-tip']) if (e.getAttribute(a)) out.push(e.getAttribute(a)!);
      if (e.children.length === 0 && e.textContent) out.push(e.textContent);
    }
    return out.filter((s) => s !== 'Aa').map((s) => s.replace(/\(esc\)/, ''));
  });
const english = (strings: string[]) => strings.filter((s) => /[A-Za-z]{2,}/.test(s));

async function expectKorean(panel: Locator) {
  const strings = await panelStrings(panel);
  expect(english(strings), JSON.stringify(strings)).toEqual([]);
  await expect(panel).toHaveAttribute('aria-label', base.ko['fvfind.label']);
  await expect(panel.getByRole('searchbox', { name: base.ko['fvfind.find'] })).toHaveAttribute('placeholder', base.ko['fvfind.find']);
  for (const k of ['fvfind.case', 'fvfind.previous', 'fvfind.next', 'fvfind.close'] as const) await expect(panel.getByRole('button', { name: base.ko[k] })).toHaveAttribute('data-tip', new RegExp(`^${base.ko[k]}`));
  await expect(panel.getByRole('status')).toHaveText('2개 중 1번째');
}

test('fileview_find_panel_translated_ko', async ({ app, core }) => {
  // A window that starts in Korean ...
  const { panel } = await openPanel(app, core, 'ko');
  await panel.locator('input').fill('needle');
  await expectKorean(panel);
});

test('fileview_find_panel_follows_language_switch', async ({ app, core }) => {
  // ... and one switched to Korean (Settings sets <html lang>) while the viewer and its panel are open.
  const { panel } = await openPanel(app, core);
  await panel.locator('input').fill('needle');
  await expect(panel.getByRole('status')).toHaveText('1 of 2');
  await app.evaluate(() => (document.documentElement.lang = 'ko'));
  await expectKorean(panel);
  await app.evaluate(() => (document.documentElement.lang = 'en'));
  await expect(panel.getByRole('button', { name: 'Match case' })).toHaveAttribute('data-tip', 'Match case');
});

test('fileview_find_case_toggle_named', async ({ app, core }) => {
  const { panel } = await openPanel(app, core);
  const aa = panel.getByRole('button', { name: 'Match case' });
  await expect(aa).toHaveText('Aa');
  await expect(aa).toHaveAttribute('data-tip', 'Match case');
  await expect(aa).not.toHaveAttribute('title', /.+/); // the house tooltip, not the slow native one
  await expect(aa).toHaveAttribute('aria-pressed', 'false');
  await aa.click();
  await expect(aa).toHaveAttribute('aria-pressed', 'true');
  await aa.click();
  await expect(aa).toHaveAttribute('aria-pressed', 'false');
  // The other buttons use the same tooltip, with their key.
  await expect(panel.getByRole('button', { name: 'Next match' })).toHaveAttribute('data-tip', /Next match.*↵/);
});

test('fileview_find_words_i18n_8_languages', () => {
  // Every key the panel reads (the phrase map in Code.tsx) is in all eight languages, and none is empty or English left over.
  const used = [...fs.readFileSync(path.join(import.meta.dirname, '../src/files/Code.tsx'), 'utf8').matchAll(/t\('(fvfind\.[a-z]+)'\)/g)].map((m) => m[1]);
  expect(used.sort()).toEqual(Object.keys(base.en).sort());
  const langs = { en: base.en, ko: base.ko, ja: base.ja, zhHans: base.zhHans, zhHant: base.zhHant, es: base.es, fr: base.fr, pt: base.pt } as Record<string, Record<string, string>>;
  expect(Object.keys(langs)).toHaveLength(8);
  for (const [lang, table] of Object.entries(langs)) {
    expect(Object.keys(table).sort(), lang).toEqual(used);
    for (const k of used) expect(table[k]?.trim(), `${lang} ${k}`).toBeTruthy();
  }
  for (const lang of ['ko', 'ja', 'zhHans', 'zhHant']) for (const k of used) expect(langs[lang][k], `${lang} ${k}`).not.toBe(base.en[k as keyof typeof base.en]);
});
