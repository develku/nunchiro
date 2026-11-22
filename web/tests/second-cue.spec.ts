// Ticket 293 round 3 (review d7d7e708, WCAG 1.4.1): with a theme as written, your turn and broken can sit close in colour, so
// each place that told them apart by colour alone carries the tree rows' own icons (hand = your turn, x-circle = broken) or a
// shape difference. One test per place, asserting the cue in the DOM / rendered style, not only `--you !== --bad`.
// SHOTS_DIR=<dir> also saves a shot of each place in Catppuccin Latte and Mocha (the REPORT's shots page).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './fixtures/board/coord';
import { patch } from './attention-patch';
import { openQuiet } from './tree-seed';
import { repo, worktree } from './visual/compare';

const PICKS = ['Catppuccin Latte', 'Catppuccin Mocha'].map((name) => ({ id: `catalog:${name}`, name, colors: parseGhostty(THEMES[name]) }));
const shotsDir = process.env.SHOTS_DIR;

async function setup(app: Page, core: Core, pick?: (typeof PICKS)[number]) {
  const p = repo(core, 'lumen');
  for (const b of ['asks', 'broke', 'calm']) worktree(core, p, b);
  openQuiet(core);
  seed(core, [
    { id: 'c1', title: 'Pick a theme', column: 'needs-decision' },
    { id: 'c2', title: 'Run the gate', column: 'done', receipt: { sha: 'abc1234', command: 'gate', result: 'failed: 3 failed' } },
    { id: 'c3', title: 'Write the report', column: 'todo' },
  ]);
  await patch(app, { asks: 'waiting', broke: 'failed' });
  if (pick) await app.addInitScript((q) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: q })), pick);
  await openWindow(app, {}, core);
  await app.mouse.move(900, 600);
}
const icon = (l: Locator) => l.locator('svg').first().getAttribute('data-icon');
/** A shot of the place itself: the union of the given elements' boxes plus a margin (the REPORT zooms it). */
async function shot(app: Page, pick: (typeof PICKS)[number] | undefined, place: string, ...where: Locator[]) {
  if (!shotsDir || !pick) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  const boxes = (await Promise.all(where.map((l) => l.boundingBox()))).filter((b): b is NonNullable<typeof b> => !!b);
  const [x0, y0] = [Math.min(...boxes.map((b) => b.x)) - 8, Math.min(...boxes.map((b) => b.y)) - 8];
  const [x1, y1] = [Math.max(...boxes.map((b) => b.x + b.width)) + 8, Math.max(...boxes.map((b) => b.y + b.height)) + 8];
  await app.screenshot({ path: path.join(shotsDir, `${pick.name.replace(/\W+/g, '-')}-${place}.png`), clip: { x: Math.max(0, x0), y: Math.max(0, y0), width: x1 - Math.max(0, x0), height: y1 - Math.max(0, y0) } });
}

