// Ticket 262 (needs 197 G19 part a) and ticket 181 `release_candidate_build` (V2.5-34l): Settings > About shows which build
// runs (app and core version, the build's short sha fixed at build time), copies one support line, lists the bundled
// third-party notices with a search, and installs the `nunchiro` command. The app shell is stood in for by a recording
// `__TAURI_INTERNALS__` (`about_info`, `cli_status`, `cli_install`); the app menu's script is read from main.rs itself.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { buildSha } from '../vite.config';
import { expect, openWindow, REPO, test } from './fixtures';

type Call = { cmd: string; args?: unknown };
type Cli = { state: 'not_installed' | 'installed' | 'stale' | 'old_copy' | 'conflict'; link: string; target: string | null; current: string | null; path_hint: string | null };
const RES = '/Users/me/Applications/Nunchiro.app/Contents/Resources';
const INFO = { app: '0.1.0', core: '0.1.0', macos: '15.1', resources: RES };
const LINK = '/Users/me/.local/bin/nunchiro';
const TARGET = '/Users/me/Applications/Nunchiro.app/Contents/MacOS/nunchiro';
const CLI: Cli = { state: 'not_installed', link: LINK, target: TARGET, current: null, path_hint: null };
// playwright.config.ts gives the test build a known NUNCHIRO_BUILD_SHA; the page shows its first 7 characters.
const SHA = buildSha(REPO, process.env);
const LINE = `Nunchiro 0.1.0 · ${SHA} (core 0.1.0, macOS 15.1)`;

/** The app shell: `about_info` answers INFO once (later calls never answer, so a Copy that waits on the app copies nothing),
 *  `cli_status` the given status, `cli_install` the given answer. Copies are recorded with whether they ran inside the click
 *  (WebKit drops a clipboard write once the user gesture is gone). */
async function shell(app: Page, { info = INFO as Omit<typeof INFO, 'resources'> & { resources: string | null }, status = CLI, install = { ...CLI, state: 'installed', current: TARGET } as Cli } = {}) {
  await app.addInitScript(
    ({ info, status, install }) => {
      const w = window as unknown as { __calls: Call[]; __copied: string[]; __inClick: boolean[]; __TAURI_INTERNALS__: unknown };
      w.__calls = [];
      w.__copied = [];
      w.__inClick = [];
      // True from the click's capture on window until its bubble on window: React's handlers run in between.
      let clicking = false;
      window.addEventListener('click', () => (clicking = true), true);
      window.addEventListener('click', () => (clicking = false));
      const answers: Record<string, unknown> = { about_info: info, cli_status: status, cli_install: install };
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: unknown) => {
          const again = cmd === 'about_info' && w.__calls.some((c) => c.cmd === 'about_info');
          w.__calls.push({ cmd, args });
          return again ? new Promise(() => {}) : Promise.resolve(answers[cmd] ?? null);
        },
        transformCallback: () => 0,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void (w.__copied.push(text), w.__inClick.push(clicking)) }, configurable: true });
    },
    { info, status, install },
  );
}
const copied = (app: Page) => app.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
const inClick = (app: Page) => app.evaluate(() => (window as unknown as { __inClick: boolean[] }).__inClick);
const calls = (app: Page) => app.evaluate(() => (window as unknown as { __calls: Call[] }).__calls.map((c) => c.cmd));
const nav = (app: Page) => app.locator('.settings > nav');
const openSettings = (app: Page) => app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
const title = (app: Page) => app.locator('.settings header.phd h1');
async function openAbout(app: Page) {
  await openSettings(app);
  await nav(app).locator('button[data-page="about"]').click();
  await expect(title(app)).toHaveText('About');
}

test('about_page_shows_app_and_core_version_and_copies_line', async ({ app }) => {
  await shell(app);
  await openWindow(app);
  await openAbout(app);
  // v25c-about-polish: two cards, App then Legal (T3 Code's About page layout).
  await expect(app.locator('.sbody section.ssec > h2')).toHaveText(['App', 'Legal']);
  const version = app.locator('[data-row="buildInfo"]');
  await expect(version.locator('.snm')).toHaveText(`Version0.1.0 · ${SHA}`);
  await expect(version.locator('.snm .mono')).toHaveText(`0.1.0 · ${SHA}`);
  await expect(version.locator('.sds')).toHaveText('background service 0.1.0 · macOS 15.1');
  await app.getByRole('button', { name: 'Copy version and build' }).click();
  await expect.poll(() => copied(app)).toEqual([LINE]);
  // Written inside the click from what the page already holds: no second app call before the write.
  expect(await inClick(app)).toEqual([true]);
  expect((await calls(app)).filter((c) => c === 'about_info')).toHaveLength(1);
  await expect(version.getByRole('status')).toHaveText('Copied');
});

