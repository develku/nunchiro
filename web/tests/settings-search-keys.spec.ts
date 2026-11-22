// Settings search keys (ticket 202 item 1; needs 69 one search, 171 and 172 basic interactions): Enter opens the first match
// and focuses its field (never while an IME composes), ArrowDown reaches the results and Up/Down move within them, Esc clears
// the query and keeps focus in the box; Esc with an empty box does what it did before (nothing is eaten).
import { expect, openWindow, test } from './fixtures';

async function openSearch(app: import('@playwright/test').Page) {
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  return app.getByRole('searchbox', { name: 'Search settings' });
}
const results = (app: import('@playwright/test').Page) => app.getByRole('list', { name: 'Matching settings' }).getByRole('button');

test('settings_search_enter_opens_first: Enter opens the first match and focuses its field', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app);
  await box.fill('terminal font size');
  await expect(results(app).first()).toContainText('Terminal font size');
  await box.press('Enter');
  await expect(app.getByRole('spinbutton', { name: 'Terminal font size' })).toBeFocused();
  await expect(app.getByRole('list', { name: 'Matching settings' })).toHaveCount(0); // opening a match clears the query
});

test('settings_search_enter_ime: Enter while an IME composes opens nothing (isComposing and keyCode 229)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app);
  await box.fill('terminal font size');
  await expect(results(app).first()).toBeVisible();
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    await box.evaluate((el, i) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...i })), init);
  }
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('terminal font size');
  await expect(results(app).first()).toBeVisible();
});

test('settings_search_enter_none: Enter with no match does nothing', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app);
  await box.fill('zzzz-no-such-setting');
  await expect(app.getByText('No setting matches')).toBeVisible();
  await box.press('Enter');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('zzzz-no-such-setting');
});

test('settings_search_arrows: Down reaches the results, Up/Down move within them, Up from the first returns to the box', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app);
  await box.fill('font');
  const found = results(app);
  expect(await found.count()).toBeGreaterThan(2);
  await box.press('ArrowDown');
  await expect(found.nth(0)).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(found.nth(1)).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(found.nth(2)).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await expect(found.nth(1)).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('ArrowUp');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('font');
  // A result opens from the keyboard.
  await box.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('list', { name: 'Matching settings' })).toHaveCount(0);
});

test('settings_search_esc: Esc clears the query and keeps focus in the box, from the box or from a result', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app);
  await box.fill('font');
  await expect(results(app).first()).toBeVisible();
  await box.press('Escape');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(app.getByRole('list', { name: 'Matching settings' })).toHaveCount(0);
  await box.fill('font');
  await box.press('ArrowDown');
  await expect(results(app).first()).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  // Settings stay open: Esc cleared the box, it did not leave the view.
  await expect(app.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
});

test('settings_search_esc_empty: Esc in an empty box is not eaten (it reaches the same handler as before)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app);
  await box.focus();
  // Observe the key at the window: an empty box must let it bubble, as before this change.
  await app.evaluate(() => {
    (window as unknown as { __esc: number }).__esc = 0;
    window.addEventListener('keydown', (e) => e.key === 'Escape' && ((window as unknown as { __esc: number }).__esc += 1));
  });
  await box.press('Escape');
  expect(await app.evaluate(() => (window as unknown as { __esc: number }).__esc)).toBe(1);
  // The window's handler since Settings became a modal (d2f5be99, D-20261108-10): the bubbled Esc closes Settings.
  const settings = app.getByRole('region', { name: 'Settings', exact: true });
  await expect(settings).toHaveCount(0);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeVisible();
  await box.fill('font');
  await box.press('Escape'); // with text, Esc is the box's own: it clears and stops there
  expect(await app.evaluate(() => (window as unknown as { __esc: number }).__esc)).toBe(1);
  await expect(box).toHaveValue('');
  await expect(settings).toBeVisible();
});
