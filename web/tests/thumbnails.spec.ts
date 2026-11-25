// Ticket v1b-05: image chips in the composer and thumbnails in chat (spec v1b Acceptance 5, window half).
// Real core; images are generated in the page and handed to the composer as a paste or drop event's own data,
// so no test reads or writes the system clipboard.
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { expect, openWindow, test, showComposer } from './fixtures';
import { append, chat, test as chatTest, openChat, rec } from './fixtures/chat/harness';
import { frames, give, helpers, ptyWrites, type Spec } from './fixtures/images/helpers';

const PNG = (seed = 1, name = 'shot.png'): Spec => ({ png: [40, 30, seed, name] });
const chips = (page: Page) => page.locator('.cbox .ichip');
const alert = (page: Page) => page.locator('.cbox .ierr');
const saved = (home: string, session: string) => {
  const dir = path.join(home, 'images', session);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

async function start(app: Page, core: { shell: (p: string, l: string) => { id: string }; project: (n: string) => string }) {
  await app.addInitScript(helpers);
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator('.cbox textarea').focus();
  return a;
}

test('thumbnails paste shows chip (and drop), with the image, its name and a ✕', async ({ app, core }) => {
  const a = await start(app, core);
  await give(app, [PNG(1, 'first.png')]);
  await expect(chips(app)).toHaveCount(1);
  await expect(chips(app).first()).toContainText('first.png');
  await expect(chips(app).first().locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await chips(app).first().locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth > 0)).toBe(true);
  await give(app, [PNG(2, 'dropped.png')], 'drop');
  await expect(chips(app)).toHaveCount(2);
  await expect(chips(app).nth(1)).toContainText('dropped.png');
  await expect(app.getByRole('button', { name: 'Remove image first.png' })).toBeVisible();
  await app.screenshot({ path: '../.scratch/shots/v1b-05-composer-two-chips.png' });
  expect(await ptyWrites(app)).toEqual([]);
  expect(core.read(a.id)).toBe('');
});

test('no send without Enter: paste, chip ✕ by keyboard and drop write nothing to the PTY', async ({ app, core }) => {
  const a = await start(app, core);
  await give(app, [PNG(1, 'one.png'), PNG(2, 'two.png')]);
  await expect(chips(app)).toHaveCount(2);
  // ✕ is a real button: Tab reaches it, Enter and Space press it.
  const x = app.getByRole('button', { name: 'Remove image one.png' });
  await x.focus();
  await app.keyboard.press('Enter');
  await expect(chips(app)).toHaveCount(1);
  await app.getByRole('button', { name: 'Remove image two.png' }).focus();
  await app.keyboard.press('Space');
  await expect(chips(app)).toHaveCount(0);
  await give(app, [PNG(3, 'three.png')], 'drop');
  await expect(chips(app)).toHaveCount(1);
  await app.waitForTimeout(400);
  expect(await ptyWrites(app)).toEqual([]);
  expect((await frames(app)).filter((f) => f.op === 'image_put')).toEqual([]);
  expect(core.read(a.id)).toBe('');
  expect(saved(core.home, a.id)).toEqual([]);
});

test('Enter saves then sends path: one write, after the upload, carrying each path once in chip order', async ({ app, core }) => {
  const a = await start(app, core);
  await give(app, [PNG(1, 'a.png'), PNG(2, 'b.png')]);
  await expect(chips(app)).toHaveCount(2);
  await app.keyboard.type('look');
  await app.keyboard.press('Enter');
  await expect(chips(app)).toHaveCount(0);
  await expect.poll(async () => (await ptyWrites(app)).length).toBe(2);
  const f = await frames(app);
  const writes = f.filter((x) => x.op === 'send_text');
  expect(writes).toHaveLength(1);
  const puts = f.filter((x) => x.op === 'image_put');
  expect(puts.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...puts.map((p) => p.at))).toBeLessThan(writes[0].at);
  expect(f.findIndex((x) => x.op === 'send_keys')).toBeGreaterThan(f.findIndex((x) => x.op === 'send_text'));
  const lines = writes[0].text!.split('\n');
  expect(lines[0]).toBe('look');
  expect(lines).toHaveLength(3);
  const files = saved(core.home, a.id);
  expect(files).toHaveLength(2);
  for (const p of lines.slice(1)) {
    expect(p.startsWith(path.join(core.home, 'images', a.id) + '/')).toBe(true);
    expect(writes[0].text!.split(p).length - 1).toBe(1);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  }
  expect(fs.statSync(path.join(core.home, 'images')).mode & 0o777).toBe(0o700);
  await expect(app.locator('.cbox textarea')).toHaveValue('');
});

