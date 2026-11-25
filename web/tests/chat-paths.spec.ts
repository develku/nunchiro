// needs 171 (open files from chat): a path in the chat opens the file (or its diff) from a visible, keyboard-reachable
// control. Every path is relative to the session folder (`sessionPath` refuses `..`, empty parts and anything outside it,
// and such a path stays plain text); the Files viewer (core) confines it again. The window events are recorded:
// `nunchiro:files.open` carries the session id as its root (src/files/open.ts: the core resolves it to the folder).
import fs from 'node:fs';
import path from 'node:path';
import { expect as pwExpect, test as pwTest, type Page } from '@playwright/test';
import { REPO, codexFake } from './fixtures';
import { append, chat, expect, openChat, rec, test, type ChatCore } from './fixtures/chat/harness';
import { mockupTurn } from './fixtures/fidelity-chat/turn';
import { pathRef, toolPath } from '../src/chat/paths';

type Use = Parameters<typeof toolPath>[0];
const use = (name: string, input: unknown): Use => ({ kind: 'tool_use', tool_id: 't', name, input });

pwTest('chat_paths_pure: toolPath reads the file of a tool call, pathRef reads inline code that is a path', () => {
  pwExpect(toolPath(use('Read', { file_path: '/p/a.ts' }))).toBe('/p/a.ts');
  for (const name of ['Edit', 'Write', 'MultiEdit']) pwExpect(toolPath(use(name, { file_path: 'src/b.ts' }))).toBe('src/b.ts');
  pwExpect(toolPath(use('NotebookEdit', { notebook_path: 'n.ipynb' }))).toBe('n.ipynb');
  pwExpect(toolPath(use('apply_patch', { path: 'x/y.rs' }))).toBe('x/y.rs');
  pwExpect(toolPath(use('read', { file_path: 'x/z.rs' }))).toBe('x/z.rs');
  // Not a string, a patch body, other tools, no input: no path.
  pwExpect(toolPath(use('Read', { file_path: 3 }))).toBeNull();
  pwExpect(toolPath(use('apply_patch', '*** Begin Patch'))).toBeNull();
  pwExpect(toolPath(use('Bash', { command: 'cat a.ts', file_path: 'a.ts' }))).toBeNull();
  pwExpect(toolPath(use('Read', null))).toBeNull();
  pwExpect(pathRef('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 });
  pwExpect(pathRef('src/a.ts')).toEqual({ path: 'src/a.ts' });
  pwExpect(pathRef('README.md')).toEqual({ path: 'README.md' });
  pwExpect(pathRef('docs/dir')).toEqual({ path: 'docs/dir' }); // has a slash
  pwExpect(pathRef('@scope/pkg/x.ts')).toEqual({ path: '@scope/pkg/x.ts' });
  // Words, versions, URLs and anything with spaces or a scheme are not paths.
  for (const t of ['npm', 'v1.2', 'e.g.', 'a b.ts', 'https://x.io/a.ts', 'file:///etc/passwd', 'a.ts:x', 'foo()', '', 'x.verylongext']) pwExpect(pathRef(t), t).toBeNull();
});

/** Records every files.open and diff.open the window dispatches. `swallow` keeps the app from acting on files.open (it
 *  would switch to the file tab and hide the chat under test); `chat_path_end_to_end` lets it through. */
const record = (page: Page, swallow = true) =>
  page.addInitScript((stop) => {
    const w = window as unknown as { __files: unknown[]; __diff: unknown[]; __opened: string[] };
    w.__files = [];
    w.__diff = [];
    w.__opened = [];
    window.addEventListener('nunchiro:files.open', (e) => (w.__files.push((e as CustomEvent).detail), stop && e.stopImmediatePropagation()));
    window.addEventListener('nunchiro:diff.open', (e) => w.__diff.push((e as CustomEvent).detail));
    window.open = (u) => (w.__opened.push(String(u)), null);
  }, swallow);
const got = (page: Page, k: '__files' | '__diff' | '__opened') => page.evaluate((key) => (window as unknown as Record<string, unknown[]>)[key], k);

/** Verbose shows every call and edit as it came (Normal folds them). */
async function verbose(page: Page, id: string) {
  const cycle = chat(page, id).locator('.cview button');
  for (let i = 0; i < 4 && !/Verbose/.test((await cycle.getAttribute('aria-label')) ?? ''); i++) await cycle.click();
  await expect(cycle).toHaveAttribute('aria-label', /Verbose/);
}

test('chat_changes_row_opens_diff: a Changes-card file row opens Diff at that file, by click and by Enter', async ({ page, chatCore }) => {
  await record(page);
  const s = chatCore.chat('changes');
  mockupTurn(s.file, s.cwd);
  await openChat(page, s.id);
  const row = chat(page, s.id).locator('.chcard li button[data-path]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('web/src/tree/tree.css');
  await row.click();
  await expect.poll(() => got(page, '__diff')).toEqual([{ path: 'web/src/tree/tree.css' }]);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => got(page, '__diff')).toEqual([{ path: 'web/src/tree/tree.css' }, { path: 'web/src/tree/tree.css' }]);
  // "View in Diff" stays and opens Diff with no path.
  await chat(page, s.id).locator('.chcard').getByRole('button', { name: 'View in Diff' }).click();
  await expect.poll(async () => (await got(page, '__diff')).length).toBe(3);
  expect((await got(page, '__diff')).at(2)).toEqual({});
});

// A fake Codex rollout, to delete a file with apply_patch (Claude has no delete edit).
const BIN = path.join(REPO, 'target/debug/nunchiro');
const fakeCodex = (home: string) => `#!/bin/sh
if [ "$1" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi
printf 'fake codex\\r\\n'
n=0
until '${BIN}' hook SessionStart < "${home}/codex-next.json" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 100 ] && break; sleep 0.05; done
while IFS= read -r line; do [ "$line" = EXIT ] && exit 0; done
`;
function codex(core: ChatCore) {
  const id = '11111111-0000-4000-8000-000000000171';
  const dir = path.join(core.home, 'codex-home/sessions/2026/11/01');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-01T11-00-00-${id}.jsonl`);
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(core.home, 'codex-next.json'), JSON.stringify({ thread_id: id, transcript_path: file }));
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(fakeCodex(core.home)), { mode: 0o700 });
  const s = core.cli('session', 'start', '--kind', 'codex', '--project', core.project('dcard'), '--label', 'codex-del').session as { id: string; cwd: string };
  append(file, { type: 'session_meta', payload: { id, cwd: s.cwd } });
  return { ...s, file };
}

test('chat_diff_header_opens_file: the diff card path opens the file; a deleted file is plain text', async ({ page, chatCore }) => {
  await record(page);
  const s = chatCore.chat('dcard');
  append(s.file, rec.user('go'), rec.edit('e1', `${s.cwd}/src/a.ts`, ['-a', '+b']));
  await openChat(page, s.id);
  await verbose(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  const open = card.locator('.dh button.path');
  await expect(open).toHaveCount(1);
  // Ticket 581: inside the session folder the path reads relative.
  await expect(open).toHaveText('src/a.ts');
  await open.click();
  await expect.poll(() => got(page, '__files')).toEqual([{ root: s.id, path: 'src/a.ts' }]);
  await open.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await got(page, '__files')).length).toBe(2);
  // The existing View button keeps opening the diff.
  await card.getByRole('button', { name: 'View' }).click();
  await expect.poll(() => got(page, '__diff')).toEqual([{ path: 'src/a.ts' }]);
  // A deleted file: nothing to open, so the path is text.
  const c = codex(chatCore);
  append(c.file, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rm' }] } });
  append(c.file, { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'd1', name: 'apply_patch', input: '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch' } });
  await page.locator(`.tab[data-tab="${c.id}"]`).click();
  await verbose(page, c.id);
  const del = chat(page, c.id).locator('.dcard');
  await expect(del).toHaveCount(1);
  await expect(del.locator('.dh .path')).toHaveText('old.txt');
  await expect(del.locator('.dh button.path')).toHaveCount(0);
});

test('chat_tool_row_path_opens_file: a Read row opens its file without toggling the row; the chevron still toggles; a row with no path is unchanged', async ({ page, chatCore }) => {
  await record(page);
  const s = chatCore.chat('tools');
  append(
    s.file,
    rec.user('go'),
    // The group row and its first call share a key (the first event's cursor), so the one under test comes second.
    rec.use('x1', 'Read', { file_path: '/etc/hosts' }),
    rec.result('x1', 'hosts'),
    rec.use('r1', 'Read', { file_path: `${s.cwd}/src/a.ts` }),
    rec.result('r1', 'code'),
    rec.use('b1', 'Bash', { command: 'echo hi' }),
    rec.result('b1', 'hi'),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  await verbose(page, s.id);
  const view = chat(page, s.id);
  // The Reads fold into one group row; open it to see its tool rows.
  await view.locator('.tool .tl', { hasText: 'Read 2 files' }).click();
  const row = view.locator('.tool', { has: page.locator('.tpath[data-file="src/a.ts"]') });
  const link = row.locator('button.tpath');
  await expect(link).toHaveText('a.ts');
  await expect(link).toHaveAttribute('data-file', 'src/a.ts');
  // Ticket 477 round 4: the row's class once was `split`, so the split pane's rule (split/split.css) drew a dashed top
  // line and stacked toggle, path and tick on three lines. It is one line with no dashed border.
  const line = link.locator('..');
  await expect(line).not.toHaveCSS('border-top-style', 'dashed');
  await expect(line).toHaveCSS('flex-direction', 'row');
  const [toggle, path] = [(await row.getByRole('button', { name: 'Read a.ts', exact: true }).boundingBox())!, (await link.boundingBox())!];
  expect(Math.abs(toggle.y + toggle.height / 2 - (path.y + path.height / 2))).toBeLessThan(4);
  expect(path.x).toBeGreaterThan(toggle.x + toggle.width - 1);
  await expect(row.getByRole('button', { name: 'Read a.ts', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await link.click();
  await expect.poll(() => got(page, '__files')).toEqual([{ root: s.id, path: 'src/a.ts' }]);
  await expect(row.getByRole('button', { name: 'Read a.ts', exact: true })).toHaveAttribute('aria-expanded', 'false'); // the click did not toggle it
  await link.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await got(page, '__files')).length).toBe(2);
  await expect(row.getByRole('button', { name: 'Read a.ts', exact: true })).toHaveAttribute('aria-expanded', 'false');
  // The row's own toggle still opens it.
  await row.getByRole('button', { name: 'Read a.ts', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Read a.ts', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect((await got(page, '__files')).length).toBe(2);
  // A path outside the folder is plain text; a call with no path is the old single button.
  await expect(view.locator('.tpath[data-file="/etc/hosts"], .tpath[data-file="etc/hosts"]')).toHaveCount(0);
  await expect(view.locator('.tpath')).toHaveCount(1);
  const bash = view.locator('.tool .tl', { hasText: 'Ran echo hi' });
  await expect(bash).toHaveAttribute('aria-expanded', 'false');
  await expect(bash.locator('.tpath')).toHaveCount(0);
});

test('chat_markdown_path_opens_file_at_line: inline code paths and relative links open files; web links, ../ and absolute paths stay out; fenced code is not linkified', async ({ page, chatCore }) => {
  await record(page);
  const s = chatCore.chat('md');
  append(
    s.file,
    rec.user('go'),
    rec.assistant(
      [
        'See `src/a.ts:12` and `README.md` in the repo, and the [notes](docs/n.md) page.',
        'Also [web](https://example.com/page), `../secret.txt`, `/etc/passwd`, `plain words` and `v1.2`.',
        '```\nsrc/b.ts:5\n```',
        '```ts\nconst x = "src/c.ts";\n```',
      ].join('\n\n'),
    ),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const links = view.locator('.md button.mdpath');
  await expect(links).toHaveCount(2); // src/a.ts:12 and README.md, nothing else
  await expect(links.nth(0)).toHaveText('src/a.ts:12');
  await links.nth(0).click();
  await expect.poll(() => got(page, '__files')).toEqual([{ root: s.id, path: 'src/a.ts', line: 12 }]);
  await links.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await got(page, '__files')).length).toBe(2);
  expect((await got(page, '__files')).at(1)).toEqual({ root: s.id, path: 'README.md' });
  // A relative Markdown link opens the file; an https link still leaves through the external path.
  await view.getByRole('link', { name: 'notes' }).click();
  await expect.poll(async () => (await got(page, '__files')).length).toBe(3);
  expect((await got(page, '__files')).at(2)).toEqual({ root: s.id, path: 'docs/n.md' });
  await view.getByRole('link', { name: 'web' }).click();
  expect(await got(page, '__opened')).toEqual(['https://example.com/page']);
  expect((await got(page, '__files')).length).toBe(3);
  // Outside the folder, words, versions: plain code, no control.
  for (const t of ['../secret.txt', '/etc/passwd', 'plain words', 'v1.2']) {
    const code = view.locator('.md code', { hasText: t });
    await expect(code).toHaveCount(1);
    await expect(code.locator('xpath=ancestor::button')).toHaveCount(0);
  }
  // Fenced blocks are never linkified.
  await expect(view.locator('.codeblk button.mdpath, .codeblk .mdpath')).toHaveCount(0);
  await expect(view.locator('.codeblk')).toHaveCount(2);
  expect((await got(page, '__files')).length).toBe(3);
});

test('chat_path_end_to_end: a path in the chat opens that file in a Files tab of the session', async ({ page, chatCore }) => {
  const s = chatCore.chat('e2e');
  fs.mkdirSync(path.join(s.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(s.cwd, 'src/a.ts'), 'export const answer = 42;\n');
  append(s.file, rec.user('go'), rec.assistant('Look at `src/a.ts:1`.'));
  await openChat(page, s.id);
  await chat(page, s.id).locator('.md button.mdpath').click();
  await expect(page.locator(`.tab[data-tab="file:${s.id}:src/a.ts"]`)).toHaveCount(1);
  await expect(page.getByText('export const answer = 42;').first()).toBeVisible();
});

// 485 (D9): an Edit or Write row names its file the way a Read row does. Inside the session folder the row shows the
// relative path (a button that opens it); outside it shows the file name, with the full path in the tooltip, as the
// window has no home folder to shorten it with (raw-words.spec.ts, ticket 471).
test('chat_tool_row_path_d9: an Edit inside the folder shows its relative path; a Write outside shows the file name, the full path on hover', async ({ page, chatCore }) => {
  await record(page);
  const s = chatCore.chat('d9');
  append(
    s.file,
    rec.user('go'),
    rec.use('e1', 'Edit', { file_path: `${s.cwd}/src/b.ts`, old_string: 'a', new_string: 'b' }),
    rec.result('e1', 'ok'),
    rec.use('w1', 'Write', { file_path: '/etc/nunchiro-485.conf', content: 'x' }),
    rec.result('w1', 'ok'),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const work = view.locator('.sum').first();
  if (await work.count()) await work.click();
  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await view.screenshot({ path: path.join(REPO, `.scratch/shots/485-toolpath-${process.env.SHOT_TAG ?? 'after'}-${test.info().project.name}.png`) });
  await expect(view.locator('.tpath[data-file="src/b.ts"]')).toHaveText('src/b.ts');
  const outside = view.locator('.tool .tl', { hasText: 'Write' });
  await expect(outside).toHaveText(/Write nunchiro-485\.conf/);
  await expect(outside).toHaveAttribute('data-tip', 'Write /etc/nunchiro-485.conf');
});
