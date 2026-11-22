// Ticket 521 item 1: Tab and Shift+Tab never leave the Settings window, on any page of its nav. Focus is sampled on every
// animation frame and after every key, so a leak that a timer repairs a moment later still fails.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { harness } from './theme-harness';
import { openSettings } from './settings-modal';

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });

/** Where focus sat outside the Settings window on any frame since the last call (empty when it never left). */
const leaks = (app: Page) =>
  app.evaluate(() => {
    const w = window as unknown as { __leaks: string[] };
    const panel = document.querySelector('.ovl-panel');
    const at = document.activeElement;
    if (panel && !panel.contains(at)) w.__leaks.push(at ? `${at.tagName.toLowerCase()}${at.className ? '.' + String(at.className).split(' ')[0] : ''}` : 'none');
    return w.__leaks.splice(0);
  });

test('settings_focus_walk_521: Tab and Shift+Tab stay in the Settings window on every page', async ({ app, core, browserName }) => {
  test.setTimeout(240_000);
  core.shell(core.project('demo'), 'alpha');
  // Artifact Libraries with its real controls (an auto-allow switch, a table with Remove buttons), as libs-settings.spec.ts seeds it.
  const entry = (o: Record<string, unknown>) => ({ sha384: '1'.repeat(96), sha512: 'b'.repeat(128), size: 1000, fetched_at: 1_761_600_000, badge: 'verified', first_requester: 'alpha', ...o });
  fs.mkdirSync(path.join(core.home, 'libs'), { recursive: true, mode: 0o700 });
  const entries = [
    entry({ host: 'cdnjs.cloudflare.com', path: '/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', library: 'Chart.js', version: '4.4.1', file: 'chart.umd.min.js' }),
    entry({ host: 'cdn.jsdelivr.net', path: '/npm/d3@7.9.0/dist/d3.min.js', library: 'd3', version: '7.9.0', file: 'dist/d3.min.js', badge: 'unverified' }),
  ];
  fs.writeFileSync(path.join(core.home, 'libs', 'libs.json'), JSON.stringify({ version: 1, entries, auto_allow: [] }), { mode: 0o600 });
  // The Theme gallery asks for the online index when Appearance opens: answered here, never the network.
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await app.addInitScript(() => {
    const w = window as unknown as { __leaks: string[] };
    w.__leaks = [];
    const sample = () => {
      const panel = document.querySelector('.ovl-panel');
      const at = document.activeElement;
      if (panel && !panel.contains(at)) w.__leaks.push(at ? `${at.tagName.toLowerCase()}${at.className ? '.' + String(at.className).split(' ')[0] : ''}` : 'none');
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await openWindow(app);
  await openSettings(app);
  const ids = await nav(app).locator('button[data-page]').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.page!));
  expect(ids.length).toBeGreaterThan(5);
  // WebKit's plain Tab skips buttons unless Full Keyboard Access is on; Option+Tab walks every control (ticket 478). Both run.
  const keys = browserName === 'webkit' ? ['Tab', 'Alt+Tab'] : ['Tab'];
  const found: string[] = [];
  for (const id of ids) {
    await nav(app).locator(`button[data-page="${id}"]`).click();
    await expect(nav(app).locator(`button[data-page="${id}"]`)).toHaveAttribute('aria-current', 'page');
    if (id === 'libraries') await expect(app.locator('tr[data-lib]')).toHaveCount(2);
    // One lap and a bit past the end: every control in the window, plus the wrap.
    const n = Math.min(120, (await app.locator('.ovl-panel').evaluate((p) => p.querySelectorAll('a[href], button, input, select, textarea, [tabindex]').length)) + 3);
    for (const key of keys) {
      // From the nav button and from the page title, where a click on the nav leaves focus (SettingsView's heading focus).
      for (const [from, start] of [['nav', nav(app).locator(`button[data-page="${id}"]`)], ['title', app.locator('.ovl-panel .phd h1')]] as const) {
        for (const dir of [key, `Shift+${key}`]) {
          await start.focus();
          await leaks(app);
          for (let i = 0; i < n; i++) {
            await app.keyboard.press(dir);
            const out = await leaks(app);
            if (out.length) {
              found.push(`${id} from ${from} ${dir} press ${i + 1}: ${[...new Set(out)].join(', ')}`);
              break;
            }
          }
        }
      }
    }
  }
  expect(found).toEqual([]);
});
