// Ticket 358 `358-provider-onoff` (threat 4): turning Codex off closes its row showing Off, takes it out of every new-session
// surface and does nothing to a Codex session already running. Its key then does nothing and says nothing.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { Session } from '../src/types';
import { openRow } from './accounts-rows';
import { publishFeatures } from '../src/settings/useFeatureSetting';
import { parse } from '../src/webwidgets/bridge';
import { expect, openWindow, test, type Core } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';
import { openWidget } from './schedules-seed';
import { openQuiet } from './tree-seed';
import { repo, show } from './visual/compare';

const fake = (status: string) => `#!/bin/sh
case "$1" in --version) echo "1.0.0"; exit 0;; esac
if [ "$1 $2" = "${status}" ]; then exit 3; fi
exec /bin/cat
`;
function setup(core: Core) {
  for (const [name, status] of [['claude', 'auth status'], ['codex', 'login status']]) fs.writeFileSync(path.join(core.home, 'bin', name), fake(status), { mode: 0o700 });
}
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];
async function openAccounts(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
}
async function newTab(app: Page) {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  return dlg;
}

test('accounts-provider-off: Codex off leaves every new-session surface and a running Codex session alone', async ({ app, core }) => {
  test.setTimeout(120_000);
  setup(core);
  const project = repo(core, 'nunchiro');
  const shell = core.shell(project, 'main');
  const running = core.cli('session', 'start', '--kind', 'codex', '--project', project, '--label', 'live codex').session as Session;
  openQuiet(core);
  await show(app, 'light');
  await openAccounts(app);
  await openRow(app, 'Codex');
  const codex = app.locator('#s-accounts .acct-agent[data-agent="codex"]');
  await codex.getByRole('switch', { name: 'Use Codex' }).click();
  await expect(codex.locator('.prv-exp')).toHaveCount(0); // the row closes
  await expect(codex.locator('[data-row="codex"]')).toContainText('Off');
  await app.screenshot({ path: `../.scratch/shots/onoff-${test.info().project.name}.png` });
  await closeSettings(app);

  let dlg = await newTab(app);
  await expect(dlg.getByRole('option', { name: /^Claude/ })).toHaveCount(1);
  await expect(dlg.getByRole('option', { name: /^Codex/ })).toHaveCount(0);
  await app.keyboard.press('Escape');

  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await expect(palette.locator('[data-command="session.new.claude"]')).toHaveCount(1);
  await expect(palette.locator('[data-command="session.new.codex"]')).toHaveCount(0);
  await app.keyboard.press('Escape');

  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  const worktree = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await worktree.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await worktree.getByRole('checkbox', { name: 'Start an agent here' }).check();
  await expect(worktree.getByRole('radio', { name: 'Claude' })).toBeVisible();
  await expect(worktree.getByRole('radio', { name: 'Codex' })).toHaveCount(0);
  await worktree.getByRole('button', { name: 'Cancel', exact: true }).click();

  await app.locator(`.tab[data-tab="${shell.id}"]`).click();
  await app.keyboard.press('Meta+KeyD');
  const chooser = app.getByRole('listbox', { name: 'Open in this split' });
  await expect(chooser.getByRole('option', { name: /^Claude/ })).toHaveCount(1);
  await expect(chooser.getByRole('option', { name: /^Codex/ })).toHaveCount(0);
  await app.keyboard.press('Escape');

  // Its key starts nothing and shows no new message.
  const before = snap(core).length;
  await app.keyboard.press('Shift+Meta+KeyO');
  await app.waitForTimeout(800);
  expect(snap(core).length).toBe(before);
  await expect(app.getByText(/Not started/)).toHaveCount(0);

  expect(snap(core).find((s) => s.id === running.id)?.state).toBe('running');
  core.run(['session', 'send-text', running.id, 'still here']);
  await expect.poll(() => core.read(running.id)).toContain('still here');

  await openAccounts(app);
  await codex.getByRole('switch', { name: 'Use Codex' }).check(); // ticket 391: the switch is in the head
  await closeSettings(app);
  dlg = await newTab(app);
  await expect(dlg.getByRole('option', { name: /^Codex/ })).toHaveCount(1);
});

const ALL_OFF = 'Claude and Codex are turned off in Settings > Accounts.';
async function turnOff(app: Page, ...names: string[]) {
  await openAccounts(app);
  for (const name of names) {
    await openRow(app, name);
    await app.locator(`#s-accounts .acct-agent[data-agent="${name.toLowerCase()}"]`).getByRole('switch', { name: `Use ${name}` }).click();
  }
}

test('accounts-provider-off: with every agent off the New tab and the worktree dialog say why, and no default can name one', async ({ app, core }) => {
  test.setTimeout(90_000);
  setup(core);
  core.shell(repo(core, 'nunchiro'), 'main');
  openQuiet(core);
  await show(app, 'light');
  await turnOff(app, 'Claude', 'Codex');
  // Ticket 391: the default agent is a select at the top of Providers; with both off it offers only Last used and the shell.
  await expect(app.getByRole('combobox', { name: 'Default agent' }).locator('option')).toHaveText(['Last used', 'Plain shell']);
  await closeSettings(app);

  const dlg = await newTab(app);
  await expect(dlg.getByRole('option', { name: /^(Claude|Codex)/ })).toHaveCount(0);
  await expect(dlg.getByText(ALL_OFF)).toBeVisible();
  await app.keyboard.press('Escape');

  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  const worktree = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await worktree.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await expect(worktree.getByRole('checkbox', { name: 'Start an agent here' })).toHaveCount(0);
  await expect(worktree.getByText(ALL_OFF)).toBeVisible();
});

test('accounts-provider-off: the schedule form leaves out an agent that is off', async ({ app, core }) => {
  setup(core);
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  await turnOff(app, 'Claude');
  // Ticket 993: the form is the Schedules widget's.
  await closeSettings(app);
  const widget = await openWidget(app);
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  const agent = widget.getByRole('combobox', { name: 'Agent' });
  await expect(agent.locator('option')).toHaveText(['Codex']);
  await expect(agent).toHaveValue('codex');
});

test('accounts-provider-off: a widget cannot start an agent that is off', () => {
  const act = (start: string) => parse({ nunchiro: 1, id: 1, method: 'act', params: { text: 'go', start } });
  publishFeatures({ 'agents.off': ['codex'] }, () => {}, false);
  expect(act('codex')).toEqual({ id: 1, error: 'codex is turned off in Settings > Accounts' });
  expect(act('claude')).toEqual({ id: 1, method: 'act', text: 'go', target: { start: 'claude' } });
  publishFeatures({}, () => {}, false);
});
