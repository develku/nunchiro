import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, openWindow } from './fixtures';

// V2.5-23 (ticket 144): state words, Diagnostics inside the opened row (ticket 336), latency.
test.use({ locale: 'en-AU', viewport: { width: 900, height: 1500 } });
test.setTimeout(60_000);
const at = (h: number, m: number) => new Date(2026, 9, 31, h, m).getTime();
const data = [
  { machine: 'macbook', host: 'macbook.local', user: 'me', port: 22, keys: ['~/.ssh/id_ed25519'], fingerprint: 'SHA256:Zp3k9Qm1… (ssh-ed25519)', channel: { state: 'up', since_ms: at(9, 12), remote_version: '0.9.4', remote_protocol: 2, local_protocol: 2, latency_ms: 42 } },
  { machine: 'studio', host: 'studio', user: 'me', port: 2222, keys: ['~/.ssh/id_rsa'], fingerprint: 'SHA256:Hq8e… (ssh-rsa)', channel: { state: 'down', since_ms: at(8, 40), remote_version: '0.9.4', remote_protocol: 2, local_protocol: 2, error: 'ssh: connect to host studio port 2222: Connection refused' } },
  { machine: 'fresh', host: 'fresh', user: 'me', port: 22, keys: [], fingerprint: null, channel: { state: 'connecting', since_ms: at(9, 10), local_protocol: 2 } },
  { machine: 'flaky', host: 'flaky', user: 'me', port: 22, keys: [], fingerprint: null, channel: { state: 'reconnecting', since_ms: at(9, 40), remote_version: '0.9.4', remote_protocol: 2, local_protocol: 2, error: 'ssh: Broken pipe' } },
  { machine: 'old', host: 'old', user: 'me', port: 22, keys: [], fingerprint: null, channel: { state: 'version_mismatch', since_ms: at(8, 40), remote_version: '0.7.1', remote_protocol: 1, local_protocol: 2, error: 'version mismatch' } },
];
async function open(app: Page) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      const op = msg.request?.op;
      if (op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines: data } } }));
      else if (op === 'machine_status') {
        const m = data.find((d) => d.machine === msg.request.label)!;
        ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machines', machines: [{ machine: m.machine, status: 'unreachable', channel: m.channel }] } } }));
      } else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click({ timeout: 3000 });
  await expect(app.locator('.machines-page')).toBeVisible();
}
const card = (app: Page, alias: string) => app.locator(`[data-machine="${alias}"]`);
const expand = (app: Page, alias: string) => card(app, alias).locator('.machine-row').click();

test('states_words', async ({ app }) => {
  await app.emulateMedia({ colorScheme: 'light' });
  await open(app);
  const words: Record<string, string> = { macbook: 'connected since 09:12', studio: 'unreachable since 08:40', fresh: 'connecting…', flaky: 'reconnecting since 09:40', old: 'protocol versions: remote 1, this Mac 2' };
  for (const [alias, text] of Object.entries(words)) await expect(card(app, alias).locator('.machine-row .pchip')).toHaveText(text);
  await expect(app.locator('.settings header.phd .ssum')).toHaveText('Machines 5 · Connected 1 · Unreachable 2');
  // Reconnecting is amber (--warn) and is not the connecting blue.
  const tone = (alias: string) => card(app, alias).locator('.machine-row .pchip').evaluate((e) => getComputedStyle(e).borderColor);
  await expect(card(app, 'flaky').locator('.machine-row .pchip')).toHaveClass(/warn/);
  expect(await tone('flaky')).not.toBe(await tone('fresh'));
  // v25f: Connect on every state that is not connected; a connected machine offers Reconnect. Test on every machine.
  for (const m of data) await expand(app, m.machine);
  for (const alias of ['studio', 'fresh', 'flaky', 'old']) await expect(card(app, alias).getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(card(app, 'macbook').getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
  await expect(card(app, 'macbook').getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
  for (const m of data) await expect(card(app, m.machine).getByRole('button', { name: 'Test', exact: true })).toBeVisible();
});

test('diagnostics_one_click', async ({ app }) => {
  await open(app);
  await expand(app, 'studio');
  await expect(card(app, 'studio').getByRole('group', { name: 'Diagnostics' })).toHaveCount(0);
  await card(app, 'studio').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const diag = card(app, 'studio').getByRole('group', { name: 'Diagnostics' });
  await expect(diag).toBeVisible();
  await expect(diag).toContainText('SSH connection failed');
  await expect(diag).toContainText('ssh: connect to host studio port 2222: Connection refused');
  await expect(diag).toContainText('run ssh studio once in Terminal');
  await expect(card(app, 'studio').getByRole('button', { name: /Diagnostics/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(card(app, 'studio').getByRole('button', { name: 'Machine status' })).toHaveCount(0);
});

test('latency_shown', async ({ app }) => {
  await open(app);
  await expand(app, 'macbook');
  await expand(app, 'studio');
  await card(app, 'macbook').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(card(app, 'macbook').getByRole('group', { name: 'Diagnostics' })).toContainText('42 ms');
  await card(app, 'studio').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(card(app, 'studio').getByRole('group', { name: 'Diagnostics' })).toContainText('unknown');
});

test('hops_after_failure_not_checked', async ({ app }) => {
  await open(app);
  for (const alias of ['studio', 'flaky']) {
    await expand(app, alias);
    await card(app, alias).getByRole('button', { name: 'Diagnostics', exact: true }).click();
    const hops = card(app, alias).locator('.machine-hops li');
    await expect(hops.nth(1)).toContainText('SSH connection failed');
    for (const i of [2, 3]) { await expect(hops.nth(i)).toBeVisible(); await expect(hops.nth(i)).toHaveCSS('position', 'static'); await expect(hops.nth(i)).toContainText('not checked'); await expect(hops.nth(i).locator('.machine-mark')).toHaveText('–'); }
  }
});

test('last_seen_version', async ({ app }) => {
  await open(app);
  await expect(card(app, 'studio')).toContainText('last seen 0.9.4');
  await expand(app, 'macbook');
  await expect(card(app, 'macbook')).toContainText('0.9.4, protocol 2 (this Mac: 2)');
  await expect(card(app, 'macbook')).not.toContainText('last seen');
});

test('error_once_in_diagnostics', async ({ app }) => {
  await open(app);
  const err = 'ssh: connect to host studio port 2222: Connection refused';
  await expand(app, 'studio');
  await expect(card(app, 'studio').getByRole('alert')).toContainText(err);
  await card(app, 'studio').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(card(app, 'studio').getByRole('alert')).toHaveCount(0);
  expect((await card(app, 'studio').innerText()).split(err).length - 1).toBe(1);
});

test('diagnostics_no_stale_current', async ({ app }) => {
  // A card that dropped keeps its old latency in the fixture; the page must not show it as current.
  data[3].channel = { ...data[3].channel, latency_ms: 42 } as typeof data[3]['channel'];
  await app.addInitScript(() => { (window as unknown as { __copied: string[] }).__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x: string) => { (window as unknown as { __copied: string[] }).__copied.push(x); } } }); });
  await open(app);
  await expand(app, 'flaky');
  await card(app, 'flaky').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const diag = card(app, 'flaky').getByRole('group', { name: 'Diagnostics' });
  await expect(diag.locator('dt', { hasText: 'Latency' }).locator('+ dd')).toHaveText('unknown');
  await expect(diag.locator('dt', { hasText: 'Remote' }).locator('+ dd')).toHaveText('last seen 0.9.4');
  await diag.getByRole('button', { name: 'Copy', exact: true }).click();
  const text = await app.evaluate(() => (window as unknown as { __copied: string[] }).__copied[0]);
  expect(text).toContain('Latency: unknown');
  expect(text).toContain('Remote: last seen 0.9.4');
  expect(text).not.toContain('42');
  data[3].channel = { ...data[3].channel, latency_ms: undefined } as typeof data[3]['channel'];
});

test('copy_feedback', async ({ app }) => {
  await app.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { if ((window as unknown as { __fail?: boolean }).__fail) throw new Error('denied'); } } }); });
  await open(app);
  await expand(app, 'studio');
  await card(app, 'studio').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const copy = card(app, 'studio').getByRole('button', { name: /^Cop/ });
  await copy.click();
  await expect(copy).toHaveText('Copied');
  await expect(copy).toHaveText('Copy', { timeout: 6000 });
  await app.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = true; });
  await copy.click();
  await expect(card(app, 'studio').getByRole('status')).toHaveText('Copy failed');
});

