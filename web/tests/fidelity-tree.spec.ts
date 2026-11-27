// FIDELITY pass 1 (ticket 64): tree rows, group heads, micro-headers, tooltip and decision line against the ko/ mockups
// (STYLE 2026-10-28; TREEROWS = v2-8a-a-folds + v2-8a-groups G2; HIDEROWS r6). Pixels: Chromium only, via visual/compare.ts.
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { mockupTree, MOCKUP_WAITING, tree } from './fixtures/fid-tree';
import { seed } from './tree-seed';
import { koRows, outDir, patchSnapshots, repo, show, trading, worktree, type Scheme } from './visual/compare';
import { MOCKUPS, mockup } from './visual/mockups';

outDir('fidelity-tree/visual');
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

const SCHEMES = ['light', 'dark'] as const;
const FOLDS = 'v2-8a-a-folds.html';
// Ticket 388 (mock final/388.html) replaced these mockups' head pills (.cnt) and per-row bar with the colour strip, pinned by
// tree-strip.spec.ts: the crops compare everything else, with both right ends left out.
test.beforeEach(({ app }) => koRows(app)); // the ko/ mockups' 30 px rows and 29 px .q (ticket 1041 lane 1)
/** How many sessions a head's strip counts. */
const counted = (head: import('@playwright/test').Locator) => head.locator('.cstrip > .sg').evaluateAll((es) => es.reduce((n, e) => n + Number(e.getAttribute('data-n')), 0));
const GROUPS = 'v2-8a-groups.html';

/** v2-8a-a-folds section ①/②: nunchiro's worktrees lcfollow (your turn), v2-palette (working), v2-spaces (broken). */
async function rows(app: Page, core: Core, scheme: Scheme) {
  const p = repo(core, 'nunchiro');
  for (const b of ['lcfollow', 'v2-palette', 'v2-spaces']) worktree(core, p, b);
  await patchSnapshots(app, { lcfollow: { waiting: 'permission', text: 'npm install' }, 'v2-palette': { working: true }, 'v2-spaces': { failed: true } });
  await show(app, scheme);
  const grp = app.locator('.grp[data-project="nunchiro"]');
  await expect(grp.locator('.row.wt2')).toHaveCount(3);
  return grp;
}

for (const scheme of SCHEMES) {
  test.describe(`tree_rows_match_mockup (${scheme})`, { tag: '@chromium' }, () => {

    test('mockup_copied_and_hashed', async () => {
      const readme = fs.readFileSync(path.join(MOCKUPS, 'README.md'), 'utf8');
      for (const f of [FOLDS, GROUPS, 'hiderows-r6.html']) {
        const sha = createHash('sha256').update(fs.readFileSync(mockup(f))).digest('hex');
        expect(readme, `${f} row with its sha256`).toMatch(new RegExp(`\\| \`${f}\` \\|[^|]*(STYLE|TREEROWS|HIDEROWS)[^|]*\\| \`${sha}\` \\|`));
      }
    });

    // Ticket 1041 lane 4: the worktree, running and broken rows, the heads and the popped-out line follow the approved
    // docs/design/polish-1121 mockup (no rail, state light and word, 32 px heads, the quiet "new N"); their ko/ crops are
    // retired. tree-polish-1041.spec.ts measures the rows against the polish mockup.
  });
}

