// V2.5-82 (ticket 303, the two gaps the reviewer saw in lane v25-board-watch-fu's shots): the watch card's subagent toggle names what
// its number counts ("2 subagents", "1 subagent"), and a card title stays readable at the 200 px grid floor of a resized detail
// (wrapped to two lines, the full title in `title`). Real core and board.json seeds; `overlay` only answers the `subagents` read.
// Shots for the REPORT (before / after, light and dark) are written only when BOARD_WATCH_GAPS_SHOTS=<dir> names a folder.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, REPO, test } from './fixtures';
import { agentsInTurn, openBoard, overlay, seed } from './fixtures/board/coord';

test.beforeEach(async ({ app }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
});

const KIDS = [
  { id: 'k1', label: 'Explore: find ssh -G callers', state: 'working', started_at: Math.floor(Date.now() / 1000) - 90 },
  { id: 'k2', label: 'Plan: page layout', state: 'done' },
];
const card = (app: Page, title: string) => app.locator('.board .wcard').filter({ has: app.locator('.wtt', { hasText: title }) });
const detail = (app: Page) => app.getByRole('complementary', { name: 'Card detail' });

/** Drag the detail's edge as far left as it goes: the grid keeps its 200 px floor beside the panel. */
async function toFloor(app: Page) {
  const edge = app.getByRole('separator', { name: 'Resize the card detail' });
  await expect(edge).toBeVisible();
  await app.waitForTimeout(700); // the card's morph into the panel is over: the edge is where it stays
  const box = (await edge.boundingBox())!;
  await app.mouse.move(box.x + 2, box.y + 200);
  await app.mouse.down();
  await app.mouse.move(2, box.y + 200, { steps: 8 });
  await app.mouse.up();
  await expect.poll(async () => Math.round((await app.locator('.board .wcols').boundingBox())!.width)).toBeLessThanOrEqual(202);
}

test('board_watch_subagent_toggle_names_count: the toggle shows the count with a word, its aria-label is the same text, and 1 reads singular', async ({ app, core }) => {
  const p = core.project('demo');
  agentsInTurn(core); // ticket 407: an agent in a turn is under Working; a quiet one is Idle
  const lead = core.agent(p, 'lead', 'x');
  const solo = core.agent(p, 'solo', 'x');
  await overlay(app, { ops: { subagents: (r) => ({ kids: r.id === lead.id ? KIDS : r.id === solo.id ? KIDS.slice(0, 1) : [] }) } });
  await openBoard(app, core);
  const two = app.getByRole('button', { name: '2 subagents' });
  await expect(two).toBeVisible({ timeout: 15_000 });
  await expect(two).toHaveText('2 subagents');
  await expect(two).toHaveAttribute('aria-label', '2 subagents');
  await expect(two.locator('svg')).toHaveCount(1); // the Icon: a chevron that turns when open
  const one = app.getByRole('button', { name: '1 subagent', exact: true });
  await expect(one).toBeVisible();
  await expect(one).toHaveText('1 subagent');
  await expect(one).toHaveAttribute('aria-label', '1 subagent');
  // Open, the list is still named after its card.
  await two.click();
  await expect(app.getByRole('list', { name: 'Subagents of lead' })).toBeVisible();
  await expect(two).toHaveAttribute('aria-expanded', 'true');
});

test('board_watch_card_title_readable_at_floor: at the 200 px grid floor a title wraps to two lines, shows its first two words and keeps the full title in `title`', async ({ app, core }) => {
  const long = 'Ship the parser tests for the whole workspace before the release branch is cut on Friday';
  seed(core, [
    { id: 'a', title: 'Ship the parser tests', column: 'todo' },
    { id: 'b', title: long, column: 'todo' },
    { id: 'c', title: 'alphabetical-parser-lane-number-one', column: 'todo' },
  ]);
  await openBoard(app, core);
  await card(app, 'Ship the parser tests').first().click();
  await expect(detail(app)).toBeVisible();
  await toFloor(app);
  const read = (title: string) =>
    card(app, title)
      .first()
      .locator('.wtt')
      .evaluate((el) => {
        const text = el.firstChild as Text;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.data.split(/[ -]/).slice(0, 2).join(' ').length);
        const box = el.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return {
          title: el.getAttribute('title'),
          height: box.height,
          lineHeight: lh,
          clippedAcross: el.scrollWidth > el.clientWidth + 1,
          firstWordsInside: [...range.getClientRects()].every((r) => r.right <= box.right + 1 && r.bottom <= box.bottom + 1),
        };
      });
  // A short title shows whole, over two lines if it must: not cut sideways by an ellipsis.
  const short = await read('Ship the parser tests');
  expect(short.title).toBe('Ship the parser tests');
  expect(short.clippedAcross).toBe(false);
  expect(short.firstWordsInside).toBe(true);
  expect(short.height).toBeLessThanOrEqual(short.lineHeight * 2 + 1);
  // A long one is held to two lines, its first two words un-truncated, the whole text in `title`.
  const lng = await read('Ship the parser tests for');
  expect(lng.title).toBe(long);
  expect(lng.firstWordsInside).toBe(true);
  expect(lng.height).toBeLessThanOrEqual(lng.lineHeight * 2 + 1);
  expect(lng.height).toBeGreaterThan(lng.lineHeight * 1.5); // it did use the second line
  // A single long word breaks instead of being cut to "alp…".
  const word = await read('alphabetical-parser-lane-number-one');
  expect(word.clippedAcross).toBe(false);
  expect(word.firstWordsInside).toBe(true);
});

test('board_watch_gaps_i18n_8_languages: the subagent count strings exist, one and other, in every language', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/src/i18n/areas/board-watch-shots.ts'), 'utf8');
  for (const lang of ['en', 'ko', 'ja', 'zhHans', 'zhHant', 'es', 'fr', 'pt']) {
    const block = src.split(new RegExp(`export const ${lang} = \\{`))[1]?.split('\n};')[0] ?? '';
    for (const key of ['board.watch.subagents.one', 'board.watch.subagents.other']) {
      const line = block.split('\n').find((l) => l.includes(`"${key}"`));
      expect(line, `${lang} ${key}`).toBeTruthy();
      expect(line, `${lang} ${key} keeps {n}`).toContain('{n}');
    }
  }
});

test('board_watch_toggle_basics: the toggle is a native labelled button: Enter and Space fold it, a visible focus ring on keys, a pointer cursor', async ({ app, core }) => {
  const p = core.project('demo');
  agentsInTurn(core); // ticket 407: an agent in a turn is under Working; a quiet one is Idle
  const lead = core.agent(p, 'lead', 'x');
  await overlay(app, { ops: { subagents: (r) => ({ kids: r.id === lead.id ? KIDS : [] }) } });
  await openBoard(app, core);
  const toggle = app.getByRole('button', { name: '2 subagents' });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  expect(await toggle.evaluate((e) => e.tagName)).toBe('BUTTON');
  await toggle.focus();
  await app.keyboard.press('Tab');
  await app.keyboard.press('Shift+Tab');
  await expect(toggle).toBeFocused();
  expect(await toggle.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
  expect(await toggle.evaluate((e) => getComputedStyle(e).cursor)).toBe('pointer');
  const list = app.getByRole('list', { name: 'Subagents of lead' });
  await app.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await app.keyboard.press('Space');
  await expect(list).toHaveCount(0);
  // The visible text is the accessible name (label in name), and the hover title says the same count.
  await expect(toggle).toHaveText('2 subagents');
  await expect(toggle).toHaveAttribute('title', '2 subagents');
});

