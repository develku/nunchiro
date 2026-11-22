// Ticket 477 (scorecard D7/D8): every Settings page and the main surfaces, shot in dark and light at 1440x900, for the
// contact sheet scripts/sweep-sheet.sh writes. Evidence only, never part of the gate: SWEEP=1. Ticket 499 adds hover,
// keyboard focus and open menus, the dialogs, the side panes, Search, onboarding, two catalogue themes and WebKit.
// Shots go to .scratch/sweep/<scheme>/<name>.png (WebKit: .scratch/sweep-webkit); SWEEP_OUT=<folder under .scratch>
// keeps a second set (before/after).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { REPO, expect, openWindow, test } from './fixtures';
import { installHost } from './fixtures/artifacts/cards/host';
import { cardOf, openBoard, seed as boardSeed } from './fixtures/board/coord';
import { fakes, gitRepo as decisionRepo, PERMISSION, show } from './decision-rows-seed';
import { append, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { openFile, setup as filesSetup, view as fileView } from './fixtures/files/harness';
import { hits, search as findText, setup as searchSetup, status as searchStatus } from './fixtures/search/harness';
import { icon } from './d5b';
import { card as themeCard, openTheme, search as themeSearch } from './theme-harness';
import { artifactServer } from './sandbox-server';
import { openQuiet, seed as treeSeed } from './tree-seed';
import { patchSnapshots } from './visual/compare';
import { lowContrast } from './contrast-scan';

const outDir = (browser: string) => path.join(REPO, '.scratch', `${process.env.SWEEP_OUT ?? 'sweep'}${browser === 'webkit' ? '-webkit' : ''}`);
const SCHEMES = ['dark', 'light'] as const;
test.skip(() => process.env.SWEEP !== '1', 'SWEEP=1');
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(({ browserName }) => {
  for (const s of [...SCHEMES, 'catalogue']) fs.rmSync(path.join(outDir(browserName), `contrast-${s}.txt`), { force: true });
});

/** One shot (page or element) and its scan, filed under `scheme` (dark, light, or catalogue for an imported theme). */
async function shoot(app: Page, scheme: string, name: string, target?: Locator) {
  const out = outDir(test.info().project.name);
  const file = path.join(out, scheme, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (target) await target.first().screenshot({ path: file, animations: 'disabled' });
  else await app.screenshot({ path: file, animations: 'disabled' });
  const low = await app.evaluate(lowContrast);
  fs.appendFileSync(path.join(out, `contrast-${scheme}.txt`), low.map((l) => `${name}\t${l}\n`).join(''));
}

/** Shoots the page (or one element) once per scheme; the theme follows prefers-color-scheme live. `hover` puts the
 *  pointer back on its target after each switch; without it the pointer parks in a corner, away from every control. */
async function both(app: Page, name: string, target?: Locator, hover?: Locator, themed = true) {
  for (const scheme of SCHEMES) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    // `themed` false: a screen drawn before the theme is applied (crash, pairing) follows prefers-color-scheme in CSS only.
    if (themed) await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    if (hover) await hover.hover();
    else await app.mouse.move(1435, 895);
    await app.waitForTimeout(250);
    await shoot(app, scheme, name, target);
  }
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);

/** Shoots the open Settings page part by part: the body scrolls inside the dialog, so `fullPage` would not reach it,
 *  and the contrast scan reads only what is on screen. Parts after the first are `<name>-2`, `<name>-3`, ... */
async function settingsParts(app: Page, name: string) {
  const MAX = 14; // shortcut: a page longer than 14 screens is cut there (Keyboard, the longest, needs 12); raise it if one grows past that.
  for (let part = 1; part <= MAX; part++) {
    await both(app, part === 1 ? name : `${name}-${part}`);
    const moved = await app.evaluate(() => {
      const box = [...document.querySelectorAll<HTMLElement>('.settings *')].find((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY));
      if (!box || box.scrollTop + box.clientHeight >= box.scrollHeight - 2) return false;
      box.scrollTop += box.clientHeight - 80; // 80px overlap, so no line falls between two shots
      return true;
    });
    if (!moved) break;
    await app.waitForTimeout(200);
  }
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Usage records over the last days and hours (as usage-tab.spec.ts), so the heat map, token mix and table have data. */
function usageRecords(home: string) {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const lines = [1, 3, 5, 26, 30, 50, 75, 100, 150, 200, 300, 400].map((h, i) => ({
    type: 'assistant',
    timestamp: at(h),
    message: { id: `m${i}`, model: i % 3 ? 'claude-sonnet-4-20250514' : 'claude-opus-4-5-20251101', usage: { input_tokens: 20_000 * (i + 1), output_tokens: 4_000 * (i + 1), cache_creation_input_tokens: 10_000, cache_read_input_tokens: 50_000 * (i + 1) } },
  }));
  for (const [dir, slice] of [['nunchiro', lines.slice(0, 7)], ['lumen', lines.slice(7)]] as const) {
    const file = path.join(home, 'claude-home/projects', `-p-${dir}`, `${dir}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, slice.map((l) => JSON.stringify(l) + '\n').join(''));
  }
}

test('settings: every page', async ({ app, core }) => {
  test.setTimeout(420_000);
  const p = core.project('nunchiro');
  core.shell(p, 'core-serve');
  core.agent(p, 'ux-fix-2', 'never');
  usageRecords(core.home);
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  await expect(nav).toBeVisible();
  const names = await nav.getByRole('button').allInnerTexts();
  expect(names.length).toBeGreaterThan(10);
  for (const [i, raw] of names.entries()) {
    await nav.getByRole('button').nth(i).click();
    await app.waitForTimeout(400);
    await settingsParts(app, `settings-${String(i + 1).padStart(2, '0')}-${slug(raw.trim().split('\n')[0])}`);
  }
});

// The Permissions page exists only inside the app (web/src/features/macos-perms.tsx registers it when
// __TAURI_INTERNALS__ is there): a fake shell answers `permission_status`, as macos-perms.spec.ts does.
test('settings: permissions (app only)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => Promise.resolve(cmd === 'permission_status' ? { full_disk: false, volumes: 'granted' } : null),
      transformCallback: () => 0,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
  });
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('[data-group="privacy"] button[data-page="permissions"]').click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Permissions');
  await settingsParts(app, 'settings-19-permissions');
});

// Ticket 993: Schedules is a widget, no Settings page: its form, then its list with one schedule (as schedules-993.spec.ts).
test('schedules: the widget, its form and one schedule', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'core-serve');
  await openWindow(app);
  await app.locator('#icon-schedules').click();
  const widget = app.locator('.sbar[data-widget="schedules"] .schedv');
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await widget.getByRole('textbox', { name: 'Name' }).fill('nightly-run');
  await widget.getByLabel('Time').fill('03:30');
  await both(app, 'schedules-form');
  await widget.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(widget.locator('.sched-item')).toHaveCount(1);
  await both(app, 'schedules-widget');
});

test('landing: a project and no session', async ({ app, core }) => {
  treeSeed(core, { op: 'add', project: core.project('beta'), added: true });
  await openWindow(app);
  await expect(app.locator('.pane .empty .landing')).toBeVisible();
  await both(app, 'landing');
});

test('files: tree and a highlighted file', async ({ app, core }) => {
  // Ticket 482: a markup file in the code viewer, so tag punctuation, names and attributes are scanned too (an .html file
  // opens rendered in the sandbox, not as code).
  const markup = '<?xml version="1.0"?>\n<!-- sample markup -->\n<page lang="en">\n  <title id="t">Hello &amp; welcome</title>\n  <item n="1"/>\n</page>\n';
  await filesSetup(app, core, { extra: (dir) => fs.writeFileSync(path.join(dir, 'page.xml'), markup) });
  await both(app, 'files-tree');
  await openFile(app, 'hello.ts');
  await both(app, 'files-text');
  await openFile(app, 'page.xml');
  await expect(app.locator('.fview[data-file="page.xml"] .fv-code .sh').first()).toBeVisible();
  await both(app, 'files-markup');
  await openFile(app, 'README.md');
  await both(app, 'files-markdown');
  await fileView(app, 'README.md').getByRole('button', { name: 'Source', exact: true }).click();
  await both(app, 'files-markdown-source');
  // Ticket 499: an HTML file. Files has no source view for it (only Markdown has one): the page runs in a sandboxed
  // frame, so the scan sees the viewer's chrome and the page itself is the user's own colours.
  await openFile(app, 'page.html');
  await expect(app.frameLocator('.fview[data-file="page.html"] iframe').locator('#h')).toBeVisible();
  await both(app, 'files-html');
});

test('board: cards in every column', async ({ app, core }) => {
  const p = core.project('nunchiro');
  core.shell(p, 'core-serve');
  boardSeed(core, [
    { id: 'c1', title: 'Write the release notes', column: 'todo' },
    { id: 'c2', title: '리뷰 메모 읽기', column: 'working' },
    { id: 'c3', title: 'Pick the default theme', column: 'needs-decision' },
    { id: 'c4', title: 'Settings search polish', column: 'review' },
    { id: 'c5', title: 'Tree rows 30px', column: 'done' },
  ]);
  await openBoard(app, core);
  await both(app, 'board');
});

chatTest('main: tree, tabs, long chat, composer, artifacts, diff, palette', async ({ page: app, chatCore: core }) => {
  test.setTimeout(180_000);
  const art = await artifactServer({});
  try {
    await installHost(app, art, []);
    const s = core.chat('nunchiro');
    git(s.cwd, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(s.cwd, 'tree.css'), '.row { height: 22px; }\n');
    fs.writeFileSync(path.join(s.cwd, 'settings.ts'), 'export const row = 22;\n');
    git(s.cwd, 'add', '.');
    git(s.cwd, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(s.cwd, 'tree.css'), '.row { height: 30px; border-radius: 5px; }\n');
    fs.writeFileSync(path.join(s.cwd, 'settings.ts'), 'export const row = 30;\nexport const compact = 22;\n');
    fs.mkdirSync(path.join(s.cwd, 'site'));
    const html = '<!doctype html><html><head><title>Sales chart</title></head><body><h1>Sales</h1><p>Q3 is up 12%.</p></body></html>';
    fs.writeFileSync(path.join(s.cwd, 'site/index.html'), html);
    const turns = Array.from({ length: 12 }, (_, i) => [
      rec.user(`Step ${i + 1}: check the tree rows and keep the decision line as in r6.`),
      rec.use(`r${i}`, 'Read', { file_path: path.join(s.cwd, 'tree.css') }),
      rec.result(`r${i}`, '.row { height: 22px; }'),
      rec.assistant(`Step ${i + 1} done. The row height comes from **settings.ts**; \`compact\` stays an option.\n\n- tree.css: 22px to 30px\n- settings.ts: a new default`),
    ]).flat();
    append(s.file,
      ...turns,
      rec.thinking('The density table fixes 22px; move the default.'),
      rec.assistant('```ts\nexport const DENSITY = {\n  comfortable: { row: 30, name: 13 },\n  compact: { row: 22, name: 12 },\n};\n```'),
      ...rec.edit('e1', path.join(s.cwd, 'settings.ts'), ['-export const row = 22;', '+export const row = 30;', '+export const compact = 22;']),
      rec.use('w1', 'Write', { file_path: path.join(s.cwd, 'site/index.html'), content: html }),
      rec.result('w1', `File created successfully at: ${path.join(s.cwd, 'site/index.html')}`, { toolUseResult: { type: 'create', filePath: path.join(s.cwd, 'site/index.html'), content: html, structuredPatch: [] } }),
      rec.use('b1', 'Bash', { command: 'cargo test --workspace' }),
      rec.result('b1', 'error: test failed, 2 of 410', {}, true),
      rec.assistant('Two tests fail; the chart is in site/index.html.'));
    const other = core.project('lumen');
    core.shell(other, 'backtest-v3');
    core.shell(other, 'needs-you');
    core.shell(core.project('tide'), 'broken');
    await patchSnapshots(app, { 'backtest-v3': { working: true }, 'needs-you': { waiting: 'permission', text: 'npm test 실행 허용?' }, broken: { failed: true } });
    await openChat(app, s.id);
    await expect(app.locator('.acard[data-path="site/index.html"]')).toHaveAttribute('data-state', 'ready');
    await both(app, 'window');
    await both(app, 'tree', app.locator('aside.sbar[data-side="left"]'));
    await both(app, 'tabs', app.locator('.centre .zh'));
    await both(app, 'state-tab-hover', app.locator('.centre .zh'), app.locator('.centre .zh .tab[data-tab]').last());
    const chatBox = app.locator(`.chat[data-session="${s.id}"]`);
    await both(app, 'chat', chatBox);
    // The end alone hides the user messages, tool rows, Edit card, failed Bash and thinking block: shoot the top and middle.
    // chat-late: one screen above the end, where the thinking block, code block, Edit and failed Bash rows sit.
    for (const [name, at] of [['chat-top', 0], ['chat-mid', 0.5], ['chat-late', -1]] as const) {
      await chatBox.locator('.cscroll').first().evaluate((e, f) => (e.scrollTop = f < 0 ? e.scrollHeight - 2 * e.clientHeight + 80 : (e.scrollHeight - e.clientHeight) * f), at);
      await app.waitForTimeout(400);
      await both(app, name, chatBox);
    }
    // The last turn's Read, Edit, Write and failed Bash fold into one row: open it, so their rows are shot and scanned.
    const group = chatBox.getByText(/ran 1 command/).last();
    await group.click();
    await app.waitForTimeout(400);
    await group.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await app.waitForTimeout(300);
    await both(app, 'chat-tools', chatBox);
    await both(app, 'state-chat-row-hover', chatBox, group);
    // Ticket 499: the thinking block. Only the Thinking view shows it: Ctrl+O cycles Normal, Thinking, Verbose.
    await app.keyboard.press('Control+KeyO');
    const thinking = chatBox.getByText('Thinking', { exact: true }).last();
    await expect(thinking).toBeVisible();
    await thinking.click();
    await thinking.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await app.waitForTimeout(300);
    await both(app, 'chat-thinking', chatBox);
    await app.keyboard.press('Control+KeyO');
    await app.keyboard.press('Control+KeyO'); // back to Normal, which the steps below expect
    // The Edit row opened: its raw INPUT and OUTPUT (this transcript's Edit renders no inline diff).
    await chatBox.getByText('Edit', { exact: true }).last().click();
    await app.waitForTimeout(400);
    await both(app, 'chat-edit', chatBox);
    await chatBox.locator('.cscroll').first().evaluate((e) => (e.scrollTop = e.scrollHeight));
    await app.locator('.composer textarea').fill('Run the two failing tests again and show me the output.');
    await both(app, 'composer', app.locator('.composer'));
    await app.locator('.composer textarea').fill('');
    await app.locator('.acard[data-path="site/index.html"]').getByRole('button', { name: 'Open' }).click();
    await expect(app.locator('.preview .pv-frame')).toBeVisible();
    await both(app, 'artifacts');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Meta+KeyD');
    const chooser = app.getByRole('listbox', { name: 'Open in this split' });
    await expect(chooser).toBeVisible();
    await chooser.getByRole('option', { name: /^Diff/ }).click();
    await expect(app.locator('[data-split-id]')).toContainText('settings.ts');
    await both(app, 'diff');
    // Side by side: its table must look like the unified one, not like a split pane (ticket 477 round 4).
    await app.locator('[data-split-id]').getByRole('button', { name: 'Split', exact: true }).click();
    await expect(app.locator('[data-split-id] table.dl').first()).toBeVisible();
    await both(app, 'diff-split');
    await app.locator('[data-split-id]').getByRole('button', { name: 'Unified', exact: true }).click();
    await app.getByRole('button', { name: 'Close split' }).click();
    await expect(async () => {
      await app.keyboard.press('Meta+KeyK');
      await expect(app.locator('.palette input')).toBeFocused({ timeout: 3000 });
    }).toPass({ timeout: 15_000 });
    await both(app, 'palette');
    await both(app, 'state-palette-hover', undefined, app.locator('.palette [data-command]').nth(2));
  } finally {
    await art.close();
  }
});

