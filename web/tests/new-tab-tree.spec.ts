// v25-new-tab (ticket 294 items 1 and 4, needs 213): the Cmd+N card closes on an outside click and on Esc after focus left
// it, always shows Cancel and stays while a start is in flight; an expanded project shows its idle and done sessions.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { shellFixture, working } from './design-shell.fixture';
import { openQuiet } from './tree-seed';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
function repoFor(core: Core, name: string) {
  const dir = core.project(name);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
const card = (app: Page) => app.getByRole('dialog', { name: 'New worktree', exact: true });

async function openCard(app: Page, core: Core) {
  const dir = repoFor(core, 'alpha');
  core.shell(dir, 'main-shell');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyN');
  await expect(card(app)).toBeVisible();
  return dir;
}

test('cmdn_card_closes_on_outside_click: a click outside the card closes it', async ({ app, core }) => {
  await openCard(app, core);
  await app.mouse.click(5, 450);
  await expect(card(app)).toHaveCount(0);
  expect(core.cli('worktree', 'list').worktrees).toHaveLength(0);
});

test('cmdn_card_closes_on_escape_after_focus_left: Esc closes the card although focus is no longer inside it', async ({ app, core }) => {
  await openCard(app, core);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await app.evaluate(() => document.activeElement?.closest('.wtnew') ?? null)).toBeNull();
  await app.keyboard.press('Escape');
  await expect(card(app)).toHaveCount(0);
});

test('cmdn_card_cancel_always_shown: Cancel is in the card before Advanced and Start agent are opened, and closes it', async ({ app, core }) => {
  await openCard(app, core);
  const cancel = card(app).getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(card(app)).toHaveCount(0);
});

test('cmdn_card_stays_during_flight: while a start is in flight neither an outside click nor Esc closes the card', async ({ app, core }) => {
  // The core's `start` answers 2.5 s late, so the flight is long enough to press on.
  await app.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string) {
      if (typeof data === 'string' && data.includes('"op":"start"')) setTimeout(() => send.call(this, data), 2500);
      else send.call(this, data);
    };
  });
  await openCard(app, core);
  await card(app).getByRole('textbox').fill('flight-one');
  await card(app).press('Alt+Enter');
  await card(app).getByRole('checkbox', { name: /Start/ }).check();
  await card(app).getByRole('button', { name: /Create/ }).click();
  await expect(card(app)).toHaveAttribute('aria-busy', 'true');
  await app.mouse.click(5, 450);
  await app.keyboard.press('Escape');
  await expect(card(app)).toBeVisible();
  // The flight ends and the card goes with it.
  await expect(card(app)).toHaveCount(0, { timeout: 20_000 });
});

test('expanded_project_shows_idle_and_done: an expanded project lists its idle sessions; the done ones are its hollow bars', async ({ app, core }) => {
  const { a } = shellFixture(core);
  const p = core.project('lumen');
  core.shell(p, 'finished-one', '/usr/bin/true');
  core.shell(p, 'finished-two', '/usr/bin/true');
  await openWindow(app);
  await working(core, a.id);
  const tree = app.locator('.tree');
  // The idle shell "notes" has a row of its own under the expanded project.
  await expect(tree.locator('.row.wt2', { hasText: 'notes' })).toBeVisible();
  // Ticket 1022: no "N done" fold; the two finished ones leave the tree (after a "just finished" row if the window saw
  // them end) and are counted by the head's hollow bars.
  await expect(tree.locator('.row.done:not(.wt2)')).toHaveCount(0);
  await expect(tree.locator('.row.wt2:not(.just)', { hasText: 'finished-' })).toHaveCount(0);
  await app.screenshot({ path: `../.scratch/shots-v25-new-tab/tree-idle-done-${test.info().project.name}.png` });
});

test('new_tab_basic_interactions_card_and_done_row: Esc and focus return on the card; the hollow bars open their popover with Enter and close it with Esc', async ({ app, core }) => {
  const dir = repoFor(core, 'alpha');
  core.shell(dir, 'main-shell');
  const fin = core.shell(dir, 'finished', '/usr/bin/true');
  // It ends before the window opens, so it is counted at once (no "just finished" row).
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === fin.id)?.state).toBe('exited');
  openQuiet(core);
  await openWindow(app);
  const trigger = app.getByRole('button', { name: 'New worktree in alpha', exact: true });
  await app.locator('.grp[data-project="alpha"] .row.head').hover();
  await trigger.press('Enter');
  await expect(card(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(card(app)).toHaveCount(0);
  await expect(trigger).toBeFocused(); // focus returns to the opener
  // Ticket 1022: the bars are a button with a name and an expanded state; Enter opens the popover, Esc closes it to them.
  const bars = app.locator('.grp[data-project="alpha"] .row.head > button.dbar');
  await expect(bars).toHaveAttribute('aria-expanded', 'false');
  await bars.focus();
  await app.keyboard.press('Enter');
  await expect(bars).toHaveAttribute('aria-expanded', 'true');
  const pop = app.getByRole('dialog', { name: /alpha · 1 finished/ });
  await expect(pop.locator('[data-done-item]')).toHaveCount(1);
  await expect(pop.locator('[data-done-item]').first()).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(bars).toBeFocused();
});
