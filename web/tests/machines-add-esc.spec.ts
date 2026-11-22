// Needs 171, 172 (ticket 206): the Machines add form closes with Escape and a Cancel button, drops the typed alias, sends
// nothing to the core and returns focus to the "Add machine" button; both are ignored while the add is in flight.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type Frame = { id: number; request?: { op: string; alias?: string } };
/** The window's requests, and a held `add_machine` the test answers by hand (the real core would try ssh). */
async function machines(app: Page, rows: unknown[] = []) {
  const sent: string[] = [];
  const held: { answer?: (reply: unknown) => void } = {};
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      if (msg.request) sent.push(msg.request.op);
      if (rows.length && msg.request?.op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines: rows } } }));
      else if (msg.request?.op === 'add_machine') held.answer = (response) => ws.send(JSON.stringify({ id: msg.id, response }));
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click();
  await expect(app.locator('.machines-page')).toBeVisible();
  return { sent, held };
}
const addButton = (app: Page) => app.getByRole('button', { name: 'Add machine', exact: true });
const form = (app: Page) => app.locator('form.machine-add');
const alias = (app: Page) => app.getByRole('combobox', { name: 'Host', exact: true });

test('machines_add_esc_closes: Escape closes the form, drops the alias, returns focus, sends nothing', async ({ app }) => {
  const { sent } = await machines(app);
  await addButton(app).click();
  await expect(alias(app)).toBeFocused();
  await alias(app).fill('studio');
  await app.keyboard.press('Escape');
  await expect(form(app)).toHaveCount(0);
  await expect(addButton(app)).toBeFocused();
  await expect(addButton(app)).toHaveAttribute('aria-expanded', 'false');
  expect(sent).not.toContain('add_machine');
});

test('machines_add_cancel_button: Cancel closes it the same way; both are ignored while the add is in flight; a reopened form is empty', async ({ app }) => {
  const { sent, held } = await machines(app);
  await addButton(app).click();
  await alias(app).fill('studio');
  await form(app).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form(app)).toHaveCount(0);
  await expect(addButton(app)).toBeFocused();
  expect(sent).not.toContain('add_machine');
  // A second open starts empty.
  await addButton(app).click();
  await expect(alias(app)).toHaveValue('');
  // In flight: the add is sent and not yet answered.
  await alias(app).fill('studio');
  await form(app).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => sent.filter((op) => op === 'add_machine').length).toBe(1);
  await expect(form(app).getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await alias(app).press('Escape');
  await expect(form(app)).toBeVisible();
  // The core refuses it: the form stays with its alias and works again.
  held.answer!({ Err: 'no such host' });
  await expect(app.getByRole('alert')).toContainText('no such host');
  await expect(form(app).getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await expect(alias(app)).toHaveValue('studio');
  await alias(app).press('Escape');
  await expect(form(app)).toHaveCount(0);
});

/** What an IME sends when Esc cancels a composition: a keydown `Escape` with `isComposing` set. */
const composingEscape = (target: ReturnType<Page['locator']>) => target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });

test('machines_esc_ignores_ime_add: Esc that cancels a composition keeps the add form and its alias; a plain Esc still closes it', async ({ app }) => {
  const { sent } = await machines(app);
  await addButton(app).click();
  await alias(app).fill('스튜디오');
  await composingEscape(alias(app));
  await expect(form(app)).toBeVisible();
  await expect(alias(app)).toHaveValue('스튜디오');
  expect(sent).not.toContain('add_machine');
  await alias(app).press('Escape');
  await expect(form(app)).toHaveCount(0);
  expect(sent).not.toContain('add_machine');
});

test('machines_esc_ignores_ime_remove: Esc that cancels a composition keeps the remove confirmation; a plain Esc still closes it', async ({ app }) => {
  const row = { machine: 'macbook', host: 'macbook.local', user: 'me', port: 22, keys: [], fingerprint: null, channel: null };
  const { sent } = await machines(app, [row]);
  await app.locator('[data-machine="macbook"] .machine-row').click();
  await app.locator('[data-machine="macbook"]').getByRole('button', { name: 'Remove', exact: true }).click();
  const confirm = app.getByRole('group', { name: 'Remove macbook', exact: true });
  await expect(confirm).toBeVisible();
  await composingEscape(confirm.getByRole('button', { name: 'Cancel', exact: true }));
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).press('Escape');
  await expect(confirm).toHaveCount(0);
  expect(sent).not.toContain('remove_machine');
});
