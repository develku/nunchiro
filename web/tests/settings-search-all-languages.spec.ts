// Ticket 556 (scorecard F7): every settings field has search words in all 8 languages, and the Settings search finds a field
// by its words in each language. The words are `searchWords.<field key>` (areas/settings-search-words.ts); a language without
// them would silently fall back to English, so a Korean user would type Korean and find nothing.
import { readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { FIELDS, PAGES, ROW_TITLE } from '../src/settings';
import { expect, openWindow, test } from './fixtures';
import { TABLES } from './i18n-tables';

const LANGS = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const;
type Lang = (typeof LANGS)[number];
const table = (l: Lang) => TABLES[l] as Record<string, string>;
const phrases = (l: Lang, key: string) => (table(l)[`searchWords.${key}`] ?? '').split(',').map((p) => p.trim());

// The feature files register their pages and fields as they load (the Vite build globs them; the node runner does not).
// Load them here, with a stub for the css and markdown imports the node runner cannot read, and leave the registry as found.
registerHooks({ load: (url, ctx, next) => (/\.(css|md)(\?.*)?$/.test(url) ? { format: 'module', source: 'export default ""', shortCircuit: true } : next(url, ctx)) });
let loaded: Promise<typeof FIELDS> | undefined;
function allFields() {
  loaded ??= (async () => {
    const [pages, fields] = [PAGES.length, FIELDS.length];
    const dir = path.resolve(import.meta.dirname, '../src/features');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) await import(path.join(dir, f));
    const all = [...FIELDS];
    PAGES.length = pages; // the registry is module state shared with the other specs of this worker: leave it as found
    FIELDS.length = fields;
    return all;
  })();
  return loaded;
}

test('settings_search_all_languages_at: no field is found by an aria-label, which the page translates', async () => {
  const bad = (await allFields()).filter((f) => f.at.includes('aria-label=')).map((f) => f.key);
  expect(bad, 'fields whose jump selector holds a label in one language; mark the control with data-setting').toEqual([]);
});

// One field per language, its first search phrase in that language, and the page it lives on.
const JUMPS: { lang: Lang; key: string }[] = [
  { lang: 'en', key: 'keepAwake' },
  { lang: 'ko', key: 'startAtLogin' },
  { lang: 'ja', key: 'copyOnSelect' },
  { lang: 'zh-Hans', key: 'scrollback' },
  { lang: 'zh-Hant', key: 'soundDone' },
  { lang: 'es', key: 'maskHistory' },
  { lang: 'fr', key: 'autoPull' },
  { lang: 'pt', key: 'themeMode' },
];

async function openSearch(app: Page, lang: Lang) {
  await openWindow(app); // waits for the English status line
  await app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), lang);
  await app.reload();
  const settings = app.locator(".settings[role='region']");
  await expect(async () => {
    if (!(await settings.isVisible())) await app.keyboard.press('Meta+Comma');
    await expect(settings).toBeVisible({ timeout: 1_000 });
  }).toPass();
  const box = app.getByRole('searchbox', { name: table(lang)['settings.search'] });
  await expect(box).toBeFocused();
  return box;
}

for (const { lang, key } of JUMPS) {
  test(`settings_search_all_languages_jump ${lang}: "${key}" is found by its ${lang} words and the jump lands on its row`, async ({ app, core }) => {
    const field = FIELDS.find((f) => f.key === key)!;
    const label = table(lang)[ROW_TITLE[key] ?? `field.${key}`] ?? ''; // ticket 991 C14: the row's own title
    expect(label, `field.${key} in ${lang}`).not.toBe('');
    core.shell(core.project('demo'), 'alpha');
    const box = await openSearch(app, lang);
    await box.fill(phrases(lang, key)[0]!);
    const hit = app.locator('.smatches .smatch').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ·`) });
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(app.locator(`#snav-${field.page}`)).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => app.evaluate((sel) => !!document.activeElement?.matches(sel), field.at)).toBe(true);
    const row = app.locator('.srow[data-found]');
    await expect(row).toHaveCount(1);
    expect(await row.evaluate((r) => r.contains(document.activeElement))).toBe(true);
  });
}
