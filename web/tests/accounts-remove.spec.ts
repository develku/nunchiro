// V2-2d Settings > Accounts > Remove against a real core with fake `claude` and `codex`: no Remove on "Your own"; the
// confirm names how many sessions lose their history; the agent's own logout runs in a visible tab and the folder then
// moves to the trash; a non-zero logout asks before the move; a session on the account makes the core refuse, naming it.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';
import { clickRemove, openRow } from './accounts-rows';

// \`--model quit\` makes an agent end at once (a resumable session). Status says signed out, login exits at once (stays open like a stale one while `login-hold` exists), logout prints its folder and after a second (its tab is seen running) exits with `logout-code` (0 when absent);
// anything else is an agent that idles as `cat`.
const fake = (name: string, variable: string, status: string, login: string, logout: string) => `#!/bin/sh
D="\${${variable}}"
case "$1" in --version) echo "${name} 1.0.0"; exit 0;; esac
case " $* " in *" --model quit "*) exit 0;; esac
case "$*" in
  "${status}") exit 1;;
  "${login}") [ -e "$NUNCHIRO_HOME/login-hold" ] && exec /bin/cat; exit 0;;
  "${logout}") printf 'logout for %s\\r\\n' "$D"; sleep 1; exit "$(cat "$NUNCHIRO_HOME/logout-code" 2>/dev/null || echo 0)";;
esac
exec /bin/cat
`;
function fakes(core: Core) {
  for (const [name, variable, status, login, logout] of [
    ['claude', 'CLAUDE_CONFIG_DIR', 'auth status --json', 'auth login', 'auth logout'],
    ['codex', 'CODEX_HOME', 'login status', 'login', 'logout'],
  ])
    fs.writeFileSync(path.join(core.home, 'bin', name), codexFake(fake(name, variable, status, login, logout)), { mode: 0o700 });
}
// The owner socket's account_add, as a script outside the window (the CLI has no add command).
const ADD = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, agent, label] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'account_add', agent, label } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function add(core: Core, agent: string, label: string): { id: string; folder: string } {
  const r = JSON.parse(execFileSync(process.execPath, ['-e', ADD, core.home, agent, label], { encoding: 'utf8', timeout: 20_000 }));
  expect(r.Ok.type).toBe('account_added');
  // A login that exits at once may still be running when the window opens, and the window then counts one tab more
  // than the snapshot taken a moment later: wait for it to end (a held login stays running on purpose).
  const until = Date.now() + 10_000;
  while (!fs.existsSync(path.join(core.home, 'login-hold')) && listed(core).some((s) => s.label === `Login: ${label}` && s.state === 'running')) {
    if (Date.now() > until) throw new Error(`Login: ${label} never exited`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // a 50 ms sync wait with no child process (V2.5-41 home guard)
  }
  return r.Ok.account;
}
const onAccount = (core: Core, kind: string, account: string, label: string) =>
  core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', label, '--account', account).session as { id: string };
async function openAccounts(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  await expect(app.getByRole('heading', { level: 2, name: /Providers/ })).toBeVisible();
}
const rows = (app: Page, agent: string) => app.locator('#s-accounts').locator(`.acct-card[data-agent-name="${agent}"]`); // v25-fix-settings: Usage shares the page
const trash = (core: Core) => {
  const dir = path.join(core.home, 'accounts', '.trash');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('accounts_remove: no Remove on "the Default account"; the confirm names the session count, logout runs in a tab, then the folder goes to the trash', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'claude', 'work');
  const old = onAccount(core, 'claude', 'work', 'old chat');
  core.cli('session', 'close', old.id);
  await openWindow(app);
  await openAccounts(app);
  // Rows first: a count of zero buttons proves nothing before the list has loaded.
  await expect(rows(app, 'Claude')).toHaveCount(2);
  for (const agent of ['Claude', 'Codex']) {
    await openRow(app, agent);
    await expect(rows(app, agent).first()).toContainText('Default');
    await expect(rows(app, agent).first().getByRole('button')).toHaveText(['', 'View usage →']); // the rename pencil, no Remove
  }
  await clickRemove(app, 'Claude', 'work');
  const sheet = app.getByRole('group', { name: 'Remove account work' });
  await expect(sheet).toContainText('Remove “work”? 1 session can no longer be resumed, and its usage history and search results are lost.');
  await expect(sheet).toContainText('You cannot undo this in Nunchiro');
  // Focus starts on Cancel; Escape closes the sheet and nothing is removed.
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(fs.existsSync(work.folder)).toBe(true);
  // Q9 ko-J9-1: folding the card keeps the open confirm on screen (it locks every other button) and Cancel still works.
  await clickRemove(app, 'Claude', 'work');
  await openRow(app, 'Codex');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await clickRemove(app, 'Claude', 'work');
  await sheet.getByRole('button', { name: 'Sign out and remove' }).click();
  await expect(app.locator('.tab').filter({ hasText: 'Logout: work' })).toBeVisible();
  // While the logout runs (its buttons disabled), focus rests on the progress line, never the page body.
  await expect(sheet.getByText('Signing out in its terminal tab')).toBeFocused();
  await expect(app.getByRole('status').filter({ hasText: 'Removed “work”. Its folder stays in the trash for 7 days.' })).toBeVisible();
  await expect(rows(app, 'Claude')).toHaveCount(1);
  expect(fs.existsSync(work.folder)).toBe(false);
  expect(trash(core)).toEqual([expect.stringMatching(new RegExp(`^${work.id}-\\d+$`))]);
  const logout = core.cli('snapshot', '--json').sessions.find((s: { label: string }) => s.label === 'Logout: work');
  expect(core.read(logout.id)).toContain(`logout for ${work.folder}`);
});