test('Enter with only images sends the paths only', async ({ app, core }) => {
  await start(app, core);
  await give(app, [PNG(5, 'only.png')]);
  await expect(chips(app)).toHaveCount(1);
  await app.keyboard.press('Enter');
  await expect.poll(async () => (await ptyWrites(app)).length).toBe(2);
  const text = (await ptyWrites(app))[0].text!;
  expect(text).toMatch(/^\/.*\/images\/[^/]+\/[0-9a-f]{64}\.png$/);
});

test('the same image twice saves once and both sends carry the same path', async ({ app, core }) => {
  const a = await start(app, core);
  for (let i = 0; i < 2; i++) {
    await give(app, [PNG(9, 'same.png')]);
    await expect(chips(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(chips(app)).toHaveCount(0);
    await expect.poll(async () => (await ptyWrites(app)).length).toBe(2 * (i + 1));
  }
  const [one, two] = (await ptyWrites(app)).filter((f) => f.op === 'send_text').map((f) => f.text);
  expect(one).toBe(two);
  expect(saved(core.home, a.id)).toHaveLength(1);
});

test('an image over the cap is refused with a message and no chip', async ({ app, core }) => {
  await start(app, core);
  await give(app, [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name: 'huge.png', type: 'image/png', pad: 20 * 1024 * 1024 }]);
  await expect(alert(app)).toContainText('huge.png: over the 20 MB image limit');
  await expect(chips(app)).toHaveCount(0);
});

test('bytes that do not match the type, and SVG or HTML pasted as an image, are refused', async ({ app, core }) => {
  await start(app, core);
  const svg = [...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')];
  const html = [...new TextEncoder().encode('<!doctype html><img src=x onerror=alert(1)>')];
  await give(app, [{ bytes: [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0], name: 'liar.png', type: 'image/png' }]);
  await expect(alert(app)).toContainText('liar.png: the file is not the PNG image it says it is');
  await give(app, [{ bytes: svg, name: 'x.svg', type: 'image/svg+xml' }]);
  await expect(alert(app)).toContainText('x.svg: only PNG, JPEG, GIF or WebP');
  await give(app, [{ bytes: html, name: 'x.html', type: 'text/html' }]);
  await expect(alert(app)).toContainText('x.html: only PNG, JPEG, GIF or WebP');
  await expect(chips(app)).toHaveCount(0);
});

test('a 900 KB and a 9 MB image both save, in pieces under the 1 MiB message cap', async ({ app, core }) => {
  test.setTimeout(90_000);
  const a = await start(app, core);
  await give(app, [{ png: [548, 548, 3, 'mid.png'] }, { png: [1733, 1733, 4, 'big.png'] }]);
  await expect(chips(app)).toHaveCount(2, { timeout: 20_000 });
  await app.keyboard.press('Enter');
  await expect.poll(async () => (await ptyWrites(app)).length, { timeout: 60_000 }).toBe(2);
  const sizes = saved(core.home, a.id)
    .map((f) => fs.statSync(path.join(core.home, 'images', a.id, f)).size)
    .sort((x, y) => x - y);
  expect(sizes).toHaveLength(2);
  expect(sizes[0]).toBeGreaterThan(880_000);
  expect(sizes[0]).toBeLessThan(940_000);
  expect(sizes[1]).toBeGreaterThan(9_000_000);
  expect(sizes[1]).toBeLessThan(9_200_000);
});

test('✕ during upload cancels without sending and keeps the text', async ({ app, core }) => {
  test.setTimeout(90_000);
  const a = await start(app, core);
  await give(app, [{ png: [1733, 1733, 6, 'slow.png'] }]);
  await expect(chips(app)).toHaveCount(1, { timeout: 20_000 });
  await app.keyboard.type('keep me');
  await app.keyboard.press('Enter');
  await expect(chips(app).first()).toHaveAttribute('data-saving', '');
  await app.getByRole('button', { name: 'Remove image slow.png' }).click();
  await expect(alert(app)).toContainText('nothing was sent');
  await app.waitForTimeout(500);
  expect(await ptyWrites(app)).toEqual([]);
  await expect(app.locator('.cbox textarea')).toHaveValue('keep me');
  expect(core.read(a.id)).toBe('');
});

test('✕ on a waiting chip while another uploads drops only that one: the PTY gets the text and the kept path', async ({ app, core }) => {
  test.setTimeout(90_000);
  const a = await start(app, core);
  await give(app, [{ png: [1733, 1733, 7, 'first.png'] }, PNG(8, 'second.png')]);
  await expect(chips(app)).toHaveCount(2, { timeout: 20_000 });
  await app.keyboard.type('two');
  await app.keyboard.press('Enter');
  await expect(chips(app).first()).toHaveAttribute('data-saving', '');
  await app.getByRole('button', { name: 'Remove image second.png' }).click();
  await expect.poll(async () => (await ptyWrites(app)).length, { timeout: 60_000 }).toBe(2);
  const text = (await ptyWrites(app))[0].text!;
  const lines = text.split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe('two');
  expect(saved(core.home, a.id)).toEqual([path.basename(lines[1])]);
  await expect(chips(app)).toHaveCount(0);
});

test('removing every chip during upload sends nothing and keeps the text', async ({ app, core }) => {
  test.setTimeout(90_000);
  const a = await start(app, core);
  await give(app, [{ png: [1733, 1733, 9, 'big.png'] }, PNG(10, 'small.png')]);
  await expect(chips(app)).toHaveCount(2, { timeout: 20_000 });
  await app.keyboard.type('none');
  await app.keyboard.press('Enter');
  await expect(chips(app).first()).toHaveAttribute('data-saving', '');
  await app.getByRole('button', { name: 'Remove image small.png' }).click();
  await app.getByRole('button', { name: 'Remove image big.png' }).click();
  await expect(alert(app)).toContainText('nothing was sent');
  await app.waitForTimeout(500);
  expect(await ptyWrites(app)).toEqual([]);
  await expect(app.locator('.cbox textarea')).toHaveValue('none');
  expect(core.read(a.id)).toBe('');
});

async function ime(app: Page): Promise<CDPSession> {
  return app.context().newCDPSession(app);
}

test('Hangul composition in progress when an image is pasted keeps the composition', { tag: '@chromium' }, async ({ app, core }) => {
  const a = await start(app, core);
  const cdp = await ime(app);
  await cdp.send('Input.insertText', { text: '사진 ' });
  await cdp.send('Input.imeSetComposition', { text: '봐', selectionStart: 1, selectionEnd: 1 });
  await give(app, [PNG(1, 'mid-ime.png')]);
  await expect(chips(app)).toHaveCount(1);
  await expect(app.locator('.cbox textarea')).toHaveValue('사진 봐');
  await cdp.send('Input.insertText', { text: '봐' });
  await expect(app.locator('.cbox textarea')).toHaveValue('사진 봐');
  // The Enter that commits a syllable is the IME's: with chips present it still does not send.
  await cdp.send('Input.insertText', { text: '줘' });
  await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: 1, selectionEnd: 1 });
  await app.locator('.cbox textarea').evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
  });
  await cdp.send('Input.insertText', { text: '요' });
  await app.waitForTimeout(300);
  expect(await ptyWrites(app)).toEqual([]);
  expect((await frames(app)).filter((f) => f.op === 'image_put')).toEqual([]);
  await expect(chips(app)).toHaveCount(1);
  await expect(app.locator('.cbox textarea')).toHaveValue('사진 봐줘요');
  await app.locator('.cbox textarea').press('Enter');
  await expect.poll(async () => (await ptyWrites(app)).length).toBe(2);
  expect((await ptyWrites(app))[0].text).toMatch(/^사진 봐줘요\n\/.*\.png$/);
  expect(core.read(a.id)).toContain('사진 봐줘요');
});

