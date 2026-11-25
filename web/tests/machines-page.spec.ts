import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, openWindow } from './fixtures';

test.use({ locale: 'en-AU' });
test.setTimeout(30_000);
const data = [
  { machine: 'macbook', host: 'macbook.local', user: 'me', port: 22, keys: ['~/.ssh/id_ed25519', '~/.ssh/id_ed25519_work'], fingerprint: 'SHA256:Zp3k9Qm1vXc0aT8bR2yLw4HdN7sUeJfGq5oKiA6xYhE (ssh-ed25519)', channel: { state: 'up', since_ms: new Date(2026, 9, 29, 9, 12).getTime(), remote_version: '0.9.4', remote_protocol: 2, local_protocol: 2 } },
  { machine: 'studio', host: 'studio', user: 'me', port: 2222, keys: ['~/.ssh/id_rsa'], fingerprint: 'SHA256:Hq8e... (ssh-rsa)', channel: { state: 'version_mismatch', since_ms: new Date(2026, 9, 29, 8, 40).getTime(), remote_version: '0.7.1', remote_protocol: 1, local_protocol: 2, error: 'version mismatch: remote protocol 1 (nunchiro 0.7.1), local protocol 2 (nunchiro 0.1.0)' } },
  { machine: 'down', host: null, user: null, port: null, keys: [], fingerprint: null, channel: { state: 'down', since_ms: 0, error: 'SSH unavailable' } },
  { machine: 'unknown', host: null, user: null, port: null, keys: [], fingerprint: null, channel: null },
];
async function fixture(app: Page) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.request?.op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines: data } } }));
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
}
async function machines(app: Page) {
  await fixture(app);
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click({ timeout: 3000 });
  await expect(app.locator('.machines-page')).toBeVisible();
}
const card = (app: Page, alias: string) => app.locator(`[data-machine="${alias}"]`);
const expand = (app: Page, alias: string) => card(app, alias).locator('.machine-row').click();

