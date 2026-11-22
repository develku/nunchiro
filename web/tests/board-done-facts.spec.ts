// V2.5-34 (needs 149): the Done card's PR lines. Node side: the cache and the markup against a fake core (no browser, no gh).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CoreClient, PrView } from '../src/api';
import { DoneFacts } from '../src/board/DoneFacts';
import { kindOf, kindOfChip, loadPrView } from '../src/board/prFacts';
import { makeT, mergeAreas, type AreaFile } from '../src/i18n';
import * as chatBase from '../src/i18n/areas/chat-base';
import * as boardDone from '../src/i18n/areas/board-done';
import * as boardCard from '../src/i18n/areas/board-card';

const URL = 'https://github.com/develku/nunchiro/pull/12';
// The node runner has no import.meta.glob, so the area files this card reads are merged by hand.
const LANGS = { en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} };
const tables = mergeAreas(LANGS, { './areas/chat-base.ts': chatBase as AreaFile, './areas/board-done.ts': boardDone as AreaFile, './areas/board-card.ts': boardCard as AreaFile });
const t = makeT('en', 'en', tables as never);
const view = (o: Partial<PrView>): PrView => ({
  url: URL, number: 12, title: 'Add the PR view', state: 'MERGED', draft: false, author: 'develku', body: '', created_at: '2026-10-30T10:00:00Z',
  head: '0123456789abcdef0123456789abcdef01234567', head_ref: 'herdr/v25-pr-view', base_ref: 'main', review: 'APPROVED', mergeable: 'UNKNOWN',
  checks: 'pass', additions: 120, deletions: 34, labels: [], reviewers: [], timeline: [], files: [{ path: 'a', additions: 1, deletions: 0 }], diff: '', diff_cut: false, ...o,
});
/** A core that answers `prView` from `reply` and counts the asks. */
const fake = (reply: () => PrView | Error) => {
  const core = { asked: 0, prView: async () => { core.asked++; const r = reply(); if (r instanceof Error) throw r; return r; } };
  return core as typeof core & CoreClient;
};
const render = (core: CoreClient, chipState: 'merged' | 'open' = 'merged') =>
  renderToStaticMarkup(createElement(DoneFacts, { t, core, chip: { state: chipState, url: URL, at: null }, number: '12', updatedAt: Date.now() - 3 * 86_400_000 }));

test('done_card_facts: a merged PR reads "Merged #12" in violet, the checks and +/- lines; the quiet line has when and commit', async () => {
  const core = fake(() => view({}));
  await loadPrView(core, URL);
  const html = render(core);
  expect(html).toContain('Merged #12');
  expect(html).toContain('color:var(--done)');
  expect(html).toContain('aria-label="All checks passing"'); // the check icon's name; no words on the line
  expect(html).toContain('data-icon="check"');
  expect(html).toContain('+120');
  expect(html).toContain('−34');
  expect(html).toMatch(/3 d ago · 0123456/);
});

test('done_card_facts: an open PR shows its state, failing checks and no violet', async () => {
  const core = fake(() => view({ state: 'OPEN', checks: 'fail', additions: 3, deletions: 1 }));
  await loadPrView(core, URL);
  const html = render(core, 'open');
  expect(html).toContain('Open #12');
  expect(html).toContain('aria-label="Checks failing"');
  expect(html).toContain('data-icon="x"');
  expect(html).not.toContain('var(--done)');
  expect(kindOf(view({ state: 'OPEN', draft: true }))).toBe('draft');
  expect(kindOf(view({ state: 'CLOSED' }))).toBe('closed');
});

// The narrowest column the board gives a card: grid-auto-columns minmax(180px, 1fr) in columns.css.
test('done_card_one_line: a Merged card\'s fact line is one line at the narrowest column width, with the check icon', async ({ page }) => {
  const css = ['tokens.css', 'board/board.css'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '../src', f), 'utf8')).join('\n');
  const core = fake(() => view({}));
  await loadPrView(core, URL);
  await page.setContent(`<style>${css} body{margin:0;font-family:system-ui}</style><div class="bcard" style="width:180px;box-sizing:border-box">${render(core)}<span class="bfact" id="probe"><i>x</i></span></div>`);
  const fact = page.locator('.bfact').first();
  await expect(fact.locator('svg[data-icon="check"]')).toBeVisible();
  await expect(fact).toContainText('+120 −34');
  const box = await fact.boundingBox();
  const one = await page.locator('#probe').boundingBox(); // a fact line holding a single word is one line box
  expect(box!.height, 'one line box').toBeCloseTo(one!.height, 0);
  // Every item sits on the same row.
  const tops = await fact.locator(':scope > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
  expect(new Set(tops).size, `item centres ${tops}`).toBe(1);
});

test('done_card_facts: with gh off the transcript badge still gives the state', async () => {
  const core = fake(() => new Error('off: the PR view uses your gh; turn on live PR status first'));
  expect(await loadPrView(core, URL)).toBeNull();
  const html = render(core, 'merged');
  expect(html).toContain('Merged #12');
  expect(html).not.toContain('+120');
  expect(html).not.toContain('Details'); // nothing to open without the view
  expect(kindOfChip({ state: 'checks_fail', url: URL, at: null })).toEqual({ kind: 'open', checks: 'fail' });
});

test('merged_cached: a merged PR is read once; an open one again only after the minute', async () => {
  const merged = fake(() => view({}));
  for (let i = 0; i < 5; i++) await loadPrView(merged, URL, 1_000_000 + i * 3_600_000);
  expect(merged.asked).toBe(1);
  let state: PrView['state'] = 'OPEN';
  const open = fake(() => view({ state }));
  await loadPrView(open, URL, 0);
  await loadPrView(open, URL, 30_000);
  expect(open.asked).toBe(1);
  state = 'MERGED';
  await loadPrView(open, URL, 61_000);
  expect(open.asked).toBe(2);
  await loadPrView(open, URL, 120_000_000);
  expect(open.asked).toBe(2); // merged now: never again
  // Two cards mounting together share one ask.
  const twin = fake(() => view({}));
  await Promise.all([loadPrView(twin, URL), loadPrView(twin, URL)]);
  expect(twin.asked).toBe(1);
});

test('lift_notices: each lifted file names its upstream path, commit and MIT notice, and THIRD_PARTY_NOTICES lists it', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/board/prFacts.ts'), 'utf8');
  for (const needle of ['apps/web/src/components/pullRequest/pullRequestIcons.tsx', 'd14ace8233ad3cf7856b6b834824f888240d67a1', 'T3 Tools Inc.', 'src/renderer/src/components/pr-check-counts.ts', '2eb0bb637dff41925d8ffa22ff9054ab656e4816', 'Lovecast Inc.', 'MIT License', 'THE SOFTWARE IS PROVIDED "AS IS"']) expect(src).toContain(needle);
  const notices = fs.readFileSync(path.join(import.meta.dirname, '../../THIRD_PARTY_NOTICES.md'), 'utf8');
  expect(notices).toMatch(/`web\/src\/board\/prFacts\.ts`[^\n]*pullRequestIcons\.tsx[^\n]*pr-check-counts\.ts[^\n]*d14ace8[^\n]*2eb0bb63/);
});
