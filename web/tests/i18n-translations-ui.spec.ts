import { stripOnTop, expect, openWindow, test } from './fixtures';

// Needs 93 (Language in Settings) and needs 157 (3) (it lives on General, the first page, as a click-to-pick row): Settings is
// click 1, picking Korean in the Language row is click 2. The old steps clicked radios on a page the nine-page IA dropped.
test('korean_visible: Settings > General > Language changes a visible label in two clicks', async ({ app, core }) => {
  stripOnTop(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('combobox', { name: /Language/ }).selectOption('ko');
  await expect(app.getByRole('combobox', { name: /언어/ })).toHaveValue('ko');
  await expect(app.getByRole('navigation', { name: '설정 페이지' }).getByRole('button', { name: '화면과 테마', exact: true })).toBeVisible();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
});
