// Ticket 371 item 22: any file reaches a prompt as @path, as text only. The real drop comes from Tauri's native event, so
// these fake that event at the IPC seam, as a WKWebView would deliver it (physical pixels). Only the real RC proves the OS side.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, showComposer, test, type Core } from './fixtures';
import { row, setup } from './fixtures/files/harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const DROP = 'tauri://drag-drop';
type Fake = { __calls: [string, Record<string, unknown>][]; __subs: [string, number][]; __emit: (event: string, payload: unknown) => void };

/** The app's IPC, on a 2x display, with the dialog answering `picked`. */
const fakeApp = (page: Page, picked: unknown = null) =>
  page.addInitScript((picked) => {
    const w = window as unknown as Fake & { __cbs: Map<number, (e: unknown) => void>; __TAURI_INTERNALS__: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__: unknown };
    Object.defineProperty(window, 'devicePixelRatio', { get: () => 2 });
    w.__calls = [];
    w.__cbs = new Map();
    w.__subs = [];
    let next = 1;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (w.__cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') w.__subs.push([args.event as string, args.handler as number]);
        if (cmd === 'plugin:dialog|open') return Promise.resolve(picked);
        return Promise.resolve(1);
      },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    };
    w.__emit = (event, payload) => w.__subs.filter(([e]) => e === event).forEach(([, h]) => w.__cbs.get(h)?.({ event, id: 1, payload }));
  }, picked);

const cbox = (app: Page) => app.locator('.cbox:visible').first();
const area = (app: Page) => cbox(app).locator('textarea:not(.hoff-edit)');
const subs = (app: Page) => app.evaluate((e) => (window as unknown as Fake).__subs.filter(([x]) => x === e).length, DROP);

/** Opens one agent's composer; `sent` collects every prompt or key write the window makes. */
async function start(app: Page, core: Core, fake = true, picked: unknown = null) {
  if (fake) await fakeApp(app, picked);
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && /"op":"send_(text|keys)"/.test(f.payload) && sent.push(f.payload)));
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(area(app)).toBeEditable();
  if (fake) await expect.poll(() => subs(app)).toBe(1);
  return sent;
}

/** A native drop at the middle of the composer, in physical pixels (the fake display is 2x). */
async function dropOnBox(app: Page, paths: string[]) {
  const b = (await cbox(app).boundingBox())!;
  await app.evaluate(([e, p]) => (window as unknown as Fake).__emit(e as string, p), [DROP, { paths, position: { x: (b.x + b.width / 2) * 2, y: (b.y + b.height / 2) * 2 } }] as const);
}

/** The HTML5 side of an OS drop of an image, should the webview deliver one. */
const html5Drop = (app: Page) =>
  cbox(app).evaluate((el, b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));

test('native_drop_inserts_once_at_the_composer_under_the_position', async ({ app, core }) => {
  await start(app, core);
  await dropOnBox(app, ['/tmp/a.log']);
  await expect(area(app)).toHaveValue('@/tmp/a.log ');
  await expect(area(app)).toBeFocused();
  // Typed text stays, and the next path is set apart from it.
  await area(app).fill('see');
  await dropOnBox(app, ['/tmp/b.pdf']);
  await expect(area(app)).toHaveValue('see @/tmp/b.pdf ');
  // A drop that lands outside a composer does nothing.
  await app.evaluate((e) => (window as unknown as Fake).__emit(e, { paths: ['/tmp/outside.log'], position: { x: 2, y: 2 } }), DROP);
  await app.waitForTimeout(200);
  await expect(area(app)).toHaveValue('see @/tmp/b.pdf ');
});

test('dropped_paths_are_text_only_quoted_and_never_raw_control_characters', async ({ app, core }) => {
  const sent = await start(app, core);
  await dropOnBox(app, ['/tmp/my file.log', '/tmp/bad\nname.log', '/tmp/tab\there.log', '/tmp/spa ce"quote.log', '/tmp/ok.log']);
  await expect(area(app)).toHaveValue('@"/tmp/my file.log" @/tmp/ok.log ');
  // What could not be written as a path is named, on one line, and goes nowhere else.
  const refused = cbox(app).locator('.ierr');
  await expect(refused).toContainText('bad');
  await expect(refused).toContainText('here.log');
  await expect(refused).toContainText('quote.log');
  expect(await refused.evaluate((e) => /[\n\t]/.test(e.textContent ?? ''))).toBe(false);
  await app.waitForTimeout(300);
  expect(sent).toEqual([]);
  await expect(cbox(app).locator('.ichip')).toHaveCount(0);
});

