// Permission sheet (ticket v1b-14, R8-final frame 5) against a real core and the fixture widget.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, expect, test, type Core } from './fixtures';
import { BASE, buildSheetHarness, widget } from './sheet-harness-build';

test.beforeAll(buildSheetHarness);

const grants = (core: Core): { name: string; level: string; hash: string }[] =>
  JSON.parse(fs.readFileSync(path.join(core.home, 'approvals.json'), 'utf8')).approvals;

async function openSheet(app: Page, core: Core, name: string) {
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await app.goto(`${BASE}tests/sheet-harness.html?name=${name}`);
  await expect(app.getByRole('dialog', { name: `Allow “${name}”?` })).toBeVisible();
  await expect(app.locator('[data-field="command"]')).toBeVisible();
}

test('shows every field of the fixture manifest', async ({ app, core }, info) => {
  const dir = widget(core, 'open-prs');
  await openSheet(app, core, 'open-prs');
  const sheet = app.getByRole('dialog');
  await expect(sheet.locator('[data-field="author"]')).toHaveText('owner');
  await expect(sheet).toContainText('script');
  await expect(sheet.locator('[data-field="command"]')).toHaveText('sh open-prs.sh --state open');
  await expect(sheet).toContainText('every 60 s');
  // v1b-21 r2 (ruling 09:48 Q3): memory has no limit of its own.
  await expect(sheet.locator('[data-field="runtime-limit"]')).toContainText(
    'A run stops after 5 seconds. A run can start at most 64 processes. Memory has no limit of its own; these two limits are the only ones.',
  );
  await expect(sheet).toContainText('Read');
  await expect(sheet).toContainText('Never');
  await expect(sheet).toContainText('Answer pending decisions');
  await expect(sheet.locator('[data-field="network"]')).toHaveText(/api\.github\.com · github\.com/);
  await expect(sheet.locator('[data-field="cli"]')).toHaveText('= nunchiro widget allow open-prs --read');
  await expect(sheet.getByRole('switch', { name: 'Allow act' })).toBeEnabled();
  // The viewer shows the manifest file byte for byte.
  await sheet.getByRole('button', { name: 'View widget.toml' }).click();
  expect(await sheet.locator('[data-field="manifest"]').textContent()).toBe(fs.readFileSync(path.join(dir, 'widget.toml'), 'utf8'));
  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/permission-sheet-${info.project.name}.png`) });
  await sheet.getByRole('button', { name: 'Hide widget.toml' }).click();
  await sheet.getByRole('switch', { name: 'Allow act' }).click();
  await expect(sheet.locator('[data-field="cli"]')).toHaveText('= nunchiro widget allow open-prs --act');
  await expect(sheet.getByRole('button', { name: 'Allow read and act' })).toBeVisible();
});

test('the command is shown exactly as it will run, quoted where a shell would', async ({ app, core }) => {
  // v1b-21 r3: `sh -c` is refused (inline script); a quoted argument to a folder script keeps the quoting check.
  widget(core, 'odd', (m) => m.replace(/command = .*/, `command = ["sh", "w.sh", "echo 'hi there'; ls"]`));
  await openSheet(app, core, 'odd');
  await expect(app.locator('[data-field="command"]')).toHaveText(`sh w.sh 'echo '\\''hi there'\\''; ls'`);
});

test('a missing author reads unknown; a widget with no network says so; act is off when not requested', async ({ app, core }) => {
  widget(core, 'plain', (m) => m.replace('author = "owner"\n', '').replace(/network = .*\n?/, '').replace('["read", "act"]', '["read"]'));
  await openSheet(app, core, 'plain');
  await expect(app.locator('[data-field="author"]')).toHaveText('unknown');
  await expect(app.locator('[data-field="network"]')).toHaveText('No network · all hosts blocked');
  await expect(app.getByRole('switch', { name: 'Allow act' })).toBeDisabled();
});

test('approving from the sheet and from the CLI store the same grant', async ({ app, core }) => {
  widget(core, 'via-sheet');
  widget(core, 'via-cli');
  await openSheet(app, core, 'via-sheet');
  await app.getByRole('button', { name: 'Allow read only' }).click();
  await expect(app.getByRole('status')).toHaveText('granted read');
  const out = core.run(['widget', 'allow', 'via-cli', '--read']);
  expect(out).toContain('sh open-prs.sh --state open');
  const [a, b] = ['via-sheet', 'via-cli'].map((n) => grants(core).find((g) => g.name === n)!);
  expect({ level: a.level, hash: a.hash }).toEqual({ level: b.level, hash: b.hash });
  expect(a.level).toBe('read');
});

test('act is granted only after the switch is turned on', async ({ app, core }) => {
  widget(core, 'acts');
  await openSheet(app, core, 'acts');
  await app.getByRole('switch', { name: 'Allow act' }).click();
  await app.getByRole('button', { name: 'Allow read and act' }).click();
  await expect(app.getByRole('status')).toHaveText('granted act');
  expect(grants(core)[0].level).toBe('act');
});

test('a file changed after the sheet opened is refused, not approved', async ({ app, core }) => {
  const dir = widget(core, 'racy');
  await openSheet(app, core, 'racy');
  fs.writeFileSync(path.join(dir, 'open-prs.sh'), '#!/bin/sh\necho swapped\n');
  await app.getByRole('button', { name: 'Allow read only' }).click();
  await expect(app.getByRole('alert')).toContainText('changed since it was shown');
  expect(fs.existsSync(path.join(core.home, 'approvals.json'))).toBe(false);
});

test('a changed widget says so', async ({ app, core }) => {
  const dir = widget(core, 'edited');
  core.run(['widget', 'allow', 'edited', '--read']);
  fs.appendFileSync(path.join(dir, 'open-prs.sh'), '# tweak\n');
  await openSheet(app, core, 'edited');
  await expect(app.getByRole('status').filter({ hasText: 'Changed since you allowed it' })).toBeVisible();
});

test('Cancel and Esc close without storing; focus starts on Cancel', async ({ app, core }) => {
  widget(core, 'open-prs');
  await openSheet(app, core, 'open-prs');
  await expect(app.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('status')).toHaveText('closed');
  expect(fs.existsSync(path.join(core.home, 'approvals.json'))).toBe(false);
});

test('an unknown widget shows the core error and cannot be approved', async ({ app, core }) => {
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await app.goto(`${BASE}tests/sheet-harness.html?name=missing`);
  await expect(app.getByRole('alert')).toContainText('missing');
  await expect(app.getByRole('button', { name: 'Allow read only' })).toBeDisabled();
});

test('command runtime child-spawn restriction is visible before approval', async ({ app, core }, info) => {
  widget(core, 'runtime-limit');
  await openSheet(app, core, 'runtime-limit');
  await expect(app.getByRole('dialog')).toContainText('Commands whose runtime spawns children with posix_spawn fail closed.');
  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/permission-runtime-${info.project.name}.png`) });
});

