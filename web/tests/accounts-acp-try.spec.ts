// An approved ACP agent's row in Settings > Accounts: "Send a test message" sends one fixed sentence, shows the answer and
// the receipt, and the row's chip says when it last answered. Against a real core and the fake ACP agent
// (crates/nunchiro-core/tests/fixtures/acp/fake_agent.py); mockup docs/design/agent-kinds-m7/index.html, section 3.
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { openRow } from './accounts-rows';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

function approved(core: Core, modes: string[] = []) {
  const cmd = fakeAcp(core, 'acme', 'acme 0.9.1', modes);
  fs.writeFileSync(agentsToml(core), tomlEntry('acme', cmd));
  ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
}
async function row(app: Parameters<typeof openWindow>[0]) {
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  return app.locator('#s-accounts .acct-agent[data-agent="acme"]');
}

test('acp_try: a test message answers, the receipt shows, the chip reads Answered today', async ({ app, core }) => {
  approved(core);
  const r = await row(app);
  await expect(r.locator('.prv-row')).toContainText('Not tried');
  await openRow(app, 'acme');
  const test = r.locator('[data-field="acp-try"]');
  await expect(test).toContainText('Reply with the one word: ready.');
  await test.getByRole('button', { name: 'Send a test message' }).click();
  await expect(test).toContainText('Answered “ready” in');
  await expect(test).toContainText('Message sent · answer read · turn ended · acme 0.9.1');
  await expect(r.locator('.prv-row')).toContainText('Answered today');
  expect(fs.readFileSync(path.join(core.home, 'acme.log'), 'utf8')).toContain('Reply with the one word: ready.');
});

test('acp_try: an error result is one failure sentence and the chip reads Test failed', async ({ app, core }) => {
  approved(core, ['try-error']);
  const r = await row(app);
  await openRow(app, 'acme');
  const test = r.locator('[data-field="acp-try"]');
  await test.getByRole('button', { name: 'Send a test message' }).click();
  await expect(test).toContainText('quota exceeded');
  await expect(test.getByRole('button', { name: 'Send again' })).toBeVisible();
  await expect(r.locator('.prv-row')).toContainText('Test failed');
});

test('acp_try: nothing is sent without the click', async ({ app, core }) => {
  approved(core);
  const r = await row(app);
  await openRow(app, 'acme');
  await expect(r.locator('[data-field="acp-try"]')).toBeVisible();
  await app.waitForTimeout(500);
  expect(fs.existsSync(path.join(core.home, 'acme.log')) && fs.readFileSync(path.join(core.home, 'acme.log'), 'utf8').includes('session/prompt')).toBe(false);
});
