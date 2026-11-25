// Ticket 1068: the Add form and the problem card name the login name ssh used and offer the alias whose HostName matches.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type Req = { op: string; alias?: string };
const HOST = 'Adas-MacBook-Pro.local';
const LOGIN = 'adamini';
const ALIAS = { name: 'macbook', host: HOST, user: 'ada' };
const DENIED = `${LOGIN}@${HOST.toLowerCase()}: Permission denied (publickey).`;
const row = { machine: HOST, host: HOST, user: LOGIN, port: 22, keys: [], fingerprint: null, saved: { host: HOST, user: null, port: null }, channel: { state: 'down', since_ms: 0, local_protocol: 2, error: DENIED } };

async function machines(app: Page) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const ok = (id: number, body: unknown) => ws.send(JSON.stringify({ id, response: { Ok: body } }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; request?: Req };
      if (msg.request?.op === 'machine_aliases') ok(msg.id, { type: 'machine_aliases', aliases: [ALIAS, { name: 'mini' }] });
      else if (msg.request?.op === 'machine_details') ok(msg.id, { type: 'machine_details', machines: [row] });
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click();
  await expect(app.locator('.machines-page')).toBeVisible();
}
const host = (app: Page) => app.getByRole('combobox', { name: 'Host', exact: true });

test('machine_login_add_form_offers_the_alias: typing the HostName shows the offer and pressing it picks the alias', async ({ app }) => {
  await machines(app);
  await app.getByRole('button', { name: 'Add machine', exact: true }).click();
  await host(app).fill(HOST.toLowerCase());
  await app.getByRole('button', { name: 'Use alias macbook (user ada)' }).click();
  await expect(host(app)).toHaveValue('macbook');
  await expect(app.getByRole('button', { name: /^Use alias/ })).toHaveCount(0);
});

test('machine_login_card_names_the_login: a key refusal with no saved user says who logged in; Edit focuses User', async ({ app }) => {
  await machines(app);
  await app.locator('button.machine-row').click();
  const problem = app.locator('.machine-problem');
  await expect(problem).toContainText(`It logged in as ${LOGIN}.`);
  await expect(problem.getByRole('button', { name: 'Use alias macbook (user ada)' })).toBeVisible();
  await problem.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(app.getByRole('textbox', { name: 'User', exact: true })).toBeFocused();
});