// v1b-33 (needs 45): the files a widget may read beyond its project, and a red warning when that is the whole home.
test('permission_sheet_shows_read_list_and_home_warning', async ({ app, core }, info) => {
  widget(core, 'default-read');
  widget(core, 'some-read', (m) => `${m}read = ["~/other", "/opt/data"]\n`);
  widget(core, 'home-read', (m) => `${m}read = ["~", "~/other"]\n`);
  await openSheet(app, core, 'default-read');
  const files = app.getByRole('group', { name: 'Files' });
  await expect(files).toHaveText(
    'Its project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin · nothing else in your home',
  );
  await expect(app.locator('[data-field="read-warning"]')).toHaveCount(0);

  await openSheet(app, core, 'some-read');
  await expect(files).toContainText('Its project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin');
  await expect(files.locator('li')).toHaveText(['~/other', '/opt/data']);
  await expect(app.locator('[data-field="read-warning"]')).toHaveCount(0);

  await openSheet(app, core, 'home-read');
  await expect(files.locator('li')).toHaveText(['~', '~/other']);
  const warning = files.getByRole('note');
  await expect(warning).toHaveText(
    'Reads your whole home folder: documents, other projects and app data. Agent config and keys stay blocked.',
  );
  await expect(warning).toHaveCSS('color', 'rgb(201, 42, 42)'); // red (#c92a2a), light theme
  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/permission-read-home-${info.project.name}.png`) });
});

// v1b-34 (needs 52, WCDN = A): a web widget naming a script CDN host cannot get act, and the sheet says why.
test('a web widget naming a CDN script host shows why act is refused', async ({ app, core }, info) => {
  const dir = path.join(core.home, 'widgets', 'cdn');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), 'version = 1\nkind = "web"\nentry = "index.html"\npermissions = ["read", "act"]\nnetwork = ["cdn.jsdelivr.net"]\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>w</p>');
  // Allowed read first: asking for act opens the sheet again, with the refusal.
  core.run(['widget', 'allow', 'cdn', '--read']);
  await openSheet(app, core, 'cdn');
  const sheet = app.getByRole('dialog');
  await expect(sheet.locator('[data-field="act-refused"]')).toHaveText(
    'act refused: a web widget that can act loads scripts only from its own folder, and cdn.jsdelivr.net serves code outside the approval; copy the library into the entry file, or allow read only',
  );
  await expect(sheet.getByRole('switch', { name: 'Allow act' })).toBeDisabled();
  // review N2: a screen reader hears why the switch is off.
  await expect(sheet.getByRole('switch', { name: 'Allow act' })).toHaveAccessibleDescription(/^act refused: /);
  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/v1b-34-sheet-${info.project.name}.png`) });
  await sheet.getByRole('button', { name: 'Allow read only' }).click();
  await expect(app.getByRole('status')).toHaveText('granted read');
  expect(grants(core)[0].level).toBe('read');
});