const gitRepo = (p: string) => (git(p, 'init', '-q', '-b', 'main'), git(p, 'commit', '-q', '--allow-empty', '-m', 'init'), p);

// Ticket 499: hover, keyboard focus and an open menu driven for real (pointer, keys, right-click), then the three
// worktree dialogs: New worktree, Tidy and the discard sheet.
test('states and dialogs: hover, focus, menus, new worktree, tidy, discard', async ({ app, core }) => {
  test.setTimeout(240_000);
  const p = gitRepo(core.project('nunchiro'));
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'dirty', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'dirty')!;
  fs.writeFileSync(path.join(w.path, 'lost.txt'), 'x');
  core.shell(p, 'main-shell');
  openQuiet(core);
  await openWindow(app);
  const tree = app.locator('aside.sbar[data-side="left"]');
  const head = app.locator('.grp[data-project="nunchiro"] .row.head');
  const wt = app.locator('.row.wt2').filter({ hasText: 'dirty' }).first();
  await expect(wt).toBeVisible();
  await both(app, 'state-tree-project-hover', tree, head);
  await both(app, 'state-tree-row-hover', tree, wt);
  // Keyboard focus: a key moves it, so the ring is the one a keyboard user sees (:focus-visible).
  await wt.focus();
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('ArrowDown');
  await both(app, 'state-tree-focus', tree);
  await app.keyboard.press('Tab');
  await both(app, 'state-tab-key-focus');
  // Open menu: the project's right-click menu, an item picked by keyboard, then one under the pointer.
  await app.locator('.grp[data-project="nunchiro"] button.n').click({ button: 'right' });
  const menu = app.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await app.keyboard.press('ArrowDown');
  await both(app, 'state-menu-project');
  await both(app, 'state-menu-item-hover', undefined, menu.getByRole('menuitem').nth(2));
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await head.hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  const nw = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await expect(nw).toBeVisible();
  await nw.getByRole('textbox').first().fill('fix login redirect');
  await both(app, 'dialog-new-worktree');
  await app.keyboard.press('Escape');
  await expect(nw).toHaveCount(0);

  await app.locator('.grp[data-project="nunchiro"] button.n').click({ button: 'right' });
  await app.getByRole('menuitem', { name: /Tidy worktrees…/ }).click();
  const tidy = app.getByRole('dialog', { name: /^Tidy/ });
  await expect(tidy).toBeVisible();
  await both(app, 'dialog-tidy');
  await app.keyboard.press('Escape');
  await expect(tidy).toHaveCount(0);

  await wt.focus();
  await app.keyboard.press('Backspace');
  const sheet = app.getByRole('alertdialog', { name: 'dirty has unsaved work' });
  await expect(sheet).toBeVisible();
  await both(app, 'dialog-discard');
  await both(app, 'state-discard-hover', undefined, sheet.getByRole('button', { name: 'Discard and remove' }));
  await sheet.getByRole('button', { name: 'Cancel' }).click();
});

