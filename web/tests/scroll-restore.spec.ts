// v25-scroll-restore-fu (ticket 297 items 10 and 11, ticket 282 item 1): the shell's scroll restore (chrome/scrollKeep.ts) for a deep
// place in a long history, and for a chat that was closed and opened again. The first restore spec is in shell-chrome-r2.spec.ts
// (`scroll_restored_per_session`, 120 short messages).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, REPO } from './fixtures';
import { append, chat, openChat, rec, test } from './fixtures/chat/harness';

const WINDOW_KEY = 'nunchiro.window.v1';
const connected = (p: Page) => expect(p.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
const saved = (p: Page, id: string) => p.evaluate(([k, i]) => JSON.parse(localStorage.getItem(k) ?? '{}').scroll?.[i] as number | undefined, [WINDOW_KEY, id]);

/** Messages of very different heights (1 to 12 wrapped lines), so the list's 36 px estimate is far from the real row sizes. */
const longHistory = (n: number) => Array.from({ length: n }, (_, i) => rec.assistant(`H${i} ${'wrapped words '.repeat((i * 7) % 12 * 6)}end`));

/** The message number of the row at the top edge of the view: where the reader is, in rows rather than pixels. */
const topRow = (scroller: Locator) =>
  scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    for (const r of el.querySelectorAll<HTMLElement>('.crow')) if (r.getBoundingClientRect().bottom > top + 4) return Number(/^H(\d+) /.exec(r.textContent ?? '')?.[1] ?? -1);
    return -1;
  });

/** The chat event key of the row at the top edge, as the shell saves it (chrome/scrollKeep.ts placeOf). */
const topKey = (scroller: Locator) =>
  scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    for (const r of el.querySelectorAll<HTMLElement>('.crow')) if (r.getBoundingClientRect().bottom > top + 1) return Number(r.dataset.key);
    return -1;
  });
/** The row key in a saved place (PLACE + key * ROW + offset, chrome/scrollKeep.ts); -1 for none or a pixel offset. */
const savedKey = (v: number | undefined) => (v === undefined || v < 2 ** 40 ? -1 : Math.floor((v - 2 ** 40) / 4096));

