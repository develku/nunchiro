// Ticket 1021 (look v24 i): an approved ACP agent row with a long command line drew the command over its "Approved" and
// "Signed in" chips. The command takes the room left of the chips and ends in an ellipsis, its whole text in a title.
// Real core, fake agent only.
import fs from 'node:fs';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const ARGS = ['--experimental-acp', '--config=/opt/acme/Application Support/acme/profiles/work/acp-settings.json', '--log-file=/tmp/acme/acp-session-debug-output.log'];

for (const width of [1000, 1440]) {
  test(`acp row: a long command never sits under or over its chips at ${width} px`, async ({ app, core }) => {
    const cmd = fakeAcp(core, 'acme', 'acme 0.9.1');
    fs.writeFileSync(agentsToml(core), tomlEntry('acme', cmd, ARGS));
    ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
    await app.setViewportSize({ width, height: 900 });
    await openWindow(app);
    await openSettings(app);
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
    const head = app.locator('#s-accounts .acct-agent[data-agent="acme"] .prv-hd');
    await expect(head.locator('.prv-chips')).toContainText('Approved', { timeout: 15_000 });
    const line = head.locator('.prv-meta code');
    const text = await line.evaluate((e) => {
      // The drawn text, not the box: a text overflowing visibly is what covered the chips.
      const r = e.getBoundingClientRect();
      const drawn = getComputedStyle(e).overflowX === 'visible' ? r.left + e.scrollWidth : r.right;
      return { left: r.left, right: drawn, top: r.top, bottom: r.bottom };
    });
    const chips = await head.locator('.prv-chips .pchip').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(text.right <= c.left || text.bottom <= c.top || text.top >= c.bottom, `command ${JSON.stringify(text)} vs chip ${JSON.stringify(c)}`).toBe(true);
    expect(await line.evaluate((e) => getComputedStyle(e).textOverflow)).toBe('ellipsis');
    // The whole command stays readable in the title.
    await expect(line).toHaveAttribute('title', (await line.textContent())!);
  });
}
