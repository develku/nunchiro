// Ticket 358 mock #acpmodels, against a real core and the fake ACP agent: an agent's own models are listed with switches, an
// off model leaves that agent's choices and stays off after a restart of the window, and a pick reaches the agent.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { openRow } from './accounts-rows';
import { expect, openWindow, test, type Core } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

function approved(core: Core, modes: string[] = [], delay = 0) {
  fs.writeFileSync(agentsToml(core), tomlEntry('acme', fakeAcp(core, 'acme', 'acme 0.9.1', modes, delay)));
  ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
}
const startAgent = (core: Core) => ownerOk(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: ['acme'], model: null, effort: null, resume: null } }).session.id as string;
async function toRow(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'acme');
  return app.locator('#s-accounts .acct-agent[data-agent="acme"]');
}
const sent = (core: Core) =>
  fs
    .readFileSync(path.join(core.home, 'acme.log'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('session/set_config_option'))
    .map((l) => JSON.parse(l).params as { configId: string; value: string });
const modelChip = (app: Page) => app.locator('[data-picker="model"]');
const openTab = (app: Page) => app.locator('.tab[data-tab]:not([data-tab="settings"])').first().click();

test('acp_models: the list shows with switches, an off model stays off after a restart and leaves the choices', async ({ app, core }) => {
  approved(core);
  startAgent(core);
  await openWindow(app);
  let row = await toRow(app);
  const models = row.locator('[data-field="models"]');
  await expect(models).toContainText('On 2/2');
  await expect(models.locator('.prv-mr')).toHaveCount(2);
  await expect(models.locator('.prv-mr').first()).toContainText('fast');
  await models.getByRole('switch', { name: 'Smart' }).click();
  await expect(models).toContainText('On 1/2');
  await expect(models.locator('.prv-mr.off')).toContainText('smart');

  await app.reload();
  await openWindow(app);
  row = await toRow(app);
  await expect(row.locator('[data-field="models"]')).toContainText('On 1/2');
  await expect(row.getByRole('switch', { name: 'Smart' })).not.toBeChecked();

  await closeSettings(app);
  await openTab(app);
  await expect(modelChip(app)).toContainText('Fast');
  await modelChip(app).click();
  const menu = app.locator('[data-menu="model"]');
  await expect(menu.getByRole('menuitemradio')).toHaveText(['Fast✓1']) // W35: name, tick, digit;
  // W35 mockup 2 (ticket 994): an ACP agent that listed thought levels has the effort chip, with its level.
  await expect(app.locator('[data-picker="effort"]')).toContainText('High');
  expect(sent(core)).toEqual([]);
});

test('acp_models: picking a model sends the value the agent reported', async ({ app, core }) => {
  approved(core);
  startAgent(core);
  await openWindow(app);
  await openTab(app);
  await modelChip(app).click();
  await app.locator('[data-menu="model"]').getByRole('menuitemradio', { name: 'Smart' }).click();
  await expect(modelChip(app)).toContainText('Smart');
  expect(sent(core)).toEqual([expect.objectContaining({ configId: 'model', value: 'smart' })]);
});

// WebKit flake (lane w83, 1 in 6; here 2 in 20): the page read the list once, before a just-started agent reported it.
test('acp_models: a list the agent reports after the page opened shows without reopening it', async ({ app, core }) => {
  approved(core, [], 2);
  startAgent(core);
  await openWindow(app);
  const row = await toRow(app);
  await expect(row.locator('[data-field="models"]')).toHaveCount(0); // not reported yet
  await expect(row.locator('[data-field="models"]')).toContainText('On 2/2', { timeout: 15_000 });
});

test('acp_models: a long list turned all off stays all off after a reload (over 4096 bytes)', async ({ app, core }) => {
  approved(core, ['many:150']);
  startAgent(core);
  await openWindow(app);
  let models = (await toRow(app)).locator('[data-field="models"]');
  await expect(models).toContainText('On 152/152');
  await models.getByRole('button', { name: 'Turn all off' }).click();
  await expect(models).toContainText('On 0/152');
  // The case this guards: one stored value well past the core's 4096-byte feature limit.
  const bytes = await app.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('nunchiro.settings.v1')!).features['agents.models_off']).length);
  expect(bytes).toBeGreaterThan(4096);
  await expect(models.getByRole('alert')).toHaveCount(0);

  await app.reload();
  await openWindow(app);
  models = (await toRow(app)).locator('[data-field="models"]');
  await expect(models).toContainText('On 0/152');
  await expect(models.getByRole('switch', { name: 'Long model 149' })).not.toBeChecked();
});

test('acp_models: the chip shows the running model when the agent listing fails', async ({ app, core }) => {
  approved(core);
  startAgent(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'acp_agents') return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'listing refused' } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await openTab(app);
  await expect(modelChip(app)).toContainText('fast');
  await modelChip(app).click();
  await expect(app.locator('[data-menu="model"]').getByRole('menuitemradio')).toHaveText(['fast✓1']);
  await expect(app.locator('.pk-msg')).toContainText('listing refused');
  expect(sent(core)).toEqual([]);
});

test('acp_models: an agent that reports none has no section and no chip', async ({ app, core }) => {
  approved(core, ['nomodels']);
  startAgent(core);
  await openWindow(app);
  const row = await toRow(app);
  await expect(row.getByText('Command')).toBeVisible();
  await expect(row.locator('[data-field="models"]')).toHaveCount(0);
  await closeSettings(app);
  await openTab(app);
  await expect(modelChip(app)).toHaveCount(0);
});
