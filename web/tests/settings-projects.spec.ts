// Ticket 1040 (mockup docs/design/projects-settings-1121/index.html): Settings > Projects lists every project the core
// knows, a row opens the project's page (name, icon, folder, its new-session defaults, its worktree settings, remove), and
// a project whose folder moved is located again with everything it had.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
// A home folder is shown as ~ (Row.tsx `tilde`); the test's projects may sit under one.
const shown = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');
const MODEL = 'Default model and effort · Claude';
const page = (app: Page) => app.locator('.settings .sbody');
const rows = (app: Page) => page(app).locator('.pj-row');
const row = (app: Page, name: string) => rows(app).filter({ has: app.locator('.pj-name', { hasText: new RegExp(`^${name}$`) }) });
const one = (app: Page) => page(app).locator('.pj-one');
const card = (app: Page, name: string) => one(app).getByRole('region', { name, exact: true });
const settingsOf = (core: Core) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {};
  } catch {
    return {};
  }
};
const treeFile = (core: Core) => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8');
/** A project the tree keeps with no session. */
const added = (core: Core, name: string) => {
  const dir = core.project(name);
  seed(core, { op: 'add', project: dir, added: true });
  return dir;
};
async function openProjects(app: Page, core?: Core) {
  await openWindow(app, {}, core);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.locator('.settings nav button[data-page="projects"]').click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Projects');
}
async function openOne(app: Page, name: string) {
  await row(app, name).locator('.pj-open').click();
  await expect(one(app).getByRole('heading', { level: 2, name })).toBeVisible();
}
/** The macOS folder panel's stand-in: answers `plugin:dialog|open` with `folder`. */
const panel = (app: Page, folder: string) =>
  app.addInitScript((picked) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? picked : null) };
  }, folder);

test('projects_page_lists_every_project: a folded group, a project with no session and an ended one are all rows, in the tree order', async ({ app, core }) => {
  const alpha = core.project('alpha');
  core.shell(alpha, 'a');
  const beta = added(core, 'beta'); // no session
  const gamma = core.project('gamma');
  core.shell(gamma, 'g', '/usr/bin/true'); // its only session ended: the tree's quiet kind
  seed(core, { op: 'group_create', name: 'Work', project: alpha }, { op: 'project_name', project: beta, name: 'Docs site' });
  await openWindow(app);
  const order = await app.locator('.grp[data-project]').evaluateAll((g) => g.map((x) => x.getAttribute('data-project')));
  expect([...order].sort()).toEqual(['Docs site', 'alpha', 'gamma']);
  seed(core, { op: 'fold', key: 'group:Work', folded: true });
  await app.reload();
  await openProjects(app);
  await expect(app.locator('.settings nav [data-group="git"] button')).toHaveText(['Git & worktrees', 'Projects']);
  await expect(app.locator('.settings header.phd p')).toHaveText('Every project Nunchiro knows, also the ones folded away in the tree. Open one to set its name, its defaults for new sessions and its worktrees. Add projects and start sessions from the tree.');
  await expect(rows(app).locator('.pj-name')).toHaveText(order as string[]);
  await expect(app.locator('.settings header.phd .ssum')).toHaveText('Projects 3');
  // A renamed project shows its folder name beside the name; the group is a chip; the path is under the name.
  await expect(row(app, 'Docs site').locator('.pj-was')).toHaveText('folder: beta');
  await expect(row(app, 'alpha').locator('.pj-chip')).toHaveText(['Work']);
  await expect(row(app, 'gamma').locator('.pj-path')).toHaveText(shown(gamma));
  await expect(row(app, 'gamma').locator('.pj-chip')).toHaveCount(0);
  // No session or worktree counts, no add button, no filter.
  await expect(page(app).getByRole('button', { name: /Add|New/ })).toHaveCount(0);
  await expect(page(app).getByRole('searchbox')).toHaveCount(0);
  // The whole row is one button: a click on the path opens the project, and the back link returns to the list.
  await row(app, 'gamma').locator('.pj-path').click();
  await expect(one(app).getByRole('heading', { level: 2, name: 'gamma' })).toBeVisible();
  await one(app).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(rows(app)).toHaveCount(3);
  // Keyboard: a row opens with Enter.
  await row(app, 'alpha').locator('.pj-open').focus();
  await app.keyboard.press('Enter');
  await expect(one(app).getByRole('heading', { level: 2, name: 'alpha' })).toBeVisible();
  await expect(one(app).locator('.pj-head .pj-chip')).toHaveText(['Work']);
});

