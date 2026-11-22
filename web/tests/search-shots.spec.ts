// Screenshots of the Search sidebar (hits, no matches, truncated, opened at a line) and the gallery card, light and
// dark (not assertions; no R8 frame exists for Search). Run with SHOTS=1.
import fs from 'node:fs';
import path from 'node:path';
import { expect, REPO, test } from './fixtures';
import { view } from './fixtures/files/harness';
import { hit, hits, search, setup, status } from './fixtures/search/harness';

const OUT = path.join(REPO, '.scratch/shots');

test('search screens', async ({ app, core }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  fs.mkdirSync(OUT, { recursive: true });
  await setup(app, core, { direct: true, extra: (d) => fs.writeFileSync(path.join(d, 'many.txt'), 'pin\n'.repeat(250)) });
  for (const theme of ['light', 'dark']) {
    await app.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await search(app, 'needle');
    await expect(hits(app)).toHaveCount(7);
    await app.screenshot({ path: path.join(OUT, `search-1-hits-${theme}.png`) });
    await hit(app, 'src/app.ts', 6).click();
    await expect(view(app, 'src/app.ts').locator('.cm-target')).toBeVisible();
    await app.screenshot({ path: path.join(OUT, `search-2-open-${theme}.png`) });
    await search(app, 'nothing-matches-this');
    await expect(status(app)).toHaveText('No matches');
    await app.screenshot({ path: path.join(OUT, `search-3-empty-${theme}.png`) });
    await search(app, 'pin');
    await expect(hits(app)).toHaveCount(200);
    await app.screenshot({ path: path.join(OUT, `search-4-truncated-${theme}.png`) });
  }
  await app.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await app.locator('nav[data-bar="right"] .lay').click();
  await expect(app.locator('.lcard[data-card="search"]')).toBeVisible();
  await app.screenshot({ path: path.join(OUT, 'search-5-gallery.png') });
});
