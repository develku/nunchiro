// Ticket v1b-10: Search (⌕ sidebar and `search` widget) over the focused session's folder through the core's
// `files_search`, opening V1B-09's viewer at the line. Real core and a `cat` shell session; a recording socket
// proxy counts requests and holds or replaces replies where a test needs a busy core or out-of-order replies.
import fs from 'node:fs';
import path from 'node:path';
import { expect, goTab, openWindow, test } from './fixtures';
import { physical, view } from './fixtures/files/harness';
import { field, hit, hits, KOREAN_NAME, listed, panel, proxy, search, setup, status } from './fixtures/search/harness';
import { makeT, mergeAreas } from '../src/i18n';
import * as errors from '../src/i18n/areas/errors';
import * as kit from '../src/i18n/areas/settings-kit';
import { plainError } from '../src/errors';

const NEEDLE = ['long.txt:1', 'markup.txt:1', 'markup.txt:2', 'notes.md:3', 'src/app.ts:2', 'src/app.ts:6', `${KOREAN_NAME}:2`];
const sorted = (a: string[]) => [...a].sort();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('search returns fixture hits and skips ignored files', async ({ app, core }) => {
  const { dir } = await setup(app, core);
  // The ignored file is there and holds the query: only .gitignore keeps it out.
  expect(fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8')).toContain('needle');
  await search(app, 'needle');
  await expect.poll(async () => sorted(await listed(app))).toEqual(sorted(NEEDLE));
  await expect(panel(app).locator('.hit[data-path="ignored.txt"]')).toHaveCount(0);
  await expect(status(app)).toHaveText('7 matches in 5 files');
  // No oversized .gitignore here, so no note.
  await expect(panel(app).getByRole('note')).toHaveCount(0);
  // The match is highlighted as text, never parsed as HTML.
  await expect(hit(app, 'src/app.ts', 2).locator('mark')).toHaveText('needle');
  // Markup and terminal escapes in a line are shown as their characters, never parsed.
  await expect(hit(app, 'markup.txt', 1).locator('.stx')).toHaveText('<b>needle</b> stays text');
  expect(await hit(app, 'markup.txt', 2).locator('.stx').textContent()).toBe('\x1b[31mneedle\x1b[0m stays text');
  await expect(panel(app).locator('.hits b, .hits script, .hits font')).toHaveCount(0);
});

test('search result opens viewer at line', async ({ app, core }) => {
  await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, 'deep.txt'), Array.from({ length: 400 }, (_, i) => (i === 349 ? 'the needle at 350' : `line ${i + 1}`)).join('\n')) });
  await search(app, 'needle at');
  await hit(app, 'deep.txt', 350).click();
  const target = view(app, 'deep.txt').locator('.cm-target');
  await expect(target).toHaveText('the needle at 350');
  await expect(target).toBeInViewport();
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('deep.txt');
  // The panel keeps its results while the file tab is active (the tab belongs to the same session).
  await expect(hit(app, 'deep.txt', 350)).toBeVisible();
});

test('search field composes Hangul', async ({ app, core, browserName }) => {
  const { wire } = await setup(app, core);
  await field(app).focus();
  if (browserName === 'chromium') {
    const cdp = await app.context().newCDPSession(app);
    // Mid-composition (ㄴ → 누 → 눈, held well past the 300 ms pause) sends nothing.
    for (const [text, final] of [
      ['ㄴ', ''],
      ['누', ''],
      ['눈', '눈'],
      ['ㅊ', ''],
      ['치', '치'],
      ['ㄹ', ''],
      ['로', '로'],
    ]) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      await wait(final ? 15 : 400);
      expect(wire.searches, `while composing ${text}`).toEqual([]);
      if (final) await cdp.send('Input.insertText', { text: final });
    }
  } else await app.keyboard.insertText('눈치로');
  await expect(field(app)).toHaveValue('눈치로');
  await expect.poll(() => wire.searches.map((s) => s.query)).toEqual(['눈치로']);
  await expect.poll(() => listed(app)).toEqual([`${KOREAN_NAME}:2`]);
});

test('search edge: an empty or whitespace query sends nothing; over 256 bytes shows the limit and sends nothing', async ({ app, core }) => {
  const { wire } = await setup(app, core);
  await search(app, '');
  await search(app, '   \t ');
  await wait(400);
  expect(wire.searches).toEqual([]);
  // 86 syllables are 258 bytes in UTF-8.
  await search(app, '가'.repeat(86));
  await expect(status(app)).toHaveText('Over 256 bytes (UTF-8): shorten the text to search');
  await wait(400);
  expect(wire.searches).toEqual([]);
  await search(app, '가'.repeat(85));
  await expect.poll(() => wire.searches.length).toBe(1);
  await expect(status(app)).toHaveText('No matches');
});

