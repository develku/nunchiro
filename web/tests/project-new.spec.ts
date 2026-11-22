// Ticket 370 item 8: "+ Project" > Create new, against the real core and real git. The test's git config is its core's
// $HOME/.gitconfig, so identity and signing are what each test says they are.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const IDENTITY = '[user]\n\tname = t\n\temail = t@example.invalid\n';
const gitconfig = (core: Core, text: string) => {
  fs.mkdirSync(core.env.HOME!, { recursive: true });
  fs.writeFileSync(path.join(core.env.HOME!, '.gitconfig'), text);
};
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const form = (app: Page) => app.getByRole('dialog', { name: 'New project' });
const pop = (app: Page) => app.getByRole('dialog', { name: 'New tab' });

async function openForm(app: Page) {
  await openWindow(app);
  await app.getByRole('button', { name: '+ Project' }).click();
  await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Create new/ }).click();
  return form(app);
}

test('project_new_makes_a_repository: live path, no Machine menu, dismissing the popover keeps a Git project that New worktree works on', async ({ app, core }) => {
  // Signing on: the commit must not wait for a passphrase or fail on a missing key.
  gitconfig(core, `${IDENTITY}[commit]\n\tgpgsign = true\n`);
  const d = await openForm(app);
  await expect(d.getByLabel('Machine')).toHaveCount(0);
  await expect(d).toContainText('Goes in ~/Projects');
  await expect(d.getByRole('button', { name: 'Create' })).toBeDisabled();
  await d.getByLabel('Name').fill('demo');
  await expect(d).toContainText('Creates ~/Projects/demo');
  await d.getByRole('button', { name: 'Create' }).click();

  const made = path.join(core.env.HOME!, 'Projects', 'demo');
  await expect(pop(app).locator('.nt-in')).toHaveAttribute('title', made, { timeout: 15_000 });
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);
  const head = app.locator(`.row.head[data-project-path="${made}"]`);
  await expect(head).toBeVisible();

  expect(fs.readdirSync(made)).toEqual(['.git']);
  expect(git(made, 'log', '--format=%s')).toBe('Initial commit');
  expect(git(made, 'status', '--porcelain')).toBe('');

  await head.hover();
  await head.getByRole('button', { name: 'New worktree in demo' }).click();
  const dialog = app.getByRole('dialog', { name: 'New worktree' });
  await dialog.getByRole('textbox').fill('first-tree');
  await app.keyboard.press('Enter');
  await expect.poll(() => git(made, 'branch', '--list', '--format=%(refname:short)')).toContain('first-tree');
});

test('project_new_location_changes: the live line follows Location, Create needs both fields, the folder lands there', async ({ app, core }) => {
  gitconfig(core, IDENTITY);
  const parent = path.join(core.home, 'elsewhere');
  const d = await openForm(app);
  await d.getByLabel('Name').fill('demo');
  await d.getByLabel('Location').fill('');
  await expect(d.getByRole('button', { name: 'Create' })).toBeDisabled();
  await d.getByLabel('Location').fill(`${parent}/`);
  await expect(d).toContainText(`Creates ${parent}/demo`);
  await d.getByRole('button', { name: 'Create' }).click();
  await expect(pop(app).locator('.nt-in')).toHaveAttribute('title', path.join(parent, 'demo'), { timeout: 15_000 });
  expect(fs.existsSync(path.join(parent, 'demo/.git'))).toBe(true);
  expect(fs.existsSync(path.join(core.env.HOME!, 'Projects/demo'))).toBe(false);
});

test('project_new_commit_failure_keeps_the_folder: no identity shows the warning, the folder stays, Continue opens New session', async ({ app, core }) => {
  gitconfig(core, '[user]\n\tuseConfigOnly = true\n');
  const d = await openForm(app);
  await d.getByLabel('Name').fill('noident');
  await d.getByRole('button', { name: 'Create' }).click();
  const made = path.join(core.env.HOME!, 'Projects', 'noident');
  await expect(d.getByRole('alert')).toContainText('without a first commit', { timeout: 15_000 });
  await expect(d.getByRole('alert')).toContainText('set user.name and user.email');
  expect(fs.existsSync(path.join(made, '.git'))).toBe(true);
  await expect(app.locator(`.row.head[data-project-path="${made}"]`)).toBeVisible();
  await d.getByRole('button', { name: 'Continue' }).click();
  await expect(pop(app).locator('.nt-in')).toHaveAttribute('title', made);
  expect(fs.existsSync(made)).toBe(true);
});