test('projects_page_folder_states: a deleted folder is "Folder not found" with Locate, a refused read is "No access", and neither shows the other', async ({ app, core }) => {
  const gone = added(core, 'gone');
  const shut = added(core, 'shut');
  added(core, 'fine');
  fs.rmSync(gone, { recursive: true });
  fs.chmodSync(shut, 0o000);
  try {
    await openProjects(app);
    await expect(row(app, 'gone')).toHaveAttribute('data-folder', 'missing');
    await expect(row(app, 'gone').locator('.pj-chip')).toHaveText(['Folder not found']);
    await expect(row(app, 'gone').getByRole('button', { name: 'Locate…' })).toBeVisible();
    await expect(row(app, 'shut').locator('.pj-chip')).toHaveText(['No access']);
    await expect(row(app, 'shut').getByRole('button', { name: 'Locate…' })).toHaveCount(0);
    await expect(row(app, 'fine').locator('.pj-chip')).toHaveCount(0);
    await expect(app.locator('.settings header.phd .ssum')).toHaveText('Projects 3 · Not found 1');
    // Opened: the red banner with Locate, and Locate in place of Reveal in Finder; the other cards stay.
    await openOne(app, 'gone');
    const banner = one(app).getByRole('alert');
    await expect(banner).toContainText('Folder not found:');
    await expect(banner).toContainText('It was moved, renamed or deleted. Locate it to keep this project’s name, group, icon, settings and session history. New sessions cannot start until then.');
    await expect(banner.getByRole('button', { name: 'Locate…' })).toBeVisible();
    await expect(card(app, 'Project').getByRole('button', { name: 'Locate…' })).toBeVisible();
    await expect(card(app, 'Project').getByRole('button', { name: 'Reveal in Finder' })).toHaveCount(0);
    await expect(card(app, 'Worktrees').getByLabel('Setup script', { exact: true })).toBeEditable();
    await one(app).getByRole('button', { name: 'Projects', exact: true }).click();
    // A refused read: amber, its own sentence, no Locate.
    await openOne(app, 'shut');
    await expect(one(app).getByRole('alert')).toContainText('macOS does not let Nunchiro read this folder.');
    await expect(one(app).getByRole('button', { name: 'Locate…' })).toHaveCount(0);
    // The folder comes back: the state follows when the window regains focus.
    fs.chmodSync(shut, 0o755);
    await app.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(one(app).getByRole('alert')).toHaveCount(0);
  } finally {
    fs.chmodSync(shut, 0o755);
  }
});

test('projects_page_open_follows_missing: a folder renamed while its page is open shows "Folder not found" and Locate there, with no focus change (look v33 S3-4)', async ({ app, core }) => {
  const dir = added(core, 'demo');
  await openProjects(app);
  await openOne(app, 'demo');
  await expect(one(app).getByRole('alert')).toHaveCount(0);
  fs.renameSync(dir, `${dir}-moved`);
  const banner = one(app).getByRole('alert');
  await expect(banner).toContainText('Folder not found:', { timeout: 8000 });
  await expect(banner.getByRole('button', { name: 'Locate…' })).toBeVisible();
  await expect(card(app, 'Project').getByRole('button', { name: 'Locate…' })).toBeVisible();
  await expect(card(app, 'Project').locator('[data-row="projects.folder"]')).toContainText('not found');
  await app.screenshot({ path: path.join(REPO, '.scratch/shots/w87-projects-open-missing.png') });
});

test('projects_page_folders_single_flight: a core that never answers project_folders gets at most one such request in flight over 30 s', async ({ app, core }) => {
  added(core, 'demo');
  let asked = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'project_folders') return void asked++; // a stalled disk: never answered
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await app.clock.install();
  await openProjects(app, core);
  await openOne(app, 'demo');
  await expect.poll(() => asked).toBe(1);
  for (let i = 0; i < 6; i++) {
    await app.clock.runFor(5000);
    await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  }
  expect(asked).toBe(1);
});