test('search edge: no hits shows No matches; a truncated search says where it stopped', async ({ app, core }) => {
  await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, 'many.txt'), 'pin\n'.repeat(250)) });
  await search(app, 'nothing-matches-this');
  await expect(status(app)).toHaveText('No matches');
  await expect(hits(app)).toHaveCount(0);
  await search(app, 'pin');
  await expect(status(app)).toHaveText('First 200 matches (stopped at 200 matches or 2 s)');
  await expect(hits(app)).toHaveCount(200);
});

test('search edge: a search stopped at the 2 s deadline before any match says so, never No matches', async ({ app, core }) => {
  const { wire } = await setup(app, core);
  wire.hook = (req) => JSON.stringify({ id: req.id, response: { Ok: { type: 'matches', matches: [], truncated: true, skipped_ignore_files: [] } } });
  await search(app, 'needle');
  await expect(status(app)).toHaveText('Search stopped at 2 s before any match');
  await expect(hits(app)).toHaveCount(0);
});

test('search edge: a .gitignore over 64 KB that the core did not apply is named in the panel', async ({ app, core }) => {
  await setup(app, core, {
    extra: (d) => {
      fs.mkdirSync(path.join(d, 'big'));
      fs.writeFileSync(path.join(d, 'big/.gitignore'), `${'# filler line\n'.repeat(5000)}hidden.txt\n`);
      fs.writeFileSync(path.join(d, 'big/hidden.txt'), 'needle under an unapplied ignore file\n');
    },
  });
  await search(app, 'needle');
  await expect(panel(app).getByRole('note')).toHaveText('.gitignore over 64 KB not applied: big/.gitignore');
  await expect(hit(app, 'big/hidden.txt', 1)).toBeVisible();
});

test('search edge: regex metacharacters and a leading dash match literally', async ({ app, core }) => {
  await setup(app, core);
  await search(app, '.b*c(d)[');
  await expect.poll(() => listed(app)).toEqual(['meta.txt:1']);
  await search(app, 'a.b');
  await expect.poll(() => listed(app)).toEqual(['meta.txt:1']);
  await search(app, '-flag');
  await expect.poll(() => listed(app)).toEqual(['meta.txt:2']);
});

test('search edge: search busy and other core refusals show the core message, never a blank list', async ({ app, core }) => {
  const { wire } = await setup(app, core);
  await search(app, 'needle');
  await expect(hits(app)).toHaveCount(NEEDLE.length);
  wire.hook = (req) => JSON.stringify({ id: req.id, response: { Err: 'search busy: try again in a moment' } });
  await search(app, 'Notes');
  await expect(panel(app).getByRole('alert')).toHaveText('Another search is still running. Try again in a moment.'); // ticket 551: the core's sentence is in the catalogue
  await expect(hits(app)).toHaveCount(0);
  // A reply with no match list fails closed too.
  wire.hook = (req) => JSON.stringify({ id: req.id, response: { Ok: { type: 'matches' } } });
  await search(app, 'needle');
  await expect(panel(app).getByRole('alert')).toHaveText('unexpected search reply from the background service'); // leftovers.search.badReply
  wire.hook = null;
  await search(app, 'Notes');
  await expect.poll(() => listed(app)).toEqual(['notes.md:1']);
});

test('search edge: a reply to an older query or an earlier session never replaces newer results', async ({ app, core }) => {
  const { s: a, wire } = await setup(app, core);
  const held: string[] = [];
  wire.hook = (req, reply) => (req.query === 'needle' ? (held.push(reply), null) : undefined);
  await search(app, 'needle');
  await expect.poll(() => held.length).toBe(1);
  await search(app, 'Notes');
  // One request in flight per panel: the newer query waits for the older reply.
  await wait(400);
  expect(wire.searches.map((s) => s.query)).toEqual(['needle']);
  wire.deliver(held[0]);
  await expect.poll(() => listed(app)).toEqual(['notes.md:1']);
  expect(wire.searches.map((s) => s.query)).toEqual(['needle', 'Notes']);
  // Clearing the field while a reply is out: the late reply brings nothing back.
  await search(app, 'needle');
  await expect.poll(() => held.length).toBe(2);
  await search(app, '');
  // Retyped while that reply is still out: the panel says it is searching, not a blank line.
  await search(app, 'Notes');
  await expect(status(app)).toHaveText('Searching…');
  wire.hook = null;
  wire.deliver(held[1]);
  await expect.poll(() => listed(app)).toEqual(['notes.md:1']);
  await search(app, '');
  await expect(hits(app)).toHaveCount(0);
  wire.hook = (req, reply) => (req.query === 'needle' ? (held.push(reply), null) : undefined);
  held.length = 1;

  // The same across a session switch: session A's late reply is dropped once B is focused.
  const other = core.project('other');
  fs.writeFileSync(path.join(other, 'b.txt'), 'needle in b\n');
  const b = core.shell(other, 'other');
  await goTab(app, core, a.id);
  await search(app, 'needle');
  await expect.poll(() => held.length).toBe(2);
  await goTab(app, core, b.id);
  wire.deliver(held[1]);
  wire.hook = null;
  await expect.poll(() => listed(app)).toEqual(['b.txt:1']);
  await wait(300);
  expect(await listed(app)).toEqual(['b.txt:1']);
});

