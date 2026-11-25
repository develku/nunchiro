// v25-new-tab (ticket 290, needs 209): the tab strip's "+" opens a small popover under it (Orca's tab "+" menu): one
// search field, then rows of icon + name + shortcut. These specs start from the visible "+" and read the popover.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';

const plus = (app: Page) => app.getByRole('button', { name: 'New session', exact: true });
const pop = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
const search = (app: Page) => pop(app).getByRole('combobox');
const row = (app: Page, name: string | RegExp) => pop(app).getByRole('option', { name });
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; kind: string; project: string; label: string; state: string }[];

/** One running shell makes alpha the current project; the window opens with its tab. */
async function open(app: Page, core: Core) {
  const alpha = core.project('alpha');
  core.shell(alpha, 'build-shell');
  await openWindow(app);
  return alpha;
}

test('plus_opens_popover_rows: "+" opens a popover under it: search first, then terminal, browser, agents, Agent settings… last', async ({ app, core }) => {
  await open(app, core);
  await plus(app).click();
  await expect(pop(app)).toBeVisible();
  // Not a centred modal dialog: no native <dialog> is open, and the popover hangs under the button.
  await expect(app.locator('dialog[open]')).toHaveCount(0);
  const [b, p] = await Promise.all([plus(app).boundingBox(), pop(app).boundingBox()]);
  expect(p!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 1);
  expect(p!.y).toBeLessThan(b!.y + b!.height + 24);
  expect(Math.abs(p!.x - b!.x)).toBeLessThan(300);
  await expect(search(app)).toBeFocused();
  const names = await pop(app).getByRole('option').evaluateAll((els) => els.map((e) => (e.querySelector('.nt-name') as HTMLElement).innerText));
  expect(names.slice(0, 4)).toEqual(['New terminal', 'New browser tab', 'Claude', 'Codex']);
  expect(names.at(-1)).toBe('Agent settings…');
  // q67 look Q6-2: Browser is the globe here, as on the right bar (it was a window glyph in this menu).
  await expect(row(app, 'New browser tab').locator('svg[data-icon="globe"]')).toHaveCount(1);
  await expect(app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Browser', exact: true }).locator('svg[data-icon="globe"]')).toHaveCount(1);
  // No radio buttons, no path field, no message box: the old sheet is gone. Q7 point 1: the one choice left is where the
  // session works (Current checkout / New worktree), not which agent.
  await expect(pop(app).locator('[role="radio"]:not([role="radiogroup"][aria-label="Where the session works"] [role="radio"])')).toHaveCount(0);
  await expect(pop(app).getByRole('textbox', { name: /Folder|First message/ })).toHaveCount(0);
  await app.screenshot({ path: `../.scratch/shots-v25-new-tab/popover-${test.info().project.name}.png` });
});

test('plus_search_finds_tabs_history_files_agents: one field finds an open tab, a finished session, a file, a URL and an agent', async ({ app, core }) => {
  const alpha = await open(app, core);
  core.shell(alpha, 'old-notes', '/usr/bin/true'); // exits at once: session history
  fs.writeFileSync(path.join(alpha, 'roadmap-zeta.md'), '# zeta\n');
  await expect.poll(() => snap(core).find((s) => s.label === 'old-notes')?.state).not.toBe('running');
  await plus(app).click();
  await search(app).fill('build-shell');
  await expect(row(app, /build-shell/)).toBeVisible();
  await search(app).fill('old-notes');
  await expect(row(app, /old-notes/)).toBeVisible();
  await search(app).fill('roadmap-zeta');
  await expect(row(app, /roadmap-zeta\.md/)).toBeVisible();
  await search(app).fill('example.com/docs');
  await expect(row(app, /example\.com\/docs/)).toBeVisible();
  await search(app).fill('codex');
  await expect(row(app, 'Codex')).toBeVisible();
  await expect(row(app, 'Claude')).toHaveCount(0);
  await search(app).fill('zzz-nothing');
  await expect(pop(app).getByRole('option')).toHaveCount(0);
  await expect(pop(app).getByRole('status')).toContainText('No match');
});

test('plus_agent_row_starts_in_current_project: Claude starts a session in the current project with no other step', async ({ app, core }) => {
  const alpha = await open(app, core);
  core.shell(core.project('beta'), 'other'); // the current project is the one of the open tab, not the newest
  await plus(app).click();
  await expect(pop(app)).toContainText('alpha');
  await row(app, 'Claude').click();
  await expect(pop(app)).toHaveCount(0);
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude').map((s) => s.project)).toEqual([alpha]);
});

test('plus_search_project_switches_folder: a project name in the search switches the folder; the next row starts there', async ({ app, core }) => {
  await open(app, core);
  const beta = core.project('beta');
  core.shell(beta, 'beta-shell');
  await expect.poll(() => snap(core).length).toBe(2);
  await plus(app).click();
  await search(app).fill('beta');
  await row(app, /beta/).filter({ hasText: 'Project' }).click();
  await expect(pop(app)).toContainText('beta');
  await expect(search(app)).toHaveValue('');
  await row(app, 'Claude').click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude').map((s) => s.project)).toEqual([beta]);
});

test('internal_folders_not_offered_as_projects: an account Login tab\'s config folder is never a project to start in', async ({ app, core }) => {
  // df047023: the popover hides a Login tab by the core's `account_tab` flag, which only the core's own account_add sets
  // (ticket 322), so the tab comes from there: a signed-out fake claude whose login waits like one asking for its code.
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), '#!/bin/sh\ncase "$*" in --version) echo "fake 1.0.0"; exit 0;; "auth status --json") exit 1;; esac\nexec /bin/cat\n', { mode: 0o700 });
  const alpha = await open(app, core);
  const { id, folder } = (ownerOk(core, { op: 'account_add', agent: 'claude', label: 'Work' }) as { account: { id: string; folder: string } }).account;
  await expect.poll(() => snap(core).filter((s) => s.project === folder).map((s) => s.label)).toEqual(['Login: Work']);
  core.shell(core.project('beta'), 'beta-shell');
  await plus(app).click();
  await search(app).fill(id.slice(0, 8));
  await expect(pop(app).getByRole('option')).toHaveCount(0);
  await search(app).fill('beta');
  await expect(row(app, /beta/).first()).toBeVisible(); // a real project is still offered
  await expect(pop(app)).not.toContainText(id);
  void alpha;
});

