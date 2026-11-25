// Ticket v1b-06: artifact cards in chat and Preview. Real core and fake agent (03's chat harness): the test writes
// files into the session folder and the transcript records of the agent writing them, so every card comes from
// the core's own `artifact` events. Playwright drives a browser, not WKWebView: the frame is served by 04's test
// server with the same CSP files (sandbox-server.ts), through a stand-in for `artifact_open` that reads bytes only
// with the core's `file_read` (fixtures/artifacts/cards/host.ts).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { stripOnTop } from './fixtures';
import { installHost, showFrame } from './fixtures/artifacts/cards/host';
import { append, chat, expect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { artifactServer } from './sandbox-server';
import { layoutCli } from './d5b';

type Art = Awaited<ReturnType<typeof artifactServer>>;
const test = chatTest.extend<{ host: { opened: string[] } }, { art: Art }>({
  art: [
    async ({}, use) => {
      const art = await artifactServer({});
      await use(art);
      await art.close();
    },
    { scope: 'worker' },
  ],
  host: [
    async ({ page, art }, use) => {
      const opened: string[] = [];
      await installHost(page, art, opened);
      await use({ opened });
    },
    { auto: true },
  ],
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const page1 = (title: string, body = '<p>hello</p>') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** Writes the file into the session folder and the agent's Write call and result for it. */
function written(s: { cwd: string; file: string }, id: string, rel: string, content: string | Buffer, opts: { error?: boolean; at?: string; record?: string } = {}) {
  const full = opts.at ?? path.join(s.cwd, rel);
  if (!opts.error && !opts.at) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const text = opts.record ?? (typeof content === 'string' ? content : '');
  return [
    rec.use(id, 'Write', { file_path: full, content: text }),
    opts.error
      ? rec.result(id, 'Error: permission denied', { toolUseResult: 'Error: permission denied' }, true)
      : rec.result(id, `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: text, structuredPatch: [] } }),
  ];
}

const card = (page: Page, session: string, rel: string) => chat(page, session).locator(`.acard[data-path="${rel}"]`);
// Ticket 1086: in Normal and Thinking a written Markdown or image file is Open on its changed-files row, so the tests of the
// one-line card itself read the Verbose view, which draws every row as built.
const verbose = (page: Page) => page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));

test('artifacts card opens preview in one click', async ({ page, chatCore, host }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('차트 만들어줘'), written(s, 'w1', 'site/index.html', page1('Sales chart')), rec.assistant('만들었습니다.'));
  await openChat(page, s.id);
  const c = card(page, s.id, 'site/index.html');
  await expect(c).toHaveAttribute('data-state', 'ready');
  await showFrame(c);
  await expect(c.locator('.af-title')).toHaveText('Sales chart');
  const id = await c.locator('.artifact-frame').getAttribute('data-artifact');
  const hash = await c.getAttribute('data-hash');
  await expect(c.frameLocator('iframe').locator('p')).toHaveText('hello');
  await page.evaluate(() => {
    (window as unknown as { __clicks: number }).__clicks = 0;
    document.addEventListener('click', () => (window as unknown as { __clicks: number }).__clicks++, true);
  });
  await c.getByRole('button', { name: 'Open' }).click();
  const pv = page.locator('.preview .pv-frame');
  await expect(pv).toHaveAttribute('data-hash', hash!);
  await expect(pv.locator('.artifact-frame')).toHaveAttribute('data-artifact', id!);
  await expect(pv.frameLocator('iframe').locator('p')).toHaveText('hello');
  expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
  // Full size: the Preview frame is taller than the card's.
  const [cardH, pvH] = await Promise.all([c.locator('iframe').evaluate((e) => e.getBoundingClientRect().height), pv.locator('iframe').evaluate((e) => e.getBoundingClientRect().height)]);
  expect(pvH).toBeGreaterThan(cardH);
  expect(host.opened.every((o) => o === `${s.id}:site/index.html`)).toBe(true);
});

test('artifacts changed file marks card', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, written(s, 'w1', 'report.html', page1('Report', '<p>v1</p>')));
  await openChat(page, s.id);
  const c = card(page, s.id, 'report.html');
  await expect(c).toHaveAttribute('data-state', 'ready');
  await showFrame(c);
  const first = await c.getAttribute('data-hash');
  await expect(c.locator('.af-chip.changed')).toHaveCount(0);
  fs.writeFileSync(path.join(s.cwd, 'report.html'), page1('Report', '<p>v2</p>'));
  await expect(c.locator('.af-chip.changed')).toBeVisible({ timeout: 5000 });
  // Nothing re-renders on its own: the old version stays until the user asks.
  await expect(c).toHaveAttribute('data-hash', first!);
  await expect(c.frameLocator('iframe').locator('p')).toHaveText('v1');
  await c.locator('.af-chip.changed').click();
  await expect(c.frameLocator('iframe').locator('p')).toHaveText('v2');
  await expect(c).not.toHaveAttribute('data-hash', first!);
  await expect(c.locator('.af-chip.changed')).toHaveCount(0);
});

/** 03's boxes(): visible chat rows, the switch, strip and composer. */
async function boxes(page: Page, session: string) {
  return page.evaluate((id) => {
    const out: Record<string, string> = {};
    const scroller = document.querySelector(`.chat[data-session="${id}"] .cscroll`)!.getBoundingClientRect();
    const box = (k: string, e: Element) => {
      const r = e.getBoundingClientRect();
      out[k] = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
    };
    for (const e of document.querySelectorAll(`.chat[data-session="${id}"] .crow`)) {
      const r = e.getBoundingClientRect();
      if (r.bottom > scroller.top && r.top < scroller.bottom) box(`row-${(e as HTMLElement).dataset.key}`, e);
    }
    for (const sel of ['.cbox', '#waiting-strip', '.shead', '.tabs']) box(sel, document.querySelector(sel)!);
    return out;
  }, session);
}

test('artifacts must not break 03 acceptance 3: three inline cards in history and one arriving while scrolled up move nothing', async ({ page, chatCore, browserName }) => {
  stripOnTop(chatCore); // needs 107 (ticket 180): the strip is not drawn above the composer; boxes() reads it
  const s = chatCore.chat();
  const qa = (from: number, n: number) => Array.from({ length: n }, (_, i) => [rec.user(`질문 ${from + i}`), rec.assistant(`답 ${from + i}\n\n둘째 문단 ${from + i}`)]).flat();
  append(s.file, qa(0, 10), written(s, 'c1', 'a.html', page1('A')), qa(10, 10), written(s, 'c2', 'b.html', page1('B')), qa(20, 10), written(s, 'c3', 'c.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>C</title></svg>'), qa(30, 10));
  fs.writeFileSync(path.join(s.cwd, 'late.html'), page1('Late'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('답 39')).toBeVisible();
  await view.locator('.cscroll').hover();
  // Up to the third card, so a card is in view while things arrive.
  await page.mouse.wheel(0, -1400);
  await expect.poll(() => view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(400);
  // Card heights are reserved whatever their state: loading, ready or a problem.
  for (const h of await view.locator('.acard.frame').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))) expect(h).toBe(346);
  const box = page.locator('.cbox textarea');
  await box.focus();
  const typed = '로그를 남기';
  let cdp;
  if (browserName === 'chromium') {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: '로그를 남' });
    await cdp.send('Input.imeSetComposition', { text: '기', selectionStart: 1, selectionEnd: 1 });
  } else await page.keyboard.insertText(typed);
  await page.evaluate(() => {
    (window as { __ended?: number }).__ended = 0;
    document.addEventListener('compositionend', () => ((window as { __ended?: number }).__ended! += 1), true);
  });
  await page.waitForTimeout(300);
  const before = await boxes(page, s.id);
  expect(Object.keys(before).filter((k) => k.startsWith('row-')).length).toBeGreaterThan(3);
  expect(await view.locator('.cscroll .acard').count()).toBeGreaterThan(0);
  // 20 events, one of them an inline card that loads while the user is scrolled up.
  append(s.file, Array.from({ length: 9 }, (_, i) => [rec.user(`새 질문 ${i}`), rec.assistant(`새 답 ${i}`)]).flat(), written(s, 'late', 'late.html', page1('Late')));
  await expect(view.locator('.newchip')).toBeVisible();
  // Past one poll, so every card has loaded and been asked again.
  await page.waitForTimeout(2600);
  expect(await boxes(page, s.id)).toEqual(before);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('composer');
  expect(await page.evaluate(() => (window as { __ended?: number }).__ended)).toBe(0);
  await expect(box).toHaveValue(typed);
  await view.locator('.newchip').click();
  await expect(card(page, s.id, 'late.html')).toHaveAttribute('data-state', 'ready');
  if (cdp) await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
});

test('artifacts outside the session folder: a card that cannot open, never a read outside roots', async ({ page, chatCore, host }) => {
  const s = chatCore.chat();
  const outside = path.join(chatCore.home, 'secret.html');
  fs.writeFileSync(outside, page1('secret'));
  fs.symlinkSync(outside, path.join(s.cwd, 'link.html'));
  append(
    s.file,
    written(s, 'o1', '', page1('abs'), { at: outside }),
    written(s, 'o2', '', page1('up'), { at: '../elsewhere/up.html' }),
    rec.use('o3', 'Write', { file_path: path.join(s.cwd, 'link.html'), content: 'x' }),
    rec.result('o3', 'ok', { toolUseResult: { type: 'create', filePath: path.join(s.cwd, 'link.html'), content: 'x', structuredPatch: [] } }),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  for (const rel of [outside, '../elsewhere/up.html', 'link.html']) {
    const c = card(page, s.id, rel);
    await expect(c).toHaveAttribute('data-state', 'outside');
    await expect(c.locator('.astate')).toHaveText('outside folder');
    await expect(c.locator('iframe')).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'Open' })).toHaveCount(0);
  }
  // The stand-in registers only what the core's file_read returned: nothing at all here.
  expect(host.opened).toEqual([]);
});

test('artifacts each failure has its own message: unsupported, command missing, outside, too large, missing', async ({ page, chatCore }) => {
  // The app without `artifact_open` (an older build): the stand-in refuses as Tauri does for an unknown command.
  await page.addInitScript(() => ((window as unknown as { __artifactNoCommand: boolean }).__artifactNoCommand = true));
  const s = chatCore.chat();
  const outside = path.join(chatCore.home, 'o.html');
  append(
    s.file,
    written(s, 'u1', 'bin.html', Buffer.from([0x3c, 0x70, 0x3e, 0, 1, 2, 0x3c])),
    written(s, 'u2', 'fine.html', page1('Fine')),
    written(s, 'u3', '', page1('o'), { at: outside }),
    written(s, 'u4', 'big.html', page1('Big', 'x'.repeat(2 * 1024 * 1024 + 10)), { record: page1('Big') }),
    written(s, 'u5', '', page1('gone'), { at: path.join(s.cwd, 'never-there.html') }),
  );
  await openChat(page, s.id);
  const want: [string, string, RegExp][] = [
    ['bin.html', 'unsupported', /binary or another type/],
    ['fine.html', 'cannot open here', /Restart Nunchiro/], // ticket 960: no command name, an action
    [outside, 'outside folder', /Outside the session folder/],
    ['big.html', 'too large', /Over 2 MB/],
    ['never-there.html', 'missing', /gone/],
  ];
  const texts = new Set<string>();
  for (const [rel, label, text] of want) {
    const c = card(page, s.id, rel);
    await showFrame(c);
    await expect(c.locator('.astate')).toHaveText(label);
    await expect(c.locator('.abody')).toHaveText(text);
    texts.add((await c.locator('.abody').textContent()) ?? '');
  }
  expect(texts.size).toBe(5);
});

test('artifacts markdown and image cards show "changed" like HTML cards', async ({ page, chatCore }) => {
  await verbose(page);
  const s = chatCore.chat();
  append(s.file, written(s, 'm1', 'notes.md', '# Notes\n\nv1'), written(s, 'm2', 'shot.png', PNG));
  await openChat(page, s.id);
  for (const rel of ['notes.md', 'shot.png']) await expect(card(page, s.id, rel)).toHaveAttribute('data-state', 'ready');
  await expect(chat(page, s.id).locator('.af-chip.changed')).toHaveCount(0);
  fs.writeFileSync(path.join(s.cwd, 'notes.md'), '# Notes\n\nv2');
  fs.writeFileSync(path.join(s.cwd, 'shot.png'), Buffer.concat([PNG, Buffer.from([0])]));
  for (const rel of ['notes.md', 'shot.png']) {
    const c = card(page, s.id, rel);
    await expect(c.locator('.af-chip.changed')).toBeVisible({ timeout: 5000 });
    expect(await c.evaluate((e) => Math.round(e.getBoundingClientRect().height))).toBe(32);
    await c.locator('.af-chip.changed').click();
    await expect(c.locator('.af-chip.changed')).toHaveCount(0);
  }
});

test('artifacts a pinned Preview keeps its session (by label, like Diff) while focus moves', async ({ page, chatCore }) => {
  const a = chatCore.chat('alpha', true, false, 'pair'); // ticket 570: one project, so the tabs share a strip
  const b = chatCore.chat('리뷰-03', true, false, 'pair');
  append(a.file, written(a, 'a1', 'a.html', page1('A', '<p>alpha</p>')));
  append(b.file, written(b, 'b1', 'b.html', page1('B', '<p>beta</p>')));
  await openChat(page, b.id);
  await card(page, b.id, 'b.html').getByRole('button', { name: 'Open' }).click();
  await page.locator('nav[data-bar="right"] .lay').click();
  // needs 153: the window has no ':' command line; `nunchiro layout` takes the same words.
  await layoutCli(page, chatCore, 'split right preview --pin 리뷰-03 --zone terminal');
  await page.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
  const placed = page.locator('[data-zone-id] .preview:not([data-side-pane] *)'); // the side pane's own Preview tab is not the pinned zone
  await expect(placed.locator('.pv-frame').frameLocator('iframe').locator('p')).toHaveText('beta');
  await page.locator(`.tab[data-tab="${a.id}"]`).click();
  await card(page, a.id, 'a.html').getByRole('button', { name: 'Open' }).click();
  await page.waitForTimeout(300);
  await expect(placed.locator('.pv-frame').frameLocator('iframe').locator('p')).toHaveText('beta');
});

test('artifacts failed write: no card', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, written(s, 'f1', 'never.html', page1('never'), { error: true }), rec.assistant('권한이 거부되었습니다.'));
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('권한이 거부되었습니다.')).toBeVisible();
  await expect(chat(page, s.id).locator('.acard')).toHaveCount(0);
});

test('artifacts over 2 MB: too large with Open in Files', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  // The transcript caps a record at 2 MiB, so the call names the file and the file grows on disk.
  append(s.file, written(s, 'b1', 'big.html', page1('Big', 'x'.repeat(2 * 1024 * 1024 + 10)), { record: page1('Big') }));
  await openChat(page, s.id);
  const c = card(page, s.id, 'big.html');
  await expect(c).toHaveAttribute('data-state', 'too_large');
  await expect(c.locator('.astate')).toHaveText('too large');
  // 09's Files opens it in a read-only tab (its own "too large" view).
  await c.getByRole('button', { name: 'Open in Files' }).click();
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText('big.html');
});

test('artifacts deleted file shows missing', async ({ page, chatCore }) => {
  await verbose(page);
  const s = chatCore.chat();
  append(s.file, written(s, 'd1', 'gone.html', page1('Gone')), written(s, 'd2', 'gone.md', '# Gone'));
  await openChat(page, s.id);
  const c = card(page, s.id, 'gone.html');
  await expect(c).toHaveAttribute('data-state', 'ready');
  fs.rmSync(path.join(s.cwd, 'gone.html'));
  fs.rmSync(path.join(s.cwd, 'gone.md'));
  await expect(c).toHaveAttribute('data-state', 'missing', { timeout: 5000 });
  await expect(c.locator('.astate')).toHaveText('missing');
  // A Markdown card is watched too: it says so on the card, without an Open to a file that is gone.
  await expect(card(page, s.id, 'gone.md')).toHaveAttribute('data-state', 'missing');
  await expect(card(page, s.id, 'gone.md').getByRole('button', { name: 'Open' })).toHaveCount(0);
});

test('artifacts markdown: one-line card, Preview renders raw HTML, javascript: links and remote images inert', async ({ page, chatCore }) => {
  await verbose(page);
  const remote: string[] = [];
  await page.route(/nunchiro\.test/, (r) => (remote.push(r.request().url()), r.abort()));
  const s = chatCore.chat();
  const md = [
    '<h1>raw heading</h1>',
    '',
    '# Release <b>notes</b>',
    '',
    '<script>window.__pwned = 1</script><img src="https://img.nunchiro.test/x.png" onerror="window.__pwned = 2">',
    '',
    '[click](javascript:window.__pwned=3) and [web](https://docs.nunchiro.test/page)',
    '',
    '![remote](https://img.nunchiro.test/y.png)',
  ].join('\n');
  append(s.file, written(s, 'm1', 'docs/notes.md', md));
  await openChat(page, s.id);
  const c = card(page, s.id, 'docs/notes.md');
  await expect(c.locator('.at')).toHaveText('Release notes');
  expect(await c.evaluate((e) => Math.round(e.getBoundingClientRect().height))).toBe(32);
  await c.getByRole('button', { name: 'Open' }).click();
  const body = page.locator('.preview .pv-body');
  // Raw HTML stays text, inside the heading as everywhere else.
  await expect(body.locator('h1')).toHaveText('Release <b>notes</b>');
  await expect(body).toContainText('<script>window.__pwned = 1</script>');
  await expect(body.locator('script, img, iframe')).toHaveCount(0);
  await expect(body.locator('a[href]')).toHaveCount(0);
  await body.getByText('click').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(remote).toEqual([]);
});

test('artifacts image: one-line card, Preview shows it from its bytes', async ({ page, chatCore }) => {
  await verbose(page);
  const s = chatCore.chat();
  append(s.file, written(s, 'i1', 'shots/screen.png', PNG));
  await openChat(page, s.id);
  const c = card(page, s.id, 'shots/screen.png');
  await expect(c.locator('.at')).toHaveText('screen.png');
  await c.getByRole('button', { name: 'Open' }).click();
  const img = page.locator('.preview .pv-body img');
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(1);
});

test('artifacts a chat thumbnail of a file opens in Preview (ticket 05 click re-pointed); base64 keeps the viewer', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  fs.writeFileSync(path.join(s.cwd, 'local.png'), PNG);
  const user = (text: string, source: unknown) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source }] } });
  append(s.file, user('file', { type: 'path', path: path.join(s.cwd, 'local.png') }), user('inline', { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') }), rec.assistant('ok'));
  await openChat(page, s.id);
  await chat(page, s.id).getByRole('button', { name: 'Open image local.png' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.preview')).toHaveAttribute('data-path', 'local.png');
  const img = page.locator('.preview .pv-body img');
  await expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(1);
  // Bytes that are no file have nothing for Preview to read: the full-size viewer still opens.
  await chat(page, s.id).getByRole('button', { name: 'Open image png image' }).click();
  await expect(page.getByRole('dialog', { name: 'Image png image' })).toBeVisible();
});

test('image_click_after_image_click_opens_image', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const user = (text: string) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] } });
  append(s.file, user('first'), user('second'), rec.assistant('ok'));
  await openChat(page, s.id);
  const images = chat(page, s.id).getByRole('button', { name: 'Open image png image' });
  await expect(images).toHaveCount(2);
  await images.nth(0).click();
  await expect(page.getByRole('dialog', { name: 'Image png image' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The first row keeps focus; its Copy bar must not cover the next row's image (needs 171 keeps Copy on every row).
  await images.nth(1).click();
  await expect(page.getByRole('dialog', { name: 'Image png image' })).toBeVisible();
});

test('artifacts fenced block: saved under the data folder and shown like a file', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.assistant('차트입니다.\n\n```nunchiro-artifact html\n<!doctype html><title>Block chart</title><p>bars</p>\n```\n'));
  await openChat(page, s.id);
  const c = chat(page, s.id).locator('.acard[data-path^="artifacts/"]');
  await expect(c).toHaveAttribute('data-state', 'ready');
  await showFrame(c);
  await expect(c.locator('.af-title')).toHaveText('Block chart');
  await expect(c.frameLocator('iframe').locator('p')).toHaveText('bars');
  const rel = (await c.getAttribute('data-path'))!;
  expect(rel).toMatch(new RegExp(`^artifacts/${s.id}/[0-9a-f]{64}\\.html$`));
  expect(fs.readFileSync(path.join(chatCore.home, rel), 'utf8')).toBe('<!doctype html><title>Block chart</title><p>bars</p>');
});

test('artifacts title with Hangul and RTL text ellipsises without widening the column', async ({ page, chatCore }) => {
  await verbose(page);
  const s = chatCore.chat();
  const long = `눈치로 아티팩트 제목이 아주 길어서 한 줄에 다 들어가지 않습니다 ${'שלום עולם '.repeat(12)}끝`;
  append(s.file, written(s, 't1', 'long.html', page1(long)), written(s, 't2', 'long.md', `# ${long}`), rec.assistant('짧은 답'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(card(page, s.id, 'long.html')).toHaveAttribute('data-state', 'ready');
  const sizes = await view.evaluate((el) => {
    const col = el.querySelector('.cin')!.getBoundingClientRect().width;
    const out = [...el.querySelectorAll('.acard')].map((c) => {
      const t = c.querySelector('.af-title, .at') as HTMLElement;
      return { card: c.getBoundingClientRect().width, title: t.getBoundingClientRect().width, cut: t.scrollWidth > t.clientWidth, overflow: getComputedStyle(t).textOverflow };
    });
    return { col, out, scroll: (el.querySelector('.cscroll') as HTMLElement).scrollWidth - (el.querySelector('.cscroll') as HTMLElement).clientWidth };
  });
  expect(sizes.out).toHaveLength(2);
  for (const c of sizes.out) {
    expect(c.card).toBeLessThanOrEqual(sizes.col);
    expect(c.cut).toBe(true);
    expect(c.overflow).toBe('ellipsis');
  }
  expect(sizes.scroll).toBe(0);
});

test('artifacts 5,000-event history with 3 inline cards keeps the virtual list flat (spec Acceptance 14 input)', async ({ page, chatCore, browserName }) => {
  test.setTimeout(120_000);
  const s = chatCore.chat();
  const msgs = (from: number, n: number) => Array.from({ length: n }, (_, i) => rec.assistant(`메시지 ${from + i}`));
  append(s.file, msgs(0, 1600), written(s, 'h1', 'h1.html', page1('H1')), msgs(1600, 1600), written(s, 'h2', 'h2.html', page1('H2')), msgs(3200, 1700), written(s, 'h3', 'h3.html', page1('H3')), msgs(4900, 94));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('메시지 4993', { exact: true })).toBeVisible();
  const measure = () =>
    page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      frames: document.querySelectorAll('iframe').length,
      heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
    }));
  const start = await measure();
  const scroller = view.locator('.cscroll');
  await scroller.hover();
  let most = 0;
  // V2.5-34: message rows keep a 16px slot for the Copy bar, so an older page is taller in px and 12 steps no longer reach a
  // card: scroll until one has mounted (at most 60 steps), then two steps past it.
  let past = 0;
  for (let i = 0; i < 60 && past < 3; i++) {
    if (most > 0) past++;
    await page.mouse.wheel(0, -2500);
    await page.waitForTimeout(150);
    // V1A-50: a card in view settles (ready or a problem) before it is counted; on a loaded host its load from the
    // core outlasts the pause, and the next wheel scrolled past it unmounted (V1A-17: wait on the state).
    await expect(view.locator('.acard.frame[data-state="loading"]')).toHaveCount(0);
    most = Math.max(most, await view.locator('.acard').count()); // ticket 1088: a card is one line by default (no frame)
  }
  // The scroll passed at least one card, mounted only while near the view.
  expect(most).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const after = await measure();
  console.log(`5k history (${browserName}): nodes ${start.nodes} → ${after.nodes}, frames ${start.frames} → ${after.frames}, heap ${start.heap} → ${after.heap}`);
  expect(after.frames).toBeLessThanOrEqual(3);
  expect(after.nodes).toBeLessThan(start.nodes * 1.5 + 200);
  expect(await view.locator('.crow').count()).toBeLessThan(80);
});

