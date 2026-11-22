// Ticket V2-10a: `![alt](path)` in assistant text renders inline through 05's Thumbnail and the core's confined
// `file_read`; remote URLs are link chips never loaded; anything else is a muted path chip. Real core, fake agent.
import fs from 'node:fs';
import path from 'node:path';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { frames, helpers } from './fixtures/images/helpers';

/** 4×3 red PNG (scripts/scenario/images.py `png(4, 3, (220, 0, 0))`). */
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4w8AARww4OQDTjwpRD8VS4AAAAABJRU5ErkJggg==', 'base64');
/** 600×800 JPEG: taller than the 240 px cap. */
const TALL = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/images/tall.jpg'));

/** Holds every `file_read` request in the page until `__release()`, so a test can look before images arrive. */
const holdReads = () => {
  const w = window as unknown as { __held: (() => void)[] | null; __release: () => void };
  w.__held = [];
  w.__release = () => {
    const h = w.__held!;
    w.__held = null;
    h.forEach((f) => f());
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const read = typeof data === 'string' && data.includes('"op":"file_read"');
    if (read && w.__held) return void w.__held.push(() => send.call(this, data));
    return send.call(this, data);
  };
};

test('md-image-raster-renders: PNG and JPEG by relative, absolute and saved path; height at most 240; click opens Preview', async ({ page, chatCore }) => {
  await page.addInitScript(helpers);
  const s = chatCore.chat();
  fs.mkdirSync(path.join(s.cwd, 'shots'));
  fs.writeFileSync(path.join(s.cwd, 'shots/red.png'), RED);
  fs.writeFileSync(path.join(s.cwd, 'tall.jpg'), TALL);
  const saved = path.join(chatCore.home, 'images', s.id, `${'c'.repeat(64)}.png`);
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, RED);
  const artifact = path.join(chatCore.home, 'artifacts', s.id, 'plot.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, RED);
  append(
    s.file,
    rec.assistant(`relative ![red](./shots/red.png)\n\nabsolute ![tall](${path.join(s.cwd, 'tall.jpg')})\n\nsaved ![s](${saved})\n\nartifact ![a](${artifact})`),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  for (const name of ['red.png', 'tall.jpg', `${'c'.repeat(64)}.png`, 'plot.png']) {
    const thumb = view.getByRole('button', { name: `Open image ${name}` });
    const img = thumb.locator('img');
    await thumb.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    const box = (await img.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(240);
    expect((await thumb.boundingBox())!.height).toBe(240);
  }
  // The tall JPEG is scaled to the cap, and decoded no larger than twice the box.
  const tall = view.getByRole('button', { name: 'Open image tall.jpg' }).locator('img');
  expect(Math.round((await tall.boundingBox())!.height)).toBe(240);
  expect(await tall.evaluate((i: HTMLImageElement) => i.naturalHeight)).toBeLessThanOrEqual(480);
  // A 4×3 image is not blown up to the box.
  expect((await view.getByRole('button', { name: 'Open image red.png' }).locator('img').boundingBox())!.height).toBeLessThanOrEqual(3);
  // Reads went through the core: the session folder for the first two, the data root for the saved one.
  const reads = (await frames(page)).filter((f) => f.op === 'file_read').map((f) => f.path);
  expect([...new Set(reads)].sort()).toEqual([`artifacts/${s.id}/plot.png`, `images/${s.id}/${'c'.repeat(64)}.png`, 'shots/red.png', 'tall.jpg']);
  await page.screenshot({ path: '../.scratch/shots/v2-10a-inline-images.png' });
  // One click opens Preview at the file.
  await view.getByRole('button', { name: 'Open image red.png' }).click();
  await expect(page.locator('.preview')).toHaveAttribute('data-path', 'shots/red.png');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('md-image-refusals: missing, outside-root, symlinked-out, SVG and remote show chips; nothing remote is requested', async ({ page, chatCore }) => {
  await page.addInitScript(helpers);
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((u: string) => ((window as unknown as { __opened: string[] }).__opened.push(u), null)) as typeof window.open;
  });
  const remote: string[] = [];
  page.on('request', (r) => r.url().includes('example.com') && remote.push(r.url()));
  const s = chatCore.chat();
  const outside = path.join(chatCore.home, 'outside.png');
  fs.writeFileSync(outside, RED);
  fs.symlinkSync(outside, path.join(s.cwd, 'link.png'));
  fs.writeFileSync(path.join(s.cwd, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  append(
    s.file,
    rec.assistant(
      ['![m](nope.png)', `![o](${outside})`, '![l](link.png)', '![v](x.svg)', '![up](../outside.png)', '![inline data](data:image/png;base64,AAAA)', '![remote pic](https://example.com/r.png)'].join('\n\n'),
    ),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  const chip = (p: string) => view.locator('.mdimg.off', { hasText: p });
  for (const p of ['nope.png', outside, 'link.png', 'x.svg', '../outside.png', 'inline data']) await expect(chip(p)).toBeVisible();
  // The chip shows the path that was checked: relative ones against the session folder.
  await expect(chip('nope.png')).toHaveAttribute('aria-label', new RegExp(`^Image ${s.cwd}/nope\\.png: `));
  await expect(view.locator('.md img')).toHaveCount(0);
  await expect(view.locator('.md .thumb')).toHaveCount(0);
  // Remote: a link chip that opens the browser; the image itself is never fetched.
  const link = view.getByRole('link', { name: 'remote pic' });
  await expect(link).toHaveAttribute('title', 'https://example.com/r.png');
  await link.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(['https://example.com/r.png']);
  expect(remote).toEqual([]);
  // Paths outside every root (absolute, or leading up and out) are never asked of the core.
  const reads = (await frames(page)).filter((f) => f.op === 'file_read').map((f) => f.path);
  expect([...new Set(reads)].sort()).toEqual(['link.png', 'nope.png', 'x.svg']);
});

test('md-image-no-jump: a scrolled-up chat does not move when inline images load', async ({ page, chatCore }) => {
  await page.addInitScript(holdReads);
  const s = chatCore.chat();
  fs.writeFileSync(path.join(s.cwd, 'tall.jpg'), TALL);
  fs.writeFileSync(path.join(s.cwd, 'red.png'), RED);
  const rows = Array.from({ length: 200 }, (_, i) => rec.assistant(i % 4 ? `메시지 ${i}` : `메시지 ${i} ![p](${i % 8 ? 'tall.jpg' : 'red.png'})`));
  append(s.file, rows);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('메시지 199', { exact: true })).toBeVisible();
  const scroller = view.locator('.cscroll');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Boxes are reserved before anything is read.
  const boxes = view.locator('.md .thumb');
  expect(await boxes.count()).toBeGreaterThan(1);
  await expect(view.locator('.md .thumb img')).toHaveCount(0);
  const row = await scroller.evaluate((el) => {
    const r = [...el.querySelectorAll<HTMLElement>('.crow')].find((e) => e.getBoundingClientRect().top >= el.getBoundingClientRect().top + 20)!;
    return { key: r.dataset.key!, y: Math.round(r.getBoundingClientRect().y) };
  });
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  const imgs = view.locator('.md .thumb img');
  await expect.poll(() => imgs.count()).toBeGreaterThan(1);
  await expect.poll(() => imgs.evaluateAll((all) => all.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const y = await view.locator(`.crow[data-key="${row.key}"]`).evaluate((e) => Math.round(e.getBoundingClientRect().y));
  expect(Math.abs(y - row.y)).toBeLessThanOrEqual(1);
});

// Round 2: a file under the core's 2 MB cap can still claim 30000×30000 pixels (GBs once decoded). The header is read
// first; over 40 megapixels, or a header with no readable size, is a chip and nothing is decoded.
const u16be = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, n >> 16];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
const riff = (chunk: string, body: number[]) => Buffer.from([...ascii('RIFF'), ...u32le(12 + body.length), ...ascii('WEBP'), ...ascii(chunk), ...u32le(body.length), ...body]);
const BOMBS: Record<string, Buffer> = {
  'bomb.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), 0, 0, 0x75, 0x30, 0, 0, 0x75, 0x30, 8, 2, 0, 0, 0, 0, 0, 0, 0]),
  'bomb.gif': Buffer.from([...ascii('GIF89a'), ...u16le(30000), ...u16le(30000), 0, 0, 0, 0x3b]),
  // A 1×1 screen whose frame claims 20000×20000, after a graphic control extension.
  'bomb-frame.gif': Buffer.from([...ascii('GIF89a'), ...u16le(1), ...u16le(1), 0, 0, 0, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...u16le(20000), ...u16le(20000), 0, 2, 2, 0x4c, 0x01, 0, 0x3b]),
  'bomb-x.webp': riff('VP8X', [0, 0, 0, 0, ...u24le(29999), ...u24le(29999)]),
  'bomb-l.webp': riff('VP8L', [0x2f, ...u32le(16383 | (16383 << 14))]),
  'bomb-v.webp': riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(16383), ...u16le(16383)]),
  'bomb.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, ...u16be(20000), ...u16be(20000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]),
};
/** Real 1×1 images the header reader must not refuse. */
const SMALL: Record<string, string> = {
  'ok.gif': 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'ok-lossy.webp': 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
  'ok-lossless.webp': 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
};

test('md-image-pixel-cap: a header over 40 megapixels or with no size is a chip and is never decoded', async ({ page, chatCore }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __decodes: number };
    w.__decodes = 0;
    const real = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...a: Parameters<typeof createImageBitmap>) => (w.__decodes++, real(...a))) as typeof createImageBitmap;
  });
  const s = chatCore.chat();
  for (const [n, b] of Object.entries(BOMBS)) fs.writeFileSync(path.join(s.cwd, n), b);
  for (const [n, b] of Object.entries(SMALL)) fs.writeFileSync(path.join(s.cwd, n), Buffer.from(b, 'base64'));
  fs.writeFileSync(path.join(s.cwd, 'nosize.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
  const names = [...Object.keys(BOMBS), 'nosize.png', ...Object.keys(SMALL)];
  append(
    s.file,
    { type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'pasted bomb' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BOMBS['bomb.png'].toString('base64') } }] } },
    rec.assistant(names.map((n) => `![${n}](${n})`).join('\n\n')),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  // Images load only within 400 px of the view (Thumbnail.tsx) and the chat opens at its end, ~2000 px below bomb.png.
  // Those near the end load first and re-measure the list; a scroll up in the same frame as a re-measure is taken for
  // the list's own correction (ChatView onScroll: `scrollTop < lastTop && scrollHeight === lastHeight`) and the chat
  // stays pinned. So scroll only in a frame where the list has settled: nothing in reach is loading and every row is
  // measured at its rendered height (the list reserves exactly what its rows take).
  const scrolledUpSettled = (e: HTMLElement) => {
    const r = e.getBoundingClientRect();
    const near = (b: Element) => b.getBoundingClientRect().bottom > r.top - 400 && b.getBoundingClientRect().top < r.bottom + 400;
    const list = e.querySelector<HTMLElement>('.clist')!;
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > .crow')].map((c) => [new DOMMatrix(getComputedStyle(c).transform).m42, c.offsetHeight]).sort((a, b) => a[0] - b[0]);
    const ends = [...rows.slice(1).map((x) => x[0]), list.offsetHeight];
    const settled = rows.length > 0 && ![...e.querySelectorAll('button.ithumb.inline[disabled]')].some(near) && rows.every(([top, h], k) => Math.abs(top + h - ends[k]) <= 1);
    if (settled) e.scrollTop = 0;
    return settled;
  };
  await expect.poll(() => view.locator('.cscroll').evaluate(scrolledUpSettled)).toBe(true);
  for (const n of Object.keys(BOMBS)) await expect(view.locator('.mdimg.off', { hasText: n })).toHaveAttribute('aria-label', /over 40 megapixels/);
  await expect(view.locator('.mdimg.off', { hasText: 'nosize.png' })).toHaveAttribute('aria-label', /size unreadable/);
  await expect(view.locator('.msg.user', { hasText: 'pasted bomb' }).locator('.thumb')).toHaveAttribute('aria-label', /over 40 megapixels/);
  for (const n of Object.keys(SMALL)) {
    const img = view.getByRole('button', { name: `Open image ${n}` }).locator('img');
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  }
  // Only the three real images were decoded.
  expect(await page.evaluate(() => (window as unknown as { __decodes: number }).__decodes)).toBe(Object.keys(SMALL).length);
});