test('plus_popover_keyboard: arrows move, Enter picks, Esc closes and gives the focus back; a row shows and honours its shortcut', async ({ app, core }) => {
  const alpha = await open(app, core);
  await plus(app).click();
  const active = () => search(app).getAttribute('aria-activedescendant');
  const first = await active();
  await app.keyboard.press('ArrowDown');
  const second = await active();
  expect(second).not.toBe(first);
  await app.keyboard.press('ArrowUp');
  expect(await active()).toBe(first);
  await app.keyboard.press('ArrowUp'); // wraps to the last row
  await expect(row(app, 'Agent settings…')).toHaveAttribute('aria-selected', 'true');
  // 1500fca28 (ticket 1099 C): Agent settings opens Settings > Providers, not what ⌘, (`settings.open`) opens, so it shows
  // where it goes and no key.
  await expect(row(app, 'Agent settings…').locator('.kbd')).toHaveCount(0);
  await expect(row(app, 'Agent settings…')).toContainText('Settings > Providers');
  // Enter picks the selected row: type to narrow to Claude, then Enter starts it.
  await search(app).fill('claude');
  await app.keyboard.press('Enter');
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude').map((s) => s.project)).toEqual([alpha]);
  await expect(pop(app)).toHaveCount(0);
  // A new session's terminal took the focus a moment after it started (36992b70d), so this waited for it. A Claude session
  // now opens in its chat view, which leaves the focus where it was (1122: seen on "+"); wait for its tab instead.
  await expect(app.getByRole('tab', { name: /New Claude session/ })).toHaveAttribute('aria-selected', 'true');
  // Esc closes and focus returns to where it was ("+": WebKit does not focus a button on a click, so focus it first).
  await plus(app).focus();
  await plus(app).click();
  await expect(pop(app)).toBeVisible();
  await app.mouse.move(700, 500); // a hover tooltip on "+" would take the first Esc (system.md, Basic interactions)
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);
  await expect(plus(app)).toBeFocused();
  // The row's shortcut works with the popover open: it does the row's job and closes the popover.
  await plus(app).click();
  await app.keyboard.press('Meta+Comma');
  await expect(pop(app)).toHaveCount(0);
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible(); // v25f: the Settings modal
});

