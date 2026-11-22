// V2-10c (needs 91, ticket 27c): the library approval card in the artifact frame bar. Playwright cannot load the app's
// scheme, so fixtures/libs/server.ts stands in for the app (27b: rewrite, `/lib/`, the contract's CSP shape) and the
// core (27a: Allow fetches once from a loopback origin). The harness page is sandbox.spec.ts's; the card's seams
// (`LibsBridge`) are injected inside the page and record every call here. No real CDN is contacted.
import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { harnessServer } from './sandbox-server';
import { CHART_STUB, libServer, type LibServer } from './fixtures/libs/server';
import type { LibCard, LibCards } from '../src/sandbox/libs';

const CDN = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|cdn\.tailwindcss\.com/;
const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js';
const V1 = `${LIB}/4.4.1/chart.umd.min.js`;
const V2 = `${LIB}/4.4.2/chart.umd.min.js`;
const REASON = 'Same CDN and exact-version rule as Claude.ai artifacts';
const HOVER = "Not checked against cdnjs's published hashes: the file came from the host as is.";

/** A page that draws with Chart when it loaded, and says which bytes it got. */
const chartPage = (...srcs: string[]) => `<!doctype html><html><head><title>chart</title>
${srcs.map((s) => `<script src="${s}"></script>`).join('\n')}</head>
<body><canvas id="c" width="200" height="80"></canvas>
<script>var r;try{new Chart(document.getElementById("c"),{});r="chart "+Chart.drawn}catch(e){r="no chart"}parent.postMessage({type:"fixture",result:r},"*")</script>
</body></html>`;

type Shared = { srv: LibServer; harness: Awaited<ReturnType<typeof harnessServer>> };
type Call = [string, ...unknown[]];
type Box = {
  srv: LibServer;
  calls: Call[];
  /** CDN requests that really left the page (answered by a route, which never reaches the network). */
  remote: string[];
  /** Replaces the stand-in's card list (hostile names, many cards, auto-allow). */
  override: ((id: string, hash: string, n: number) => LibCards | Promise<LibCards>) | null;
  mount: (text: string, extra?: Record<string, unknown>) => Promise<{ id: string; hash: string }>;
  results: () => Promise<string[]>;
  msgs: (type: string) => Promise<any[]>;
  ops: () => string[];
};

const test = base.extend<{ box: Box }, { shared: Shared }>({
  shared: [
    async ({}, use) => {
      const srv = await libServer();
      const harness = await harnessServer(srv.origin);
      await use({ srv, harness });
      await harness.close();
      await srv.close();
    },
    { scope: 'worker' },
  ],
  box: async ({ page, shared }, use) => {
    const srv = shared.srv;
    srv.reset();
    const calls: Call[] = [];
    const remote: string[] = [];
    await page.route(CDN, (route) => {
      const url = route.request().url();
      remote.push(url);
      return route.fulfill({ contentType: 'text/javascript', body: url.includes('Chart.js') ? CHART_STUB : 'window.OTHER="loaded"' });
    });
    let n = 0;
    const box: Box = {
      srv,
      calls,
      remote,
      override: null,
      async mount(text, extra = {}) {
        const a = srv.set(`a${Math.random().toString(36).slice(2, 8)}`, text);
        await page.evaluate(
          ({ p, always }) => {
            const w = window as any;
            w.__mount({
              ...p,
              ...(always ? { onAlwaysAllow: () => w.__messages.push({ type: 'always' }) } : {}),
              libs: {
                cards: (id: string, hash: string) => w.__libCards(id, hash),
                openWith: (id: string, hash: string, url: string, sha: string) => w.__libOpenWith(id, hash, url, sha),
                allow: (url: string, integrity: string | null, requester: string) => w.__libAllow(url, integrity, requester),
                list: () => w.__libList(),
              },
            });
          },
          { p: { artifact: a, origin: srv.origin, ...extra, always: undefined }, always: !!extra.always },
        );
        return a;
      },
      msgs: (type) => page.evaluate((t) => (window as any).__messages.filter((m: any) => m?.type === t), type),
      results: async () => (await box.msgs('fixture')).map((m) => m.result),
      ops: () => calls.map((c) => c[0]),
    };
    await page.exposeFunction('__libCards', async (id: string, hash: string) => {
      calls.push(['cards', id, hash]);
      return box.override ? box.override(id, hash, n++) : srv.cards(id, hash);
    });
    await page.exposeFunction('__libOpenWith', (id: string, hash: string, url: string, sha: string) => {
      calls.push(['openWith', id, hash, url, sha]);
      return srv.openWith(id, hash, url, sha);
    });
    await page.exposeFunction('__libAllow', async (url: string, integrity: string | null, requester: string) => {
      calls.push(['allow', url, integrity, requester]);
      await srv.allow(url);
    });
    await page.exposeFunction('__libList', () => {
      calls.push(['list']);
      return { entries: srv.entries(), auto_allow: [], saved: true };
    });
    await page.exposeFunction('__grant', (id: string, hash: string) => {
      calls.push(['grant', id, hash]);
      srv.grant(id, hash);
    });
    await page.goto(shared.harness.url);
    await use(box);
    await srv.stopCdn();
  },
});

