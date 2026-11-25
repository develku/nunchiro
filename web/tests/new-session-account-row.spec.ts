// V2-2b acceptance `new-session-account-row` (v25-new-tab, needs 209: the New tab popover lists one row per account, "Claude · name",
// only when the agent has 2+ accounts, the one last used in the folder first; before, the sheet showed an Account row only when the chosen agent had
// 2+ accounts ("Your own" counts), prefills the account last used in that project (else "Your own"), marks a
// signed-out account with ○ and still starts on it; the label (Hangul here) shows on the tab and the AGENTS row.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { restartStart } from '../src/PermissionNeeded';
import type { Session } from '../src/types';
import { openRow } from './accounts-rows';
import { expect, openWindow, test, type Core, stripOnTop } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

const LABEL = '회사 계정';
const ID = '0123456789abcdef0123456789abcdef';

// Status probes answer "signed out"; any session start idles as `cat`.
const fake = (name: string, status: string) => `#!/bin/sh
case "$1" in --version) echo "${name === 'claude' ? '2.1.311 (Claude Code)' : 'codex-cli 0.161.0'}"; exit 0;; esac
if [ "$1 $2" = "${status}" ]; then ${name === 'claude' ? `echo '{"loggedIn": false}'` : `echo 'Not logged in' >&2`}; exit 1; fi
exec /bin/cat
`;
/** One Claude account named LABEL, as the registry stores it (V2-2a `accounts.toml` and its 0700 folder). */
function setup(core: Core, account: boolean) {
  for (const [name, status] of [
    ['claude', 'auth status'],
    ['codex', 'login status'],
  ])
    fs.writeFileSync(path.join(core.home, 'bin', name), fake(name, status), { mode: 0o700 });
  if (!account) return;
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "${LABEL}"\n`);
}
async function openSheet(app: Page, folder: string) {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('combobox').fill(folder);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('combobox').fill('');
  return dlg;
}
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];

test('new-session-account-row: hidden while the agent has one account', async ({ app, core }) => {
  setup(core, false);
  const folder = core.project('alpha');
  await openWindow(app);
  const dlg = await openSheet(app, folder);
  // The list (with its probes) has answered once the Accounts page would; give it the same time, then still one plain row.
  await app.waitForTimeout(1500);
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ })).toHaveText(['Claude']); // one plain row (its key chip is a sibling of the name)
});

test('new-session-account-row: shown with two, signed-out marked, prefilled with the project last account, label on tab and in the tree row tip', async ({ app, core }) => {
  setup(core, true);
  const alpha = core.project('alpha');
  const beta = core.project('beta');
  await openWindow(app);
  let dlg = await openSheet(app, alpha);
  const rows = dlg.getByRole('option', { name: /^Claude/ });
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ })).toHaveText(['Claude · Default', `Claude · ${LABEL}`]); // nothing used here yet: "Your own" first
  await expect(rows.nth(1)).toContainText('signed out');
  // Codex has only "Your own": one plain row.
  await expect(dlg.getByRole('option', { name: 'Codex', exact: true })).toBeVisible();
  await app.screenshot({ path: `../.scratch/shots/new-session-account-${test.info().project.name}.png` });
  await rows.nth(1).click(); // signed out, still selectable
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => snap(core).map((s) => [s.kind, s.project, s.account])).toEqual([['claude', alpha, LABEL]]);
  const [started] = snap(core);
  expect(started.config_dir).toBe(path.join(fs.realpathSync(core.home), 'accounts/claude', ID));
  await expect(app.locator(`.tab[data-tab="${started.id}"] .tacct`)).toHaveText(LABEL);
  await expect(app.locator(`button.row.wt2[data-menu-session="${started.id}"] .tip`)).toContainText(LABEL);
  await app.screenshot({ path: `../.scratch/shots/account-tab-agents-${test.info().project.name}.png` });

  // The same project lists that account first; another project lists "Your own" first.
  dlg = await openSheet(app, alpha);
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ }).first()).toHaveText(`Claude · ${LABEL}`, { timeout: 15_000 });
  await dlg.getByRole('combobox').fill(beta);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('combobox').fill('');
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ }).first()).toHaveText('Claude · Default');
  await dlg.getByRole('option', { name: 'Claude · Default' }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => snap(core).find((s) => s.project === beta)?.account ?? 'own').toBe('own');
  const own = snap(core).find((s) => s.project === beta)!;
  await expect(app.locator(`.tab[data-tab="${own.id}"] .tacct`)).toHaveCount(0);
  await expect(app.locator(`button.row.wt2[data-menu-session="${own.id}"] .tip`)).not.toContainText(LABEL);
});

test('new-session-account-row: a restart of a fresh account session stays on its account', () => {
  const s = { kind: 'claude', project: '/p', label: 'x', agent_session_id: null, account: LABEL } as unknown as Session;
  expect(restartStart(s)).toMatchObject({ account: LABEL, resume: null });
  expect(restartStart({ ...s, account: undefined })).not.toHaveProperty('account');
});

/** Makes the added account the default in its card's 기본 계정, and returns its account card. */
async function makeDefault(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  const card = app.locator(`#s-accounts .acct-card[data-account="${ID}"]`);
  // Ticket 391: the card's 새 세션 기본값 block picks the account (it was a button on the account card).
  await app.getByRole('combobox', { name: 'Default account · Claude' }).selectOption(ID);
  await expect(card).toContainText('Default');
  return card;
}
const FELL_BACK = 'Signed out. New sessions use the CLI’s own sign-in instead.';

