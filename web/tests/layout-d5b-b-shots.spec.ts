// LAYOUT D5b lane B: the side-by-side pictures (REPORT's .scratch/layout-b/side-by-side.html is built from these). Each
// state is shot from the approved mockup and from the app: the left sidebar (or the picker's corner). Not a gate.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { defaultBars } from '../src/layout/bars';
import { expect, openWindow, test, type Core } from './fixtures';
import { card, drag, icon, startEdit } from './d5b';
import { openQuiet } from './tree-seed';
import { mockup } from './visual/mockups';

const OUT = path.resolve(import.meta.dirname, '../../.scratch/layout-b/shots');
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(({ browserName }) => browserName !== 'chromium', 'pictures are Chromium only');

const mock = async (page: Page, scheme: 'light' | 'dark', step: (m: Page) => Promise<void>) => {
  const m = await page.context().newPage();
  await m.setViewportSize({ width: 1440, height: 900 });
  await m.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await m.goto(`file://${mockup('layout-d5b.html')}`);
  // The approved file ends inside its <script>, so a browser never runs it: run its own text (see visual-conformance).
  await m.evaluate(() => {
    const r = document.createElement('script');
    r.textContent = document.querySelector('script')!.textContent!;
    document.body.append(r);
  });
  await step(m);
  return m;
};
const save = (name: string, scheme: string, who: 'mock' | 'app', png: Buffer) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}-${scheme}-${who}.png`), png);
};
/** nunchiro with two sessions and one worktree row; Agents (open) and Files (closed) nested, as the mockup's default. */
async function seed(app: Page, core: Core, scheme: 'light' | 'dark', nest = true) {
  const p = core.project('nunchiro');
  core.shell(p, 'ux-fix-2');
  core.shell(core.project('lumen'), 'backtest-v3');
  openQuiet(core, 'nunchiro', 'lumen', '');
  const bars = { ...defaultBars(), nest: nest ? { [p]: ['context', 'files'] } : {}, open: nest ? { [`${p}::context`]: true } : {} };
  await app.addInitScript(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), ['nunchiro.settings.v1', { bars }] as const);
  await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await openWindow(app);
  await app.mouse.move(900, 600);
}
const left = (app: Page) => app.locator('aside.sbar[data-side="left"]');

for (const scheme of ['light', 'dark'] as const) {
  test(`shot row-hot ${scheme}`, async ({ app, core }) => {
    await seed(app, core, scheme, false);
    await startEdit(app);
    const t = await drag(app, card(app, 'context'), app.locator('.sbar .tree .row.head[data-project-path]').first(), { release: false });
    // A tree update during the hold can re-create the row; the next pointer move re-marks it.
    await expect(async () => {
      await app.mouse.move(t.x + 1, t.y);
      await app.mouse.move(t.x, t.y);
      await expect(app.locator('.tree [data-hot]')).toHaveCount(1, { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    save('row-hot', scheme, 'app', await left(app).screenshot());
    const m = await mock(app, scheme, async (m) => void (await m.evaluate(() => document.querySelector('.ph')!.classList.add('hot'))));
    save('row-hot', scheme, 'mock', await m.locator('#sbL').screenshot());
  });
}
test('shot subviews', async ({ app, core }) => {
  await seed(app, core, 'light');
  await expect(left(app).locator('.view')).toHaveCount(2);
  save('subviews', 'light', 'app', await left(app).screenshot());
  const m = await mock(app, 'light', async () => {});
  save('subviews', 'light', 'mock', await m.locator('#sbL').screenshot());
});
// 465: the owner's use, two views open at once under one project.
test('shot subviews-open dark', async ({ app, core }) => {
  await seed(app, core, 'dark');
  await left(app).locator('.view[data-view="files"] .vh button.vt').click();
  await expect(left(app).locator('.view .vb')).toHaveCount(2);
  await expect(left(app).locator('.view[data-view="files"] .files .r[title]').first()).toBeVisible();
  save('subviews-open', 'dark', 'app', await left(app).screenshot());
  const m = await mock(app, 'dark', async (m) => void (await m.locator('.vh[data-k="nunchiro:files"]').click()));
  save('subviews-open', 'dark', 'mock', await m.locator('#sbL').screenshot());
});
test('shot picker', async ({ app, core }) => {
  await seed(app, core, 'light', false);
  await icon(app, 'left', 'Tree').click(); // collapsed: the picker is the way to the tree
  await startEdit(app);
  await drag(app, card(app, 'board'), icon(app, 'left', 'Tree'));
  await expect(app.getByRole('dialog', { name: /^Projects for / })).toBeVisible();
  const clip = { x: 0, y: 0, width: 520, height: 360 };
  save('picker', 'light', 'app', await app.screenshot({ clip }));
  const m = await mock(app, 'light', async (m) => void (await m.evaluate(() => (window as unknown as { picker: (w: string, x: number, y: number) => void }).picker('board', 90, 220))));
  save('picker', 'light', 'mock', await m.screenshot({ clip }));
});
test('shot edit-x', async ({ app, core }) => {
  await seed(app, core, 'light');
  await startEdit(app);
  save('edit-x', 'light', 'app', await left(app).screenshot());
  const m = await mock(app, 'light', async (m) => void (await m.locator('#lay').click()));
  save('edit-x', 'light', 'mock', await m.locator('#sbL').screenshot());
});
test('shot folded', async ({ app, core }) => {
  await seed(app, core, 'light');
  await left(app).getByRole('button', { name: 'Collapse nunchiro' }).click();
  await expect(left(app).locator('.view')).toHaveCount(0);
  save('folded', 'light', 'app', await left(app).screenshot());
  const m = await mock(app, 'light', async (m) => void (await m.locator('.fold').first().click()));
  save('folded', 'light', 'mock', await m.locator('#sbL').screenshot());
});
