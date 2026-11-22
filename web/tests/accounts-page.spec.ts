// V2-2a Settings > Accounts against a real core with fake `claude` and `codex` status and login commands: both tables,
// "Your own" first with no Remove, Hangul names through IME composition (Chromium over CDP; WebKit has no IME driver,
// so it covers the keyCode 229 guard and a committed name), no layout jump when a row's state changes, axe clean.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { more, openAdd, openRow, recordStatusRuns } from './accounts-rows';
import { closeSettings, openSettings } from './settings-modal';

// D is the folder the agent was pointed at (the override, else the core's own variable, as the fixture sets both).
const fake = (name: string, variable: string, status: string, login: string) => `#!/bin/sh
D="\${${variable}}"
case "$1" in --version) echo "${name} 1.0.0"; exit 0;; esac
if [ "$1 $2" = "${status}" ]; then
  # Only a "Your own" probe carries HOME (an added account's gets PATH and its folder only).
  [ -n "$HOME" ] && echo ${name} >> "$HOME/own-probes.log"
  if [ -e "$D/.logged-in" ]; then ${name === 'claude' ? `echo '{"loggedIn": true}'` : `echo 'Logged in using ChatGPT' >&2`}; exit 0; fi
  ${name === 'claude' ? `echo '{"loggedIn": false}'` : `echo 'Not logged in' >&2`}; exit 1
fi
if [ "$*" = "${login}" ]; then printf 'login for %s\\r\\n' "$D"; exec sleep 600; fi
exec /bin/cat
`;
function fakes(core: Core) {
  for (const [name, variable, status, login] of [
    ['claude', 'CLAUDE_CONFIG_DIR', 'auth status', 'auth login'],
    ['codex', 'CODEX_HOME', 'login status', 'login'],
  ])
    fs.writeFileSync(path.join(core.home, 'bin', name), fake(name, variable, status, login), { mode: 0o700 });
}
async function openAccounts(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.getByRole('heading', { level: 2, name: /Providers/ })).toBeVisible();
}
const rows = (app: Page, agent: string) => app.locator('#s-accounts').locator(`.acct-card[data-agent-name="${agent}"]`); // needs 192 (ticket 250 r4): one Accounts table, each row tagged with its agent
const registry = (core: Core) => fs.readFileSync(path.join(core.home, 'accounts.toml'), 'utf8');

