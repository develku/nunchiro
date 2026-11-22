// Ticket 261 (needs 197, G14): diff viewer options, stored per window (features/diff-options.tsx), read live by Diff.
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { collapseUnchanged, hideWhitespace, parsePatch, type DiffLine } from '../src/diff/patch';
import { expect, openWindow, test, type Core } from './fixtures';
import { closeSettings } from './settings-modal';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

const LINES = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
const body = (lines: string[]) => lines.join('\n') + '\n';

/** A git project committed with `files`, then edited to `after`, with a shell session started on it. */
function project(core: Core, files: Record<string, string>, after: Record<string, string>) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  for (const [p, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), b);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  core.shell(dir, 'core-serve');
  for (const [p, b] of Object.entries(after)) fs.writeFileSync(path.join(dir, p), b);
  return dir;
}
// Hunk 1 is whitespace only (an indent); hunk 2 has a trailing-space pair and one real change.
const wsEdit = () => {
  const l = [...LINES];
  l[1] = '  line2';
  l[14] = 'line15 ';
  l[15] = 'LINE16';
  return body(l);
};

/** Seeds the window store's feature values once (a reload keeps what the window saved since). */
const seed = (app: Page, features: Record<string, unknown>) =>
  app.addInitScript((features) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features }));
      sessionStorage.setItem('seeded', '1');
    }
  }, features);