// FIDELITY BAR (needs 130): the five elements the coordinator found below the mockup. Each renders the mockup's own data
// (fixtures/fid-tree.ts) and asserts the mockup's own shape: mockup ② lumen's bar, ③ Trading's head and rows, ①'s
// clean-up line. Chromium only where a crop is compared; shapes are checked on both.
test.describe('fidelity bar: tree rows equal or better than the mockup', { tag: '@chromium' }, () => {

  // ② "내가 접은 프로젝트: 색 바 + 결정 대기 줄은 그대로 보임": one 3x12 segment per session, never one wide bar.
  test('folded_project_colour_strip', async ({ app, core }) => {
    const g = await mockupTree(app, core, 'light', false);
    await app.getByRole('button', { name: 'Collapse lumen', exact: true }).click();
    const head = g.locator('.grp[data-project="lumen"] > .row.head');
    const segs = head.locator('.cstrip i');
    // lumen has a main session and one worktree: one bar per session, the waiting one first (ticket 388: orange, then grey).
    await expect(segs).toHaveCount(2);
    expect(await head.locator('.cstrip > .sg').evaluateAll((es) => es.map((e) => e.getAttribute('data-tone')))).toEqual(['o', 'g']);
    // Each bar is 3 px wide, never one merged slab; your turn stands 14 px, the rest 10 px (mock final/388.html).
    const boxes = await segs.evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    expect(boxes).toEqual([[3, 14], [3, 10]]);
    const bar = await head.locator('.cstrip').boundingBox();
    expect(await head.boundingBox()).not.toBeNull();
    // The bar stays inside its row: no overflow past the row's right edge.
    const row = (await head.boundingBox())!;
    expect(bar!.x + bar!.width).toBeLessThanOrEqual(row.x + row.width);
  });

  // ③ "내가 접은 그룹: 프로젝트 전체를 합친 색 바, 대기 3개 이상이면 2줄 + '+N'": the folded group head carries the
  // merged strip and "N projects", and its waiting rows read "project · session", at most two, then "+N waiting".
  test('folded_group_strip_and_more', async ({ app, core }) => {
    const g = await mockupTree(app, core, 'light');
    const head = g.locator('> .row.ghead');
    // The merged strip: one bar per session in the group (lumen main+worktree, tide main+worktree).
    await expect.poll(() => counted(head)).toBe(4);
    // "2 projects" after the counts, the mockup's muted ".d".
    await expect(head.locator('.d')).toHaveText('2 projects');
    // Waiting rows name the project and the session.
    await expect(g.locator('.q')).toHaveCount(2);
    const names = g.locator('.row.wt2 .n');
    await expect(names.first()).toContainText('lumen · backtest-runner');
    await expect(names.nth(1)).toContainText('tide · sealed-read-backend');
  });

  // A third waiting item, then: at most two rows and "+1 waiting" (the mockup's ".more").
  test('folded_group_two_rows_then_more', async ({ app, core }) => {
    const k = repo(core, 'lumen');
    for (const b of ['backtest-runner', 'broke', 'tests']) worktree(core, k, b);
    core.shell(k, 'main');
    seed(core, { op: 'group_create', name: 'Trading', project: k }, { op: 'fold', key: 'group:Trading', folded: true });
    await patchSnapshots(app, { 'backtest-runner': { waiting: 'permission' }, broke: { waiting: 'permission' }, tests: { waiting: 'permission' } });
    await show(app, 'light');
    const g = app.locator('.pgrp[data-group="Trading"]');
    await expect(g.locator('.q')).toHaveCount(2);
    await expect(g.locator('.more')).toHaveText('+1 waiting');
    // Ticket 388: the strip counts all four sessions (three waiting are one orange bar and "3").
    expect(await counted(g.locator('> .row.ghead'))).toBe(4);
    await expect(g.locator('> .row.ghead .sg[data-tone="o"] .num')).toHaveText('3');
  });

  // ① "Ready to clean up (2) · Clean up…": merged worktrees leave the rows for one line under them, link included.
  test('cleanup_row_present', async ({ app, core }) => {
    await mockupTree(app, core, 'light', true, true);
    await show(app, 'light');
    const grp = app.locator('.grp[data-project="nunchiro"]');
    await expect(grp).toBeVisible();
    const line = grp.locator('.cleanup');
    await expect(line.locator('> summary')).toContainText('Ready to clean up (2)');
    await expect(line.locator('.cu')).toHaveText('Clean up…');
    // One line that holds its words: at the real sidebar width the base's fixed-height summary wrapped to three lines and
    // cut them ("Clean / up…"). Two lines is the mockup's own wrap at this width; nothing may be clipped.
    const [h, sh] = await line.locator('> summary').evaluate((e) => [e.getBoundingClientRect().height, e.scrollHeight]);
    expect(sh, `the summary needs ${sh}px and its box is ${Math.round(h)}px`).toBeLessThanOrEqual(Math.round(h) + 1);
    expect(h).toBeLessThanOrEqual(30);
    // Merged worktrees stay inside the fold; the follow-up removes the redundant loose remove rows.
    await expect(grp.locator('.cleanup .row.sub')).toHaveCount(2);
  });

  // The mockup's "Caution" chip: a risky permission is a chip on the row, not words in the question.
  test('risky_row_carries_caution_chip', async ({ app, core }) => {
    const g = await mockupTree(app, core, 'light');
    const q = g.locator('.q').first();
    await expect(q.locator('.warn')).toHaveText('Caution');
    // The chip rides inside the question's span, before its words (hiderows-r6), so the two share one line.
    await expect(q.locator('.qt .warn')).toHaveText('Caution');
    await expect(q.locator('.qt')).toContainText(MOCKUP_WAITING);
  });
});