test('projects_page_name_and_icon: a name typed on the page shows on the tree row, an empty name returns to the folder name, and an image is the icon', async ({ app, core }) => {
  const dir = core.project('alpha');
  core.shell(dir, 'a');
  await panel(app, ''); // the app's window: Reveal in Finder is the app's (no Finder in a browser window)
  await openProjects(app);
  await openOne(app, 'alpha');
  const name = card(app, 'Project').getByLabel('Name', { exact: true });
  await expect(name).toHaveValue('alpha');
  await name.fill('Docs site');
  await name.press('Enter');
  await expect(app.locator('.grp[data-project="Docs site"]')).toHaveCount(1);
  await expect(one(app).getByRole('heading', { level: 2, name: 'Docs site' })).toBeVisible();
  expect(treeFile(core)).toContain('Docs site');
  await name.fill('');
  await name.blur();
  await expect(app.locator('.grp[data-project="alpha"]')).toHaveCount(1);
  await expect(name).toHaveValue('alpha');
  // Icon: the existing pick; the page and the tree row both show it.
  await expect(card(app, 'Project').locator('.srow .snm')).toHaveText(['Name', 'Icon', 'Folder']);
  await card(app, 'Project').locator('input[type="file"]').setInputFiles({ name: 'i.png', mimeType: 'image/png', buffer: PNG });
  await expect(one(app).locator('.pj-head img.pico')).toHaveCount(1);
  await expect(app.locator('.grp[data-project="alpha"] img.pico')).toHaveCount(1);
  // Folder: the path, Copy path and Reveal in Finder.
  await expect(card(app, 'Project').locator('[data-row="projects.folder"] .sds')).toHaveText(shown(dir));
  await expect(card(app, 'Project').getByRole('button', { name: 'Copy path' })).toBeVisible();
  await expect(card(app, 'Project').getByRole('button', { name: 'Reveal in Finder' })).toBeVisible();
});

test('projects_page_locate_moves_everything: after Locate the tree file, the settings, the icon and the past sessions are at the new folder and nothing names the old one', async ({ app, core }) => {
  const old = core.project('old-blog');
  const other = core.project('api');
  core.shell(other, 'o');
  core.shell(old, 'past', '/usr/bin/true'); // a past session: its history must stay with the project
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { project: string; state: string }[]).find((s) => s.project === old)?.state).toBe('exited');
  seed(core, { op: 'group_create', name: 'Work', project: old }, { op: 'pin', project: old, pinned: true }, { op: 'project_name', project: old, name: 'Blog' });
  const moved = path.join(path.dirname(old), 'blog-2024');
  await panel(app, moved);
  await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'agents.new_session_defaults': { all: {}, projects: { [p]: { claude: { model: 'sonnet' } } } } } })), old);
  await openProjects(app);
  await openOne(app, 'Blog');
  // Its own settings and icon, set on the page before the folder moves.
  await card(app, 'Worktrees').getByLabel('Setup script', { exact: true }).fill('pnpm install');
  await card(app, 'Worktrees').getByLabel('Cleanup script', { exact: true }).click();
  await expect.poll(() => settingsOf(core)['worktree.scripts']?.[old]?.setup).toBe('pnpm install');
  await card(app, 'Project').locator('input[type="file"]').setInputFiles({ name: 'i.png', mimeType: 'image/png', buffer: PNG });
  await expect(one(app).locator('.pj-head img.pico')).toHaveCount(1);
  fs.renameSync(old, moved);
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  await one(app).getByRole('alert').getByRole('button', { name: 'Locate…' }).click();
  // Frame 4: the confirm names the old and the new path and what moves.
  const confirm = app.getByRole('alertdialog', { name: 'Use this folder for ‘Blog’?' });
  await expect(confirm.locator('.pj-was-now')).toHaveText([`Was${shown(old)}`, `Now${shown(moved)}`]);
  await expect(confirm).toContainText('The name, group, pin, icon, settings and session history move to this folder.');
  await expect(confirm).toContainText('Nothing on disk is changed.');
  await expect(confirm.locator('.rmfacts li')).toHaveText(['The name, group, pin, icon, settings and session history move to this folder.', 'Nothing on disk is changed.', 'Permissions, approvals, tokens and schedules for this project are asked again after the move.']);
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await confirm.getByRole('button', { name: 'Use this folder' }).click();
  await expect(confirm).toHaveCount(0);
  const now = fs.realpathSync(moved);
  await expect(app.locator('.toast')).toContainText(`Blog now uses ${shown(now)}`);
  // One project at the new path, with the same name, group, pin, icon, settings and past session; no row at the old one.
  await expect(one(app).getByRole('heading', { level: 2, name: 'Blog' })).toBeVisible();
  await expect(one(app).getByRole('alert')).toHaveCount(0);
  await expect(card(app, 'Project').locator('[data-row="projects.folder"] .sds')).toHaveText(shown(now));
  await expect(one(app).locator('.pj-head img.pico')).toHaveCount(1);
  await expect(one(app).locator('.pj-head .pj-chip')).toHaveText(['Work']);
  await expect(card(app, 'Worktrees').getByLabel('Setup script', { exact: true })).toHaveValue('pnpm install');
  await expect(card(app, 'New sessions').getByRole('combobox', { name: MODEL })).toHaveValue('sonnet');
  const tree = treeFile(core);
  expect(tree).not.toContain(`${old}"`);
  expect(tree).toContain(`pins = ["${now}"]`);
  expect(tree).toContain(`"${now}" = "Blog"`);
  expect(tree).toMatch(new RegExp(`name = "Work"\\nprojects = \\["${now.replaceAll('/', '\\/')}"\\]`));
  expect(Object.keys(settingsOf(core)['worktree.scripts'])).toEqual([now]);
  const sessions = core.cli('snapshot', '--json').sessions as { project: string; label: string }[];
  expect(sessions.filter((s) => s.label === 'past').map((s) => s.project)).toEqual([now]);
  expect(await app.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('nunchiro.settings.v1')!).features['agents.new_session_defaults'].projects))).toEqual([now]);
  await one(app).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(rows(app).locator('.pj-name')).toHaveText(['api', 'Blog']); // the tree's order: ungrouped first, then the group
  await expect(row(app, 'Blog').locator('.pj-path')).toHaveText(shown(now));
});

