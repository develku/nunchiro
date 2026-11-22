// V1A-54 item 5 (owner pass 2026-10-26): the palette input shows no autocorrect or spelling marks, and after Esc the
// keyboard reaches the terminal again without a click.
import { expect, openWindow, terminalText, test } from './fixtures';

test('palette-esc-focus: the search field turns autocorrect, autocapitalise and spellcheck off', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const input = app.getByRole('combobox', { name: 'Command palette search' });
  await expect(input).toHaveAttribute('spellcheck', 'false');
  await expect(input).toHaveAttribute('autocorrect', 'off');
  await expect(input).toHaveAttribute('autocapitalize', 'off');
  await expect(input).toHaveAttribute('autocomplete', 'off');
});

for (const open of ['Meta+KeyK', 'click'] as const) {
  test(`palette-esc-focus: opened by ${open}, Esc, then typing and prefix o reach the terminal without a click`, async ({ app, core }) => {
    const s = core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.locator(`.term[data-session="${s.id}"]`).click();
    if (open === 'click') await app.getByRole('button', { name: 'Open command palette' }).click();
    else await app.keyboard.press(open);
    await expect(app.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('KeyO');
    await app.keyboard.type('after-esc');
    await expect.poll(() => terminalText(app, s.id)).toContain('after-esc');
  });
}

// Ticket 553 (review inputs-all-542 r1): `.palette input` used to set `outline: 0`, which took the ring from every palette dialog field.
test('palette-focus-ring: the focused search field shows the shared focus ring', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const input = app.getByRole('combobox', { name: 'Command palette search' });
  await expect(input).toBeFocused();
  const ring = await input.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth };
  });
  expect(ring).toEqual({ style: 'solid', width: '2px' });
});
