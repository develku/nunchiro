// V1A-52 (owner pass 2026-10-26): hint labels sat on the start of a tab or project name, so a 1-3 character name was
// hidden whole. A label now sits beside such a name; V1A-48/49 rules stay: labels never overlap each other and every
// visible target keeps one.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';
import { openQuiet } from './tree-seed';

type Box = { x: number; y: number; w: number; h: number };
const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The glyph boxes of each tab and project name (a project button reads `a · main`), outside nested buttons such as the close x. */
const names = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-hint-kind="tab"], [data-hint-kind="project"]')].map((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const boxes: { x: number; y: number; w: number; h: number }[] = [];
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent?.trim() || n.parentElement?.closest('button') !== (el.matches('button') ? el : null)) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const b of r.getClientRects()) boxes.push({ x: b.left, y: b.top, w: b.width, h: b.height });
      }
      return { name: el.textContent!.replace('×', '').trim(), boxes };
    }),
  );

/** Every target the user can see, by a 6 px hit-test grid (as qa-ui.spec.ts): independent of Hints.tsx's sampling. */
const seen = (page: Page) =>
  page.evaluate(() => {
    const sel = 'button:not(:disabled), a[href], input:not([type=hidden]):not(:disabled), textarea:not(.xterm-helper-textarea):not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"]), .term, [data-hint-kind]';
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest('[hidden], .hints-layer, .hint-preview, .hk-board, .xterm')) continue;
      // Ticket 389's rules, as qa-ui.spec.ts: no label on drag edges, marked duplicates, row parts, hover-only, panes, quiet.
      const row = '[data-hint-kind="project"], [data-hint-kind="agent"], [data-hint-kind="session"]';
      // Ticket 408: nor on a control marked unusable or an ended session's read-only terminal.
      if (el.closest('[data-hint-skip], [role="separator"], [aria-disabled="true"]') || el.matches('.roterm .term') || el.parentElement?.closest(row) || el.matches('[data-hint-kind="pane"]')) continue;
      if (el.closest('[data-hint-quiet]') && !el.matches('[data-hint-kind="tab"]')) continue;
      if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      let hit = false;
      for (let y = Math.max(r.top, 0) + 0.5; y < Math.min(r.bottom, innerHeight) && !hit; y += 6)
        for (let x = Math.max(r.left, 0) + 0.5; x < Math.min(r.right, innerWidth) && !hit; x += 6) {
          const top = document.elementFromPoint(x, y);
          hit = !!top && el.contains(top);
        }
      if (hit) n++;
    }
    return n;
  });

test('hints-short-names: 1-3 character tab and project names stay readable, no label overlaps, every target labelled', async ({ app, core }) => {
  for (const p of ['a', 'bc', 'def']) for (const s of ['x', 'yz', 'abc']) core.shell(core.project(p), s);
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  await expect(app.locator('.grp[data-project] .row.head')).toHaveCount(3); // sample after the tree's first render, not before
  const visible = await seen(app);
  const text = await names(app);
  // Ticket 570 (265cd9cde): the strip shows only the selected project's three tabs, beside the three project names.
  expect(text.filter((t) => t.boxes.length).map((t) => t.name.replace(/^shell · /, '').split(' ')[0]).sort()).toEqual(['a', 'abc', 'bc', 'def', 'x', 'yz']);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint').first()).toBeVisible();
  const labels = await app.$$eval('.hint[data-kind="element"]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { label: (e as HTMLElement).dataset.hint!, x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );
  const hidden = text.flatMap((t) => labels.filter((l) => t.boxes.some((b) => meets(l, b))).map((l) => `${l.label} on "${t.name}"`));
  expect(hidden).toEqual([]);
  const overlaps = labels.flatMap((a, i) => labels.slice(i + 1).filter((b) => meets(a, b)).map((b) => `${a.label}/${b.label}`));
  expect(overlaps).toEqual([]);
  expect(labels.length).toBe(visible);
  await app.screenshot({ path: path.join(REPO, '.scratch/shots/v1a-52', `hints-short-names-${test.info().project.name}.png`) });
});

test('hints-long-project-name: a project name wider than its row keeps its start readable when no free spot exists', async ({ app, core }) => {
  // Rows stacked tight, each name wider than its row: the spots above, below and beside are taken by the neighbours' labels.
  const long = Array.from({ length: 8 }, (_, i) => `nunchiro-realwindow-owner-check-${i}`);
  for (const p of long) core.shell(core.project(p), 'gui');
  await openWindow(app);
  const visible = await seen(app);
  const text = await names(app);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint').first()).toBeVisible();
  const labels = await app.$$eval('.hint[data-kind="element"]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { label: (e as HTMLElement).dataset.hint!, x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );
  await app.screenshot({ path: path.join(REPO, '.scratch/shots/v1a-54', `hints-long-project-name-${test.info().project.name}.png`) });
  // The first glyphs of each project name (its first word) are never under a label.
  const projects = text.filter((t) => /^nunchiro-realwindow/.test(t.name) && t.boxes.length);
  const starts = projects.map((t) => ({ name: t.name, box: { ...t.boxes[0], w: Math.min(t.boxes[0].w, 40) } }));
  expect(starts.flatMap((s) => labels.filter((l) => meets(l, s.box)).map((l) => `${l.label} on "${s.name}"`))).toEqual([]);
  const overlaps = labels.flatMap((a, i) => labels.slice(i + 1).filter((b) => meets(a, b)).map((b) => `${a.label}/${b.label}`));
  expect(overlaps).toEqual([]);
  expect(labels.length).toBe(visible);
});