// Ticket 499: the permission sheet, opened as a user opens it: a script widget's "Needs approval" badge in the library.
test('permission sheet: from the widget library', async ({ app, core }) => {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), script_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
  const dir = path.join(core.home, 'widgets', 'open-prs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), 'version = 1\nkind = "script"\nauthor = "test"\ncommand = ["/bin/sh", "run.sh"]\ninterval = 60\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo prs\n');
  await openWindow(app, core.boot(), core);
  await app.locator('nav[data-bar="right"] .lay').click();
  const lib = app.getByRole('complementary', { name: 'Widget library' });
  const badge = lib.locator('.lcard[data-card="widget:open-prs"]').getByRole('button', { name: 'Needs approval' });
  await expect(badge).toBeVisible();
  await both(app, 'widget-library', lib);
  await both(app, 'state-widget-library-hover', lib, lib.locator('.lcard').first());
  await badge.click();
  await expect(app.getByRole('dialog', { name: 'Allow “open-prs”?' })).toBeVisible();
  await both(app, 'permission-sheet');
});

// Ticket 499: a terminal tab with coloured output, the side pane's Terminal and its Browser. The native browser view
// needs the app, so its bridge answers nothing (as browser-view.spec.ts); the pane's own chrome is what is measured.
// The terminal's text is drawn by xterm and is not scanned (its colours are the theme's ANSI palette); the shot shows it.
test('panes: terminal tab, side terminal, side browser', async ({ app, core }) => {
  await app.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: () => Promise.resolve(null), metadata: {} };
  });
  const out = "printf 'cargo test\\n\\033[32mok\\033[0m 408 passed; \\033[31mFAILED\\033[0m 2; \\033[33mwarning\\033[0m 1; \\033[34mnote\\033[0m \\033[2mdim\\033[0m\\n'; exec cat";
  const a = core.shell(core.project('demo'), 'alpha', '/bin/sh', '-c', out);
  const agent = core.agent(core.project('demo'), 'agent', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toContainText('FAILED');
  await both(app, 'terminal-tab');
  await app.locator(`.tab[data-tab="${agent.id}"]`).click(); // the side pane belongs to an agent's tab
  await icon(app, 'right', 'Terminal').click();
  await expect(app.locator('[data-side-pane]:not([hidden])')).toBeVisible();
  await app.waitForTimeout(500);
  await both(app, 'side-terminal');
  await icon(app, 'right', 'Browser').click();
  await expect(app.locator('[data-side-pane]:not([hidden])').getByLabel('Address')).toBeVisible();
  await both(app, 'side-browser');
});

