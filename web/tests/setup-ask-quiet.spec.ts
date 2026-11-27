// A repo setup script's approval never opens a sheet over the window at launch: an ask the user did not just cause (an
// older worktree, one made from the CLI or by an agent) waits in Decisions and opens the sheet on Review. Only the
// window's own create opens it by itself, at once. An ask whose worktree was removed goes with it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
function repo(core: Core) {
  const dir = core.project('demo');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'orca.yaml'), 'scripts:\n  setup: |\n    echo from-repo > ran.txt\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  core.shell(dir, 'alpha');
  return dir;
}
const create = (core: Core, dir: string, branch: string) => (core.cli('worktree', 'create', '--project', dir, '--branch', branch).worktrees as { branch: string; path: string }[]).find((w) => w.branch === branch)!.path;
const asks = (core: Core) => ((core.cli('snapshot', '--json').owner_decisions ?? []) as { owner?: { type: string } }[]).filter((d) => d.owner?.type === 'setup');
const sheet = (app: import('@playwright/test').Page) => app.getByRole('dialog', { name: /^Approve the setup script of / });

test('old_setup_ask_opens_no_sheet_at_launch_or_reload', async ({ app, core }) => {
  const dir = repo(core);
  create(core, dir, 'older');
  expect(asks(core)).toHaveLength(1);
  await openWindow(app);
  await app.waitForTimeout(1500);
  await expect(sheet(app)).toHaveCount(0);
  await app.reload();
  await app.waitForTimeout(1500);
  await expect(sheet(app)).toHaveCount(0);
});

test('old_setup_ask_is_listed_in_decisions_and_opens_sheet_on_review', async ({ app, core }) => {
  const dir = repo(core);
  const wt = create(core, dir, 'older');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  const card = app.locator('[data-widget-body="decisions"] [data-setup]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(`Approve the setup script of ${path.basename(wt)}`);
  await expect(sheet(app)).toHaveCount(0);
  await card.getByRole('button', { name: 'Review' }).click();
  await expect(sheet(app).locator('[data-field="script"]')).toHaveText('echo from-repo > ran.txt');
  await expect(sheet(app).locator('[data-field="path"]')).toHaveText(wt);
  await expect(sheet(app)).not.toContainText('busy');
  await sheet(app).getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet(app)).toHaveCount(0);
  await expect(card).toHaveCount(1); // Cancel leaves the ask waiting
});

test('setup_ask_of_removed_worktree_is_gone', async ({ app, core }) => {
  const dir = repo(core);
  const wt = create(core, dir, 'gone');
  expect(asks(core)).toHaveLength(1);
  core.cli('worktree', 'remove', '--path', wt);
  expect(asks(core)).toEqual([]);
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  await expect(app.locator('[data-widget-body="decisions"] [data-setup]')).toHaveCount(0);
  await expect(sheet(app)).toHaveCount(0);
});

test('window_own_create_still_opens_the_sheet', async ({ app, core }) => {
  repo(core);
  await openWindow(app);
  await app.locator('.grp[data-project="demo"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in demo', exact: true }).click();
  const dialog = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await dialog.getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' }).fill('fresh');
  await dialog.getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' }).press('Enter');
  await expect(sheet(app).locator('[data-field="script"]')).toHaveText('echo from-repo > ran.txt', { timeout: 10_000 });
});
