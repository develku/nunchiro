// 11-20 guard (review SHOULD d): a run that refused to update or stop the core says so in the window, in one line.
import { expect, openWindow, test } from './fixtures';

const line = /does not update or stop the background service/;

test('a refused run shows one line about the core; a normal run shows none', async ({ app }) => {
  await openWindow(app, { coreForeign: true });
  await expect(app.getByRole('status').filter({ hasText: line })).toHaveCount(1);
  await expect(app.getByRole('status').filter({ hasText: line })).toContainText('logs/core.log');
});

test('the owner run without a refusal shows no such line', async ({ app }) => {
  await openWindow(app);
  await expect(app.getByRole('status').filter({ hasText: line })).toHaveCount(0);
});
