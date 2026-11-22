// Ticket v1b-09: Files explorer and read-only viewer. Real core (`files_list`, `file_read`), a `cat` shell session
// whose folder holds the fixtures. Playwright drives a browser, not WKWebView: HTML runs in V1B-04's test server
// (same CSP files and bootstrap, see sandbox-server.ts) behind a same-origin route, standing in for the app's
// `nunchiro-artifact` scheme and `artifact_open`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sameContent, viewOf } from '../src/files/api';
import { parse } from '../src/settings';
import { expect, goTab, ORIGIN, test, showComposer, stripOnTop } from './fixtures';
import { FIX, openAt, openFile, physical, row, setup, view } from './fixtures/files/harness';
import { CSP_DEFAULT } from './sandbox-server';

test('files opens text', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  await expect(v).toHaveAttribute('data-view', 'text');
  await expect(v.locator('.cm-content')).toContainText('export function hello(name: string): string {');
  await expect(v.locator('.cm-content')).toContainText('안녕, ${name}');
  // shiki colours arrive on demand as marks; a keyword and a comment differ in colour.
  await expect(v.locator('.cm-content .sh').first()).toBeVisible();
  const colours = await v.locator('.cm-content .sh').evaluateAll((els) => new Set(els.map((e) => getComputedStyle(e).color)).size);
  expect(colours).toBeGreaterThan(2);
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('hello.ts');
});

test('files opens markdown (rendered and source)', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'README.md');
  const v = view(app, 'README.md');
  await expect(v.locator('.fv-md h1')).toHaveText('Files fixture');
  await expect(v.locator('.fv-md li')).toHaveCount(2);
  // Raw HTML is off: the tag shows as text, never as an element.
  await expect(v.locator('.fv-md b')).toHaveCount(0);
  await expect(v.locator('.fv-md')).toContainText('<b>raw html stays text</b>');
  await v.getByRole('button', { name: 'Source' }).click();
  await expect(v.locator('.cm-content')).toContainText('# Files fixture');
  await v.getByRole('button', { name: 'Rendered' }).click();
  await expect(v.locator('.fv-md h1')).toBeVisible();
});

test('files opens png', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'dot.png');
  const img = view(app, 'dot.png').locator('img');
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(4);
});

test('files opens svg', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'logo.svg');
  const v = view(app, 'logo.svg');
  const img = v.locator('img');
  await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(40);
  // Never inline DOM: no <svg> in the window, and its script never ran.
  expect(await app.locator('.fview svg').count()).toBe(0);
  expect(await app.evaluate(() => (window as { __svgRan?: boolean }).__svgRan)).toBeUndefined();
});

test('files opens html in sandbox', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'page.html');
  const v = view(app, 'page.html');
  const frame = v.locator('.artifact-frame iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const body = app.frameLocator('.fview[data-file="page.html"] iframe');
  await expect(body.locator('#h')).toHaveText('Hello from page.html');
  await expect(body.locator('#h')).toHaveAttribute('data-ran', 'yes');
  // 04's default policy, from the very CSP file the app embeds.
  const csp = await app.evaluate(async () => (await fetch('/__artifact/f0')).headers.get('content-security-policy'));
  expect(csp).toBe(CSP_DEFAULT);
  // Opaque origin: the page cannot reach the window.
  expect(await body.locator('body').evaluate(() => { try { return String(window.parent.document); } catch { return 'blocked'; } })).toBe('blocked');
});

// S2-1 (look v35 c): the app serves the page from its own scheme, another origin than the window. The window's
// meta CSP had no frame-src, so default-src 'self' refused the frame and WKWebView showed an empty white box.
test('files html loads from the app scheme origin under the window CSP', async ({ app, core }) => {
  await setup(app, core, { artifactOrigin: 'http://nunchiro-artifact.localhost' });
  await openFile(app, 'page.html');
  const body = app.frameLocator('.fview[data-file="page.html"] iframe');
  await expect(body.locator('#h')).toHaveText('Hello from page.html');
  // macOS uses `nunchiro-artifact:`, which no test browser can serve. Both policies apply in the app and intersect, so
  // the window's meta must state every directive of the app's own policy (tauri.conf.json) with the same sources. The
  // one difference: the meta's frame-src adds 'self' (the same-origin test frames; inert in the app, whose header lacks it).
  const conf = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../app/src-tauri/tauri.conf.json'), 'utf8'));
  const directives = (csp: string) =>
    Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...sources]) => [name, [...sources].sort()]));
  const meta = directives((await app.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ?? '');
  const own = directives(conf.app.security.csp);
  expect(own['frame-src']?.length).toBeGreaterThan(0);
  expect(meta).toEqual({ ...own, 'frame-src': [...own['frame-src'], "'self'"].sort() });
});

