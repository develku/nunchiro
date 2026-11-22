// v25-empty (needs 140, approved mockup `.scratch/review-1028/v25-mock-a/index.html` draft A and section 3 draft B):
// a session with no messages shows a centred headline + subline, and headings inside an answer rank by size while the
// body keeps its own. Ticket 363 (owner 11-09): the composer left that block for the bottom, so the seat assertions went.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

const size = (el: Locator) => el.evaluate((n) => getComputedStyle(n).fontSize);

test('empty_state_block: the headline is centred above a bottom composer that the first message does not move', async ({ page, chatCore }) => {
  const s = chatCore.chat('lumen', false);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const block = view.locator('.cscroll .empty');
  await expect(block.getByRole('heading')).toHaveText('What should we build in lumen?');
  await expect(block).toContainText('Write what you want the agent to do');
  await expect(block.locator('.composer')).toHaveCount(0);
  const box = page.locator('.wg[data-widget="composer"] .composer');
  const input = box.locator('textarea#composer');
  await expect(input).toBeVisible();
  const top = () => box.evaluate((el) => el.getBoundingClientRect().top);
  const before = await top();
  const area = await view.locator('.cscroll').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  expect(before, 'the composer is under the chat area').toBeGreaterThanOrEqual(area.bottom - 1);
  const head = await block.locator('.ehead').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (r.top + r.bottom) / 2;
  });
  expect(Math.abs(head - (area.top + area.bottom) / 2), 'the headline and hint are centred in the area above it').toBeLessThan(2);
  await input.fill('첫 메시지');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  // The first message lands: the block goes and the composer has not moved.
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  append(s.file, rec.user('첫 메시지'));
  await expect(view.getByText('첫 메시지')).toBeVisible();
  await expect(view.locator('.cscroll .empty')).toHaveCount(0);
  await expect(input).toBeVisible();
  expect(await top(), 'the same y after the first message').toBe(before);
});

test('empty_state_block_dark_and_other_language: the block follows the theme and the UI language', async ({ page, chatCore }) => {
  const s = chatCore.chat('lumen', false);
  await openChat(page, s.id); // the harness waits for the English status line; the language changes after it
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await page.reload();
  const block = chat(page, s.id).locator('.cscroll .empty');
  await expect(block.getByRole('heading')).toHaveText('lumen에서 무엇을 만들까요?');
  const dark = await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className);
  expect(dark, 'dark is the resolved theme').toContain('dark');
});

test('headings_scaled_body_kept: h1/h2/h3 rank by size and the answer body keeps its own', async ({ page, chatCore }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
  const s = chatCore.chat('headings');
  append(s.file, rec.user('show me'), rec.assistant('## Second level\n\nbody words here\n\n### Third level\n\nmore body'));
  await openChat(page, s.id);
  const md = chat(page, s.id).locator('.md').first();
  await expect(md.locator('h2')).toHaveText('Second level');
  expect(await size(md.locator('h2'))).toBe('18px');
  expect(await size(md.locator('h3'))).toBe('15px');
  expect(await size(md.locator('p').first())).toBe('14.5px'); // the body does not grow with the headings
  expect(await size(md)).toBe('14.5px');
});

test('headings_scaled_body_kept_h1: a top-level heading inside an answer reads at 22px', async ({ page, chatCore }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
  const s = chatCore.chat('heading-one');
  append(s.file, rec.user('show me'), rec.assistant('# Top level\n\nbody'));
  await openChat(page, s.id);
  const h1 = chat(page, s.id).locator('.md h1').first();
  await expect(h1).toHaveText('Top level');
  expect(await size(h1)).toBe('22px');
});
