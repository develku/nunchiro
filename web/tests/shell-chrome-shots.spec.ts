// v25-shell-chrome: before/after shots of every screen the lane changes, light and dark, into .scratch/shots-v25-shell-chrome/.
// SHOTS_PHASE=before|after names the files (default after). Not a gate check: it asserts nothing but that it ran; the
// promises are in shell-chrome.spec.ts. Run: SHOTS_PHASE=before pnpm exec playwright test shell-chrome-shots --project=chromium
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { fakes, gitRepo, PERMISSION, show } from './decision-rows-seed';
import { icon } from './d5b';

const OUT = path.join(REPO, '.scratch', 'shots-v25-shell-chrome');
const phase = process.env.SHOTS_PHASE === 'before' ? 'before' : 'after';

async function both(app: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(150);
    await app.screenshot({ path: path.join(OUT, `${name}-${scheme}-${phase}.png`) });
  }
}

function seed(core: Core) {
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go');
  const s1 = core.shell(p, 'shell one');
  const s2 = core.shell(p, 'shell two');
  return { a, s1, s2 };
}

test('shots: window with tabs, left sidebar, icon bars', async ({ app, core }) => {
  seed(core);
  await openWindow(app);
  await both(app, '1-window');
});

test('shots: right sidebar, side pane and the terminal widget', async ({ app, core }) => {
  const { a } = seed(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Diff').click();
  await icon(app, 'right', 'Terminal').click();
  await expect(app.locator('[data-side-pane]')).toBeVisible();
  await both(app, '2-panes');
});

test('shots: an ended session tab', async ({ app, core }) => {
  const { s1 } = seed(core);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s1.id}"]`).click();
  core.windowClose(s1.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator(`.tab[data-tab="${s1.id}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await both(app, '3-ended');
});

test('shots: Board stacked in the main zone', async ({ app, core }) => {
  seed(core);
  await openWindow(app);
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click();
  await expect(app.locator('.board')).toBeVisible();
  await both(app, '4-board');
});

test('shots: a waiting decision dots its icon; both sidebars open at one shared width', async ({ app, core }) => {
  fakes(core);
  const a = core.agent(gitRepo(core, 'repo'), 'wt-a', 'go-a', true);
  await openWindow(app);
  show(a.cwd, 'go-a', PERMISSION('rm x'));
  await expect(icon(app, 'right', 'Decisions').locator('.wdot')).toBeVisible({ timeout: 8000 });
  await both(app, '5-waiting-dot');
  await icon(app, 'right', 'Decisions').click();
  await expect(app.locator('aside.sbar[data-side="right"]')).toBeVisible();
  await both(app, '6-both-sidebars');
});