// The acceptance page: mockup and app, same data, light and dark, written to `.scratch/fid-tree/side/` for
// `.scratch/fid-tree/side-by-side.html`. The mockup's panes are its own drawing; `fixtures/fid-tree.ts` reproduces its
// data in the app, so the two sides show the same tree.
test('same_data_side_by_side', async ({ app, core, page }) => {
  const dir = path.resolve(import.meta.dirname, '../../.scratch/fid-tree2/round1-side');
  fs.mkdirSync(dir, { recursive: true });
  await mockupTree(app, core, 'light', true, true);
  const m = await page.context().newPage();
  await m.setViewportSize(page.viewportSize()!);
  for (const scheme of SCHEMES) {
    await show(app, scheme);
    // The merged chips arrive over the socket, so wait for the line they produce before the shot.
    await expect(app.locator('.grp[data-project="nunchiro"] .cleanup')).toBeVisible();
    await tree(app).screenshot({ path: path.join(dir, `app-${scheme}.png`), animations: 'disabled' });
    // The mockup draws both schemes on one page (`.pane.lt` and `.pane.dk`), so the scheme picks the pane, not the media.
    await m.goto(`file://${mockup(FOLDS)}`);
    await m.locator(scheme === 'dark' ? '.pane.dk' : '.pane:not(.dk)').first().screenshot({ path: path.join(dir, `mock-${scheme}.png`), animations: 'disabled' });
    for (const f of [`mock-${scheme}.png`, `app-${scheme}.png`]) expect(fs.statSync(path.join(dir, f)).size, f).toBeGreaterThan(2000);
  }
  await m.close();
});

