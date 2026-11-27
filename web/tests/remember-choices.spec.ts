// Choices a user makes again and again come back: the new-session popover's "New worktree" per project, and Search's
// Sessions/Files scope. Both survive a reload of the window.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const plus = (app: Page) => app.getByRole('button', { name: 'New session', exact: true });
const pop = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
const place = (app: Page, name: string) => pop(app).getByRole('radiogroup', { name: 'Where the session works' }).getByRole('radio', { name });

/** The popover, switched to project `name` through its search (as a user picks another project there). */
async function popFor(app: Page, name: string) {
  await plus(app).click();
  await pop(app).getByRole('combobox').fill(name);
  await expect(pop(app).getByRole('option').first()).toBeVisible();
  const row = pop(app).getByRole('option', { name: new RegExp(name) }).filter({ hasText: 'Project' });
  if (await row.count()) await row.click(); // no Project row: it is the popover's folder already
  else await pop(app).getByRole('combobox').fill('');
  await expect(pop(app)).toContainText(name);
}

function repo(core: Core, name: string) {
  const dir = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('new_worktree_choice_is_remembered_per_project: the next popover for that project opens on New worktree', async ({ app, core }) => {
  const alpha = repo(core, 'alpha');
  const beta = repo(core, 'beta');
  core.shell(beta, 'b');
  core.shell(alpha, 'a');
  await openWindow(app, {}, core);
  await popFor(app, 'alpha');
  await expect(place(app, 'Current folder')).toHaveAttribute('aria-checked', 'true');
  await place(app, 'New worktree').click();
  await pop(app).getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(pop(app)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { kind: string }[]).filter((s) => s.kind === 'claude').length).toBe(1);
  await popFor(app, 'alpha');
  await expect(place(app, 'New worktree')).toHaveAttribute('aria-checked', 'true');
  await app.keyboard.press('Escape');
  // Another project keeps its own choice.
  await popFor(app, 'beta');
  await expect(place(app, 'Current folder')).toHaveAttribute('aria-checked', 'true');
  await app.keyboard.press('Escape');
  // After a reload: still New worktree for alpha; picking Current folder there is remembered too.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await popFor(app, 'alpha');
  await expect(place(app, 'New worktree')).toHaveAttribute('aria-checked', 'true');
  await place(app, 'Current folder').click();
  await pop(app).getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(pop(app)).toHaveCount(0, { timeout: 15_000 });
  await popFor(app, 'alpha');
  await expect(place(app, 'Current folder')).toHaveAttribute('aria-checked', 'true');
});

test('search_scope_is_remembered: Search opens on the scope used last, also after a reload', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a');
  await openWindow(app, {}, core);
  const search = app.getByRole('button', { name: 'Search', exact: true });
  const panel = app.locator('.sbar .spanel');
  await search.click();
  await expect(panel.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'true');
  await panel.getByRole('radio', { name: 'Sessions' }).click();
  await search.click(); // closes the sidebar
  await expect(panel).toHaveCount(0);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await search.click();
  await expect(panel.getByRole('radio', { name: 'Sessions' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('searchbox')).toHaveAccessibleName('Search sessions');
});