// Ticket 499: the Search sidebar with hits, a hit under the pointer, and no matches.
test('search panel: hits, hover, no matches', async ({ app, core }) => {
  await searchSetup(app, core, { direct: true });
  await findText(app, 'needle');
  await expect(hits(app).first()).toBeVisible();
  await both(app, 'search-hits');
  await both(app, 'state-search-hit-hover', undefined, hits(app).nth(1));
  await findText(app, 'nothing-matches-this');
  await expect(searchStatus(app)).toHaveText('No matches');
  await both(app, 'search-empty');
});

// Ticket 499: onboarding, every step opened (477 shot only the page as it opens).
test('onboarding: every step', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="onboarding"]').click();
  const steps = app.locator('.ob-step');
  await expect(steps.first()).toBeVisible();
  const ids = await steps.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.step!));
  for (const id of ids) {
    await app.locator(`.ob-step[data-step="${id}"]`).click();
    await app.waitForTimeout(300);
    await both(app, `onboarding-${id}`);
  }
  await both(app, 'state-onboarding-step-hover', undefined, steps.first());
});

// Ticket 499: two real catalogue themes (iTerm2-Color-Schemes, one dark, one light), imported as a user imports them:
// Appearance, Show all, search, Enter on the card. The real core fetches them, so this needs the network.
test('catalogue themes: Dracula and iTerm2 Solarized Light', async ({ app, core }) => {
  test.setTimeout(240_000);
  const p = gitRepo(core.project('nunchiro'));
  core.shell(p, 'main-shell', '/bin/sh', '-c', "printf '\\033[32mok\\033[0m 408 passed; \\033[31mFAILED\\033[0m 2\\n'; exec cat");
  await openWindow(app);
  for (const name of ['Dracula', 'iTerm2 Solarized Light']) {
    const id = slug(name);
    await openTheme(app);
    await app.getByRole('radio', { name: 'One theme' }).check();
    await themeSearch(app, name);
    await themeCard(app, name).locator('.tpick').press('Enter'); // a click previews, Enter keeps (ticket 162)
    await expect(app.locator(`.tcard[data-theme-id="imported:${name}"] .tpick`)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await app.mouse.move(1435, 895);
    await shoot(app, 'catalogue', `${id}-appearance`);
    await app.getByRole('button', { name: 'Close Settings' }).click();
    await app.mouse.move(1435, 895);
    await app.waitForTimeout(300);
    await shoot(app, 'catalogue', `${id}-window`);
    await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
    await shoot(app, 'catalogue', `${id}-tree-hover`, app.locator('aside.sbar[data-side="left"]'));
    await app.locator('.grp[data-project="nunchiro"] button.n').click({ button: 'right' });
    await expect(app.getByRole('menu').last()).toBeVisible();
    await app.keyboard.press('ArrowDown');
    await shoot(app, 'catalogue', `${id}-menu`);
    await app.keyboard.press('Escape');
    await app.keyboard.press('Meta+KeyK');
    await expect(app.locator('.palette input')).toBeFocused();
    await shoot(app, 'catalogue', `${id}-palette`);
    await app.keyboard.press('Escape');
  }
});


// Ticket 552: the screens 499 never shot. Dialogs and menus are opened as a user opens them (palette, right-click, a
// button); each shot name is listed in docs/tickets/v2/issues/552-theme-sweep-all.md.
test('552 dialogs: add project, new project, clone, new session, decision card, deny, quit, close notice', async ({ app, core }) => {
  test.setTimeout(180_000);
  fakes(core);
  const repo = decisionRepo(core, 'repo');
  const agent = core.agent(repo, 'main-a', 'go-a');
  await openWindow(app);
  const palette = async (command: string) => {
    await app.keyboard.press('Meta+KeyK');
    const p = app.getByRole('dialog', { name: 'Command palette' });
    await expect(p).toBeVisible();
    await p.getByRole('combobox').fill(command);
    await app.keyboard.press('Enter');
  };
  await palette('Add project');
  const add = app.getByRole('dialog', { name: 'Add project', exact: true });
  await expect(add).toBeVisible();
  await both(app, 'dialog-add-project');
  await add.getByRole('button', { name: /^Create new/ }).click();
  await expect(app.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await both(app, 'dialog-new-project');
  await app.getByRole('dialog', { name: 'New project' }).getByRole('button', { name: 'Back' }).click();
  await add.getByRole('button', { name: /^Clone/ }).click();
  await expect(app.getByRole('dialog', { name: 'Clone a repository' })).toBeVisible();
  await both(app, 'dialog-clone');
  await app.keyboard.press('Escape');

  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  await expect(app.getByRole('dialog', { name: 'New tab' })).toBeVisible();
  await both(app, 'dialog-new-session');
  await app.keyboard.press('Escape');

  // A permission asked: the tree's decision line, the decision card from "details", and the deny instruction box.
  show(agent.cwd, 'go-a', PERMISSION('touch out-a'));
  const line = app.locator(`.q[data-line="${agent.id}"]`);
  await expect(line).toBeVisible({ timeout: 8000 });
  await both(app, 'tree-decision-line', app.locator('aside.sbar[data-side="left"]'));
  await line.locator('[data-act="deny"]').click();
  await expect(app.locator('.dn input')).toBeVisible();
  await both(app, 'decision-deny-instruction', app.locator('aside.sbar[data-side="left"]'));
  await line.locator('[data-act="details"]').click();
  await expect(app.locator('.deccard .dc-note')).toBeVisible();
  await both(app, 'decision-card');
  await app.keyboard.press('Escape');

  // The full quit lists the running agent and the pending item; the first window close shows a one-time notice.
  await app.evaluate(() => window.dispatchEvent(new Event('nunchiro:quit-request')));
  await expect(app.getByRole('dialog', { name: 'Quit and stop all agents' })).toBeVisible();
  await both(app, 'dialog-quit');
  await app.keyboard.press('Escape');
  await app.evaluate(() => window.dispatchEvent(new Event('nunchiro:close-request')));
  await expect(app.getByRole('dialog', { name: 'Closing the window' })).toBeVisible();
  await both(app, 'dialog-close-notice');
});

test('552 board: card editor and widget editor', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'core-serve');
  boardSeed(core, [{ id: 'c1', title: 'Write the release notes', column: 'todo' }]);
  await openBoard(app, core);
  const board = app.locator('.board');
  await cardOf(app, 'Write the release notes').locator('.btt').click();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toBeVisible();
  await both(app, 'board-card-editor');
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  if (!(await board.isVisible())) await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // Esc may close the widget too
  await app.mouse.move(2, 2);
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  await expect(app.getByRole('dialog', { name: 'Edit board widget' })).toBeVisible();
  await both(app, 'board-widget-editor');
});

