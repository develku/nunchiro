// Ticket 557 (scorecard first use F3): walk the whole command registry (chrome/commands.ts). Every id has a name in all
// 8 languages (a non-English window never shows the English title), the palette finds it by that name, and running it
// raises no page error. The registry is read from the palette of a seeded window, so a command added later is walked too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const LANGS = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const;
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });

/** Ids that never reach the palette of a test window, each with the reason. */
const ABSENT: Record<string, string> = {
  'rc.update.check': 'only an RC build lists it (rcUpdates() is false in the test build)',
};
/** Commands a palette row cannot run: they act on the right-clicked item (data-menu-arg), so the palette leaves them out
 *  (ticket 991 A10; it greyed them before). */
const NEEDS_MENU_ARG = /^(icon\.(hide|move|split)|board\.card\.\w+|path\.(copy|reveal)|message\.copy|file\.mention)$/;
/** Greyed in the walk window with the context they need; another spec drives each of them where the context exists. */
const GREYED: Record<string, string> = {
  'decision.back': 'needs a decision jump first (decisions spec)',
  'layout.done': 'needs layout edit mode; the walk runs layout.edit first',
  'layout.cancel': 'needs layout edit mode; the walk runs layout.edit first',
  'tab.reopen': 'needs a closed tab; the walk closes one first',
  'pane.maximize': 'needs the side pane open; the walk opens it first',
  'handoff.claude': 'the seeded session is Claude, and a session is not handed to its own agent',
  'group.remove': 'acts on a project in a group (tree row menu); no group in the walk window',
  'group.rename': 'acts on a group (tree row menu); no group in the walk window',
  'group.dissolve': 'acts on a group (tree row menu); no group in the walk window',
  'pane.shell.new': 'needs a session in the side pane (paneSession); the walk window has none open',
  'group.move': 'acts on a project (tree row menu); none is shown in the walk window',
  'project.rename': 'acts on a project (tree row menu); none is shown in the walk window',
  'session.settle': 'needs a settleable (done) session; the walk window has none',
  'worktree.open': 'acts on a worktree row (tree row menu); the walk window has none',
  'worktree.copy-path': 'acts on a worktree row (tree row menu); the walk window has none',
  'worktree.reveal': 'acts on a worktree row (tree row menu); the walk window has none',
  'worktree.rename': 'acts on a worktree row (tree row menu); the walk window has none',
  'worktree.remove': 'acts on a worktree row (tree row menu); the walk window has none',
  // f04cc01e6 (eighth look A): off with "The browser is not open" while no browser tab strip is on screen.
  'browser.tab.next': 'needs the browser tab strip; the walk window has no browser open',
  'browser.tab.prev': 'needs the browser tab strip; the walk window has no browser open',
  'browser.tab.close': 'needs the browser tab strip; the walk window has no browser open',
  'browser.tab.new': 'needs the browser tab strip; the walk window has no browser open',
  // ba9f4e484 (look 1117 v12 A S3-B): off with "No split is open" while the focused session has no split.
  'split.close': 'needs an open split; the walk window has none (split specs drive it)',
  // 376eefe9c (ticket 1069): off until a second session tab was shown before the focused one (lastTab.before).
  'tab.split.right': 'needs the tab shown before the focused one; the walk window reloads onto the agent (tab-drag-split spec drives it)',
  'tab.split.down': 'needs the tab shown before the focused one; the walk window reloads onto the agent (tab-drag-split spec drives it)',
};
const seed = (core: import('./fixtures').Core) => {
  const p = core.project('demo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  core.shell(p, 'one');
  core.shell(p, 'two');
  return core.agent(p, 'agent', 'x').id; // a running Claude session: handoff, side chat, preview and the side pane need one
};
const openPalette = async (app: Page) => {
  await app.keyboard.press('ControlOrMeta+k');
  const box = app.locator('.palette input[role="combobox"]');
  await expect(app.locator('#palette-list')).toBeVisible();
  return box;
};
const rows = (app: Page) =>
  app.locator('#palette-list [data-command]:not([data-command^="session.open."])').evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('data-command')!, label: e.querySelector('span')!.textContent!, off: e.getAttribute('aria-disabled') === 'true' })));
const focusAgent = async (app: Page, id: string) => {
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
};

const sources = fs.readFileSync(path.resolve(import.meta.dirname, '../src/chrome/commands.ts'), 'utf8');
/** Every id the file names as a literal; the families (pane.focus.<dir>, session.jump.<n>, settings.<page>.<key>) are in the palette's list. */
const literal = [...sources.matchAll(/\bid: '([\w.-]+)'/g)].map((m) => m[1]!).filter((id) => !(id in ABSENT) && !NEEDS_MENU_ARG.test(id));

const listIn = async (app: Page, l: string, id: string) => {
  await app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), l);
  await app.reload();
  await expect(app.locator('.tab[data-tab]:not([data-tab="settings"])').first()).toBeVisible();
  await focusAgent(app, id);
  const box = await openPalette(app);
  return { box, list: await rows(app) };
};

for (const l of LANGS) {
  test(`command_walk_557 labels: ${l} names every command and the palette finds it`, async ({ app, core }) => {
    const agent = seed(core);
    await openWindow(app, {}, core);
    const { box, list } = await listIn(app, l, agent);
    expect(list.length, 'the registry is listed').toBeGreaterThan(130);
    expect(list.map((r) => r.id), 'every id commands.ts names is in the palette').toEqual(expect.arrayContaining(literal));
    for (const r of list) {
      await box.fill(r.label);
      await expect(app.locator(`#palette-list [data-command="${r.id}"]`), `${l}: ${r.id} is found by "${r.label}"`).toHaveCount(1);
    }
  });
}

