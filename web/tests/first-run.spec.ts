// Ticket 305 (owner RC feedback F11): the centre checklist is gone. The empty centre is a Landing (mark, one button, keys);
// setup lives in Settings > Onboarding (settings-onboarding.spec.ts).
import { expect, openWindow, test } from './fixtures';

test.describe('fresh window', () => {
  test.use({ firstRun: true });

  test('first_run_center_checklist_is_gone: no "Getting started", the Landing shows once Settings closes', async ({ app }) => {
    await openWindow(app);
    const settings = app.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close Settings' }).click();
    const center = app.locator('.pane .empty');
    await expect(center.getByText('Add a project to get started')).toBeVisible();
    await expect(center.getByRole('button', { name: 'Add project' })).toBeVisible();
    await expect(center.locator('.landing-mark')).toBeVisible();
    await expect(center.locator('.landing-keys')).toContainText('⌘K');
    // Look 1117 v4f (A q10b-1): the hint key in the ◆ form the rest of the window uses, with what ◆ is.
    await expect(center.locator('.landing-keys')).toContainText('◆ f');
    await expect(center.locator('.landing-keys')).toContainText('◆ = ⌃.');
    await expect(center.locator('.landing-keys')).not.toContainText('Prefix');
    await expect(app.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
    await expect(center.locator('ol, input')).toHaveCount(0);
    await app.screenshot({ path: `../.scratch/shots/landing-${test.info().project.name}.png` });
  });
});

test('first-run: the Landing button opens the start flow', async ({ app }) => {
  await openWindow(app);
  await app.locator('.pane .empty').getByRole('button', { name: 'Add project' }).click();
  await expect(app.getByRole('dialog', { name: 'Add project' })).toBeVisible();
});

test('first-run: the palette command opens Settings > Onboarding, with a session open too', async ({ app, core }) => {
  core.shell(core.project('beta'), 'beta');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="firstrun.open"]').click();
  await expect(app.locator('.ob-step')).toHaveCount(8); // ticket 391: six steps with ticket 582's first session, seven with the keys step (owner 11-16), eight with the assistant step (ticket 1034), the macOS one only in the app
});
