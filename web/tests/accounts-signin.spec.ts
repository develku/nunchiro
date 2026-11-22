// Ticket 178 finding 20: Settings > Accounts signs a new account in through the browser, like Orca, against a real core
// with the fake `claude` and `codex` logins of crates/nunchiro-core/tests/fixtures/accounts; a test core records what it
// would hand to `open` (ticket 800: no browser opens, no real login runs).
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, expect, grantClipboard, openWindow, test, type Core } from './fixtures';
import { openAdd, openRow } from './accounts-rows';
import { LANGUAGES, type Key } from '../src/i18n';
import { EN, TABLES } from './i18n-tables';

const CODE = 'FAKE-CODE-91x#q';
const LINK = 'https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fake';
const FIXTURES = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/accounts');
/** REPORT captures: the accounts section in each state, per engine. */
const shot = (app: Page, name: string) => app.locator('#s-accounts').screenshot({ path: path.join(REPO, `.scratch/shots/signin-${name}-${test.info().project.name}.png`) });

function fakes(core: Core) {
  const bin = path.join(core.home, 'bin');
  fs.copyFileSync(path.join(FIXTURES, 'signin-fake-claude.sh'), path.join(bin, 'claude'));
  fs.copyFileSync(path.join(FIXTURES, 'signin-fake-codex.sh'), path.join(bin, 'codex'));
  for (const name of ['security']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NUNCHIRO_HOME/${name}.log"\n`);
  for (const name of ['claude', 'codex', 'security']) fs.chmodSync(path.join(bin, name), 0o700);
}
const read = (core: Core, name: string) => (fs.existsSync(path.join(core.home, name)) ? fs.readFileSync(path.join(core.home, name), 'utf8') : '');
async function openAccounts(app: Page) {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.getByRole('heading', { level: 2, name: /Providers/ })).toBeVisible();
}
const section = (app: Page, agent: string) => app.locator(`[data-agent="${agent}"]`);
const rows = (app: Page, agent: string) => app.locator('#s-accounts').locator(`.acct-card[data-agent-name="${agent}"]`);
/** Click 1: the agent's "+ Add account"; then the name; click 2: "Sign in". */
async function startSignIn(app: Page, agent: string, name: string, enter = false) {
  await openRow(app, agent === 'codex' ? 'Codex' : 'Claude');
  await openAdd(app, agent);
  await app.getByRole('textbox', { name: 'Name' }).fill(name);
  if (enter) await app.getByRole('textbox', { name: 'Name' }).press('Enter');
  else await section(app, agent).getByRole('button', { name: 'Sign in with browser' }).click();
  return app.getByRole('group', { name: `Sign in “${name}”` });
}
async function setup(app: Page, core: Core) {
  fakes(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openAccounts(app);
}

test('signin_claude_browser_flow and signin_reachable_2_clicks: Add account, Sign in, the browser opens, Paste code signs in; no terminal tab', async ({ app, core, browserName }) => {
  await setup(app, core);
  const tabs = await app.locator('.tab[data-tab]').count();
  const panel = await startSignIn(app, 'claude', 'work');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('Your browser opened the Claude sign-in. Finish there; this page updates when you are signed in.');
  await expect.poll(() => core.opened()).toBe(`open\n${LINK}\n`); // ticket 800: recorded, not started
  await shot(app, 'waiting');
  // Copy link copies exactly the link the core let through.
  if (browserName === 'chromium') {
    await grantClipboard(app);
    await panel.getByRole('button', { name: 'Copy link' }).click();
    await expect(panel.getByRole('button', { name: 'Link copied.' })).toBeVisible();
    expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(LINK);
  }
  const field = panel.getByRole('textbox', { name: 'Paste code' });
  await field.fill(CODE);
  await panel.getByRole('button', { name: 'Submit code' }).click();
  await expect(app.getByRole('group', { name: 'Sign in “work”' })).toHaveCount(0);
  await expect(app.getByRole('status').filter({ hasText: '“work” is signed in.' })).toBeVisible();
  await expect(rows(app, 'Claude')).toHaveCount(2);
  await expect(rows(app, 'Claude').nth(1)).toContainText('work');
  await expect(rows(app, 'Claude').nth(1)).toContainText('Signed in');
  await shot(app, 'signed-in');
  // signin_code_never_persisted (page side): the code is in no field, attribute or text of the page.
  expect(await app.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((i) => i.value).join(''))).not.toContain(CODE);
  expect(read(core, 'code-seen')).toBe('stdin\n');
  expect(read(core, 'core.log')).not.toContain(CODE);
  // No terminal tab was opened and no Keychain call was made.
  await expect(app.locator('.tab[data-tab]')).toHaveCount(tabs);
  expect(core.cli('snapshot', '--json').sessions.filter((s: { label: string }) => s.label.startsWith('Login: '))).toEqual([]);
  expect(read(core, 'security.log')).toBe('');
});

