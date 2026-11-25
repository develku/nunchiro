// Tickets 321 and 322 against a real core with fake agents: the new-session default is stored in the core and used by
// a new session; Sign out runs the agent's own logout, removes nothing, and leaves the account usable after sign-in.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../src/types';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';
import { more, openRow } from './accounts-rows';

const LABEL = 'work';
const ID = '0123456789abcdef0123456789abcdef';
// Signed in unless the folder holds `.out`; logout writes it, login clears it; any session start idles as `cat`.
const fake = (name: string, variable: string, status: string, login: string, logout: string) => `#!/bin/sh
D="\${${variable}:-$HOME/.${name}}"
case "$1" in --version) echo "${name === 'claude' ? '2.1.311 (Claude Code)' : 'codex-cli 0.161.0'}"; exit 0;; esac
mkdir -p "$D"
case "$*" in
  "${status}") if [ -e "$D/.out" ]; then ${name === 'claude' ? `echo '{"loggedIn": false}'` : `echo 'Not logged in' >&2`}; exit 1; fi; ${name === 'claude' ? `echo '{"loggedIn": true, "subscriptionType": "max"}'` : `echo 'Logged in using ChatGPT' >&2`}; exit 0;;
  "${login}") rm -f "$D/.out"; exit 0;;
  "${logout}") touch "$D/.out"; exit 0;;
esac
exec /bin/cat
`;
function setup(core: Core) {
  for (const [name, variable, status, login, logout] of [
    ['claude', 'CLAUDE_CONFIG_DIR', 'auth status --json', 'auth login', 'auth logout'],
    ['codex', 'CODEX_HOME', 'login status', 'login', 'logout'],
  ])
    fs.writeFileSync(path.join(core.home, 'bin', name), codexFake(fake(name, variable, status, login, logout)), { mode: 0o700 });
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "${LABEL}"\n`);
}
async function openAccounts(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  await expect(app.locator('#s-accounts .acct-card').first()).toBeVisible();
}
const card = (app: Page, id: string, agent = 'Claude') => app.locator(`#s-accounts .acct-card[data-agent-name="${agent}"][data-account="${id}"]`);
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];

test('account default: the pick is stored in the core, moves the chip and Remove, and a new session starts on it', async ({ app, core }) => {
  setup(core);
  const folder = core.project('alpha');
  await openWindow(app);
  await openAccounts(app);
  // The agent's own account is the pick until the owner picks another. Its name already reads "Default", so no chip repeats the word.
  await expect(card(app, 'own').locator('.acct-name')).toHaveText('Default');
  await expect(card(app, 'own').locator('.pchip.plain')).toHaveCount(0);
  await expect(card(app, ID)).toContainText("Plan Max", { timeout: 15_000 });
  await expect(card(app, "own")).toContainText("Plan Max"); // accounts probe 11-10: checked as the page opened
  await more(card(app, ID));
  await expect(card(app, ID).getByRole('button', { name: /Remove/ })).toBeVisible();

  // Ticket 391: the card's 새 세션 기본값 block picks the default account (it was a button on the account card).
  await app.getByRole('combobox', { name: 'Default account · Claude' }).selectOption(ID);
  await expect(card(app, ID).locator('.pchip.plain')).toHaveText('Default');
  await expect(card(app, 'own').locator('.pchip.plain')).toHaveCount(0);
  await expect(card(app, ID).getByRole('button', { name: /Remove/ })).toHaveCount(0); // the default is not removable
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features['accounts.default.claude']).toBe(ID);

  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await dlg.getByRole('combobox').fill(folder);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('combobox').fill('');
  const rows = dlg.getByRole('option', { name: /^Claude/ });
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ }).first()).toHaveText(`Claude · ${LABEL}`); // the pick comes first
  await rows.first().click();
  await expect.poll(() => snap(core).map((s) => s.account)).toEqual([LABEL]);
});

test('account sign out: an added account signs out without being removed, and can start again once signed in', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
  const work = card(app, ID);
  await expect(work).toContainText('Signed in', { timeout: 15_000 });
  await more(work);
  await work.getByRole('button', { name: `Sign out of Claude · ${LABEL}` }).click();
  await app.getByRole('group', { name: `Sign out of ${LABEL}` }).getByRole('button', { name: 'Sign out' }).click();
  await expect(work.locator('.acct-signed')).toHaveAttribute('data-signed', 'no', { timeout: 15_000 });
  expect(fs.readFileSync(path.join(core.home, 'accounts.toml'), 'utf8')).toContain(ID); // still registered
  await expect(work.getByRole('button', { name: `Sign in to ${LABEL}` }).or(work.getByRole('button', { name: 'Sign in' }))).toBeVisible();
  // The logout tab is closed, so nothing keeps agents off the folder (Sessions::start refuses while it is listed).
  fs.rmSync(path.join(core.home, 'accounts/claude', ID, '.out'));
  const started = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'after', '--account', LABEL).session as Session;
  expect(started.account).toBe(LABEL);
});

test('account sign out: the Default account logs out with no folder override, then signs in from its row', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
  const own = card(app, 'own');
  // Accounts probe 11-10: "Your own" was checked as the page opened.
  await expect(own.locator('.acct-signed')).toHaveAttribute('data-signed', 'yes', { timeout: 15_000 });
  await expect(own).toContainText("Plan Max");
  await more(own);
  await own.getByRole('button', { name: 'Sign out of Claude · Default' }).click();
  await app.getByRole('group', { name: 'Sign out of Default' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(own.locator('.acct-signed')).toHaveAttribute('data-signed', 'no', { timeout: 15_000 }); // the probe after logout, not the old "yes"
  await expect.poll(() => snap(core).filter((s) => s.label === 'Logout: Default' && s.state !== 'closed').length).toBe(0); // its tab closes
  await own.getByRole('button', { name: /Sign in/ }).click();
  await expect.poll(() => snap(core).some((s) => s.label === 'Login: Default')).toBe(true);
  await expect.poll(() => snap(core).filter((s) => s.label === 'Login: Default' && s.state !== 'closed').length, { timeout: 15_000 }).toBe(0);
  // The login dropped the held check, so the check after it really probes; the login tab may have the front.
  await expect.poll(async () => {
    if (!(await app.locator('#s-accounts').isVisible())) await openAccounts(app);
    await openRow(app, 'Claude');
    return card(app, 'own').locator('.acct-signed').getAttribute('data-signed');
  }, { timeout: 20_000, intervals: [1_000] }).toBe('yes');
});