const card = (o: Partial<LibCard> = {}): LibCard => ({
  url: V1,
  host: 'cdnjs.cloudflare.com',
  library: 'Chart.js',
  version: '4.4.1',
  file: 'chart.umd.min.js',
  listed: false,
  auto: false,
  other_versions: [],
  message: '`Chart.js` `4.4.1` is not on this Mac yet. Allow it to fetch it once; until then nothing is fetched.',
  integrity: null,
  ...o,
});
const libs = (page: Page) => page.locator('.af-lib');
const panel = (page: Page) => page.getByRole('region', { name: 'Libraries' });

test('card_shows_library_version_host_session_reason_and_what_leaves: every part as text, a hostile name stays text', async ({ page, box }) => {
  const hostile = '<img src=x onerror="parent.__pwned=1">';
  box.override = () => ({ cards: [card({ library: hostile, file: '<b>dist/chart.js</b>' })], refused: [], pinned: 0 });
  await box.mount(chartPage(V1), { requester: '<i>build-bot</i>', title: 'Sales chart' });
  const c = libs(page);
  await expect(c).toHaveCount(1);
  await expect(c).toContainText(`${hostile} 4.4.1`);
  await expect(c).toContainText('<b>dist/chart.js</b> · cdnjs.cloudflare.com');
  await expect(c).toContainText('Asked by <i>build-bot</i>');
  await expect(c).toContainText(REASON);
  await expect(c).toContainText('Only this library request goes to cdnjs.cloudflare.com: your IP and the URL. Nothing from the page is sent.');
  await expect(c).toContainText('is not on this Mac yet. Allow it to fetch it once; until then nothing is fetched.');
  await expect(c.getByRole('button')).toHaveText(['Allow', "Don't allow"]);
  // Rendered as text: no element came from the page's strings, nothing ran.
  expect(await panel(page).locator('img, b, i').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  // Without a requester the card never names the page's own title (page-controlled), and Allow sends no requester.
  box.override = () => ({ cards: [card()], refused: [], pinned: 0 });
  await box.mount(chartPage(V1), { title: 'Pat (owner)' });
  await expect(libs(page)).toContainText('Asked by a page not opened from a session');
  await expect(libs(page)).not.toContainText('Pat (owner)');
  await libs(page).getByRole('button', { name: 'Allow', exact: true }).click();
  await expect.poll(() => box.calls.filter((c) => c[0] === 'allow')).toEqual([['allow', V1, null, '']]);
});

test('allow_is_armed_after_the_card_appears_or_moves: a click already on its way cannot answer a card that just showed', async ({ page, box }) => {
  const twelve = Array.from({ length: 12 }, (_, i) => card({ url: `${LIB}/4.4.${i}/chart.umd.min.js`, version: `4.4.${i}` }));
  box.override = () => ({ cards: twelve, refused: [], pinned: 0 });
  await box.mount(chartPage(V1));
  const allow = libs(page).first().getByRole('button', { name: 'Allow', exact: true });
  await expect(libs(page)).toHaveCount(8);
  // At once: not armed (a page that shrinks itself to open the panel under the pointer gets nothing from the click).
  await expect(allow).toBeDisabled({ timeout: 300 });
  await expect(allow).toBeEnabled();
  // Answering one slides the next card in: every card re-arms.
  await libs(page).first().getByRole('button', { name: "Don't allow" }).click();
  await expect(libs(page).first().getByRole('button', { name: 'Allow', exact: true })).toBeDisabled({ timeout: 300 });
  await expect(libs(page).first().getByRole('button', { name: 'Allow', exact: true })).toBeEnabled();
  // A scroll anywhere (chat follow mode as the page grows) re-arms the same cards.
  await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
  await expect(allow).toBeDisabled({ timeout: 300 });
  await expect(allow).toBeEnabled();
  // A shift with no scroll event: the click lands on a moved panel, sends nothing and re-arms.
  await page.evaluate(() => ((document.querySelector('.artifact-frame') as HTMLElement).style.marginTop = '40px'));
  await allow.click();
  await expect(allow).toBeDisabled({ timeout: 300 });
  expect(box.ops()).toEqual(['cards']);
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect.poll(() => box.ops()).toEqual(['cards', 'allow']);
});

test('approved_library_is_fetched_once_and_served_offline: Allow pins once, reloads, then Network off and the origin gone the chart draws', async ({ page, box }) => {
  await box.srv.startCdn();
  box.srv.cdn.files.set('/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', CHART_STUB);
  const a = await box.mount(chartPage(V1), { requester: 'alpha' });
  await expect(libs(page)).toHaveCount(1);
  await expect.poll(() => box.results()).toEqual(['no chart']);
  await libs(page).getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(libs(page)).toHaveCount(0);
  await expect.poll(() => box.results()).toEqual(['no chart', 'chart ok']);
  expect(box.calls.filter((c) => c[0] === 'allow')).toEqual([['allow', V1, null, 'alpha']]);
  expect(box.srv.cdn.hits).toEqual(['/ajax/libs/Chart.js/4.4.1/chart.umd.min.js']);
  expect(box.srv.served.filter((s) => s.startsWith(a.id))).toEqual([`${a.id}:default`, `${a.id}:default`]);
  // Offline: the origin stopped, the Network chip off; a fresh view of the same page draws from the pinned bytes.
  await box.srv.stopCdn();
  await page.reload();
  await box.mount(chartPage(V1));
  await expect.poll(() => box.results()).toEqual(['chart ok']);
  await expect(page.locator('.artifact-frame')).toHaveAttribute('data-net', 'off');
  await expect(libs(page)).toHaveCount(0);
  expect(box.srv.cdn.hits).toHaveLength(1);
  expect(box.remote).toEqual([]);
  expect(box.srv.served.filter((s) => s.startsWith('lib:'))).toHaveLength(2);
});

test('other_version_needs_its_own_card: 4.4.2 after 4.4.1, "Open with 4.4.1" serves it for one view and pins nothing', async ({ page, box }) => {
  await box.srv.startCdn();
  box.srv.cdn.files.set('/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', CHART_STUB.replace('"ok"', '"4.4.1"'));
  await box.srv.allow(V1);
  const pinned = box.srv.entries()[0].sha384;
  const a = await box.mount(chartPage(V2));
  const c = libs(page);
  await expect(c).toHaveCount(1);
  await expect(c.locator('.af-lib-name')).toHaveText('Chart.js 4.4.2; you allowed 4.4.1');
  await expect.poll(() => box.results()).toEqual(['no chart']);
  await c.getByRole('button', { name: 'Open with 4.4.1' }).click();
  await expect.poll(() => box.results()).toEqual(['no chart', 'chart 4.4.1']);
  expect(box.calls.filter((x) => x[0] === 'openWith')).toEqual([['openWith', a.id, a.hash, V2, pinned]]);
  await expect(panel(page)).toContainText('Opened with 4.4.1 for this view only.');
  await expect(libs(page)).toHaveCount(0);
  // Nothing pinned, nothing allowed; the next view shows the card again and does not get 4.4.1.
  expect(box.srv.entries().map((e) => e.version)).toEqual(['4.4.1']);
  expect(box.ops()).not.toContain('allow');
  await page.reload();
  await box.mount(chartPage(V2));
  await expect(libs(page)).toHaveCount(1);
  await expect.poll(() => box.results()).toEqual(['no chart']);
  // Newest first when several versions are pinned.
  box.override = () => ({ cards: [card({ url: V2, version: '4.4.2', other_versions: ['4.4.0', '4.10.0', '4.4.1'] })], refused: [], pinned: 0 });
  await box.mount(chartPage(V2));
  await expect(libs(page).locator('.af-lib-acts button')).toHaveText(['Allow', "Don't allow", 'Open with 4.10.0', 'Open with 4.4.1', 'Open with 4.4.0']);
  box.override = () => ({ cards: [card({ url: V2, version: '4.4.2', other_versions: ['4.4.0-beta.1', '4.4.0', '4.4.0-alpha'] })], refused: [], pinned: 0 });
  await box.mount(chartPage(V2));
  await expect(libs(page).locator('.af-lib-acts button')).toHaveText(['Allow', "Don't allow", 'Open with 4.4.0', 'Open with 4.4.0-beta.1', 'Open with 4.4.0-alpha']);
});

test('frame_url_carries_view_token: "Open with" reloads the frame with the returned token', async ({ page, box }) => {
  await box.srv.startCdn();
  box.srv.cdn.files.set('/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', CHART_STUB.replace('"ok"', '"4.4.1"'));
  await box.srv.allow(V1);
  const a = await box.mount(chartPage(V2));
  const c = libs(page);
  await expect(c).toHaveCount(1);
  await expect.poll(() => box.results()).toEqual(['no chart']);
  await c.getByRole('button', { name: 'Open with 4.4.1' }).click();
  await expect.poll(() => box.results()).toEqual(['no chart', 'chart 4.4.1']);
  const view = box.srv.views.at(-1)!;
  expect(view).toMatch(/^[0-9a-f]{32}$/);
  expect(box.srv.views).toEqual(['', view]);
  await expect(page.locator('iframe')).toHaveAttribute('src', `${box.srv.origin}/${a.id}?view=${view}`);
});

test('manifest_match_shows_verified_and_off_manifest_unverified: badge text and hover', async ({ page, box }) => {
  box.override = () => ({ cards: [card({ listed: true }), card({ url: V2, version: '4.4.2', listed: false })], refused: [], pinned: 0 });
  await box.mount(chartPage(V1, V2));
  const badges = page.locator('.af-badge');
  await expect(badges).toHaveText(['cdnjs lists this version', 'Unverified']);
  await expect(badges.nth(0)).not.toHaveAttribute('title');
  await expect(badges.nth(1)).toHaveAttribute('title', HOVER);
});

test('network_on_keeps_todays_policy_and_still_serves_pinned_from_cache: chip and "Always allow" as before with cards present', async ({ page, box }) => {
  await box.srv.startCdn();
  box.srv.cdn.files.set('/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', CHART_STUB);
  await box.srv.allow(V1);
  const other = 'https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js';
  const text = chartPage(V1, other).replace('r="chart "+Chart.drawn', 'r="chart "+Chart.drawn+" other "+(window.OTHER||"none")');
  const a = await box.mount(text, { always: true });
  await expect(libs(page)).toHaveCount(1);
  await expect(libs(page)).toContainText('lodash.js 4.17.21');
  await expect.poll(() => box.results()).toEqual(['chart ok other none']);
  const chip = page.getByRole('button', { name: 'Network off' });
  await chip.click();
  await expect(page.getByRole('button', { name: 'Network on' })).toBeDisabled();
  await expect(page.locator('.artifact-frame')).toHaveAttribute('data-net', 'on');
  // On: today's policy, so the unpinned tag loads from its host; the pinned one still comes from the cache.
  await expect.poll(() => box.results()).toEqual(['chart ok other none', 'chart ok other loaded']);
  expect(box.remote).toEqual([other]);
  expect(box.srv.served.filter((s) => s.startsWith(a.id))).toEqual([`${a.id}:default`, `${a.id}:wide`]);
  expect(box.srv.served.filter((s) => s.startsWith('lib:'))).toHaveLength(2);
  expect(box.calls.filter((c) => c[0] === 'grant')).toEqual([['grant', a.id, a.hash]]);
  // The card stays (pinning still matters offline); "Always allow in this project" keeps its meaning.
  await expect(libs(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Always allow in this project' }).click();
  expect(await box.msgs('always')).toHaveLength(1);
  expect(box.ops()).not.toContain('allow');
});

test('forged_csp_report_makes_no_card_or_fetch: text 10 only for the five hosts, never a card or an op', async ({ page, box }) => {
  const forged = [
    { type: 'nunchiro:csp-violation', directive: 'script-src-elem', blocked: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js' },
    { type: 'nunchiro:csp-violation', blocked: 'https://cdn.jsdelivr.net/npm/other@1.0.0/x.js' },
    { type: 'nunchiro:csp-violation', blocked: 'https://evil.example/x.js' },
    { type: 'nunchiro:csp-violation', blocked: 'http://unpkg.com/x@1.0.0/x.js' },
    { type: 'nunchiro:csp-violation', blocked: 'javascript:alert(1)' },
    { type: 'nunchiro:csp-violation', blocked: 42 },
    { type: 'nunchiro:csp-violation', blocked: { href: 'https://unpkg.com/' } },
    { type: 'nunchiro:csp-violation' },
    { type: 'nunchiro:csp-violation', blocked: `https://unpkg.com/${'a'.repeat(3000)}` },
    { type: 'nunchiro:lib-card', url: V1 },
    { type: 'nunchiro:lib-allow', url: V1 },
  ];
  const page1 = `<!doctype html><html><head><title>forge</title></head><body><script>
${JSON.stringify(forged)}.forEach(function (m) { parent.postMessage(m, '*') });
parent.postMessage({ type: 'fixture', result: 'sent' }, '*');
</script></body></html>`;
  await box.mount(page1);
  await expect.poll(() => box.results()).toEqual(['sent']);
  await expect(panel(page).locator('.af-lib-note')).toHaveText(['This page loads code from `cdn.jsdelivr.net` while it runs. Only `<script>` tags with exact versions are supported.']);
  await expect(libs(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(box.ops()).toEqual(['cards']);
  expect(box.remote).toEqual([]);
  // A message from the window itself (not the frame) is ignored too.
  await page.evaluate(() => window.postMessage({ type: 'nunchiro:csp-violation', blocked: 'https://unpkg.com/x@1.0.0/y.js' }, '*'));
  await page.waitForTimeout(300);
  await expect(panel(page).locator('.af-lib-note')).toHaveCount(1);
  expect(box.ops()).toEqual(['cards']);
});

test('refused_card_list_is_said_not_silent: the app refusing the list leaves a note, no card and no op', async ({ page, box }) => {
  box.override = () => {
    throw new Error('refused');
  };
  await box.mount(chartPage(V1));
  await expect(panel(page).locator('.af-lib-note')).toHaveText(["Nunchiro could not read this page's libraries, so its CDN scripts stay blocked. Open it again to retry."]);
  await expect(libs(page)).toHaveCount(0);
  await expect.poll(() => box.results()).toEqual(['no chart']);
  expect(box.ops()).toEqual(['cards']);
  expect(box.remote).toEqual([]);
});

test('cards_capped_at_8_per_page: 12 cards show 8 and "4 more libraries"; answering one brings the next', async ({ page, box }) => {
  const twelve = Array.from({ length: 12 }, (_, i) => card({ url: `${LIB}/4.4.${i}/chart.umd.min.js`, version: `4.4.${i}` }));
  box.override = () => ({ cards: twelve, refused: [], pinned: 0 });
  await box.mount(chartPage(V1));
  await expect(libs(page)).toHaveCount(8);
  await expect(page.locator('.af-lib-more')).toHaveText('4 more libraries');
  // Ticket 199: the count is plain text, never something that reads as a button.
  await expect(page.locator('.af-lib-more')).toHaveJSProperty('tagName', 'P');
  await expect(page.getByRole('button', { name: /more librar/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '12 libraries to allow' })).toBeVisible();
  // A click that finds the panel moved since it armed only re-arms it (by design): press until the first card has gone.
  const first = libs(page).filter({ hasText: 'Chart.js 4.4.0' });
  await expect(async () => {
    if (await first.count()) await first.getByRole('button', { name: "Don't allow" }).click({ timeout: 1000 });
    await expect(first).toHaveCount(0, { timeout: 1000 });
  }).toPass();
  await expect(libs(page)).toHaveCount(8);
  await expect(libs(page).last().locator('.af-lib-name')).toHaveText('Chart.js 4.4.8');
  await expect(page.locator('.af-lib-more')).toHaveText('3 more libraries');
  await expect(panel(page).locator('.af-lib-note')).toHaveText(['You did not allow `Chart.js` `4.4.0`. The page runs without it.']);
  // Don't allow stores nothing and asks nothing; the next view shows the card again.
  expect(box.ops()).toEqual(['cards']);
  await page.reload();
  await box.mount(chartPage(V1));
  await expect(libs(page).first().locator('.af-lib-name')).toHaveText('Chart.js 4.4.0');
  await expect(page.locator('.af-lib-more')).toHaveText('4 more libraries');
});

test('auto_allow_card_polls_then_reloads_once: every 1000 ms, at most 40 times, one reload when the count drops', async ({ page, box }) => {
  await page.clock.install();
  await page.reload();
  const stamps: number[] = [];
  // Auto on for 3 answers, then pinned: polling stops and the frame reloads once.
  box.override = (_id, _hash, n) => (stamps.push(n), { cards: n < 3 ? [card({ auto: true })] : [], refused: [], pinned: n < 3 ? 0 : 1 });
  const a = await box.mount(chartPage(V1));
  await expect(libs(page)).toContainText('Auto-allowed: fetching it now.');
  for (let i = 0; i < 6; i++) {
    await page.clock.runFor(1000);
    await page.waitForTimeout(50);
  }
  // 1 load + 3 polls (the third saw it pinned) + 1 after the reload.
  await expect.poll(() => box.ops().filter((o) => o === 'cards').length).toBe(5);
  expect(box.srv.served.filter((s) => s.startsWith(a.id))).toHaveLength(2);
  expect(box.ops()).not.toContain('allow');
  // Never pinned: 40 polls, then it stops; no reload.
  box.srv.served.length = 0;
  box.calls.length = 0;
  box.override = () => ({ cards: [card({ auto: true })], refused: [], pinned: 0 });
  const b = await box.mount(chartPage(V2));
  for (let i = 0; i < 45; i++) {
    await page.clock.runFor(1000);
    await page.waitForTimeout(20);
  }
  await expect.poll(() => box.ops().filter((o) => o === 'cards').length).toBe(41);
  await page.clock.runFor(5000);
  await page.waitForTimeout(100);
  expect(box.ops().filter((o) => o === 'cards')).toHaveLength(41);
  expect(box.srv.served.filter((s) => s.startsWith(b.id))).toHaveLength(1);
  expect(box.ops()).not.toContain('allow');
});

test('unrewritten_or_script_created_cdn_load_is_blocked_by_csp: under the contract CSP only `/lib/` loads', async ({ page, box }) => {
  const pinnedUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pinned/1.0.0/p.js';
  box.srv.pins.set(pinnedUrl, Buffer.from('window.P="ok"'));
  const text = `<!doctype html><html><head><title>dyn</title>
<script src="${V1}"></script>
<script src="${pinnedUrl}"></script></head><body><script>
function done(how) { parent.postMessage({ type: 'fixture', result: how + '; chart ' + typeof Chart + '; pinned ' + (window.P || 'none') }, '*') }
var s = document.createElement('script');
s.src = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
s.onerror = function () { done('created blocked') };
s.onload = function () { done('created loaded') };
document.head.appendChild(s);
</script></body></html>`;
  await box.mount(text);
  await expect.poll(() => box.results()).toEqual(['created blocked; chart undefined; pinned ok']);
  expect(box.remote).toEqual([]);
  // The CSP report for the run-time load gives text 10; the unrewritten tag has its card instead.
  await expect(panel(page).locator('.af-lib-note')).toHaveText(['This page loads code from `cdn.jsdelivr.net` while it runs. Only `<script>` tags with exact versions are supported.']);
  await expect(libs(page)).toHaveCount(1);
});

test('network_off_blocks_all_cdn_fetches: no card answered, nothing leaves for a CDN', async ({ page, box }) => {
  await box.srv.startCdn();
  box.srv.cdn.files.set('/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', CHART_STUB);
  await box.mount(chartPage(V1, 'https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js'));
  await expect(libs(page)).toHaveCount(2);
  await expect.poll(() => box.results()).toEqual(['no chart']);
  await page.waitForTimeout(500);
  expect(box.remote).toEqual([]);
  expect(box.srv.cdn.hits).toEqual([]);
  expect(box.ops()).toEqual(['cards']);
});

test('no_layout_jump_when_cards_appear: under pointer or focus only the chip appears; the cards open when both leave', async ({ page, box }) => {
  let release: (v: LibCards) => void = () => {};
  box.override = () => new Promise<LibCards>((ok) => (release = ok));
  await box.mount(chartPage(V1), { always: true });
  const bar = page.locator('.af-bar');
  const frame = page.locator('.artifact-frame iframe');
  // Network on, so the bar also holds "Always allow in this project" left of the Network chip.
  await page.getByRole('button', { name: 'Network off' }).click();
  await expect(page.getByRole('button', { name: 'Always allow in this project' })).toBeVisible();
  await expect(frame).toBeVisible();
  // The bar, the page, and every chip already in the bar (the Network chip, the caller's actions) keep their boxes.
  const rect = async () => JSON.stringify([await bar.boundingBox(), await frame.boundingBox(), ...(await Promise.all((await bar.locator('.af-chip:not(.af-libs-chip)').all()).map((c) => c.boundingBox())))]);
  const fb = (await frame.boundingBox())!;
  // Pointer over the page.
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  const before = await rect();
  release({ cards: [card()], refused: [], pinned: 0 });
  await expect(page.getByRole('button', { name: '1 library to allow' })).toBeVisible();
  await page.waitForTimeout(200);
  expect(await rect()).toBe(before);
  await expect(panel(page)).toHaveCount(0);
  // The pointer leaves: the cards open.
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height + 200);
  await expect(libs(page)).toHaveCount(1);

  // Keyboard focus in the frame: the same.
  await page.reload();
  await box.mount(chartPage(V2));
  await expect(frame).toBeVisible();
  // A bar control holds keyboard focus (the frame container alone does not: the cards open inside it, below its top).
  await page.getByRole('button', { name: 'Network off' }).focus();
  const before2 = await rect();
  release({ cards: [card({ url: V2, version: '4.4.2' })], refused: [], pinned: 0 });
  await expect(page.getByRole('button', { name: '1 library to allow' })).toBeVisible();
  await page.waitForTimeout(200);
  expect(await rect()).toBe(before2);
  await expect(panel(page)).toHaveCount(0);
  // The chip opens them on purpose.
  await page.getByRole('button', { name: '1 library to allow' }).click();
  await expect(libs(page)).toHaveCount(1);
});

test('no_agent_path_reaches_libs_ops: Allow, auto-allow and Remove are sent only from click handlers in the window', () => {
  const SRC = path.resolve(import.meta.dirname, '../src');
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const all = files(SRC).map((f) => [path.relative(SRC, f), fs.readFileSync(f, 'utf8')] as const);
  const using = (re: RegExp) => all.filter(([, t]) => re.test(t)).map(([f]) => f).sort();
  // The op names live only in the client's type, the card's bridge and the settings page (no other file even holds
  // a `libs_` fragment to build one from).
  expect(using(/libs_/)).toEqual(['api.ts', 'sandbox/libs.ts', 'settings/libs/LibsPage.tsx']);
  expect(using(/libs_allow/)).toEqual(['api.ts', 'sandbox/libs.ts']);
  expect(using(/libs_auto_allow|libs_remove/)).toEqual(['api.ts', 'settings/libs/LibsPage.tsx']);
  expect(using(/\.libs\(/)).toEqual(['sandbox/libs.ts', 'settings/libs/LibsPage.tsx']);
  // The bridge's Allow is called from the card only, and the card calls it only from its button's onClick.
  expect(using(/\.allow\(/)).toEqual(['sandbox/LibCards.tsx']);
  const card = all.find(([f]) => f === 'sandbox/LibCards.tsx')![1];
  const calls = card.split('\n').filter((l) => /answer\.(allow|openWith)\(/.test(l));
  expect(calls.length).toBeGreaterThan(0);
  for (const l of calls) expect(l).toMatch(/onClick=\{\(\) => still\(\) && void s\.answer\.(allow|openWith)\(/);
  // The settings page sends each op only from an onClick or onChange handler.
  const settings = all.find(([f]) => f === 'settings/libs/LibsPage.tsx')![1].split('\n');
  const opLines = settings.filter((l) => /libs_(auto_allow|remove)/.test(l));
  // The third is a row's reset (ticket 543): the kit's `Reset` calls `run` from its own onClick.
  expect(opLines.length).toBe(3);
  for (const l of opLines) expect(l).toMatch(/(on(Click|Change)|run)=\{/);
  // No message, CSP-report, chat or hook handler reaches them: the frame's message handler never names an op.
  for (const [f, t] of all.filter(([, t]) => /addEventListener\('message'/.test(t))) {
    expect(t, f).not.toMatch(/libs_|\.allow\(|answer\.|openWith\(/);
  }
  // Cards come only from `artifact_lib_cards`.
  expect(using(/artifact_lib_cards/)).toEqual(['sandbox/libs.ts']);
});

// Ticket 553 (review raw-words-errors-551 r1): a refused Allow reads plainly, and its raw reason is the line's accessible
// description, not only the tooltip.
test('refused_allow_reason_is_described: a screen reader hears the raw reason of a failed Allow', async ({ page, box }) => {
  const gone = `${LIB}/9.9.9/gone.umd.min.js`;
  box.override = () => ({ cards: [card({ url: gone, version: '9.9.9' })], refused: [], pinned: 0 });
  await box.mount(chartPage(gone));
  await libs(page).getByRole('button', { name: 'Allow', exact: true }).click();
  const msg = libs(page).locator('.af-lib-msg[role="alert"]');
  const raw = (await msg.getAttribute('title')) ?? '';
  expect(raw).not.toBe('');
  await expect(msg).toHaveText('That did not work.');
  await expect(msg).toHaveAccessibleDescription(raw);
});
