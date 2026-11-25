// V2-6d (ticket 57, moved to the tree row by ticket 1070): closing an ended session from its tree row's menu offers
// "Closed <name> · Undo" in the status line for 10 s; Undo takes the close back; only the latest close is undoable.
// (A running session's Close only stops it and is not undoable.) Each test runs a real core with its own NUNCHIRO_HOME.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const line = (p: Page) => p.locator('footer.status .undoline');
const stateOf = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === id)?.state;
const row = (p: Page, id: string) => p.locator(`button.row.wt2[data-menu-session="${id}"]`).first(); // a just-finished session shows a second row for a while
/** A shell the window shows, then quits on its own: state `exited`, not closed. */
async function ended(app: Page, core: Core, project: string, label: string) {
  const s = core.shell(project, label, '/bin/sh', '-c', 'read x; exit 0');
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
  core.cli('session', 'send-text', s.id, 'x\r');
  await expect.poll(() => stateOf(core, s.id)).toBe('exited');
  await expect(row(app, s.id)).toBeVisible();
  return s.id;
}
async function close(app: Page, id: string) {
  await row(app, id).click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Close session' }).click();
}

test.describe('close undo', () => {
  test('close_undo_ui', async ({ app, core }) => {
    const p = core.project('demo');
    openQuiet(core);
    await openWindow(app);
    const a = await ended(app, core, p, 'lumen-api');
    await close(app, a);
    await expect.poll(() => stateOf(core, a)).toBeUndefined();
    await expect(line(app)).toContainText('Closed lumen-api');
    const r = await new AxeBuilder({ page: app }).include('footer.status').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
    await line(app).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => stateOf(core, a)).toBe('exited');
    await expect(line(app)).toHaveCount(0);
  });

  test('close_undo_only_latest', async ({ app, core }) => {
    const p = core.project('demo');
    openQuiet(core);
    await openWindow(app);
    const a = await ended(app, core, p, 'first');
    const b = await ended(app, core, p, 'second');
    for (const id of [a, b]) {
      await close(app, id);
      await expect.poll(() => stateOf(core, id)).toBeUndefined();
    }
    await expect(line(app)).toContainText('Closed second');
    await line(app).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => stateOf(core, b)).toBe('exited');
    expect(stateOf(core, a)).toBeUndefined();
  });
});
