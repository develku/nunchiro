// A plugin is approved for its access (docs/plugins.md, Approval and the switch): after a change to its scripts alone
// the Plugins page keeps it approved and says it changed; after a change that adds access it asks again, and Review
// lists what is new. A real core, the example plugin from docs/api/examples without its check.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const EXAMPLE = path.resolve(import.meta.dirname, '../../docs/api/examples/plugins/quiet-hours');

function installApproved(core: Core) {
  const to = path.join(core.home, 'plugins/quiet-hours');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(EXAMPLE)) fs.copyFileSync(path.join(EXAMPLE, f), path.join(to, f));
  // Without its check: a plugin with a check asks again after any change (docs/plugins.md).
  const toml = path.join(to, 'plugin.toml');
  fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').split('[[gate]]')[0]);
  core.run(['plugin', 'allow', 'quiet-hours']);
  return to;
}
async function row(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="plugins"]').click();
  const r = app.locator('.plg[data-plugin="quiet-hours"]');
  await expect(r).toBeVisible();
  return r;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`plugin_change_that_adds_access_asks_again (${scheme})`, async ({ app, core }) => {
    const dir = installApproved(core);
    // Its script alone changes: still approved, and the row says it changed.
    fs.appendFileSync(path.join(dir, 'status.sh'), '# a comment\n');
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    let r = await row(app);
    await expect(r.locator('.chip').first()).toHaveText('Approved');
    await expect(r).toContainText('it asks for nothing new, so it stays approved');
    // Now it reaches a host: it asks again, and Review names what is new.
    const toml = path.join(dir, 'plugin.toml');
    fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace('show = "note"', 'show = "note"\nnetwork = ["example.com"]'));
    // The page reads the list again when it opens.
    await app.locator('.settings > nav button[data-page="general"]').click();
    await app.locator('.settings > nav button[data-page="plugins"]').click();
    r = app.locator('.plg[data-plugin="quiet-hours"]');
    await expect(r.locator('.chip').first()).toHaveText('Changed since approval');
    await r.getByRole('button', { name: 'Review Quiet hours' }).click();
    const added = app.locator('.ps [data-field="added"]');
    await expect(added).toContainText('New since you approved it:');
    await expect(added.locator('li')).toHaveText(['command status reaches example.com']);
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/plugins-access-${scheme}.png` });
  });
}

test('plugin_with_a_check_asks_again_after_a_script_change', async ({ app, core }) => {
  const to = path.join(core.home, 'plugins/quiet-hours');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(EXAMPLE)) fs.copyFileSync(path.join(EXAMPLE, f), path.join(to, f));
  core.run(['plugin', 'allow', 'quiet-hours']);
  fs.appendFileSync(path.join(to, 'status.sh'), '# a comment\n');
  await openWindow(app);
  const r = await row(app);
  await expect(r.locator('.chip').first()).toHaveText('Changed since approval');
  await expect(r).not.toContainText('it asks for nothing new');
});