test('plus_agent_within_two_clicks: from the main view, "+" then the Codex row starts a Codex session', async ({ app, core }) => {
  const alpha = await open(app, core);
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake('#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.161.0"; exit 0;; esac\nexec /bin/cat\n'), { mode: 0o700 });
  await plus(app).click(); // click 1
  await row(app, 'Codex').click(); // click 2
  await expect.poll(() => snap(core).filter((s) => s.kind === 'codex').map((s) => s.project)).toEqual([alpha]);
});

test('new_tab_basic_interactions: the popover and its rows have the basics: Esc, arrows, hover name, focus return, right-click menu', async ({ app, core }) => {
  await open(app, core);
  await plus(app).click();
  // Hover name: a row has a native title with its full name (long names are cut).
  await expect(row(app, 'Claude')).toHaveAttribute('title', /Claude/);
  // Arrow keys move a visible selection; Home/End do too.
  await app.keyboard.press('End');
  await expect(row(app, 'Agent settings…')).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Home');
  await expect(row(app, 'New terminal')).toHaveAttribute('aria-selected', 'true');
  // A session result has its own right-click menu (the tree row's); a file result has Copy path.
  await search(app).fill('build-shell');
  await row(app, /build-shell/).click({ button: 'right' });
  await expect(app.getByRole('menu')).toBeVisible();
  await expect(app.getByRole('menuitem', { name: 'Close session' })).toBeVisible(); // an idle shell is ended by Close session, not Stop (4bf0a62d4)
  await app.keyboard.press('Escape');
  await expect(app.getByRole('menu')).toHaveCount(0);
  await search(app).fill('');
  // Click outside closes; focus returns to "+".
  await expect(pop(app)).toBeVisible(); // Esc went to the menu, not the popover
  await app.mouse.click(5, 450);
  await expect(pop(app)).toHaveCount(0);
  await expect(plus(app)).toBeFocused(); // focus returns to "+" after a click outside too (system.md basics)
  // "+" again toggles: a second click closes what the first opened.
  await plus(app).click();
  await expect(pop(app)).toBeVisible();
  await plus(app).click();
  await expect(pop(app)).toHaveCount(0);
});

test('plus_acp_agent_row: an approved ACP agent has a row with its mark and starts an acp session in the current project', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'tool', 'tool 1.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('tool', cmd, [], []));
  ownerOk(core, { op: 'acp_agent_grant', name: 'tool', hash: ownerOk(core, { op: 'acp_agent_status', name: 'tool' }).view.hash });
  const alpha = await open(app, core);
  await plus(app).click();
  const acp = pop(app).getByRole('option').filter({ hasText: 'ACP agent' });
  await expect(acp).toHaveCount(1);
  await expect(acp.locator('.agent-logo')).toHaveCount(1);
  // Claude and Codex show their logos too.
  await expect(row(app, 'Claude').locator('svg.agent-logo')).toHaveCount(1);
  await expect(row(app, 'Codex').locator('svg.agent-logo')).toHaveCount(1);
  await acp.click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'acp').map((s) => s.project)).toEqual([alpha]);
});

const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __calls: [string, Record<string, unknown>][]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Record<string, unknown>) => (w.__calls.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: [string, Record<string, unknown>][] }).__calls.filter((c) => c[0] === 'browser_show' || c[0] === 'browser_go'));