test('files opens binary as name and size', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'blob.bin');
  const v = view(app, 'blob.bin');
  await expect(v).toHaveAttribute('data-view', 'binary');
  await expect(v.locator('.fv-meta')).toContainText('blob.bin');
  await expect(v.locator('.fv-meta')).toContainText('13 B · binary, not shown');
  await expect(v.getByRole('button', { name: 'Reveal in Finder' })).toBeEnabled();
});

test('files opens 5 MB as name, size and reveal', async ({ app, core }) => {
  const { dir, revealed } = await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, 'big.log'), 'x'.repeat(5 * 1024 * 1024)) });
  await openFile(app, 'big.log');
  const v = view(app, 'big.log');
  await expect(v).toHaveAttribute('data-view', 'large');
  await expect(v.locator('.fv-meta')).toContainText('5.0 MB · over 2 MB, not shown');
  await expect(v.locator('.cm-content')).toHaveCount(0);
  await v.getByRole('button', { name: 'Reveal in Finder' }).click();
  await expect.poll(() => revealed).toEqual([path.join(dir, 'big.log')]);
});

// Ticket 820: read only until Edit is pressed; nothing typed, pasted or dropped before that reaches the file or the core.
test('files viewer is read only until Edit', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && sent.push(f.payload)));
  // The window's socket is already open: reload so this listener sees every frame.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openFile(app, 'hello.ts'); // the reload kept Files open on its bar
  const content = view(app, 'hello.ts').locator('.cm-content');
  const before = await content.textContent();
  await expect(content).toHaveAttribute('contenteditable', 'false');
  await expect(content).toHaveAttribute('aria-readonly', 'true');
  const mark = sent.length;
  await content.click();
  await app.keyboard.type('typed text');
  await app.keyboard.press('Enter');
  await app.keyboard.press('Backspace');
  await app.keyboard.press('Meta+KeyX');
  for (const step of ['paste', 'drop', 'exec'])
    await content.evaluate((el, step) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'pasted');
      if (step === 'paste') el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (step === 'drop') el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
      if (step === 'exec') document.execCommand('insertText', false, 'exec');
    }, step);
  await app.keyboard.press('Meta+KeyZ');
  await app.keyboard.press('Meta+Shift+KeyZ');
  expect(app.url()).toBe(`${ORIGIN}/`);
  expect(await content.textContent()).toBe(before);
  expect(fs.readFileSync(path.join(dir, 'hello.ts'), 'utf8')).toBe(fs.readFileSync(path.join(FIX, 'hello.ts'), 'utf8'));
  // No write request ever leaves the window: while typing, pasting and dropping into the viewer the only requests
  // are file reads (the 3 s check) and the window's queue heartbeat and the Room tab's 1.5 s read (room_read, ticket 571); no send_text, send_keys or anything else.
  const ops = () => sent.slice(mark).map((f) => JSON.parse(f)).filter((f) => f.request).map((f) => f.request.op as string);
  // Wait for at least one 3 s re-read, so the window was live the whole time.
  await expect.poll(ops, { timeout: 8000 }).toContain('file_read');
  expect(ops().filter((o) => !['files_list', 'file_read', 'queue_connect', 'board_snapshot', 'room_read'].includes(o))).toEqual([]);
  await expect(view(app, 'hello.ts').getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('files edit: one line edited and saved with Cmd+S reaches the file, and the core reads it back', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  await v.getByRole('button', { name: 'Edit', exact: true }).click();
  const content = v.locator('.cm-content');
  await expect(content).toHaveAttribute('contenteditable', 'true');
  const line = content.locator('.cm-line').first();
  await line.click();
  await app.keyboard.press('Meta+ArrowRight');
  await app.keyboard.type(' to you');
  await expect(line).toHaveText('// Greets the reader. to you');
  await expect(v.locator('[data-state="unsaved"]')).toBeVisible();
  // Cmd+Z steps back the unsaved typing and Shift+Cmd+Z puts it back; Revert puts the read text back.
  await app.keyboard.press('Meta+KeyZ');
  await expect(line).toHaveText('// Greets the reader.');
  await expect(v.locator('[data-state="unsaved"]')).toHaveCount(0);
  await app.keyboard.press('Meta+Shift+KeyZ');
  await expect(line).toHaveText('// Greets the reader. to you');
  await v.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(line).toHaveText('// Greets the reader.');
  await line.click();
  await app.keyboard.press('Meta+ArrowRight');
  await app.keyboard.type(' to you');
  await app.keyboard.press('Meta+KeyS');
  await expect(v.locator('[data-state="unsaved"]')).toHaveCount(0);
  const want = fs.readFileSync(path.join(FIX, 'hello.ts'), 'utf8').replace('// Greets the reader.', '// Greets the reader. to you');
  expect(fs.readFileSync(path.join(dir, 'hello.ts'), 'utf8')).toBe(want);
  // A fresh window reads the file from the core again and shows the saved line, read only.
  await app.reload();
  await openFile(app, 'hello.ts');
  await expect(view(app, 'hello.ts').locator('.cm-line').first()).toHaveText('// Greets the reader. to you');
  await expect(view(app, 'hello.ts').locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
});

test('files edit: a tab with unsaved edits does not close; after Revert it does (ticket 820)', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  await v.getByRole('button', { name: 'Edit', exact: true }).click();
  const line = v.locator('.cm-content .cm-line').first();
  await line.click();
  await app.keyboard.type('x');
  await expect(v.locator('[data-state="unsaved"]')).toBeVisible();
  const close = app.locator('[aria-label="Close tab hello.ts"]'); // the ✕ is drawn on hover or focus
  await close.click({ force: true });
  await expect(app.getByText('Save or revert your edits first').first()).toBeVisible();
  await expect(line).toHaveText(/x$/);
  await v.getByRole('button', { name: 'Revert', exact: true }).click();
  await close.click({ force: true });
  await expect(v).toHaveCount(0);
});

