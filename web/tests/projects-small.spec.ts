// V2.5-15 (ticket 154, needs 139): the new-project wizard, a project's chosen icon and Open in editor.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Core, expect, openWindow, test } from './fixtures';
import { shellFixture, working } from './design-shell.fixture';

// One owner-socket request (the window's own path is the same op), answered as the raw reply line.
const ASK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, req] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: JSON.parse(req) }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
const ask = (core: Core, request: object) => JSON.parse(execFileSync(process.execPath, ['-e', ASK, core.home, JSON.stringify(request)], { encoding: 'utf8', timeout: 10_000 }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');


const head = (app: import('@playwright/test').Page, name: string) => app.locator('.tree .row.head').filter({ hasText: name });

test('projects_wizard_reachable: + Project, a name, Create makes the folder and opens the New tab popover on it', async ({ app, core }) => {
  const lumen = core.project('lumen');
  core.shell(lumen, 'notes');
  await openWindow(app);
  // The labelled control, the chooser's Create new, then Create.
  const openForm = async () => {
    await app.getByRole('button', { name: '+ Project' }).click();
    await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Create new/ }).click();
  };
  await openForm();
  const wizard = app.getByRole('dialog', { name: 'New project' });
  await wizard.getByLabel('Name').fill('fresh-one');
  await wizard.getByRole('button', { name: 'Create' }).click();
  const folder = path.join(path.dirname(lumen), 'fresh-one'); // the location starts beside the tree's projects
  // Create is asynchronous: New session opens on the folder only after the core made it, so wait for that, then stat.
  await expect(app.getByRole('dialog', { name: 'New tab' }).locator('.nt-in')).toHaveAttribute('title', folder); // v25-new-tab: the popover names its folder (needs 209)
  expect(fs.statSync(folder).isDirectory()).toBe(true);
  // A taken name is refused and says so, leaving the wizard open.
  await app.keyboard.press('Escape');
  await openForm();
  await app.getByRole('dialog', { name: 'New project' }).getByLabel('Name').fill('fresh-one');
  await app.getByRole('dialog', { name: 'New project' }).getByRole('button', { name: 'Create' }).click();
  await expect(app.getByRole('dialog', { name: 'New project' }).getByRole('alert')).toContainText('already exists');
});

test('open_in_editor_reachable: the project row\'s Open in editor hands its folder to the editor command', async ({ app, core }) => {
  shellFixture(core);
  const project = core.project('lumen');
  await openWindow(app);
  // Click 1 is the hover that shows the row's buttons, click 2 the labelled control.
  await head(app, 'lumen').hover();
  await head(app, 'lumen').getByRole('button', { name: 'Open in editor' }).click();
  await expect.poll(() => core.opened()).toBe(`open\n-t\n${project}\n`); // ticket 800: recorded, not started
});

test('open_in_editor_worktree_and_line: a managed worktree folder opens, in the editor Settings chose, at the line (ticket 375)', async ({ core }) => {
  const project = core.project('lumen');
  core.shell(project, 'notes');
  // The fixture's worktrees_dir is <home>/wt: a worktree under <home>/wt/lumen lies outside every project and opens;
  // the root itself is wider than any project's worktrees and does not.
  const wt = path.join(core.home, 'wt', 'lumen', 'a');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src', 'a b.rs'), 'x\n');
  const real = fs.realpathSync(wt);
  expect(ask(core, { op: 'open_in_editor', path: wt }).Ok).toBeTruthy();
  expect(core.opened()).toBe(`open\n-t\n${real}\n`);
  expect(ask(core, { op: 'quit_settings', patch: { features: { 'editor.app': 'Cursor' } } }).Ok).toBeTruthy();
  expect(ask(core, { op: 'open_in_editor', path: path.join(wt, 'src', 'a b.rs'), line: 7 }).Ok).toBeTruthy();
  expect(core.opened()).toBe(`open\n-t\n${real}\nopen\ncursor://file${real.replaceAll(' ', '%20')}/src/a%20b.rs:7\n`);
  // An option-like name is never handed to `open -a`: the default editor is used.
  expect(ask(core, { op: 'quit_settings', patch: { features: { 'editor.app': '-n' } } }).Ok).toBeTruthy();
  expect(ask(core, { op: 'open_in_editor', path: wt }).Ok).toBeTruthy();
  expect(core.opened().endsWith(`open\n-t\n${real}\n`)).toBe(true);
  fs.mkdirSync(path.join(core.home, 'wt', 'other'));
  expect(ask(core, { op: 'open_in_editor', path: path.join(core.home, 'wt', 'other') }).Err).toMatch(/outside every project/);
});