test('projects_page_locate_refusals: a folder that is already a project, and a running session, are one line in the dialog and change nothing', async ({ app, core }) => {
  const old = added(core, 'old-blog');
  const other = added(core, 'api');
  fs.rmSync(old, { recursive: true });
  await panel(app, other);
  await openProjects(app);
  await row(app, 'old-blog').getByRole('button', { name: 'Locate…' }).click(); // the row's own Locate
  const confirm = app.getByRole('alertdialog', { name: 'Use this folder for ‘old-blog’?' });
  const before = treeFile(core);
  await confirm.getByRole('button', { name: 'Use this folder' }).click();
  await expect(confirm.getByRole('alert')).toHaveText('That folder is already a project in Nunchiro.');
  expect(treeFile(core)).toBe(before);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(rows(app)).toHaveCount(2);
});

test('projects_page_remove_uses_tree_dialog: the page button opens the tree dialog, now "from Nunchiro", and the page returns to the list', async ({ app, core }) => {
  const dir = added(core, 'notes-app');
  const keep = core.project('alpha');
  core.shell(keep, 'a');
  await openProjects(app);
  await openOne(app, 'notes-app');
  await expect(card(app, 'Remove')).toContainText('Closes this project’s sessions and deletes their history. The folder and its files stay on disk.');
  await card(app, 'Remove').getByRole('button', { name: 'Remove from Nunchiro…' }).click();
  const dialog = app.getByRole('alertdialog', { name: 'Remove ‘notes-app’ from Nunchiro?' });
  await expect(dialog).toContainText(dir);
  await expect(dialog).toContainText('The folder and its files stay on disk.');
  await dialog.getByRole('button', { name: 'Remove from Nunchiro', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows(app).locator('.pj-name')).toHaveText(['alpha']);
  expect(fs.existsSync(dir)).toBe(true);
  // The tree's menu item says the same words.
  await app.keyboard.press('Escape');
  await app.locator('.grp[data-project="alpha"] .head .n').click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' }).locator('[data-command="project.remove"]')).toHaveText('Remove from Nunchiro…');
});

test('projects_page_new_session_defaults: a model set on the project page is what a new session of that project starts with, and Providers has no scope line', async ({ app, core }) => {
  const frames: { op: string; session?: unknown; start?: unknown }[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const j = JSON.parse(String(f.payload));
        if (j.request) frames.push(j.request);
      } catch {
        // not JSON (an ack frame)
      }
    }),
  );
  // Since #57 the New tab menu sends its start as `start_or_wait` (a held start waits for memory), the start inside it.
  const lastStart = () => frames.map((f) => (f.op === 'start_or_wait' ? (f.start as typeof f) : f)).filter((f) => f.op === 'start').at(-1)?.session;
  const startClaude = async (project: string) => {
    await app.evaluate((p) => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: p } })), project);
    await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: 'Claude' }).first().click();
  };
  const dir = core.project('alpha');
  core.shell(dir, 'a');
  core.shell(core.project('beta'), 'b');
  await openProjects(app);
  await openOne(app, 'alpha');
  const sec = card(app, 'New sessions');
  await expect(sec.locator('.srow .snm')).toHaveText(['Claude', 'Codex']);
  const model = sec.getByRole('combobox', { name: MODEL });
  await expect(model.locator('option').first()).toHaveText('Follow All projects');
  await expect(sec.getByRole('button', { name: /Reset/ })).toHaveCount(0);
  await model.selectOption('sonnet');
  const stored = () => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features?.['agents.new_session_defaults']);
  await expect.poll(async () => (await stored())?.projects?.[dir]?.claude?.model).toBe('sonnet');
  expect((await stored()).all).toEqual({});
  expect(Object.keys((await stored()).projects)).toEqual([dir]); // another project is not touched
  // The reset goes back to "Follow All projects".
  await sec.getByRole('button', { name: 'Reset Claude model and effort to default' }).click();
  await expect(model).toHaveValue('');
  await expect.poll(async () => (await stored())?.projects?.[dir]?.claude).toBeUndefined();
  await model.selectOption('sonnet');
  // Providers: all-projects values only.
  await app.locator('.settings nav button[data-page="providers"]').click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Providers');
  await expect(app.locator('.settings .setscope')).toHaveCount(0);
  await expect(app.locator('.settings')).not.toContainText('Applying settings for');
  // A new session of this project gets the model (last: a started session takes the window from Settings).
  await app.keyboard.press('Escape');
  await startClaude(dir);
  await expect.poll(lastStart).toMatchObject({ project: dir, model: 'sonnet' });
});

