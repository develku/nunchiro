// Ticket 391 follow-up K (real-app check 11-10): Settings > Onboarding's Providers step lists agents only. OpenRouter, GLM
// and Kimi are API-key services run through another agent, not agents, so they get no card there. The Onboarding nav item
// has its own icon, not General's gear. Fake agents only.
import fs from 'node:fs';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('onboarding: the Providers step shows the ACP agent and no card for the OpenRouter service it runs', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'opencode', '1.4.0');
  fs.writeFileSync(agentsToml(core), [tomlEntry('opencode', cmd), tomlEntry('openrouter', cmd, ['acp'], ['OPENROUTER_API_KEY'])].join('\n'));
  for (const name of ['opencode', 'openrouter']) ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Onboarding' }).click();
  await app.locator('.ob-step[data-step="providers"]').click();
  const panel = app.locator('.ob-panel[data-panel="providers"]');
  await expect(panel.locator('[data-agent="opencode"]')).toBeVisible();
  await expect(panel.locator('[data-agent="openrouter"]')).toHaveCount(0);
});

test('onboarding: its nav item draws its own icon, not the gear of General', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  const icon = (name: string) => nav.getByRole('button', { name, exact: true }).locator('svg').evaluate((s) => s.innerHTML);
  expect(await icon('Onboarding')).not.toBe(await icon('General'));
});
