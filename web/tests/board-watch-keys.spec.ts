// V2.5-89 (ticket 303 left three strings with no reader): the dead `board.watch.subs.*` keys are gone, `board-watch-fu.ts` cannot
// declare a key nothing reads again, and the watch card's subagent toggle is named by the same text it shows, in every language.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test } from './fixtures';
import { agentsInTurn, openBoard, overlay } from './fixtures/board/coord';

test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const src = walk(path.join(REPO, 'web/src')).filter((f) => /\.(tsx?|css)$/.test(f));
const catalogue = path.join(REPO, 'web/src/i18n/areas/board-watch-fu.ts');

test('watch_subs_dead_keys_removed: the show, hide and title strings of the old subagent toggle appear nowhere in web/src or web/tests', () => {
  // Built from parts so this file does not contain the names it hunts for.
  const dead = ['show', 'hide', 'title'].map((k) => `board.watch.subs.${k}`);
  const files = [...src, ...walk(path.join(REPO, 'web/tests'))];
  for (const key of dead) {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(`"${key}"`) || fs.readFileSync(f, 'utf8').includes(`'${key}'`));
    expect(hits.map((f) => path.relative(REPO, f)), key).toEqual([]);
  }
});

test('watch_catalogue_has_no_unread_keys: every key board-watch-fu.ts declares is read in web/src outside the i18n catalogues', () => {
  const declared = fs.readFileSync(catalogue, 'utf8').split('interface AreaKeys {')[1]?.split('\n  }')[0].match(/"[\w.]+"(?=: true)/g)?.map((k) => k.slice(1, -1)) ?? [];
  expect(declared.length, 'the AreaKeys block was found').toBeGreaterThan(3);
  const readers = src.filter((f) => !f.includes(`${path.sep}i18n${path.sep}`)).map((f) => fs.readFileSync(f, 'utf8'));
  const unread = declared.filter((k) => !readers.some((s) => s.includes(`'${k}'`) || s.includes(`"${k}"`) || s.includes(`\`${k}\``)));
  expect(unread, 'declared in board-watch-fu.ts, read nowhere').toEqual([]);
});

// The toggle's text for two subagents and for one, per language (literals from the spec, not read back from the catalogue).
const TOGGLE: Record<string, [two: string, one: string]> = {
  en: ['2 subagents', '1 subagent'],
  ko: ['하위 에이전트 2개', '하위 에이전트 1개'],
  ja: ['サブエージェント 2 件', 'サブエージェント 1 件'],
  'zh-Hans': ['2 个子代理', '1 个子代理'],
  'zh-Hant': ['2 個子代理', '1 個子代理'],
  es: ['2 subagentes', '1 subagente'],
  fr: ['2 sous-agents', '1 sous-agent'],
  pt: ['2 subagentes', '1 subagente'],
};
const setLanguage = (app: Page, l: string) =>
  app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), l);

test('watch_subs_toggle_name_matches_text_8_languages: on the rendered card the toggle’s aria-label equals its visible text', async ({ app, core }) => {
  test.setTimeout(180_000);
  const p = core.project('demo');
  agentsInTurn(core); // ticket 407: an agent in a turn is under Working; a quiet one is Idle
  const lead = core.agent(p, 'lead', 'x');
  const solo = core.agent(p, 'solo', 'x');
  const kids = [
    { id: 'k1', label: 'Explore: find ssh -G callers', state: 'working', started_at: Math.floor(Date.now() / 1000) - 90 },
    { id: 'k2', label: 'Plan: page layout', state: 'done' },
  ];
  await overlay(app, { ops: { subagents: (r) => ({ kids: r.id === lead.id ? kids : r.id === solo.id ? kids.slice(0, 1) : [] }) } });
  await openBoard(app, core);
  await expect(app.locator('.board .wsub')).toHaveCount(2, { timeout: 15_000 });
  for (const [language, [two, one]] of Object.entries(TOGGLE)) {
    await setLanguage(app, language);
    await app.reload();
    await expect(app.locator('html')).toHaveAttribute('lang', language);
    const toggles = app.locator('.board .wsub');
    await expect(toggles).toHaveCount(2, { timeout: 15_000 });
    const seen: string[] = [];
    for (const t of await toggles.all()) {
      const text = (await t.innerText()).trim();
      expect(text, language).toBeTruthy();
      await expect(t, language).toHaveAttribute('aria-label', text);
      seen.push(text);
    }
    expect(seen.sort(), language).toEqual([one, two].sort());
  }
});

// Shots for the REPORT (Korean and English, dark, the aria-label printed beside each) only when BOARD_WATCH_KEYS_SHOTS=<dir> names a folder.
test('shots', async ({ app, core }) => {
  const OUT = process.env.BOARD_WATCH_KEYS_SHOTS;
  test.skip(!OUT, 'shots only on request');
  fs.mkdirSync(OUT!, { recursive: true });
  core.agent(core.project('demo'), 'lead', 'x');
  await overlay(app, { ops: { subagents: () => ({ kids: [{ id: 'k1', label: 'Explore: find ssh -G callers', state: 'working' }, { id: 'k2', label: 'Plan: page layout', state: 'done' }] }) } });
  await app.emulateMedia({ colorScheme: 'dark' });
  await openBoard(app, core);
  await expect(app.locator('.board .wsub').first()).toBeVisible({ timeout: 15_000 }); // the board has settled before the language reload
  const labels: Record<string, string> = {};
  for (const language of ['en', 'ko']) {
    await setLanguage(app, language);
    await app.reload();
    const toggle = app.locator('.board .wsub').first();
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    labels[language] = (await toggle.getAttribute('aria-label'))!;
    await app.locator('.board .wcell:has(.wsub)').first().screenshot({ path: path.join(OUT!, `toggle-${language}-dark.png`) });
  }
  fs.writeFileSync(path.join(OUT!, 'labels.json'), JSON.stringify(labels, null, 2));
});
