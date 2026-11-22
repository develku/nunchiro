// V2-8b: the PR badge in the chat header. Node side: the age text, the link guard and what renders (no browser).
import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { ageText, PrChip, pullUrl, type PrChipData } from '../src/chat/PrChip';
import { makeT } from './i18n-tables';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const URL = 'https://github.com/develku/nunchiro/pull/12';
// Ticket 167 (e6a4cead) moved the strings to area files that only Vite merges: the node side passes the on-disk catalogue (8aa8da5d).
const t = makeT('en', 'en');
const html = (chip: PrChipData | null) => renderToStaticMarkup(createElement(PrChip, { chip, now: NOW, t }));

test('pr_chip_age_text', () => {
  expect(ageText(ago(20_000), NOW, t)).toBe('just now');
  expect(ageText(ago(10 * MIN), NOW, t)).toBe('10 min ago');
  expect(ageText(ago(3 * 60 * MIN), NOW, t)).toBe('3 h ago');
  expect(ageText(ago(2 * 24 * 60 * MIN), NOW, t)).toBe('2 d ago');
  // An event stored before V2-8b has no time: no age text, never a made-up age.
  expect(ageText(null, NOW, t)).toBe('');
  expect(ageText('not a date', NOW, t)).toBe('');
  expect(html({ state: 'open', url: URL, at: null })).not.toContain('ago');
  expect(html({ state: 'open', url: URL, at: ago(10 * MIN) })).toContain('10 min ago');
});

test('no_pr_in_transcript_no_chip', () => {
  expect(html(null)).toBe('');
});

test('pr_chip_opens_url_only_for_https_github', () => {
  expect(pullUrl(URL)).toBe(URL);
  for (const bad of [
    'http://github.com/o/r/pull/1',
    'javascript:alert(1)',
    'https://evil.example/o/r/pull/1',
    'https://github.com.evil.example/o/r/pull/1',
    'https://github.com/o/r/pull/1?x=1',
    'https://github.com/o/r/issues/1',
    'https://user@github.com/o/r/pull/1',
  ])
    expect(pullUrl(bad), bad).toBeNull();
  // A link that fails the guard is shown as text: no button, no href.
  const text = html({ state: 'open', url: 'http://github.com/o/r/pull/1', at: null });
  expect(text).toContain('Open');
  expect(text).not.toContain('<button');
  expect(html({ state: 'merged', url: URL, at: null })).toContain('<button');
});

// V2-9a follow-up: the core reads up to 20 chat pages per PrChip request, so a burst of tool results costs one request.
chatTest('pr_chip_fetch_is_debounced: 10 tool results within 1 s cause one extra PrChip request after the 2 s trailing delay', async ({ page, chatCore }) => {
  const s = chatCore.chat('alpha', true, false, 'pair'); // ticket 570: one project, so the tabs share a strip
  const other = chatCore.chat('beta', true, false, 'pair');
  let asked = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => (typeof m === 'string' && m.includes('"pr_chip"') && m.includes(s.id) && asked++, server.send(m)));
    server.onMessage((m) => ws.send(m));
  });
  await page.clock.install();
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect.poll(() => asked).toBe(2); // the one on open is immediate: the chat's and the status bar's (CHROME)
  for (let i = 0; i < 10; i++) {
    append(s.file, rec.use(`t${i}`, 'Bash', { command: `echo ${i}` }), rec.result(`t${i}`, `${i}`));
    await expect(view.locator('.tool .tl', { hasText: `echo ${i}` })).toBeVisible();
    await page.clock.fastForward(100);
  }
  await page.clock.fastForward(1500); // 2.5 s since the first result, 1.5 s since the last
  expect(asked).toBe(2);
  await page.clock.fastForward(600);
  await expect.poll(() => asked).toBe(3);
  // A result pending when the chat unmounts (cold for 30 s) never fires.
  await page.locator(`.tab[data-tab="${other.id}"]`).click();
  await page.clock.fastForward(29_000);
  append(s.file, rec.use('late', 'Bash', { command: 'echo late' }), rec.result('late', 'late'));
  await page.waitForTimeout(500); // the core's watcher delivers on the real clock
  await page.clock.fastForward(1500);
  await expect(view).toHaveCount(0);
  await page.clock.fastForward(5000);
  await page.waitForTimeout(300);
  expect(asked).toBe(3);
});

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
chatTest.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});
