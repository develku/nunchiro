// Needs 171, 172 (ticket 205): a signed-out added account has a "Sign in" button on its own row. It reuses the browser
// sign-in with the account's `id`, so it signs the same folder in again and never creates a second account. Against a
// real core with the fake `claude` of crates/nunchiro-core/tests/fixtures/accounts (never a real login).
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { more, openRow, recordStatusRuns } from './accounts-rows';

const CODE = 'FAKE-CODE-91x#q';
const FIXTURES = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/accounts');

function fakes(core: Core) {
  const bin = path.join(core.home, 'bin');
  fs.copyFileSync(path.join(FIXTURES, 'signin-fake-claude.sh'), path.join(bin, 'claude'));
  fs.copyFileSync(path.join(FIXTURES, 'signin-fake-codex.sh'), path.join(bin, 'codex'));
  for (const name of ['open', 'security']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NUNCHIRO_HOME/${name}.log"\n`);
  for (const name of ['claude', 'codex', 'open', 'security']) fs.chmodSync(path.join(bin, name), 0o700);
}
// The owner socket's account_add, as a script outside the window: a signed-out account whose terminal login tab waits.
const ADD = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, agent, label] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'account_add', agent, label } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
type Added = { id: string; folder: string };
function add(core: Core, label: string, { keepTab = false } = {}): Added {
  const r = JSON.parse(execFileSync(process.execPath, ['-e', ADD, core.home, 'claude', label], { encoding: 'utf8', timeout: 20_000 }));
  expect(r.Ok.type).toBe('account_added');
  // The login tab holds the folder ("in use"): closed unless the test wants that.
  if (!keepTab) {
    core.cli('session', 'close', r.Ok.session.id);
    const until = Date.now() + 10_000;
    while (core.cli('snapshot', '--json').sessions.some((s: { id: string; state: string }) => s.id === r.Ok.session.id && s.state === 'running')) {
      if (Date.now() > until) throw new Error(`Login: ${label} never closed`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // a 50 ms sync wait with no child process (V2.5-41 home guard)
    }
  }
  return r.Ok.account;
}
async function openAccounts(app: Page) {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  await expect(app.getByRole('heading', { level: 2, name: /Providers/ })).toBeVisible();
}
const rows = (app: Page, agent: string) => app.locator('#s-accounts').locator(`.acct-card[data-agent-name="${agent}"]`);
const rowOf = (app: Page, id: string) => app.locator(`#s-accounts .acct-card[data-account="${id}"]`);
const folders = (a: Added) => fs.readdirSync(path.dirname(a.folder)).sort();
/** The `account_sign_in` requests the window sends, as their JSON. */
function signInRequests(app: Page) {
  const sent: { op: string; agent: string; label: string; id?: string }[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string' || !f.payload.includes('account_sign_in"')) return;
      const request = JSON.parse(f.payload).request;
      if (request?.op === 'account_sign_in') sent.push(request);
    }),
  );
  return sent;
}
const signInButton = (app: Page, label: string) => app.getByRole('button', { name: `Sign in “${label}”` });
const panel = (app: Page, label: string) => app.getByRole('group', { name: `Sign in “${label}”` });

test('signed_out_row_has_sign_in: only a signed-out added row has it, never the default, a signed-in or an unknown row', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'work');
  const done = add(core, 'done');
  fs.writeFileSync(path.join(done.folder, '.logged-in'), '');
  const mystery = add(core, 'mystery');
  fs.writeFileSync(path.join(mystery.folder, '.unknown'), '');
  await openWindow(app);
  await openAccounts(app);
  await expect(rows(app, 'Claude')).toHaveCount(4);
  await expect(rowOf(app, work.id).locator('.acct-signed')).toHaveAttribute('data-signed', 'no');
  await expect(rowOf(app, done.id).locator('.acct-signed')).toHaveAttribute('data-signed', 'yes');
  await expect(rowOf(app, mystery.id).locator('.acct-signed')).toHaveAttribute('data-signed', 'unknown');
  await expect(rowOf(app, work.id).getByRole('button')).toHaveText(['', 'View usage →', 'Sign in']); // ticket 450: the first is the rename pencil
  await expect(signInButton(app, 'work')).toBeVisible();
  await expect(rowOf(app, done.id).getByRole('button')).toHaveText(['', 'View usage →']); // ticket 322: Sign out is behind its ⋯; ticket 391: the default is the card's 기본 계정 select
  await expect(rowOf(app, mystery.id).getByRole('button')).toHaveText(['', 'View usage →', 'Check again']);
  await expect(rows(app, 'Claude').first()).toContainText('Default');
  // Accounts probe 11-10: "Your own" was checked as the page opened and said no, so it offers Sign in. Another account is
  // signed in, so the head has no Check and the card does.
  await expect(rows(app, 'Claude').first().getByRole('button')).toHaveText(['', 'View usage →', 'Check', 'Sign in']);
  await openRow(app, 'Codex');
  await expect(rows(app, 'Codex').first().getByRole('button')).toHaveText(['', 'View usage →', 'Check', 'Sign in']);
});