test('accounts_page: both agent tables render, "the Default account" first and default, with no Remove', async ({ app, core }) => {
  fakes(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
  for (const agent of ['Claude', 'Codex']) {
    await openRow(app, agent);
    await expect(rows(app, agent)).toHaveCount(1);
    const own = rows(app, agent).first();
    await expect(own).toContainText('Default');
    // Accounts probe 11-10: "Your own" is checked as the page opens; the fakes' own logins are signed out.
    await expect(own).toContainText('Signed out');
    await expect(own).not.toContainText('Always kept'); // v25-fix-settings: the missing Remove says it (designer panel Lane C)
    // Round 2: the exact set, in order. Signed out with no other account signed in, the card carries Check and Sign in.
    await expect(own.getByRole('button')).toHaveText(['', 'View usage →', 'Check', 'Sign in']); // the first is the rename pencil
    await expect(own.getByText(/remove/i)).toHaveCount(0);
  }
  // The one-line note on a clean start, plain text (V1B-39). Ticket 391 follow-up G: the open card is Codex's, whose note names
  // its own folder (it showed Claude's text) and the page by its name, Skills & hooks.
  await openAdd(app, 'codex');
  await expect(app.getByRole('textbox', { name: 'Name' })).toHaveAttribute('title', /A new account starts empty. The config, AGENTS.md and skills from ~\/.codex are not loaded. Add what you need in Skills & hooks./);
  await expect(app.getByRole('link', { name: /Agent extensions/ })).toHaveCount(0);
});

test('accounts_page: a Hangul name composes, Enter while composing does not submit, then adds and opens the login tab', async ({ app, core, browserName }) => {
  fakes(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  await openAdd(app, 'claude');
  const name = app.getByRole('textbox', { name: 'Name' });
  await name.fill(''); // ticket 450: the field opens with a suggested name
  await name.click();
  if (browserName === 'chromium') {
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.insertText', { text: '회' });
    for (const s of ['ㅅ', '사']) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: 1, selectionEnd: 1 });
    // Enter while the IME still composes "사": the IME's key, the form stays open and nothing is stored.
    await app.keyboard.press('Enter');
    await app.waitForTimeout(300);
    await expect(app.getByRole('group', { name: 'Add Claude account' })).toBeVisible();
    expect(fs.existsSync(path.join(core.home, 'accounts.toml'))).toBe(false);
    await cdp.send('Input.insertText', { text: '사' });
    await expect(name).toHaveValue('회사');
  } else {
    // WebKit: a keydown the IME owns arrives as keyCode 229 (Safari marks composition this way); it never submits.
    await name.fill('회사');
    await name.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })));
    await app.waitForTimeout(300);
    await expect(app.getByRole('group', { name: 'Add Claude account' })).toBeVisible();
    expect(fs.existsSync(path.join(core.home, 'accounts.toml'))).toBe(false);
  }
  // Ticket 178 finding 20: Enter now starts the browser sign-in (accounts-signin.spec.ts); the terminal login is this button.
  await app.getByRole('button', { name: 'Sign in using a terminal instead' }).click();
  await expect(name).toHaveCount(0); // ticket 450: the form closes once the login starts
  await expect(rows(app, 'Claude')).toHaveCount(2);
  await expect(rows(app, 'Claude').nth(1)).toContainText('회사');
  expect(registry(core)).toContain('label = "회사"');
  await expect(app.getByRole('status').filter({ hasText: 'Login for “회사” opened in the tab “Login: 회사”.' })).toBeVisible();
  // The login runs in a visible terminal tab with only the account folder.
  const tab = app.locator('.tab').filter({ hasText: 'Login: 회사' });
  await expect(tab).toBeVisible();
  const session = core.cli('snapshot', '--json').sessions.find((s: { label: string }) => s.label === 'Login: 회사');
  const id = registry(core).match(/id = "([0-9a-f-]+)"/)![1];
  await expect.poll(() => core.read(session.id)).toContain(`login for ${path.join(fs.realpathSync(core.home), 'accounts/claude', id)}`);
  // An invalid name offers no submit.
  await openRow(app, 'Codex');
  await openAdd(app, 'codex');
  await expect(app.getByRole('textbox', { name: 'Name' })).toHaveValue('Account 2'); // ticket 450: filled in, so Enter alone signs in
  await expect(app.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await app.getByRole('textbox', { name: 'Name' }).fill('   ');
  await expect(app.getByRole('button', { name: 'Sign in with browser' })).toBeDisabled();
  await expect(app.getByRole('button', { name: 'Sign in using a terminal instead' })).toBeDisabled();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(app.locator('#s-accounts .acct-agent[data-agent="codex"]').getByRole('button', { name: 'Add account', exact: true })).toBeFocused();
});

