// Tickets 311, 312: a row's reset shows only while it differs from its default; a card goes back in one click and one undo;
// a failed read says so in plain words and Retry recovers. Real core; the one refused read is injected on the socket.
import type { Page } from '@playwright/test';
import { explainError, plainError } from '../src/errors';
import { expect, openWindow, test } from './fixtures';

async function page(app: Page, name: string) {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
}

test('settings_kit_plain_error: a known failure gets its sentence, an unknown one the generic line with its words under Details', () => {
  const t = ((k: string) => k) as Parameters<typeof explainError>[0];
  expect(plainError(t, new Error('core disconnected'))).toBe('settings.err.core');
  expect(plainError(t, '/a/b: Permission denied (os error 13)')).toBe('settings.err.denied');
  // Ticket 601 r2 (4804bfd82) gave 'agents.toml is too large' its group line, so the unknown case uses words no group knows.
  expect(explainError(t, new Error('agents.toml is too large')).what).toBe('err.h.fileBad');
  expect(explainError(t, new Error('the frobnicator jammed'))).toEqual({ what: 'err.failed', todo: 'err.failed.todo', details: 'the frobnicator jammed', known: false });
  // Another program's words are not Nunchiro's: no sentence about Nunchiro being busy or a folder's permissions.
  expect(explainError(t, 'git@host: Permission denied (publickey).').what).toBe('err.failed');
  expect(explainError(t, 'ssh: connect to host a port 22: Operation timed out').what).toBe('err.failed');
  expect(explainError(t, 'core disconnected', true)).toEqual({ what: 'err.failed', todo: 'err.failed.todo', details: 'core disconnected', known: false });
});

test('settings_kit_reset_only_when_changed: the row arrow and the card button put defaults back, undo restores the card', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await page(app, 'Terminal');
  // Ticket 391: Padding sits in Look's closed Advanced fold.
  await app.locator('section[aria-labelledby="h-term-look"] details > summary').click();
  const row = app.locator('[data-row="termPadLeft"]');
  const value = row.locator('input[type="number"]');
  const arrow = row.getByRole('button', { name: /^Reset .* to default$/ });
  const card = app.getByRole('button', { name: 'Reset Appearance to defaults' }); // 79926e264 renamed the Look card to Appearance
  await expect(row).toContainText(/Default \d+ px/);
  await expect(arrow).toHaveCount(0);
  await expect(card).toHaveCount(0);

  await value.fill('12');
  await arrow.click();
  await expect(value).toHaveValue('10');
  await expect(arrow).toHaveCount(0);
  await expect(value).toBeFocused(); // the arrow is gone; focus must not fall to the page

  await value.fill('7');
  await card.click();
  await expect(value).toHaveValue('10');
  await expect(card).toHaveCount(0);
  await app.keyboard.press('Meta+z');
  await expect(value).toHaveValue('7');

  // An edit made between the reset and the undo survives it, in this card and in another.
  const top = app.locator('[data-row="termPadTop"] input[type="number"]');
  const scroll = app.locator('[data-row="termScroll"] input[type="number"]');
  await card.click();
  await top.fill('9');
  await scroll.fill('2');
  await app.locator('.sbody h1, .sbody h2').first().click();
  await app.keyboard.press('Meta+z');
  await expect(value).toHaveValue('7');
  await expect(top).toHaveValue('9');
  await expect(scroll).toHaveValue('2');
});

// Ticket 391 (audit pick): each Terminal section shows its everyday rows; the rest wait in one closed Advanced fold.
test('terminal_advanced_fold: closed on open, a search for ligatures opens it and focuses the switch', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await page(app, 'Terminal');
  const folds = app.locator('section[aria-labelledby^="h-term-"] details');
  await expect(folds).toHaveCount(2);
  for (const f of await folds.all()) await expect(f).not.toHaveAttribute('open');
  // Kept outside the folds: scroll speed, Option as Meta, cursor.
  for (const row of ['termScroll', 'termOptionMeta', 'termCursor']) await expect(app.locator(`[data-row="${row}"]`)).toBeVisible();
  await expect(app.locator('[data-row="termLigatures"]')).toBeHidden();
  const search = app.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('ligatures');
  await search.press('Enter');
  const ligatures = app.getByRole('switch', { name: 'Ligatures' });
  await expect(ligatures).toBeFocused();
  await expect(app.locator('section[aria-labelledby="h-term-look"] details')).toHaveAttribute('open');
});

test('settings_kit_retry_after_failed_read: plain words, no endless reading line, Try again loads the page', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  let refuse = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r?.request?.op === 'quit_settings' && refuse-- > 0) return ws.send(JSON.stringify({ id: r.id, response: { Err: 'core is stopping' } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  refuse = 1;
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click(); // ticket 391: the orchestration switch lives here
  await expect(app.getByRole('alert')).toContainText('Lost the connection');
  await expect(app.locator('.sbody [role="status"]')).toHaveCount(0);
  await app.getByRole('button', { name: 'Try again' }).click();
  await expect(app.getByRole('alert')).toHaveCount(0);
  await expect(app.locator('[data-setting="orchEnabled"]')).toBeVisible();
});
