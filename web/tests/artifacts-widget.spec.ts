// Ticket v1b-13: the Artifacts (◧) widget. Real core and fake agent (03's chat harness): every row comes from the
// core's own chat events (a user message carrying 05's saved image path, 06's `artifact` events) and every changed
// file from the core's `diff_list`. HTML frames load through 06's browser stand-in for `artifact_open`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { installHost } from './fixtures/artifacts/cards/host';
import { gitChat, page1, PNG, savedImage, write, written } from './fixtures/artifacts-widget/helpers';
import { append, chat, expect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { artifactServer } from './sandbox-server';
import { layoutCli } from './d5b';

type Art = Awaited<ReturnType<typeof artifactServer>>;
// Ticket 570: the strip shows only the selected project's tabs; another project's session opens from its tree row.
const treeRow = (page: Page, id: string) => page.locator(`button.row.wt2[data-menu-session="${id}"]`);
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
      // Chat cards may still be loading frames: drop the route first so the test's end does not race a fulfil.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
    { auto: true },
  ],
});

const dock = (page: Page) => page.getByRole('complementary', { name: 'Artifacts' });
const rows = (page: Page) => dock(page).getByRole('list', { name: 'This session' }).getByRole('listitem');
const changed = (page: Page) => dock(page).getByRole('list', { name: 'Files changed' }).getByRole('listitem');
// AGENTVIEW: Preview opens in the side pane, so the Artifacts sidebar stays open after a row is clicked.
const openWidget = async (page: Page) => {
  if (!(await dock(page).isVisible())) await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
};

/** One pasted image (05's saved path), one HTML artifact and one code edit (+2 −1), in that order. */
function threeRows(chatCore: Parameters<typeof gitChat>[0]) {
  const s = gitChat(chatCore, 'core-serve', { 'src/lib.rs': 'a\nb\n' });
  const img = savedImage(chatCore, s.id, PNG);
  write(s.cwd, 'src/lib.rs', 'a\nc\nd\n');
  append(
    s.file,
    rec.user(`이 화면 봐줘\n${img}`),
    written(s, 'w1', 'site/index.html', page1('Sales chart')),
    rec.edit('e1', path.join(s.cwd, 'src/lib.rs'), ['a', '-b', '+c', '+d']),
    rec.assistant('고쳤습니다.'),
  );
  return { s, img };
}

test('artifacts widget lists a pasted image, an HTML artifact and a code edit in order', async ({ page, chatCore }) => {
  const { s, img } = threeRows(chatCore);
  await openChat(page, s.id);
  await openWidget(page);
  await expect(dock(page)).toBeVisible();
  // Ticket 960: a pasted image reads "png image", not its saved sha256 file name.
  await expect(rows(page)).toHaveText([/png image.*attachment/, /html.*Sales chart.*by agent/]);
  await expect(rows(page).first()).not.toContainText(path.basename(img, '.png'));
  // Diff's own list: the code file, and the HTML file too (an artifact type still lists when changed).
  await expect(changed(page)).toHaveText([/site\/index\.html.*\+1 −0/, /src\/lib\.rs.*\+2 −1/]);
  // The same counts as Diff's own list.
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Changed files' }).locator('[data-path="src/lib.rs"]')).toContainText('+2 −1');
});

