// Ticket 991 C19: small Settings slips. A prefix chord in a row's description never breaks between the prefix and its key
// (a lone "?" wrapped to its own line on Keyboard), and the Artifact Libraries page says its title once.
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('keys_chord_one_line_C19: Prefix › ? stays on one line at a narrow window', async ({ app }) => {
  await app.setViewportSize({ width: 1000, height: 900 });
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="keys"]').click();
  const chord = app.locator('[data-row] .sds .kchord, .srow .sds .kchord').first();
  await expect(chord).toBeVisible();
  expect(await chord.evaluate((e) => [e.getClientRects().length, getComputedStyle(e).whiteSpace])).toEqual([1, 'nowrap']);
});

test('libraries_title_once_C19: the page head names Artifact Libraries; no second visible heading repeats it', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="libraries"]').click();
  await expect(app.locator('.spage h1')).toHaveText('Artifact libraries');
  // Screen-reader only (the .sr clip): it stays for the structure and the search, drawn at 1 px.
  expect(await app.locator('#h-libs').evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(3);
});

// Ticket 991 C15: one control style. Add machine and Add teammate are the same button kind (outlined, with the plus);
// the scrollback count is in the window's font with no native spin arrows, as the kit's steppers. Ticket 993: Add
// schedule left Settings with its page (the Schedules widget's "+" is its header's icon button).
test('one_add_button_kind_C15: the Add buttons look alike; the scrollback box is a kit number box', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  const look = async (page: string, name: string) => {
    await nav.locator(`button[data-page="${page}"]`).click();
    const b = app.getByRole('button', { name, exact: true });
    return b.evaluate((e) => [e.className, !!e.querySelector('svg'), getComputedStyle(e).backgroundColor]);
  };
  const looks = [await look('team', 'Add teammate'), await look('machines', 'Add machine')];
  expect(looks[1]).toEqual(looks[0]);
  await nav.locator('button[data-page="terminal"]').click();
  const box = app.locator('[data-setting="scrollback"]');
  const [font, bodyFont, look2] = await box.evaluate((e) => [getComputedStyle(e).fontFamily, getComputedStyle(document.body).fontFamily, getComputedStyle(e).appearance]);
  expect(font).toBe(bodyFont);
  expect(look2).toBe('textfield');
});
