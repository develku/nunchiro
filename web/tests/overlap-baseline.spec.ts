// V2.5-34 (ticket 291 item 3): the overlap ratchet only ever shrinks. Two promises:
//  - overlap_baseline_has_no_stale_lines: every line of scripts/overlap.baseline still offends (a fixed pair is deleted).
//  - chat_copy_bar_clear_of_text / chat_copy_bar_hover_only: the message Copy bar, shown, covers no text and stays one line
//    that takes clicks only on hover (commit 0ebb7a73).
// `scan` below is a copy of the one in overlap-check.spec.ts: a spec file cannot be imported from another spec (the reason
// ux-states.ts copies the dead-click test the same way). Keep the two in step.
import { expect, seed, STATES, test, type Ctx } from './ux-states';

const WIDTHS = [900, 1440];

const state = (name: string) => STATES.find((s) => s.name === name)!;

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
