// Ticket 358, mock #acplogin against a real core and a fake ACP agent (crates/nunchiro-core/tests/fixtures/acp/signin_agent.py):
// the choice shows only what the agent reports, the link is the core's and only https, cancel returns the row, and sign-out
// appears only for an agent that advertises it.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, ownerOk, tomlEntry } from './acp-fakes';
import { openRow } from './accounts-rows';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const AGENT_PY = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/acp/signin_agent.py');

/** The clipboard as a recorder (WebKit has no clipboard-write permission). */
const recordClipboard = (app: Page) =>
  app.addInitScript(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
  });
const clip = (app: Page) => app.evaluate(() => (window as unknown as { __clip: string[] }).__clip);

/** An approved `acme` entry running the fixture with `modes`; its signed-in state is the returned file. */
function agent(core: Core, modes: string[]) {
  const state = path.join(core.home, 'acme.state');
  const cmd = path.join(core.home, 'bin/acme');
  fs.writeFileSync(cmd, `#!/bin/sh\n[ "$1" = --version ] && { echo 'acme 0.9.1'; exit 0; }\nexec /usr/bin/python3 ${AGENT_PY} ${state} ${modes.join(' ')} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(agentsToml(core), tomlEntry('acme', cmd));
  ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
  return state;
}
async function toRow(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'acme');
  return app.locator('#s-accounts .acct-agent[data-agent="acme"]');
}
async function open(app: Page) {
  await recordClipboard(app);
  await openWindow(app);
  return toRow(app);
}

test('acp_signin_methods: agent, terminal and env_var reported shows two choices', async ({ app, core }) => {
  agent(core, ['methods:agent,terminal,env']);
  const row = await open(app);
  const choice = row.getByRole('radiogroup', { name: 'Sign-in method' });
  await expect(choice.getByRole('radio')).toHaveCount(2);
  await expect(choice).toContainText('Agent login');
  await expect(choice).toContainText('Terminal');
  await expect(row).not.toContainText('API key');
});

test('acp_signin_methods: two agent methods take their reported names', async ({ app, core }) => {
  agent(core, ['methods:agent,agent2']);
  const row = await open(app);
  const choice = row.getByRole('radiogroup', { name: 'Sign-in method' });
  await expect(choice).toContainText('Sign in with Acme');
  await expect(choice).toContainText('Company SSO');
});

test('acp_signin_methods: one reported method shows no choice', async ({ app, core }) => {
  agent(core, ['methods:agent']);
  const row = await open(app);
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(row.locator('[data-field="acp-login"]')).toContainText('Agent login');
  await expect(row.getByRole('radiogroup')).toHaveCount(0);
});

test('acp_signin_actions: copy the link, then cancel returns the row to signed out', async ({ app, core }) => {
  const state = agent(core, ['methods:agent', 'link:https://acme.example/login?x=1', 'hold']);
  const row = await open(app);
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(row.locator('.prv-row')).toContainText('Signing in');
  await expect(row.locator('[data-field="acp-note"]')).toBeVisible();
  await row.getByRole('button', { name: 'Copy link' }).click();
  await expect.poll(() => clip(app)).toEqual(['https://acme.example/login?x=1']);
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
  await expect(row.locator('.prv-row')).toContainText('Needs sign-in');
  expect(fs.existsSync(state)).toBe(false);
});

test('acp_signin_actions: a link that is not https gets no copy button', async ({ app, core }) => {
  agent(core, ['methods:agent', 'link:http://acme.example/login']);
  const row = await open(app);
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(row.getByRole('alert')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
});

test('acp_signin_actions: sign-out only where the agent advertises it', async ({ app, core }) => {
  const state = agent(core, ['methods:agent', 'logout']);
  fs.writeFileSync(state, '');
  const row = await open(app);
  await expect(row.locator('.prv-row')).toContainText('Signed in');
  await row.getByRole('button', { name: 'Sign out' }).click();
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(fs.existsSync(state)).toBe(false);
});

test('acp_signin_actions: no sign-out for an agent that does not advertise it', async ({ app, core }) => {
  fs.writeFileSync(agent(core, ['methods:agent']), '');
  const row = await open(app);
  await expect(row.locator('.prv-row')).toContainText('Signed in');
  await expect(row.locator('[data-field="acp-login"]')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('acp_signin_methods: an agent that reports no method shows no sign-in', async ({ app, core }) => {
  const state = agent(core, []);
  fs.writeFileSync(state, '');
  const row = await open(app);
  await expect(row.locator('.prv-row')).toContainText('Signed in');
  await expect(row.locator('[data-field="acp-login"]')).toHaveCount(0);
  // Signed out, and the row reads it again on opening: the chip going back to Approved is that read arriving.
  fs.rmSync(state);
  await row.locator('.prv-row .prv-chv').click();
  await openRow(app, 'acme');
  await expect(row.locator('.prv-row')).not.toContainText('Signed in');
  await expect(row.locator('.prv-row')).toContainText('Approved');
  await expect(row.locator('[data-field="acp-login"]')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
});

test('acp_signin_actions: a first check with no answer on the login shows no alert', async ({ app, core }) => {
  fs.writeFileSync(agent(core, ['methods:agent', 'flaky-check']), '');
  let checks = 0;
  app.on('websocket', (ws) => ws.on('framereceived', (frame) => void (String(frame.payload).includes('"type":"acp_check"') && checks++)));
  const row = await open(app);
  await expect.poll(() => checks, { timeout: 15_000 }).toBeGreaterThan(0);
  await app.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(row.getByRole('alert')).toHaveCount(0);
});

test('acp_signin_methods: the row refreshes by itself when the terminal login tab ends', async ({ app, core }) => {
  const state = agent(core, ['methods:agent,terminal']);
  core.shell(core.project('demo'), 'alpha');
  const row = await open(app);
  await row.getByText('Terminal', { exact: true }).click();
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => fs.existsSync(state), { timeout: 15_000 }).toBe(true);
  await expect(row.locator('.prv-row')).toContainText('Signed in', { timeout: 15_000 });
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
});

test('acp_signin_actions: a reloaded window finds the running sign-in and can cancel it', async ({ app, core }) => {
  agent(core, ['methods:agent', 'link:https://acme.example/login?x=1', 'hold']);
  let row = await open(app);
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await app.reload();
  row = await toRow(app);
  await expect(row.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(row.locator('.prv-row')).toContainText('Signing in');
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('acp_signin_actions: a check that fails after the sign-in keeps the row and says so', async ({ app, core }) => {
  agent(core, ['methods:agent', 'logout', 'flaky-check']);
  const row = await open(app);
  await row.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(row.getByRole('alert')).toContainText('Could not read', { timeout: 15_000 });
  await expect(row.locator('[data-field="acp-login"]')).toBeVisible();
  await expect(row.locator('.prv-row')).toContainText('Signed in');
});
