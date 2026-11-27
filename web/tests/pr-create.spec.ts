// The Diff header's Create PR, run by the app: Push & PR opens a form filled from the commits; the edited title and body
// reach gh as given (argv and stdin, read from a fake gh's log); the commits are pushed first to a local bare remote; the
// foot line names the new PR and the session's chip shows it. With gh signed out the form opens with the button off and
// a way to Settings › Git; the edited text survives closing the form. No network: origin's URL is GitHub's for gh only,
// and its pushes go to a bare repository (`pushInsteadOf`).
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();
const URL = 'https://github.com/develku/nunchiro.git';

/** A fake gh: `auth status` exits with `<home>/gh-auth`; `pr create` logs argv to gh-runs and stdin to gh-stdin, prints a link. */
function fakeGh(core: Core, auth = 0) {
  const h = core.home;
  fs.writeFileSync(path.join(h, 'gh-auth'), String(auth));
  fs.writeFileSync(
    path.join(h, 'bin/gh'),
    `#!/bin/sh\nif [ "$1 $2" = 'auth status' ]; then exit $(/bin/cat '${h}/gh-auth'); fi\nprintf '%s|' "$@" >> '${h}/gh-runs'\n/bin/cat > '${h}/gh-stdin'\necho https://github.com/develku/nunchiro/pull/58\n`,
    { mode: 0o700 },
  );
}

function setup(core: Core, n: number) {
  const origin = core.project('origin.git');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const project = core.project('demo');
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'lex.rs'), 'fn a() {}\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'remote', 'add', 'origin', URL);
  git(project, 'config', `url.${origin}.pushInsteadOf`, URL);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'remote', 'set-head', 'origin', 'main');
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  const w = (core.cli('worktree', 'create', '--project', project, '--branch', 'fix-lexer', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'fix-lexer')!;
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', w.path, '--label', 'calm').session as { id: string; cwd: string };
  for (let i = 0; i < n; i++) git(s.cwd, 'commit', '-q', '--allow-empty', '-m', `Fix lexer step ${i}`);
  return { origin, s };
}

const diffIcon = (page: Page) => page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `pr-create-${name}-${test.info().project.name}.png`) });

test('pr create: the form is filled from the commits; the edited text reaches gh unchanged after the push', async ({ app, core }) => {
  fakeGh(core);
  const { origin, s } = setup(core, 2);
  const head = git(s.cwd, 'rev-parse', 'HEAD');
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  await dock.getByRole('button', { name: 'Push & PR', exact: true }).click();
  const form = dock.getByRole('form', { name: 'Create PR' });
  const title = form.getByLabel('Title');
  await expect(title).toHaveValue('Fix lexer');
  await expect(form.getByLabel('Description')).toHaveValue('- Fix lexer step 0\n- Fix lexer step 1');
  await expect(form.getByLabel('Into')).toHaveValue('main');
  await expect(form).toContainText(`Pushes 2 commits to origin/fix-lexer first. Head commit: ${head.slice(0, 7)}.`);
  await shot(app, 'form');
  await app.emulateMedia({ colorScheme: 'dark' });
  await shot(app, 'form-dark');
  await app.emulateMedia({ colorScheme: 'light' });
  const body = 'Body with $(id) and `id`\n--admin';
  await title.fill('-x Fix the lexer `now`');
  await form.getByLabel('Description').fill(body);
  await form.getByRole('checkbox', { name: 'Draft' }).check();
  await form.getByRole('button', { name: 'Push & create PR' }).click();
  await expect(dock.getByRole('status').filter({ hasText: 'Pull request' })).toContainText('Pull request #58 created.');
  expect(fs.readFileSync(path.join(core.home, 'gh-runs'), 'utf8')).toBe('pr|create|--repo=develku/nunchiro|--head=fix-lexer|--base=main|--title=-x Fix the lexer `now`|--body-file=-|--draft|');
  expect(fs.readFileSync(path.join(core.home, 'gh-stdin'), 'utf8')).toBe(body);
  expect(git(origin, 'rev-parse', 'refs/heads/fix-lexer')).toBe(head);
  await shot(app, 'created');
});

test('pr create: gh signed out opens the form with the button off; edited text survives closing it', async ({ app, core }) => {
  fakeGh(core, 1);
  setup(core, 1);
  await openWindow(app);
  await diffIcon(app).click();
  const dock = app.getByRole('complementary', { name: 'Diff' });
  const button = dock.getByRole('button', { name: 'Push & PR', exact: true });
  await button.click();
  const form = dock.getByRole('form', { name: 'Create PR' });
  await expect(form.getByLabel('Title')).toHaveValue('Fix lexer step 0');
  await expect(form.getByRole('button', { name: 'Push & create PR' })).toHaveAttribute('aria-disabled', 'true');
  await expect(form).toContainText('Creating a pull request needs the GitHub CLI (gh), installed and signed in.');
  await expect(form.getByRole('button', { name: 'Open Settings › Git' })).toBeVisible();
  await form.getByLabel('Title').fill('My own title');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await button.click();
  await expect(form.getByLabel('Title')).toHaveValue('My own title');
  expect(fs.existsSync(path.join(core.home, 'gh-runs'))).toBe(false);
});