test('search edge: switching the focused session clears results and re-runs the query against the new root', async ({ app, core }) => {
  const { s: a, wire } = await setup(app, core);
  const other = core.project('other');
  fs.writeFileSync(path.join(other, 'b.txt'), 'one needle\ntwo needle\n');
  const b = core.shell(other, 'other');
  await goTab(app, core, a.id);
  await search(app, 'needle');
  await expect(hits(app)).toHaveCount(NEEDLE.length);
  // B's reply is held: until it arrives the list is empty, never A's results under B's name.
  const held: string[] = [];
  wire.hook = (req, reply) => (req.root === b.id ? (held.push(reply), null) : undefined);
  await goTab(app, core, b.id);
  await expect.poll(() => held.length).toBe(1);
  await expect(hits(app)).toHaveCount(0);
  wire.deliver(held[0]);
  await expect.poll(() => listed(app)).toEqual(['b.txt:1', 'b.txt:2']);
  expect(wire.searches.at(-1)).toMatchObject({ root: b.id, query: 'needle' });
  await expect(field(app)).toHaveValue('needle');
});

test('search edge: no focused session asks for one', async ({ app, core }) => {
  await proxy(app);
  await openWindow(app, {}, core);
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(status(app)).toHaveText('Focus a session to search its folder');
  await expect(field(app)).toBeDisabled();
});

test('search edge: a removed worktree or folder says so plainly, the core message as the tooltip (ticket 480)', async ({ app, core }) => {
  const { dir, wire } = await setup(app, core);
  fs.rmSync(dir, { recursive: true, force: true });
  await search(app, 'needle');
  await expect.poll(() => wire.replies.size).toBe(1);
  const err = JSON.parse([...wire.replies.values()][0]).response.Err as string;
  expect(err).toBeTruthy();
  const t = makeT<string>('en', 'en', mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { errors, kit }) as never) as Parameters<typeof plainError>[0];
  await expect(panel(app).getByRole('alert')).toHaveText(plainError(t, err));
  await expect(panel(app).getByRole('alert')).toHaveAttribute('title', err);
  expect(plainError(t, err)).not.toBe(t('err.failed') + ' ' + t('err.failed.todo')); // a removed folder is a known failure
});