test('accounts_remove: a non-zero logout asks about the leftovers before the move', async ({ app, core }) => {
  fakes(core);
  const team = add(core, 'codex', 'team');
  fs.writeFileSync(path.join(core.home, 'logout-code'), '1');
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Codex', 'team');
  const sheet = app.getByRole('group', { name: 'Remove account team' });
  await expect(sheet).toContainText('0 sessions can no longer be resumed, and their usage history and search results are lost.');
  await sheet.getByRole('button', { name: 'Sign out and remove' }).click();
  await expect(sheet).toContainText('Logout exited with 1.');
  await expect(sheet.getByRole('button', { name: 'Keep account' })).toBeFocused();
  expect(fs.existsSync(team.folder)).toBe(true);
  await sheet.getByRole('button', { name: 'Remove anyway' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed “team”.' })).toBeVisible();
  expect(fs.existsSync(team.folder)).toBe(false);
  expect(trash(core)).toHaveLength(1);
});

test('accounts_remove: a live session on the account is named in the refusal and nothing moves', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'claude', 'work');
  onAccount(core, 'claude', 'work', 'live chat');
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Claude', 'work');
  await expect(app.locator('[role="alert"][data-error]')).toContainText('"live chat"');
  await expect(app.getByRole('group', { name: 'Remove account work' })).toHaveCount(0);
  expect(fs.existsSync(work.folder)).toBe(true);
  expect(trash(core)).toEqual([]);
});

// Ticket 178 (needs 149 finding 9): a stale login tab is the only blocker. The refusal names it with "Close and remove".
const held = (core: Core, agent: string, label: string) => {
  fs.writeFileSync(path.join(core.home, 'login-hold'), '');
  // Kept: the login tab reads it when it starts, which may be after the add returns.
  return add(core, agent, label);
};
const listed = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; label: string; state: string; agent_ended?: boolean }[];

