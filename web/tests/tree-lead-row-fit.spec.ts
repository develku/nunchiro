// Look 1117 v13 A S2-2 (third time): a working Lead's tree row read "Le…". The row is rendered node side with every part
// at once (the "!" bypass mark, "<1 min", the level's bars and the model and effort, the sub-agent count) in the app's own
// CSS, at the tree's default width (250 px). The name is the last thing to give way: the pair goes first, down to its bars.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { rowState } from '../src/tree';
import { WtRow } from '../src/tree/RowIcon';
import { KidCount } from '../src/tree/kids';
import type { Session } from '../src/types';
import { makeT } from './i18n-tables';

const t = makeT('en', 'en');
const NOW = Date.now();
const CSS = ['tokens.css', 'styles.css', 'tree/tree.css', 'lead/lead.css', 'chat/perm-chip.css'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '../src', f), 'utf8')).join('\n');

// Whether a part's box is short of its own text (the ellipsis shows).
const cut = (e: Element) => e.scrollWidth > e.clientWidth;

const lead = (name: string) => {
  const s = { id: 's-lead', kind: 'claude', project: '/p', cwd: '/p', label: name, state: 'running', permission_mode: 'bypass permissions', level: 'standard', model: 'sonnet', effort: 'medium', pending: [], attention: { working: true, waiting: false, stale: false, failed: false, last_activity: NOW } } as unknown as Session;
  const state = rowState({ path: 'main:s-lead', name, sessions: [s] } as never, [s], undefined, NOW, undefined, t);
  const kids = [{ id: 'k1', state: 'working', started_at: NOW / 1000 - 5 }, { id: 'k2', state: 'done' }] as never;
  return renderToStaticMarkup(
    createElement('div', { className: 'sess' }, createElement('span', { className: 'wtwrap' }, createElement(WtRow, { name, state, sessionId: s.id, since: NOW - 20_000, seat: s, t }), createElement(KidCount, { ids: [s.id], name, kids, open: false, onToggle: () => {}, over: true, t }))),
  );
};

test('lead_row_name_whole_when_working: "!", "<1 min", bars, model and effort and the sub-agent count all show; the name is not cut, the pair gives way', async ({ page }) => {
  await page.setContent(`<style>${CSS}</style><aside class="dock l" style="width:250px"><nav class="tree">${lead('Lead')}${lead('Release notes and changelog writer')}</nav></aside>`);
  const rows = page.locator('.row.wt2');
  const first = rows.nth(0);
  for (const part of ['.skipm', '.tm', '.lvl', '.lvl-pair']) await expect(first.locator(part), part).toBeVisible();
  await expect(first.locator('.ic'), 'ticket 1041: a working row has no arc; its light and age say it').toHaveCount(0);
  await expect(first.locator('.sdot')).toHaveAttribute('data-dot', 'run'); // design book: the working dot
  await expect(page.locator('.kidcount').first()).toHaveText('↳ 2');
  await expect(first.locator('.tm')).toHaveText(/^\d+:\d\d$/); // design book: the working row's elapsed time, 0:20
  expect(await first.locator('.tm').evaluate(cut), 'the age is cut while the pair can still give way').toBe(false);
  // The name's box holds the whole word: no wrap into the clamped second line ("Le…"), no width short of the text.
  const fit = (nm: string) => page.locator('.row.wt2 .nm', { hasText: nm }).evaluate((e) => {
    const whole = document.createElement('span');
    whole.style.cssText = 'position:absolute;white-space:nowrap;font:inherit';
    whole.textContent = e.textContent;
    e.parentElement!.appendChild(whole);
    const need = whole.getBoundingClientRect().width;
    whole.remove();
    return { wraps: e.scrollHeight > e.clientHeight + 1, short: need - e.getBoundingClientRect().width };
  });
  const lead1 = await fit('Lead');
  expect(lead1.wraps, 'the name wraps into the clamp').toBe(false);
  expect(lead1.short, 'px the name box is short of its text').toBeLessThanOrEqual(0.5);
  // The pair gave way (its box is narrower than its whole text) and is still drawn.
  const pair = await first.locator('.lvl-pair').evaluate((e) => e.scrollWidth - e.clientWidth);
  expect(pair).toBeGreaterThan(0);
  // A name too long for the row is cut, but only once the pair is down to its bars.
  const second = rows.nth(1);
  expect((await fit('Release notes and changelog writer')).wraps).toBe(true);
  expect(await second.locator('.lvl-mark').evaluate((e) => Math.round(e.getBoundingClientRect().width))).toBeLessThanOrEqual(12);
});

// Ticket 995: at the tree's narrowest width (SIDEBAR_MIN, 208 px) the same row read "L…". The name wins: once the pair is
// down to its bars, the age gives way next, and the sub-agent count keeps its place.
test('lead_row_name_whole_at_narrowest_tree: at 208 px the age gives way, not the name', async ({ page }) => {
  await page.setContent(`<style>${CSS}</style><aside class="dock l" style="width:208px"><nav class="tree">${lead('Lead')}</nav></aside>`);
  const row = page.locator('.row.wt2');
  const nm = row.locator('.nm');
  expect(await nm.evaluate((e) => e.scrollHeight > e.clientHeight + 1), 'the name wraps into the clamp ("L…")').toBe(false);
  expect(await nm.evaluate(cut), 'the name is cut').toBe(false);
  // Ticket 1041: the working arc left the row, so at 208 px the pair may keep part of its words; the order holds: the age
  // gives way only once the pair is down to its bars.
  if (await row.locator('.tm').evaluate(cut)) expect(await row.locator('.lvl-mark').evaluate((e) => Math.round(e.getBoundingClientRect().width))).toBeLessThanOrEqual(12);
  else expect(await row.locator('.lvl-pair').evaluate((e) => e.scrollWidth - e.clientWidth), 'the pair gives way first').toBeGreaterThan(0);
  await expect(page.locator('.kidcount')).toHaveText('↳ 2');
  await expect(page.locator('.kidcount')).toBeVisible();
});