test('popover_rows_show_keys: New terminal, New browser tab, Claude and Codex show their keys; the key does the row\'s job and closes the popover', async ({ app, core }) => {
  const alpha = await open(app, core);
  await plus(app).click();
  for (const [name, key] of [['New terminal', '⌃~'], ['New browser tab', '⇧⌘B'], ['Claude', '⇧⌘C'], ['Codex', '⇧⌘O']] as const) // Agent settings has no key (1099 C)
    await expect(row(app, name).locator('.kbd')).toHaveText(key);
  await app.keyboard.press('Shift+Meta+KeyC');
  await expect(pop(app)).toHaveCount(0);
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude').map((s) => s.project)).toEqual([alpha]);
  // The same key works with no popover open: a terminal in this project.
  await app.keyboard.press('Control+Shift+Backquote');
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.label !== 'build-shell').length).toBe(1);
});

// Ticket 997 L1 (A6): the URL row and the browser row open the owner's own browser as a centre tab, also beside an agent session
// (its page stays in its side pane, which they no longer open).
const centre = (app: Page) => app.locator('.centre .pane');
const browserTab = (app: Page) => app.locator('.tabs [role="tab"][data-browser-tab]');

test('popover_url_row_opens_url: a URL result opens My browser as a centre tab at that address', async ({ app, core }) => {
  await fakeApp(app);
  const alpha = core.project('alpha');
  core.agent(alpha, 'a', 'never-created', false);
  await openWindow(app);
  await plus(app).click();
  await search(app).fill('example.com/docs');
  await row(app, /example\.com\/docs/).click();
  await expect(pop(app)).toHaveCount(0);
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
  await expect(centre(app).getByLabel('Address')).toHaveValue('http://example.com/docs');
  await expect.poll(async () => (await calls(app)).map((c) => c[1].url)).toContain('http://example.com/docs');
  expect((await calls(app)).find((c) => c[1].url === 'http://example.com/docs')![1]).toMatchObject({ space: 'you' });
  await expect(app.locator('[data-side-pane]:not([hidden])').getByLabel('Address')).toHaveCount(0);
});

test('popover_browser_rows_open_my_browser_without_agent_session: with a shell current, the browser rows open My browser as a centre tab (ticket 288, 997)', async ({ app, core }) => {
  await fakeApp(app);
  await open(app, core); // the current session is a shell: it has no side pane
  await plus(app).click();
  await expect(row(app, 'New browser tab')).not.toHaveAttribute('aria-disabled', 'true');
  await search(app).fill('example.com');
  await expect(row(app, /example\.com/)).not.toHaveAttribute('aria-disabled', 'true');
  await row(app, /example\.com/).click();
  await expect(pop(app)).toHaveCount(0);
  await expect(centre(app).getByLabel('Browser space')).toHaveValue('you');
  await expect(centre(app).getByLabel('Address')).toHaveValue('http://example.com/');
  await expect.poll(async () => (await calls(app)).map((c) => c[1].space)).toContain('you');
  await expect(app.locator('aside.sbar[data-side="right"][data-widget="browser"]')).toHaveCount(0);
  // The plain browser row opens the same tab, never a second one.
  await app.locator('.tabs [role="tab"][data-tab]').first().click();
  await plus(app).click();
  await row(app, 'New browser tab').click();
  await expect(browserTab(app)).toHaveCount(1);
  await expect(browserTab(app)).toHaveAttribute('aria-selected', 'true');
});

// Look 1117 (S3): from a Home session the popover read "in home" (the folder's name); the place is "Home" everywhere else.
test('popover_names_home_as_home', async ({ app, core }) => {
  const home = path.join(core.home, 'team', 'home');
  fs.mkdirSync(home, { recursive: true });
  core.shell(fs.realpathSync(home), 'notes');
  await openWindow(app);
  await plus(app).click();
  await expect(pop(app).locator('.nt-in')).toHaveText('in Assistants');
});
