// Ticket 259 (G21), ticket 1040: Settings › Projects › a project › Worktrees (features/setup-scripts.tsx) saves to the core's
// `worktree.scripts`, and a repo's orca.yaml setup script waits in the strip until the setup sheet approves its exact text.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, stripOnTop, test, type Core } from './fixtures';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const stored = (core: Core) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['worktree.scripts'];
  } catch {
    return undefined;
  }
};
function repo(core: Core, files: Record<string, string> = {}) {
  const dir = core.project('demo');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('setup_scripts_rows_on_project_page_and_searchable', async ({ app, core }) => {
  const dir = repo(core);
  core.shell(dir, 'alpha');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  // Ticket 1040: the settings search finds the rows and opens Projects (the list: the field needs a project); the
  // project's own page holds them, with no project select.
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('cleanup script');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Cleanup script/ }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText('Projects');
  await app.waitForTimeout(3100); // a search hit keeps looking for its field for 3 s (SettingsView `want`) and would take the focus from the typing below
  await app.locator('.pj-row[data-project="' + dir + '"] .pj-open').click();
  const sec = app.locator('.sbody').getByRole('region', { name: 'Worktrees' });
  await expect(sec.locator('.srow .snm')).toHaveText(['Setup script', 'Cleanup script', 'Repo setup script', 'Agent waits for setup', 'Shared files', 'Sparse checkout']);
  // Each value saves to the core's map for this project.
  await sec.getByLabel('Setup script', { exact: true }).fill('pnpm install');
  await sec.getByLabel('Cleanup script', { exact: true }).click(); // the box saves when it loses focus
  await expect.poll(() => stored(core)?.[dir]?.setup).toBe('pnpm install');
  await sec.getByRole('radio', { name: 'Run when approved' }).click(); // checked once the core took it
  await expect.poll(() => stored(core)?.[dir]?.policy).toBe('run_when_approved');
  await sec.getByRole('switch', { name: 'Agent waits for setup' }).click();
  await expect.poll(() => stored(core)?.[dir]?.wait).toBe(true);
  // Back to the defaults: the project's entry goes away.
  for (const label of ['Setup script', 'Repo setup script', 'Agent waits for setup']) await sec.getByRole('button', { name: new RegExp(`Reset ${label}`) }).click();
  await expect.poll(() => stored(core)).toBeUndefined();
});

test('setup_approval_sheet_shows_script_text_and_hash', async ({ app, core }) => {
  const dir = repo(core, { 'orca.yaml': 'scripts:\n  setup: |\n    echo from-repo > ran.txt\n' });
  core.shell(dir, 'alpha');
  stripOnTop(core); // the strip is where an owner item waits
  await openWindow(app);
  const made = core.cli('worktree', 'create', '--project', dir, '--branch', 'feature');
  const wt = (made.worktrees as { branch: string; path: string }[]).find((w) => w.branch === 'feature')!.path;
  const item = app.locator('#waiting-strip .qcard[data-kind="owner"]').filter({ hasText: 'approve the setup script of worktree' });
  await expect(item).toBeVisible({ timeout: 10_000 });
  expect(fs.existsSync(path.join(wt, 'ran.txt'))).toBe(false);
  const hash = (core.cli('snapshot', '--json').owner_decisions[0].owner.hash as string).slice(0, 12);
  // Real-app look 11-15: the sheet opens by itself for a worktree no session made (the default layout has no strip).
  const sheet = app.getByRole('dialog', { name: /^Approve the setup script of / });
  await expect(sheet.locator('[data-field="script"]')).toHaveText('echo from-repo > ran.txt');
  await expect(sheet.locator('[data-field="hash"]')).toHaveText(`hash ${hash}`);
  await expect(sheet.locator('[data-field="path"]')).toHaveText(wt);
  await expect(sheet).toContainText("Setup script from the repo's orca.yaml");
  await sheet.getByRole('button', { name: 'Approve and run' }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => fs.existsSync(path.join(wt, 'ran.txt'))).toBe(true);
  // The script ran in a visible setup tab of the worktree.
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { label: string; cwd: string }[]).some((s) => s.label === 'setup' && s.cwd === wt)).toBe(true);
  await expect.poll(() => core.cli('snapshot', '--json').owner_decisions ?? []).toEqual([]);
  const approvals = JSON.parse(fs.readFileSync(path.join(core.home, 'approvals.json'), 'utf8')).approvals as { kind?: string; hash: string }[];
  expect(approvals.find((a) => a.kind === 'setup')?.hash.slice(0, 12)).toBe(hash);
});