test('about_page_shows_build_sha', async ({ app }) => {
  // The known value from the test build's environment, not a git read of this checkout.
  expect(process.env.NUNCHIRO_BUILD_SHA?.slice(0, 7)).toBe(SHA);
  await shell(app);
  await openWindow(app);
  await openAbout(app);
  await expect(app.locator('[data-row="buildInfo"] .snm')).toContainText(SHA);
});

test('build_sha_falls_back_to_git_files_without_env', async ({}, info) => {
  const root = path.join(REPO, '.scratch', `about-sha-${process.pid}-${info.project.name}`);
  fs.rmSync(root, { recursive: true, force: true });
  const main = path.join(root, 'main');
  fs.mkdirSync(path.join(main, 'web'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'one');
  const head = git(main, 'rev-parse', 'HEAD');
  // A plain checkout: .git is a folder, HEAD names a loose ref.
  expect(buildSha(main, {})).toBe(head.slice(0, 7));
  // Only the given root's own .git counts: a folder without one is "dev", never a parent's checkout (a dotfiles repo in $HOME).
  expect(buildSha(path.join(main, 'web'), {})).toBe('dev');
  // The ref only in packed-refs.
  git(main, 'pack-refs', '--all');
  expect(fs.existsSync(path.join(main, '.git/refs/heads/main'))).toBe(false);
  expect(buildSha(main, {})).toBe(head.slice(0, 7));
  // A worktree: .git is a file (`gitdir:`), HEAD is the worktree's own, its branch ref in the common folder.
  const wt = path.join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'two');
  const side = git(wt, 'rev-parse', 'HEAD');
  expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
  expect(side).not.toBe(head);
  expect(buildSha(wt, {})).toBe(side.slice(0, 7));
  // A detached HEAD holds the sha itself.
  git(wt, 'checkout', '-q', '--detach', head);
  expect(buildSha(wt, {})).toBe(head.slice(0, 7));
  // The environment wins; a value that is not a hex sha is ignored.
  expect(buildSha(wt, { NUNCHIRO_BUILD_SHA: 'ABCDEF0123456789' })).toBe('abcdef0');
  expect(buildSha(wt, { NUNCHIRO_BUILD_SHA: 'x; rm -rf' })).toBe(head.slice(0, 7));
  // No checkout at all: "dev".
  const bare = path.join(root, 'none');
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(bare, '.git'), 'gitdir: /nowhere/at/all\n');
  expect(buildSha(bare, {})).toBe('dev');
  fs.rmSync(root, { recursive: true, force: true });
});

test('build_info_copy_from_about_and_palette', async ({ app }) => {
  await shell(app);
  await openWindow(app);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('dialog').getByRole('combobox').fill('Copy build info');
  await app.keyboard.press('Enter');
  // The palette copies from the info read once at load: no app call waits between the key and the write.
  await expect.poll(() => copied(app)).toEqual([LINE]);
  await openAbout(app);
  await app.getByRole('button', { name: 'Copy version and build' }).click();
  await expect.poll(() => copied(app)).toEqual([LINE, LINE]);
  expect((await inClick(app))[1]).toBe(true);
  expect((await calls(app)).filter((c) => c === 'about_info')).toHaveLength(1);
});

test('settings_search_finds_build_info', async ({ app }) => {
  await shell(app);
  await openWindow(app);
  await openSettings(app);
  const search = nav(app).getByRole('searchbox', { name: 'Search settings' });
  const results = app.getByRole('list', { name: 'Matching settings' });
  for (const q of ['version', 'build', 'about']) {
    await search.fill(q);
    await expect(results.getByRole('button', { name: 'Version and build · About' }), q).toBeVisible();
  }
  await results.getByRole('button', { name: 'Version and build · About' }).click();
  await expect(title(app)).toHaveText('About');
  await expect.poll(() => app.evaluate(() => document.activeElement?.getAttribute('data-setting'))).toBe('buildInfo');
  // Korean: the page and the field in the catalogue's words.
  await nav(app).locator('button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption('ko');
  // By class: the search box and the results list carry Korean names now.
  await nav(app).locator('input.search').fill('버전');
  await expect(nav(app).locator('ul.smatches').getByRole('button', { name: '버전과 빌드 · 정보' })).toBeVisible();
  await expect(nav(app).locator('button[data-page="about"]')).toHaveText('정보');
});

/** THIRD_PARTY_NOTICES.md's table rows as "file — source — licence", markdown links and backticks dropped. */
function noticeRows(md: string): string[] {
  const rows: string[] = [];
  let cols: Record<string, number> | null = null;
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, ''));
  const lines = md.split('\n');
  for (const [i, l] of lines.entries()) {
    if (!l.startsWith('|')) cols = null;
    else if (/^\|[-| ]+\|$/.test(l)) continue;
    else if (/^\|[-| ]+\|$/.test(lines[i + 1] ?? '')) {
      const h = cells(l).map((c) => c.toLowerCase());
      cols = { source: h.findIndex((c) => c === 'source' || c === 'upstream'), licence: h.findIndex((c) => /^licen[cs]e$/.test(c)) };
    } else if (cols) {
      const c = cells(l);
      rows.push([c[0], c[cols.source], c[cols.licence]].join(' — '));
    }
  }
  return rows;
}

