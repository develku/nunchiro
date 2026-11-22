// V2-10c round 2 (ticket 27c): the library card's "Asked by" names who asked, as the window already names it: a chat
// card and the Preview it opens name the session as the tree does; the Files view names "Files". A page's own
// <title> never leaks in. Real core and chat harness (as artifacts.spec.ts); the app's library commands are a
// stand-in on `window.__NUNCHIRO_LIBS__` that answers one card for any page and records Allow.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { installHost } from './fixtures/artifacts/cards/host';
import { append, chat, expect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { openFile, setup, view } from './fixtures/files/harness';
import { artifactServer } from './sandbox-server';

const URL1 = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const HOSTILE = 'Pat (owner)';
const page1 = `<!doctype html><html><head><title>${HOSTILE}</title><script src="${URL1}"></script></head><body><p>hello</p></body></html>`;

type Art = Awaited<ReturnType<typeof artifactServer>>;
const test = chatTest.extend<{ allowed: string[][] }, { art: Art }>({
  art: [
    async ({}, use) => {
      const art = await artifactServer({});
      await use(art);
      await art.close();
    },
    { scope: 'worker' },
  ],
  allowed: async ({ page }, use) => {
    const allowed: string[][] = [];
    await page.exposeFunction('__libAllow', (url: string, requester: string) => void allowed.push([url, requester]));
    await page.addInitScript((url) => {
      const w = window as unknown as { __libAllow: (u: string, r: string) => Promise<void> };
      const card = { url, host: 'cdnjs.cloudflare.com', library: 'Chart.js', version: '4.4.1', file: 'chart.umd.min.js', listed: true, auto: false, other_versions: [], message: 'not on this Mac yet', integrity: null };
      window.__NUNCHIRO_LIBS__ = {
        cards: async () => ({ cards: [card], refused: [], pinned: 0 }),
        openWith: async () => '',
        allow: (u, _i, r) => w.__libAllow(u, r),
        list: async () => ({ entries: [], auto_allow: [], defaults: [], saved: true }),
      };
    }, URL1);
    await use(allowed);
  },
});

/** Playwright scrolls a button into view before clicking, and a scroll re-arms the card (by design): scroll first,
 *  let it re-arm, then click. */
async function allow(scope: ReturnType<Page['locator']>, page: Page) {
  const b = scope.getByRole('button', { name: 'Allow', exact: true });
  await b.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  await expect(b).toBeEnabled();
  await b.click();
}
const asked = (scope: ReturnType<Page['locator']>) => scope.locator('.af-lib .af-lib-line').filter({ hasText: /^Asked by / });

test('libs_requester_chat_card_and_preview_name_the_session: never the page title', async ({ page, chatCore, art, allowed }) => {
  await installHost(page, art);
  const s = chatCore.chat('sales-bot');
  const full = path.join(s.cwd, 'site/index.html');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, page1);
  append(s.file, rec.user('차트 만들어줘'), rec.use('w1', 'Write', { file_path: full, content: page1 }), rec.result('w1', `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: page1, structuredPatch: [] } }));
  await openChat(page, s.id);
  const c = chat(page, s.id).locator('.acard[data-path="site/index.html"]');
  await expect(c).toHaveAttribute('data-state', 'ready');
  await expect(asked(c)).toHaveText('Asked by sales-bot');
  await expect(c.locator('.af-libs')).not.toContainText(HOSTILE);
  await allow(c, page);
  await expect.poll(() => allowed).toEqual([[URL1, 'sales-bot']]);
  // The Preview it opens follows the same session and names it the same way.
  await c.getByRole('button', { name: 'Open' }).click();
  const pv = page.locator('.preview .pv-frame');
  await expect(asked(pv)).toHaveText('Asked by sales-bot');
  await expect(pv.locator('.af-libs')).not.toContainText(HOSTILE);
});

test('libs_requester_files_view_names_files: never the page title', async ({ app: page, core, allowed }) => {
  await setup(page, core, { extra: (dir) => fs.writeFileSync(path.join(dir, 'chart.html'), page1) });
  await openFile(page, 'chart.html');
  const v = view(page, 'chart.html');
  await expect(asked(v)).toHaveText('Asked by Files');
  await expect(v.locator('.af-libs')).not.toContainText(HOSTILE);
  await allow(v, page);
  await expect.poll(() => allowed).toEqual([[URL1, 'Files']]);
});
