// Ticket 391 follow-up H (real-app check 11-10): small copy and alignment on Providers. The checked time reads "Checked
// just now", the Check again icon keeps a gap from its word, the one model select is labelled "Model", and the
// Permission select starts where the other selects of New session defaults start. Fake agents only.
import fs from 'node:fs';
import path from 'node:path';
import { openRow } from './accounts-rows';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test('providers: Checked just now, a gap after the Check again icon, Model, and the selects of New session defaults in one column', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), `#!/bin/sh\ncase "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\nexit 1\n`, { mode: 0o700 });
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await expect(app.locator('[data-field="agents-checked"]')).toHaveText('Checked just now');
  const again = app.getByRole('button', { name: 'Check again' }).first();
  const gap = await again.evaluate((b) => b.querySelector('svg')!.getBoundingClientRect().right < [...b.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim()).map((n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().left; })[0] - 3);
  expect(gap, 'the icon keeps a gap from its word').toBe(true);

  await openRow(app, 'Claude');
  const defaults = app.locator('#s-accounts .acct-agent[data-agent="claude"] .prv-blk').filter({ hasText: 'New session defaults' });
  await expect(defaults.locator('[data-row="newDefaultModel"] .prv-k')).toHaveText('Model');
  const selects = defaults.locator('select');
  await expect(selects).toHaveCount(4);
  const lefts = await selects.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size, `select x: ${lefts.join(', ')}`).toBe(1);
});
