// Ticket 358 `358-rename`: Settings > Accounts, ⋯ > Rename, against a real core with a fake `claude`. The running session and
// a new one both stay on the account's folder; a name another account has keeps Save off with the mock's line.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../src/types';
import { openRow } from './accounts-rows';
import { expect, openWindow, test, type Core } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

const WORK = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

const FAKE = `#!/bin/sh
D="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1" in --version) echo "2.1.311 (Claude Code)"; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then
  if [ -e "$D/.logged-in" ]; then echo '{"loggedIn": true}'; exit 0; fi
  echo '{"loggedIn": false}'; exit 1
fi
exec /bin/cat
`;
function setup(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  for (const id of [WORK, OTHER]) fs.mkdirSync(path.join(core.home, 'accounts/claude', id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts/claude', WORK, '.logged-in'), '');
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${WORK}"\nlabel = "회사"\n\n[[accounts]]\nagent = "claude"\nid = "${OTHER}"\nlabel = "개인"\n`);
}
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];
const card = (app: Page, id: string) => app.locator(`#s-accounts .acct-card[data-account="${id}"]`);
async function openClaude(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  await expect(card(app, WORK)).toBeVisible({ timeout: 15_000 });
}
async function startRename(app: Page) {
  // Ticket 450: the pencil beside the name, no menu to open first.
  await card(app, WORK).getByRole('button', { name: 'Rename Claude account 회사' }).click();
  const group = app.getByRole('group', { name: 'Rename 회사' });
  await expect(group.getByRole('textbox')).toBeFocused();
  await expect(group.getByRole('textbox')).toHaveValue('회사');
  return group;
}

test('accounts-rename: a running session keeps going and a new one opens under the new name, on the same folder', async ({ app, core }) => {
  setup(core);
  const project = core.project('alpha');
  const running = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'live', '--account', '회사').session as Session;
  await openWindow(app);
  await openClaude(app);
  const group = await startRename(app);
  await expect(app.getByText('Running sessions stay as they are. New sessions start under the new name.')).toBeVisible();
  await group.getByRole('textbox').fill('본사');
  await group.getByRole('button', { name: 'Save' }).click();
  await expect(card(app, WORK)).toContainText('본사');
  await expect(group).toHaveCount(0);
  expect(fs.readFileSync(path.join(core.home, 'accounts.toml'), 'utf8')).not.toContain('회사');
  await expect.poll(() => snap(core).find((s) => s.id === running.id)?.account).toBe('본사');
  expect(snap(core).find((s) => s.id === running.id)?.state).toBe('running');

  await closeSettings(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await dlg.getByRole('combobox').fill(project);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('combobox').fill('');
  await dlg.getByRole('option', { name: 'Claude · 본사' }).click();
  await expect.poll(() => snap(core).length).toBe(2);
  const fresh = snap(core).find((s) => s.id !== running.id)!;
  expect(fresh.account).toBe('본사');
  expect(fresh.config_dir).toBe(running.config_dir);
});

test('accounts-rename: a name another account has keeps Save off and says so; Cancel changes nothing', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openClaude(app);
  const group = await startRename(app);
  const save = group.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();
  // Typing right away replaces the old name, as in Finder: the field opens with it selected (real-app look 11-15).
  await app.keyboard.type('x');
  await expect(group.getByRole('textbox')).toHaveValue('x');
  await group.getByRole('textbox').fill('개인');
  await expect(save).toBeDisabled();
  await expect(app.getByText('An account with this name already exists.')).toBeVisible();
  await app.screenshot({ path: `../.scratch/shots/rename-dup-${test.info().project.name}.png` });
  await group.getByRole('textbox').fill('');
  await expect(save).toBeDisabled();
  await group.getByRole('button', { name: 'Cancel' }).click();
  await expect(card(app, WORK)).toContainText('회사');
  expect(fs.readFileSync(path.join(core.home, 'accounts.toml'), 'utf8')).toContain('회사');
});

// Owner 11-16: the agent's own account is "Default" and is renamed like an added one; the name is kept by the core's
// settings and shows on the row and in the new-session account picker.
test('rename: the pencil on the Default account renames it, on the row and in the new-session picker', async ({ app, core }) => {
  setup(core);
  const project = core.project('alpha');
  await openWindow(app);
  await openClaude(app);
  const own = card(app, 'own').first();
  await expect(own.locator('.acct-name')).toHaveText('Default');
  await own.getByRole('button', { name: 'Rename Claude account Default' }).click();
  const group = app.getByRole('group', { name: 'Rename Default' });
  await group.getByRole('textbox').fill('회사'); // an added account's name
  await expect(group.getByRole('button', { name: 'Save' })).toBeDisabled();
  await group.getByRole('textbox').fill('내 것');
  await group.getByRole('button', { name: 'Save' }).click();
  await expect(card(app, 'own').first().locator('.acct-name')).toHaveText('내 것');
  await expect(card(app, 'own').first().getByRole('button', { name: 'Rename Claude account 내 것' })).toBeVisible();
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features['accounts.own_label.claude']).toBe('내 것');
  expect(fs.readFileSync(path.join(core.home, 'accounts.toml'), 'utf8')).not.toContain('내 것');

  await closeSettings(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await dlg.getByRole('combobox').fill(project);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('combobox').fill('');
  await expect(dlg.getByRole('option', { name: 'Claude · 내 것' })).toBeVisible({ timeout: 15_000 });
});
