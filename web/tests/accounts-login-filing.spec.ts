// Ticket 178 (needs 149 finding 9): an account's Login and Logout tabs are filed on its row in Settings > Accounts,
// never as a tree project named after the account's config folder (where "+" would start an agent among its
// credentials). The tab stays there across a core restart, where the login keeps running in its holder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';
import { clickRemove, openRow } from './accounts-rows';

// Status says signed out; login stays open like one waiting for its pasted code; logout waits for `logout-go`.
const FAKE = (status: string, login: string, logout: string) => `#!/bin/sh
case "$1" in --version) echo "fake 1.0.0"; exit 0;; esac
case "$*" in
  "${status}") exit 1;;
  "${login}") exec /bin/cat;;
  "${logout}") while [ ! -e "$NUNCHIRO_HOME/logout-go" ]; do sleep 0.1; done; exit 0;;
esac
exec /bin/cat
`;
const ADD = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, agent, label] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'account_add', agent, label } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function setup(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), FAKE('auth status --json', 'auth login', 'auth logout'), { mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'bin', 'codex'), codexFake(FAKE('login status', 'login', 'logout')), { mode: 0o700 });
}
function add(core: Core, agent: string, label: string): { id: string; folder: string } {
  const r = JSON.parse(execFileSync(process.execPath, ['-e', ADD, core.home, agent, label], { encoding: 'utf8', timeout: 20_000 }));
  expect(r.Ok.type).toBe('account_added');
  return r.Ok.account;
}
// Two clicks from the visible, labelled Settings control in the left bar.
async function openAccounts(app: import('@playwright/test').Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
}
const tree = (app: import('@playwright/test').Page) => app.locator('.grp');

test('login_tab_filed_visibly: Login and Logout tabs show on the account row, not as a config-folder project, also after a core restart', async ({ app: first, core }) => {
  let app = first;
  setup(core);
  const work = add(core, 'claude', 'work');
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await expect(tree(app).filter({ hasText: 'demo' })).toHaveCount(1);
  await expect(app.locator('.tab').filter({ hasText: 'Login: work' })).toBeVisible();
  // No project named after the account's folder (its id) in the tree.
  await expect(tree(app).filter({ hasText: work.id.slice(0, 8) })).toHaveCount(0);
  await expect(app.locator(`[data-project-path="${work.folder}"]`)).toHaveCount(0);
  // Settings > Accounts: the row names its open tab.
  await openAccounts(app);
  const row = () => app.locator('#s-accounts').locator(`.acct-card[data-agent-name="Claude"][data-account="${work.id}"]`);
  await expect(row()).toContainText('Tab open: “Login: work”');

  // A core that dies (kill -9) leaves the login running in its holder; the new core takes it back.
  // The page goes first: left open, it would retry the dead core's window port every second, a port the OS may
  // give to another worker's core meanwhile (round 2: the cause of "core disconnected" in parallel runs).
  const context = first.context();
  await first.close();
  const died = new Promise((done) => core.proc.once('exit', done));
  core.proc.kill('SIGKILL');
  await died;
  // `restart` waits for an exit code, which a signal death leaves null.
  Object.defineProperty(core.proc, 'exitCode', { value: 137 });
  await core.restart();
  expect(core.cli('snapshot', '--json').sessions.find((s: { label: string }) => s.label === 'Login: work').state).toBe('running');
  // The new core has a new window port and token: a fresh page boots with them.
  app = await context.newPage();
  await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(app);
  await expect(tree(app).filter({ hasText: 'demo' })).toHaveCount(1);
  await expect(app.locator(`[data-project-path="${work.folder}"]`)).toHaveCount(0);
  await openAccounts(app);
  await expect(row()).toContainText('Tab open: “Login: work”');

  // Logout tab: closed login, then Remove runs the logout, which waits here; it too is on the row, not in the tree.
  const login = core.cli('snapshot', '--json').sessions.find((s: { label: string }) => s.label === 'Login: work');
  core.cli('session', 'close', login.id);
  await app.evaluate(() => window.dispatchEvent(new Event('focus'))); // the page's refresh on window focus
  await expect(row()).not.toContainText('Login: work');
  await clickRemove(app, 'Claude', 'work');
  await app.getByRole('group', { name: 'Remove account work' }).getByRole('button', { name: 'Sign out and remove' }).click();
  await expect(app.locator('.tab').filter({ hasText: 'Logout: work' })).toBeVisible();
  await expect(row()).toContainText('Tab open: “Logout: work”');
  await expect(app.locator(`[data-project-path="${work.folder}"]`)).toHaveCount(0);
  await expect(tree(app).filter({ hasText: work.id.slice(0, 8) })).toHaveCount(0);
  fs.writeFileSync(path.join(core.home, 'logout-go'), '');
  await expect(app.getByRole('status').filter({ hasText: 'Removed “work”.' })).toBeVisible();
});
