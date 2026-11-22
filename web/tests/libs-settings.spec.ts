// V2-10c (needs 91, ticket 27c): Settings > Artifact libraries against a real core. The lockfile is seeded before the
// core first opens it (it reads `libs/libs.json` on the first libs op), so no fetch happens; Remove and the auto-allow
// switch are checked both as the frames the window sends and as the core's lockfile on disk.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const HOVER = "Not checked against cdnjs's published hashes: the file came from the host as is.";
const hex = (c: string, n: number) => c.repeat(n);
// Ticket 366: the core's DEFAULT_AUTO_ALLOW, in its order (crates/nunchiro-core/src/libs/mod.rs).
const DEFAULTS = ['Chart.js', 'd3', 'three.js', 'plotly.js', 'lodash.js', 'PapaParse', 'tone', 'KaTeX', 'highlight.js', 'marked', 'leaflet'];
const NOTE = 'On by default. Exact versions that match the manifest load without a card. When off, Nunchiro asks once.';
const entry = (o: Record<string, unknown>) => ({ sha512: hex('b', 128), size: 1000, fetched_at: 1_761_600_000, ...o });
const ENTRIES = [
  entry({ host: 'cdnjs.cloudflare.com', path: '/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', library: 'Chart.js', version: '4.4.1', file: 'chart.umd.min.js', sha384: hex('1', 96), badge: 'verified', first_requester: 'alpha' }),
  entry({ host: 'cdn.jsdelivr.net', path: '/npm/d3@7.9.0/dist/d3.min.js', library: 'd3', version: '7.9.0', file: 'dist/d3.min.js', sha384: hex('2', 96), sha512: hex('c', 128), badge: 'unverified', first_requester: '<b>beta</b>' }),
];

function seed(core: Core, lockfile: unknown) {
  const dir = path.join(core.home, 'libs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'libs.json'), JSON.stringify(lockfile), { mode: 0o600 });
}
const onDisk = (core: Core) => JSON.parse(fs.readFileSync(path.join(core.home, 'libs', 'libs.json'), 'utf8'));
/** Every libs op this window sends to the core. */
function sent(page: Page) {
  const ops: Record<string, unknown>[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const op = JSON.parse(f.payload)?.request;
      if (typeof op?.op === 'string' && op.op.startsWith('libs_')) ops.push(op);
    }),
  );
  return ops;
}
async function openLibraries(app: Page) {
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Artifact libraries', exact: true }).click(); // needs 192 (ticket 250): its own page again
  await expect(app.getByRole('heading', { level: 2, name: /^Artifact libraries/ })).toBeAttached(); // C19: screen-reader only, the page head shows it
}

test('libs_settings_lists_removes_and_switches_auto_allow: entries, Remove, the cdnjs-only switch, the set-aside notice, search', async ({ app, core }) => {
  // Version 2 with every default offered and none on: an owner who turned them all off (ticket 366 r2).
  seed(core, { version: 2, entries: ENTRIES, auto_allow: [], defaults_offered: DEFAULTS });
  const ops = sent(app);
  await openLibraries(app);
  const rows = app.locator('tr[data-lib]');
  await expect(rows).toHaveCount(2);
  // The draft's five columns; the file and the fetch day stay on the name's hover, the full host on its own.
  await expect(app.locator('.libs-table th')).toHaveCount(5);
  await expect(rows.nth(0).locator('td').nth(0)).toHaveText('Chart.js@4.4.1');
  await expect(rows.nth(0).locator('td').nth(0)).toHaveAttribute('title', new RegExp(`^chart\\.umd\\.min\\.js · ${new Date(1_761_600_000 * 1000).getFullYear()}`));
  await expect(rows.nth(0).locator('td').nth(1)).toHaveText('cdnjs');
  await expect(rows.nth(0).locator('td').nth(1)).toHaveAttribute('title', 'cdnjs.cloudflare.com');
  await expect(rows.nth(0).locator('.chip.ok')).toHaveText('Matches cdnjs');
  await expect(rows.nth(0)).toContainText('alpha');
  await expect(rows.nth(1).locator('td').nth(0)).toHaveText('d3@7.9.0');
  await expect(rows.nth(1).locator('.chip.warn')).toHaveText('Unverified');
  await expect(rows.nth(1).getByText('Unverified')).toHaveAttribute('title', HOVER);
  // A requester from page bytes is text.
  await expect(rows.nth(1)).toContainText('<b>beta</b>');
  expect(await rows.nth(1).locator('b').count()).toBe(0);
  await expect(app.locator('.sbody .conflict')).toHaveCount(0);

  // The switch is offered for cdnjs libraries only: the pinned Chart.js (also a default, ticket 366) and the other
  // defaults, all off in this lockfile; the jsDelivr d3 entry adds none.
  // needs 192 (ticket 250 r3): a row of the draft (the library left, the switch right).
  const switches = app.locator('.settings').getByRole('switch', { name: 'Auto-allow (cdnjs only): Chart.js', exact: true });
  await expect(app.locator('.settings').getByRole('switch')).toHaveCount(DEFAULTS.length);
  await expect(app.locator('.settings .srow').filter({ has: app.getByRole('switch', { name: 'Auto-allow (cdnjs only): Chart.js', exact: true }) })).toHaveText('Chart.jsDefaultCharts · On this Mac: 4.4.1'); // owner 2026-11-16: what it is for, and the versions held
  await expect(app.locator('#s-libs > .lede').last()).toHaveText(NOTE); // the rule, once above the card
  // Controlled by the core's answer: it turns on once the lockfile says so.
  await switches.click();
  await expect(switches).toBeChecked();
  await expect.poll(() => onDisk(core).auto_allow).toEqual([{ host: 'cdnjs.cloudflare.com', library: 'Chart.js' }]);

  await app.getByRole('button', { name: 'Remove d3 7.9.0' }).click();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => onDisk(core).entries.map((e: { library: string }) => e.library)).toEqual(['Chart.js']);
  expect(ops).toEqual([
    { op: 'libs_list' },
    { op: 'libs_auto_allow', host: 'cdnjs.cloudflare.com', library: 'Chart.js', on: true },
    { op: 'libs_remove', url: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js' },
  ]);
  // A default's switch stays with no entry left for it, on or off (ticket 366: the owner can turn it on again).
  await app.getByRole('button', { name: 'Remove Chart.js 4.4.1' }).click();
  await expect(rows).toHaveCount(0);
  await expect(app.getByRole('status').filter({ hasText: 'No libraries yet' })).toBeVisible();
  await expect(switches).toHaveCount(1);
  await switches.click();
  await expect(switches).not.toBeChecked();
  await expect(switches).toHaveCount(1);
  await expect.poll(() => onDisk(core).auto_allow).toEqual([]);

  // Found by the settings search.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('artifact lib');
  const found = app.getByRole('list', { name: 'Matching settings' }).getByRole('button');
  await expect(found).toHaveText(['Artifact libraries (fixed versions from a CDN, allowed automatically) · Artifact libraries']); // needs 192 (ticket 250): its own page again
  await found.click();
  await expect(app.locator('[data-setting="artifactLibs"]')).toBeFocused();
});

