// V2-6d (ticket 57): closing a stopped or done session from its AGENTS row offers "Closed <name> · Undo" in the status
// line for 10 s; Undo brings the row back in its place. A working session keeps its Stop (not undoable).
// Each test runs a real core with its own NUNCHIRO_HOME under .scratch.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { expect, openWindow, REPO, test, agentsZone } from './fixtures';

const line = (p: Page) => p.locator('footer.status .undoline');
const agentIds = (p: Page) => p.locator('.ar').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(REPO, '.scratch/shots', `v2-6d-${name}-${test.info().project.name}.png`) });

test.describe('close undo', () => {
  test.beforeEach(({ core }) => agentsZone(core));

  test('close_undo_ui', async ({ app, core }) => {
    const p = core.project('demo');
    const a = core.shell(p, 'lumen-api').id;
    const b = core.shell(p, 'busy').id;
    const c = core.shell(p, 'other').id;
    core.cli('session', 'close', a);
    core.cli('session', 'close', c);
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    const before = await agentIds(app);
    // The working row offers Stop only; the stopped one offers Close.
    const busy = app.locator('.arow').filter({ has: app.locator(`[data-agent="${b}"]`) });
    await busy.hover();
    await expect(busy.getByRole('button', { name: 'Stop busy' })).toBeVisible();
    await expect(busy.getByRole('button', { name: /^Close/ })).toHaveCount(0);
    const row = app.locator('.arow').filter({ has: app.locator(`[data-agent="${a}"]`) });
    await row.hover();
    await shot(app, 'hover');
    await row.getByRole('button', { name: 'Close lumen-api' }).click();
    await expect.poll(() => agentIds(app)).toEqual(before.filter((id) => id !== a));
    await expect(line(app)).toContainText('Closed lumen-api');
    await shot(app, 'closed');
    const r = await new AxeBuilder({ page: app }).include('footer.status').include('.agents').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
    await line(app).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => agentIds(app)).toEqual(before);
    await expect(line(app)).toHaveCount(0);
    await shot(app, 'undone');
  });

  test('close_undo_only_latest', async ({ app, core }) => {
    const p = core.project('demo');
    const a = core.shell(p, 'first').id;
    const b = core.shell(p, 'second').id;
    core.cli('session', 'close', a);
    core.cli('session', 'close', b);
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(2);
    for (const name of ['first', 'second']) {
      const row = app.locator('.arow').filter({ hasText: name });
      await row.hover();
      await row.getByRole('button', { name: `Close ${name}` }).click();
      // The closed row leaves the list and the rows below move up: hover the next one only after that, or the hover is lost.
      await expect(row).toHaveCount(0);
    }
    await expect(line(app)).toContainText('Closed second');
    await line(app).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => agentIds(app)).toEqual([b]);
  });
});