test('remove_refusal_names_login_tab, close_and_remove_completes: the login tab is named, Close and remove closes it and the account goes to the trash', async ({ app, core }) => {
  fakes(core);
  const work = held(core, 'claude', 'work');
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Claude', 'work');
  const sheet = app.getByRole('group', { name: 'Remove account work' });
  await expect(sheet).toContainText('“work” is in use by tab “Login: work”');
  await expect(app.locator('[role="alert"][data-error]')).toHaveCount(0);
  expect(fs.existsSync(work.folder)).toBe(true);
  await sheet.getByRole('button', { name: 'Close and remove' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed “work”. Its folder stays in the trash for 7 days.' })).toBeVisible();
  await expect(rows(app, 'Claude')).toHaveCount(1);
  expect(fs.existsSync(work.folder)).toBe(false);
  expect(trash(core)).toEqual([expect.stringMatching(new RegExp(`^${work.id}-\\d+$`))]);
  expect(listed(core).find((s) => s.label === 'Login: work')?.state).toBe('closed');
});

test('close_and_remove_offers_only_login_tabs: with an agent session on the account too, the refusal is plain and nothing is closed', async ({ app, core }) => {
  fakes(core);
  const work = held(core, 'claude', 'work');
  const chat = onAccount(core, 'claude', 'work', 'live chat');
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Claude', 'work');
  await expect(app.locator('[role="alert"][data-error]')).toContainText('"live chat"');
  await expect(app.locator('[role="alert"][data-error]')).toContainText('close them first');
  await expect(app.getByRole('button', { name: 'Close and remove' })).toHaveCount(0);
  const states = listed(core);
  expect(states.find((s) => s.id === chat.id)?.state).toBe('running');
  expect(states.find((s) => s.label === 'Login: work')?.state).toBe('running');
  expect(fs.existsSync(work.folder)).toBe(true);
});

test('remove_refusal_label_rendered_as_text: a markup label shows as quoted text, a long one is cut', async ({ app, core }) => {
  fakes(core);
  const markup = '<img src=x onerror="document.title=1">';
  const long = 'W'.repeat(64);
  held(core, 'claude', markup);
  held(core, 'codex', long);
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Claude', `${markup}`);
  const sheet = app.getByRole('group', { name: `Remove account ${markup}` });
  await expect(sheet).toContainText(`is in use by tab “Login: ${markup}”`);
  await expect(sheet.locator('img')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await clickRemove(app, 'Codex', `${long}`);
  const cut = app.getByRole('group', { name: `Remove account ${long}` }).locator('p').first();
  // "Login: " and 40 more characters, then the ellipsis: 48 in all.
  await expect(cut).toContainText(`“Login: ${'W'.repeat(40)}…”`);
  await expect(cut).not.toContainText(`Login: ${'W'.repeat(41)}`);
});

// Finding 9 second half: the window runs at most 4 off-loop requests at once, so a usage read that lands while they are
// taken is refused ("too many requests in flight"), and the columns stayed "—" until the next minute. The first read
// here is refused that way; the columns fill, and stay filled after a refused remove and after a remove.
test('account_rows_after_remove: after a refused usage read, a refused remove and a remove, the other accounts stay listed', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'claude', 'work');
  const team = add(core, 'claude', 'team');
  const line = (id: string, input: number) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, usage: { input_tokens: input, output_tokens: 0 } } }) + '\n';
  for (const [a, n] of [[work, 42], [team, 77]] as const) {
    fs.mkdirSync(path.join(a.folder, 'projects/p'), { recursive: true });
    fs.writeFileSync(path.join(a.folder, 'projects/p/a.jsonl'), line(`m${n}`, n));
  }
  const chat = onAccount(core, 'claude', 'work', 'live chat');
  let refuse = 1;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r?.request?.op === 'account_usage' && refuse-- > 0) return ws.send(JSON.stringify({ id: r.id, response: { Err: 'too many requests in flight; try again' } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  await openWindow(app);
  await openAccounts(app);
  const ids: Record<string, string> = { work: work.id, team: team.id };
  const row = (label: string) => rows(app, 'Claude').and(app.locator(`[data-account="${ids[label]}"]`)); // D2: the row itself; its token counts moved to Usage
  await expect(row('team')).toBeVisible();
  await expect(row('work')).toBeVisible();
  await expect.poll(() => refuse).toBeLessThan(0); // the refused read was retried
  await clickRemove(app, 'Claude', 'work');
  await expect(app.locator('#s-accounts').getByRole('alert')).toContainText('"live chat"');
  await expect(row('team')).toBeVisible();
  await expect(row('work')).toBeVisible();
  core.cli('session', 'close', chat.id);
  await expect.poll(() => ['running', 'resumable'].includes(listed(core).find((s) => s.id === chat.id)?.state ?? ''), { timeout: 15_000 }).toBe(false);
  await clickRemove(app, 'Claude', 'work');
  await app.getByRole('group', { name: 'Remove account work' }).getByRole('button', { name: 'Sign out and remove' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Removed “work”.' })).toBeVisible();
  await expect(rows(app, 'Claude')).toHaveCount(2);
  await expect(row('team')).toBeVisible();
});

// Round 2: a session the core counts against the account but that is not running (an agent that ended, resumable, in the account folder)
// is listed on the row, and one click on it opens that session.
test('blocker_reachable: a resumable session in the account folder is on the row and one click opens it', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'claude', 'work');
  const old = core.cli('session', 'start', '--kind', 'claude', '--project', work.folder, '--label', 'old chat', '--account', 'work', '--model', 'quit').session as { id: string };
  // Its agent ended on its own (ticket 286: the shell it left still runs); the core still counts it (it can be resumed).
  await expect.poll(() => listed(core).find((s) => s.id === old.id)?.agent_ended, { timeout: 15_000 }).toBe(true);
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Claude', 'work');
  await expect(app.locator('[role="alert"][data-error]')).toContainText('"old chat"');
  const open = rows(app, 'Claude').getByRole('button', { name: 'Resumable: “old chat”' });
  await expect(open).toBeVisible();
  await open.click();
  await expect(app.locator(`.tab[data-tab="${old.id}"]`)).toHaveAttribute('aria-selected', 'true');
  expect(fs.existsSync(work.folder)).toBe(true);
});

test('claude_login_label_not_offered: a claude session named "Login: work" in the account folder gets the plain refusal', async ({ app, core }) => {
  fakes(core);
  const work = add(core, 'claude', 'work');
  const fake = core.cli('session', 'start', '--kind', 'claude', '--project', work.folder, '--label', 'Login: work', '--account', 'work').session as { id: string };
  await openWindow(app);
  await openAccounts(app);
  await clickRemove(app, 'Claude', 'work');
  await expect(app.locator('[role="alert"][data-error]')).toContainText('"Login: work"');
  await expect(app.locator('[role="alert"][data-error]')).toContainText('close them first');
  await expect(app.getByRole('button', { name: 'Close and remove' })).toHaveCount(0);
  expect(listed(core).find((s) => s.id === fake.id)?.state).toBe('running');
  expect(fs.existsSync(work.folder)).toBe(true);
});