test('search edge: a Korean query and a Hangul, emoji and space file name list and open; names ellipsise', async ({ app, core }) => {
  const long = '한글 파일 이름 🎉 아주 길고 긴 설명이 붙은 메모 정리본 최종.md';
  await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, long), '제목\n눈치로 검색 한 번 더\n') });
  const width = async () => (await app.locator('.sbar.l').boundingBox())!.width;
  const w = await width();
  await search(app, '눈치로 검색');
  await expect.poll(async () => sorted(await listed(app))).toEqual(sorted([`${KOREAN_NAME}:2`, `${long}:2`]));
  const name = panel(app).locator(`.sfile[data-path="${long}"] .n`);
  expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis')).toBe(true);
  expect(await width()).toBe(w);
  await hit(app, KOREAN_NAME, 2).click();
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('📝');
  await expect(app.locator(`.fview[data-file="${KOREAN_NAME}"]`)).toBeVisible();
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('search edge: a 300-character cut line ellipsises in one row; results never shift the centre', async ({ app, core }) => {
  await setup(app, core);
  const centre = async () => JSON.stringify(await app.locator('.layout').boundingBox());
  const before = await centre();
  await search(app, 'needle');
  const row = hit(app, 'long.txt', 1);
  await expect(row).toBeVisible();
  const short = await hit(app, 'notes.md', 3).boundingBox();
  expect((await row.boundingBox())!.height).toBe(short!.height);
  expect(await row.locator('.stx').evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis')).toBe(true);
  // One line of text in every row: nothing wraps inside the fixed row height.
  for (const r of await hits(app).all()) expect(await r.locator('.stx').evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  // The match sits at column 121: the row starts near it, so it is in view.
  await expect(row.locator('mark')).toBeInViewport();
  expect(await centre()).toBe(before);
  await search(app, 'nothing-matches-this');
  await expect(status(app)).toHaveText('No matches');
  expect(await centre()).toBe(before);
});

test('search edge: prefix keys and hints reach the search field and result rows with a Korean input source', async ({ app, core }) => {
  await setup(app, core);
  await app.locator('.cmd').focus();
  // ⌃Space s (search.open) as a Korean source sends it: keyCode 229, key "Process".
  await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await physical(app, { code: 'KeyS', key: 'Process', keyCode: 229 });
  await expect(field(app)).toBeFocused();
  await search(app, 'needle');
  await expect(hits(app)).toHaveCount(NEEDLE.length);
  // From the field, the prefix still works (it never types into the field).
  await field(app).focus();
  await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await physical(app, { code: 'KeyF', key: 'ㄹ' });
  await expect(app.locator('.hint').first()).toBeVisible();
  await expect(field(app)).toHaveValue('needle');
  const target = (await hit(app, 'notes.md', 3).boundingBox())!;
  // Ticket 389: labels are letters; with Korean input on (key Process) each letter's QWERTY code stands in.
  const all = await app.locator('.hint').evaluateAll((els) => els.map((e) => ({ keys: (e as HTMLElement).dataset.keys!, x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top })));
  const h = all.find((x) => Math.abs(x.x - target.x) < 2 && Math.abs(x.y - target.y) < 2);
  expect(h).toBeTruthy();
  for (const k of h!.keys.split(' ')) await physical(app, { code: (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`), key: 'Process', keyCode: 229 });
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('notes.md');
  await expect(view(app, 'notes.md')).toBeVisible();
});

test('search edge: keyboard only, arrows move through hits, Enter opens, Esc returns to the field', async ({ app, core }) => {
  await setup(app, core);
  await search(app, 'needle');
  await expect(hits(app)).toHaveCount(NEEDLE.length);
  const order = await listed(app);
  await field(app).press('ArrowDown');
  await expect(hits(app).nth(0)).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('ArrowDown');
  await expect(hits(app).nth(2)).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await expect(hits(app).nth(1)).toBeFocused();
  await expect(hits(app).nth(1)).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Escape');
  await expect(field(app)).toBeFocused();
  await field(app).press('ArrowDown');
  await expect(hits(app).nth(1)).toBeFocused();
  await app.keyboard.press('Enter');
  const [p] = order[1].split(':');
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText(path.basename(p));
  await expect(view(app, p).locator('.cm-target, .fv-md')).toBeVisible();
});

test('search widget: a pinned widget searches its own session, not the focused one', async ({ app, core }) => {
  const { s: a } = await setup(app, core, { direct: true });
  const other = core.project('other');
  fs.writeFileSync(path.join(other, 'b.txt'), 'needle in b\n');
  core.shell(other, 'other');
  expect(core.cli('layout', 'split', 'down', 'search', '--pin', 'other', '--zone', 'terminal').type).toBe('text');
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const zone = app.locator('.lz', { has: app.locator('.spanel') });
  await zone.getByRole('searchbox').fill('needle');
  await zone.getByRole('searchbox').press('Enter');
  await expect.poll(() => zone.getByRole('option').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path))).toEqual(['b.txt']);
});

test('search widget: the gallery lists Search and a placed widget searches the focused session', async ({ app, core }) => {
  await setup(app, core, { direct: true });
  await app.getByRole('button', { name: 'Search', exact: true }).click(); // close the ⌕ dock
  await expect(panel(app)).toHaveCount(0);
  expect(core.cli('layout', 'split', 'down', 'search', '--zone', 'terminal').type).toBe('text');
  const zone = app.locator('.lz', { has: app.locator('.spanel') });
  await zone.getByRole('searchbox').fill('needle');
  await zone.getByRole('searchbox').press('Enter');
  await expect(zone.getByRole('option')).toHaveCount(NEEDLE.length);
  await zone.locator('.hit[data-path="notes.md"]').click();
  await expect(view(app, 'notes.md')).toBeVisible();
  await app.locator('nav[data-bar="right"] .lay').click();
  await expect(app.locator('.lcard[data-card="search"]')).toBeVisible();
});
