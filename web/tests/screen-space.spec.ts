// V1A-60 screen space (needs 68, 69): the main zone keeps 80 terminal columns while side panels fold to their icon
// bar, and they come back in place when room returns. The answer strip's height: answer-strip.spec.ts (V1A-60b).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test, type Core, legacyLayout } from './fixtures';

test.beforeEach(({ core }) => legacyLayout(core)); // D5b: the default window has no tree or AGENTS zone; this spec is about zones, so it starts from their old shape

/** A shell that prints `sN <rows> <cols>` (the PTY's own size) on each Enter. */
const sizer = (core: Core) => core.shell(core.project('demo'), 'sizer', '/bin/sh', '-c', 'n=0; while read l; do n=$((n+1)); echo "s$n $(stty size)"; done');

const asked = new Map<string, number>();
/** The PTY's column count right now, as the program in it sees it. */
async function columns(app: Page, id: string) {
  const n = (asked.get(id) ?? 0) + 1;
  asked.set(id, n);
  await app.locator(`.term[data-session="${id}"]`).click({ position: { x: 20, y: 20 } });
  await app.keyboard.press('Enter');
  let line: RegExpMatchArray | null = null;
  await expect.poll(async () => (line = (await terminalText(app, id)).match(new RegExp(`s${n} \\d+ (\\d+)`))) !== null).toBe(true);
  return Number(line![1]);
}

const PANELS = { files: '.sbar.l', diff: '.sbar.r', board: '[data-zone-id="board"]', tree: '[data-zone-id="tree"]' };
/** A panel's box, `folded` when it is drawn with no width, `absent` when it is not drawn at all (CHROME, needs 104: Settings
 *  is a wide view that drops the sidebars; frame-chrome.spec.ts settings_wide_hides_sidebars pins that). */
const panelBoxes = (app: Page) =>
  app.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, s]) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return [k, !r ? 'absent' : r.width > 0 ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : 'folded'];
  })), PANELS);

/** UXFIX (c): the Board icon opens a centre tab now; these folding tests need the board as a right edge zone, as a user's own layout can have. */
const edgeBoard = (core: Core) => core.cli('layout', 'edge', 'right', 'board');

async function openPanels(app: Page, core: Core) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Files' }).click();
  const right = app.getByRole('navigation', { name: 'Right bar' });
  await right.getByRole('button', { name: 'Diff' }).click();
  edgeBoard(core);
  await expect(right.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true');
}
const layoutFile = (core: Core) => fs.readFileSync(path.join(core.home, 'layout.toml'), 'utf8');

test('main-zone-min-width: at 1280 px with Diff, Board and Files open the terminal has at least 80 columns', async ({ app, core }) => {
  const s = sizer(core);
  await app.setViewportSize({ width: 1280, height: 800 });
  await openWindow(app);
  await openPanels(app, core);
  await expect.poll(() => columns(app, s.id)).toBeGreaterThanOrEqual(80);
  // Folding is view state: the icons stay pressed and nothing is closed.
  await expect(app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
  await expect(app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff' })).toHaveAttribute('aria-pressed', 'true');
  expect(Object.values(await panelBoxes(app))).toContain('folded');
});

test('side-panels-restore: widening the window restores the folded panels in place; layout.toml is not rewritten', async ({ app, core }) => {
  const s = sizer(core);
  await app.setViewportSize({ width: 1920, height: 800 });
  await openWindow(app);
  await openPanels(app, core);
  await expect.poll(() => columns(app, s.id)).toBeGreaterThanOrEqual(80);
  const wide = await panelBoxes(app);
  expect(Object.values(wide)).not.toContain('folded');
  const file = layoutFile(core);
  await app.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => Object.values(await panelBoxes(app))).toContain('folded');
  await expect.poll(() => columns(app, s.id)).toBeGreaterThanOrEqual(80);
  await app.setViewportSize({ width: 1920, height: 800 });
  await expect.poll(() => panelBoxes(app)).toEqual(wide);
  expect(layoutFile(core)).toBe(file);
});

const left = (app: Page) => app.getByRole('navigation', { name: 'Left bar' });
const right = (app: Page) => app.getByRole('navigation', { name: 'Right bar' });
const shownBox = (app: Page, sel: string) => app.locator(sel).evaluate((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none');

for (const via of ['icon', 'command'] as const) {
  test(`fold-icon: the ${via} of a folded panel unfolds it (another folds) instead of closing it; layout.toml keeps Board`, async ({ app, core }) => {
    const s = sizer(core);
    await app.setViewportSize({ width: 1280, height: 800 });
    await openWindow(app);
    edgeBoard(core);
    await right(app).getByRole('button', { name: 'Diff' }).click();
    await left(app).getByRole('button', { name: 'Files' }).click();
    await left(app).getByRole('button', { name: 'Search' }).click();
    const board = right(app).getByRole('button', { name: 'Board (folded)' });
    await expect(board).toBeVisible();
    if (via === 'icon') await board.click();
    else {
      await app.keyboard.press('Meta+KeyK');
      // The Search click above focuses its field two frames later (useRails.tsx:161); that late focus can land after the
      // palette opened, so a page-level Enter would go to Search. locator.press focuses the palette field first.
      const search = app.getByRole('combobox', { name: 'Command palette search' });
      await search.fill('Show or hide the board');
      await search.press('Enter');
    }
    await expect.poll(() => shownBox(app, '[data-zone-id="board"]')).toBe(true);
    await expect(right(app).getByRole('button', { name: /^Board( · |$)/ })).toHaveAttribute('aria-pressed', 'true');
    expect(layoutFile(core)).toContain('board');
    await expect.poll(() => columns(app, s.id)).toBeGreaterThanOrEqual(80);
  });
}

test('fold-settings: the Settings modal folds and unfolds nothing behind it (v25f); closing it leaves the panels as they were', async ({ app, core }) => {
  const s = sizer(core);
  await app.setViewportSize({ width: 1280, height: 800 });
  await openWindow(app);
  await openPanels(app, core);
  await expect.poll(async () => Object.values(await panelBoxes(app))).toContain('folded');
  const SEL = '.body > .sbar[data-folded], .lz[hidden], .lz-split[hidden]';
  await app.waitForTimeout(300);
  const before = await app.evaluate((sel) => document.querySelectorAll(sel).length, SEL);
  const boxes = await panelBoxes(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // v25 placement: bottom-left
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(await panelBoxes(app)).toEqual(boxes);
  expect(await app.evaluate((sel) => document.querySelectorAll(sel).length, SEL)).toBe(before);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
  expect(await panelBoxes(app)).toEqual(boxes);
  await expect.poll(() => columns(app, s.id)).toBeGreaterThanOrEqual(80);
});