// Ticket 366: a fresh core starts with the default cdnjs libraries auto-allowed. Each is a row marked Default with its
// switch on; turning one off sends the window op, saves the rest, and keeps the row (off, still marked) to turn on again.
test('libs_settings_shows_the_default_set_366: defaults on and marked, one turned off stays listed', async ({ app, core }) => {
  const ops = sent(app);
  await openLibraries(app);
  const sw = (lib: string) => app.locator('.settings').getByRole('switch', { name: `Auto-allow (cdnjs only): ${lib}`, exact: true });
  const row = (lib: string) => app.locator('.settings .srow').filter({ has: app.getByRole('switch', { name: `Auto-allow (cdnjs only): ${lib}`, exact: true }) });
  await expect(app.locator('.settings').getByRole('switch')).toHaveCount(DEFAULTS.length);
  for (const lib of DEFAULTS) {
    await expect(sw(lib)).toBeChecked();
    await expect(row(lib).locator('.chip.libs-default')).toHaveText('Default');
    await expect(row(lib)).toContainText('Not fetched yet');
  }
  expect(DEFAULTS).not.toContain('mermaid');
  await expect(app.locator('tr[data-lib]')).toHaveCount(0);
  // Nothing on disk until a change: the defaults are the core's, not a seeded file.
  expect(fs.existsSync(path.join(core.home, 'libs', 'libs.json'))).toBe(false);

  await sw('d3').click();
  await expect(sw('d3')).not.toBeChecked();
  await expect(row('d3').locator('.chip.libs-default')).toHaveText('Default');
  await expect.poll(() => onDisk(core).auto_allow.map((a: { library: string }) => a.library)).toEqual(DEFAULTS.filter((l) => l !== 'd3'));
  await sw('d3').click();
  await expect(sw('d3')).toBeChecked();
  expect(ops).toEqual([
    { op: 'libs_list' },
    { op: 'libs_auto_allow', host: 'cdnjs.cloudflare.com', library: 'd3', on: false },
    { op: 'libs_auto_allow', host: 'cdnjs.cloudflare.com', library: 'd3', on: true },
  ]);
});

// Ticket 366: a cdnjs library outside the set has its switch and no mark. r2: this version 1 lockfile (from before the
// defaults) gets every default on once.
test('libs_settings_non_default_cdnjs_library_is_not_marked_366', async ({ app, core }) => {
  seed(core, { version: 1, entries: [entry({ host: 'cdnjs.cloudflare.com', path: '/ajax/libs/moment.js/2.30.1/moment.min.js', library: 'moment.js', version: '2.30.1', file: 'moment.min.js', sha384: hex('3', 96), badge: 'verified', first_requester: 'alpha' })], auto_allow: [] });
  await openLibraries(app);
  const moment = app.locator('.settings .srow').filter({ has: app.getByRole('switch', { name: 'Auto-allow (cdnjs only): moment.js', exact: true }) });
  await expect(moment).toHaveText('moment.jsAuto-allow exact versions that match the manifest · On this Mac: 2.30.1');
  await expect(moment.locator('.chip')).toHaveCount(0);
  await expect(app.locator('.settings').getByRole('switch')).toHaveCount(DEFAULTS.length + 1);
  for (const lib of DEFAULTS) await expect(app.locator('.settings').getByRole('switch', { name: `Auto-allow (cdnjs only): ${lib}`, exact: true })).toBeChecked();
  await expect(app.locator('.settings').getByRole('switch', { name: 'Auto-allow (cdnjs only): moment.js', exact: true })).not.toBeChecked();
});

test('libs_settings_set_aside_lockfile_shows_the_notice: a newer lockfile is left as it is and changes last until exit', async ({ app, core }) => {
  seed(core, { version: 3, entries: ENTRIES, auto_allow: [] });
  await openLibraries(app);
  await expect(app.locator('.sbody .conflict')).toHaveText('The library list on disk is broken or from a newer Nunchiro, so it was left as it is. Changes here last until Nunchiro quits.');
  await expect(app.locator('tr[data-lib]')).toHaveCount(0);
  expect(onDisk(core).version).toBe(3);
});
