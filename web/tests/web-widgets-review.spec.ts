// Ticket v1b-23: one failing-then-passing test per fixed review finding, named `review-23: <finding>`. Same setup as
// web-widgets.spec.ts (a real core per test, the scheme stood in for by fixtures/web-widgets/host.ts). Chromium only;
// WKWebView rows are not run here.
import fs from 'node:fs';
import path from 'node:path';
import { textError } from '../src/webwidgets/bridge';
import { frameId } from '../src/webwidgets/api';
import { expect, test } from './fixtures';
import { coreCall, installWidgetHost } from './fixtures/web-widgets/host';
import { allow, BRIDGE, call, confirmLine, enable, frameAt, open, replies, replyTo, sendLog, target, webWidget } from './fixtures/web-widgets/review/helpers';

/** A page that never ran a bootstrap: the bridge client alone, as a crafted page the frame navigates to would be. */
const BARE = BRIDGE.replace('<title>bridge client</title>', '<title>bare page</title>');
/** Navigates the frame before its own load event: a parser-blocking script that never arrives holds the load back. */
const leaveEarly = (to: string) =>
  `<!doctype html><html><head><script>location.replace(location.origin + ${JSON.stringify(to)})</script>` +
  `<script src="https://cdn.jsdelivr.net/npm/review-23-never.js"></script></head><body>first page</body></html>`;

