// Diff (±) widget against a real core (spec B3 Diff, Acceptance 10; ticket v1b-11).
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { layoutCli } from './d5b';
import { listState } from '../src/diff/state';
import { makeT } from './i18n-tables';

// core.autocrlf=false: a host's global `input` (the MacBook's) stored crlf.txt as LF, so both lines diffed (as diff_core.rs).
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

/** A git project with a first commit; `files` maps paths to contents. */
function repo(core: Core, name: string, files: Record<string, string | Buffer>) {
  const dir = core.project(name);
  git(dir, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const write = (dir: string, p: string, body: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), body);
};
const files = (page: Page) => page.getByRole('list', { name: 'Changed files' }).locator('[data-path]');
/** The right bar's Diff icon: the header has its own Diff button since D5b (needs 130), same accessible name. */
const diffIcon = (page: Page) => page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `diff-${name}-${test.info().project.name}.png`) });

test('diff: lists exactly the changed and untracked files against the start commit, in unified and split views', async ({ app, core }) => {
  const dir = repo(core, 'nunchiro', { 'src/core/session.rs': 'fn reap() {\n    self.reap(pid)?;\n}\n', 'b.txt': 'b\n', 'gone.txt': 'bye\n' });
  core.shell(dir, 'core-serve');
  // After the start: a commit, an edit, a delete and an untracked file. The commit still counts.
  write(dir, 'b.txt', 'b committed after start\n');
  git(dir, 'commit', '-q', '-am', 'later');
  write(dir, 'src/core/session.rs', 'fn reap() {\n    self.retire_group(pgid)?;\n    self.reap_all(pid)?;\n}\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  write(dir, 'notes/new.md', '# new\n');
  await openWindow(app);
  await expect(app.locator('.sbar.r')).toHaveCount(0);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  await expect(dock).toBeVisible();
  await expect(files(app)).toHaveText([/b\.txt.*modified/, /gone\.txt.*deleted/, /notes\/new\.md.*untracked/, /src\/core\/session\.rs.*modified.*\+2 −1/]);
  await expect(dock.locator('.dbase')).toContainText('session start · 4 files');
  await shot(app, 'list');
  await files(app).filter({ hasText: 'session.rs' }).click();
  const view = app.getByRole('region', { name: 'Diff of src/core/session.rs' });
  await expect(view.locator('tr.add')).toHaveText([/self\.retire_group\(pgid\)\?;/, /self\.reap_all\(pid\)\?;/]);
  await expect(view.locator('tr.del')).toHaveText([/self\.reap\(pid\)\?;/]);
  // Ticket 374: a shell session has no composer, so the note + on a changed line shows disabled.
  await expect(view.getByRole('button', { name: 'Note on line 2' }).first()).toHaveAttribute('aria-disabled', 'true');
  await shot(app, 'unified');
  await dock.getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Split' }).click();
  // The deletion sits beside the addition that replaced it.
  const first = view.locator('table.dl-split tr').filter({ has: app.locator('td.del') }).first();
  await expect(first.locator('td.del.c')).toContainText('self.reap(pid)?;');
  await expect(first.locator('td.add.c')).toContainText('self.retire_group(pgid)?;');
  await shot(app, 'split');
  // Read only: nothing in the widget stages or reverts. Ticket 373's one git button only asks an agent; a shell has none.
  await expect(dock.getByRole('button', { name: /stage|revert|accept|reject/i })).toHaveCount(0);
  await expect(dock.getByRole('button', { name: /commit/i })).toHaveAttribute('aria-disabled', 'true');
  await expect(dock.getByRole('button', { name: /commit/i })).toHaveAttribute('data-tip', 'A terminal session has no agent to ask.');
});

test('diff: a session in a non-git folder shows an empty state, not an error', async ({ app, core }) => {
  const dir = core.project('plain');
  write(dir, 'x.txt', 'x\n');
  core.shell(dir, 'plain');
  await openWindow(app);
  await diffIcon(app).click();
  await expect(app.getByRole('complementary', { name: 'Diff' }).getByRole('status')).toHaveText(/not a git repository/);
  await expect(app.getByText(/Diff is unavailable/)).toHaveCount(0);
  await shot(app, 'not-git');
});

test('diff: "open Diff at path" opens the widget on that file (diff.open <path>)', async ({ app, core }) => {
  const dir = repo(core, 'demo', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  core.shell(dir, 'alpha');
  write(dir, 'a.txt', 'a changed\n');
  write(dir, 'b.txt', 'b changed\n');
  await openWindow(app);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:diff.open', { detail: { path: 'b.txt' } })));
  await expect(app.locator('[data-path="b.txt"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(app.getByRole('region', { name: 'Diff of b.txt' }).locator('tr.add')).toHaveText([/b changed/]);
});

test('diff: binary, too large, CRLF, missing final newline and Korean names', async ({ app, core }) => {
  const dir = repo(core, 'edge', { 'blob.bin': Buffer.from([0, 1, 2, 0]), 'big.txt': 'old\n'.repeat(30000), 'crlf.txt': 'one\r\ntwo\r\n', '문서/메모.txt': '안녕\n' });
  core.shell(dir, 'edge');
  write(dir, 'blob.bin', Buffer.from([0, 9, 9, 0]));
  write(dir, 'big.txt', 'new\n'.repeat(30000));
  write(dir, 'crlf.txt', 'one\r\nTWO\r\n');
  write(dir, '문서/메모.txt', '안녕하세요');
  await openWindow(app);
  await diffIcon(app).click();
  await expect(files(app)).toHaveCount(4);
  const open = async (p: string) => {
    await app.locator(`[data-path="${p}"]`).click();
    return app.getByRole('region', { name: `Diff of ${p}` });
  };
  await expect(app.locator('[data-path="blob.bin"]')).toContainText('binary');
  await expect(await open('blob.bin')).toContainText('Binary file');
  await expect(await open('big.txt')).toContainText('Too large to show');
  await expect((await open('crlf.txt')).locator('tr.add')).toHaveText([/TWO␍/]);
  const ko = await open('문서/메모.txt');
  await expect(ko.locator('tr.add')).toHaveText([/안녕하세요/]);
  await expect(ko.locator('tr.note')).toHaveText(['No newline at end of file']);
  await shot(app, 'korean');
});

test('diff: the prefix key opens Diff under a Korean input source', async ({ app, core }) => {
  const dir = repo(core, 'demo', { 'a.txt': 'a\n' });
  core.shell(dir, 'alpha');
  write(dir, 'a.txt', 'changed\n');
  await openWindow(app);
  // ⌃Space then KeyG, as the Korean 2-set layout reports it (key ㅎ).
  const key = (init: { code: string; key: string; ctrlKey?: boolean }) => app.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);
  await key({ code: 'Space', key: ' ', ctrlKey: true });
  await key({ code: 'KeyG', key: 'ㅎ' });
  await expect(app.getByRole('complementary', { name: 'Diff' })).toBeVisible();
  await expect(files(app)).toHaveText([/a\.txt/]);
});

test('diff: two windows viewing the same diff both show it', async ({ app, core, context }) => {
  const dir = repo(core, 'demo', { 'a.txt': 'a\n' });
  core.shell(dir, 'alpha');
  write(dir, 'a.txt', 'changed\n');
  write(dir, 'u.txt', 'new\n');
  const other = await context.newPage();
  await other.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  for (const page of [app, other]) {
    await openWindow(page, {}, core);
    // The windows share this browser's storage, so the second one opens with Diff already showing on its bar.
    const icon = diffIcon(page);
    if ((await icon.getAttribute('aria-pressed')) !== 'true') await icon.click();
  }
  for (const page of [app, other]) await expect(files(page)).toHaveText([/a\.txt.*modified/, /u\.txt.*untracked/]);
  await other.close();
});

test('diff: a start commit that no longer exists shows its own state, not a git error', async ({ app, core }) => {
  const dir = repo(core, 'rewritten', { 'a.txt': 'a\n' });
  core.shell(dir, 'alpha');
  // Rewrite the only commit and prune the old one, as a rebase plus gc would.
  write(dir, 'a.txt', 'amended\n');
  git(dir, 'commit', '-q', '-a', '--amend', '-m', 'amended');
  git(dir, 'reflog', 'expire', '--expire=now', '--all');
  git(dir, 'gc', '-q', '--prune=now');
  await openWindow(app);
  await diffIcon(app).click();
  await expect(app.getByRole('complementary', { name: 'Diff' }).getByRole('status')).toHaveText(/start commit no longer exists/);
  await expect(app.getByText(/fatal|bad object/)).toHaveCount(0);
});

test('diff: the widget gallery lists Diff, and a placed Diff follows the focused session', async ({ app, core }) => {
  const dir = repo(core, 'demo', { 'a.txt': 'a\n' });
  core.shell(dir, 'alpha');
  write(dir, 'a.txt', 'changed\n');
  await openWindow(app);
  await app.locator('nav[data-bar="right"] .lay').click();
  await expect(app.locator('.lcard[data-card="diff"]')).toBeVisible();
  // needs 153: the window has no ':' command line; `nunchiro layout` takes the same words.
  await layoutCli(app, core, 'split right diff --zone terminal');
  await app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
  const toml = path.join(core.home, 'layout.toml');
  await expect.poll(() => (fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : '')).toContain('"diff"');
  const placed = app.locator('[data-zone-id] .dock.zone.diff');
  await expect(placed.locator('[data-path]')).toHaveText([/a\.txt.*modified/]);
  await expect(placed.getByRole('button', { name: 'Close Diff' })).toHaveCount(0);
  await shot(app, 'gallery');
});

// needs 171, 172 (chat basics, ticket 198): the Diff widget's hover text, Open file and keys.
const tip = (page: Page) => page.locator('#app-tip');
const recordOpens = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __opens: unknown[] };
    w.__opens = [];
    window.addEventListener('nunchiro:files.open', (e) => w.__opens.push((e as CustomEvent).detail));
  });