// Gap 1 and gap 4 are the same row at the sidebar's real width: the button must stay one line, and the name must not be
// cut while the row still has room for it.
test.describe('fidelity bar: waiting rows at the real sidebar width', { tag: '@chromium' }, () => {

  // ① "Open in panel" wraps onto three lines and pushes the row: one line, never wider than the row allows.
  test('open_in_panel_one_line', async ({ app, core }) => {
    const g = await mockupTree(app, core, 'light');
    const q = g.locator('.q').first();
    const btn = q.locator('[data-act="details"]');
    await expect(btn).toBeVisible();
    // The accessible name stays the words; the button may show an icon instead.
    await expect(btn).toHaveAccessibleName('Open in panel');
    // One line: an icon button, at most one 22px line box, never the 3 wrapped lines of the words.
    const box = (await btn.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(22);
    // The row is the one-line height (mockup .q 29px), not pushed taller by the button.
    expect((await q.boundingBox())!.height).toBeLessThanOrEqual(30);
    // And the question keeps the row: the words take most of it, not the button (on the base the text button was 93px of
    // a 193px row and left the question 16px, cut to "npm…").
    const [qtCw, rowW] = await q.evaluate((e) => [(e.querySelector('.qt') as HTMLElement).clientWidth, e.getBoundingClientRect().width]);
    expect(qtCw, `the question gets ${Math.round(qtCw)}px of a ${Math.round(rowW)}px row`).toBeGreaterThan(rowW / 2);
    // Never wider than the row allows.
    expect(box.x + box.width).toBeLessThanOrEqual((await q.boundingBox())!.x + (await q.boundingBox())!.width);
  });

  // ④ "names_not_cut_early": "backtest-..." in a 240 px sidebar though the row has room for the whole name.
  test('names_not_cut_early', async ({ app, core }) => {
    const g = await mockupTree(app, core, 'light');
    await app.locator('.sbar.l').evaluate((e) => { (e as HTMLElement).style.width = '300px'; });
    const wide = await tree(app).evaluate((e) => e.getBoundingClientRect().width);
    // Under a folded group the row names its project too (mockup ③, "lumen · rehfix"); the whole of it must fit.
    for (const [name, shown] of [['backtest-runner', 'lumen · backtest-runner'], ['sealed-read-backend', 'tide · sealed-read-backend']] as const) {
      const n = g.locator('.row.wt2 .n', { hasText: name });
      await expect(n).toHaveText(shown);
      // Not ellipsised: the name itself fits its box (the project prefix is the one that gives way, to "tide ·").
      const [scroll, client, box] = await n.evaluate((e) => {
        const nm = e.querySelector('.nm') as HTMLElement;
        return [nm.scrollWidth, nm.clientWidth, Math.round(nm.getBoundingClientRect().width)];
      });
      expect(scroll, `${name} is cut to ${box}px at a ${Math.round(wide)}px sidebar`).toBeLessThanOrEqual(client + 1);
    }
    // A waiting row's question is not cut either when the row has room for it (the second one carries no chip).
    const qt = g.locator('.q').nth(1).locator('.qt');
    const [qs, qc] = await qt.evaluate((e) => [(e as HTMLElement).scrollWidth, (e as HTMLElement).clientWidth]);
    expect(qs).toBeLessThanOrEqual(qc + 1);
  });
});

test.describe('micro headers and tooltip', () => {
  test('micro_headers_sentence_case', async ({ app, core }) => {
    core.shell(repo(core, 'lumen'), 'main');
    await show(app, 'light');
    const muted = await app.evaluate(() => {
      const e = document.createElement('i');
      e.style.color = 'var(--muted)';
      document.body.append(e);
      return getComputedStyle(e).color;
    });
    for (const [loc, text] of [
      [app.locator('.ph', { hasText: 'Projects' }), 'Projects'],
      [app.locator('.mach').first(), 'This Mac'],
    ] as const) {
      await expect(loc).toBeVisible();
      const css = await loc.evaluate((e) => {
        const c = getComputedStyle(e);
        return { tt: c.textTransform, fs: c.fontSize, fw: c.fontWeight, color: c.color, ls: c.letterSpacing };
      });
      expect(css).toMatchObject({ tt: 'none', fs: '11px', fw: '600', color: muted, ls: 'normal' });
      expect((await loc.textContent())!).toContain(text);
    }
  });

  test('tooltip_bubble_matches_tip', async ({ app, core }) => {
    const grp = await rows(app, core, 'light');
    await grp.locator('.q .qib.al').first().hover();
    const tip = app.locator('.apptip');
    await expect(tip).toBeVisible();
    const css = await tip.evaluate((e) => {
      const c = getComputedStyle(e);
      // WebKit prints 12px x 1.45 as 17.400002px; a hundredth of a pixel is float noise, not a different line height.
      return { bg: c.backgroundColor, color: c.color, fs: c.fontSize, lh: `${Math.round(parseFloat(c.lineHeight) * 100) / 100}px`, pad: c.padding, r: c.borderRadius, shadow: c.boxShadow };
    });
    // Ticket 1041 lane 6 (N183, polish-1121 `.tip`): one tooltip look, ink --text with --panel text at 11 px on the float
    // shadow; it replaced the ko/v2-8a-a-folds.html .tip (12 px, --hov text, no shadow).
    expect(css).toEqual({ bg: 'rgb(35, 39, 43)', color: 'rgb(250, 250, 249)', // the design book's --text and --panel
      fs: '11px', lh: '15.4px', pad: '4px 8px', r: '6px', shadow: 'rgba(0, 0, 0, 0.14) 0px 12px 32px 0px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px' });
    await expect(tip).toHaveText('Allow (1)');
  });
});

test.describe('tree has no duplicate controls and passes axe', () => {
  /** A tree with every row kind: worktree rows in each state, a decision line, a folded and an unfolded group. */
  async function everything(app: Page, core: Core, scheme: Scheme) {
    const g = await trading(app, core, scheme, false);
    const [a, b] = ['q1', 'q2'].map((n) => core.project(n));
    [a, b].forEach((d, i) => core.shell(d, `s${i}`));
    seed(core, { op: 'group_create', name: 'Archive', project: a }, { op: 'project_move', project: b, group: 'Archive' });
    return g;
  }

  test('nodup_tree', async ({ app, core }) => {
    await everything(app, core, 'light');
    await expect(app.locator('.sess .q').first()).toBeVisible();
    const dup = await app.locator('.tree .row, .tree .q').evaluateAll((els) =>
      els.flatMap((row) => {
        const acts = [...row.querySelectorAll<HTMLElement>('button:not(.n), [role=button]:not(.n)')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).filter(Boolean);
        const text = (row.querySelector('.n')?.textContent ?? '').trim();
        const same = acts.filter((a, i) => acts.indexOf(a) !== i);
        // an icon plus a same-text button: a button whose label repeats the row's own visible text
        const echo = text ? acts.filter((a) => a === text && !row.matches('button')) : [];
        return [...same, ...echo].map((x) => `${(row as HTMLElement).className}: ${x}`);
      }),
    );
    expect(dup).toEqual([]);
  });

  for (const scheme of SCHEMES) {
    test(`axe_tree (${scheme})`, async ({ app, core }) => {
      await everything(app, core, scheme);
      const q = app.locator('.sess .q').first();
      await expect(q).toBeVisible();
      await q.locator('.qib.al').hover(); // a tooltip showing
      await expect(app.locator('.apptip')).toBeVisible();
      const r = await new AxeBuilder({ page: app }).include('.dock.l').analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  }
});