test.describe('web widgets review (v1b-23)', () => {
  test.beforeEach(async ({ app }) => {
    // No third-party traffic: the CDN script is held until the test ends.
    await app.route(/cdn\.jsdelivr\.net/, () => {});
    await app.route(/\/__review\/bare$/, (r) => r.fulfill({ contentType: 'text/html', body: BARE }));
  });

  test('review-23: marks cap holds across joiners', () => {
    const m4 = '́'.repeat(4);
    expect(textError(`a${m4}‍${m4}`)).toMatch(/combining marks/);
    expect(textError(`a${m4}‌${m4}`)).toMatch(/combining marks/);
    expect(textError(`Run the tests x${`${m4}‍`.repeat(40)} then`)).toMatch(/combining marks/);
    expect(textError(`a${m4} b${m4}`)).toBeNull();
    expect(textError('👨‍👩‍👧 리뷰')).toBeNull();
    expect(textError('❤️‍🔥')).toBeNull();
  });

  // V2.5-49: the start check skips the one shared hidden set (board/rights.rs `hidden`), so a hidden prefix cannot
  // slip /, ! or # past it; every shared range is refused (at the start: a ZWJ, the middle of
  // U+200B..U+200F, is allowed right after a visible character, as act.rs allows it).
  test('webwidget_start_check_uses_shared_set', () => {
    for (const prefix of ['\u061c', '\u{e0041}', ' \u061c\u{e0041}']) {
      for (const lead of ['/', '!', '#']) expect(textError(`${prefix}${lead}model opus`)).toMatch(/may not start with/);
    }
    const ranges: [number, number][] = [[0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xe0000, 0xe007f]];
    for (const [lo, hi] of ranges) {
      for (const code of [lo, (lo + hi) >> 1, hi]) expect(textError(`${String.fromCodePoint(code)}ab`), code.toString(16)).not.toBeNull();
    }
    expect(textError('리뷰 해줘 👍')).toBeNull();
    expect(textError('Run the tests, then 커밋 🚀')).toBeNull();
  });

  test('review-23: a page navigated to before the first load gets no bridge', async ({ app, core }) => {
    const host = await installWidgetHost(app, core.home);
    await enable(core);
    const t = target(core);
    webWidget(core, 'w', leaveEarly('/__review/bare'));
    allow(core, 'w', 'act');
    await open(app, core, 'w');
    const g = await frameAt(app, '/__review/bare');
    expect(host.served.filter((s) => s.status === 200)).toHaveLength(1);
    const c = await call(g, 'context');
    const a = await call(g, 'act', { text: 'from the navigated page', session: 'target' });
    await app.waitForTimeout(1500);
    expect([c, a]).toEqual([1, 2]);
    expect(await replies(g)).toEqual([]);
    await expect(confirmLine(app, 'w')).toHaveAttribute('data-confirm', 'idle');
    expect(t.received()).toBe('');
    expect(sendLog(core, t.s.id)).toEqual([]);
  });

  test('review-23: a frame navigated to another widget page cannot act as the first', async ({ app, core }) => {
    await installWidgetHost(app, core.home);
    await enable(core);
    const t = target(core);
    webWidget(core, 'b', BRIDGE);
    allow(core, 'b', 'act');
    const b = (await coreCall(core.home, { op: 'widget_page', name: 'b' })).Ok.page;
    webWidget(core, 'a', leaveEarly(`/__widget/${frameId('b', b.hash, true)}`)); // v1b-34: b's act page
    allow(core, 'a', 'act');
    await open(app, core, 'a');
    const g = await frameAt(app, `/__widget/w-b-`);
    const a = await call(g, 'act', { text: 'b speaking as a', session: 'target' });
    await app.waitForTimeout(1500);
    expect(await replies(g)).toEqual([]);
    await expect(confirmLine(app, 'a')).toHaveAttribute('data-confirm', 'idle');
    expect(a).toBe(1);
    expect(t.received()).toBe('');
  });

  test('review-23: the served page still talks through parent after the bridge key', async ({ app, core }) => {
    await installWidgetHost(app, core.home);
    await enable(core);
    target(core);
    webWidget(core, 'w', BRIDGE);
    allow(core, 'w', 'read');
    await open(app, core, 'w');
    const f = await frameAt(app, '/__widget/w-w-');
    const r = await replyTo(f, await call(f, 'context'));
    expect(r.ok).toEqual({ projects: [{ name: 'act' }], sessions: [{ label: 'target', project: 'act', state: 'running' }] });
    // Page code never sees the key: not on parent, not in what it posts.
    const seen = await f.evaluate(() => JSON.stringify(Object.getOwnPropertyNames(parent)) + String((parent as unknown as { key?: string }).key));
    expect(seen).not.toMatch(/key"|[0-9]+-[0-9]+-[0-9]+-[0-9]+/);
  });

  test('review-23: context is answered at most once per second', async ({ app, core }) => {
    await installWidgetHost(app, core.home);
    await enable(core);
    target(core);
    webWidget(core, 'w', BRIDGE);
    allow(core, 'w', 'read');
    await open(app, core, 'w');
    const f = await frameAt(app, '/__widget/w-w-');
    const first = await replyTo(f, await call(f, 'context'));
    expect(first.ok).toBeTruthy();
    expect((await replyTo(f, await call(f, 'context'))).error).toBe('one context per second');
    await app.waitForTimeout(1100);
    expect((await replyTo(f, await call(f, 'context'))).ok).toBeTruthy();
  });

  test('review-23: a target label that is not drawn as itself is refused', async ({ app, core }) => {
    await installWidgetHost(app, core.home);
    await enable(core);
    const t = target(core);
    webWidget(core, 'w', BRIDGE);
    allow(core, 'w', 'act');
    await open(app, core, 'w');
    const f = await frameAt(app, '/__widget/w-w-');
    expect((await replyTo(f, await call(f, 'act', { text: 'hi', session: '\u202etegrat' }))).error).toMatch(/invisible, bidi or control/);
    await app.waitForTimeout(1100);
    expect((await replyTo(f, await call(f, 'act', { text: 'hi', session: 'x'.repeat(257) }))).error).toMatch(/over 256 bytes/);
    await expect(confirmLine(app, 'w')).toHaveAttribute('data-confirm', 'idle');
    expect(t.received()).toBe('');
  });

  test('review-23: a confirm sends to the session it was raised for', async ({ app, core }) => {
    await installWidgetHost(app, core.home);
    await enable(core);
    const t = target(core);
    webWidget(core, 'w', BRIDGE);
    allow(core, 'w', 'act');
    await open(app, core, 'w');
    const f = await frameAt(app, '/__widget/w-w-');
    const id = await call(f, 'act', { text: 'to the first project', session: 'target' });
    const line = confirmLine(app, 'w');
    await expect(line).toHaveAttribute('data-confirm', 'open');
    // The placement follows a session in another project, which has its own session labelled "target".
    const other = core.shell(core.project('other'), 'target');
    await app.locator(`button.row.wt2[data-menu-session="${other.id}"]`).click(); // ticket 570: another project's tab is not in the strip
    await app.waitForTimeout(700);
    await line.getByRole('button', { name: 'Send' }).click();
    expect((await replyTo(f, id)).ok).toEqual({ status: 'delivered' });
    await expect.poll(t.received).toBe('to the first project');
    expect(sendLog(core, t.s.id).map((e) => e.sender)).toEqual(['widget:w']);
  });

  test('review-23: an approved host cannot redirect the widget to another host', async ({ app, core, browserName }) => {
    // The 302 can only come from a route (the hosts are *.nunchiro.test), and Playwright's WebKit refuses
    // route.fulfill with a redirect status ("Cannot fulfill with redirect status: 302").
    test.skip(browserName === 'webkit', 'Playwright WebKit cannot fulfill a route with a redirect status');
    await installWidgetHost(app, core.home);
    const seen: string[] = [];
    await app.route(/nunchiro\.test/, (r) => {
      const url = r.request().url();
      seen.push(url);
      if (url === 'https://api.nunchiro.test/hop')
        return r.fulfill({ status: 302, headers: { location: 'https://evil.nunchiro.test/take', 'access-control-allow-origin': '*' } });
      return r.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'evil data' });
    });
    await enable(core);
    webWidget(core, 'r', fs.readFileSync(path.join(import.meta.dirname, 'fixtures/web-widgets/review/redirect.html'), 'utf8'), ['api.nunchiro.test']);
    allow(core, 'r', 'read');
    await open(app, core, 'r');
    await expect.poll(() => app.frames().some((f) => f.url().includes('/__widget/w-r-'))).toBe(true);
    const f = app.frames().find((f) => f.url().includes('/__widget/w-r-'))!;
    await expect.poll(() => f.evaluate(() => (window as unknown as { result: string }).result), { timeout: 10_000 }).toBe('blocked');
    expect(seen).toEqual(['https://api.nunchiro.test/hop']);
  });
});
