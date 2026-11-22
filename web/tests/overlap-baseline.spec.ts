// V2.5-34 (ticket 291 item 3): the overlap ratchet only ever shrinks. Two promises:
//  - overlap_baseline_has_no_stale_lines: every line of scripts/overlap.baseline still offends (a fixed pair is deleted).
//  - chat_copy_bar_clear_of_text / chat_copy_bar_hover_only: the message Copy bar, shown, covers no text and stays one line
//    that takes clicks only on hover (commit 0ebb7a73).
// `scan` below is a copy of the one in overlap-check.spec.ts: a spec file cannot be imported from another spec (the reason
// ux-states.ts copies the dead-click test the same way). Keep the two in step.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO } from './fixtures';
import { expect, seed, STATES, test, type Ctx } from './ux-states';

const WIDTHS = [900, 1440];

/** Runs in the page. Returns the offender lines of the current screen (same rules as overlap-check.spec.ts). */
const scan = (page: Page, state: string, width: number) =>
  page.evaluate(
    ([state, width]) => {
      const ux = (window as unknown as { __ux: { css(e: Element): string; NATIVE: string } }).__ux;
      const ALLOW = ['.xterm, canvas', '[role="tooltip"], .tip', '.toast', 'svg', '.sr, .sr-only'].join(', ');
      const LAYERS = '[role="menu"], [role="dialog"], [role="listbox"], [role="alertdialog"], .cmenu';
      const CONTROL = `${ux.NATIVE}, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="link"], [role="checkbox"], [role="switch"], [role="treeitem"]`;
      type Item = { el: Element; r: DOMRect };
      const clipped = (el: Element, r: DOMRect) => {
        let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
        for (let a: Element | null = el; a; a = a.parentElement) {
          const st = getComputedStyle(a);
          if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
          const b = a.getBoundingClientRect();
          x0 = Math.max(x0, b.left); y0 = Math.max(y0, b.top); x1 = Math.min(x1, b.right); y1 = Math.min(y1, b.bottom);
        }
        x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, innerWidth); y1 = Math.min(y1, innerHeight);
        return x1 > x0 && y1 > y0 ? new DOMRect(x0, y0, x1 - x0, y1 - y0) : null;
      };
      const items: Item[] = [];
      const add = (el: Element, r: DOMRect) => {
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0' || el.closest(ALLOW)) return;
        const c = clipped(el, r);
        if (c) items.push({ el, r: c });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim() || !n.parentElement || /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(n.parentElement).visibility !== 'hidden') add(n.parentElement, r);
      }
      for (const el of Array.from(document.body.querySelectorAll(CONTROL))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) add(el, r);
      }
      const out = new Set<string>();
      for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
          if (a.el.closest(LAYERS) !== b.el.closest(LAYERS)) continue;
          const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (w < 3 || h < 3 || w * h < 0.1 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) continue;
          const top = document.elementFromPoint(Math.max(a.r.left, b.r.left) + w / 2, Math.max(a.r.top, b.r.top) + h / 2);
          if (!top || !(a.el.contains(top) || b.el.contains(top))) continue;
          out.add([ux.css(a.el), ux.css(b.el)].sort().join('|'));
        }
      return [...out].map((l) => `${state}|${width}|${l}`);
    },
    [state, width] as const,
  );

const state = (name: string) => STATES.find((s) => s.name === name)!;

test('overlap_baseline_has_no_stale_lines: every line of scripts/overlap.baseline still offends', async ({ page, chatCore }) => {
  // V2.5-34: the baseline is empty, so nothing can be stale; the 240 s walk of every state would only re-prove the other tests.
  test.skip(fs.readFileSync(path.join(REPO, 'scripts/overlap.baseline'), 'utf8').split('\n').every((l) => !l.trim()), 'scripts/overlap.baseline is empty: no line can be stale');
  test.setTimeout(240_000);
  const c = await seed(page, chatCore, true);
  const found: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const s of STATES) {
      await s.enter(c).catch((e) => { throw new Error(`state ${s.name} at ${width}px: ${String(e).slice(0, 400)}`); });
      found.push(...(await scan(page, s.name, width)));
    }
  }
  // Every found line is "new" against an empty baseline, so overlap-check.sh prints exactly the found list.
  const dir = path.join(REPO, '.scratch');
  fs.mkdirSync(dir, { recursive: true });
  const empty = path.join(dir, `overlap-empty-${process.pid}.baseline`);
  const list = path.join(dir, `overlap-baseline-found-${process.pid}.txt`);
  fs.writeFileSync(empty, '');
  fs.writeFileSync(list, [...new Set(found)].map((l) => `${l}\n`).join(''));
  const r = spawnSync('sh', [path.join(REPO, 'scripts/overlap-check.sh'), empty, list], { encoding: 'utf8' });
  fs.rmSync(empty, { force: true });
  fs.rmSync(list, { force: true });
  const offending = new Set(r.stderr.split('\n').filter((l) => l.startsWith('overlap: ') && l.includes('|')).map((l) => l.slice('overlap: '.length)));
  const baseline = fs.readFileSync(path.join(REPO, 'scripts/overlap.baseline'), 'utf8').split('\n').filter(Boolean);
  expect(baseline.filter((l) => !offending.has(l)), 'baseline lines that no longer offend: delete them').toEqual([]);
});

