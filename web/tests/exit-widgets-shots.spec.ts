// v25-exit-widgets (tickets 286, 288): before/after shots of every screen the lane changes, light and dark, into
// .scratch/shots-v25-exit-widgets/. SHOTS_PHASE=before|after names the files (default after). Not a gate check: it asserts nothing
// but that it ran; the promises are in widgets-open-without-session.spec.ts and ended-session-actions.spec.ts.
// Run: SHOTS_PHASE=before pnpm exec playwright test exit-widgets-shots --project=chromium
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { icon } from './d5b';
import { openQuiet } from './tree-seed';

const OUT = path.join(REPO, '.scratch', 'shots-v25-exit-widgets');
const phase = process.env.SHOTS_PHASE === 'before' ? 'before' : 'after';

async function both(app: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(150);
    await app.screenshot({ path: path.join(OUT, `${name}-${scheme}-${phase}.png`) });
  }
}
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: unknown };
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve(null), transformCallback: () => 1, metadata: {} };
  });
const state = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === id)?.state;
/** A shell the window shows, then quits: `exited`. */
async function ended(app: Page, core: Core, project: string, label: string) {
  const s = core.shell(project, label, '/bin/sh', '-c', 'read x; exit 0');
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
  core.cli('session', 'send-text', s.id, 'x\r');
  await expect.poll(() => state(core, s.id)).toBe('exited');
  return s.id;
}

test('shots: Browser icon with no session focused', async ({ app, core }) => {
  await fakeApp(app);
  const first = core.shell(core.project('nunchiro'), 'shell one');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${first.id}"]`).hover();
  await app.getByRole('button', { name: 'Close tab shell one' }).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  await icon(app, 'right', 'Browser').click();
  await app.waitForTimeout(400);
  await both(app, '1-browser-no-session');
});

test('shots: Browser tab of an agent session', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('nunchiro'), 'agent-a', 'go');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
  await app.waitForTimeout(400);
  await both(app, '2-browser-agent-pane');
});

test('shots: Terminal icon with no session focused', async ({ app, core }) => {
  const first = core.shell(core.project('nunchiro'), 'shell one');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${first.id}"]`).hover();
  await app.getByRole('button', { name: 'Close tab shell one' }).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  await icon(app, 'right', 'Terminal').click();
  await app.waitForTimeout(600);
  await both(app, '3-terminal-no-session');
});

test('shots: tab menu of an ended session', async ({ app, core }) => {
  await openWindow(app, {}, core);
  const id = await ended(app, core, core.project('nunchiro'), 'job');
  await app.locator(`.tab[data-tab="${id}"]`).click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' })).toBeVisible();
  await both(app, '4-ended-tab-menu');
});

test('shots: tree row menu of an ended session', async ({ app, core }) => {
  openQuiet(core);
  await openWindow(app, {}, core);
  const id = await ended(app, core, core.project('nunchiro'), 'job');
  // Ticket 1022 (b0e04c688): no "N done" fold; a session the window saw end keeps its row for 10 minutes.
  await app.locator(`button.row.wt2[data-menu-session="${id}"]`).click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' })).toBeVisible();
  await both(app, '5-ended-tree-row-menu');
});