test('signin_codex_browser_flow: the Codex link opens, no Paste code, the callback signs in', async ({ app, core }) => {
  await setup(app, core);
  const panel = await startSignIn(app, 'codex', 'team');
  await expect(panel.getByRole('status')).toHaveText(/Your browser opened the Codex sign-in/);
  await expect.poll(() => core.opened()).toMatch(/^open\nhttps:\/\/auth\.openai\.com\/oauth\/authorize\?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fake\n$/);
  await expect(panel.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  await expect(panel.getByRole('textbox', { name: 'Paste code' })).toHaveCount(0);
  await shot(app, 'codex-waiting');
  fs.writeFileSync(path.join(core.home, 'codex-callback'), '');
  await expect(app.getByRole('status').filter({ hasText: '“team” is signed in.' })).toBeVisible();
  await expect(rows(app, 'Codex').nth(1)).toContainText('Signed in');
  expect(core.cli('snapshot', '--json').sessions.filter((s: { label: string }) => s.label.startsWith('Login: '))).toEqual([]);
});

test('signin_failure_and_retry: a wrong code shows Orca’s line and Retry signs in; a login that exits shows one line and the terminal login', async ({ app, core }) => {
  await setup(app, core);
  // Enter in the name field starts the browser sign-in too.
  const panel = await startSignIn(app, 'claude', 'work', true);
  await panel.getByRole('textbox', { name: 'Paste code' }).fill('WRONG-code');
  await panel.getByRole('textbox', { name: 'Paste code' }).press('Enter');
  await expect(panel.getByRole('alert')).toHaveText('Claude did not accept that code. Start the sign-in again.');
  await shot(app, 'code-rejected');
  await openRow(app, 'Claude');
  await expect(rows(app, 'Claude')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Retry' }).click();
  await panel.getByRole('textbox', { name: 'Paste code' }).fill(CODE);
  await panel.getByRole('button', { name: 'Submit code' }).click();
  await expect(app.getByRole('status').filter({ hasText: '“work” is signed in.' })).toBeVisible();
  await expect(rows(app, 'Claude')).toHaveCount(2);
  // A login that exits non-zero: one line, Retry, and the terminal login as the fallback.
  fs.writeFileSync(path.join(core.home, 'mode'), 'exit3');
  const failed = await startSignIn(app, 'claude', 'second');
  await expect(failed.getByRole('alert')).toHaveText('Claude sign-in ended with code 3.');
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  await failed.getByRole('button', { name: 'Sign in using a terminal instead' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Login for “second” opened in the tab “Login: second”.' })).toBeVisible();
  await expect(app.locator('.tab').filter({ hasText: 'Login: second' })).toBeVisible();
});

test('signin_terminal_fallback_kept: "Sign in using a terminal instead" on the add row runs the old login tab', async ({ app, core }) => {
  await setup(app, core);
  await openRow(app, 'Codex');
  await openAdd(app, 'codex');
  await app.getByRole('textbox', { name: 'Name' }).fill('term');
  await shot(app, 'add-row');
  await section(app, 'codex').getByRole('button', { name: 'Sign in using a terminal instead' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Login for “term” opened in the tab “Login: term”.' })).toBeVisible();
  await expect(app.locator('.tab').filter({ hasText: 'Login: term' })).toBeVisible();
  expect(core.opened()).toBe('');
});

test('signin_cancel: Cancel stops the login and lists nothing', async ({ app, core }) => {
  await setup(app, core);
  fs.writeFileSync(path.join(core.home, 'mode'), 'hang');
  const panel = await startSignIn(app, 'claude', 'gone');
  await expect(panel.getByRole('status')).toHaveText(/Your browser opened/);
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Sign-in cancelled.' })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await openRow(app, 'Claude');
  await expect(rows(app, 'Claude')).toHaveCount(1);
  const pid = Number(read(core, 'login.pid').trim());
  await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
});

test('signin_strings_8_languages: every sign-in string is in all 8 languages with the English placeholders', () => {
  const keys = (Object.keys(EN) as Key[]).filter((k) => /^settings\.accounts\.(signIn|opening|browserOpened|copyLink|linkCopied|pasteCode|submitCode|signedInDone|retry|fail\.)/.test(k));
  expect(keys.length).toBe(23);
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const langs = LANGUAGES.map((l) => l.id).filter((id) => id !== 'system');
  expect(langs).toHaveLength(8);
  for (const id of langs)
    for (const k of keys) {
      expect(TABLES[id]?.[k]?.trim(), `${id}: ${k}`).toBeTruthy();
      expect(holes(TABLES[id]![k]!), `${id}: ${k}`).toEqual(holes(EN[k]));
    }
});

// Ticket 378 (설정 나머지): the panel of a sign-in in progress comes back after another Settings page, and the login still
// finishes there; Esc inside the panel cancels it.
test('signin_survives_page_change: leave Providers mid sign-in, come back, the panel is there and the sign-in finishes', async ({ app, core }) => {
  await setup(app, core);
  const panel = await startSignIn(app, 'claude', 'back');
  await expect(panel.getByRole('status')).toHaveText(/Your browser opened/);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await panel.getByRole('textbox', { name: 'Paste code' }).fill(CODE);
  await panel.getByRole('button', { name: 'Submit code' }).click();
  await expect(panel).toHaveCount(0);
  await expect(app.getByRole('status').filter({ hasText: '“back” is signed in.' })).toBeVisible();
  // Signed in: nothing is held, so a later visit shows no panel.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers', exact: true }).click();
  await expect(app.locator('#s-accounts')).toBeVisible();
  await expect(app.getByRole('group', { name: /^Sign in “/ })).toHaveCount(0);
});

test('signin_esc_cancels: Esc inside the panel cancels the sign-in', async ({ app, core }) => {
  await setup(app, core);
  fs.writeFileSync(path.join(core.home, 'mode'), 'hang');
  const panel = await startSignIn(app, 'claude', 'esc');
  await expect(panel.getByRole('status')).toHaveText(/Your browser opened/);
  await expect(panel).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('status').filter({ hasText: 'Sign-in cancelled.' })).toBeVisible();
  await expect(panel).toHaveCount(0);
});
