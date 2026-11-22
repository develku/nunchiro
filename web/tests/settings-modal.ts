// Settings and the Board are one large modal (v25f F4). A reload keeps it open, so a spec cannot toggle it with Meta+Comma,
// and nothing behind it takes a click until it is closed.
import type { Page } from '@playwright/test';
import { expect } from './fixtures';

const dialog = (app: Page) => app.getByRole('dialog', { name: 'Settings' });

/** Opens Settings and never closes it: open already (a reload keeps it) is left as it is. */
export async function openSettings(app: Page) {
  // The visible control, not the chord: a chord pressed right after a reload can be dropped (ticket 106).
  const gear = app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' });
  if (!(await dialog(app).isVisible())) {
    // A window at the minimum width has no Left bar: the chord opens it there (it only toggles, so only when closed).
    if (await gear.count()) await gear.click();
    else await app.keyboard.press('Meta+Comma');
  }
  await expect(dialog(app)).toBeVisible();
}

/** Closes Settings when it is open, before a click on what sits behind it. */
export async function closeSettings(app: Page) {
  if (await dialog(app).isVisible()) await app.getByRole('button', { name: 'Close Settings' }).click();
  await expect(dialog(app)).toBeHidden();
}

/** Closes whichever modal is open (Settings or the Board), before a click on what sits behind it. */
export async function closeModal(app: Page) {
  const x = app.locator('.ovl .ovl-x');
  if (await x.count()) await x.click();
  await expect(app.locator('.ovl')).toHaveCount(0);
}
