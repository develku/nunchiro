// LAYOUT D5b design conformance: screenshots of the D5b mockup next to the app, per state, for the side-by-side page
// `.scratch/layout-a/side-by-side.html` (REPORT). Not part of the gate: run with D5B_SHOTS=1.
// The D5b mockup has no approval badge or compass, so those two states use the D4 mockup that drew them (D4 carry-overs).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, expect, openWindow, test } from './fixtures';
import { at, barBefore, card, drag, icon, layoutButton, startEdit, unapproved } from './d5b';

test.skip(!process.env.D5B_SHOTS, 'screenshots for the side-by-side page: D5B_SHOTS=1');
// The approved mockups, copied once with the `</script>` their last script lacks (a browser does not run an unclosed script):
// `.scratch/layout-a/mock/`. The intro text and page padding are hidden so the window fills the 1440x900 viewport, as the app does.
const MOCKUPS = process.env.D5B_MOCKUPS ?? path.join(REPO, '.scratch/layout-a/mock');
const OUT = path.join(REPO, '.scratch/layout-a');
const SHOTS = path.join(OUT, 'shots');
type Row = { state: string; note: string; mock?: string; app: string[] };
const rows: Row[] = [];
const png = (name: string) => path.join(SHOTS, `${name}.png`);
const add = (state: string, note: string, mock: string | undefined, app: string[]) => rows.push({ state, note, mock, app });

async function mockup(page: Page, file: string, scheme: 'light' | 'dark', run: (p: Page) => Promise<void>) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`file://${MOCKUPS}/${file}`);
  await page.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
  await page.addStyleTag({ content: 'h1,h1+p,.note,.tg,.notes{display:none!important}body{padding:0!important}.mw,.app,#app{height:100vh!important;border-radius:0!important;border:0!important}' });
  await run(page);
}

test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }));
test.afterAll(() => {
  const cell = (f?: string) => (f ? `<a href="shots/${f}.png"><img src="shots/${f}.png" loading="lazy"></a>` : '<em>no mockup frame</em>');
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>LAYOUT D5b: mockup vs app</title><style>body{font:14px system-ui;margin:16px;background:#f6f6f4;color:#1f2328}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d9e0;padding:6px;vertical-align:top}img{width:100%;display:block}h2{margin:18px 0 4px}small{color:#59636e}</style>
<h1>LAYOUT D5b lane A: mockup next to the app (1440x900)</h1>${rows
      .map((r) => `<h2>${r.state}</h2><small>${r.note}</small><table><tr><th>Mockup</th>${r.app.map((a) => `<th>App · ${a.split('-').pop()}</th>`).join('')}</tr><tr><td>${cell(r.mock)}</td>${r.app.map((a) => `<td>${cell(a)}</td>`).join('')}</tr></table>`)
      .join('')}`,
  );
});

test('shots', async ({ app, core, browser }) => {
  test.setTimeout(240_000);
  const project = core.project('nunchiro');
  for (const l of ['ux-fix-2', 'layout-d5', 'docs-1028h']) core.shell(project, l);
  unapproved(core, 'repo-stats', 'pr-checks');
  const mock = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await openWindow(app);
  const both = async (state: string, note: string, mockFile: string | undefined, mockRun: ((p: Page) => Promise<void>) | undefined, appRun?: () => Promise<void>) => {
    const key = state.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const shots: string[] = [];
    await appRun?.();
    for (const scheme of ['light', 'dark'] as const) {
      if (scheme === 'dark' && !['default', 'edit-mode-with-library'].includes(key)) continue;
      await app.emulateMedia({ colorScheme: scheme });
      await app.waitForTimeout(250);
      await app.screenshot({ path: png(`${key}-app-${scheme}`) });
      shots.push(`${key}-app-${scheme}`);
    }
    if (mockFile && mockRun) {
      await mockup(mock, mockFile, 'light', mockRun);
      await mock.waitForTimeout(200);
      await mock.screenshot({ path: png(`${key}-mock`) });
    }
    add(state, note, mockFile ? `${key}-mock` : undefined, shots);
  };
  const d5b = (run: (p: Page) => Promise<void>) => run;

  await both('Default', 'Left bar Tree, Files, Search; Right bar Diff, Preview, Board, Artifacts. The mockup also shows nested sub-views (lane B).', 'layout-d5b.html', d5b(async () => {}));
  await both('Files open', 'A click on the Files icon replaces the Tree in the left sidebar; it never splits it.', 'layout-d5b.html', d5b((p) => p.locator('.ri[data-w="files"]').first().click()), async () => {
    await icon(app, 'left', 'Files').click();
  });
  await both('Edit mode with library', 'The Layout button turns orange, the edit bar and the library open, icons get a dashed outline.', 'layout-d5b.html', d5b((p) => p.locator('#lay').click()), async () => {
    await startEdit(app);
  });
  await both('Icon moved to the other bar', 'Files dragged to the right bar; the right sidebar opens it.', 'layout-d5b.html', d5b((p) => p.evaluate(() => { (window as any).edit = true; (window as any).place('files', 'R', 1); (window as any).render(); })), async () => {
    await drag(app, icon(app, 'left', 'Files'), await barBefore(app, 'right', 1));
  });
  await both('Approval badge and sheet', 'D4 carry-over (the D5b mockup has no frame for it): an unapproved user widget shows "Needs approval"; the badge opens the existing permission sheet.', undefined, undefined, async () => {
    await card(app, 'widget:repo-stats').scrollIntoViewIfNeeded();
    await card(app, 'widget:repo-stats').getByRole('button', { name: 'Needs approval' }).click();
    await expect(app.getByRole('dialog')).toBeVisible();
  });
  await app.keyboard.press('Escape');
  await both('Compass mid-drag', 'D4 carry-over (no D5b mockup frame): five arms over a zone, the aimed arm filled, a preview and a caption.', undefined, undefined, async () => {
    await drag(app, card(app, 'files'), await at(app, 'terminal', 0.92, 0.5), { release: false });
  });
  await app.mouse.up();
  await app.keyboard.press('Escape');
  await endEditIfOn(app);

  // Title bar modes: the mockup draws the always-shown bar only.
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ titleBar: 'auto', titleHint: true })));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await both('Title bar Auto-hide', 'Revealed while the pointer is in the top 6 px; hidden otherwise (two frames: pointer away, pointer at the top).', undefined, undefined, async () => {
    await app.mouse.move(700, 2);
  });
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ titleBar: 'hidden' })));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await both('Title bar Hidden with the one-time hint', 'Hidden: no title bar; the hint names the way back. The macOS traffic lights are the app shell and are not drawn by the web page.', undefined, undefined);
  await mock.context().close();
  expect(rows.length).toBeGreaterThan(5);
});

async function endEditIfOn(page: Page) {
  if (await layoutButton(page).evaluate((e) => e.getAttribute('aria-pressed') === 'true')) await layoutButton(page).click();
}
