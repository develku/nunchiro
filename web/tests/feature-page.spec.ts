// V2.5-33d (ticket 169), `new_page_one_file`: a fixture page registered from one file is in the Settings nav, two clicks
// from the window. The fixture is built in only for this suite (playwright.config.ts sets VITE_FEATURE_FIXTURES).
import { expect, openWindow, test } from './fixtures';
import { harness } from './theme-harness';

test('new_page_one_file: Settings, then the fixture page shows its body', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await app.addInitScript(() => ((window as { __NUNCHIRO_FEATURE_FIXTURE__?: boolean }).__NUNCHIRO_FEATURE_FIXTURE__ = true));
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // click 1
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Fixture page', exact: true }).click(); // click 2
  await expect(app.getByRole('heading', { name: 'Fixture page', level: 2 })).toBeVisible();
  await expect(app.getByText('Registered from one file.')).toBeVisible();
});

// Ticket 170: the palette's field commands follow the registry, so a page registered after the window drew is searchable.
test('palette_sees_late_page: a page registered after start shows its field in the palette', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await expect(palette.locator('[data-command="settings.late-fixture.lateField"]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await app.evaluate(() => window.dispatchEvent(new Event('nunchiro-fixture-late')));
  await app.keyboard.press('Meta+KeyK');
  await expect(palette.locator('[data-command="settings.late-fixture.lateField"]')).toHaveCount(1);
});
