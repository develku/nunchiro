// Ticket 259 (real-app look 11-15): a repo setup script asks in the default layout, which has no strip, and Approve runs it.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from './fixtures';
import { repo, show } from './visual/compare';
import { openQuiet } from './tree-seed';

test('repo_setup_script_asks_in_the_default_layout_and_runs_on_approve', async ({ app, core }) => {
  const project = repo(core, 'nunchiro');
  fs.writeFileSync(path.join(project, 'orca.yaml'), 'scripts:\n  setup: echo ran > setup-ran.txt\n');
  execFileSync('git', ['-C', project, 'add', 'orca.yaml']);
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'setup script']);
  core.shell(project, 'main');
  openQuiet(core);
  await show(app, 'light');
  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  const name = app.getByRole('dialog', { name: 'New worktree', exact: true }).getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' });
  await name.fill('with setup');
  await name.press('Enter');
  const sheet = app.getByRole('dialog').filter({ hasText: "Setup script from the repo's orca.yaml" });
  await expect(sheet).toContainText('echo ran > setup-ran.txt');
  const made = () => (core.cli('worktree', 'list').worktrees as { path: string; branch: string }[]).find((w) => w.branch.includes('with-setup'));
  expect(fs.existsSync(path.join(made()!.path, 'setup-ran.txt'))).toBe(false); // nothing ran before the approval
  await sheet.getByRole('button', { name: 'Approve and run', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => fs.existsSync(path.join(made()!.path, 'setup-ran.txt'))).toBe(true);
});
