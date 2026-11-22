// Ticket 106: the global key handler is attached before the first frame, so a chord pressed the moment the window
// opens reaches it (WebKit showed a frame before the old passive effect ran, and dropped the key).
import { expect, openWindow, test } from './fixtures';

test('early_chord_not_dropped_webkit: one Meta+Comma right after the window opens shows Settings', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await expect(app.getByRole('navigation', { name: 'Settings pages' })).toBeVisible({ timeout: 2000 });
});
