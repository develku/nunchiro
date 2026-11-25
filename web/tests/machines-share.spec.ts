// Ticket 1050: Share this Mac gives a link that holds no secret; Paste link in Add machine fills the form and shows the
// host key, Test refuses a key that differs from the link, and nothing is added before the Add press.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const KEY = 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const LIVE = 'SHA256:ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkj';
const LINK = `nunchiro-machine:v1?host=studio.local&user=ada&port=2222&hostkey=${KEY}&label=studio`;
/** A reply that never comes: the request stays in flight. */
const HOLD = 'hold';
type Frame = { id: number; request?: { op: string; alias?: string; link?: string } };
/** The window's requests; machine_share and machine_trust get canned replies (the real core would read /etc/ssh and run ssh-keyscan). */
async function machines(app: Page, replies: Record<string, unknown>) {
  const sent: Frame['request'][] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      if (msg.request) sent.push(msg.request);
      const reply = msg.request && replies[msg.request.op];
      if (reply === HOLD) return;
      if (reply) ws.send(JSON.stringify({ id: msg.id, response: { Ok: reply } }));
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click();
  await expect(app.locator('.machines-page')).toBeVisible();
  return sent;
}
const form = (app: Page) => app.locator('form.machine-add');
async function pasteLink(app: Page, text: string) {
  await app.getByRole('button', { name: 'Add machine', exact: true }).click();
  await form(app).getByRole('button', { name: 'Paste link', exact: true }).click();
  await form(app).getByRole('textbox', { name: 'Share link', exact: true }).fill(text);
}

test('machines_share_link: Share this Mac shows the link and Copy, with a picker for each name', async ({ app }) => {
  const share = { type: 'machine_share', remote_login: true, shares: [{ host: 'studio.local', link: LINK }, { host: 'studio.tail1.ts.net', link: LINK.replace('studio.local', 'studio.tail1.ts.net') }] };
  await machines(app, { machine_share: share });
  await app.getByRole('button', { name: 'Share this Mac', exact: true }).click();
  const panel = app.getByRole('group', { name: 'Share this Mac', exact: true });
  await expect(panel.locator('code')).toHaveText(LINK);
  await expect(panel.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await panel.getByRole('combobox', { name: 'Name to share', exact: true }).selectOption('studio.tail1.ts.net');
  await expect(panel.locator('code')).toContainText('host=studio.tail1.ts.net&');
  await expect(panel).toContainText('it gives no access by itself');
});

test('machines_share_off: Remote Login off gives no link', async ({ app }) => {
  await machines(app, { machine_share: { type: 'machine_share', remote_login: false, shares: [] } });
  await app.getByRole('button', { name: 'Share this Mac', exact: true }).click();
  const panel = app.getByRole('group', { name: 'Share this Mac', exact: true });
  await expect(panel.getByRole('alert')).toContainText('Remote Login is off');
  await expect(panel.locator('code')).toHaveCount(0);
});

test('machines_paste_link: Paste fills host, user and port, shows the fingerprint, and adds nothing without Add', async ({ app }) => {
  const sent = await machines(app, {});
  await pasteLink(app, LINK);
  await expect(form(app).getByRole('combobox', { name: 'Host', exact: true })).toHaveValue('studio.local');
  await expect(form(app).getByRole('textbox', { name: 'User', exact: true })).toHaveValue('ada');
  await expect(form(app).getByRole('textbox', { name: 'Port', exact: true })).toHaveValue('2222');
  await expect(form(app)).toContainText(KEY);
  expect(sent.map((r) => r?.op)).not.toContain('add_machine');
});

test('machines_paste_mismatch: a live key that differs from the link is refused with both fingerprints', async ({ app }) => {
  const sent = await machines(app, { machine_trust: { type: 'machine_trust', live: LIVE, trusted: false, error: null } });
  await pasteLink(app, LINK);
  await form(app).getByRole('button', { name: 'Test', exact: true }).click();
  const alert = form(app).getByRole('alert');
  await expect(alert).toContainText('Not trusted');
  await expect(alert).toContainText(KEY);
  await expect(alert).toContainText(LIVE);
  expect(sent.find((r) => r?.op === 'machine_trust')).toEqual({ op: 'machine_trust', alias: 'studio', link: LINK });
  expect(sent.map((r) => r?.op)).not.toContain('add_machine');
});

test('machines_paste_test_holds_add: Add stays disabled while the Test of a pasted link runs', async ({ app }) => {
  const sent = await machines(app, { machine_trust: HOLD });
  await pasteLink(app, LINK);
  const add = form(app).getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeEnabled();
  await form(app).getByRole('button', { name: 'Test', exact: true }).click();
  await expect(add).toBeDisabled();
  await form(app).getByRole('combobox', { name: 'Host', exact: true }).press('Enter');
  expect(sent.map((r) => r?.op)).not.toContain('add_machine');
});

test('machines_paste_then_choose: choosing a host suggestion drops the pasted link and its refusal', async ({ app }) => {
  const sent = await machines(app, {
    machine_aliases: { type: 'machine_aliases', aliases: [{ name: 'studio.local-work' }] },
    machine_trust: { type: 'machine_trust', live: LIVE, trusted: false, error: null },
    machine_probe: { type: 'machine_probe', error: null },
  });
  await app.getByRole('button', { name: 'Add machine', exact: true }).click();
  const host = form(app).getByRole('combobox', { name: 'Host', exact: true });
  // The focused Host field opens its suggestions over the buttons below; close them before Paste link.
  await expect(form(app).getByRole('listbox')).toBeVisible();
  await host.press('Escape');
  await form(app).getByRole('button', { name: 'Paste link', exact: true }).click();
  await form(app).getByRole('textbox', { name: 'Share link', exact: true }).fill(LINK);
  await form(app).getByRole('button', { name: 'Test', exact: true }).click();
  await expect(form(app).getByRole('alert')).toContainText('Not trusted');
  await host.focus();
  await host.press('ArrowDown');
  await host.press('Enter');
  await expect(host).toHaveValue('studio.local-work');
  await expect(form(app).getByRole('alert')).toHaveCount(0);
  await expect(form(app)).not.toContainText(KEY);
  await form(app).getByRole('button', { name: 'Test', exact: true }).click();
  await expect(form(app).getByRole('status')).toContainText('reachable');
  expect(sent.filter((r) => r?.op === 'machine_trust')).toHaveLength(1);
});

test('machines_paste_malformed: a malformed link shows a plain error and fills nothing', async ({ app }) => {
  await machines(app, {});
  await pasteLink(app, LINK.replace('host=studio.local', 'host=-oProxyCommand=x'));
  await expect(form(app).getByRole('alert')).toHaveText('This is not a valid Nunchiro machine link. Copy it again from Share this Mac on the other Mac.');
  await expect(form(app).getByRole('combobox', { name: 'Host', exact: true })).toHaveValue('');
});