test('files edit: typing right after Save is never lost behind a clean "saved" state (Codex look 11-15)', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  await v.getByRole('button', { name: 'Edit', exact: true }).click();
  const line = v.locator('.cm-content .cm-line').first();
  await line.click();
  await app.keyboard.press('Meta+ArrowRight');
  await app.keyboard.type(' A');
  await app.keyboard.press('Meta+KeyS');
  await app.keyboard.type('B');
  await expect.poll(() => fs.readFileSync(path.join(dir, 'hello.ts'), 'utf8')).toContain('// Greets the reader. A');
  // Either B was held while the save was in flight, or it came after and is marked unsaved; never shown as saved.
  await expect.poll(async () => {
    const shown = await line.textContent();
    const unsaved = await v.locator('[data-state="unsaved"]').count();
    const disk = fs.readFileSync(path.join(dir, 'hello.ts'), 'utf8').split('\n')[0];
    return unsaved > 0 || shown === disk;
  }).toBe(true);
});

test('files edit: a save after the file changed on disk is refused in plain words and keeps the outside change', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  await v.getByRole('button', { name: 'Edit', exact: true }).click();
  await v.locator('.cm-line').first().click();
  await app.keyboard.press('Meta+ArrowRight');
  await app.keyboard.type(' mine');
  fs.writeFileSync(path.join(dir, 'hello.ts'), '// changed by an agent\n');
  await v.getByRole('button', { name: 'Save', exact: true }).click();
  const alert = v.locator('.fv-save-error[role="alert"]');
  await expect(alert).toContainText('The file changed on disk after you opened it, so nothing was saved.');
  await expect(alert.locator('details.err-details')).toContainText('the file changed on disk since it was opened; nothing was saved');
  expect(fs.readFileSync(path.join(dir, 'hello.ts'), 'utf8')).toBe('// changed by an agent\n');
  // The edit is still there to copy, and still unsaved.
  await expect(v.locator('.cm-line').first()).toHaveText('// Greets the reader. mine');
  await expect(v.locator('[data-state="unsaved"]')).toBeVisible();
});