/** Commands that end or close sessions and tabs: each runs in a window of its own, as the next command needs the tabs. */
const SPENDS = ['session.stop', 'session.restart', 'session.close', 'tab.close', 'tab.close.others', 'tab.close.right', 'tab.close.all', 'tab.reopen', 'handoff.claude', 'handoff.codex', 'quit.all'];
const errors = (app: Page) => {
  const seen: string[] = [];
  app.on('pageerror', (e) => seen.push(e.message));
  return seen;
};
/** Runs a command from the palette by its English name; returns false when the palette shows it greyed. */
const run = async (app: Page, label: string, id: string, wait = false) => {
  const box = await openPalette(app);
  await box.fill(label);
  const row = app.locator(`#palette-list [data-command="${id}"]`);
  await expect(row, `${id} is listed for "${label}"`).toHaveCount(1);
  if (wait) await expect(row).not.toHaveAttribute('aria-disabled', 'true').catch(() => {}); // a stop takes a moment to reach the list
  if ((await row.getAttribute('aria-disabled')) === 'true') {
    await app.keyboard.press('Escape');
    return false;
  }
  await row.click();
  await app.waitForTimeout(150); // run() defers the command one tick after the palette closes
  return true;
};
/** Stop and Close ask first when an agent runs; the walk answers yes so the command runs to its end. */
const confirm = async (app: Page) => {
  const ask = app.locator('[role="alertdialog"] .btn.p');
  if (await ask.isVisible()) await ask.click();
  await app.waitForTimeout(300);
};

test('command_walk_557 run: every command runs without a page error', async ({ app, core }) => {
  test.setTimeout(480_000);
  const agent = seed(core);
  const seen = errors(app);
  await openWindow(app, {}, core);
  await focusAgent(app, agent);
  await openPalette(app);
  const all = await rows(app);
  const greyed: string[] = [];
  const walk = all.filter((r) => !SPENDS.includes(r.id));
  for (const r of walk.filter((r) => !r.id.startsWith('settings.'))) {
    // A reload keeps an open modal (chrome/Overlay.tsx). An Escape that came before a command's Board finished opening left it
    // over every later tab click (ticket 730: 2 of 5 runs), so each step starts with none.
    await app.evaluate(() => sessionStorage.removeItem('nunchiro.overlay'));
    await app.reload();
    await expect(app.locator(`.tab[data-tab="${agent}"]`)).toBeVisible();
    await focusAgent(app, agent);
    if (r.id === 'layout.done' || r.id === 'layout.cancel') await run(app, 'Edit layout', 'layout.edit');
    if (r.id === 'pane.maximize') await run(app, 'Show or hide the side pane', 'pane.toggle');
    // Right after a reload a project command is greyed for a moment (no project known yet: group.create was red in 1 run of 2),
    // so a command not listed as greyed gets the poll `wait` gives before it counts as greyed.
    if (!(await run(app, r.label, r.id, !(r.id in GREYED) && !NEEDS_MENU_ARG.test(r.id)))) greyed.push(r.id);
    await app.keyboard.press('Escape');
  }
  // The settings commands open a page of Settings, focused on one field.
  await app.reload();
  await focusAgent(app, agent);
  for (const r of walk.filter((r) => r.id.startsWith('settings.'))) {
    expect(await run(app, r.label, r.id), r.id).toBe(true);
    await app.keyboard.press('Escape');
  }
  expect(seen, 'page errors while running the commands').toEqual([]);
  expect(greyed.filter((id) => !NEEDS_MENU_ARG.test(id) && !(id in GREYED)), 'greyed commands with no reason listed').toEqual([]);
});

for (const id of SPENDS) {
  test(`command_walk_557 run: ${id} runs without a page error`, async ({ app, core }) => {
    const agent = seed(core);
    const seen = errors(app);
    await openWindow(app, {}, core);
    await focusAgent(app, agent);
    await openPalette(app);
    const row = (await rows(app)).find((r) => r.id === id)!;
    expect(row, `${id} is in the palette`).toBeTruthy();
    if (id === 'tab.reopen') (await run(app, 'Close tab', 'tab.close'), await confirm(app)); // the command is greyed until a tab was closed
    if (id === 'session.restart' || id === 'session.close') {
      // Both act on an ended session: a shell that quits on its own is `exited` (a stopped agent is `closed`, which neither takes).
      const ended = core.shell(core.project('demo'), 'ended', '/bin/sh').id;
      await focusAgent(app, ended);
      // The shell can end on its own before this send (quickcheck 11-21): "session has exited" is the state wanted.
      try { core.cli('session', 'send-text', ended, 'exit\r'); } catch (e) { if (!String(e).includes('session has exited')) throw e; }
      await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === ended)?.state).toBe('exited');
    }
    if (id === 'tab.close.right') await app.locator('.tab[data-tab]').first().click(); // the agent's tab is the last one: nothing is to its right
    expect(await run(app, row.label, id, true), `${id} was greyed`).toBe(id !== 'handoff.claude');
    await confirm(app);
    await app.keyboard.press('Escape');
    expect(seen).toEqual([]);
  });
}
