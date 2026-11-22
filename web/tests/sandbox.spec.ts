// Artifact sandbox (V1B-04, spec v1b Acceptance 6). Playwright drives a browser, not the Tauri WKWebView, so
// the custom scheme is replaced by a test server that sends the same CSP files and bootstrap (see
// sandbox-server.ts). "Nothing reaching the core" is asserted with canary loopback listeners: the core has
// no request log, so two listeners stand in for a local service and the core's API port.
import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, parse } from '../src/settings';
import { webUrl } from '../src/sandbox/link';
import { artifactServer, canary, CSP_DEFAULT, CSP_NETWORK, FIXTURES, harnessServer } from './sandbox-server';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const LIB_SOURCE = 'nunchiro-artifact://localhost/lib/';
const CHART_STUB = 'function Chart(el){var c=el.getContext("2d");c.fillRect(10,10,50,30);Chart.drawn="ok"}';

type Shared = { art: Awaited<ReturnType<typeof artifactServer>>; vars: Record<string, string>; harness: Awaited<ReturnType<typeof harnessServer>> };
type Box = {
  /** Requests that really left the page for a `*.nunchiro.test` host or a CDN (answered by routes). */
  remote: string[];
  /** Requests for the pinned library cache path (ARTIFACTLIBS); the stand-in for the app's `/lib/<sha384>` route answers them. */
  lib: string[];
  grants: [string, string][];
  canary: { count: () => number };
  core: { count: () => number };
  mount: (id: string, file: string, extra?: Record<string, unknown>) => Promise<{ id: string; hash: string }>;
  remount: (a: { id: string; hash: string }, extra?: Record<string, unknown>) => Promise<void>;
  msgs: (type: string) => Promise<any[]>;
  results: () => Promise<string[]>;
  frame: () => import('@playwright/test').FrameLocator;
  settle: () => Promise<void>;
  art: Shared['art'];
};

const test = base.extend<{ box: Box }, { shared: Shared }>({
  shared: [
    async ({}, use) => {
      const vars: Record<string, string> = {};
      const art = await artifactServer(vars);
      const harness = await harnessServer(art.origin);
      await use({ art, vars, harness });
      await harness.close();
      await art.close();
    },
    { scope: 'worker' },
  ],
  box: async ({ page, shared }, use) => {
    const [a, b] = [await canary(), await canary()];
    shared.vars.CANARY = String(a.port);
    shared.vars.CORE = String(b.port);
    const remote: string[] = [];
    const lib: string[] = [];
    await page.route(/nunchiro\.test|cdn\.jsdelivr\.net|fonts\.googleapis\.com/, (route) => {
      const url = route.request().url();
      remote.push(url);
      if (url.includes('pixel.png')) return route.fulfill({ contentType: 'image/png', body: PNG });
      if (url.includes('evil.nunchiro.test')) return route.fulfill({ contentType: 'text/javascript', body: 'parent.postMessage({type:"fixture",result:"evil ran"},"*")' });
      if (url.includes('chart.js')) return route.fulfill({ contentType: 'text/javascript', body: CHART_STUB });
      if (url.includes('fonts.googleapis')) return route.fulfill({ contentType: 'text/css', body: 'body{}' });
      if (url.includes('api.nunchiro.test')) return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'data' });
      return route.abort();
    });
    const grants: [string, string][] = [];
    await page.exposeFunction('__grant', (id: string, hash: string) => {
      grants.push([id, hash]);
      shared.art.grant(id, hash);
    });
    await page.goto(shared.harness.url);
    const frame = () => page.frameLocator('iframe');
    const remount = (x: { id: string; hash: string }, extra: Record<string, unknown> = {}) =>
      page.evaluate((p) => window.__mount(p), { artifact: x, origin: shared.art.origin, ...extra });
    const box: Box = {
      remote,
      lib,
      grants,
      canary: a,
      core: b,
      art: shared.art,
      frame,
      remount,
      async mount(id, file, extra = {}) {
        const x = shared.art.set(id, file);
        await remount(x, extra);
        return x;
      },
      msgs: (type) => page.evaluate((t) => window.__messages.filter((m: any) => m?.type === t), type),
      results: async () => (await box.msgs('fixture')).map((m) => m.result),
      settle: async () => {
        await expect.poll(async () => (await box.msgs('nunchiro:ready')).length).toBeGreaterThan(0);
        await page.waitForTimeout(700);
      },
    };
    await use(box);
    await a.close();
    await b.close();
  },
});