test('files open keeps centre boxes', async ({ app, core }) => {
  stripOnTop(core, { below: true }); // needs 107 (ticket 180): the strip is not drawn above the composer
  const { s } = await setup(app, core);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const boxes = () =>
    app.evaluate((id) => {
      const out: Record<string, string> = {};
      for (const sel of ['.zh', `.tab[data-tab="${id}"]`, '.shead', '.pane', `.term[data-session="${id}"]`, '#waiting-strip', '.cbox'])
        out[sel] = (() => {
          const r = document.querySelector(sel)!.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height].map(Math.round).join(',');
        })();
      return out;
    }, s.id);
  const session = await boxes();
  // The viewer fills the pane from its first frame (loading or not), so content arriving moves nothing.
  await row(app, 'hello.ts').click();
  const fview = view(app, 'hello.ts');
  await expect(fview).toBeVisible();
  const first = await fview.boundingBox();
  await expect(fview).toHaveAttribute('data-view', 'text');
  await expect(fview.locator('.cm-content')).toBeVisible();
  expect(await fview.boundingBox()).toEqual(first);
  expect(first).toEqual(await app.locator('.pane').boundingBox());
  // Switching back, opening a second file, and closing both leaves every box of the session tab where it was.
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  expect(await boxes()).toEqual(session);
  await row(app, 'README.md').click();
  await expect(view(app, 'README.md')).toBeVisible();
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  expect(await boxes()).toEqual(session);
  for (const name of ['hello.ts', 'README.md']) await app.locator(`[aria-label="Close tab ${name}"]`).click({ force: true }); // CHROME: the ✕ is drawn on hover or focus
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  expect(await boxes()).toEqual(session);
  // Cmd+W closes a file tab; opening the same file twice focuses the one tab.
  await row(app, 'hello.ts').click();
  await row(app, 'hello.ts').click();
  await expect(app.locator('.tab', { hasText: 'hello.ts' })).toHaveCount(1);
  await app.keyboard.press('Meta+KeyW');
  await expect(app.locator('.tab', { hasText: 'hello.ts' })).toHaveCount(0);
  expect(await boxes()).toEqual(session);
});

test('files edge: a core refusal shows a plain line in the tab, the core message under Details', async ({ app, core }) => {
  const { s } = await setup(app, core, {
    extra: (d) => {
      fs.symlinkSync('/etc/hosts', path.join(d, 'link-out'));
      fs.mkdirSync(path.join(d, '.git'));
      fs.writeFileSync(path.join(d, '.git/config'), '[remote]\n\turl = https://token@example.com\n');
    },
  });
  for (const [p, msg] of [
    ['../secret', 'path not allowed'],
    ['/etc/hosts', 'path not allowed'],
    ['link-out', 'outside root'],
    ['.git/config', 'path not allowed'],
  ]) {
    await openAt(app, s.id, p);
    const v = view(app, p);
    await expect(v.getByRole('alert').locator('details.err-details')).toContainText(msg);
    await expect(v).toHaveAttribute('data-view', 'error');
  }
});

test('files edge: a folder with 10,000 entries lists without freezing', async ({ app, core }) => {
  await setup(app, core, {
    extra: (d) => {
      fs.mkdirSync(path.join(d, 'many'));
      for (let i = 0; i < 10_000; i++) fs.writeFileSync(path.join(d, 'many', `f${String(i).padStart(5, '0')}.txt`), '');
    },
  });
  const t0 = Date.now();
  await row(app, 'many').click();
  await expect(row(app, 'many/f00000.txt')).toBeVisible();
  console.log(`10,000 entries listed in ${Date.now() - t0} ms`);
  // Virtualised: only the rows in view are in the DOM.
  expect(await app.locator('.frow').count()).toBeLessThan(120);
  // The main thread stays free: a timer still fires promptly while scrolling to the end.
  const lag = await app.evaluate(async () => {
    const tree = document.querySelector('.ftree')!;
    const t = performance.now();
    tree.scrollTop = tree.scrollHeight;
    await new Promise((r) => setTimeout(r, 0));
    return performance.now() - t;
  });
  expect(lag).toBeLessThan(200);
  await expect(row(app, 'many/f09999.txt')).toBeVisible();
});