test('artifacts two windows opening the same artifact share 04 grant semantics', async ({ browser, chatCore, art }) => {
  const s = chatCore.chat();
  append(s.file, written(s, 'g1', 'net.html', page1('Net')));
  const pages = await Promise.all([0, 1].map(() => browser.newPage({ viewport: { width: 1440, height: 900 } })));
  for (const p of pages) {
    await p.addInitScript((boot) => (window.__NUNCHIRO__ = boot), chatCore.boot());
    await installHost(p, art);
    await openChat(p, s.id);
  }
  const [a, b] = pages.map((p) => card(p, s.id, 'net.html'));
  await expect(a).toHaveAttribute('data-state', 'ready');
  await expect(b).toHaveAttribute('data-state', 'ready');
  await showFrame(a);
  await showFrame(b);
  const id = await a.locator('.artifact-frame').getAttribute('data-artifact');
  expect(await b.locator('.artifact-frame').getAttribute('data-artifact')).toBe(id);
  expect(await b.getAttribute('data-hash')).toBe(await a.getAttribute('data-hash'));
  // A grant is for this id and hash, wherever it was given (04 keeps grants per app, not per window).
  await a.getByRole('button', { name: 'Network off' }).click();
  await expect(a.locator('.artifact-frame')).toHaveAttribute('data-net', 'on');
  const hits = art.hits.length;
  await b.locator('.af-chip.open').click();
  await expect(pages[1].locator('.preview .pv-frame iframe')).toBeVisible();
  await expect.poll(() => art.hits.slice(hits).filter((h) => h.startsWith(`${id}:`))).toContain(`${id}:wide`);
  // A content change resets it for every window.
  fs.writeFileSync(path.join(s.cwd, 'net.html'), page1('Net', '<p>v2</p>'));
  await expect(b.locator('.af-chip.changed')).toBeVisible({ timeout: 5000 });
  const reset = art.hits.length;
  await b.locator('.af-chip.changed').click();
  await expect.poll(() => art.hits.slice(reset).filter((h) => h.startsWith(`${id}:`))).toContain(`${id}:default`);
  // Polls may still be in flight: drop their routes first so closing does not race a fulfil.
  await Promise.all(pages.map(async (p) => (await p.unrouteAll({ behavior: 'ignoreErrors' }), await p.close())));
});

test('artifacts Preview opens in the side pane and leaves the Diff sidebar alone (AGENTVIEW)', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, written(s, 'w1', 'p.html', page1('P')));
  await openChat(page, s.id);
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  const side = page.locator('.sbar.r .sbh b');
  await expect(side).toHaveText('Diff');
  await card(page, s.id, 'p.html').getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('[data-side-pane] .preview .pv-frame')).toBeVisible();
  await expect(side).toHaveText('Diff'); // Diff stays; Preview has no bar slot
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
});