test('diagnostics_a11y', async ({ app }) => {
  await open(app);
  await expand(app, 'studio');
  const button = card(app, 'studio').getByRole('button', { name: 'Diagnostics', exact: true });
  await expect(button).not.toHaveAttribute('aria-controls', /.+/);
  await button.click();
  await expect(button).toHaveAccessibleName('Diagnostics');
  const id = await button.getAttribute('aria-controls');
  expect(id).toBeTruthy();
  await expect(app.locator(`#${id}`)).toHaveCount(1);
  await button.click();
  await expect(button).not.toHaveAttribute('aria-controls', /.+/);
});

// machines_matches_draft removed: it only wrote draft | app shots of the card that ticket 336 replaced, and asserted nothing about the page.

test('row_latency: the last latency sits beside the state chip only while the machine is up', async ({ app }) => {
  data[3].channel = { ...data[3].channel, latency_ms: 42 } as typeof data[3]['channel'];
  await open(app);
  await expect(card(app, 'macbook').locator('.machine-row .machine-lat')).toHaveText('42 ms');
  for (const alias of ['studio', 'fresh', 'flaky', 'old']) await expect(card(app, alias).locator('.machine-lat')).toHaveCount(0);
  data[3].channel = { ...data[3].channel, latency_ms: undefined } as typeof data[3]['channel'];
});

test('fix_command: a version mismatch and a remote without Nunchiro show the command from docs/remote.md with its own Copy', async ({ app }) => {
  const command = 'cargo install --locked --path crates/nunchiro --root "$HOME/.local"';
  expect(fs.readFileSync(path.resolve(import.meta.dirname, '../../docs/remote.md'), 'utf8')).toContain(`\n${command}\n`);
  const was = data[1].channel;
  data[1].channel = { ...was, error: 'machine studio: SSH exit status: 127: zsh:1: command not found: nunchiro' } as typeof data[1]['channel'];
  await app.addInitScript(() => { (window as unknown as { __copied: string[] }).__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x: string) => { (window as unknown as { __copied: string[] }).__copied.push(x); } } }); });
  await open(app);
  for (const alias of ['old', 'studio', 'flaky']) await expand(app, alias);
  const fix = card(app, 'old').locator('.machine-fix');
  await expect(fix).toContainText('To update, run this on old, in a Nunchiro source folder at the same version as this Mac:');
  await expect(fix.locator('code')).toHaveText(command);
  await fix.getByRole('button', { name: 'Copy command', exact: true }).click();
  await expect(fix.getByRole('button')).toHaveText('Copied');
  expect(await app.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([command]);
  await expect(card(app, 'studio').locator('.machine-fix')).toContainText('Nunchiro is not installed on studio.');
  await expect(card(app, 'studio').locator('.machine-fix code')).toHaveText(command);
  // A dropped link is not a missing or old Nunchiro.
  await expect(card(app, 'flaky').locator('.machine-fix')).toHaveCount(0);
  data[1].channel = was as typeof data[1]['channel'];
});