test('552 composer menus: model, effort, permission mode, slash, file mention', async ({ app, core }) => {
  const p = core.project('demo-claude');
  git(p, 'init', '-q');
  fs.mkdirSync(path.join(p, '.claude/commands'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude/commands/ship.md'), '# ship\n');
  fs.mkdirSync(path.join(p, 'src/tree'), { recursive: true });
  fs.writeFileSync(path.join(p, 'src/tree/Tree.tsx'), 'export const tree = 1;\n');
  core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'claude', '--model', 'never');
  await openWindow(app);
  const composer = app.locator('.composer').first();
  const box = app.locator('.cbox textarea').first();
  for (const [name, trigger] of [['model', composer.locator('[data-picker="model"]')], ['effort', composer.locator('[data-picker="effort"]')], ['permission', composer.locator('.ch.perm')]] as const) {
    await trigger.click();
    await expect(app.getByRole('menu').last()).toBeVisible();
    await both(app, `composer-menu-${name}`);
    await app.keyboard.press('Escape');
    await expect(app.getByRole('menu')).toHaveCount(0);
  }
  await composer.getByRole('button', { name: 'Commands and skills', exact: true }).click();
  await expect(app.getByRole('listbox', { name: 'Commands and skills' })).toBeVisible();
  await both(app, 'composer-menu-slash');
  await box.fill('');
  await box.fill('@tree');
  await expect(app.getByRole('listbox', { name: 'Files' })).toBeVisible();
  await both(app, 'composer-menu-file');
  await box.fill('');
});

// Ticket 552: the first-run import step with its results (499 shot the step closed), as import-open.spec.ts drives it.
test.describe('552 first run', () => {
  test.use({ firstRun: true });
  test('import step: found conversations, imported, search hits', async ({ app, core }) => {
    const rec = (o: object) => JSON.stringify(o) + '\n';
    const dir = path.join(core.home, 'claude-home/projects/-work-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'c1.jsonl'), rec({ type: 'user', cwd: '/work/app', message: { role: 'user', content: 'migrate the zebra table' } }) + rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, the zebra table is renamed.' }] } }));
    fs.writeFileSync(path.join(dir, 'c2.jsonl'), rec({ type: 'user', cwd: '/work/app', message: { role: 'user', content: 'write the release notes' } }));
    await openWindow(app);
    const step = app.locator('[data-step="import"]');
    await expect(step).toBeVisible();
    await both(app, 'firstrun-import');
    await step.getByRole('button', { name: 'Look for conversations' }).click();
    await step.getByRole('button', { name: 'Select all' }).click();
    await both(app, 'firstrun-import-found', step);
    await step.getByRole('button', { name: /^Import \d+ selected/ }).click();
    await expect(step.getByRole('status')).toContainText('Imported');
    const find = step.getByRole('textbox', { name: 'Search imported conversations' });
    await find.fill('zebra');
    await find.press('Enter');
    await expect(step.locator('[data-hit]')).not.toHaveCount(0);
    await both(app, 'firstrun-import-hits', step);
  });
});

