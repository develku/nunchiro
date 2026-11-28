// Settings > Plugins, Browse plugins (docs/plugins.md, Browse and install): the catalogue lists the repository's own
// plugins/catalog.json; Install puts the plugin in the list off and not approved, and its catalogue row says Installed;
// a newer catalogue version says Update. The `catalog` and `install` frames are answered by the test, so no test
// touches GitHub (crates/nunchiro-core/tests/plugins_online.rs covers the download and the hash checks against a local
// origin): an install copies the example's files into the real core's home, as the core does after its checks, and
// asks the real core for the list.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/catalog.json'), 'utf8')).plugins as { id: string; version: string; dir: string; files: { path: string }[] }[];

async function harness(app: Page, core: Core, version?: string) {
  const ops: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      const action = frame?.request?.op === 'plugin' ? frame.request.action : null;
      if (action?.do === 'catalog') {
        ops.push('catalog');
        const catalog = CATALOG.map((e) => ({ ...e, version: version ?? e.version }));
        return ws.send(JSON.stringify({ id: frame.id, response: { Ok: { type: 'plugin_catalog', catalog } } }));
      }
      if (action?.do === 'install') {
        ops.push(`install ${action.id}`);
        const e = CATALOG.find((x) => x.id === action.id)!;
        const to = path.join(core.home, 'plugins', e.id);
        fs.mkdirSync(to, { recursive: true });
        for (const f of e.files) fs.copyFileSync(path.join(ROOT, e.dir, f.path), path.join(to, f.path));
        return server.send(JSON.stringify({ ...frame, request: { op: 'plugin', action: { do: 'list' } } }));
      }
      server.send(m);
    });
  });
  return ops;
}
async function page(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="plugins"]').click();
  await app.getByRole('button', { name: 'Browse plugins' }).click();
  const browse = app.locator('.plg-browse');
  await expect(browse).toBeVisible();
  return browse;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`plugins_browse_and_install (${scheme})`, async ({ app, core }) => {
    const ops = await harness(app, core);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const browse = await page(app);
    await expect(browse).toContainText('Quiet hours');
    await expect(browse).toContainText('1 panel · 1 command · 2 settings · 1 check · 0.1.0 · Nunchiro examples · no network');
    await browse.getByRole('button', { name: 'Install Quiet hours' }).click();
    // Installed: in the list, off and not approved; the catalogue row says so.
    const listed = app.locator('.plg[data-plugin="quiet-hours"]');
    await expect(listed).toContainText('Not approved');
    await expect(listed.getByRole('switch', { name: 'Turn Quiet hours on' })).not.toBeChecked();
    await expect(browse.getByText('Installed', { exact: true })).toBeVisible();
    expect(ops).toEqual(['catalog', 'install quiet-hours']);
    expect(fs.existsSync(path.join(core.home, 'plugins/quiet-hours/plugin.toml'))).toBe(true);
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/plugins-browse-${scheme}.png` });
  });
}

test('plugins_browse_offers_update_for_a_newer_version', async ({ app, core }) => {
  await harness(app, core, '9.0.0');
  const to = path.join(core.home, 'plugins/quiet-hours');
  fs.mkdirSync(to, { recursive: true });
  for (const f of CATALOG[0].files) fs.copyFileSync(path.join(ROOT, CATALOG[0].dir, f.path), path.join(to, f.path));
  await openWindow(app);
  const browse = await page(app);
  await expect(browse.getByRole('button', { name: 'Update Quiet hours' })).toBeVisible();
});