const stored = async (app: Page) => (await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'))).features ?? {};

/** Ticket 374: the view's options bar sits above the stacked files, outside each file's region. */
const bar = (app: Page) => app.getByRole('region', { name: 'Diff view' }).locator('.dbar');
const diffButton = (app: Page) => app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
/** Opens the window and Diff on `file`; `list` false when the file list is hidden (diff.hide_file_list), so the first file shows. */
const openDiffOn = async (app: Page, file: string, list = true) => {
  await openWindow(app);
  await diffButton(app).click();
  if (list) await app.getByRole('list', { name: 'Changed files' }).locator(`[data-path="${file}"]`).click();
  const view = app.getByRole('region', { name: `Diff of ${file}` });
  await expect(view.locator('table.dl')).toBeVisible();
  return view;
};
const openSettings = async (app: Page) => {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(app.locator('.settings > nav')).toBeVisible();
};

test('diff_hide_whitespace_draws_ws_only_pairs_as_context', async ({ app, core }) => {
  project(core, { 'a.txt': body(LINES) }, { 'a.txt': wsEdit() });
  await seed(app, { 'diff.hide_whitespace': true });
  const view = await openDiffOn(app, 'a.txt');
  // Only the real change stays a change; the trailing-space pair is context, and the indent-only hunk is a note.
  await expect(view.locator('tr.del')).toHaveText([/line16/]);
  await expect(view.locator('tr.add')).toHaveText([/LINE16/]);
  await expect(view.locator('tr.context').filter({ hasText: 'line15' })).toHaveCount(1);
  await expect(view.locator('tr.note')).toHaveText([/^2 whitespace-only changes hidden$/, /Whitespace-only change hidden/]); // the count says so for a partly hidden hunk too
  // Split draws the same lines.
  await bar(app).getByRole('button', { name: 'Split' }).click();
  await expect(view.locator('td.del.c')).toHaveText([/line16/]);
});

test('diff_wrap_long_lines', async ({ app, core }) => {
  const long = 'word '.repeat(120).trim();
  project(core, { 'a.txt': body(LINES) }, { 'a.txt': body([...LINES.slice(0, 5), long, ...LINES.slice(5)]) });
  await seed(app, { 'diff.wrap': true });
  const view = await openDiffOn(app, 'a.txt');
  const row = view.locator('tr.add');
  await expect(row).toHaveCount(1);
  expect((await row.boundingBox())!.height).toBeGreaterThan(30);
  const code = view.locator('.dcode');
  expect(await code.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
});

test('diff_collapse_unchanged_with_expander', async ({ app, core }) => {
  const l = [...LINES];
  l[9] = 'changed10';
  project(core, { 'a.txt': body(LINES) }, { 'a.txt': body(l) });
  await seed(app, { 'diff.collapse_unchanged': true });
  const view = await openDiffOn(app, 'a.txt');
  // git's three context lines each side: one stays next to the change, two fold into an expander.
  await expect(view.locator('tr.context')).toHaveText([/line9/, /line11/]);
  const show = view.getByRole('button', { name: 'Show 2 lines' });
  await expect(show).toHaveCount(2);
  await show.first().click();
  await expect(view.locator('tr.context')).toHaveText([/line7/, /line8/, /line9/, /line11/]);
  await expect(show).toHaveCount(1);
});

test('diff_hide_file_list', async ({ app, core }) => {
  project(core, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { 'a.txt': 'a2\n', 'b.txt': 'b2\n' });
  await seed(app, { 'diff.hide_file_list': true });
  const view = await openDiffOn(app, 'a.txt', false);
  await expect(app.getByRole('list', { name: 'Changed files' })).toHaveCount(0);
  await expect(view.locator('tr.add')).toHaveText([/a2/]);
});

test('diff_colour_blind_palette_uses_tokens', async ({ app, core }) => {
  project(core, { 'a.txt': 'a\n' }, { 'a.txt': 'a2\n' });
  await seed(app, { 'diff.colours': 'colour_blind' });
  const view = await openDiffOn(app, 'a.txt');
  // Ticket 1041 lane 7b: added lines take the set's own cyan (--diff-cb-add-ink), removed ones its magenta
  // (--diff-cb-del-ink): tokens, never the state hues (blue working, orange your turn).
  const ink = (sel: string, token: string) =>
    view.locator(sel).evaluate((sign, token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      sign.parentElement!.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(sign).color, want];
    }, token);
  const [add, cyan] = await ink('tr.add .sign', '--diff-cb-add-ink');
  expect(add).toBe(cyan);
  const [del, magenta] = await ink('tr.del .sign', '--diff-cb-del-ink');
  expect(del).toBe(magenta);
  for (const sel of ['tr.add .sign', 'tr.del .sign'])
    for (const state of ['--run', '--you']) {
      const [got, hue] = await ink(sel, state);
      expect(got).not.toBe(hue);
    }
});

test('diff_header_toggles_share_stored_value', async ({ app, core }) => {
  project(core, { 'a.txt': body(LINES) }, { 'a.txt': wsEdit() });
  const view = await openDiffOn(app, 'a.txt');
  await expect(view.locator('tr.del')).toHaveCount(3);
  const ws = bar(app).getByRole('button', { name: 'Hide whitespace changes' });
  await expect(ws).toHaveAttribute('aria-pressed', 'false');
  // B21 (look 1117): the three toggles read as words, as the Unified / Split toggle beside them does, not bare glyphs.
  await expect(bar(app).getByRole('group', { name: 'Diff' }).first().getByRole('button')).toHaveText(['Spaces', 'Wrap', 'Collapse']);
  await ws.click(); // click 1
  await expect(ws).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('tr.del')).toHaveCount(1);
  await expect.poll(async () => (await stored(app))['diff.hide_whitespace']).toBe(true);
  await bar(app).getByRole('button', { name: 'Wrap long lines' }).click();
  await expect.poll(async () => (await stored(app))['diff.wrap']).toBe(true);
  await expect(view.locator('table.dl')).toHaveClass(/\bwrap\b/);
  // The Settings row shows the same stored value, and turning it off there turns the header toggle off live: back on the
  // session, without a reload, Diff draws all three changes again.
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="appearance"]').click();
  const row = app.locator('[data-setting="diffHideWhitespace"]');
  await expect(row).toBeChecked();
  await expect(app.locator('[data-setting="diffWrap"]')).toBeChecked();
  await row.uncheck();
  await expect.poll(async () => (await stored(app))['diff.hide_whitespace']).toBe(false);
  await closeSettings(app); // the Diff dock sits behind the Settings modal
  // The dock comes back with the session (Diff still loading): the right-bar button would close it then.
  if (!(await app.getByRole('complementary', { name: 'Diff', exact: true }).isVisible())) await diffButton(app).click();
  await expect(ws).toHaveAttribute('aria-pressed', 'false');
  await expect(bar(app).getByRole('button', { name: 'Wrap long lines' })).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('tr.del')).toHaveCount(3);
});

test('diff_header_path_readable_in_narrow_dock: the view toggles wrap to a second row before the path is cut', async ({ app, core }) => {
  project(core, { 'a.txt': 'a\n' }, { 'a.txt': 'a2\n' });
  const view = await openDiffOn(app, 'a.txt');
  const fit = (l: Locator) => l.evaluate((e) => e.scrollWidth - e.clientWidth);
  expect(await fit(view.locator('.fhead .dpath'))).toBeLessThanOrEqual(0); // ticket 374: the path sits in the file's header
  expect(await fit(bar(app))).toBeLessThanOrEqual(0);
  // Every control stays inside the bar.
  const box = (await bar(app).boundingBox())!;
  for (const b of await bar(app).getByRole('button').all()) {
    const r = (await b.boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
  }
});

test('diff_options_rows_on_appearance_page_and_searchable', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  const nav = app.locator('.settings > nav');
  await nav.locator('button[data-page="appearance"]').click();
  const section = app.getByRole('region', { name: 'Diff', exact: true });
  await expect(section.getByRole('switch')).toHaveCount(4);
  for (const key of ['diffHideWhitespace', 'diffWrap', 'diffCollapse', 'diffHideList']) await expect(section.locator(`[data-setting="${key}"]`)).not.toBeChecked();
  await expect(section.locator('[data-setting="diffColours"]:checked')).toHaveValue('theme');
  // One search from another page lists the row with its page and focuses it.
  await nav.locator('button[data-page="general"]').click();
  await nav.getByRole('searchbox', { name: 'Search settings' }).fill('Wrap long lines');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: 'Wrap long lines · Appearance' }).click();
  await expect(app.locator('[data-setting="diffWrap"]')).toBeFocused();
  // A click on the switch stores the value the Diff view reads.
  await app.locator('[data-setting="diffWrap"]').check();
  await expect.poll(async () => (await stored(app))['diff.wrap']).toBe(true);
});