test('about_page_lists_licences_from_notices', async ({ app }) => {
  const rows = noticeRows(fs.readFileSync(path.join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
  expect(rows.length).toBeGreaterThan(20);
  await shell(app);
  await openWindow(app);
  await openAbout(app);
  // The Legal card's row names the count from the notices file; the list stays shut until View licences.
  const row = app.locator('[data-row="licences"]');
  await expect(row.locator('.snm')).toHaveText('Open source licences');
  await expect(row.locator('.sds')).toHaveText(`${rows.length} notices for code and data adapted into Nunchiro.`);
  const view = row.getByRole('button', { name: 'View licences' });
  await expect(view).toHaveAttribute('aria-expanded', 'false');
  const box = app.locator('[data-licences]');
  await expect(box).toBeHidden();
  // Keyboard: the button opens the block in place below the card.
  await view.focus();
  await app.keyboard.press('Enter');
  await expect(view).toHaveAttribute('aria-expanded', 'true');
  await expect(box).toBeVisible();
  expect(await box.evaluate((b) => b.getBoundingClientRect().top >= b.previousElementSibling!.getBoundingClientRect().bottom)).toBe(true);
  const items = box.locator('li');
  await expect(items).toHaveText(rows);
  // Plain rows: no table pipes, backticks or markdown link syntax.
  for (const r of await items.allInnerTexts()) expect(r, r).not.toMatch(/[|`]|\]\(/);
  expect(await box.locator('ul').evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto');
  // A search keeps only the entries that name it, and the block stays open while it is typed.
  const search = app.getByRole('searchbox', { name: 'Search licences' });
  await search.fill('Lovecast');
  const want = rows.filter((r) => r.toLowerCase().includes('lovecast'));
  expect(want.length).toBeGreaterThan(2);
  await expect(items).toHaveText(want);
  await expect(items.first()).toBeVisible();
  await search.fill('no such licence anywhere');
  await expect(app.getByRole('status').filter({ hasText: 'No entry matches' })).toBeVisible();
  // The button toggles it shut again.
  await view.click();
  await expect(box).toBeHidden();
  await expect(view).toHaveAttribute('aria-expanded', 'false');
  // Full licence texts: Show in Finder reveals the bundled files in the app's Resources folder.
  const files = app.locator('[data-row="licenceFiles"]');
  await expect(files.locator('.snm')).toHaveText('Full licence texts');
  await expect(files.locator('.sds')).toHaveText('Rust and npm licence files bundled in the app.');
  await files.getByRole('button', { name: 'Show in Finder' }).click();
  await expect.poll(async () => JSON.stringify(await app.evaluate(() => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.cmd.includes('reveal'))))).toContain(`${RES}/THIRD_PARTY_LICENSES_RUST.md`);
});

test('about_hides_licence_files_without_resources_folder', async ({ app }) => {
  await shell(app, { info: { ...INFO, resources: null } });
  await openWindow(app);
  await openAbout(app);
  await expect(app.locator('[data-row="licences"]')).toBeVisible();
  await expect(app.locator('[data-row="licenceFiles"]')).toHaveCount(0);
});

// Look v35 c S3-2: a build that does not update itself shows the row, its button off, with the reason on the row.
test('about_updates_row_off_with_reason_outside_a_self_updating_build', async ({ app }) => {
  await shell(app);
  await openWindow(app);
  await openAbout(app);
  const row = app.locator('[data-row="updates"]');
  const check = row.getByRole('button', { name: 'Check now' });
  await expect(check).toBeDisabled();
  await expect(row.locator('[data-why="why-updates"]')).toHaveText('This build does not update itself: only the installed Nunchiro.app does. A test build keeps its own home and never updates.');
  await expect(check).toHaveAttribute('aria-describedby', 'why-updates');
});

test('about_updates_row_runs_the_palette_check_in_a_self_updating_build', async ({ app }) => {
  await shell(app); // `rc_update_check` answers null: nothing newer
  await openWindow(app, { rcUpdates: true });
  await openAbout(app);
  const row = app.locator('[data-row="updates"]');
  await expect(row.locator('.sds').first()).toHaveText('Check for a new build.');
  await row.getByRole('button', { name: 'Check now' }).click();
  await expect(row.locator('.sds').first()).toHaveText('No newer build');
});

test('about_has_its_own_nav_icon', async ({ app }) => {
  await shell(app);
  await openWindow(app);
  await openSettings(app);
  const icon = (page: string) => nav(app).locator(`button[data-page="${page}"] svg`).evaluate((e) => e.innerHTML);
  expect(await icon('about')).not.toBe(await icon('general'));
});

test('about_page_reachable_in_two_clicks', async ({ app }) => {
  await shell(app);
  await openWindow(app);
  await openSettings(app); // 1
  await nav(app).getByRole('button', { name: 'About', exact: true }).click(); // 2
  await expect(title(app)).toHaveText('About');
  await expect(app.locator('[data-row="buildInfo"]')).toBeVisible();
  // It sits last in the Advanced group.
  await expect(nav(app).locator('[data-group="advanced"] button[data-page]').last()).toHaveAttribute('data-page', 'about');
});

test('app_menu_about_opens_about_page', async ({ app }) => {
  // The exact script main.rs evaluates for the menu's "About Nunchiro".
  const main = fs.readFileSync(path.join(REPO, 'app/src-tauri/src/main.rs'), 'utf8');
  const script = /const ABOUT_SCRIPT: &str =\s*"((?:[^"\\]|\\.)*)";/.exec(main)?.[1];
  expect(script, 'ABOUT_SCRIPT in main.rs').toBeTruthy();
  expect(main).toMatch(/MenuItem::with_id\(\s*app,\s*"about",\s*"About Nunchiro"/);
  await shell(app);
  await openWindow(app);
  await expect(app.locator('.settings')).toHaveCount(0);
  await app.evaluate((s) => (0, eval)(s), script!.replace(/\\"/g, '"'));
  await expect(title(app)).toHaveText('About');
  await expect(app.locator('#snav-about')).toHaveAttribute('aria-current', 'page');
});

test('about_install_wires_cli_status_install_refusal_and_path_hint', async ({ app }) => {
  const hint = 'export PATH="$HOME/.local/bin:$PATH"';
  await shell(app, { status: { ...CLI, state: 'conflict', current: null }, install: { ...CLI, state: 'installed', current: TARGET, path_hint: hint } });
  await openWindow(app);
  await openAbout(app);
  const row = app.locator('[data-row="cliInstall"]');
  // A file that is not a link into Nunchiro.app: refused, Install stays off.
  await expect(row.getByRole('alert')).toContainText(`~/.local/bin/nunchiro is not a link to Nunchiro.app`);
  await expect(row.getByRole('button', { name: 'Install' })).toBeDisabled();
  expect(await calls(app)).toContain('cli_status');
  expect(await calls(app)).not.toContain('cli_install');
});

test('about_install_outside_names_the_rc_data_folder', async ({ app }) => {
  // The RC ("Nunchiro RC.app") or a dev build: no target to install from, and the note says why.
  await shell(app, { status: { ...CLI, target: null } });
  await openWindow(app);
  await openAbout(app);
  const row = app.locator('[data-row="cliInstall"]');
  await expect(row.getByRole('status')).toContainText('uses its own data folder');
  await expect(row.getByRole('button', { name: 'Install' })).toBeDisabled();
});

test('about_install_links_and_shows_path_hint', async ({ app }) => {
  const hint = 'export PATH="$HOME/.local/bin:$PATH"';
  await shell(app, { install: { ...CLI, state: 'installed', current: TARGET, path_hint: hint } });
  await openWindow(app);
  await openAbout(app);
  const row = app.locator('[data-row="cliInstall"]');
  await expect(row.locator('.snm')).toHaveText('nunchiro command');
  await expect(row.locator('.sds').first()).toHaveText('Run the Nunchiro command-line tool as nunchiro from any terminal. It only creates the link ~/.local/bin/nunchiro.');
  await row.getByRole('button', { name: 'Install' }).click();
  await expect(row.getByRole('status')).toContainText(`~/.local/bin/nunchiro → ~/Applications/Nunchiro.app/Contents/MacOS/nunchiro`);
  await expect(row.locator('code', { hasText: hint })).toBeVisible();
  expect(await calls(app)).toContain('cli_install');
});

// Look v34 S3-2: the "old copy" note read 15 px in the full text colour under a muted 12-13 px description; it is a hint
// line in the description's own type now.
test('about_install_old_copy_note_is_a_hint_line', async ({ app }) => {
  await shell(app, { status: { ...CLI, state: 'old_copy', current: null } });
  await openWindow(app);
  await openAbout(app);
  const row = app.locator('[data-row="cliInstall"]');
  const note = row.getByRole('status');
  await expect(note).toContainText('~/.local/bin/nunchiro is an old copy of nunchiro');
  const type = (el: Element) => ({ size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color });
  expect(await note.evaluate(type)).toEqual(await row.locator('.sds').first().evaluate(type));
});