test('accounts_page: a row whose signed-in state changes moves no element; axe 0 serious or critical', async ({ app, core }) => {
  fakes(core);
  core.shell(core.project('demo'), 'alpha');
  // An account before the window opens, signed out.
  const add = JSON.parse(execFileSync(process.execPath, ['-e', ADD, core.home, 'codex', 'team'], { encoding: 'utf8', timeout: 20_000 }));
  expect(add.Ok.type).toBe('account_added');
  const folder: string = add.Ok.account.folder;
  const whenFails = recordStatusRuns(core);
  // Round 2: the version line gains "New version …" once the core's background version read is done; under load that
  // landed after the measure below and moved the rows. The update state's reply says when it is done.
  const updateIds = new Set<number>();
  let versionsRead = false;
  app.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const frame = typeof f.payload === 'string' ? JSON.parse(f.payload) : null;
      if (frame?.request?.op === 'agent_update_state') updateIds.add(frame.id);
    });
    ws.on('framereceived', (f) => {
      const frame = typeof f.payload === 'string' ? JSON.parse(f.payload) : null;
      if (updateIds.has(frame?.id) && JSON.stringify(frame).includes('"checked":true')) versionsRead = true;
    });
  });
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Codex');
  const team = rows(app, 'Codex').nth(1);
  await whenFails(() => expect(team).toContainText('Signed out'));
  // The opening checks of "Your own" answered before the boxes are measured and the logins change below: a head's Check
  // leaves when its answer lands (round 2: under load Claude's could land after the measure).
  await expect(rows(app, 'Codex').first()).toContainText('Signed out');
  for (const agent of ['claude', 'codex']) await expect(app.locator(`#s-accounts [data-row="${agent}"] .prv-chips`)).not.toHaveText('Checking…');
  await expect.poll(() => versionsRead, { timeout: 30_000 }).toBe(true);
  await app.waitForTimeout(300);
  const boxes = () =>
    app.locator('#s-accounts').evaluate((s) => [...s.querySelectorAll('.prv-row .prv-name, .prv-row .prv-ver, .prv-row .prv-meta')].map((e) => { const r = e.getBoundingClientRect(); return `${r.x},${r.y}`; }));
  await expect(app.locator('#s-accounts .prv-row .prv-ver').first()).not.toBeEmpty();
  const before = await boxes();
  fs.writeFileSync(path.join(folder, '.logged-in'), '');
  fs.mkdirSync(path.join(core.home, 'codex-home'), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'codex-home', '.logged-in'), '');
  // A window focus refreshes the list (the timer does too, every 60 s).
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(team).toContainText('Signed in');
  // "Your own" was checked as the page opened; within the minute it changes only on the owner's Check.
  await expect(rows(app, 'Codex').first()).toContainText('Signed out');
  await app.locator('#s-accounts .acct-agent[data-agent="codex"]').getByRole('button', { name: /Check/ }).click();
  await expect(rows(app, 'Codex').first()).toContainText('Signed in');
  expect(await boxes()).toEqual(before);
  const r = await new AxeBuilder({ page: app }).include('#s-accounts').analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

// The owner socket's account_add, as a script outside the window (the CLI has no add command).
const ADD = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, agent, label] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'account_add', agent, label } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;

// Accounts probe 11-10: "Your own" is probed once as the page opens, then not again on focus or a reload within the
// minute; each press of the owner's Check probes.
test('own_account_is_probed_once_on_open_not_on_focus_or_reload', async ({ app, core }) => {
  fakes(core);
  core.shell(core.project('demo'), 'alpha');
  const log = path.join(core.home, 'sentinel-home', 'own-probes.log');
  const probes = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  // An added account is probed on every list; "Your own" by the page opening, once.
  const add = JSON.parse(execFileSync(process.execPath, ['-e', ADD, core.home, 'claude', 'work'], { encoding: 'utf8', timeout: 20_000 }));
  expect(add.Ok.type).toBe('account_added');
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  await expect(rows(app, 'Claude')).toHaveCount(2);
  await expect(rows(app, 'Claude').nth(1)).toContainText(/Signed (in|out)/);
  await expect.poll(() => probes().sort()).toEqual(['claude', 'codex']);
  await openRow(app, 'Codex');
  for (let i = 0; i < 3; i++) await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // v25f: a reload keeps the Settings modal and its page.
  await openRow(app, 'Claude');
  await expect(rows(app, 'Claude').nth(1)).toContainText(/Signed (in|out)/);
  await openRow(app, 'Codex');
  await expect(rows(app, 'Codex').first()).toContainText('Signed out');
  await app.waitForTimeout(500);
  expect(probes().sort()).toEqual(['claude', 'codex']);
  // Each press of the owner's Check probes, within the minute too.
  const button = app.getByRole('button', { name: 'Check Codex sign-in for Default' });
  await button.click();
  await expect.poll(() => probes().filter((p) => p === 'codex').length).toBe(2);
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => probes().filter((p) => p === 'codex').length).toBe(3);
  await expect(rows(app, 'Codex').first()).toContainText('Signed out');
});

// V2-2a follow-up: the core's `shown()` also refuses U+16FE4 and U+1D159 (neither is a default-ignorable code point), so the button offers only what the core accepts.
test('valid_name_refuses_core_codepoints: the Name field enables Add only for names the core accepts', async ({ app, core }) => {
  fakes(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  await openAdd(app, 'claude');
  const name = app.getByRole('textbox', { name: 'Name' });
  const add = app.getByRole('button', { name: 'Sign in with browser' });
  for (const [value, ok] of [
    ['work', true],
    ['a\u{16FE4}b', false],
    ['a\u{1D159}b', false],
    ['가'.repeat(64), true],
    ['가'.repeat(65), false],
  ] as const) {
    await name.fill(value);
    if (ok) await expect(add).toBeEnabled();
    else await expect(add).toBeDisabled();
  }
});

const ACCOUNT = '0123456789abcdef0123456789abcdef';
function registered(core: Core, signedIn: boolean) {
  const folder = path.join(core.home, 'accounts/claude', ACCOUNT);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (signedIn) fs.writeFileSync(path.join(folder, '.logged-in'), '');
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ACCOUNT}"\nlabel = "회사"\n`);
  return folder;
}

