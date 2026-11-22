// Accounts probe 11-10 (ticket 391 follow-up D, real-app check 11-10): under Connection & sign-in of an ACP card the line
// says what the button beside it does, in each of its three states: Sign in (by the chosen method), Cancel while a sign-in
// runs, and nothing to do once signed in (or what Sign out runs). It never only states the state. Real core, a fake ACP agent
// (crates/nunchiro-core/tests/fixtures/acp/signin_agent.py).
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, ownerOk, tomlEntry } from './acp-fakes';
import { openRow } from './accounts-rows';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const AGENT_PY = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/acp/signin_agent.py');
/** An approved `acme` entry running the fixture with `modes`; its signed-in state is the returned file. */
function agent(core: Core, modes: string[]) {
  const state = path.join(core.home, 'acme.state');
  const cmd = path.join(core.home, 'bin/acme');
  fs.writeFileSync(cmd, `#!/bin/sh\n[ "$1" = --version ] && { echo 'acme 0.9.1'; exit 0; }\nexec /usr/bin/python3 ${AGENT_PY} ${state} ${modes.join(' ')} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(agentsToml(core), tomlEntry('acme', cmd));
  ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
  return state;
}
async function open(app: Page) {
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'acme');
  return app.locator('#s-accounts .acct-agent[data-agent="acme"]');
}
const what = (row: ReturnType<Page['locator']>) => row.locator('[data-field="acp-login-what"]');

test('acp sign-in line: signed out it says what Sign in does; while signing in, what Cancel does', async ({ app, core }) => {
  agent(core, ['methods:agent', 'link:https://acme.example/login', 'hold']);
  const row = await open(app);
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(what(row)).toHaveText('Sign in asks acme to start its own login, usually in your browser.');
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(what(row)).toHaveText('Cancel stops this sign-in; acme stays signed out.');
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(what(row)).toHaveText('Sign in asks acme to start its own login, usually in your browser.');
});

test('acp sign-in line: signed in there is nothing to do, and with Sign out it says what that runs', async ({ app, core }) => {
  fs.writeFileSync(agent(core, ['methods:agent']), '');
  const row = await open(app);
  await expect(row.locator('.prv-row')).toContainText('Signed in', { timeout: 15_000 });
  await expect(what(row)).toHaveText('Nothing to do: acme is already signed in with its own login; Nunchiro keeps no password or key.');
});

test('acp sign-in line: signed in with Sign out offered, the line names what Sign out runs', async ({ app, core }) => {
  fs.writeFileSync(agent(core, ['methods:agent', 'logout']), '');
  const row = await open(app);
  await expect(row.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15_000 });
  await expect(what(row)).toHaveText("Nothing to do: acme is already signed in. Sign out runs acme's own sign-out.");
});