// Pure cases (no browser) for the two line transforms in diff/patch.ts.
const NOTE = 'Whitespace-only change hidden';
const hunk = (...lines: string[]) => parsePatch(['@@ -1,9 +1,9 @@', ...lines].join('\n'));
const shape = (lines: DiffLine[]) => lines.map((l) => (l.kind === 'fold' ? `fold:${l.hidden!.map((h) => h.text).join(',')}` : l.kind === 'hunk' ? 'hunk' : `${l.kind}:${l.text}`));

test('diff_hide_whitespace_cases: ws pairs become context (new text, both numbers); unequal runs pair by place; a ws-only hunk becomes the note', () => {
  // Mixed hunk: the trailing-space pair turns context, the real change stays.
  const mixed = hideWhitespace(hunk(' a', '-b ', '-c', '+b', '+C'), NOTE);
  expect(shape(mixed)).toEqual(['hunk', 'context:a', 'context:b', 'del:c', 'add:C']);
  expect(mixed[2]).toMatchObject({ oldNumber: 2, newNumber: 2 });
  // More removals than additions: the first pair matches, the rest stay removed.
  expect(shape(hideWhitespace(hunk('-x', '-  y', '-z', '+ x'), NOTE))).toEqual(['hunk', 'context: x', 'del:  y', 'del:z']);
  // More additions than removals.
  expect(shape(hideWhitespace(hunk('-p', '+p\t', '+q'), NOTE))).toEqual(['hunk', 'context:p\t', 'add:q']);
  // Inner runs collapse too, not only the ends.
  expect(shape(hideWhitespace(hunk('-f(a,  b)', '+f(a,\tb)', '-x', '+y'), NOTE))).toEqual(['hunk', 'context:f(a,\tb)', 'del:x', 'add:y']);
  // Pairing is by place, not by search: `b` against `a` differs, so nothing turns context.
  expect(shape(hideWhitespace(hunk('-a', '-b', '+b'), NOTE))).toEqual(['hunk', 'del:a', 'del:b', 'add:b']);
  // A ws-only hunk keeps its header and shows the note; the next hunk is untouched.
  const two = parsePatch(['@@ -1,3 +1,3 @@', ' a', '-  b', '+b', ' c', '@@ -9,1 +9,1 @@', '-x', '+y'].join('\n'));
  expect(shape(hideWhitespace(hunk('-a b', '+ab'), NOTE))).toEqual(['hunk', `note:${NOTE}`]); // git diff -w: no whitespace at all counts
  expect(shape(hideWhitespace(two, NOTE))).toEqual(['hunk', `note:${NOTE}`, 'hunk', 'del:x', 'add:y']);
});

test('diff_collapse_unchanged_cases: keeps one line next to a change, folds two or more at hunk start, end and between changes', () => {
  // Hunk start: nothing before the run to keep a line for.
  const start = collapseUnchanged(hunk(' c1', ' c2', ' c3', '-d', '+e'));
  expect(shape(start)).toEqual(['hunk', 'fold:c1,c2', 'context:c3', 'del:d', 'add:e']);
  expect(start[1]).toMatchObject({ oldNumber: 1, newNumber: 1 });
  // Hunk end.
  expect(shape(collapseUnchanged(hunk('-d', '+e', ' c1', ' c2', ' c3')))).toEqual(['hunk', 'del:d', 'add:e', 'context:c1', 'fold:c2,c3']);
  // Between two changes: one kept each side, the middle two fold.
  expect(shape(collapseUnchanged(hunk('-d', ' c1', ' c2', ' c3', ' c4', '+e')))).toEqual(['hunk', 'del:d', 'context:c1', 'fold:c2,c3', 'context:c4', 'add:e']);
  // Only one line would fold: the run stays as it is.
  expect(shape(collapseUnchanged(hunk('-d', ' c1', ' c2', ' c3', '+e')))).toEqual(['hunk', 'del:d', 'context:c1', 'context:c2', 'context:c3', 'add:e']);
});