const opens = (page: Page) => page.evaluate(() => (window as unknown as { __opens: unknown[] }).__opens);

test('changed_file_path_tooltip (Diff): a cut path in the changed-file list shows the full path on hover; a short one shows none', async ({ app, core }) => {
  const long = `${'quite-long-directory-name/'.repeat(6)}deep-file-name.ts`;
  const dir = repo(core, 'tips', { 'a.txt': 'a\n' });
  core.shell(dir, 'tips');
  write(dir, long, 'x\n');
  write(dir, 'a.txt', 'a2\n');
  await openWindow(app);
  await diffIcon(app).click();
  const name = files(app).filter({ hasText: 'deep-file-name' }).locator('.dname .mono');
  await expect(name).toBeVisible();
  expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await name.hover();
  await expect(tip(app)).toHaveText(long);
  await app.mouse.move(5, 5);
  await expect(tip(app)).toBeHidden();
  await files(app).filter({ hasText: 'a.txt' }).locator('.dname .mono').hover();
  await app.waitForTimeout(600);
  await expect(tip(app)).toBeHidden();
});

test('diff_open_file_and_line: the Open file control and a double-click on a line each open a file tab (the line one at its line); a deleted file\'s control is aria-disabled', async ({ app, core }) => {
  const dir = repo(core, 'openfile', { 'src/a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n' });
  const s = core.shell(dir, 'openfile');
  write(dir, 'src/a.txt', 'one\ntwo\nTHREE\nfour\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  await recordOpens(app);
  await openWindow(app);
  await diffIcon(app).click();
  // A file tab takes the centre (Diff follows the focused session), so each step goes back to the session's tab first.
  const pick = async (file: string) => {
    await app.locator(`.tab[data-tab="${s.id}"]`).click();
    await files(app).filter({ hasText: file }).click();
    return app.getByRole('region', { name: `Diff of ${file}` });
  };
  // The control.
  let view = await pick('src/a.txt');
  const open = view.getByRole('button', { name: 'Open file' });
  await expect(open).toBeEnabled();
  await open.click();
  await expect(app.locator(`.tab[data-tab="file:${s.id}:src/a.txt"]`)).toHaveCount(1);
  expect(await opens(app)).toEqual([{ root: s.id, path: 'src/a.txt' }]);
  // N28 (look 1117 v3): the file tab takes the centre; Diff keeps the session the file belongs to, not an empty pane.
  await expect(files(app).filter({ hasText: 'src/a.txt' })).toHaveCount(1);
  // A double-click on a line: the new-file number of an added line, and of a context line.
  view = await pick('src/a.txt');
  await view.locator('tr.add', { hasText: 'THREE' }).dblclick();
  await expect.poll(async () => (await opens(app)).at(-1)).toEqual({ root: s.id, path: 'src/a.txt', line: 3 });
  view = await pick('src/a.txt');
  await view.locator('tr', { has: app.locator('td.c', { hasText: /^\s*two$/ }) }).dblclick();
  await expect.poll(async () => (await opens(app)).at(-1)).toEqual({ root: s.id, path: 'src/a.txt', line: 2 });
  // A deleted file has nothing to open.
  view = await pick('gone.txt');
  // chat6 item 2: aria-disabled, not disabled, so Tab reaches it (the test below); the tooltip shows on hover too.
  await expect(view.getByRole('button', { name: 'Open file' })).toHaveAttribute('aria-disabled', 'true');
  await view.getByRole('button', { name: 'Open file' }).hover({ force: true });
  await expect(tip(app)).toHaveText('Deleted: there is no file to open');
  const before = (await opens(app)).length;
  await view.locator('tr.del').first().dblclick();
  await app.waitForTimeout(300);
  expect((await opens(app)).length).toBe(before);
});

test('diff_open_deleted_focusable: Tab reaches a deleted file\'s Open file control, it is aria-disabled (not disabled), Enter and click open nothing, and the tooltip shows on keyboard focus; a live file still opens', async ({ app, core, browserName }) => {
  const dir = repo(core, 'delfocus', { 'src/a.txt': 'one\n', 'gone.txt': 'bye\n' });
  const s = core.shell(dir, 'delfocus');
  write(dir, 'src/a.txt', 'one\ntwo\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  await recordOpens(app);
  await openWindow(app);
  await diffIcon(app).click();
  await files(app).filter({ hasText: 'gone.txt' }).click();
  const view = app.getByRole('region', { name: 'Diff of gone.txt' });
  const open = view.getByRole('button', { name: 'Open file' });
  await expect(open).toHaveAttribute('aria-disabled', 'true');
  await expect(open).not.toHaveAttribute('disabled', /.*/);
  await files(app).filter({ hasText: 'gone.txt' }).focus();
  // Ticket 374: the stack's options bar and the files above gone.txt add stops before its header.
  for (let i = 0; i < 30 && !(await open.evaluate((e) => e === document.activeElement)); i++) await app.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); // WebKit's Tab skips buttons, as Safari's does
  await expect(open).toBeFocused();
  await expect(tip(app)).toHaveText('Deleted: there is no file to open');
  await app.keyboard.press('Enter');
  await open.click({ force: true }); // Playwright treats aria-disabled as not actionable
  await app.waitForTimeout(300);
  expect(await opens(app)).toEqual([]);
  await expect(app.locator(`.tab[data-tab="file:${s.id}:gone.txt"]`)).toHaveCount(0);
  // A live file still opens.
  await files(app).filter({ hasText: 'src/a.txt' }).click();
  const live = app.getByRole('region', { name: 'Diff of src/a.txt' }).getByRole('button', { name: 'Open file' });
  await expect(live).not.toHaveAttribute('aria-disabled', 'true');
  await live.click();
  await expect(app.locator(`.tab[data-tab="file:${s.id}:src/a.txt"]`)).toHaveCount(1);
});

test('diff_list_arrows: Down, Up, Home and End move between the changed files (roving tabindex) and Enter opens the diff of the one reached', async ({ app, core }) => {
  const dir = repo(core, 'arrows', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  core.shell(dir, 'arrows');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) write(dir, f, `${f} changed\n`);
  await openWindow(app);
  await diffIcon(app).click();
  await expect(files(app)).toHaveCount(3);
  const [a, b, c] = [0, 1, 2].map((i) => files(app).nth(i));
  // One tab stop: the selected file.
  await expect(a).toHaveAttribute('tabindex', '0');
  await expect(b).toHaveAttribute('tabindex', '-1');
  await a.focus();
  await app.keyboard.press('ArrowDown');
  await expect(b).toBeFocused();
  await expect(b).toHaveAttribute('tabindex', '0');
  await expect(a).toHaveAttribute('tabindex', '-1');
  await app.keyboard.press('ArrowDown');
  await expect(c).toBeFocused();
  await app.keyboard.press('ArrowDown'); // stops at the last
  await expect(c).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await expect(b).toBeFocused();
  await app.keyboard.press('Home');
  await expect(a).toBeFocused();
  await app.keyboard.press('End');
  await expect(c).toBeFocused();
  // Enter opens the diff of the file reached.
  await expect(c).toHaveAttribute('aria-pressed', 'false');
  await app.keyboard.press('Enter');
  await expect(c).toHaveAttribute('aria-pressed', 'true');
  await expect(app.getByRole('region', { name: 'Diff of c.txt' }).locator('tr.add')).toHaveText([/c\.txt changed/]);
});

// Ticket 463: the core answers the status bar's timed list from a stamp; opening Diff and pressing Refresh are a person
// asking, so each sends `fresh` and the core reads git at once (a shell session: no git facts that would read anyway).
test('diff_open_and_refresh_ask_the_core_for_a_fresh_list', async ({ app, core }) => {
  const dir = repo(core, 'fresh', { 'a.txt': 'a\n' });
  core.shell(dir, 'fresh');
  write(dir, 'a.txt', 'a\nb\n');
  const fresh: unknown[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const frame = typeof f.payload === 'string' ? JSON.parse(f.payload) : null;
      if (frame?.request?.op === 'diff_list' && frame.request.fresh === true) fresh.push(frame);
    }),
  );
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  await expect(files(app)).toHaveText([/a\.txt.*modified/]);
  expect(fresh).toHaveLength(1);
  await dock.getByRole('button', { name: 'Refresh Diff' }).click();
  await expect.poll(() => fresh.length).toBe(2);
});

