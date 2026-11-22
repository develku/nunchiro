// Ticket 414 item L: a Settings page opened with the mouse (or an accessibility press) draws no focus ring around its title;
// one opened from the keyboard still moves focus to the title and draws the standard ring there.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const button = (app: Page, name: string) => nav(app).getByRole('button', { name, exact: true });
const title = (app: Page) => app.locator('.settings header.phd h1');
const ring = (app: Page) =>
  title(app).evaluate((h) => {
    const s = getComputedStyle(h);
    return { drawn: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0, style: s.outlineStyle, width: s.outlineWidth };
  });

test('settings_title_focus: a mouse-opened page shows no ring on its title; a keyboard-opened one keeps focus and the ring', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  const search = app.getByRole('searchbox', { name: 'Search settings' });
  await expect(search).toBeFocused(); // A13: the search box holds the focus when Settings opens
  // Mouse: focus still follows the page to its title (focus management kept), with no ring.
  for (const name of ['Appearance', 'Keyboard', 'About']) {
    await button(app, name).click();
    await expect(title(app)).toHaveText(name);
    await expect(title(app), name).toBeFocused();
    expect((await ring(app)).drawn, `${name}: ${JSON.stringify(await ring(app))}`).toBe(false);
  }
  // An accessibility press (the real-app report): a click that no pointer or key went before, after typing in the search box.
  // The engine carried the search box's :focus-visible over to the title and drew the ring.
  await search.click();
  await app.keyboard.type('x');
  await app.keyboard.press('Escape'); // clears the query, the focus stays in the box
  await expect(search).toBeFocused();
  await button(app, 'Layout').evaluate((b: HTMLButtonElement) => b.click());
  await expect(title(app)).toHaveText('Layout');
  await expect(title(app)).toBeFocused();
  expect((await ring(app)).drawn, JSON.stringify(await ring(app))).toBe(false);
  // Keyboard: Enter, then Space, on a nav button opens its page; focus lands on the title and the ring is drawn.
  for (const [name, key] of [['Notifications', 'Enter'], ['Terminal', 'Space']]) {
    await button(app, name).focus();
    await app.keyboard.press(key);
    await expect(title(app)).toHaveText(name);
    await expect(title(app)).toBeFocused();
    expect(await title(app).evaluate((h) => h.matches(':focus-visible')), key).toBe(true);
    expect((await ring(app)).drawn, `${key}: ${JSON.stringify(await ring(app))}`).toBe(true);
  }
  // A title quieted by a mouse open loses the mark with the focus, so a later keyboard focus draws the ring.
  await button(app, 'Appearance').click();
  await expect(title(app)).toHaveAttribute('data-quiet', '');
  await app.keyboard.press('Tab');
  await expect(title(app)).not.toBeFocused();
  await expect(title(app)).not.toHaveAttribute('data-quiet');
});
