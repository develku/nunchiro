// ticket 291 item 3 (needs 210): the overlap check. In each state of web/tests/ux-states.ts, at 900 and 1440 px, every pair
// of visible text and controls whose boxes intersect is an offender `<state>|<width>|<css path A>|<css path B>` (paths
// sorted), unless one holds the other (ancestor/descendant) or the pair is on the allow-list below.
// scripts/overlap.baseline lists today's offenders; the spec fails on one that is not listed (scripts/overlap-check.sh).
// OVERLAP_WRITE=1 rewrites the baseline from the offenders found now (first generation only); OVERLAP_BASELINE names another
// baseline file (the scenario test points it at an empty one to see every offender of an old build).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO } from './fixtures';
import { expect, seed, STATES, test } from './ux-states';

const BASELINE = process.env.OVERLAP_BASELINE ?? path.join(REPO, 'scripts/overlap.baseline');
const FOUND = path.join(REPO, '.scratch/overlap.found');
const WIDTHS = [900, 1440];

/** Runs in the page. Returns the offender lines of the current screen. */
const scan = (page: Page, state: string, width: number) =>
  page.evaluate(
    ([state, width]) => {
      const ux = (window as unknown as { __ux: { css(e: Element): string; NATIVE: string } }).__ux;
      // Allow-list: a selector whose subtree is drawn by something else or overlaps by design. Each has its reason.
      const ALLOW = [
        '.xterm, canvas', // terminal text is painted by xterm; its rows are not boxes of ours
        '[role="tooltip"], .tip', // a tooltip floats over what it describes
        '.toast', // a toast floats over the screen
        'svg', // icon glyphs sit inside their button (a badge on an icon)
        '.sr, .sr-only', // text for screen readers only: clipped to a pixel, drawn over the control it labels
      ].join(', ');
      // A floating layer (menu, dialog, listbox) lies over the page by design: a pair with one side in a layer and the other
      // outside it is no clash. Two items inside the same layer are still compared.
      const LAYERS = '[role="menu"], [role="dialog"], [role="listbox"], [role="alertdialog"], .cmenu';
      const CONTROL = `${ux.NATIVE}, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="link"], [role="checkbox"], [role="switch"], [role="treeitem"]`;
      type Item = { el: Element; r: DOMRect };
      const clipped = (el: Element, r: DOMRect) => {
        // The part of the box inside the element's own and every ancestor's clip or scroll box; null when nothing is left.
        let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
        for (let a: Element | null = el; a; a = a.parentElement) { // the element itself too: overflow hidden cuts its own text
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
          // Tolerance: a few px of glyph or border overlap is not a clash; the shared part must cover 10% of the smaller box.
          if (w < 3 || h < 3 || w * h < 0.1 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) continue;
          // Painted over by something else (a modal, a menu) at the middle of the shared part: nothing clashes on screen.
          const top = document.elementFromPoint(Math.max(a.r.left, b.r.left) + w / 2, Math.max(a.r.top, b.r.top) + h / 2);
          if (!top || !(a.el.contains(top) || b.el.contains(top))) continue;
          out.add([ux.css(a.el), ux.css(b.el)].sort().join('|'));
        }
      return [...out].map((l) => `${state}|${width}|${l}`);
    },
    [state, width] as const,
  );

function ratchet(found: string[]) {
  const now = [...new Set(found)].sort();
  if (process.env.OVERLAP_WRITE) return void fs.writeFileSync(path.join(REPO, 'scripts/overlap.baseline'), now.map((l) => `${l}\n`).join(''));
  fs.mkdirSync(path.dirname(FOUND), { recursive: true });
  fs.writeFileSync(FOUND, now.map((l) => `${l}\n`).join(''));
  const r = spawnSync('sh', [path.join(REPO, 'scripts/overlap-check.sh'), BASELINE, FOUND], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}

test('overlap_scan_finds_text_over_a_button_and_spares_a_contained_one', async ({ page }) => {
  await page.goto('about:blank');
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__ux = {
      css: (e: Element) => e.tagName.toLowerCase() + [...e.classList].map((c) => `.${c}`).join(''),
      NATIVE: 'button, a[href], input, select, textarea, summary, label[for], option',
    };
  });
  await page.setContent(`<div style="position:relative;height:80px">
    <button class="mode" style="position:absolute;left:10px;top:10px;width:120px;height:30px">Transcript view</button>
    <div class="note" style="position:absolute;left:20px;top:14px">2 lines skipped</div>
    <button class="ok" style="position:absolute;left:200px;top:10px;width:120px;height:30px"><span>inside</span></button></div>`);
  expect(await scan(page, 's', 900)).toEqual(['s|900|button.mode|div.note']);
});

test('overlap_scan_ignores_text_cut_off_by_its_own_ellipsis', async ({ page }) => {
  // Round 2 (review SHOULD): a span with overflow hidden + text-overflow ellipsis shows only its own box; the rest of its
  // text range is not drawn, so it does not run under the buttons beside it (the tree's decision text, .sess .q .qt).
  await page.goto('about:blank');
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__ux = {
      css: (e: Element) => e.tagName.toLowerCase() + [...e.classList].map((c) => `.${c}`).join(''),
      NATIVE: 'button, a[href], input, select, textarea, summary, label[for], option',
    };
  });
  await page.setContent(`<div style="display:flex;width:300px">
    <span class="qt" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Do you trust the files in this folder and everything below it, really?</span>
    <button class="qib" style="width:60px;height:24px">Allow</button></div>
    <div style="position:relative;height:60px"><span class="spill" style="position:absolute;left:0;top:30px;white-space:nowrap">text that spills out of its box</span>
    <button class="under" style="position:absolute;left:20px;top:30px;width:80px;height:20px">Go</button></div>`);
  // The ellipsis span is spared; a span without overflow clipping that spills over a button is still found.
  expect(await scan(page, 's', 900)).toEqual(['s|900|button.under|span.spill']);
});

test('overlap_gate: every state at 900 and 1440 px passes against scripts/overlap.baseline', async ({ page, chatCore }) => {
  test.setTimeout(240_000);
  const c = await seed(page, chatCore, true);
  const found: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const state of STATES) {
      await state.enter(c).catch((e) => { throw new Error(`state ${state.name} at ${width}px: ${String(e).slice(0, 400)}`); });
      // Scan a painted frame: between frames a row that just grew still sits on the row below it, until the frame's
      // resize callback moves that row (the chat list does it before paint).
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      found.push(...(await scan(page, state.name, width)));
    }
  }
  ratchet(found);
});
