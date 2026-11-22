// Ticket 203 (needs 171, 172; widget boundary): after the widget's frame navigates away its bridge is closed for good.
// The owner can press Reload: a fresh frame through the same path as a first load (same sandbox, same served URL),
// and the bridge opens once. Nothing reloads by itself.
import fs from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { installWidgetHost } from './fixtures/web-widgets/host';

const HERE = path.join(import.meta.dirname, 'fixtures/web-widgets');
const RECORDING_CLAUDE = `#!/usr/bin/env python3
import os, signal, sys, tty
if '--version' in sys.argv:
    print('2.1.310 (Claude Code)')
    sys.exit()
tty.setraw(0)
os.write(1, '\\u276f '.encode())
out = open('received.bin', 'wb')
while True:
    data = os.read(0, 4096)
    if not data:
        break
    out.write(data)
    out.flush()
`;
const view = (page: Page) => page.locator('[data-user-widget="w"]');
const bar = (page: Page) => view(page).locator('.ww-confirm');
const frames = (page: Page) => page.frames().filter((f) => f.url().includes('/__widget/w-w-'));
async function frameOf(app: Page): Promise<Frame> {
  await expect.poll(() => frames(app).length).toBe(1);
  const f = frames(app)[0];
  await expect.poll(() => f.evaluate(() => typeof (window as unknown as { call?: unknown }).call)).toBe('function');
  return f;
}
const call = (f: Frame, method: string, params?: unknown) => f.evaluate(([m, p]) => (window as unknown as { call: (m: string, p: unknown) => number }).call(m as string, p), [method, params] as const);
const replies = (f: Frame) => f.evaluate(() => (window as unknown as { replies: () => { id: number; ok?: unknown; error?: string }[] }).replies());