// Ticket 358 `358-default-fallback`.
test('new-session-account-row: a signed-out default falls back to the CLI login, and the Accounts row says so', async ({ app, core }) => {
  setup(core, true);
  const alpha = core.project('alpha');
  await openWindow(app);
  const card = await makeDefault(app);
  await expect(card).toContainText(FELL_BACK, { timeout: 15_000 });
  await closeSettings(app);
  const dlg = await openSheet(app, alpha);
  const rows = dlg.getByRole('option', { name: /^Claude/ });
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ }).first()).toHaveText('Claude · Default');
  await rows.first().click();
  await expect.poll(() => snap(core).map((s) => [s.kind, s.account ?? null, s.config_dir ?? null])).toEqual([['claude', null, null]]);
});

test('new-session-account-row: a removed default says the same on the Default account', async ({ app, core }) => {
  setup(core, true);
  core.shell(core.project('alpha'), 'main');
  await openWindow(app);
  const settings = path.join(core.home, 'settings.json');
  const stored = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
  fs.writeFileSync(settings, JSON.stringify({ ...stored, features: { ...stored.features, 'accounts.default.claude': 'fedcba9876543210fedcba9876543210' } }));
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  const own = app.locator('#s-accounts .acct-card[data-account="own"]');
  await expect(own).toContainText('Default', { timeout: 15_000 });
  await expect(own).toContainText(FELL_BACK);
  await expect(app.locator(`#s-accounts .acct-card[data-account="${ID}"]`)).not.toContainText(FELL_BACK);
});

test('new-session-account-row: an unknown sign-in state keeps the default', async ({ app, core }) => {
  setup(core, true);
  const claude = path.join(core.home, 'bin/claude');
  fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace('exit 1', 'exit 3')); // the status text and exit disagree: unknown
  const alpha = core.project('alpha');
  await openWindow(app);
  const card = await makeDefault(app);
  await expect(card.locator('.acct-signed')).toHaveAttribute('data-signed', 'unknown', { timeout: 15_000 });
  await expect(card).not.toContainText(FELL_BACK);
  await closeSettings(app);
  const dlg = await openSheet(app, alpha);
  await expect(dlg.locator('.nt-name', { hasText: /^Claude/ }).first()).toHaveText(`Claude · ${LABEL}`, { timeout: 15_000 });
});