test('md-image-scope: only the message’s own session folder and its own saved images are read; the title names what was read', async ({ page, chatCore }) => {
  await page.addInitScript(helpers);
  const a = chatCore.chat('a');
  const b = chatCore.chat('b');
  fs.writeFileSync(path.join(b.cwd, 'theirs.png'), RED);
  const own = path.join(chatCore.home, 'images', a.id, `${'d'.repeat(64)}.png`);
  const other = path.join(chatCore.home, 'images', b.id, `${'e'.repeat(64)}.png`);
  for (const f of [own, other]) fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, RED);
  // A lookalike outside the data folder: the data folder's file is what gets read, and the title says so.
  const lookalike = `/etc/images/${a.id}/${'d'.repeat(64)}.png`;
  append(a.file, rec.assistant([`![t](${path.join(b.cwd, 'theirs.png')})`, `![o](${other})`, `![l](${lookalike})`].join('\n\n')), rec.assistant('done'));
  await openChat(page, a.id);
  const view = chat(page, a.id);
  await expect(view.getByText('done')).toBeVisible();
  await expect(view.locator('.mdimg.off', { hasText: 'theirs.png' })).toHaveAttribute('aria-label', /outside the readable folders/);
  await expect(view.locator('.mdimg.off', { hasText: `${'e'.repeat(64)}.png` })).toHaveAttribute('aria-label', /outside the readable folders/);
  const shown = view.getByRole('button', { name: `Open image ${'d'.repeat(64)}.png` });
  await expect(shown.locator('img')).toBeVisible();
  await expect(shown).toHaveAttribute('title', `Nunchiro data folder: images/${a.id}/${'d'.repeat(64)}.png`);
  const reads = (await frames(page)).filter((f) => f.op === 'file_read').map((f) => f.path);
  expect([...new Set(reads)]).toEqual([`images/${a.id}/${'d'.repeat(64)}.png`]);
});
