// Ticket 503 and ticket 513 (web tails from the 508 review): the chat's Edit row keeps its path on the row's line; a
// missing catalogue line cannot ship looking like a key; widget lines come whole from one language; the gallery has no
// hardcoded Korean; the Korean catalogue says 배치 for layout (docs/i18n-terms.md).
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import type { Rollup } from 'vite';
import { buildQuiet } from './vite-build';
import path from 'node:path';
import { expect as pwExpect, test as pwTest } from '@playwright/test';
import { REPO } from './fixtures';
import { english } from './fixtures/ui-scan';
import { makeT } from '../src/i18n';
import { TABLES } from './i18n-tables';
import { timeLocale } from '../src/widgets/api';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

const SHOTS = path.join(REPO, '.scratch/shots');
const tag = () => `${process.env.SHOT_TAG ?? 'after'}-${test.info().project.name}`;

// 503: in Normal view the Edit row's path button wrapped to its own line under "Edit"; the Read row did not.
test('edit_row_path_on_one_line_503: in Normal view the Edit and Read rows keep the toggle and the path on one line', async ({ page, chatCore }) => {
  const s = chatCore.chat('t503');
  fs.mkdirSync(path.join(s.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(s.cwd, 'src/a.ts'), 'a\n');
  append(
    s.file,
    rec.user('go'),
    rec.use('r1', 'Read', { file_path: `${s.cwd}/src/a.ts` }),
    rec.result('r1', 'a'),
    rec.use('e1', 'Edit', { file_path: `${s.cwd}/src/a.ts`, old_string: 'a', new_string: 'b' }),
    rec.result('e1', 'ok'),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.cview button')).toHaveAttribute('aria-label', /Normal/);
  const work = view.locator('.sum').first();
  if (await work.count()) await work.click();
  await expect(view.locator('.tool .tl-path')).toHaveCount(2);
  fs.mkdirSync(SHOTS, { recursive: true });
  await view.screenshot({ path: path.join(SHOTS, `513-edit-row-${tag()}.png`) });
  for (const name of ['Read', 'Edit']) {
    const row = view.locator('.tool .tl-path', { has: page.locator('.tgl .tn', { hasText: new RegExp(`^${name}$`) }) });
    await expect(row, name).toHaveCount(1);
    const tgl = (await row.locator('.tgl').boundingBox())!;
    const file = (await row.locator('.tpath').boundingBox())!;
    expect(Math.abs(tgl.y + tgl.height / 2 - (file.y + file.height / 2)), `${name}: toggle and path on one line`).toBeLessThan(4);
    expect(file.x, `${name}: path after the toggle`).toBeGreaterThan(tgl.x + tgl.width - 1);
  }
});

// 513 item 2: `makeT` shows the key when no table has the line (a missing key must not crash the window), so a missing
// line looks like `shell.tree.card`; the Korean-window scan flags such a token as a fault, not as code.
pwTest('missing_line_shows_key_and_the_scan_flags_it_513: makeT falls back to the key; a visible key-shaped token is a fault', async ({ page }) => {
  const t = makeT<string>('ko', 'en-US', { en: { 'shell.tree.card': 'In layout' }, ko: {} });
  pwExpect(t('shell.tree.nope')).toBe('shell.tree.nope');
  pwExpect(t('chat.row.gone', { n: 2 })).toBe('chat.row.gone');
  pwExpect(t('shell.tree.card')).toBe('In layout'); // English before the key
  // Keys of two parts, with a hyphen, with a digit part, and declared keys that end like a host or a file are faults; host
  // and file names that start with an area word, paths and code are not.
  await page.setContent(
    '<main lang="ko"><p>배치에 있음</p><p>shell.tree.card</p><p>rest.widgets.gallery.webOff · 웹</p><p>palette.placeholder</p>' +
      '<p>settings.page.inapp-browser,</p><p>pr.tier.0</p><p>about.section.app</p><p>usage.reset.log</p>' +
      '<p>chat.openai.com</p><p>search.brave.com 열기</p><p>git.config.lock</p><p>src/login.ts</p><p>vite.config.ts</p><code>chat.row.done</code>' +
      // 521: a version string (its tail `rc.2` starts with an area word) and a `.v2` name are not keys.
      '<p>Nunchiro 0.9.0-rc.2</p><p>(0.9.0-rc.2)</p><p>-rc.2</p><p>board.v2</p><p>chat.v10 저장</p></main>',
  );
  const bad = (await english(page)).map((w) => w.split(' (')[0]);
  pwExpect(bad).toEqual(['shell.tree.card', 'rest.widgets.gallery.webOff', 'palette.placeholder', 'settings.page.inapp-browser', 'pr.tier.0', 'about.section.app', 'usage.reset.log']);
});

// 513 item 5: docs/i18n-terms.md names layout 배치 in Korean; no Korean line says 레이아웃.
pwTest('korean_layout_is_baechi_513: the Tree card line and every other Korean line say 배치, never 레이아웃', () => {
  const ko = TABLES.ko as Record<string, string>;
  pwExpect(ko['shell.tree.card']).toContain('배치');
  // Ticket 577: `palette.kw.*` are search words, never shown; one may hold the older word a person still types.
  pwExpect(Object.entries(ko).filter(([k, v]) => !k.startsWith('palette.kw.') && v.includes('레이아웃'))).toEqual([]);
});

// ---- 513 items 3 and 4: the widget gallery and placed widgets, mounted with a fake core (widgets-lang-harness.tsx) ----

const WEB = path.resolve(import.meta.dirname, '..');
const HARNESS = '/__widgets-513/';
pwTest.beforeAll(async () => {
  const out = await buildQuiet({
    configFile: path.join(WEB, 'vite.config.ts'),
    root: WEB,
    base: HARNESS,
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: path.join(WEB, 'tests/widgets-lang-harness.html') } },
  });
  for (const o of (Array.isArray(out) ? out : [out as Rollup.RollupOutput]).flatMap((r) => ('output' in r ? r.output : []))) {
    const dest = path.join(WEB, 'dist', HARNESS, o.fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.${process.pid}`, o.type === 'chunk' ? o.code : o.source);
    fs.renameSync(`${dest}.${process.pid}`, dest);
  }
});

/** The harness in one language, with the act hint shown, then a row sent (the sent note) and the ask card pressed. */
async function widgets(page: Page, lang: 'ko' | 'en') {
  await page.goto(`${HARNESS}tests/widgets-lang-harness.html?lang=${lang}`);
  await pwExpect(page.locator('.ugal .wcard[data-card="widget:ok"]')).toBeVisible();
  await pwExpect(page.locator('[data-user-widget="act"] .uw-act')).toBeVisible();
  await pwExpect(page.locator('[data-user-widget="act2"] .uw-act')).toBeVisible();
  await page.locator('[data-user-widget="act"] [data-act-row="0"]').click();
  await pwExpect(page.locator('[data-user-widget="act"] .uw-act')).toHaveAttribute('data-act-note', 'ok');
  await page.locator('.ugal .wcard.ask').click();
  await pwExpect(page.locator('.ugal [role="status"]')).toBeVisible();
}

/** Each widget line (text, and accessible names) with its words in the other language: English in Korean, Hangul in English. */
const mixed = (page: Page, lang: 'ko' | 'en') =>
  page.evaluate((lang) => {
    // Data, not catalogue words: agent and key names, the fixture's widget names, author, session name and the manifest kind id.
    const KEEP = /^(Enter|Claude|Codex|claude|codex|kai|act|act2|new|chg|int|bad|web|ok|target|integration)$/;
    const lines: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.ugal .gsl, .ugal .wcard b, .ugal .wcard .dim, .ugal .wcard .txt, .uw-note, .uw-act, .uw-h .dim')) lines.push(el.innerText);
    for (const el of document.querySelectorAll<HTMLElement>('#root [aria-label], #root [title]')) lines.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '');
    return lines.filter((l) => {
      if (lang === 'en') return /[가-힣]/.test(l);
      const plain = l.replace(/\S*[/.~$=#_@`]\S*/g, ' ').replace(/\([^)]*`[^)]*\)/g, ' ');
      return (plain.match(/[A-Za-z][A-Za-z'-]*[A-Za-z]/g) ?? []).some((w) => w.length > 2 && !KEEP.test(w));
    });
  }, lang);

for (const lang of ['ko', 'en'] as const) {
  pwTest(`widget_lines_one_language_${lang}_513: each widget line comes whole from the ${lang} catalogue`, async ({ page }) => {
    await widgets(page, lang);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.locator('#root').screenshot({ path: path.join(SHOTS, `513-widgets-${lang}-${process.env.SHOT_TAG ?? 'after'}-${pwTest.info().project.name}.png`) });
    pwExpect(await mixed(page, lang)).toEqual([]);
  });
}

// 513 item 4: Gallery.tsx draws no Korean of its own; the gallery's title and ask card come from the catalogue.
pwTest('gallery_has_no_hardcoded_korean_513: Gallery.tsx holds no Hangul; in English the gallery names itself in English', async ({ page }) => {
  const src = fs.readFileSync(path.join(WEB, 'src/widgets/Gallery.tsx'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l));
  pwExpect(src.filter((l) => /[가-힣]/.test(l))).toEqual([]);
  await widgets(page, 'en');
  await pwExpect(page.getByRole('group', { name: 'User widgets' })).toBeVisible();
  await pwExpect(page.locator('.ugal .wcard.ask')).toContainText('Ask an agent');
  await page.goto(`${HARNESS}tests/widgets-lang-harness.html?lang=ko`);
  await pwExpect(page.getByRole('group', { name: '내 위젯' })).toBeVisible();
  await pwExpect(page.locator('.ugal .wcard.ask')).toContainText('에이전트에게');
});

// 513 round 2: widget times follow the system's regional format when it is in the window's language, else the window's.
pwTest('widget_time_locale_513: the system tag in its own language, else the window language', () => {
  pwExpect(timeLocale('en', 'en-GB')).toBe('en-GB');
  pwExpect(new Date(2026, 0, 1, 15, 4, 5).toLocaleTimeString(timeLocale('en', 'en-GB'))).toBe('15:04:05');
  pwExpect(timeLocale('ko', 'en-US')).toBe('ko');
  pwExpect(timeLocale('ko', 'ko-KR')).toBe('ko-KR');
  pwExpect(timeLocale('zh-Hans', 'zh-Hans-CN')).toBe('zh-Hans-CN');
  pwExpect(timeLocale('zh-Hant', 'zh-Hans-CN')).toBe('zh-Hant');
  pwExpect(timeLocale('', 'fr-FR')).toBe('en');
});