test('files edge: a file that changes while open shows changed with reload, never a silent swap', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  fs.appendFileSync(path.join(dir, 'hello.ts'), 'export const added = 1;\n');
  await expect(v.locator('[data-state="changed"]')).toBeVisible({ timeout: 8000 });
  await expect(v.locator('.cm-content')).not.toContainText('added');
  await v.getByRole('button', { name: 'Reload' }).click();
  await expect(v.locator('.cm-content')).toContainText('export const added = 1;');
  await expect(v.locator('[data-state="changed"]')).toHaveCount(0);
});

test('files edge: a file deleted while open shows missing', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  await openFile(app, 'hello.ts');
  const v = view(app, 'hello.ts');
  fs.rmSync(path.join(dir, 'hello.ts'));
  await expect(v.locator('[data-state="missing"]')).toBeVisible({ timeout: 8000 });
  // What was shown stays readable.
  await expect(v.locator('.cm-content')).toContainText('export function hello');
});

test('files edge: non-UTF-8 text the core marks binary shows as binary', async ({ app, core }) => {
  await setup(app, core);
  await openFile(app, 'latin1.txt');
  await expect(view(app, 'latin1.txt')).toHaveAttribute('data-view', 'binary');
  await expect(view(app, 'latin1.txt').locator('.fv-meta')).toContainText('18 B · binary');
});