async function setup(app: Page, core: Core) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), web_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
  fs.writeFileSync(path.join(core.home, 'bin/claude'), RECORDING_CLAUDE, { mode: 0o700 });
  core.cli('session', 'start', '--kind', 'claude', '--project', core.project('act'), '--label', 'target');
  const host = await installWidgetHost(app, core.home);
  const dir = path.join(core.home, 'widgets', 'w');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), `version = 1\nkind = "web"\nauthor = "test"\nentry = "index.html"\npermissions = ["read", "act"]\nnetwork = []\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), fs.readFileSync(path.join(HERE, 'bridge.html'), 'utf8'));
  core.run(['widget', 'allow', 'w', '--act']);
  await openWindow(app, core.boot(), core);
  core.cli('layout', ...'split right widget:w --zone terminal'.split(' '));
  return host;
}

test('webwidget_reload_same_boundary: Reload gives a fresh frame under the same sandbox and URL', async ({ app, core }) => {
  const host = await setup(app, core);
  const first = await frameOf(app);
  const iframe = view(app).locator('iframe');
  const src = await iframe.getAttribute('src');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  // On its served page there is nothing to reload.
  await expect(view(app).getByRole('button', { name: 'Reload widget' })).toHaveCount(0);
  await iframe.evaluate((e) => e.setAttribute('data-first', ''));
  // The frame leaves its served page: the bridge closes and the status offers Reload.
  await first.evaluate(() => location.reload());
  await expect.poll(() => host.served.filter((s) => s.status === 200).length).toBe(2);
  await expect(bar(app)).toContainText('went to another address');
  const reload = view(app).getByRole('button', { name: 'Reload widget' });
  await expect(reload).toHaveText('Reload');
  // Nothing reloads by itself.
  await app.waitForTimeout(1200);
  expect(host.served.filter((s) => s.status === 200)).toHaveLength(2);
  await reload.click();
  // A new element, the same boundary.
  await expect(view(app).locator('iframe[data-first]')).toHaveCount(0);
  await expect(view(app).locator('iframe')).toHaveCount(1);
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await iframe.getAttribute('src')).toBe(src);
  await expect.poll(() => host.served.filter((s) => s.status === 200).length).toBe(3);
  await expect(view(app).getByRole('button', { name: 'Reload widget' })).toHaveCount(0);
  await expect(bar(app)).toHaveAttribute('data-confirm', 'idle');
  await expect(bar(app)).not.toContainText('went to another address');
  // The bridge opens once: one context reply, one confirm that cancels with one reply.
  const g = await frameOf(app);
  const a = await call(g, 'context');
  await expect.poll(async () => (await replies(g)).filter((r) => r.id === a).length).toBe(1);
  await app.waitForTimeout(800);
  expect((await replies(g)).filter((r) => r.id === a)).toHaveLength(1);
  const b = await call(g, 'act', { text: 'after reload', session: 'target' });
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await bar(app).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await replies(g)).filter((r) => r.id === b)).toEqual([{ nunchiro: 1, id: b, error: 'cancelled' }]);
  await expect(bar(app)).toHaveAttribute('data-confirm', 'idle');
  // Only the one-load rule: the new frame navigating away closes the bridge again, and Reload is offered again.
  await g.evaluate(() => location.reload());
  await expect(bar(app)).toContainText('went to another address');
  await expect(view(app).getByRole('button', { name: 'Reload widget' })).toBeVisible();
});

/** The window's socket, with the requests whose text contains `__hold` held (released by `__release`). */
const holdSockets = (app: Page) =>
  app.addInitScript(() => {
    if (window.top !== window) return;
    const w = window as unknown as { __hold: string; __held: (() => void)[]; __release: () => void };
    w.__hold = '';
    w.__held = [];
    w.__release = () => w.__held.splice(0).forEach((f) => f());
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
      if (w.__hold && typeof data === 'string' && data.includes(w.__hold)) w.__held.push(() => send.call(this, data));
      else send.call(this, data);
    };
  });
const hold = (app: Page, op: string) => app.evaluate((o) => ((window as unknown as { __hold: string }).__hold = o), op);
const held = (app: Page) => app.evaluate(() => (window as unknown as { __held: unknown[] }).__held.length);
const release = (app: Page) => app.evaluate(() => (window as unknown as { __release: () => void }).__release());

// Preflight: an act the old frame raised, still waiting for the core's grant check when the owner presses Reload,
// must not raise a confirm (or post a reply) into the new frame.
test('webwidget_reload_drops_stale_act: an in-flight act of the old frame does nothing after Reload', async ({ app, core }) => {
  await holdSockets(app);
  await setup(app, core);
  const first = await frameOf(app);
  await hold(app, 'widget_page');
  await call(first, 'act', { text: 'from the old frame', session: 'target' });
  await expect.poll(() => held(app)).toBe(1);
  await first.evaluate(() => location.reload());
  await expect(bar(app)).toContainText('went to another address');
  await hold(app, '');
  await view(app).getByRole('button', { name: 'Reload widget' }).click();
  const g = await frameOf(app);
  await release(app); // the old act's grant check now answers
  await app.waitForTimeout(1500);
  await expect(bar(app)).toHaveAttribute('data-confirm', 'idle');
  expect(await replies(g)).toEqual([]);
  // The new frame's own act works, once.
  const id = await call(g, 'act', { text: 'from the new frame', session: 'target' });
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await expect(view(app).locator('.ww-text')).toHaveText('from the new frame');
  await bar(app).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await replies(g)).map((r) => r.id)).toEqual([id]);
});

// Review MUST (round 2): a Send already in flight (the core has the act) when the frame navigates away and the owner
// presses Reload. Its answer belongs to the old frame: it must not be posted into the new frame (ids restart, so it
// would answer an unrelated call). Settings5 item 3: the old Send keeps the widget's hold until it settles, so the new
// frame's act is busy meanwhile and starts only after it.
test('webwidget_reload_drops_inflight_send: a Send in flight when Reload is pressed answers nothing in the new frame', async ({ app, core }) => {
  await holdSockets(app);
  await setup(app, core);
  const first = await frameOf(app);
  const oldId = await call(first, 'act', { text: 'from the old frame', session: 'target' });
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await app.waitForTimeout(700); // Send arms after ARM_MS
  await hold(app, 'widget_act');
  await bar(app).getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => held(app)).toBe(1); // the core has the act; its answer is pending
  await hold(app, '');
  await first.evaluate(() => location.reload());
  await expect(bar(app)).toContainText('went to another address');
  await view(app).getByRole('button', { name: 'Reload widget' }).click();
  const g = await frameOf(app);
  await app.waitForTimeout(1100); // one act per second per widget
  // Settings5 item 3: the old Send is still in the core, so it keeps the widget's hold across Reload and the new
  // frame's act is busy. Its call has the same id the old one had (ids restart in a new frame).
  const newId = await call(g, 'act', { text: 'from the new frame', session: 'target' });
  expect(newId).toBe(oldId);
  await expect.poll(async () => (await replies(g)).find((r) => r.id === newId)?.error).toBe('busy');
  await expect(bar(app)).toHaveAttribute('data-confirm', 'idle');
  await release(app); // the old Send's answer arrives now
  // The note still updates for the owner; the old answer is posted nowhere (the only reply is the busy one above).
  await expect(bar(app).locator('[data-act-note]')).toContainText('sent to session “target”');
  expect(await replies(g)).toEqual([{ nunchiro: 1, id: newId, error: 'busy' }]);
  // The old finish released the hold once: the new frame's act now starts, and takes it for itself.
  await app.waitForTimeout(1100);
  const mine = await call(g, 'act', { text: 'from the new frame, again', session: 'target' });
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await expect(view(app).locator('.ww-text')).toHaveText('from the new frame, again');
  const second = await call(g, 'act', { text: 'second', session: 'target' });
  await expect.poll(async () => (await replies(g)).find((r) => r.id === second)?.error).toBe('busy');
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await bar(app).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await replies(g)).find((r) => r.id === mine)).toEqual({ nunchiro: 1, id: mine, error: 'cancelled' });
});

// Settings5 item 3 (widget boundary): one pending act per widget holds across Reload. A Send the core still has in flight
// keeps the widget's hold when the owner presses Reload; a second act is refused as busy (the reply the widget already
// gives) and raises no second confirm, until the first call settles. Then the hold is released once and a new act starts.
test('reload_keeps_hold_until_act_settles: a Send in flight keeps the widget busy across Reload', async ({ app, core }) => {
  await holdSockets(app);
  await setup(app, core);
  const first = await frameOf(app);
  await call(first, 'act', { text: 'first act', session: 'target' });
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await app.waitForTimeout(700); // Send arms after ARM_MS
  await hold(app, 'widget_act');
  await bar(app).getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => held(app)).toBe(1); // the act is in flight; its answer is pending
  await hold(app, '');
  await first.evaluate(() => location.reload());
  await expect(bar(app)).toContainText('went to another address');
  await view(app).getByRole('button', { name: 'Reload widget' }).click();
  const g = await frameOf(app);
  await app.waitForTimeout(1100); // one act per second per widget: the refusal below is the hold, not the rate limit
  const refused = await call(g, 'act', { text: 'second act', session: 'target' });
  await expect.poll(async () => (await replies(g)).find((r) => r.id === refused)?.error).toBe('busy');
  await expect(bar(app)).toHaveAttribute('data-confirm', 'idle'); // no second confirm opened
  expect(await held(app)).toBe(1);
  await release(app); // the first act settles
  await expect(bar(app).locator('[data-act-note]')).toContainText('sent to session “target”');
  // Released once: a new act now starts, and while its confirm is open a further one is busy again.
  await app.waitForTimeout(1100);
  const next = await call(g, 'act', { text: 'third act', session: 'target' });
  await expect(bar(app)).toHaveAttribute('data-confirm', 'open');
  await expect(view(app).locator('.ww-text')).toHaveText('third act');
  const again = await call(g, 'act', { text: 'fourth act', session: 'target' });
  await expect.poll(async () => (await replies(g)).find((r) => r.id === again)?.error).toBe('busy');
  await bar(app).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await replies(g)).find((r) => r.id === next)).toEqual({ nunchiro: 1, id: next, error: 'cancelled' });
});
