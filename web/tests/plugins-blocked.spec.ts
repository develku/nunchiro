// A plugin its catalogue's kill list names (docs/plugins.md, Browse and install): the Plugins page says it is blocked
// and why, it shows off, and its switch cannot turn it on. A real core; the list as the core keeps it after a read,
// so no test touches GitHub (crates/nunchiro-core/tests/plugins_online.rs reads one from a local origin).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const EXAMPLE = path.resolve(import.meta.dirname, '../../docs/api/examples/plugins/quiet-hours');
const ORIGIN = 'https://raw.githubusercontent.com/develku/nunchiro/';
const COMMIT = '534940ad7e016d5b40c26e648d401ace64a75981';

for (const scheme of ['light', 'dark'] as const) {
  test(`plugin_on_the_kill_list_is_blocked (${scheme})`, async ({ app, core }) => {
    const to = path.join(core.home, 'plugins/quiet-hours');
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(EXAMPLE)) fs.copyFileSync(path.join(EXAMPLE, f), path.join(to, f));
    core.run(['plugin', 'allow', 'quiet-hours']);
    fs.writeFileSync(path.join(core.home, 'plugins.json'), JSON.stringify({ on: ['quiet-hours'], installed: { 'quiet-hours': { commit: COMMIT, origin: ORIGIN } } }));
    fs.writeFileSync(path.join(core.home, 'plugin-kill-list.json'), JSON.stringify({ lists: { [ORIGIN]: [Date.now(), [{ id: 'quiet-hours', reason: 'It sent files to a stranger.' }]] } }));
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    await openSettings(app);
    await app.locator('.settings > nav button[data-page="plugins"]').click();
    const row = app.locator('.plg[data-plugin="quiet-hours"]');
    await expect(row.locator('.chip').first()).toHaveText('Blocked');
    await expect(row).toContainText('Its catalogue blocks it: It sent files to a stranger. It stays off.');
    const sw = row.getByRole('switch', { name: 'Turn Quiet hours on' });
    await expect(sw).not.toBeChecked();
    await expect(sw).toBeDisabled();
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/plugins-blocked-${scheme}.png` });
  });
}

test('a_refresh_that_blocks_a_plugin_says_so_once', async ({ app, core }) => {
  const to = path.join(core.home, 'plugins/quiet-hours');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(EXAMPLE)) fs.copyFileSync(path.join(EXAMPLE, f), path.join(to, f));
  core.run(['plugin', 'allow', 'quiet-hours']);
  fs.writeFileSync(path.join(core.home, 'plugins.json'), JSON.stringify({ on: ['quiet-hours'], installed: { 'quiet-hours': { commit: COMMIT, origin: ORIGIN } } }));
  // A list read just now that names nothing: no read starts while the test runs.
  fs.writeFileSync(path.join(core.home, 'plugin-kill-list.json'), JSON.stringify({ lists: { [ORIGIN]: [Date.now(), []] }, tried: { [ORIGIN]: Date.now() } }));
  await openWindow(app);
  // The next read names it: the window says so once.
  fs.writeFileSync(path.join(core.home, 'plugin-kill-list.json'), JSON.stringify({ lists: { [ORIGIN]: [Date.now(), [{ id: 'quiet-hours', reason: 'It sent files to a stranger.' }]] }, tried: { [ORIGIN]: Date.now() } }));
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(app.getByText('Quiet hours was turned off: its catalogue blocks it. It sent files to a stranger.')).toBeVisible();
});

test('a_plugin_that_was_off_is_not_told_it_was_turned_off', async ({ app, core }) => {
  const to = path.join(core.home, 'plugins/quiet-hours');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(EXAMPLE)) fs.copyFileSync(path.join(EXAMPLE, f), path.join(to, f));
  fs.writeFileSync(path.join(core.home, 'plugins.json'), JSON.stringify({ on: [], installed: { 'quiet-hours': { commit: COMMIT, origin: ORIGIN } } }));
  fs.writeFileSync(path.join(core.home, 'plugin-kill-list.json'), JSON.stringify({ lists: { [ORIGIN]: [Date.now(), []] }, tried: { [ORIGIN]: Date.now() } }));
  await openWindow(app);
  fs.writeFileSync(path.join(core.home, 'plugin-kill-list.json'), JSON.stringify({ lists: { [ORIGIN]: [Date.now(), [{ id: 'quiet-hours', reason: 'It sent files to a stranger.' }]] }, tried: { [ORIGIN]: Date.now() } }));
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(app.getByText('Quiet hours is blocked by its catalogue. It sent files to a stranger.')).toBeVisible();
  await expect(app.getByText(/was turned off/)).toHaveCount(0);
});