// Ticket 552: the pairing page a browser sees before it is paired (as inputs-one-style.spec.ts opens it), and the crash
// screen (as crash-screen.spec.ts). Both are drawn outside the app's theme code, so they follow prefers-color-scheme.
test('552 pairing page', async ({ app, core, browser }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phone = await ctx.newPage();
  await phone.route('**/', async (r) => {
    const res = await r.fetch();
    r.fulfill({ response: res, body: (await res.text()).replace('<head>', '<head><meta name="nunchiro-browser">') });
  });
  await phone.goto(app.url());
  await expect(phone.locator('.pairing input').first()).toBeVisible();
  await both(phone, 'pairing', undefined, undefined, false);
  // The page is served by the test's static server, which has no /pair: the first try shows the unreachable error.
  await phone.getByRole('button', { name: /pair/i }).click();
  await expect(phone.getByRole('alert')).toBeVisible();
  await both(phone, 'pairing-unreachable', undefined, undefined, false);
  // Then the core answers with a code, as it does for a real browser.
  await phone.route('**/pair*', (r) => r.fulfill({ json: r.request().method() === 'POST' ? { id: 'p1', code: '482 193' } : { state: 'waiting' } }));
  await phone.getByRole('button', { name: /pair/i }).click();
  await expect(phone.locator('[data-pair-code]')).toBeVisible();
  await both(phone, 'pairing-code', undefined, undefined, false);
  await ctx.close();
});

test('552 crash screen', async ({ app }) => {
  await app.addInitScript(() => ((window as unknown as { __testCrash?: string }).__testCrash = 'render'));
  await app.goto('/');
  await expect(app.getByRole('alert').filter({ hasText: 'This window hit a problem' })).toBeVisible();
  await both(app, 'crash-screen', undefined, undefined, false);
});