// Ticket 222 review SHOULD (V2.5-63): the Diff header and its empty states read in the window language, ko and en.
for (const [lang, head, empty, unknown] of [
  ['en', 'vs an empty repository · this checkout since session start · 1 file', 'No changes since the session started.', /^Start commit unknown/],
  ['ko', '빈 저장소 기준 · 세션 시작 이후 이 체크아웃 · 파일 1개', '세션이 시작된 뒤로 변경 사항이 없습니다.', /^시작 커밋을 알 수 없습니다/],
] as const) {
  test(`diff_header_and_empty_states_follow_language (${lang})`, async ({ app, core }) => {
    // A repository without a commit: the header names the empty repository as its base.
    const dir = core.project(`empty-${lang}`);
    git(dir, 'init', '-q');
    core.shell(dir, 'alpha');
    write(dir, 'new.txt', 'new\n');
    await openWindow(app); // waits for the English status line, so the language is set after it and the window reloaded
    await app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), lang);
    await app.reload();
    await app.locator('#icon-diff').click(); // the icon's name follows the language
    // Ticket 492: the dock's name and its Refresh button follow the language too (mw.diff.title, mw.diff.refresh).
    // Commit 265144597: ko keeps the word Diff for the pane (docs/i18n-terms.md).
    const dock = app.getByRole('complementary', { name: 'Diff', exact: true });
    await expect(dock.locator('.dbase')).toHaveText(head);
    // The scope switch read the same missing catalogue before: it follows the language too.
    await expect(dock.getByRole('radio', { checked: true })).toHaveText(lang === 'ko' ? '변경 전체' : 'Changes');
    await shot(app, `lang-${lang}-head`);
    fs.rmSync(path.join(dir, 'new.txt'));
    await dock.getByRole('button', { name: lang === 'ko' ? 'Diff 새로고침' : 'Refresh Diff' }).click();
    await expect(dock.getByRole('status')).toHaveText(empty);
    await shot(app, `lang-${lang}-empty`);
    // A session the core holds no start commit for: the list state the core cannot stage on demand, read through listState.
    expect(listState('s', { type: 'diff', base: null, files: [], truncated: false }, '', makeT(lang, lang))).toMatch(unknown);
  });
}
