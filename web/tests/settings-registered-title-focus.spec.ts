// A registered Settings page (Skills & hooks is one) keeps the focus on its title after a nav click, as a built-in page
// does: its own field no longer takes the focus once its list loads.
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('registered_page_title_takes_focus: Skills & hooks opened from the nav focuses its title, also after its MCP list loads', async ({ app, core }) => {
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
  const title = app.locator('.settings header.phd h1');
  await expect(title).toHaveText('Skills & hooks');
  await expect(app.locator('[data-mcp="own"]').getByRole('textbox', { name: 'Command' })).toBeVisible(); // the list loaded
  await app.waitForTimeout(300);
  await expect(title).toBeFocused();
});
