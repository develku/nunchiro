// Ticket 374: Diff stacks every changed file in one view with syntax colours and per-file collapse, and a note on a
// changed line goes to the composer as a quote, unsent. Real core, a fake Claude session (running, so the composer
// takes text).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { chat, ChatCore, expect, openChat, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from '../src/diff/diffCollapse';
import { formatLineNote } from '../src/diff/lineNote';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

/** A Claude session on a git project whose first commit holds `before`; `after` is written once the session started. */
function session(core: ChatCore, before: Record<string, string>, after: Record<string, string>) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  const put = (files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), body);
    }
  };
  put(before);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = core.chat('demo');
  put(after);
  return s;
}

const dock = (page: Page) => page.getByRole('complementary', { name: 'Diff' });
const list = (page: Page) => dock(page).getByRole('list', { name: 'Changed files' }).locator('[data-path]');
const file = (page: Page, p: string) => page.getByRole('region', { name: `Diff of ${p}` });
async function openDiff(page: Page) {
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(dock(page)).toBeVisible();
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `diff-stack-${name}-${test.info().project.name}.png`) });

const names = Array.from({ length: 20 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
const ts = (i: number) => `export function f${i}(name: string) {\n  const url = '/session';\n  return url + name;\n}\n`;

test('diff_stack_all_files_coloured_and_collapsible', async ({ page, chatCore }) => {
  const s = session(chatCore, Object.fromEntries(names.map((n) => [n, 'export const a = 1;\n'])), Object.fromEntries(names.map((n, i) => [n, ts(i)])));
  await openChat(page, s.id);
  await openDiff(page);
  await expect(list(page)).toHaveCount(20);
  // One view: the first file's patch shows without choosing it, and only sections near the viewport are mounted.
  const first = file(page, names[0]);
  await expect(first.locator('tr.add')).toHaveCount(4);
  expect(await dock(page).locator('.dsec').count()).toBeLessThan(20);
  // TypeScript keywords take the theme's --syn-keyword (ticket 482): light's, then dark's under the dark theme.
  const kw = first.locator('tr.add .sh').filter({ hasText: /^export$/ });
  await expect(kw).toHaveCount(1);
  expect(await kw.evaluate((e) => (e as HTMLElement).style.color)).toBe('var(--syn-keyword)');
  const ink = () => kw.evaluate((e) => [getComputedStyle(e).color, getComputedStyle(document.documentElement).getPropertyValue('--syn-keyword').trim()]);
  const rgb = (c: string) => page.evaluate((c) => { const p = document.createElement('span'); p.style.color = c; document.body.append(p); const v = getComputedStyle(p).color; p.remove(); return v; }, c);
  const [light, lightTok] = await ink();
  expect(light).toBe(await rgb(lightTok));
  await shot(page, 'light');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect.poll(async () => (await ink())[1]).not.toBe(lightTok);
  const [dark, darkTok] = await ink();
  expect(dark).toBe(await rgb(darkTok));
  await shot(page, 'dark');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  // Every file is in the same view: scrolling to the end reaches the last one; a click in the list scrolls to its file.
  // Sections mount as they near the viewport and their heights settle after, so the end moves: scroll again until it holds.
  await expect
    .poll(async () => {
      await dock(page).locator('.dstack').evaluate((e) => (e.scrollTop = e.scrollHeight));
      return file(page, names[19]).locator('tr.add').count();
    })
    .toBe(4);
  await list(page).filter({ hasText: names[10] }).click();
  await expect(file(page, names[10]).locator('.fhead')).toBeInViewport();
  // Collapse one file with its chevron.
  const chev = file(page, names[10]).getByRole('button', { name: `Collapse ${names[10]}` });
  await chev.click();
  await expect(file(page, names[10]).locator('table.dl')).toHaveCount(0);
  await expect(file(page, names[10]).locator('.fhead .m')).toHaveText(/collapsed/);
  await expect(file(page, names[10]).getByRole('button', { name: `Expand ${names[10]}` })).toHaveAttribute('aria-expanded', 'false');
  // Collapse all, then expand all.
  const bar = page.getByRole('region', { name: 'Diff view' }).locator('.dbar');
  await bar.getByRole('button', { name: 'Collapse all' }).click();
  await expect(dock(page).locator('.dstack table.dl')).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Collapse all' })).toBeDisabled();
  await shot(page, 'collapsed');
  await bar.getByRole('button', { name: 'Expand all' }).click();
  // The view stays near the file being read; every file in it is open again.
  await expect(dock(page).locator('.dstack table.dl').first()).toBeVisible();
  await expect(dock(page).locator('.dstack .fhead .chev[aria-expanded="false"]')).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Expand all' })).toBeDisabled();
});

test('diff_line_note_goes_to_composer_unsent', async ({ page, chatCore }) => {
  const s = session(chatCore, { 'src/login.ts': "export function login() {\n  const url = '/old';\n}\n" }, { 'src/login.ts': "export function login() {\n  const url = '/session';\n  await save(name);\n}\n" });
  await openChat(page, s.id);
  await openDiff(page);
  const view = file(page, 'src/login.ts');
  const composer = page.locator('.cbox textarea');
  // Keyboard: the + is reachable without a mouse; Esc cancels and leaves the composer empty.
  const plus2 = view.locator('tr.add').first().getByRole('button', { name: 'Note on line 2' });
  await plus2.focus();
  await page.keyboard.press('Enter');
  const field = page.getByRole('textbox', { name: 'Note on src/login.ts line 2' });
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(composer).toHaveValue('');
  // Hover, +, type, Enter: the composer holds file, line and note as a quote, focused, not sent.
  await view.locator('tr.add').first().hover();
  await plus2.click();
  await field.fill('rename "this"');
  await shot(page, 'note');
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(composer).toHaveValue('> File: src/login.ts\n> Line: 2\n> User comment: "rename \\"this\\""\n');
  await expect(composer).toBeFocused();
  await shot(page, 'note-composer');
  await page.waitForTimeout(300);
  await expect(chat(page, s.id).getByText('rename')).toHaveCount(0);
  await expect(composer).toHaveValue(/rename/);
  // Split: a removed line's note names its old number.
  await page.getByRole('region', { name: 'Diff view' }).getByRole('button', { name: 'Split' }).click();
  await view.locator('td.del.c').first().hover();
  await view.getByRole('button', { name: 'Note on line 2' }).first().click();
  await page.getByRole('textbox', { name: 'Note on src/login.ts line 2' }).fill('old one');
  // Cmd+Enter adds too, and must not reach the window's Cmd+Enter (which sends the composer in the background).
  await page.keyboard.press('Meta+Enter');
  await expect(composer).toHaveValue('> File: src/login.ts\n> Line: 2\n> User comment: "rename \\"this\\""\n> File: src/login.ts\n> Line: 2\n> User comment: "old one"\n');
  await expect(chat(page, s.id).getByText('rename')).toHaveCount(0);
});

test('diff_stack_keeps_folds_and_open_note_across_refresh', async ({ page, chatCore }) => {
  const s = session(chatCore, Object.fromEntries(names.map((n) => [n, 'export const a = 1;\n'])), Object.fromEntries(names.map((n, i) => [n, ts(i)])));
  await openChat(page, s.id);
  await openDiff(page);
  await expect(list(page)).toHaveCount(20);
  await file(page, names[0]).getByRole('button', { name: `Collapse ${names[0]}` }).click();
  await list(page).filter({ hasText: names[10] }).click();
  const view = file(page, names[10]);
  await expect(view.locator('.fhead')).toBeInViewport();
  await view.locator('tr.add').first().hover();
  await view.getByRole('button', { name: 'Note on line 2' }).click();
  const field = page.getByRole('textbox', { name: `Note on ${names[10]} line 2` });
  await field.fill('keep me');
  const stack = dock(page).locator('.dstack');
  const top = () => view.locator('.fhead').evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const before = await top();
  // A file appears above all others outside the app; returning to the window re-reads the list.
  fs.writeFileSync(path.join(s.cwd, 'src/a00.ts'), 'export const b = 2;\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(list(page)).toHaveCount(21);
  // The note being written, the reader's place and the folded file all stay.
  await expect(field).toHaveValue('keep me');
  await expect(field).toBeFocused();
  expect(await top()).toBe(before);
  expect(await stack.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Diff view' }).getByRole('button', { name: 'Expand all' })).toBeEnabled();
  await list(page).filter({ hasText: names[0] }).click();
  await expect(file(page, names[0]).getByRole('button', { name: `Expand ${names[0]}` })).toHaveAttribute('aria-expanded', 'false');
});

test('diff_line_note_format_and_collapse_helpers', () => {
  // Orca's escaping: backslash, quote, CR and LF, so a note stays one line.
  expect(formatLineNote('a b.ts', 7, 'say "hi"\nthen \\ go\r')).toBe('File: a b.ts\nLine: 7\nUser comment: "say \\"hi\\"\\nthen \\\\ go\\r"');
  expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  expect(areAllDiffFilesCollapsed(['a', 'b'], new Set(['a']))).toBe(false);
  expect([...toggleAllDiffFiles(['a', 'b'], new Set(['a']))]).toEqual(['a', 'b']);
  expect([...toggleAllDiffFiles(['a', 'b'], new Set(['a', 'b']))]).toEqual([]);
});
