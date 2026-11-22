import path from 'node:path';
import { expect, openWindow, test } from './fixtures';

const quitRequest = (page: import('@playwright/test').Page) => page.evaluate(() => window.dispatchEvent(new Event('nunchiro:quit-request')));

test('the full quit lists running agents and pending items, and Cancel changes nothing', async ({ app, core }) => {
  const project = core.project('demo');
  const trigger = path.join(project, 'go');
  core.shell(project, 'plain');
  core.agent(project, 'asker', trigger);
  await openWindow(app);
  // Make the fake agent raise its permission dialog so the queue holds one pending item.
  (await import('node:fs')).writeFileSync(trigger, '');
  await expect.poll(() => core.cli('snapshot', '--json').sessions.flatMap((s: { pending: unknown[] }) => s.pending).length, { timeout: 15_000 }).toBe(1);
  await quitRequest(app);
  const dialog = app.getByRole('dialog', { name: 'Quit and stop all agents' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Running agents (2)');
  await expect(dialog).toContainText('plain');
  await expect(dialog).toContainText('asker');
  await expect(dialog).toContainText('Pending queue items (1)');
  // Ticket 559 (F2): the decision's title, never its kind word or the terminal text behind it.
  await expect(dialog.locator('li').filter({ hasText: 'asker' }).last()).toHaveText(/asker\s*· (risky permission|Permission)$/i);
  await expect(dialog).not.toContainText('Do you want to proceed');
  await expect(dialog).not.toContainText('permission:');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(core.cli('snapshot', '--json').sessions.filter((s: { state: string }) => s.state === 'running')).toHaveLength(2);
});

test('Esc cancels the quit confirmation', async ({ app, core }) => {
  core.shell(core.project('demo'), 'plain');
  await openWindow(app);
  await quitRequest(app);
  await expect(app.getByRole('dialog', { name: 'Quit and stop all agents' })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
});

test('a quit asked before the page listened still shows the confirmation', async ({ app, core }) => {
  core.shell(core.project('demo'), 'plain');
  await app.addInitScript(() => ((window as unknown as { __NUNCHIRO_QUIT__: boolean }).__NUNCHIRO_QUIT__ = true));
  await openWindow(app);
  await expect(app.getByRole('dialog', { name: 'Quit and stop all agents' })).toBeVisible();
});

test('outside the app the window cannot stop the core and says how to', async ({ app, core }) => {
  core.shell(core.project('demo'), 'plain');
  await openWindow(app);
  await quitRequest(app);
  await app.getByRole('dialog').getByRole('button', { name: 'Quit and stop all agents' }).click();
  await expect(app.getByRole('alert')).toContainText('nunchiro serve stop');
  expect(core.cli('snapshot', '--json').sessions[0].state).toBe('running');
});

test('the first window close shows a one-time notice naming the full quit; later closes do not', async ({ app, core }) => {
  core.shell(core.project('demo'), 'plain');
  await openWindow(app);
  const closeRequest = () => app.evaluate(() => window.dispatchEvent(new Event('nunchiro:close-request')));
  await closeRequest();
  const notice = app.getByRole('dialog', { name: 'Closing the window' });
  await expect(notice).toContainText('Agents keep running');
  await expect(notice).toContainText('⌘⌥Q');
  await expect(notice).toContainText('nunchiro serve stop');
  await notice.getByRole('button', { name: 'Close the window' }).click();
  await expect(notice).toHaveCount(0);
  await closeRequest();
  await expect(app.getByRole('dialog')).toHaveCount(0);
});

test('the command palette lists the full quit', async ({ app, core }) => {
  core.shell(core.project('demo'), 'plain');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog').getByRole('combobox').fill('stop all');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('dialog', { name: 'Quit and stop all agents' })).toBeVisible();
});
