// Ticket 338 (owner 11-09): closing a running session's tab closes at once by default; with the General row on it asks once.
import type { Page } from '@playwright/test';
import { test, expect, openWindow } from './fixtures';

const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
const ask = (app: Page) => app.getByRole('alertdialog', { name: "Close the 'one' tab?" });
async function turnOn(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General', exact: true }).click();
  const row = app.getByRole('switch', { name: 'Ask before closing a running session tab' });
  await expect(row).not.toBeChecked();
  await row.click();
  await expect(row).toBeChecked();
  await app.keyboard.press('Escape');
  await expect(app.locator('.ovl')).toHaveCount(0);
}

test('close_running_tab: off closes at once; on asks from the key and the button, Keep keeps, Close closes', async ({ app, core }) => {
  const p = core.project('demo');
  const [one, two] = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await tab(app, one).click();
  await app.keyboard.press('Meta+KeyW');
  await expect(tab(app, one)).toHaveCount(0);
  await expect(app.getByRole('alertdialog')).toHaveCount(0);
  await app.getByRole('status').filter({ hasText: 'tab closed' }).getByRole('button', { name: 'Undo' }).click();
  await expect(tab(app, one)).toHaveCount(1);

  await turnOn(app);
  await tab(app, one).click();
  await app.keyboard.press('Meta+KeyW');
  await expect(ask(app)).toBeVisible();
  await expect(ask(app).getByRole('button', { name: 'Keep tab' })).toBeFocused();
  await ask(app).getByRole('button', { name: 'Keep tab' }).click();
  await expect(ask(app)).toHaveCount(0);
  await expect(tab(app, one)).toHaveCount(1);

  await tab(app, one).locator('..').getByRole('button', { name: /^Close tab/ }).click();
  await expect(ask(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(ask(app)).toHaveCount(0);
  await expect(tab(app, one)).toHaveCount(1);

  await tab(app, one).locator('..').getByRole('button', { name: /^Close tab/ }).click();
  await ask(app).getByRole('button', { name: 'Close tab', exact: true }).click();
  await expect(tab(app, one)).toHaveCount(0);
  await expect(tab(app, two)).toHaveCount(1);
  expect((core.cli('snapshot', '--json').sessions as { state: string }[]).filter((s) => s.state === 'running')).toHaveLength(2);
});