test('machines_page_shows_every_field', async ({ app }) => {
  await machines(app);
  await expand(app, 'macbook');
  for (const text of ['macbook', 'connected since 09:12', 'me@macbook.local:22', '~/.ssh/id_ed25519_work', data[0].fingerprint!, '0.9.4, protocol 2 (this Mac: 2)']) await expect(card(app, 'macbook')).toContainText(text);
});
test('keys_are_labelled_configured', async ({ app }) => { await machines(app); await expand(app, 'macbook'); await expect(card(app, 'macbook')).toContainText('Keys (configured)'); expect(await app.locator('.machines-page').innerText()).not.toMatch(/\bused\b/i); });
test('version_mismatch_shows_problem_card_without_restart', async ({ app }) => { await machines(app); await expand(app, 'studio'); await expect(card(app, 'studio').getByRole('alert')).toContainText('agents keep running'); await expect(card(app, 'studio').getByRole('button', { name: 'Connect', exact: true })).toBeVisible(); await expect(card(app, 'studio').getByRole('button', { name: /restart/i })).toHaveCount(0); });
test('machines_only_in_settings', async ({ app }) => { await machines(app); await expect(app.locator('.first-run').getByText(/machine/i)).toHaveCount(0); expect(fs.readFileSync(path.resolve(import.meta.dirname, '../src/settings/onboarding/OnboardingPage.tsx'), 'utf8')).not.toMatch(/machines|add_machine/); });
test('no_install_no_restart_control', async ({ app }) => { await machines(app); await expect(app.locator('.machines-page').getByRole('button', { name: /install|restart|setup/i })).toHaveCount(0); await expect(app.locator('.machines-page').getByRole('menuitem', { name: /install|restart|setup/i })).toHaveCount(0); });
test('unknown_is_not_blank', async ({ app }) => { await machines(app); for (const alias of ['down', 'unknown']) { await expand(app, alias); await expect(card(app, alias)).toContainText('unknown'); for (const dd of await card(app, alias).locator('dd').allTextContents()) { expect(dd.trim()).not.toBe(''); expect(dd.trim()).not.toBe('0'); expect(dd).not.toMatch(/\bused\b/); } } });
test('machines_reachable_in_2_clicks', async ({ app }) => {
  await machines(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).getByText('Settings: Machines', { exact: true }).click();
  await expect(app.locator('.machines-page')).toBeVisible();
  await expect(app.locator('#h-machines')).toBeFocused();
});
test('machines_axe_clean', async ({ app }) => { await machines(app); await expand(app, 'studio'); const r = await new AxeBuilder({ page: app }).include('.settings').analyze(); expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]); });
const hardcoded = (text: string) => { const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); return [...code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])|(?:placeholder|aria-label|title)="([^"]+)"/g)].map((m) => m[1] ?? m[2]); };
test('machines_text_from_catalogue', async ({ app }) => {
  await machines(app);
  const folder = path.resolve(import.meta.dirname, '../src/settings/machines');
  // The link field's placeholder is the share link's own format (ticket 1050), not a word to translate.
  const format = (s: string) => /^nunchiro-machine:v1\?/.test(s);
  for (const f of fs.readdirSync(folder).filter((f) => f.endsWith('.tsx'))) expect(hardcoded(fs.readFileSync(path.join(folder, f), 'utf8')).filter((s) => !format(s))).toEqual([]);
  expect(hardcoded('<p>Injected English</p>')).toEqual(['Injected English']);
  expect(hardcoded('<input aria-label="Injected English" />')).toEqual(['Injected English']);
});
// machines_match_mockup removed: it pinned the needs 122 card's pixels, which ticket 336 replaced with the row list.
test('machines_row_opens_and_closes: click, Enter and Space open the row; Esc closes it, keeps Settings open and returns focus', async ({ app }) => {
  await machines(app);
  const row = card(app, 'macbook').locator('.machine-row');
  const detail = card(app, 'macbook').getByRole('button', { name: 'Remove', exact: true });
  await expect(row).toContainText('ssh macbook · Nunchiro 0.9.4, protocol 2');
  await expect(row.locator('.pchip')).toHaveCount(1);
  await expect(detail).toHaveCount(0);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(detail).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(app.locator('.machines-page')).toBeVisible();
  for (const key of ['Enter', 'Space']) {
    await row.press(key);
    await expect(detail).toBeVisible();
    await row.press(key);
    await expect(detail).toHaveCount(0);
  }
  await row.press('Enter');
  await detail.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('remove_forgets_alias_only', async ({ app, core }) => {
  core.run(['serve', 'stop']);
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ machines: { macbook: { projects: {} } } }));
  fs.writeFileSync(path.join(core.home, 'machines.json'), JSON.stringify({ version: 1, machines: ['macbook'] }));
  const ssh = path.join(core.env.HOME!, '.ssh'); fs.mkdirSync(ssh);
  const paths = ['config', 'known_hosts', 'id_ed25519'].map((p) => path.join(ssh, p));
  for (const p of paths) fs.writeFileSync(p, `sentinel ${path.basename(p)}`);
  const before = paths.map((p) => ({ bytes: fs.readFileSync(p), mtime: fs.statSync(p).mtimeMs }));
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" >> "$NUNCHIRO_HOME/discovery.log"\nif [ "$1" = -G ]; then printf 'hostname macbook.local\\nuser me\\nport 22\\nidentityfile ~/.ssh/id_ed25519\\n'; exit; fi\nif [ "$1" = -lF ]; then printf '256 SHA256:fixture macbook.local (ED25519)\\n'; exit; fi\nprintf '{"type":"hello","protocol":2,"version":"0.9.4"}\\n{"type":"sessions","sessions":[]}\\n'\ncat >/dev/null\n`;
  for (const name of ['ssh', 'ssh-keygen']) fs.writeFileSync(path.join(core.home, 'bin', name), script, { mode: 0o700 });
  core.env.NUNCHIRO_SSH = path.join(core.home, 'bin', 'ssh');
  await core.restart();
  await app.addInitScript((boot) => { window.__NUNCHIRO__ = boot; }, core.boot());
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click({ timeout: 3000 });
  await expand(app, 'macbook');
  await expect(card(app, 'macbook')).toContainText('me@macbook.local:22');
  await card(app, 'macbook').getByRole('button', { name: 'Remove', exact: true }).click();
  const confirm = app.getByRole('group', { name: 'Remove macbook', exact: true });
  await expect(confirm).toContainText('SSH config, known_hosts and key files stay untouched');
  const log = fs.readFileSync(path.join(core.home, 'discovery.log'), 'utf8');
  await confirm.getByRole('button', { name: 'Remove machine', exact: true }).click();
  await expect(card(app, 'macbook')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).machines).toEqual({});
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'machines.json'), 'utf8')).machines).toEqual([]);
  expect(fs.readFileSync(path.join(core.home, 'discovery.log'), 'utf8')).toBe(log);
  paths.forEach((p, i) => { expect(fs.readFileSync(p)).toEqual(before[i].bytes); expect(fs.statSync(p).mtimeMs).toBe(before[i].mtime); });
  // Adding the alias uses the same owner settings operation and the existing SSH config, with no edit to it.
  await app.getByRole('button', { name: 'Add machine', exact: true }).click();
  await app.getByRole('combobox', { name: 'Host', exact: true }).fill('macbook');
  // Q6 C15: the form's buttons are the Settings pages' shared buttons, not the page's own style.
  for (const name of ['Test', 'Add', 'Cancel']) await expect(app.locator('.machine-add').getByRole('button', { name, exact: true })).toHaveClass(/(^| )btn( |$)/);
  await app.getByRole('button', { name: 'Add', exact: true }).click();
  await expand(app, 'macbook');
  await expect(card(app, 'macbook')).toContainText('me@macbook.local:22');
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).machines.macbook).toBeTruthy();
});
