// V1A-59 GUI session lifecycle: start from the palette, a project's "+" and the empty state; stop from the tab, the
// AGENTS row and the palette through the core's `close`; AGENTS order and Clear done; a closed session read-only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ownerOk } from './acp-fakes';
import { expect, openWindow, REPO, test, type Core, agentsZone, showComposer } from './fixtures';
import { openQuiet } from './tree-seed';
import { append, chat, rec, test as chatTest } from './fixtures/chat/harness';

test.beforeEach(({ core }) => agentsZone(core)); // D5b: these specs read the AGENTS rows, which the default window no longer shows

type Snap = { id: string; kind: string; project: string; state: string; label: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const stateOf = (core: Core, id: string) => snap(core).find((s) => s.id === id)?.state;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `v1a59-${name}-${test.info().project.name}.png`) });
const agentIds = (page: Page) => page.locator('.ar').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));

async function palette(page: Page, id: string) {
  await page.keyboard.press('Meta+KeyK');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.locator(`[data-command="${id}"]`).click();
  await expect(dialog).toHaveCount(0);
}

test('session-start-palette: with no session open, the palette starts a Claude session in a picked folder', async ({ app, core }) => {
  const folder = core.project('alpha');
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyK');
  const item = app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]');
  await expect(item).toHaveAttribute('aria-disabled', 'false');
  await item.click();
  // v25-new-tab (needs 209): the popover; a folder typed in the search is the folder to start in, then the Claude row starts.
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('combobox').fill(folder);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  // The core probes the agent's version before it answers: allow for a busy host.
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => snap(core).map((s) => [s.kind, s.project, s.state])).toEqual([['claude', folder, 'running']]);
  const id = snap(core)[0].id;
  await expect(app.locator(`.tab[data-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('Q7 point 1: New tab > New worktree makes a worktree of the project and starts the session in it', async ({ app, core }) => {
  const folder = core.project('alpha');
  const git = (...a: string[]) => execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  await openWindow(app);
  await palette(app, 'session.new');
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await dlg.getByRole('combobox').fill(folder);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  const place = dlg.getByRole('radiogroup', { name: 'Where the session works' });
  await expect(place.getByRole('radio', { name: 'Current folder' })).toHaveAttribute('aria-checked', 'true');
  await place.getByRole('radio', { name: 'New worktree' }).click();
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => snap(core).map((s) => [s.kind, s.project, s.state])).toEqual([['claude', folder, 'running']]);
  const cwd = (core.cli('snapshot', '--json').sessions as { cwd: string }[])[0].cwd;
  expect(cwd).not.toBe(folder);
  // The folder is a worktree of the project, on its own branch.
  expect(git('worktree', 'list', '--porcelain')).toContain(`worktree ${fs.realpathSync(cwd)}`);
});

// Ticket 991 (Q7 point 1, the part left for later): the new worktree's generated branch (wt-xxxx) takes its name from
// the session's first prompt. The window lists the worktrees again when the session's title arrives; the core renames
// in that list, so the tree row and the status bar show the name without waiting for the 30 s refresh.
test('Q7 point 1: the first prompt names the new worktree\'s branch, and the tree row and the status bar follow', async ({ app, core }) => {
  const folder = core.project('alpha');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'commit', '-q', '--allow-empty', '-m', 'init');
  await openWindow(app);
  await palette(app, 'session.new');
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await dlg.getByRole('combobox').fill(folder);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('radiogroup', { name: 'Where the session works' }).getByRole('radio', { name: 'New worktree' }).click();
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => snap(core).map((s) => s.state)).toEqual(['running']);
  const s = (core.cli('snapshot', '--json').sessions as { id: string; cwd: string }[])[0];
  const made = git(s.cwd, 'symbolic-ref', '--short', 'HEAD');
  expect(made).toMatch(/^wt-[0-9a-f]{4}$/);
  const row = app.locator(`[data-wt="${s.cwd}"]`);
  const branch = app.locator('.shead .dim').first(); // ticket 1031: the branch is in the session header, not the status bar
  await expect(row).toContainText(made);
  await expect(branch).toContainText(made);
  // Claude's own prompt hook, with the words of the first message.
  ownerOk(core, { op: 'hook', id: s.id, event: 'UserPromptSubmit', payload: { prompt: 'Fix the login redirect!' } });
  await expect(row).toContainText('fix-the-login-redirect'); // well inside the list's 30 s refresh
  await expect(row).not.toContainText(made);
  await expect(branch).toContainText('fix-the-login-redirect');
  expect(git(s.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('fix-the-login-redirect');
  expect(git(folder, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toBe('fix-the-login-redirect\nmain');
  expect(fs.realpathSync(s.cwd)).toBe(s.cwd); // the folder is not moved
  // A second prompt renames nothing.
  ownerOk(core, { op: 'hook', id: s.id, event: 'UserPromptSubmit', payload: { prompt: 'Something else now' } });
  await app.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect(git(s.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('fix-the-login-redirect');
  await expect(row).toContainText('fix-the-login-redirect');
});

test('session-start-project-plus: "+" on a project row starts a session in that project', async ({ app, core }) => {
  const beta = core.project('beta');
  core.shell(core.project('alpha'), 'a1');
  core.shell(beta, 'b1');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  // Shown with its row: hovered, or by Tab from the row. Showing it moves nothing (needs 26).
  const still = () => app.$$eval('.grp[data-project="beta"] .head .r, .tab, .ar .s', (els) => els.map((e) => JSON.stringify(e.getBoundingClientRect())));
  const before = await still();
  await app.locator('.grp[data-project="beta"] .head .n').hover();
  expect(await still()).toEqual(before);
  await app.locator('.tab').first().hover();
  expect(await still()).toEqual(before);
  await app.locator('.ar').first().hover();
  expect(await still()).toEqual(before);
  await app.locator('.grp[data-project="beta"] .head .n').hover();
  await app.locator('.grp[data-project="beta"]').getByRole('button', { name: 'New session in beta' }).click();
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg.locator('.nt-in')).toHaveAttribute('title', beta);
  // Known projects are found by name in the search.
  await dlg.getByRole('combobox').fill('alpha');
  await expect(dlg.getByRole('option', { name: /^alpha/ })).toBeVisible();
  await dlg.getByRole('combobox').fill('');
  await shot(app, 'new-session');
  await dlg.getByRole('option', { name: 'New terminal' }).click(); // the first row: a shell in beta
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => snap(core).filter((s) => s.project === beta && s.state === 'running').length).toBe(2);
});

test('empty-state-button: the empty state button opens the start flow by click and by Enter', async ({ app, core }) => {
  core.project('alpha');
  await openWindow(app);
  // V2.5-67: the empty state's own button (ticket 305: on the Landing, as "Add project").
  const button = app.locator('.pane > .empty > div > button', { hasText: 'Add project' });
  await shot(app, 'empty');
  await button.click();
  const dlg = app.getByRole('dialog', { name: 'Add project' });
  await expect(dlg).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await button.focus();
  await app.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: /^Browse folder/ })).toBeFocused();
});

test('session-stop-tab-agents-palette: each of the three entry points stops a session through close', async ({ app, core }) => {
  const p = core.project('demo');
  const [one, two, three] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  const agent = core.agent(p, 'agent', 'never').id;
  await openWindow(app);
  // Tab: its menu (owner 11-17: a tab has no Stop button). An idle shell has no turn to stop: Close session ends it at once (4bf0a62d4).
  await app.locator(`.tab[data-tab="${one}"]`).click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Stop this session' })).toHaveCount(0);
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Close session' }).click();
  await expect.poll(() => stateOf(core, one)).toBe('closed');
  // AGENTS row.
  // By keyboard: Tab from the row reaches its Stop.
  await app.locator(`[data-agent="${two}"]`).focus();
  // WebKit, like Safari, moves to buttons on Option+Tab.
  await app.keyboard.press(test.info().project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(app.getByRole('button', { name: 'Stop two' })).toBeFocused();
  await app.keyboard.press('Enter');
  await expect.poll(() => stateOf(core, two)).toBe('closed');
  // Palette: the current session.
  await app.locator(`.tab[data-tab="${three}"]`).click();
  await palette(app, 'session.close');
  await expect.poll(() => stateOf(core, three)).toBe('closed');
  // A running agent asks once: Cancel keeps it, Stop closes it.
  await app.locator(`.tab[data-tab="${agent}"]`).click({ button: 'right' });
  await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Stop this session' }).click();
  const ask = app.getByRole('alertdialog', { name: 'Stop agent?' });
  await shot(app, 'stop-ask');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  expect(stateOf(core, agent)).toBe('running');
  await app.locator(`.tab[data-tab="${agent}"]`).click();
  await palette(app, 'session.stop');
  await ask.getByRole('button', { name: 'Stop' }).click();
  await expect(ask).toHaveCount(0);
  await expect.poll(() => stateOf(core, agent)).toBe('closed');
});

test('agents-order-clear-done: running first; Clear done hides closed rows; no reorder while hovered', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'a').id;
  const b = core.shell(p, 'b', '/bin/sh', '-c', 'read x; exit 0').id;
  const c = core.shell(p, 'c').id;
  const d = core.shell(p, 'd').id;
  core.cli('session', 'close', a);
  await openWindow(app);
  await expect.poll(() => agentIds(app)).toEqual([b, c, d, a]);
  // Hovered, a session that ends keeps its place.
  await app.locator(`[data-agent="${c}"]`).hover();
  core.cli('session', 'send-text', b, 'x\r');
  await expect(app.locator(`[data-agent="${b}"] .st`)).toHaveAttribute('data-s', 'done');
  await app.waitForTimeout(300);
  expect(await agentIds(app)).toEqual([b, c, d, a]);
  // Left, running sessions come first.
  await app.mouse.move(900, 400);
  await expect.poll(() => agentIds(app)).toEqual([c, d, b, a]);
  // A row with no Stop (ended) moves nothing when hovered.
  const texts = () => app.$$eval('.ar .s', (els) => els.map((e) => JSON.stringify(e.getBoundingClientRect())));
  const rest = await texts();
  await app.locator(`[data-agent="${b}"]`).hover();
  expect(await texts()).toEqual(rest);
  await app.mouse.move(900, 400);
  // Clear done hides the closed and exited rows; they stay in the palette.
  await app.locator(`[data-agent="${c}"]`).hover();
  await shot(app, 'agents');
  await app.getByRole('button', { name: 'Clear done' }).click();
  await expect.poll(() => agentIds(app)).toEqual([c, d]);
  // The focused Clear done went with the rows: the hold ends once the pointer leaves, focus is not left stuck.
  await app.mouse.move(900, 400);
  core.cli('session', 'close', c);
  await expect.poll(() => agentIds(app)).toEqual([d, c]);
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' }).locator(`[data-command="session.open.${a}"]`)).toBeVisible();
  await app.keyboard.press('Escape');
  // Kept after a reload.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(() => agentIds(app)).toEqual([d, c]);
});

test('agents-more-count: "+K" equals the rows cut off and follows a row height change', async ({ app, core }) => {
  const p = core.project('many');
  Array.from({ length: 16 }, (_, i) => core.shell(p, `row-${String(i).padStart(2, '0')}`));
  await openWindow(app);
  // D5b: a zone of its own is as tall as the window now, so taller rows make the 16 overflow it.
  await app.evaluate(() => document.documentElement.style.setProperty('--arow', '80px'));
  const cut = () =>
    app.locator('.agents .alist').evaluate((l) => {
      const bottom = l.getBoundingClientRect().bottom;
      return [...l.querySelectorAll('.ar')].filter((e) => e.getBoundingClientRect().bottom > bottom + 0.5).length;
    });
  await expect.poll(async () => (await app.locator('.agents .amore').textContent()) === `+${await cut()}`).toBe(true);
  const before = await cut();
  // Taller rows cut off more: the count follows without a scroll or a box resize.
  await app.evaluate(() => document.documentElement.style.setProperty('--arow', '120px'));
  await expect.poll(cut).toBeGreaterThan(before);
  await expect.poll(async () => (await app.locator('.agents .amore').textContent()) === `+${await cut()}`).toBe(true);
});

test('closed-session-readonly: an exited shell shows its last scrollback read-only with disabled composer', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'gone', '/bin/sh', '-c', 'echo last-words; read x; exit 0').id;
  await openWindow(app);
  await expect.poll(() => core.read(s)).toContain('last-words');
  core.cli('session', 'send-text', s, 'x\r');
  await expect.poll(() => stateOf(core, s)).toBe('exited');
  const term = app.locator(`.term[data-session="${s}"]`);
  await expect(term.locator('.xterm-rows')).toContainText('last-words');
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const box = app.locator('.composer textarea');
  await expect(box).toBeVisible();
  await expect(box).toBeDisabled();
  await expect(app.locator('.composer .why')).toHaveText('gone has exited: read only');
  await shot(app, 'exited-shell');
});

// V1A-68 r3 (needs 78): a closed shell's text stays in the core's memory; the view offers the editor export to keep it.
test('closed-session-readonly: a closed shell shows its last scrollback read-only, saves it to a file and opens a temporary copy', async ({ app, core }) => {
  // A fake $EDITOR and an empty HOME, as terminal-editor.spec: no real editor or dotfiles take part.
  const editor = path.join(core.home, 'bin/fake-editor');
  fs.writeFileSync(editor, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.mkdirSync(path.join(core.home, 'user'));
  core.run(['serve', 'stop'], 10_000);
  Object.assign(core.env, { EDITOR: editor, HOME: path.join(core.home, 'user'), ZDOTDIR: path.join(core.home, 'user') });
  await core.restart();
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  const s = core.shell(core.project('demo'), 'shut', '/bin/sh', '-c', "printf '\\033[31mclosed-words\\033[0m\\r\\nline-two\\r\\n'; exec cat").id;
  await expect.poll(() => core.read(s)).toContain('line-two');
  core.cli('session', 'close', s);
  expect(fs.existsSync(path.join(core.home, 'scrollback', s))).toBe(false);
  await openWindow(app);
  // Reached from the palette (a closed session opens no tab of its own).
  await palette(app, `session.open.${s}`);
  await expect(app.locator(`.term[data-session="${s}"] .xterm-rows`)).toContainText('closed-words');
  await expect(app.locator('.composer textarea')).toBeDisabled();
  await shot(app, 'closed-shell');
  // V1A-68 r4 (needs 78): Save to file downloads the plain text; nothing is written under the Nunchiro home.
  const [download] = await Promise.all([app.waitForEvent('download'), app.getByRole('button', { name: 'Save to file…' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^shut-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
  expect(fs.readFileSync((await download.path())!, 'utf8')).toBe('closed-words\nline-two\n');
  expect(fs.existsSync(path.join(core.home, 'exports'))).toBe(false);
  // The editor copy says it is temporary.
  const copy = app.getByRole('button', { name: 'Open a temporary copy in $EDITOR' });
  await expect(copy).toHaveAttribute('title', /deleted when Nunchiro restarts/);
  await copy.click();
  const file = path.join(core.home, 'exports', s, 'scrollback.txt');
  await expect.poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')).toContain('closed-words');
});

test('closed-session-readonly: a closed shell whose view the bound dropped offers no save', async ({ app, core }) => {
  const p = core.project('demo');
  // 17 closed shells: the core keeps the newest 16 views.
  const ids = Array.from({ length: 17 }, (_, i) => {
    const id = core.shell(p, `s${i}`, '/bin/sh', '-c', `echo mark-${i}; exec cat`).id;
    return id;
  });
  for (const id of ids) {
    await expect.poll(() => core.read(id)).toContain('mark-');
    core.cli('session', 'close', id);
  }
  await openWindow(app);
  await palette(app, `session.open.${ids[1]}`);
  await expect(app.getByRole('button', { name: 'Open a temporary copy in $EDITOR' })).toBeVisible();
  await palette(app, `session.open.${ids[0]}`);
  await expect(app.locator('.composer .why')).toHaveText('s0 is closed: read only');
  await expect(app.getByRole('button', { name: 'Save to file…' })).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Open a temporary copy in $EDITOR' })).toHaveCount(0);
});

chatTest('closed-session-readonly: a closed agent shows its transcript, Restart session, and disabled composer and chips', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('닫기 전 질문'), rec.assistant('닫기 전 답'));
  chatCore.cli('session', 'close', s.id);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // Reached from the palette (a closed session opens no tab of its own).
  await palette(page, `session.open.${s.id}`);
  const view = chat(page, s.id);
  await expect(view.getByText('닫기 전 답')).toBeVisible();
  await expect(page.locator('.composer textarea')).toBeVisible();
  await expect(page.locator('.composer textarea')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.locator('.composer .why')).toHaveText('chat is closed: read only');
  await expect(page.locator('.composer [data-picker="model"]')).toHaveAttribute('aria-disabled', 'true');
  await page.screenshot({ path: path.join(REPO, '.scratch/shots', `v1a59-closed-agent-${chatTest.info().project.name}.png`) });
  // needs 207 (v25-quiet-chat): the chat carries no "is closed + Resume" row. Ticket 371 item 17 (owner 11-09): one button beside the composer's reason line, no strip.
  await expect(page.getByRole('button', { name: /^Continue/ })).toHaveCount(1);
  await expect(page.locator('.composer .whyline').getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(page.locator('.resume')).toHaveCount(0);
  // v25-shell-chrome (ticket 282 item 2): no Resume strip; Restart session is in the tab's menu.
  await page.locator(`.tab[data-tab="${s.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Resume session' }).click();
  await expect.poll(() => (chatCore.cli('snapshot', '--json').sessions as Snap[]).some((x) => x.state === 'running')).toBe(true);
  const live = (chatCore.cli('snapshot', '--json').sessions as Snap[]).find((x) => x.state === 'running')!;
  await expect(page.locator(`.tab[data-tab="${live.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

// Round 2 (verifier of c927585): real modal focus, Esc from anywhere, model defaults (owner 11-17: a tab has no Stop button).

test('new-session-popover: focus starts in the search, Esc closes from it and after an arrow', async ({ app, core }) => {
  // v25-new-tab (ticket 290, needs 209): not a modal any more (it replaces new-session-modal): the page behind stays live.
  core.shell(core.project('alpha'), 'a1');
  await openWindow(app);
  await palette(app, 'session.new');
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg.getByRole('combobox')).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await palette(app, 'session.new');
  await expect(dlg.getByRole('combobox')).toBeFocused(); // the palette is gone before the popover mounts: keys sent now would go nowhere
  await app.keyboard.type('x');
  await app.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('new_tab_popover_outside_press_closes: a mouse press outside the popover box closes it', async ({ app, core }) => {
  // Ticket 297 item 8: the press used to be sent at a fixed point right after the palette closed, before the popover was
  // mounted (7 of 20 runs at 4 workers left it open). Wait for the popover, then press below its own box.
  core.shell(core.project('alpha'), 'a1');
  await openWindow(app);
  await palette(app, 'session.new');
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg.getByRole('combobox')).toBeFocused();
  const box = (await dlg.boundingBox())!;
  await app.mouse.click(box.x + box.width / 2, Math.min(box.y + box.height + 40, 890));
  await expect(dlg).toHaveCount(0);
});

test('new-session-defaults: another folder takes the current session model when the agent matches', async ({ app, core }) => {
  const cur = core.agent(core.project('alpha'), 'cur', 'model-x').id;
  const beta = core.project('beta');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${cur}"]`).click();
  await palette(app, 'session.new');
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await dlg.getByRole('combobox').fill(beta);
  await dlg.getByRole('option', { name: /Start in folder/ }).click();
  await dlg.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { project: string; model?: string }[]).find((x) => x.project === beta)?.model).toBe('model-x');
});

