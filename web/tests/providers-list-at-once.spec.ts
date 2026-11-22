// Ticket 991 C10: Settings > Providers showed Claude and Codex alone for a second, then the agents from agents.toml popped
// in. The card's rows now come in together: every frame shows either no agent row (a Checking line) or all of them.
import fs from 'node:fs';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('providers_rows_at_once_C10: the agents card never shows part of its rows', async ({ app, core }) => {
  fs.writeFileSync(agentsToml(core), tomlEntry('acme', fakeAcp(core, 'acme', 'acme 0.9.1', [])));
  ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
  await app.addInitScript(() => {
    const seen = new Set<number>();
    (window as unknown as { __rows: Set<number> }).__rows = seen;
    new MutationObserver(() => {
      const card = document.querySelector('#s-accounts .prv-sec .prv-card');
      if (card) seen.add(card.querySelectorAll(':scope > .acct-agent').length);
    }).observe(document, { subtree: true, childList: true });
  });
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.locator('#s-accounts .acct-agent[data-agent="acme"]')).toBeVisible();
  const counts = await app.evaluate(() => [...(window as unknown as { __rows: Set<number> }).__rows]);
  expect(counts.filter((n) => n > 0)).toEqual([3]);
});