const uid = (t: { title: string }) => t.title.replace(/\W+/g, '-').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 6);
const violations = async (box: Box) => [...new Set((await box.msgs('nunchiro:csp-violation')).map((m) => m.directive))].sort();

/** Nothing left the sandbox: no connection to either loopback stand-in, no remote request, no popup or navigation. */
async function sealed(page: Page, box: Box, frameUrlStart: string) {
  expect(box.canary.count(), 'connections to the local-service stand-in').toBe(0);
  expect(box.core.count(), 'connections to the core-port stand-in').toBe(0);
  expect(box.remote).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
  expect(await page.evaluate(() => location.pathname)).toBe('/');
  // A blocked navigation leaves an error page (Chromium) or the artifact itself (WebKit); never a loopback URL.
  const urls = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url());
  expect(urls[0].startsWith(frameUrlStart) || urls[0].startsWith('chrome-error:')).toBe(true);
  // v1b-06: a frame the artifact nests (SVG foreignObject) may exist only as a blocked error page. V1A-50: WebKit
  // blocks it by frame-src before its load starts (the same violation is reported), so its URL stays empty.
  const blank = page.context().browser()?.browserType().name() === 'webkit' ? /^$/ : /^(chrome-error:|about:blank)/;
  for (const u of urls.slice(1)) expect(u, 'a nested frame').toMatch(blank);
  expect(await page.evaluate(() => window.__opened)).toEqual([]);
}

const FRAME_ATTRS = { sandbox: 'allow-scripts' };

// v1b-06: the same hostile set again with the frame inside a chat row (ticket 06's inline card).
for (const inChat of [false, true]) test.describe(`hostile fixtures: blocked with nothing reaching the core${inChat ? ' (in a chat row)' : ''}`, () => {
  const cases: { file: string; expect: (box: Box, page: Page) => Promise<void>; directive?: string; click?: boolean }[] = [
    { file: 'fetch-loopback.html', directive: 'connect-src', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    { file: 'fetch-core.html', directive: 'connect-src', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    { file: 'websocket-api.html', directive: 'connect-src', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    { file: 'top-location.html', expect: async (b) => expect(await b.results()).toEqual(['threw SecurityError']) },
    { file: 'window-open.html', click: true, expect: async (b) => expect(await b.results()).toEqual(['load null', 'click null']) },
    { file: 'form-post.html', click: true, expect: async () => {} },
    { file: 'remote-image.html', directive: 'img-src', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    { file: 'script-host.html', directive: 'script-src-elem', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    { file: 'self-navigation.html', expect: async () => {} },
    { file: 'exfil-misc.html', expect: async () => {} },
    // v1b-06: SVG cards run in the same frame (served as text/html, like the app's scheme).
    { file: 'svg-script.svg', directive: 'connect-src', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    { file: 'svg-href.svg', directive: 'img-src', expect: async (b) => expect(await b.results()).toEqual(['blocked']) },
    // V1A-50: the nested iframe is stopped by frame-src on both engines (what sealed()'s empty WebKit URL relies on).
    {
      file: 'svg-foreignobject.svg',
      directive: 'img-src',
      expect: async (b) => {
        expect(await b.results()).toEqual(['done']);
        expect(await violations(b)).toContain('frame-src');
      },
    },
  ];
  for (const c of cases) {
    test(c.file, async ({ page, box, shared }, info) => {
      const id = uid(info);
      await box.mount(id, `hostile/${c.file}`, { inChat });
      await box.settle();
      if (c.click) {
        await box.frame().locator('body').click();
        await page.waitForTimeout(300);
      }
      await c.expect(box, page);
      if (c.directive) expect(await violations(box)).toContain(c.directive);
      await sealed(page, box, `${shared.art.origin}/`);
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', FRAME_ATTRS.sandbox);
      info.annotations.push({ type: 'blocked by', description: (await violations(box)).join(', ') || 'sandbox flags / parent frame-src (no CSP report)' });
    });
  }

  test('nunchiro:// link, forged messages and web links', async ({ page, box }, info) => {
    await box.mount(uid(info), 'hostile/nunchiro-link.html', { inChat });
    await box.settle();
    // The page asked before any click: the window drops it (the frame is not focused).
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await box.frame().locator('#app').click();
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await box.frame().locator('#web').click();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['https://docs.nunchiro.test/page']);
    await page.waitForTimeout(2100);
    await box.frame().locator('#forge').click();
    await page.waitForTimeout(300);
    // Forged asks for loopback, link-local and app schemes never get through; the one public https ask after
    // a real click does (a page cannot be told apart from its own bootstrap), and a second ask inside the gap is dropped.
    expect(await page.evaluate(() => window.__opened)).toEqual(['https://docs.nunchiro.test/page', 'https://forged.nunchiro.test/']);
    expect(box.canary.count() + box.core.count()).toBe(0);
    expect(page.context().pages()).toHaveLength(1);
  });
});

// ARTIFACTLIBS (needs 91): the default policy takes library scripts only from the pinned cache path, which the app
// serves after rewriting a pinned tag's `src` to `nunchiro-artifact://localhost/lib/<sha384>` (libs.rs `rewrite_with`).
// The page below is that rewritten form. Renamed from "an allowed-CDN chart renders with no click": no CDN is allowed now.
const CHART_PAGE = (src: string) => `<!doctype html><html><head><title>chart</title>
<script src="${src}"></script></head>
<body><canvas id="c" width="200" height="80"></canvas>
<script>new Chart(document.getElementById("c"),{data:[3,5,2]});parent.postMessage({type:"fixture",result:"chart "+Chart.drawn},"*")</script>
</body></html>`;

/**
 * Chromium and WebKit under Playwright do not treat `nunchiro-artifact://` as a standard scheme (the Tauri app registers it),
 * so a CSP source with that host never matches here. This puts the one real cache source on the test origin instead:
 * the served default policy, from the Rust file, with its `nunchiro-artifact://localhost/lib/` token swapped for
 * `<test origin>/lib/` and nothing else changed, and a `/lib/<hash>` answer standing in for the app's cache route.
 * It throws if the served policy has no cache source, so a policy that lost it cannot pass by accident.
 */
async function pinnedCacheAt(page: Page, box: Box) {
  const origin = box.art.origin;
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/lib/')) {
      box.lib.push(LIB_SOURCE + url.pathname.slice('/lib/'.length));
      return route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: CHART_STUB });
    }
    const res = await route.fetch();
    const csp = res.headers()['content-security-policy'];
    if (!csp?.includes(LIB_SOURCE)) throw new Error(`the served policy has no pinned cache source: ${csp}`);
    return route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp.replace(LIB_SOURCE, `${origin}/lib/`) } });
  });
}