test('project_new_init_failure_says_no_repository: a failed git init never claims a missing commit, and the folder stays', async ({ app, core }) => {
  gitconfig(core, `${IDENTITY}[init]\n\tdefaultBranch = bad..name\n`); // real git refuses this branch name
  const d = await openForm(app);
  await d.getByLabel('Name').fill('noinit');
  await d.getByRole('button', { name: 'Create' }).click();
  const made = path.join(core.env.HOME!, 'Projects', 'noinit');
  await expect(d.getByRole('alert')).toContainText('could not make it a repository', { timeout: 15_000 });
  await expect(d.getByRole('alert')).not.toContainText('first commit');
  await expect(d).toContainText('bad..name'); // git's own line, under the translated one
  expect(fs.statSync(made).isDirectory()).toBe(true);
  await expect(app.locator(`.row.head[data-project-path="${made}"]`)).toBeVisible();
  await d.getByRole('button', { name: 'Continue' }).click();
  await expect(pop(app).locator('.nt-in')).toHaveAttribute('title', made);
});

test('project_new_refusals_are_translated: an existing folder is untouched, bad names and locations create nothing and read in the window language', async ({ app, core }) => {
  gitconfig(core, IDENTITY);
  const parent = path.join(core.home, 'parent');
  fs.mkdirSync(path.join(parent, 'taken'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'taken/keep'), 'mine');
  await openWindow(app); // waits for the English status line, so the language changes after it
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await app.getByRole('button', { name: '+ 프로젝트' }).click();
  await app.getByRole('dialog', { name: '프로젝트 추가' }).getByRole('button', { name: /^새로 만들기/ }).click();
  const d = app.getByRole('dialog', { name: '새 프로젝트' });
  await d.getByLabel('이름').fill('demo');
  await expect(d).toContainText('만듭니다: ~/Projects/demo');
  await app.screenshot({ path: `../.scratch/shots-v28-proj-new/create-${test.info().project.name}.png` });

  const submit = d.getByRole('button', { name: '만들기', exact: true });
  await d.getByLabel('이름').fill('taken');
  await d.getByLabel('위치').fill(parent);
  await submit.click();
  await expect(d.getByRole('alert')).toHaveText('같은 이름의 폴더가 이미 있습니다. 그 폴더는 건드리지 않았습니다.');
  expect(fs.readdirSync(path.join(parent, 'taken'))).toEqual(['keep']);
  expect(fs.readFileSync(path.join(parent, 'taken/keep'), 'utf8')).toBe('mine');

  await d.getByLabel('이름').fill('.hidden');
  await submit.click();
  await expect(d.getByRole('alert')).toHaveText('1~64자로 쓰고, 슬래시를 넣거나 점으로 시작할 수 없습니다.');
  expect(fs.existsSync(path.join(parent, '.hidden'))).toBe(false);

  await d.getByLabel('이름').fill('fine');
  for (const bad of ['relative/place', `${parent}/x/../y`]) {
    await d.getByLabel('위치').fill(bad);
    await submit.click();
    await expect(d.getByRole('alert')).toHaveText('위치는 / 또는 ~/로 시작해야 하고 ..를 넣을 수 없습니다.');
  }
  expect(fs.readdirSync(parent)).toEqual(['taken']);
});

test('project_new_location_follows_the_tree: the folder most projects sit in is offered, not ~/Projects', async ({ app, core }) => {
  const [a, b] = [core.project('one'), core.project('two')];
  seed(core, { op: 'add', project: a, added: true }, { op: 'add', project: b, added: true });
  const d = await openForm(app);
  await expect(d.getByLabel('Location')).toHaveValue(path.dirname(a));
});