test('open_in_editor_rejects_outside_root: a path outside every known project, by dots or by link, starts nothing', async ({ core }) => {
  const project = core.project('lumen');
  core.shell(project, 'notes');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-out-'));
  fs.symlinkSync(other, path.join(project, 'link'));
  try {
    for (const bad of [other, path.join(project, '..', path.basename(other)), path.join(project, 'link'), path.join(project, 'missing'), '/']) {
      expect(ask(core, { op: 'open_in_editor', path: bad }).Err, bad).toMatch(/outside every project|no such path/);
    }
    // Codex look 11-20: a link at <worktrees_dir>/<project name> is no worktree folder, so its target is no root.
    fs.mkdirSync(path.join(core.home, 'wt'), { recursive: true });
    fs.symlinkSync(other, path.join(core.home, 'wt', 'lumen'));
    fs.writeFileSync(path.join(other, 'config'), 'x\n');
    expect(ask(core, { op: 'open_in_editor', path: path.join(core.home, 'wt', 'lumen', 'config') }).Err).toMatch(/outside every project|no such path/);
    expect(core.opened()).toBe('');
    expect(ask(core, { op: 'open_in_editor', path: project }).Ok).toBeTruthy();
    expect(core.opened()).toBe(`open\n-t\n${project}\n`); // ticket 800: recorded before the reply
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('project_icon_reachable: Set icon on the row takes a chosen image and draws it before the name', async ({ app, core }) => {
  const { a } = shellFixture(core);
  await openWindow(app);
  await working(core, a.id);
  await expect(head(app, 'lumen').locator('img.pico')).toHaveCount(0);
  await head(app, 'lumen').hover();
  // Click 1 opens the file chooser; the chosen file is the second step.
  const chooser = app.waitForEvent('filechooser');
  await head(app, 'lumen').getByRole('button', { name: 'Set icon' }).click();
  await (await chooser).setFiles({ name: 'icon.png', mimeType: 'image/png', buffer: PNG });
  await expect(head(app, 'lumen').locator('img.pico')).toHaveAttribute('src', /^data:image\/png;base64,/);
  // A text file is refused with the page's alert and the icon stays.
  await head(app, 'lumen').hover();
  const again = app.waitForEvent('filechooser');
  await head(app, 'lumen').getByRole('button', { name: 'Set icon' }).click();
  await (await again).setFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(app.getByRole('alert').filter({ hasText: 'PNG, JPEG or SVG' })).toBeVisible();
  await expect(head(app, 'lumen').locator('img.pico')).toHaveCount(1);
});

test('project_icon_rejects_bad_type: the core takes PNG, JPEG and SVG up to 256 KiB and nothing else', async ({ core }) => {
  const project = core.project('lumen');
  core.shell(project, 'notes');
  const set = (bytes: Buffer, p = project) => ask(core, { op: 'project_icon_set', project: p, data_b64: bytes.toString('base64') });
  for (const bad of [Buffer.from('GIF89a.....'), Buffer.from('<html><script>1</script>'), Buffer.from('plain'), Buffer.alloc(0)]) expect(set(bad).Err, bad.toString()).toMatch(/PNG, JPEG or SVG|base64/);
  expect(set(PNG, '/not/a/project').Err).toBe('unknown project');
  expect(set(Buffer.concat([PNG, Buffer.alloc(256 * 1024)])).Err).toBe('icon is over 256 KiB');
  expect(set(PNG).Ok).toBeTruthy();
  const got = ask(core, { op: 'project_icon_get', project }).Ok.ProjectIcon ?? ask(core, { op: 'project_icon_get', project }).Ok;
  expect(got.mime).toBe('image/png');
  expect(Buffer.from(got.data_b64, 'base64').equals(PNG)).toBe(true);
});