test('a chart from the pinned library cache renders with no click', async ({ page, box }, info) => {
  await pinnedCacheAt(page, box);
  const id = uid(info);
  const hash = 'a'.repeat(96);
  await box.remount(box.art.setText(id, CHART_PAGE(`${box.art.origin}/lib/${hash}`)));
  await box.settle();
  expect(await box.results()).toEqual(['chart ok']);
  expect(await violations(box)).toEqual([]);
  expect(box.lib).toEqual([`${LIB_SOURCE}${hash}`]);
  expect(box.remote, 'the library never came from a remote origin').toEqual([]);
  await expect(box.frame().locator('canvas')).toBeVisible();
  await expect(box.frame().locator('body')).toBeVisible();
  expect(box.grants).toEqual([]);
  expect(box.art.hits.filter((h) => h.startsWith(id))).toEqual([`${id}:default`]);
});

// The chart test must fail when a library loads from outside the cache: the same page and the same policy, the script
// from each outside source. Every one is blocked by script-src, the chart never draws, and nothing reaches the core.
for (const [name, src, remote] of [
  ['the old CDN (cdn.jsdelivr.net)', 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js', 'cdn.jsdelivr.net'],
  ['the old CDN (cdnjs.cloudflare.com)', 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', 'cdnjs.cloudflare.com'],
  ['another remote origin', 'https://evil.nunchiro.test/chart.js', 'evil.nunchiro.test'],
  ['another path on the same origin', '{origin}/chart.js', ''],
  ['a path that only starts like the cache', '{origin}/library/chart.js', ''],
  ['the cache path without its trailing slash', '{origin}/lib', ''],
] as const)
  test(`a chart script from ${name} is blocked`, async ({ page, box }, info) => {
    await pinnedCacheAt(page, box);
    await box.remount(box.art.setText(uid(info), CHART_PAGE(src.replace('{origin}', box.art.origin))));
    await box.settle();
    expect(await box.results()).toEqual([]);
    expect(await violations(box)).toContain('script-src-elem');
    expect(box.lib, 'no request reached the cache path').toEqual([]);
    expect(box.remote.filter((u) => remote && u.includes(remote)), 'no request left for the remote origin').toEqual([]);
    expect(box.canary.count() + box.core.count()).toBe(0);
  });

test('the network chip: remote image loads after one click, loopback stays closed', async ({ page, box }, info) => {
  const id = uid(info);
  const x = await box.mount(id, 'ok/network.html');
  await box.settle();
  expect((await box.results()).sort()).toEqual(['fetch blocked', 'image blocked', 'loopback blocked', 'ws blocked']);
  expect(box.remote).toEqual([]);
  const chip = page.getByRole('button', { name: 'Network off' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('button', { name: 'Network on' })).toBeDisabled();
  expect(box.grants).toEqual([[x.id, x.hash]]);
  await expect.poll(async () => (await box.results()).includes('image loaded')).toBe(true);
  await page.waitForTimeout(500);
  const after = await box.results();
  expect(after).toContain('fetch data');
  // `connect-src https: wss:` leaves plain http and ws shut: the local API stays out of reach even when granted.
  expect(after).toContain('loopback blocked');
  expect(after).not.toContain('loopback reached');
  expect(after).not.toContain('ws reached');
  expect(box.remote.filter((u) => u.includes('pixel.png'))).toHaveLength(1);
  expect(box.canary.count() + box.core.count()).toBe(0);
  expect(box.art.hits.filter((h) => h.startsWith(id))).toEqual([`${id}:default`, `${id}:wide`]);
});

test('a content change resets the grant', async ({ page, box }, info) => {
  const id = uid(info);
  const first = await box.mount(id, 'hostile/remote-image.html');
  await box.settle();
  await page.getByRole('button', { name: 'Network off' }).click();
  await expect.poll(async () => (await box.results()).includes('loaded')).toBe(true);
  await expect(page.locator('.artifact-frame')).toHaveAttribute('data-net', 'on');
  const before = box.remote.length;
  const next = box.art.setText(id, fs.readFileSync(path.join(FIXTURES, 'hostile/remote-image.html'), 'utf8') + '<!-- edited -->');
  expect(next.hash).not.toBe(first.hash);
  await box.remount(next);
  await expect(page.locator('.artifact-frame')).toHaveAttribute('data-net', 'off');
  await expect(page.getByRole('button', { name: 'Network off' })).toBeEnabled();
  await expect.poll(async () => (await box.results()).filter((r) => r === 'blocked').length).toBe(2);
  expect(box.remote.length, 'no remote request after the change').toBe(before);
  expect(box.art.hits.filter((h) => h.startsWith(id)).pop()).toBe(`${id}:default`);
});

test('the per-project setting loads the first page under the wide policy, after the grant', async ({ page, box }, info) => {
  const id = uid(info);
  const x = await box.mount(id, 'hostile/remote-image.html', { alwaysAllow: true });
  await expect.poll(async () => (await box.results()).includes('loaded')).toBe(true);
  expect(box.grants).toEqual([[x.id, x.hash]]);
  expect(box.art.hits.filter((h) => h.startsWith(id))).toEqual([`${id}:wide`]);
  await expect(page.locator('.artifact-frame')).toHaveAttribute('data-net', 'on');
  // Changed content under the same setting is granted again, for the new hash only.
  const next = box.art.setText(id, '<!doctype html><img src="https://img.nunchiro.test/pixel.png?2" onload="parent.postMessage({type:\'fixture\',result:\'second\'},\'*\')">');
  await box.remount(next, { alwaysAllow: true });
  await expect.poll(async () => (await box.results()).includes('second')).toBe(true);
  expect(box.grants.at(-1)).toEqual([next.id, next.hash]);
});

test('a refused grant leaves the narrow policy and says so', async ({ page, box }, info) => {
  const x = box.art.set(uid(info), 'hostile/remote-image.html');
  await page.evaluate((p) => {
    window.__grant = () => Promise.reject(new Error('refused'));
    window.__mount(p);
  }, { artifact: x, origin: box.art.origin });
  await box.settle();
  await page.getByRole('button', { name: 'Network off' }).click();
  await expect(page.getByRole('button', { name: 'Network off' })).toHaveAttribute('title', /refused/);
  await page.waitForTimeout(400);
  expect(await box.results()).toEqual(['blocked']);
  expect(box.remote).toEqual([]);
});

test('the v1a hint key reaches the frame as a whole', async ({ page, box }, info) => {
  const x = await box.mount(uid(info), 'ok/page.html');
  await box.settle();
  await box.remount(x, { hints: true }); // the hint layer reads the page when it opens, as on the real key
  const wrap = page.locator('.artifact-frame');
  const w = (await wrap.boundingBox())!;
  const hints = await page.locator('.hints-layer .hint').evaluateAll((els) => els.map((e) => ({ x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top, keys: (e as HTMLElement).dataset.keys })));
  const onFrame = hints.filter((h) => Math.abs(h.x - w.x) < 2 && Math.abs(h.y - w.y) < 2);
  expect(onFrame).toHaveLength(1);
  for (const k of onFrame[0].keys!.split(' ')) await page.keyboard.press(k); // ticket 389: the letters shown
  await expect(wrap).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
});

test('the frame follows the page height up to its cap', async ({ page, box }, info) => {
  await box.mount(uid(info), 'ok/page.html', { maxHeight: 320 });
  await box.settle();
  await expect.poll(() => page.locator('iframe').evaluate((e) => e.getBoundingClientRect().height)).toBe(320);
  await box.mount(uid(info), 'ok/page.html');
  await expect.poll(() => page.locator('iframe').evaluate((e) => e.getBoundingClientRect().height)).toBe(400);
});

// Inventory N226: `artifactNetwork` was stored and cleaned but nothing read it. It is gone; a store written before still reads.
test('the removed artifactNetwork setting: an old store that has it reads clean, keeps its other values and drops the field', () => {
  expect('artifactNetwork' in DEFAULTS).toBe(false);
  for (const old of ['["/p/a"]', '[1]']) {
    const read = parse(`{"artifactNetwork":${old},"tabFont":13}`);
    expect(read.clean).toBe(true);
    expect(read.settings.tabFont).toBe(13);
    expect('artifactNetwork' in read.settings).toBe(false);
  }
});

test('both policies come from the files the Rust handler embeds', () => {
  const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  const sources = (csp: string, name: string) => directive(csp, name)!.split(/\s+/).slice(1);
  expect(CSP_DEFAULT).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' nunchiro-artifact:\/\/localhost\/lib\/; /);
  // ARTIFACTLIBS: the default script-src is exactly inline code plus the pinned cache path. No remote origin, no
  // scheme-wide source, no wildcard, and not the whole app scheme; script-src-elem/-attr/default-src cannot widen it.
  expect(sources(CSP_DEFAULT, 'script-src')).toEqual(["'unsafe-inline'", LIB_SOURCE]);
  expect(directive(CSP_DEFAULT, 'script-src-elem')).toBeUndefined();
  expect(directive(CSP_DEFAULT, 'default-src')).toBe("default-src 'none'");
  for (const host of ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdn.tailwindcss.com', 'code.jquery.com'])
    expect(CSP_DEFAULT, host).not.toContain(host);
  expect(sources(CSP_DEFAULT, 'script-src').filter((s) => /^(https?:|wss?:|\*|nunchiro-artifact:\/?\/?(localhost\/?)?)/.test(s) && s !== LIB_SOURCE)).toEqual([]);
  // The network grant widens connections and media, not the library path: it still names the cache path.
  expect(CSP_NETWORK).toContain('connect-src https: wss:');
  expect(sources(CSP_NETWORK, 'script-src')).toContain(LIB_SOURCE);
  // Product fact kept from V1B-04 (pinned so a change shows): the owner-granted policy has always allowed `https:` scripts.
  expect(sources(CSP_NETWORK, 'script-src')).toEqual(["'unsafe-inline'", 'https:', LIB_SOURCE]);
  for (const csp of [CSP_DEFAULT, CSP_NETWORK]) expect(csp).not.toContain('allow-same-origin');
});

test('screenshots: the frame with the network chip in both states', async ({ page, box }, info) => {
  const x = await box.mount(uid(info), 'ok/network.html');
  await box.settle();
  const dir = path.join(path.resolve(import.meta.dirname, '../..'), '.scratch/shots');
  fs.mkdirSync(dir, { recursive: true });
  const wrap = page.locator('.artifact-frame');
  await wrap.screenshot({ path: path.join(dir, `sandbox-network-off-${info.project.name}.png`) });
  await page.getByRole('button', { name: 'Network off' }).click();
  await expect.poll(async () => (await box.results()).includes('image loaded')).toBe(true);
  await wrap.screenshot({ path: path.join(dir, `sandbox-network-on-${info.project.name}.png`) });
  expect(box.grants).toEqual([[x.id, x.hash]]);
});

test('webUrl passes only public http(s) hosts', () => {
  for (const ok of ['https://docs.example.com/a?b=1', 'http://example.org/', 'https://8.8.8.8/', 'https://[2606:4700::1111]/'])
    expect(webUrl(ok), ok).toBe(new URL(ok).href);
  for (const bad of [
    'nunchiro://open', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/', 'blob:https://example.com/x',
    'http://127.0.0.1:7777/api/x', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://localhost:1/', 'http://app.localhost/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://0.0.0.0/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.1/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://100.64.0.1/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://core/', 'http://printer.local/',
    'http://router.lan/', 'http://svc.internal/', 'https://user:pw@example.com/', 'http://example.com./x', 'http://localhost./',
  ])
    expect(webUrl(bad), bad).toBeNull();
  expect(webUrl('https://example.com/' + 'a'.repeat(2100))).toBeNull();
  expect(webUrl(42)).toBeNull();
});

// WebRTC sits outside CSP. Playwright's browsers keep it on, so the first test is the probe's positive control
// (the leak this fixture exists to catch) and the second removes the engine feature in every frame, as the app
// does in its WKWebView. The real WKWebView result is in REPORT.md (run on the built app, not here).
test.describe('WebRTC TURN/STUN fixture', () => {
  test('control: the probe reaches a loopback listener when the engine allows WebRTC', async ({ box }, info) => {
    await box.mount(uid(info), 'hostile/webrtc-turn.html');
    await box.settle();
    await expect.poll(() => box.canary.count(), { timeout: 8000 }).toBeGreaterThan(0);
  });

  test('with the engine feature off nothing connects, in the page and in a srcdoc frame', async ({ page, box }, info) => {
    await page.addInitScript(() => {
      for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription'])
        Object.defineProperty(window, k, { value: undefined, configurable: false });
    });
    await page.goto(page.url());
    await box.mount(uid(info), 'hostile/webrtc-turn.html');
    await box.settle();
    await expect.poll(async () => (await box.results()).length).toBe(2);
    expect((await box.results()).sort()).toEqual(['main absent', 'srcdoc absent']);
    await page.waitForTimeout(1500);
    expect(box.canary.count()).toBe(0);
  });
});

test('preconnect, DNS prefetch and a _blank link before any grant', async ({ page, box }, info) => {
  await box.mount(uid(info), 'hostile/preconnect.html');
  await box.settle();
  await box.frame().locator('#blank').click();
  await page.waitForTimeout(1500);
  expect(page.context().pages()).toHaveLength(1);
  // No HTTP request may ever reach the stand-in. A bare TCP preconnect is outside CSP; it is switched off in
  // the app's engine and measured there (REPORT.md), so here it is recorded, not asserted, for WebKit.
  info.annotations.push({ type: 'tcp connections to the canary', description: String(box.canary.count()) });
  if (info.project.name === 'chromium') expect(box.canary.count()).toBe(0);
});

// Known limit (review round 2, item 4): CSP cannot say "https: except loopback", so after a grant a page can open
// a TLS connection to a loopback port. The core speaks plain HTTP, so no request is ever parsed; the connection is
// all that happens. Before the grant it is blocked.
test('after a grant https to loopback opens a socket (documented limit); before it, nothing', async ({ page, box }, info) => {
  const x = await box.mount(uid(info), 'ok/https-loopback.html');
  await box.settle();
  expect(await box.results()).toEqual(['failed']);
  expect(box.canary.count()).toBe(0);
  await page.getByRole('button', { name: 'Network off' }).click();
  await expect.poll(() => box.canary.count()).toBeGreaterThan(0);
  expect(box.grants).toEqual([[x.id, x.hash]]);
});