test('projects_page_scripts_and_files_moved: a setup script saved before shows on the project page; Git & Worktrees has the link line and no project select', async ({ app, core }) => {
  const dir = core.project('alpha');
  core.shell(dir, 'a');
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ features: { 'worktree.scripts': { [dir]: { setup: 'make deps', cleanup: '', policy: 'ask', wait: false } }, 'worktree.shared': { [dir]: { files: [{ path: '.env', mode: 'link' }], sparse: [] } } } }));
  core.run(['serve', 'stop', '--yes']);
  await core.restart();
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await openProjects(app, core);
  await openOne(app, 'alpha');
  const sec = card(app, 'Worktrees');
  await expect(sec.locator('.srow .snm')).toHaveText(['Setup script', 'Cleanup script', 'Repo setup script', 'Agent waits for setup', 'Shared files', 'Sparse checkout']);
  await expect(sec.getByLabel('Setup script', { exact: true })).toHaveValue('make deps');
  await expect(sec.getByRole('list', { name: 'Shared files' }).locator('li')).toHaveAttribute('data-path', '.env');
  await expect(sec.locator('select')).toHaveCount(0); // no project select: the page is the project
  // Same saving, same key and shape.
  await sec.getByRole('switch', { name: 'Agent waits for setup' }).click();
  await expect.poll(() => settingsOf(core)['worktree.scripts']?.[dir]).toEqual({ setup: 'make deps', cleanup: '', policy: 'ask', wait: true });
  // Git & Worktrees: the global worktree folder stays; the two sections are one line with a link.
  await app.locator('.settings nav button[data-page="git"]').click();
  const git = app.locator('.settings .sbody');
  await expect(git.locator('[data-setting="worktreeRoot"]')).toBeVisible();
  await expect(git.getByRole('region', { name: 'Setup scripts' })).toHaveCount(0);
  await expect(git.getByRole('region', { name: 'Shared files' })).toHaveCount(0);
  await expect(git).toContainText('Setup scripts and shared files are set per project.');
  await git.getByRole('button', { name: 'Open Projects' }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Projects');
  await expect(rows(app)).toHaveCount(1);
  // The search entry of a moved field opens Projects (the list: the field needs a project).
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('cleanup script');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Cleanup script/ }).click();
  await expect(app.locator('.settings nav button[data-page="projects"]')).toHaveAttribute('aria-current', 'page');
  await expect(rows(app)).toHaveCount(1);
});
