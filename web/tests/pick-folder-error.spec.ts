// V2.5-34 picker_error_shown: when the dialog plugin call fails, the popover says so and the search stays to type a path in
// (v25-new-tab, needs 209: "+ Project" opens the folder picker at once; the old Choose folder… button and path field are gone).
import { expect, test } from './fixtures';

test('a failing folder picker is shown with the path field to type in', async ({ page, core }) => {
  await page.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
    (window as any).__TAURI_INTERNALS__ = { invoke: () => Promise.reject('plugin dialog not found') };
  }, core.boot());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: '' } })));
  const dialog = page.getByRole('dialog', { name: 'New tab' });
  await expect(dialog.getByRole('alert')).toContainText("Could not open the folder picker");
  await expect(dialog.getByRole('combobox')).toBeEditable();
});

test('a cancelled picker is not an error', async ({ page, core }) => {
  await page.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
    (window as any).__TAURI_INTERNALS__ = { invoke: () => Promise.resolve(null) };
  }, core.boot());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: '' } })));
  const dialog = page.getByRole('dialog', { name: 'New tab' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