test('new_tab_popover_no_dead_selector: the composer key is not swallowed while the popover holds focus, and no selector names dialog.newsess', async ({ app, core }) => {
  // useGlobalKeys used to look for `dialog.newsess` (the old sheet); the popover is `.newtab`, so Cmd+Enter in its search
  // reached the composer's background send and started a session with the composer's text.
  const s = core.agent(core.project('alpha'), 'a1', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const ta = app.locator('.composer textarea');
  await ta.fill('keep this text');
  await palette(app, 'session.new');
  const dlg = app.getByRole('dialog', { name: 'New tab' });
  await expect(dlg.getByRole('combobox')).toBeFocused();
  await dlg.getByRole('combobox').press('Meta+Enter');
  await expect(ta).toHaveValue('keep this text');
  await expect(dlg).toBeVisible();
  expect(snap(core).filter((x) => x.kind === 'claude')).toHaveLength(1);
  expect(fs.readFileSync(path.join(REPO, 'web/src/chrome/useGlobalKeys.ts'), 'utf8')).not.toContain('dialog.newsess');
});

test('stop_ask_label_translated: the Stop confirmation reads its label and words from the catalogue in all 8 languages', async ({ app, core }) => {
  const s = core.agent(core.project('alpha'), 'agent', 'never');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await palette(app, 'session.stop');
  const ask = app.getByRole('alertdialog');
  await expect(ask).toHaveAccessibleName('Stop agent?');
  const want: Record<string, string> = { ko: 'agent를 중지하시겠습니까?', ja: 'agent を停止しますか？', 'zh-Hans': '停止 agent？', 'zh-Hant': '停止 agent？', es: '¿Detener agent?', fr: 'Arrêter agent ?', pt: 'Parar agent?' };
  for (const [lang, label] of Object.entries(want)) {
    await app.evaluate((l) => document.documentElement.setAttribute('lang', l), lang);
    await expect(ask, lang).toHaveAccessibleName(label);
    await expect(ask.locator('b'), lang).toHaveText(label);
  }
});