test('artifacts widget: each entry opens in one click', async ({ page, chatCore }) => {
  const { s } = threeRows(chatCore);
  await openChat(page, s.id);
  await page.evaluate(() => {
    (window as unknown as { __clicks: number }).__clicks = 0;
    document.addEventListener('click', () => (window as unknown as { __clicks: number }).__clicks++, true);
  });
  const clicks = () => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
  // The pasted image: Preview shows it from the data folder.
  await openWidget(page);
  let before = await clicks();
  await rows(page).nth(0).locator('button.it').click();
  await expect(page.locator('.preview')).toHaveAttribute('data-path', new RegExp(`^images/${s.id}/[0-9a-f]{64}\\.png$`));
  await expect.poll(() => page.locator('.preview .pv-body img').evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(1);
  expect((await clicks()) - before).toBe(1);
  // The HTML artifact: Preview's frame, with its id and hash.
  await openWidget(page);
  before = await clicks();
  await rows(page).nth(1).locator('button.it').click();
  const pv = page.locator('.preview .pv-frame');
  await expect(pv).toHaveAttribute('data-hash', /.+/);
  await expect(pv.locator('.artifact-frame')).toHaveAttribute('data-artifact', /.+/);
  await expect(pv.frameLocator('iframe').locator('p')).toHaveText('hello');
  expect((await clicks()) - before).toBe(1);
  // The changed file: Diff at that path.
  await openWidget(page);
  before = await clicks();
  await changed(page).filter({ hasText: 'src/lib.rs' }).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Diff of src/lib.rs' }).locator('tr.add')).toHaveText([/c/, /d/]);
  expect((await clicks()) - before).toBe(1);
});

/** Box of every visible "This session" row and the "Files changed" heading, keyed by row. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    const list = document.querySelector('.aw .awlist')!.getBoundingClientRect();
    const box = (k: string, e: Element) => {
      const r = e.getBoundingClientRect();
      out[k] = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
    };
    for (const e of document.querySelectorAll('.aw .awrow')) {
      const r = e.getBoundingClientRect();
      if (r.bottom > list.top && r.top < list.bottom) box((e as HTMLElement).dataset.key!, e);
    }
    document.querySelectorAll('.aw .sec').forEach((e, i) => box(`sec-${i}`, e));
    return out;
  });

test('artifacts widget focus switch: the list follows the focused session within one render; a pinned placement keeps its session', async ({ page, chatCore }) => {
  const a = gitChat(chatCore, 'alpha', null);
  const b = gitChat(chatCore, '리뷰-03', null);
  append(a.file, written(a, 'a1', 'a.html', page1('Alpha page')));
  append(b.file, written(b, 'b1', 'b.html', page1('Beta page')));
  await openChat(page, a.id);
  await openWidget(page);
  await expect(rows(page)).toHaveText([/Alpha page/]);
  // Every mutation: while the header names 리뷰-03, no alpha row may be on screen.
  await page.evaluate(() => {
    const w = window as unknown as { __mixed: number };
    w.__mixed = 0;
    new MutationObserver(() => {
      const aw = document.querySelector('.sbar.r .aw');
      if (aw?.querySelector('.ph .r')?.textContent === '리뷰-03' && aw.textContent?.includes('Alpha page')) w.__mixed++;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await treeRow(page, b.id).click();
  await expect(rows(page)).toHaveText([/Beta page/]);
  expect(await page.evaluate(() => (window as unknown as { __mixed: number }).__mixed)).toBe(0);
  // A placed widget pinned to 리뷰-03 stays on it while focus moves back to alpha.
  await page.locator('nav[data-bar="right"] .lay').click();
  await expect(page.locator('.lcard[data-card="artifacts"]')).toBeVisible();
  // needs 153: the window has no ':' command line; `nunchiro layout` takes the same words.
  await layoutCli(page, chatCore, 'split right artifacts --pin 리뷰-03 --zone terminal');
  await page.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
  const placed = page.locator('[data-zone-id] .dock.zone.aw');
  await expect(placed.getByRole('list', { name: 'This session' }).getByRole('listitem')).toHaveText([/Beta page/]);
  await page.keyboard.press('Control+1'); // ticket 570: the first project (alpha) and its tab; the split layout shows no tree here
  await expect(chat(page, a.id)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(placed.getByRole('list', { name: 'This session' }).getByRole('listitem')).toHaveText([/Beta page/]);
  await expect(placed.locator('.ph .r')).toHaveText('리뷰-03');
});

test('artifacts widget empty: no focused session, or a session with nothing yet, shows a line and no error', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'fresh', null);
  await openChat(page, s.id);
  await openWidget(page);
  await expect(dock(page).getByRole('status').first()).toHaveText('No attachments or artifacts in this session yet. Attach a file to a message, or ask the agent to make an artifact.');
  await expect(dock(page).getByRole('status').nth(1)).toHaveText('This folder is not a git repository, so there are no changes to show.');
  await expect(dock(page).getByRole('alert')).toHaveCount(0);
  // v25f: Settings is a modal over the workspace; the dock stays behind it and is there again when it closes.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dock(page)).toBeVisible();
  // No focused session: close the session's tab, and the dock's one status line says so.
  await page.locator(`.tab[data-tab="${s.id}"]`).click({ button: 'middle' });
  await expect(page.locator('.tab[data-tab]')).toHaveCount(0);
  await openWidget(page);
  await expect(dock(page).getByRole('status')).toHaveText('Open a session to see its attachments and artifacts. Start a session'); // ticket 469: the button that fills it
  await expect(dock(page).locator('.ph .r')).toHaveText('');
});

test('artifacts widget: an artifact that cannot open shows 06’s state word and clicks like 06’s card, never reading outside roots', async ({ page, chatCore, host }) => {
  const s = gitChat(chatCore, 'broken', null);
  const outside = path.join(chatCore.home, 'secret.html');
  fs.writeFileSync(outside, page1('secret'));
  append(
    s.file,
    written(s, 'o1', '', page1('Outside'), { at: outside }),
    written(s, 'g1', 'gone.html', page1('Gone')),
    written(s, 'b1', 'big.html', page1('Big', 'x'.repeat(2 * 1024 * 1024 + 10)), { record: page1('Big') }),
  );
  fs.rmSync(path.join(s.cwd, 'gone.html'));
  await openChat(page, s.id);
  await openWidget(page);
  const row = (key: string) => dock(page).locator(`.awrow[data-key="${key}"] button.it`);
  const want: [string, string, string][] = [
    [`${s.id}:${outside}`, 'outside', 'outside folder'],
    [`${s.id}:gone.html`, 'missing', 'missing'],
    [`${s.id}:big.html`, 'too_large', 'too large'],
  ];
  for (const [key, state, word] of want) {
    await expect(row(key)).toHaveAttribute('data-state', state);
    await expect(row(key).locator('.astate')).toHaveText(word);
  }
  // 06's card offers nothing for outside or missing: the rows are disabled, and Preview never opens.
  await expect(row(`${s.id}:${outside}`)).toBeDisabled();
  await expect(row(`${s.id}:gone.html`)).toBeDisabled();
  await expect(page.locator('.preview')).toHaveCount(0);
  // Over 2 MB: 06's "Open in Files", in one click.
  await row(`${s.id}:big.html`).click();
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText('big.html');
  expect(host.opened.filter((o) => o.includes('secret'))).toEqual([]);
});

test('artifacts widget: the same file written twice is one row with its latest title, in its first place; a fenced block is keyed by its hash', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'twice', null);
  const block = (body: string) => rec.assistant(`차트\n\n\`\`\`nunchiro-artifact html\n<!doctype html><title>Block</title><p>${body}</p>\n\`\`\`\n`);
  append(s.file, written(s, 'w1', 'report.html', page1('Report v1')), written(s, 'w2', 'notes.md', '# Notes'), block('one'), written(s, 'w3', 'report.html', page1('Report v2')), block('one'), block('two'));
  await openChat(page, s.id);
  await openWidget(page);
  // report.html where it first appeared, with its latest title; then notes.md; then the blocks "one" and "two".
  await expect(rows(page)).toHaveText([/Report v2/, /Notes/, /Block/, /Block/]);
  const keys = await rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key!));
  expect(keys.slice(0, 2)).toEqual([`${s.id}:report.html`, `${s.id}:notes.md`]);
  for (const k of keys.slice(2)) expect(k).toMatch(new RegExp(`^data:artifacts/${s.id}/[0-9a-f]{64}\\.html$`));
  expect(new Set(keys).size).toBe(4);
});

test('artifacts widget: a base64 image is an attachment opening 05’s viewer; a path outside the readable roots shows 05’s placeholder', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'images', null);
  const user = (text: string, source: unknown) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source }] } });
  const outside = path.join(chatCore.home, 'elsewhere.png');
  fs.writeFileSync(outside, PNG);
  append(s.file, user('inline', { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') }), user('far', { type: 'path', path: outside }), rec.assistant('ok'));
  await openChat(page, s.id);
  await openWidget(page);
  await expect(rows(page)).toHaveText([/png image.*attachment/, /elsewhere\.png.*attachment/]);
  const bytes = rows(page).nth(0);
  await expect(bytes.locator('.awthumb img')).toBeVisible();
  await bytes.locator('button.it').click();
  await expect(page.getByRole('dialog', { name: 'Image png image' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const far = rows(page).nth(1);
  await expect(far.locator('.awthumb [role="img"]')).toHaveAttribute('aria-label', 'Image elsewhere.png: outside the readable folders');
  await expect(far.locator('button.it')).toBeDisabled();
});

test('artifacts widget: 300 entries virtualise without dropping the newest; Hangul and RTL names ellipsise inside the zone', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'many', null);
  const hangul = '프로세스 그룹 정리 순서와 세션 종료 경로를 한눈에 보는 아주 긴 한글 제목의 산출물 페이지';
  const rtl = 'تقرير طويل جدا عن ترتيب إنهاء الجلسات ومجموعات العمليات في النظام';
  // One chat page holds the newest 200 events: one message carrying 298 saved image paths fits in it.
  const paths = Array.from({ length: 298 }, (_, i) => savedImage(chatCore, s.id, Buffer.concat([PNG, Buffer.from([i & 255, i >> 8])])));
  append(s.file, rec.user(paths.join('\n')), written(s, 'h1', 'hangul.html', page1(hangul)), written(s, 'r1', 'rtl.html', page1(rtl)));
  await openChat(page, s.id);
  await openWidget(page);
  const width = await dock(page).evaluate((e) => e.getBoundingClientRect().width);
  await expect(rows(page).first()).toBeVisible();
  expect(await rows(page).count()).toBeLessThan(60);
  const list = dock(page).getByRole('list', { name: 'This session' });
  await list.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect(rows(page).last()).toContainText(rtl);
  for (const name of [hangul, rtl]) {
    const n = rows(page).filter({ hasText: name }).locator('.awn');
    await expect(n).toBeVisible();
    expect(await n.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  }
  expect(await dock(page).evaluate((e) => e.getBoundingClientRect().width)).toBe(width);
  // The oldest is still there, scrolled back to.
  await list.evaluate((e) => (e.scrollTop = 0));
  await expect(rows(page).first()).toHaveAttribute('data-key', new RegExp(`/${path.basename(paths[0])}$`)); // ticket 960: shown as "png image"
});

test('artifacts widget: new entries while the list is scrolled move nothing visible', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'live', null);
  append(s.file, Array.from({ length: 60 }, (_, i) => written(s, `m${i}`, `n/${i}.md`, `# Note ${i}`)).flat());
  await openChat(page, s.id);
  await openWidget(page);
  const list = dock(page).getByRole('list', { name: 'This session' });
  await expect(rows(page).first()).toBeVisible();
  // The baseline waits for the Files changed answer: "Loading changes…" is one line, the not-git note two (18 px).
  await expect(dock(page).getByRole('status')).toHaveText(/not a git repository/);
  await list.evaluate((e) => (e.scrollTop = 400));
  await page.waitForTimeout(200);
  const before = await boxes(page);
  const height = () => list.evaluate((e) => e.scrollHeight);
  const h0 = await height();
  append(s.file, written(s, 'late1', 'late/a.html', page1('Late A')), written(s, 'late2', 'late/b.md', '# Late B'));
  await expect.poll(height).toBe(h0 + 80);
  await page.waitForTimeout(200);
  expect(await boxes(page)).toEqual(before);
  // A rewrite of a row above the view updates it in place: nothing below shifts.
  const above = await list.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const r = [...el.querySelectorAll<HTMLElement>('.awrow')].find((e) => e.getBoundingClientRect().bottom <= top);
    return r!.dataset.key!.split(':').pop()!;
  });
  append(s.file, written(s, 'again', above, '# Rewritten above'));
  await expect(rows(page).filter({ hasText: 'Rewritten above' })).toHaveCount(1);
  await page.waitForTimeout(200);
  expect(await boxes(page)).toEqual(before);
  expect(await height()).toBe(h0 + 80);
});

test('artifacts widget: Diff list states (not_git, no_commits, truncated) show Diff’s own wording', async ({ page, chatCore }) => {
  const plain = gitChat(chatCore, 'plain', null);
  const empty = gitChat(chatCore, 'empty', 'no_commits');
  write(empty.cwd, 'a.txt', 'a\n');
  const huge = gitChat(chatCore, 'huge', {});
  for (let i = 0; i <= 2000; i++) write(huge.cwd, `u/${i}.txt`, '');
  await openChat(page, plain.id);
  await openWidget(page);
  const diffWords = async () => {
    await page.getByRole('button', { name: 'Diff', exact: true }).click();
    const d = page.getByRole('complementary', { name: 'Diff' });
    await expect(d).toBeVisible();
    return d;
  };
  await expect(dock(page).getByRole('status').nth(1)).toHaveText('This folder is not a git repository, so there are no changes to show.');
  await expect((await diffWords()).getByRole('status')).toHaveText('This folder is not a git repository, so there are no changes to show.');
  await treeRow(page, empty.id).click();
  await openWidget(page);
  await expect(dock(page).locator('.awnote')).toHaveText('compared with an empty repository · at session start');
  await expect(changed(page)).toHaveText([/a\.txt/]);
  await expect((await diffWords()).locator('.dbase')).toContainText('vs an empty repository · this checkout since session start');
  await treeRow(page, huge.id).click();
  await openWidget(page);
  await expect(dock(page).getByRole('note')).toHaveText('Showing the first 2000 files; more changed.', { timeout: 15_000 });
  await expect((await diffWords()).getByRole('note')).toHaveText('Showing the first 2000 files; more changed.', { timeout: 15_000 });
});

// v1b-28: the V1B-13 review follow-ups.
test('artifacts_list_indent_matches_files_list', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/artifacts-widget/Artifacts.tsx'), 'utf8');
  const indent = (cls: string) => src.match(new RegExp(`^( *)<ul [^\\n]*className="${cls}"`, 'm'))![1].length;
  expect(indent('awlist')).toBe(indent('awfiles'));
  // Its closing tag lines up with it too.
  expect(src).toMatch(new RegExp(`^ {${indent('awlist')}}</ul>\\n {${indent('awlist') - 2}}</>\\n  \\);\\n}\\n\\nfunction Changes`, 'm'));
});

test('disabled_artifact_rows_name_their_reason_by_aria_describedby', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'reasons', null);
  const outside = path.join(chatCore.home, 'secret.html');
  fs.writeFileSync(outside, page1('secret'));
  const far = path.join(chatCore.home, 'elsewhere.png');
  fs.writeFileSync(far, PNG);
  const image = { type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'far' }, { type: 'image', source: { type: 'path', path: far } }] } };
  append(s.file, written(s, 'o1', '', page1('Outside'), { at: outside }), written(s, 'g1', 'gone.html', page1('Gone')), image, rec.assistant('ok'));
  fs.rmSync(path.join(s.cwd, 'gone.html'));
  await openChat(page, s.id);
  await openWidget(page);
  const disabled = dock(page).locator('button.it:disabled');
  await expect(disabled).toHaveCount(3);
  const reasons = ['Outside the session folder: Nunchiro does not read it. Ask the agent to save it inside the session folder.', 'The file is gone: it was deleted or moved after the agent wrote it. Ask the agent to write it again.', 'outside the readable folders'];
  for (const [i, reason] of reasons.entries()) {
    const row = disabled.nth(i);
    await expect(row).toHaveAccessibleDescription(reason);
    // The description is a real element in the page, not only a tooltip.
    await expect(row).toHaveAttribute('aria-describedby', /.+/);
    const id = (await row.getAttribute('aria-describedby'))!;
    await expect(page.locator(`[id="${id}"]`)).toHaveText(reason);
  }
});

test('artifacts_item_full_width: the changed-file row has no inline width and fills its list row', async ({ page, chatCore }) => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/artifacts-widget/Artifacts.tsx'), 'utf8');
  expect(src).not.toContain("width: '100%'");
  const { s } = threeRows(chatCore);
  await openChat(page, s.id);
  await openWidget(page);
  await expect(changed(page)).toHaveCount(2);
  const row = changed(page).first();
  const [li, it] = await Promise.all([row.boundingBox(), row.locator('button.it').boundingBox()]);
  expect(it!.width).toBeCloseTo(li!.width, 0);
});

test('B21 (ticket 991): Python bytecode caches are not listed as files changed', async ({ page, chatCore }) => {
  const { s } = threeRows(chatCore);
  write(s.cwd, '__pycache__/app.cpython-312.pyc', 'x');
  await openChat(page, s.id);
  await openWidget(page);
  await expect(changed(page)).toHaveCount(2);
  await expect(changed(page).filter({ hasText: '__pycache__' })).toHaveCount(0);
});