// Ticket 358 `358-menu-login-or-logout`, owner decision 11-09: by state, never both (c-358.html:487 draws both).
test('accounts_page: the ⋯ menu shows Sign out or Sign in by state, never both', async ({ app, core }) => {
  fakes(core);
  const folder = registered(core, true);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
  await openRow(app, 'Claude');
  const card = app.locator(`#s-accounts .acct-card[data-account="${ACCOUNT}"]`);
  await expect(card.locator('.acct-signed')).toHaveAttribute('data-signed', 'yes', { timeout: 15_000 });
  await more(card);
  const menu = card.locator('.acct-menu');
  await expect(menu.getByRole('button')).toHaveText(['Sign out', 'Remove…']);
  await app.screenshot({ path: `../.scratch/shots/manage-${test.info().project.name}.png` });

  fs.rmSync(path.join(folder, '.logged-in'));
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(card.locator('.acct-signed')).toHaveAttribute('data-signed', 'no', { timeout: 15_000 });
  await more(card);
  await expect(menu.getByRole('button')).toHaveText(['Sign in', 'Remove…']);
  await menu.getByRole('button', { name: 'Sign in to Claude · 회사' }).click();
  await expect(card.locator('details.acct-more')).not.toHaveAttribute('open');
});

// Ticket 358 `358-permission-row`: the agent's own choices, Bypass by default, and the next new session only.
test('accounts_page: Permission sets what the next new session starts with; a running one stays', async ({ app, core }) => {
  test.setTimeout(90_000);
  fakes(core);
  const log = path.join(core.home, 'argv.log');
  const claude = path.join(core.home, 'bin/claude');
  fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace('exec /bin/cat', `echo "$*" >> "${log}"; exec /bin/cat`));
  const project = core.project('demo');
  await openWindow(app);
  const start = async () => {
    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
    const dlg = app.getByRole('dialog', { name: 'New tab' });
    await dlg.getByRole('combobox').fill(project);
    await dlg.getByRole('option', { name: /Start in folder/ }).click();
    await dlg.getByRole('combobox').fill('');
    await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
    await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  };
  const argv = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const setPermission = async (choice: string) => {
    await openAccounts(app);
    await openRow(app, 'Claude');
    await app.getByRole('combobox', { name: 'Permission · Claude' }).selectOption({ label: choice });
    await expect(app.getByText('Applies from the next new session.').first()).toBeVisible();
    await closeSettings(app);
  };
  await openAccounts(app);
  await openRow(app, 'Claude');
  const claudeSelect = app.getByRole('combobox', { name: 'Permission · Claude' });
  await expect(claudeSelect).toHaveValue('full-access');
  await expect(claudeSelect.locator('option')).toHaveText(["Agent's own setting", 'Ask every time', 'Accept edits', 'Auto', 'Bypass permissions']);
  await openRow(app, 'Codex');
  await expect(app.getByRole('combobox', { name: 'Permission · Codex' }).locator('option')).toHaveText(["Agent's own setting", 'Ask every time', 'Auto', 'Bypass permissions']);
  await closeSettings(app);

  await start();
  await expect.poll(argv).toHaveLength(1);
  expect(argv()[0]).toContain('--dangerously-skip-permissions');
  await setPermission('Ask every time');
  await start();
  await expect.poll(argv).toHaveLength(2);
  expect(argv()[1]).toContain('--permission-mode manual');
  expect(argv()[0]).toContain('--dangerously-skip-permissions'); // the running session was not restarted
  expect((core.cli('snapshot', '--json').sessions as { state: string }[]).filter((s) => s.state === 'running')).toHaveLength(2);
  await setPermission('Bypass permissions');
  await start();
  await expect.poll(argv).toHaveLength(3);
  expect(argv()[2]).toContain('--dangerously-skip-permissions');
});