test('files edge: a Hangul, emoji and spaces name lists, opens and ellipsises without widening the sidebar', async ({ app, core }) => {
  const name = '한글 파일 이름 🎉 아주 길고 긴 설명이 붙은 메모 정리본 최종.md';
  const width = async () => (await app.locator('.sbar.l').boundingBox())!.width;
  await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, name), '# 제목\n\n본문 🎉\n') });
  const w = await width();
  const r = row(app, name);
  await expect(r).toBeVisible();
  expect(await r.locator('.n').evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis')).toBe(true);
  await openFile(app, name);
  await expect(view(app, name).locator('.fv-md h1')).toHaveText('제목');
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('🎉');
  expect(await width()).toBe(w);
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('files edge: Hangul composition in the composer is not interrupted when a tree update arrives', async ({ app, core, browserName }) => {
  const { dir, s } = await setup(app, core);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const box = app.locator('.cbox textarea');
  await box.focus();
  await app.evaluate(() => {
    (window as { __ended?: number }).__ended = 0;
    document.addEventListener('compositionend', () => ((window as { __ended?: number }).__ended! += 1), true);
  });
  let cdp;
  if (browserName === 'chromium') {
    cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.insertText', { text: '파일을 ' });
    await cdp.send('Input.imeSetComposition', { text: '여', selectionStart: 1, selectionEnd: 1 });
  } else await app.keyboard.insertText('파일을 여');
  fs.writeFileSync(path.join(dir, 'arrived.txt'), 'new');
  // The tree refreshes on its own timer while the composer keeps focus.
  await expect(row(app, 'arrived.txt')).toBeVisible({ timeout: 8000 });
  expect(await app.evaluate(() => document.activeElement?.id)).toBe('composer');
  expect(await app.evaluate(() => (window as { __ended?: number }).__ended)).toBe(0);
  if (cdp) {
    await cdp.send('Input.insertText', { text: '여' });
    await expect(box).toHaveValue('파일을 여');
  } else await expect(box).toHaveValue('파일을 여');
});

test('files edge: prefix keys and hints reach tree rows and the viewer with a Korean input source', async ({ app, core }) => {
  await setup(app, core);
  // ⌃Space e (focus the tree) as a Korean source sends it: keyCode 229, key "Process".
  await app.locator('.cmd').focus();
  await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await physical(app, { code: 'KeyE', key: 'Process', keyCode: 229 });
  await expect.poll(() => app.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('role'))).toBe('treeitem');
  // ⌃Space f shows hints over tree rows; typing a row's label (as Hangul jamo keys) opens it.
  const hintFor = async (sel: string) => {
    await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
    await physical(app, { code: 'KeyF', key: 'ㄹ' });
    await expect(app.locator('.hint').first()).toBeVisible();
    const target = (await app.locator(sel).boundingBox())!;
    const hints = await app.locator('.hint').evaluateAll((els) => els.map((e) => ({ keys: (e as HTMLElement).dataset.keys!, x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top })));
    const hit = hints.find((h) => Math.abs(h.x - target.x) < 2 && Math.abs(h.y - target.y) < 2);
    expect(hit, sel).toBeTruthy();
    for (const k of hit!.keys.split(' ')) await physical(app, { code: (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`), key: 'Process', keyCode: 229 }); // ticket 389: each letter's QWERTY key
  };
  await hintFor('.frow[data-path="hello.ts"]');
  await expect(view(app, 'hello.ts')).toHaveAttribute('data-view', 'text');
  await expect(view(app, 'hello.ts').locator('.cm-content')).toBeVisible();
  await hintFor('.fview[data-file="hello.ts"] .cm-content');
  await expect.poll(() => app.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true);
  // Arrow keys in the tree move between rows; Enter opens the row reached.
  const order = await app.locator('.frow').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!));
  const next = order[order.indexOf('README.md') + 1];
  await row(app, 'README.md').click();
  await row(app, 'README.md').focus();
  await app.keyboard.press('ArrowDown');
  await expect(row(app, next)).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveText(new RegExp(next.replace('.', '\\.')));
});

test('files edge: the session folder vanishing shows a message', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  await expect(row(app, 'hello.ts')).toBeVisible();
  fs.rmSync(dir, { recursive: true, force: true });
  await expect(app.getByRole('status').filter({ hasText: 'folder is gone' })).toBeVisible({ timeout: 8000 });
});

test('files edge: switching the focused session switches the tree without reordering rows under the pointer', async ({ app, core }) => {
  const { s: a, dir } = await setup(app, core);
  const other = core.project('other');
  fs.mkdirSync(path.join(other, 'only-in-other'));
  fs.writeFileSync(path.join(other, 'only-in-other/x.txt'), 'x');
  const b = core.shell(other, 'other');
  await goTab(app, core, b.id);
  await expect(row(app, 'only-in-other')).toBeVisible();
  await expect(row(app, 'hello.ts')).toHaveCount(0);
  // Expanded folders are kept per session.
  await row(app, 'only-in-other').click();
  await expect(row(app, 'only-in-other/x.txt')).toBeVisible();
  await goTab(app, core, a.id);
  await expect(row(app, 'hello.ts')).toBeVisible();
  // Pointer on a row: a new file that sorts first does not move the rows under it until the pointer leaves.
  await row(app, 'hello.ts').hover();
  const rows = () => app.locator('.frow').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.path}@${Math.round(e.getBoundingClientRect().y)}`));
  const before = await rows();
  fs.writeFileSync(path.join(dir, 'AAA-first.txt'), 'a');
  await app.waitForTimeout(6000);
  expect(await rows()).toEqual(before);
  await app.mouse.move(800, 400);
  await expect(row(app, 'AAA-first.txt')).toBeVisible({ timeout: 8000 });
  await goTab(app, core, b.id);
  await expect(row(app, 'only-in-other/x.txt')).toBeVisible();
});

test('files edge: a session switch with the pointer on the tree waits until the pointer leaves', async ({ app, core }) => {
  const { s: a } = await setup(app, core);
  const other = core.project('other');
  fs.writeFileSync(path.join(other, 'only-in-other.txt'), 'x');
  const b = core.shell(other, 'other');
  await goTab(app, core, a.id);
  await expect(row(app, 'hello.ts')).toBeVisible();
  await row(app, 'hello.ts').hover();
  const rows = () => app.locator('.frow').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.path}@${Math.round(e.getBoundingClientRect().y)}`));
  const before = await rows();
  // Ticket 570: the other session is in another project; ⌃1-9 switch the project while the pointer stays on the tree (the projects' order is the tree's, so try both).
  await app.keyboard.press('Control+Digit2');
  await app.waitForTimeout(300);
  if ((await app.locator('.tab[aria-selected="true"]').getAttribute('data-tab')) !== b.id) await app.keyboard.press('Control+Digit1');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', b.id);
  await app.waitForTimeout(500);
  expect(await rows()).toEqual(before);
  await app.mouse.move(800, 400);
  await expect(row(app, 'only-in-other.txt')).toBeVisible();
  await expect(row(app, 'hello.ts')).toHaveCount(0);
});

test('files edge: over 2 MB a same-size edit is caught through the core mtime', async ({ app, core }) => {
  const size = 3 * 1024 * 1024;
  const { dir } = await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, 'big.log'), 'x'.repeat(size)) });
  const file = path.join(dir, 'big.log');
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  await openFile(app, 'big.log');
  const v = view(app, 'big.log');
  await expect(v).toHaveAttribute('data-view', 'large');
  fs.writeFileSync(file, 'y'.repeat(size));
  fs.utimesSync(file, 1_700_000_100, 1_700_000_100);
  await expect(v.locator('[data-state="changed"]')).toBeVisible({ timeout: 8000 });

  // A core that sends neither field leaves size as the only evidence; a hash, if one is ever sent, also counts.
  const big = { kind: 'text', size: 3e6, too_large: true };
  expect(sameContent(big, { ...big })).toBe(true);
  expect(sameContent({ ...big, mtime_ms: 1 }, { ...big, mtime_ms: 2 })).toBe(false);
  expect(sameContent({ ...big, hash: 'a' }, { ...big, hash: 'b' })).toBe(false);
  expect(sameContent({ ...big, mtime_ms: 1, hash: 'a' }, { ...big, mtime_ms: 1, hash: 'a' })).toBe(true);
  expect(sameContent({ ...big, size: 3e6 + 1 }, big)).toBe(false);
  // Up to 2 MB the bytes decide: a touch or a checkout of the same content is not a change.
  const small = { kind: 'text', size: 3, too_large: false, text: 'abc' };
  expect(sameContent({ ...small, mtime_ms: 1 }, { ...small, mtime_ms: 2 })).toBe(true);
});

test('files: a window with no file open loads no CodeMirror; the first text tab does', async ({ app, core }) => {
  // Build check: the entry script and what it preloads carry no CodeMirror code.
  const dist = path.join(import.meta.dirname, '../dist');
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const eager = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  expect(eager.length).toBeGreaterThan(0);
  for (const f of eager) expect(fs.readFileSync(path.join(dist, f), 'utf8').includes('cm-scroller'), `${f} carries CodeMirror`).toBe(false);
  // Load check: nothing CodeMirror is fetched until a text file opens.
  const scripts: string[] = [];
  app.on('request', (r) => r.resourceType() === 'script' && scripts.push(r.url()));
  await setup(app, core);
  await openFile(app, 'dot.png');
  expect(scripts.filter((u) => /\/Code-[\w-]+\.js$/.test(u))).toEqual([]);
  await openFile(app, 'hello.ts');
  await expect(view(app, 'hello.ts').locator('.cm-content')).toBeVisible();
  expect(scripts.filter((u) => /\/Code-[\w-]+\.js$/.test(u))).toHaveLength(1);
});

test('files widget: the gallery lists Files and a placed Files widget shows the focused session tree', async ({ app, core }) => {
  await setup(app, core);
  await app.getByRole('button', { name: 'Files', exact: true }).click(); // collapse the Files sidebar
  await expect(app.locator('.frow')).toHaveCount(0);
  expect(core.cli('layout', 'split', 'down', 'files', '--zone', 'terminal').type).toBe('text');
  const zone = app.locator('.lz', { has: app.locator('.files') });
  await expect(zone.locator('.frow[data-path="hello.ts"]')).toBeVisible();
  await zone.locator('.frow[data-path="hello.ts"]').click();
  await expect(view(app, 'hello.ts')).toHaveAttribute('data-view', 'text');
  await app.locator('nav[data-bar="right"] .lay').click();
  await expect(app.locator('.lcard[data-card="files"]')).toBeVisible();
});

test('files edge: git letters show and ignored entries are dimmed', async ({ app, core }) => {
  const git = (d: string, ...a: string[]) =>
    execFileSync('git', a, { cwd: d, env: { PATH: '/usr/bin:/bin', HOME: d, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  await setup(app, core, {
    extra: (d) => {
      fs.writeFileSync(path.join(d, '.gitignore'), 'blob.bin\n');
      git(d, 'init', '-q');
      git(d, 'add', 'hello.ts', 'README.md', '.gitignore');
      git(d, 'commit', '-q', '-m', 'x');
      fs.appendFileSync(path.join(d, 'hello.ts'), '// changed\n');
    },
  });
  await expect(row(app, 'hello.ts').locator('.fgit')).toHaveText('M');
  await expect(row(app, 'dot.png').locator('.fgit')).toHaveText('?');
  await expect(row(app, 'README.md').locator('.fgit')).toHaveCount(0);
  await expect(row(app, 'blob.bin')).toHaveAttribute('data-ignored', 'true');
  await expect(row(app, '.git')).toHaveCount(0);
  // An ignored row is dimmed by the --g5 token alone; the old extra 0.7 opacity took it to about 2.6:1 (--g5 itself is 4.35:1 on --g0, light).
  await expect(row(app, 'blob.bin').locator('.n')).toHaveCSS('opacity', '1');
});

test('files edge: an unknown future kind from the core renders as binary', async () => {
  expect(viewOf({ kind: 'model3d', size: 10, too_large: false, text: 'x', data: null })).toBe('binary');
  expect(viewOf({ kind: 'image', size: 10, too_large: false, data: null })).toBe('binary');
  expect(viewOf({ kind: 'text', size: 10, too_large: false, text: 'x' })).toBe('text');
  expect(viewOf({ kind: 'text', size: 3e6, too_large: true })).toBe('large');
});

test('files open at line scrolls to and marks the line (Search, ticket 10)', async ({ app, core }) => {
  const { s } = await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, 'long.txt'), Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')) });
  await openAt(app, s.id, 'long.txt', 300);
  const v = view(app, 'long.txt');
  const target = v.locator('.cm-target');
  await expect(target).toHaveText('line 300');
  await expect(target).toBeInViewport();
  await openAt(app, s.id, 'long.txt', 5);
  await expect(target).toHaveText('line 5');
  await expect(app.locator('.tab', { hasText: 'long.txt' })).toHaveCount(1);
});

test('files expanded folders are kept per session in window settings; a broken store falls back to none', async () => {
  const ok = parse(JSON.stringify({ filesExpanded: { s1: ['src', 'src/a'] } }));
  expect(ok.clean).toBe(true);
  expect(ok.settings.filesExpanded).toEqual({ s1: ['src', 'src/a'] });
  expect(parse('{}').settings.filesExpanded).toEqual({});
  for (const bad of [[], { s1: 'src' }, { s1: [1] }, 'x']) {
    const r = parse(JSON.stringify({ filesExpanded: bad, density: 'spacious' }));
    expect(r.clean).toBe(false);
    expect(r.settings.filesExpanded).toEqual({});
    // Other fields are still trusted field by field.
    expect(r.settings.density).toBe('spacious');
  }
});

// V1A-63 frame-time figure, not an assertion: scrolls the 10,000-entry folder top to bottom in fixed 220 px steps, one
// per animation frame, and prints rAF deltas (median, p95) and long tasks. Run with MEASURE=1 on Chromium, headed
// (headless Chromium throttles rAF), on this branch and on main; compare the printed lines.
test('files measure: scroll 10,000 entries', async ({ app, core }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.MEASURE, 'run with MEASURE=1');
  test.setTimeout(120_000);
  await setup(app, core, {
    extra: (d) => {
      fs.mkdirSync(path.join(d, 'many'));
      const ext = ['rs', 'ts', 'json', 'md', 'png', 'txt', 'toml', 'py'];
      for (let i = 0; i < 10_000; i++) fs.writeFileSync(path.join(d, 'many', `f${String(i).padStart(5, '0')}.${ext[i % ext.length]}`), '');
    },
  });
  await row(app, 'many').click();
  await expect(row(app, 'many/f00000.rs')).toBeVisible();
  await app.mouse.move(800, 400); // pointer outside the tree: refreshes run as in normal use
  const m = await app.evaluate(async () => {
    const tree = document.querySelector('.ftree')!;
    const long: number[] = [];
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
    obs.observe({ type: 'longtask', buffered: false });
    const deltas: number[] = [];
    await new Promise<void>((done) => {
      let last = performance.now();
      const step = (t: number) => {
        deltas.push(t - last);
        last = t;
        if (tree.scrollTop + tree.clientHeight >= tree.scrollHeight - 1) return done();
        tree.scrollTop += 220;
        requestAnimationFrame(step);
      };
      requestAnimationFrame((t) => ((last = t), requestAnimationFrame(step)));
    });
    obs.disconnect();
    const s = [...deltas].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { frames: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1], longTasks: long.length, longMs: long.reduce((a, b) => a + b, 0) };
  });
  console.log(`MEASURE ${JSON.stringify(m)}`);
});