for (const pick of [undefined, ...PICKS]) {
  const tag = pick ? ` (${pick.name})` : '';
  test(`second_cue_tab_dot: your turn is a hand, broken an x-circle, others stay a plain dot${tag}`, async ({ app, core }, info) => {
    test.skip(info.project.name !== 'chromium', 'one browser is enough');
    await setup(app, core, pick);
    const dot = (s: string) => app.locator(`.tab .tdot[data-s="${s}"]`).first();
    await expect(dot('waiting')).toBeVisible({ timeout: 15_000 });
    await expect(dot('failed')).toBeVisible();
    await shot(app, pick, 'tab-dot', app.locator('.tab').nth(0), app.locator('.tab').nth(1));
    expect(await icon(dot('waiting'))).toBe('hand');
    expect(await icon(dot('failed'))).toBe('fail');
    expect(await dot('waiting').locator('svg').count()).toBe(1);
    // the glyph replaces the disc: no fill behind it, and the glyph is drawn at a size that reads (not a 7px speck)
    for (const s of ['waiting', 'failed']) expect((await dot(s).boundingBox())!.width, `${s} dot keeps its 7px footprint, so a state change moves no tab`).toBe(7);
    for (const s of ['waiting', 'failed']) {
      const look = await dot(s).evaluate((e) => ({ fill: getComputedStyle(e).backgroundColor, w: e.querySelector('svg')!.getBoundingClientRect().width, ink: getComputedStyle(e).color }));
      expect(look.fill, `${s} dot has no disc behind the glyph`).toBe('rgba(0, 0, 0, 0)');
      expect(look.w, `${s} glyph size`).toBeGreaterThanOrEqual(11);
    }
    // the dot keeps its name for a screen reader, and a calm session's dot carries no glyph
    await expect(dot('waiting')).toHaveAttribute('aria-label', 'waiting');
    await expect(app.locator('.tab .tdot:not([data-s="waiting"]):not([data-s="failed"]) svg')).toHaveCount(0);
  });

  // Ticket 462 (owner 11-12): no notch on the failed bar, the approved mockup's shape. The second cue for a broken session is
  // its row's x-circle (tree_broken_row_red); on the strip both urgent bars are 14px and solid.
  test(`second_cue_head_strip: on the head's colour strip (ticket 388, which took the pills out) a broken bar and a your-turn bar are both solid and the same size${tag}`, async ({ app, core }, info) => {
    test.skip(info.project.name !== 'chromium', 'one browser is enough');
    await setup(app, core, pick);
    const head = app.locator('.tree .grp[data-project] .row.head').first(); // ticket 1032: the Assistants group comes first
    const you = head.locator('.cstrip > .sg[data-tone="o"]');
    const bad = head.locator('.cstrip > .sg[data-tone="r"]');
    await expect(you).toBeVisible({ timeout: 15_000 });
    await shot(app, pick, 'head-pills', head, app.locator('.tree .grp[data-project] .row.wt2').first());
    // The words are in each colour's accessible name and the hover summary; the shape is the second cue.
    await expect(you).toHaveAttribute('data-n', '1');
    await expect(bad).toHaveAttribute('data-n', '1');
    const bg = (l: Locator) => l.locator('i').first().evaluate((e) => ({ image: getComputedStyle(e).backgroundImage, w: getComputedStyle(e).width, h: getComputedStyle(e).height }));
    const [y, r] = [await bg(you), await bg(bad)];
    expect(y.image).toBe('none');
    expect(r.image).toBe('none');
    expect(r.w).toBe(y.w); // same footprint, so nothing moves
    expect(r.h).toBe(y.h);
  });

  test(`second_cue_board_card: a your-turn task card shows a hand and a solid edge bar, a broken one an x-circle and a dashed edge bar (ticket 1041: the bar, not a border)${tag}`, async ({ app, core }, info) => {
    test.skip(info.project.name !== 'chromium', 'one browser is enough');
    await setup(app, core, pick);
    await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
    const board = app.locator('.board');
    await expect(board).toBeVisible();
    await app.mouse.move(2, 2);
    await expect(board.locator('.bcard[data-source="manual"]')).toHaveCount(3); // the three seeded task cards (the sessions have cards too)
    const card = (title: string) => board.locator('.bcard', { has: app.locator('.btt', { hasText: new RegExp(`^${title}$`) }) });
    const you = card('Pick a theme');
    const bad = card('Run the gate');
    const calm = card('Write the report');
    await shot(app, pick, 'board-card', you, bad, calm);
    expect(await icon(you.locator('.bdot'))).toBe('hand');
    expect(await icon(bad.locator('.bdot'))).toBe('fail');
    expect(await calm.locator('.bdot svg').count()).toBe(0);
    for (const c of [you, bad, calm]) expect((await c.locator('.bdot').boundingBox())!.width, 'the dot keeps its 8px footprint').toBe(8);
    // Ticket 1041 (A+C): no border box; the left edge bar (::before) is solid for your turn, dashed (a repeating gradient) for broken.
    const edge = (c: Locator) => c.evaluate((e) => { const s = getComputedStyle(e, '::before'); return { content: s.content, image: s.backgroundImage, width: s.width }; });
    const [ey, eb, ec] = [await edge(you), await edge(bad), await edge(calm)];
    expect(ey.content).not.toBe('none');
    expect(ey.image).toBe('none');
    expect(eb.image).toContain('repeating-linear-gradient');
    expect(ey.width).toBe(eb.width);
    expect(ec.content).toBe('none');
    for (const c of [you, bad, calm]) expect(await c.evaluate((e) => getComputedStyle(e).borderLeftWidth)).toBe('0px');
  });
}