/** Walks up from the bottom the way a reader does (the list measures the rows it passes), then stops on a real wheel event. */
async function scrollUpTo(page: Page, scroller: Locator, row: number) {
  await scroller.hover();
  await scroller.evaluate(async (el, to) => {
    const top = () => {
      const t = el.getBoundingClientRect().top;
      for (const r of el.querySelectorAll<HTMLElement>('.crow')) if (r.getBoundingClientRect().bottom > t + 4) return Number(/^H(\d+) /.exec(r.textContent ?? '')?.[1] ?? -1);
      return -1;
    };
    for (let i = 0; i < 4000 && top() > to; i++) {
      el.scrollTop -= el.clientHeight * 0.9;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }, row);
  await page.mouse.wheel(0, -1);
  await page.waitForTimeout(60);
}

test('scroll_restore_deep_history: a place far up in a 2000-message history comes back after a reload, not the bottom', async ({ page, chatCore }) => {
  test.setTimeout(120_000);
  const s = chatCore.chat('deep');
  append(s.file, longHistory(2000));
  await openChat(page, s.id);
  const scroller = chat(page, s.id).locator('.cscroll');
  await expect(chat(page, s.id).getByText(/^H1999 /)).toBeVisible();
  await scrollUpTo(page, scroller, 700);
  const before = await topRow(scroller);
  expect(before).toBeGreaterThan(600);
  expect(before).toBeLessThan(800);
  // Ticket 540: the shell saves 150 ms after the last scroll (chrome/scrollKeep.ts SAVE_MS), and a slow frame during the walk up
  // saves a place on the way. Any place is > 1000, so wait for the saved row to be the one at the top now, not just any place.
  const key = await topKey(scroller);
  await expect.poll(async () => savedKey(await saved(page, s.id)), { timeout: 5000 }).toBe(key);
  await page.reload();
  await connected(page);
  await expect(chat(page, s.id).locator('.clist')).toHaveAttribute('aria-busy', 'false');
  // Back at the same message (within a few rows), and not at the bottom.
  await expect.poll(async () => Math.abs((await topRow(chat(page, s.id).locator('.cscroll'))) - before), { timeout: 20_000 }).toBeLessThan(4);
  expect(await chat(page, s.id).locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(1000);
});

test('scroll_restore_after_tab_reopen: a chat closed and opened again comes back to its place', async ({ page, chatCore }) => {
  test.setTimeout(120_000);
  const a = chatCore.chat('reopen', true, false, 'scroll'); // ticket 570: one project, so the tabs share a strip
  const others = Array.from({ length: 9 }, (_, n) => ({ ...chatCore.chat(`other-${n}`, true, false, 'scroll'), label: `other-${n}` }));
  for (const o of others) append(o.file, [rec.assistant(`${o.label} only`)]);
  append(a.file, longHistory(300));
  await openChat(page, a.id);
  const scroller = chat(page, a.id).locator('.cscroll');
  await expect(chat(page, a.id).getByText(/^H299 /)).toBeVisible();
  await scrollUpTo(page, scroller, 120);
  const before = await topRow(scroller);
  expect(before).toBeGreaterThan(60);
  await expect.poll(() => saved(page, a.id), { timeout: 5000 }).toBeGreaterThan(1500);
  // Close the tab (the session keeps running). The chat view keeps the last eight chats it showed in memory (ChatView `kept`);
  // nine other chats opened and closed push this one out, so the reopened chat has to find its place from the window's saved one.
  const tab = page.locator(`.tab[data-tab="${a.id}"]`);
  const close = async (id: string) => (await page.locator(`.tab[data-tab="${id}"]`).hover(), await page.locator(`.tab[data-tab="${id}"] ~ button.x`).click());
  await close(a.id);
  await expect(tab).toHaveCount(0);
  for (const o of others) {
    await page.locator(`.tab[data-tab="${o.id}"]`).click();
    await expect(chat(page, o.id).getByText(`${o.label} only`)).toBeVisible();
    await close(o.id);
  }
  for (let n = 0; n < others.length + 1 && !(await tab.count()); n++) {
    await page.keyboard.press('Shift+Meta+KeyT'); // newest first: the nine others come back before this one
    await page.waitForTimeout(150);
  }
  await expect(tab).toBeVisible();
  await expect(chat(page, a.id).locator('.clist')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => Math.abs((await topRow(chat(page, a.id).locator('.cscroll'))) - before), { timeout: 20_000 }).toBeLessThan(4);
  expect(await chat(page, a.id).locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(500);
});

// Dead code left by the shell-chrome and quiet-chat lanes (ticket 297 items 7 and 12): source greps, no browser. Each pattern is
// something that had a user once and has none now; a file that brings one back has to say why.
const SRC = path.join(REPO, 'web', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const allSource = (dir = ''): string[] =>
  fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allSource(path.join(dir, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [path.join(dir, e.name)] : []));

test('shell_chrome_dead_code_removed: the blue bar on the open icon and the chat resume strip have no CSS left', () => {
  const css = allSource().filter((f) => f.endsWith('.css'));
  const all = css.map(read).join('\n');
  expect(all.match(/\.ai(\.lay)?\[aria-pressed='true'\]::before/)?.[0]).toBeUndefined(); // the filled accent icon replaced the 3 px bar (ticket 284)
  expect(all.match(/^\.resume\s*\{/m)?.[0]).toBeUndefined(); // the strip over the chat (ticket 282 item 3)
});

test('quiet_chat_should_7: the chat no longer sends a decision-line event, so nothing listens for one', () => {
  const all = allSource().map(read).join('\n');
  expect(all.includes('DECISIONS_OPEN')).toBe(false);
  expect(all.includes('nunchiro:decisions.open')).toBe(false);
});
