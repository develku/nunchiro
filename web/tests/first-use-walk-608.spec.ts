// Ticket 608 (first-use walk 4, F10): the dead ends this walk found, each fixed.
import { expect, openWindow, test } from './fixtures';

test.describe('first run', () => {
  test.use({ firstRun: true });
  // D1: in a window with no native folder picker (the browser build), Choose folder… did nothing and said nothing.
  test('no_picker_says_type_the_path: Browse folder and Choose folder… say to type the path, and a typed path starts an agent', async ({ app, core }) => {
    await app.goto('/');
    const settings = app.getByRole('dialog', { name: 'Settings' });
    await settings.locator('.ob-step[data-step="project"]').click();
    await settings.locator('button[data-go="project"]').click();
    await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Browse folder/ }).click();
    const popover = app.getByRole('dialog', { name: 'New tab' });
    await expect(popover.getByRole('alert')).toHaveText("Could not open the folder picker. Type the folder path in the search instead.");
    await expect(popover.getByRole('combobox')).toBeFocused();
    // The row asked again says it again (it was silent before).
    await popover.getByRole('combobox').fill('');
    await popover.getByRole('option', { name: /^Choose folder…/ }).click();
    await expect(popover.getByRole('alert')).toContainText('Type the folder path');
    // And the way it names works: a typed path, then the agent.
    const dir = core.project('typed');
    await popover.getByRole('combobox').fill(dir);
    await popover.getByRole('option', { name: new RegExp(`^${dir}`) }).click();
    await expect(popover.locator('.nt-in')).toHaveAttribute('title', dir);
    await popover.getByRole('option', { name: /^Claude/ }).click();
    await expect(app.locator('.tab[data-tab]:not([data-tab="settings"])')).toHaveCount(1);
  });
});

// D2, D3: the palette found no notification level ("mute") and no way back to Onboarding; each row now opens its place.
test('palette_rows_open_their_place: "mute" focuses the notification level, "onboarding" opens the Onboarding steps', async ({ app }) => {
  await openWindow(app);
  const go = async (q: string, title: string) => {
    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('dialog').getByRole('combobox').fill(q);
    await expect(app.locator('#palette-list [data-command^="settings."]').first()).toContainText(title);
    await app.keyboard.press('Enter');
  };
  await go('mute', 'Settings: Notification level for new sessions');
  await expect(app.locator('input[name="notify-default"]:focus')).toHaveCount(1);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await go('onboarding', 'Settings: Onboarding steps');
  await expect(app.locator('.ob-step[aria-current="step"]')).toBeFocused();
});
