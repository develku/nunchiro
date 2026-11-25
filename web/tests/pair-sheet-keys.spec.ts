// Ticket 203 (needs 80, 171, 172): the pairing dialog on the Mac window is answered only from the window. Esc is Deny
// (one answer, trusted key only), focus goes inside on open, Tab stays inside, focus returns when answered.
// Settings5: focus lands on the dialog itself, never on a button, so a stray Space or Enter pressed on arrival answers
// nothing; Tab then reaches Deny first, then Allow.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { enable, freePort, phone } from './web-access-shared';

test.setTimeout(60_000);

/** Every pairing answer the window sends the core (its WebSocket `browser` frames). */
function answers(app: Page) {
  const sent: { allow: boolean }[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      try {
        const b = (JSON.parse(f.payload) as { browser?: { op?: string; allow?: boolean } }).browser;
        if (b?.op === 'answer') sent.push({ allow: !!b.allow });
      } catch {
        // Not JSON: not an answer.
      }
    }),
  );
  return sent;
}

/** A paired-request dialog is up on the Mac window; `marker` is the element that had focus just before it opened. */
async function ask(app: Page, browser: Parameters<typeof phone>[0]) {
  const port = await freePort();
  await enable(app, port);
  await app.getByRole('switch', { name: 'Allow phone and web access', exact: true }).focus();
  await app.getByRole('switch', { name: 'Allow phone and web access', exact: true }).evaluate((e) => e.setAttribute('data-before-dialog', ''));
  const { page } = await phone(browser, `http://127.0.0.1:${port}/`);
  await page.getByRole('button', { name: 'Pair' }).click();
  const sheet = app.getByRole('dialog', { name: 'Browser pairing request' });
  await expect(sheet).toBeVisible();
  // Event-driven (item 4): the dialog is visible a frame before its focus effect has run, and a key pressed in between
  // would reach the element that had focus before it. Wait for the focus itself, never a sleep.
  await expect(sheet).toBeFocused();
  return { sheet, phone: page };
}

test('pair_esc_denies_once: Esc inside the dialog sends one Deny', async ({ app, browser }) => {
  const sent = answers(app);
  await openWindow(app);
  const { sheet, phone: page } = await ask(app, browser);
  // The dialog holds focus on open: no button, so no Allow and no Deny by a stray key.
  await expect(sheet).toBeFocused();
  await app.keyboard.press('Escape');
  await app.keyboard.press('Escape'); // a second Esc while the first is in flight or answered adds nothing
  await expect(sheet).toHaveCount(0);
  await app.waitForTimeout(500);
  expect(sent).toEqual([{ allow: false }]);
  await expect(page.getByRole('alert')).toHaveText('The pairing was denied or expired.');
});

test('pair_untrusted_keydown_is_ignored: a script-made Esc never answers', async ({ app, browser }) => {
  const sent = answers(app);
  await openWindow(app);
  const { sheet } = await ask(app, browser);
  await sheet.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await app.waitForTimeout(600);
  await expect(sheet).toBeVisible();
  expect(sent).toEqual([]);
  // The real key still works afterwards. The script-made Esc also closed the Settings modal behind the sheet (the modal's own
  // listener does not check isTrusted) and handed focus back to the page; put it on the dialog again, as the user's own click would.
  await sheet.focus();
  await app.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(sent).toEqual([{ allow: false }]);
});

test('pair_enter_never_allows: Enter on first focus is not an Allow', async ({ app, browser }) => {
  const sent = answers(app);
  await openWindow(app);
  const { sheet } = await ask(app, browser);
  // Settings5: Enter on arrival answers nothing (focus is the dialog); Tab reaches Deny, and Enter there is a Deny.
  await app.keyboard.press('Enter');
  await app.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Deny' })).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  await app.waitForTimeout(400);
  expect(sent.filter((s) => s.allow)).toEqual([]);
  expect(sent).toEqual([{ allow: false }]);
});

test('pair_arrival_focus_safe: Space and Enter on arrival answer nothing; Tab reaches Deny then Allow; Esc denies', async ({ app, browser }) => {
  const sent = answers(app);
  await openWindow(app);
  const { sheet, phone: page } = await ask(app, browser);
  const deny = sheet.getByRole('button', { name: 'Deny' });
  const allow = sheet.getByRole('button', { name: 'Allow' });
  await expect(sheet).toBeFocused();
  await expect(sheet).toHaveAttribute('tabindex', '-1');
  await app.keyboard.press('Space');
  await app.keyboard.press('Enter');
  // Still pending: the dialog is up, nothing was sent, and the phone still waits.
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeFocused();
  expect(sent).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Tab reaches Deny, then Allow; Shift+Tab from Allow comes back to Deny.
  await app.keyboard.press('Tab');
  await expect(deny).toBeFocused();
  await app.keyboard.press('Tab');
  await expect(allow).toBeFocused();
  await app.keyboard.press('Shift+Tab');
  await expect(deny).toBeFocused();
  expect(sent).toEqual([]);
  await app.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  expect(sent).toEqual([{ allow: false }]);
});

test('pair_arrival_focus_safe: Esc on the dialog denies', async ({ app, browser }) => {
  const sent = answers(app);
  await openWindow(app);
  const { sheet } = await ask(app, browser);
  await expect(sheet).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(sent).toEqual([{ allow: false }]);
});

test('pair_focus_stays_inside_and_returns: Tab is trapped, focus goes back after the answer', async ({ app, browser }) => {
  const sent = answers(app);
  await openWindow(app);
  const { sheet } = await ask(app, browser);
  const inside = () => sheet.evaluate((el) => el.contains(document.activeElement));
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await app.keyboard.press(key);
    expect(await inside(), `focus after ${key}`).toBe(true);
  }
  await sheet.getByRole('button', { name: 'Deny' }).click();
  await expect(sheet).toHaveCount(0);
  expect(sent).toEqual([{ allow: false }]);
  await expect(app.locator('[data-before-dialog]')).toBeFocused();
});