/** The seeded chat of `session-decision` (two messages), at `width`, with the live line under them. The state's pending
 *  decision keeps the real line away (ChatView `working` is false while a decision waits, ticket 212), so the line's markup
 *  (ChatView `Working`: a `.wline` of a `.wtime` span) is put into the always-present `.wlive` region to measure the bar against it. */
async function decisionChat(c: Ctx, width: number) {
  await c.page.setViewportSize({ width, height: 800 });
  await state('session-decision').enter(c);
  const chat = c.page.locator(`.chat[data-session="${c.beta}"]`);
  await expect(chat.locator('.message-row')).toHaveCount(2);
  await chat.locator('.wlive').evaluate((e) => e.replaceChildren(Object.assign(document.createElement('div'), { className: 'wline', innerHTML: '<span class="wtime">Working for 12s</span>' })));
  await expect(chat.locator('.wlive .wline')).toBeVisible();
  return chat;
}

for (const width of WIDTHS) {
  test(`chat_copy_bar_clear_of_text: the shown Copy bar covers no text of any row or of the live line (${width}px)`, async ({ page, chatCore }) => {
    const c = await seed(page, chatCore, true);
    const chat = await decisionChat(c, width);
    const rows = chat.locator('.message-row');
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).hover();
      const bar = rows.nth(i).locator('.message-actions');
      await expect(bar).toHaveCSS('opacity', '1');
      // Every text line of the chat (its transcript and live line), minus the bar's own text, against the bar's box.
      const hits = await chat.evaluate((root, i) => {
        const b = root.querySelectorAll('.message-row')[i].querySelector('.message-actions')!.getBoundingClientRect();
        const out: string[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement;
          if (!n.textContent?.trim() || !el || el.closest('.message-actions') || getComputedStyle(el).visibility === 'hidden') continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          // A line counts across the full width of its block: a longer message would run under the bar too.
          let blk: Element = el;
          while (getComputedStyle(blk).display === 'inline' && blk.parentElement) blk = blk.parentElement;
          const bb = blk.getBoundingClientRect();
          for (const r of Array.from(range.getClientRects())) {
            const w = Math.min(b.right, bb.right) - Math.max(b.left, bb.left);
            const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
            if (w > 1 && h > 1) out.push(`${el.className || el.tagName}: ${n.textContent!.trim().slice(0, 30)}`);
          }
        }
        return out;
      }, i);
      expect(hits, `row ${i}'s Copy bar covers text`).toEqual([]);
    }
  });
}

test('chat_copy_bar_hover_only: the bar is one line, hidden and inert at rest, clickable on hover or when focused', async ({ page, chatCore }) => {
  const c = await seed(page, chatCore, true);
  const chat = await decisionChat(c, 900);
  const row = chat.locator('.message-row').first(); // the user's bubble: the narrowest row, where a wrapping bar would grow tall
  const bar = row.locator('.message-actions');
  const inert = () => bar.evaluate((e) => getComputedStyle(e).pointerEvents);
  // At rest.
  await page.mouse.move(0, 0);
  await expect(bar).toHaveCSS('opacity', '0');
  expect(await inert()).toBe('none');
  // Hover: shown, takes clicks (the point at its middle hits the bar), one line (every button on one row of pixels).
  await row.hover();
  await expect(bar).toHaveCSS('opacity', '1');
  expect(await inert()).toBe('auto');
  const box = (await bar.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.message-actions') !== null, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toBe(true);
  const btns = await bar.locator('.btn').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; }));
  expect(new Set(btns.map((b) => b.top)).size, 'the bar wraps onto more than one line').toBe(1);
  expect(Math.max(...btns.map((b) => b.h)), 'a button grew tall (its label wrapped)').toBeLessThan(32);
  expect(await bar.evaluate((e) => e.scrollWidth <= e.clientWidth), 'the buttons are squeezed or spill out of the bar').toBe(true);
  expect(box.height).toBeLessThan(40);
  // Focus on the bar itself (Tab to a button): shown and clickable, with the pointer elsewhere.
  await page.mouse.move(0, 0);
  await bar.getByRole('button', { name: 'Copy message', exact: true }).focus();
  await expect(bar).toHaveCSS('opacity', '1');
  expect(await inert()).toBe('auto');
});
