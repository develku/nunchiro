// v25f (owner F8, decision A): the guided Add machine form. Host suggestions from a mocked `machine_aliases`, Test from a
// mocked `machine_probe`, one-click Add with a toast, and Connect/Test on each card. The real core answers everything else.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type Req = { op: string; host?: string; user?: string; port?: number; alias?: string; label?: string; retry?: boolean; replace?: boolean; session?: unknown };
const ALIASES = ['macbook', 'macbook-lan', 'mini', 'studio'];
const row = (machine: string, state = 'down') => ({ machine, host: machine, user: null, port: null, keys: [], fingerprint: null, channel: { state, since_ms: 0, local_protocol: 2, error: state === 'down' ? 'ssh: connect to host studio port 22: Connection refused' : undefined } });

async function machines(app: Page, rows: unknown[] = []) {
  const sent: Req[] = [];
  const added: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const ok = (id: number, body: unknown) => ws.send(JSON.stringify({ id, response: { Ok: body } }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; request?: Req };
      const r = msg.request;
      if (r) sent.push(r);
      if (r?.op === 'machine_aliases') ok(msg.id, { type: 'machine_aliases', aliases: ALIASES.map((name) => ({ name })) });
      else if (r?.op === 'machine_probe') ok(msg.id, { type: 'machine_probe', error: r.host === 'studio' ? 'ssh: connect to host studio port 22: Connection refused' : null });
      else if (r?.op === 'add_machine') { added.push(r.alias!); ok(msg.id, { type: 'ack' }); }
      else if (r?.op === 'machine_details') ok(msg.id, { type: 'machine_details', machines: r.alias ? [row(r.alias, 'up')] : rows });
      else if (r?.op === 'start') ok(msg.id, { type: 'ack' }); // Open terminal: the real core would run ssh
      else if (r?.op === 'machine_status' && !r.label) ok(msg.id, { type: 'machines', machines: ['studio', 'mini'].map((m) => ({ machine: m, status: 'x', channel: row(m, m === 'studio' ? 'down' : 'up').channel })) });
      else if (r?.op === 'machine_status') ok(msg.id, { type: 'machines', machines: [{ machine: r.label, status: 'x', channel: row(r.label!, r.label === 'studio' ? 'down' : 'up').channel }] });
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click();
  await expect(app.locator('.machines-page')).toBeVisible();
  return { sent, added };
}
const host = (app: Page) => app.getByRole('combobox', { name: 'Host', exact: true });
const options = (app: Page) => app.getByRole('listbox', { name: 'SSH aliases' }).getByRole('option');
const form = (app: Page) => app.locator('form.machine-add');

test('machines_guided_filter_pick: typing filters the aliases; a click or Enter picks one', async ({ app }) => {
  await machines(app);
  await app.getByRole('button', { name: 'Add machine', exact: true }).click();
  await expect(host(app)).toBeFocused();
  await expect(options(app)).toHaveText(ALIASES);
  await host(app).fill('mac');
  await expect(options(app)).toHaveText(['macbook', 'macbook-lan']);
  await options(app).filter({ hasText: 'macbook-lan' }).click();
  await expect(host(app)).toHaveValue('macbook-lan');
  await expect(app.getByRole('listbox')).toHaveCount(0);
  // Keyboard: Down twice, Enter picks the second match and the form stays.
  await host(app).fill('');
  await host(app).pressSequentially('i');
  await expect(options(app)).toHaveText(['mini', 'studio']);
  await host(app).press('ArrowDown');
  await host(app).press('ArrowDown');
  await expect(options(app).nth(1)).toHaveAttribute('aria-selected', 'true');
  await host(app).press('Enter');
  await expect(host(app)).toHaveValue('studio');
  await expect(form(app)).toBeVisible();
  // A free host that is no alias is still allowed.
  await host(app).fill('build.example.com');
  await expect(app.getByRole('listbox')).toHaveCount(0);
  await expect(form(app).getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
});

test('machines_guided_test_add_toast: Test shows reachable or the ssh error; one click adds, closes the form and toasts', async ({ app }) => {
  const { sent, added } = await machines(app);
  await app.getByRole('button', { name: 'Add machine', exact: true }).click();
  await host(app).fill('studio');
  await form(app).getByRole('button', { name: 'Test', exact: true }).click();
  // Ticket 991 C6: ssh's words become one plain sentence with what to do; the raw text stays under Details.
  await expect(form(app).getByRole('status')).toHaveText('⚠ The machine refused the SSH connection. Turn on Remote Login (SSH) on it, and check the port.Detailsssh: connect to host studio port 22: Connection refused');
  // A failed Test only warns.
  await expect(form(app).getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  await host(app).fill('mini');
  await expect(form(app).getByRole('status')).toHaveCount(0);
  await form(app).getByRole('button', { name: 'User and port (optional)' }).click();
  await form(app).getByRole('textbox', { name: 'User', exact: true }).fill('me');
  await form(app).getByRole('textbox', { name: 'Port', exact: true }).fill('2222');
  await form(app).getByRole('button', { name: 'Test', exact: true }).click();
  await expect(form(app).getByRole('status')).toHaveText('✓ reachable');
  expect(sent.filter((r) => r.op === 'machine_probe').at(-1)).toEqual({ op: 'machine_probe', host: 'mini', user: 'me', port: 2222 });
  expect(added).toEqual([]);
  await form(app).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form(app)).toHaveCount(0);
  await expect(app.locator('.toast')).toContainText('Added mini');
  await expect(app.locator('[data-machine="mini"]')).toBeVisible();
  expect(sent.find((r) => r.op === 'add_machine')).toEqual({ op: 'add_machine', alias: 'mini', host: 'mini', user: 'me', port: 2222 });
  await expect.poll(() => sent.some((r) => r.op === 'machine_status' && r.label === 'mini')).toBe(true);
});

test('machines_guided_card_connect_test: every card has Connect (Reconnect when up) and Test with the result on the card', async ({ app }) => {
  const { sent } = await machines(app, [row('studio'), row('mini', 'up')]);
  const studio = app.locator('[data-machine="studio"]');
  const mini = app.locator('[data-machine="mini"]');
  await studio.locator('.machine-row').click();
  await mini.locator('.machine-row').click();
  await expect(mini.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
  await studio.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => sent.some((r) => r.op === 'machine_status' && r.label === 'studio' && r.retry === true)).toBe(true);
  await studio.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(studio.getByRole('status')).toHaveText('⚠ not reachable');
  // The error itself shows once, in the card's problem line.
  await expect(studio.getByText('ssh: connect to host studio port 22: Connection refused')).toHaveCount(1);
  await mini.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(mini.getByRole('status')).toHaveText('✓ reachable');
  await expect(studio.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
});

const SAVED = { ...row('studio'), saved: { host: 'studio.lan', user: 'me', port: 2222 } };
test('machines_edit: Edit reopens the form with what was saved and saves over the same machine; unchanged values send nothing', async ({ app }) => {
  const { sent } = await machines(app, [SAVED]);
  const studio = app.locator('[data-machine="studio"]');
  await studio.locator('.machine-row').click();
  await expect(studio.locator('.machine-row')).toContainText('ssh studio · studio.lan'); // C5: the saved host, not only the alias
  await studio.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(form(app).locator('label')).toContainText('Edit studio');
  await expect(host(app)).toHaveValue('studio.lan');
  await expect(form(app).getByRole('textbox', { name: 'User', exact: true })).toHaveValue('me');
  await expect(form(app).getByRole('textbox', { name: 'Port', exact: true })).toHaveValue('2222');
  await form(app).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form(app)).toHaveCount(0);
  expect(sent.some((r) => r.op === 'add_machine')).toBe(false);
  await studio.getByRole('button', { name: 'Edit', exact: true }).click();
  await form(app).getByRole('textbox', { name: 'Port', exact: true }).fill('22');
  await form(app).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form(app)).toHaveCount(0);
  await expect(app.locator('.toast')).toContainText('Saved studio (studio.lan)'); // C5: the host it now reaches
  expect(sent.find((r) => r.op === 'add_machine')).toEqual({ op: 'add_machine', alias: 'studio', host: 'studio.lan', user: 'me', port: 22, replace: true });
  // It was not up, so the new values are tried at once; the row stays one row.
  await expect.poll(() => sent.some((r) => r.op === 'machine_status' && r.label === 'studio' && r.retry === true)).toBe(true);
  await expect(app.locator('[data-machine]')).toHaveCount(1);
});

test('machines_open_terminal: Open terminal starts a local shell tab running ssh with the saved overrides as separate arguments', async ({ app }) => {
  const { sent } = await machines(app, [SAVED]);
  const studio = app.locator('[data-machine="studio"]');
  await studio.locator('.machine-row').click();
  await studio.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(app.locator('.toast')).toContainText('Opened a terminal tab: ssh studio');
  expect(sent.find((r) => r.op === 'start')).toEqual({ op: 'start', session: { kind: 'shell', project: '', label: 'ssh studio', args: ['ssh', '-o', 'HostName=studio.lan', '-o', 'User=me', '-o', 'Port=2222', '--', 'studio'], resume: null } });
});

test('machines_retry_on_wake: coming back to the window retries every machine that is not up, at most once per 10 s', async ({ app }) => {
  const { sent } = await machines(app);
  const retries = () => sent.filter((r) => r.op === 'machine_status' && r.retry).map((r) => r.label);
  expect(retries()).toEqual([]);
  await app.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(retries).toEqual(['studio']);
  await app.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await app.waitForTimeout(400);
  expect(retries()).toEqual(['studio']);
  expect(sent.filter((r) => r.op === 'machine_status' && !r.label)).toHaveLength(1);
});