test('row_sign_in_reuses_the_account: the request carries the id; the same folder is signed in, no second account', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'work');
  const before = folders(work);
  const sent = signInRequests(app);
  await openWindow(app);
  await openAccounts(app);
  await expect(rows(app, 'Claude')).toHaveCount(2);
  await signInButton(app, 'work').click();
  await expect(panel(app, 'work')).toBeVisible();
  await expect(panel(app, 'work').getByRole('status')).toHaveText(/Your browser opened the Claude sign-in/);
  expect(sent).toEqual([{ op: 'account_sign_in', agent: 'claude', label: 'work', id: work.id }]);
  // The panel offers no terminal login for it: that path would add a second account of the same name.
  await expect(panel(app, 'work').getByRole('button', { name: 'Sign in using a terminal instead' })).toHaveCount(0);
  await panel(app, 'work').getByRole('textbox', { name: 'Paste code' }).fill(CODE);
  await panel(app, 'work').getByRole('button', { name: 'Submit code' }).click();
  await expect(panel(app, 'work')).toHaveCount(0);
  await expect(app.getByRole('status').filter({ hasText: '“work” is signed in.' })).toBeVisible();
  await expect(rows(app, 'Claude')).toHaveCount(2);
  await expect(rowOf(app, work.id)).toContainText('Signed in');
  await expect(rowOf(app, work.id)).toContainText('work');
  await expect(signInButton(app, 'work')).toHaveCount(0);
  expect(folders(work)).toEqual(before);
  expect(fs.existsSync(path.join(work.folder, '.logged-in'))).toBe(true);
});

test('row_sign_in_retry_keeps_the_id: Retry signs the same account in again and the panel has no terminal fallback', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'work');
  const before = folders(work);
  fs.writeFileSync(path.join(core.home, 'mode'), 'exit3');
  const sent = signInRequests(app);
  await openWindow(app);
  await openAccounts(app);
  await signInButton(app, 'work').click();
  await expect(panel(app, 'work').getByRole('alert')).toHaveText('Claude sign-in ended with code 3.');
  await expect(panel(app, 'work').getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(panel(app, 'work').getByRole('button', { name: 'Sign in using a terminal instead' })).toHaveCount(0);
  fs.rmSync(path.join(core.home, 'mode'));
  await panel(app, 'work').getByRole('button', { name: 'Retry' }).click();
  await panel(app, 'work').getByRole('textbox', { name: 'Paste code' }).fill(CODE);
  await panel(app, 'work').getByRole('button', { name: 'Submit code' }).click();
  await expect(app.getByRole('status').filter({ hasText: '“work” is signed in.' })).toBeVisible();
  expect(sent).toEqual([
    { op: 'account_sign_in', agent: 'claude', label: 'work', id: work.id },
    { op: 'account_sign_in', agent: 'claude', label: 'work', id: work.id },
  ]);
  await expect(rows(app, 'Claude')).toHaveCount(2);
  expect(folders(work)).toEqual(before);
});

test('row_sign_in_in_use_is_refused: a session holding the folder refuses it with the core’s text; the row button is disabled while a panel is open', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'work', { keepTab: true }); // its terminal login tab is still running on the folder
  const other = add(core, 'other');
  const sent = signInRequests(app);
  const whenFails = recordStatusRuns(core);
  await openWindow(app);
  await openAccounts(app);
  await whenFails(() => expect(signInButton(app, 'work')).toBeVisible());
  await whenFails(() => expect(signInButton(app, 'other')).toBeVisible());
  await signInButton(app, 'work').click();
  // Ticket 534: the core's fixed refusal in plain words (what happened, what to do), its own words under a closed Details.
  await expect(panel(app, 'work').getByRole('alert')).toHaveText(/^The account work is in use\. Close its sessions, then try again\.Details/);
  await expect(panel(app, 'work').getByRole('alert').locator('details.err-details')).not.toHaveAttribute('open');
  await expect(panel(app, 'work').getByRole('alert').locator('details.err-details')).toContainText('account "work" is in use; close its sessions first');
  expect(sent).toHaveLength(1);
  expect(fs.existsSync(path.join(core.home, 'login.pid'))).toBe(false); // no login process started
  // While a panel is open, every row's Sign in and Remove are disabled.
  await expect(signInButton(app, 'other')).toBeDisabled();
  await expect(signInButton(app, 'work')).toBeDisabled();
  await more(rowOf(app, other.id));
  await expect(rowOf(app, other.id).getByRole('button', { name: 'Remove Claude account other' })).toBeDisabled();
  await panel(app, 'work').getByRole('button', { name: 'Cancel' }).click();
  await expect(panel(app, 'work')).toHaveCount(0);
  await expect(signInButton(app, 'other')).toBeEnabled();
  expect(folders(work)).toEqual(folders(other));
});