test('prefix keys with a Korean input source still work with chips present', async ({ app, core }) => {
  await app.addInitScript(helpers);
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator('.cbox textarea').focus();
  await give(app, [PNG(1, 'k.png')]);
  await expect(chips(app)).toHaveCount(1);
  const physical = (init: { code: string; key: string; ctrlKey?: boolean; keyCode?: number }) =>
    app.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);
  await physical({ code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await expect(app.locator('.prefix-armed')).toBeVisible();
  await physical({ code: 'KeyN', key: 'Process', keyCode: 229 });
  await expect.poll(() => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab')).toBe(ids[1]);
  expect(await ptyWrites(app)).toEqual([]);
  expect(core.read(ids[0])).toBe('');
});

// Chat half: the user block's thumbnails from the transcript.
/** 4×3 red PNG (scripts/scenario/images.py `png(4, 3, (220, 0, 0))`). */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4w8AARww4OQDTjwpRD8VS4AAAAABJRU5ErkJggg==';
const userWith = (text: string, ...sources: unknown[]) => ({
  type: 'user',
  uuid: crypto.randomUUID(),
  message: { role: 'user', content: [{ type: 'text', text }, ...sources.map((source) => ({ type: 'image', source }))] },
});

chatTest('thumbnail appears from the transcript: base64, saved path and session-folder path; others are named placeholders', async ({ page, chatCore }) => {
  await page.addInitScript(helpers);
  const s = chatCore.chat();
  // A saved image (as the composer saves it) and one in the session folder (as Codex names a local image).
  const red = Buffer.from(RED_PNG, 'base64');
  const savedPath = path.join(chatCore.home, 'images', s.id, `${'a'.repeat(64)}.png`);
  fs.mkdirSync(path.dirname(savedPath), { recursive: true });
  fs.writeFileSync(savedPath, red);
  fs.writeFileSync(path.join(s.cwd, 'local.png'), red);
  const outside = path.join(chatCore.home, 'outside.png');
  fs.writeFileSync(outside, red);
  append(
    s.file,
    userWith('base64 image', { type: 'base64', media_type: 'image/png', data: RED_PNG }),
    rec.user(`saved by the composer\n${savedPath}`),
    userWith('codex local', { type: 'path', path: path.join(s.cwd, 'local.png') }),
    userWith('outside roots', { type: 'path', path: outside }),
    userWith('broken base64', { type: 'base64', media_type: 'image/png', data: 'bm90IGFuIGltYWdl' }),
    userWith('remote', { type: 'url', url: 'https://example.com/x.png' }),
    // Only a whole line that is an absolute local path counts as a saved path; a URL ending like one does not.
    rec.user(`url lookalike\nhttps://evil.example/images/${s.id}/${'b'.repeat(64)}.png`),
    // A dot-dot path that starts inside the session folder is still outside it: never sent to the core.
    userWith('dot dot', { type: 'path', path: `${s.cwd}/../../outside.png` }),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  const row = (t: string) => view.locator('.msg.user', { hasText: t });
  for (const t of ['base64 image', 'saved by the composer', 'codex local']) {
    const img = row(t).locator('.thumb img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    expect((await row(t).locator('.thumb').boundingBox())!.height).toBe(42);
  }
  await expect(row('outside roots').locator('.thumb')).toHaveAttribute('aria-label', 'Image outside.png: outside the readable folders');
  await expect(row('broken base64').locator('.thumb')).toHaveAttribute('aria-label', 'Image png image: image could not be decoded');
  await expect(row('remote').locator('.thumb')).toHaveAttribute('aria-label', /remote image not loaded/);
  await expect(row('url lookalike').locator('.thumb')).toHaveCount(0);
  await expect(row('dot dot').locator('.thumb')).toHaveAttribute('aria-label', 'Image outside.png: outside the readable folders');
  for (const t of ['outside roots', 'broken base64', 'remote', 'dot dot']) {
    await expect(row(t).locator('.thumb img')).toHaveCount(0);
    expect((await row(t).locator('.thumb').boundingBox())!.height).toBe(42);
  }
  // Reads went to the data root and the session folder only; nothing outside the roots was asked of the core.
  const reads = (await frames(page)).filter((f) => f.op === 'file_read').map((f) => f.path);
  expect(reads.sort()).toEqual([`images/${s.id}/${'a'.repeat(64)}.png`, 'local.png']);
  await page.screenshot({ path: '../.scratch/shots/v1b-05-chat-thumbnails.png' });
});

chatTest('a click opens the full-size image; Esc closes it and focus returns to the thumbnail', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, userWith('see this', { type: 'base64', media_type: 'image/png', data: RED_PNG }), rec.assistant('ok'));
  await openChat(page, s.id);
  const thumb = chat(page, s.id).getByRole('button', { name: 'Open image png image' });
  await expect(thumb.locator('img')).toBeVisible();
  await thumb.click();
  const dialog = page.getByRole('dialog', { name: 'Image png image' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toHaveAttribute('src', `data:image/png;base64,${RED_PNG}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(thumb).toBeFocused();
});