test('a_dropped_name_holding_an_invisible_format_character_is_not_inserted', async ({ app, core }) => {
  const sent = await start(app, core);
  await dropOnBox(app, [`/tmp/zero${String.fromCodePoint(0x200b)}width.log`, '/tmp/ok.log']);
  await expect(area(app)).toHaveValue('@/tmp/ok.log ');
  await expect(cbox(app).locator('.ierr')).toContainText('zero?width.log');
  expect(sent).toEqual([]);
});

test('a drop on a composer that cannot take input changes nothing', async ({ app, core }) => {
  await start(app, core);
  await area(app).evaluate((el: HTMLTextAreaElement) => (el.disabled = true));
  await dropOnBox(app, ['/tmp/a.log']);
  await app.waitForTimeout(200);
  await expect(area(app)).toHaveValue('');
});

test('os_image_drop_in_the_app_gives_one_path_and_no_chip', async ({ app, core }) => {
  await start(app, core);
  // Both routes fire: the RC decides whether WKWebView really delivers the HTML5 one with Tauri's native handler on.
  await html5Drop(app);
  await dropOnBox(app, ['/tmp/shot.png']);
  await expect(area(app)).toHaveValue('@/tmp/shot.png ');
  await app.waitForTimeout(300);
  await expect(cbox(app).locator('.ichip')).toHaveCount(0);
  await expect(cbox(app).locator('.ierr')).toHaveCount(0);
});

test('the browser build keeps image chips from a drop and the image menu row', async ({ app, core }) => {
  await start(app, core, false);
  await html5Drop(app);
  await expect(cbox(app).locator('.ichip')).toHaveCount(1);
  await expect(area(app)).toHaveValue('');
  await cbox(app).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(app.getByRole('menuitem', { name: 'Attach an image' })).toBeVisible();
  await expect(app.getByRole('menuitem', { name: 'Attach a file' })).toHaveCount(0);
});

test('plus_menu_in_the_app_inserts_the_picked_paths', async ({ app, core }) => {
  const sent = await start(app, core, true, ['/tmp/report.pdf', '/tmp/my notes.pdf']);
  await cbox(app).getByRole('button', { name: 'Add', exact: true }).click();
  await app.getByRole('menuitem', { name: 'Attach a file' }).click();
  await expect(area(app)).toHaveValue('@/tmp/report.pdf @"/tmp/my notes.pdf" ');
  const calls = await app.evaluate(() => (window as unknown as Fake).__calls.filter(([c]) => c === 'plugin:dialog|open').map(([, a]) => a));
  expect(calls).toEqual([{ options: { multiple: true } }]);
  expect(sent).toEqual([]);
});

test('a cancelled file picker leaves the box alone', async ({ app, core }) => {
  await start(app, core, true, null);
  await area(app).fill('kept');
  await cbox(app).getByRole('button', { name: 'Add', exact: true }).click();
  await app.getByRole('menuitem', { name: 'Attach a file' }).click();
  await app.waitForTimeout(200);
  await expect(area(app)).toHaveValue('kept');
});

test('files_row_drags_its_at_path_into_the_composer', async ({ app, core }) => {
  await setup(app, core, {
    extra: (dir) => {
      fs.writeFileSync(path.join(dir, 'my notes.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'bad\nname.txt'), 'x');
    },
  });
  await showComposer(app);
  await expect(area(app)).toBeEditable();
  await row(app, 'hello.ts').dragTo(area(app));
  await expect(area(app)).toHaveValue('@hello.ts');
  await area(app).fill('');
  await row(app, 'my notes.txt').dragTo(area(app));
  await expect(area(app)).toHaveValue('@"my notes.txt"');
  // A name that cannot be written as a path cannot be dragged at all.
  await expect(app.locator('.frow').filter({ hasText: 'bad' })).toHaveAttribute('draggable', 'false');
});
