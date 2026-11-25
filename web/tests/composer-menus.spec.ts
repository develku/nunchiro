// CHAT-MENUS (needs 121, ticket 82): the composer's / and @ menus are GUI entry points to the agent CLI's own commands, skills
// and file mentions. They insert text; the user sends it. Real core per test (fake claude, the fixtures' fake codex).
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, REPO, test, showComposer } from './fixtures';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');

const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** A project with agent folders and a few files, and one session of `kind` in it. */
// `quiet`: the fake agent (fixtures.ts) waits for the file its `--model` names, relative to its folder; `never` is no file there, so no dialog is pending (a first message sent while one is pending
// is held until it is answered, v25-quiet-chat, ticket 294 item 2).
function setup(core: Core, kind: 'claude' | 'codex' | 'shell' = 'claude', quiet = false, name = `demo-${kind}`) {
  const p = core.project(name);
  execFileSync('git', ['init', '-q'], { cwd: p }); // its own repo: the checkout's .gitignore (.scratch) must not mark every file ignored
  put(p, '.claude/commands/ship.md', '# ship\n');
  put(p, '.claude/skills/tdd-lite/SKILL.md', '# tdd-lite\n');
  put(p, 'src/tree/tree.css', '.tree { color: red; }\n');
  put(p, 'src/tree/Tree.tsx', 'export const tree = 1;\n');
  put(p, 'README.md', '# readme\n');
  if (kind === 'codex') fs.copyFileSync(path.join(FIXTURES, 'codex'), path.join(core.home, 'bin/codex'));
  if (kind === 'shell') return core.shell(p, kind);
  return core.cli('session', 'start', '--kind', kind, '--project', p, '--label', kind, ...(quiet ? ['--model', 'never'] : [])).session as { id: string };
}

/** Every request the window sends, in order. */
async function spy(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).request) sent.push(JSON.parse(m).request);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

const box = (app: Page) => app.locator('.cbox').first();
const ta = (app: Page) => box(app).locator('textarea:not(.hoff-edit)');
const slash = (app: Page) => app.getByRole('listbox', { name: 'Commands and skills' });
const files = (app: Page) => app.getByRole('listbox', { name: 'Files' });
const opt = (menu: ReturnType<typeof slash>, name: string | RegExp) => menu.getByRole('option', { name });
const isSend = (r: { op: string }) => r.op === 'send_text' || r.op === 'send_keys';

test('composer_menu_opens_above_composer', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await app.getByRole('button', { name: 'Commands and skills', exact: true }).click();
  await expect(slash(app)).toBeVisible();
  const menu = (await slash(app).boundingBox())!;
  const composer = (await box(app).boundingBox())!;
  expect(menu.y + menu.height).toBeLessThanOrEqual(composer.y);
  // No min-width rule reaches the menu (the context menu's `.cmenu { min-width: 236px }` once did): the initial `auto`,
  // which Chromium resolves to "0px" and WebKit reports as "auto". Any length set by a rule fails on both engines.
  expect(await slash(app).evaluate((el) => getComputedStyle(el).minWidth)).toMatch(/^(0px|auto)$/);
});

test('slash_opens_and_filters', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('/');
  await expect(slash(app)).toBeVisible();
  await expect(opt(slash(app), /^\/btw/)).toBeVisible();
  await expect(opt(slash(app), /^\/context/)).toBeVisible();
  await expect(opt(slash(app), /^\/code-review/)).toBeVisible();
  await ta(app).pressSequentially('con');
  await expect(opt(slash(app), /^\/context/)).toBeVisible();
  await expect(opt(slash(app), /^\/btw/)).toHaveCount(0);
  await ta(app).fill('hello /');
  await expect(slash(app)).toHaveCount(0); // a / after other text is plain text
});

test('slash_pick_inserts_text_not_send', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('/con');
  await opt(slash(app), /^\/context/).click();
  await expect(ta(app)).toHaveValue('/context ');
  await expect(slash(app)).toHaveCount(0);
  await expect(ta(app)).toBeFocused();
});

test('at_lists_existing_file_search', async ({ app, core }) => {
  setup(core);
  const sent = await spy(app);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('@tree');
  await expect(files(app)).toBeVisible();
  await expect(opt(files(app), 'src/tree/tree.css')).toBeVisible();
  await expect(opt(files(app), 'src/tree/Tree.tsx')).toBeVisible();
  await expect(opt(files(app), 'README.md')).toHaveCount(0);
  expect(sent.some((r) => r.op === 'files_search')).toBe(true); // the core's existing search, no new op
});

test('at_pick_inserts_path', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('look at @tree');
  await opt(files(app), 'src/tree/tree.css').click();
  await expect(ta(app)).toHaveValue('look at @src/tree/tree.css ');
  await expect(files(app)).toHaveCount(0);
});

test('at_menu_stays_in_session_root', async ({ app, core }) => {
  const s = setup(core);
  const sent = await spy(app);
  fs.writeFileSync(path.join(core.home, 'p', 'outside.txt'), 'secret\n'); // next to the project folder, outside the session root
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('@../..');
  await expect(files(app)).toBeVisible();
  await expect(files(app).getByText('No match')).toBeVisible();
  await expect(files(app).getByRole('option')).toHaveCount(0);
  await ta(app).fill('@../');
  await expect(files(app).getByText('No match')).toBeVisible();
  await app.waitForTimeout(300);
  // the window only ever asked for paths under the session's own root (the core refuses the rest)
  expect(sent.filter((r) => r.op.startsWith('file')).every((r) => r.root === s.id)).toBe(true);
});

test('menus_per_agent_kind', async ({ app, core }) => {
  const c = setup(core, 'claude');
  const x = setup(core, 'codex');
  const s = setup(core, 'shell');
  await openWindow(app);
  // Ticket 570: each kind is in its own project, so its tab is not in the strip; the tree row opens it.
  await app.locator(`button.row.wt2[data-menu-session="${c.id}"]`).click();
  await ta(app).click();
  await ta(app).pressSequentially('/');
  await expect(opt(slash(app), /^\/btw/)).toBeVisible();
  await expect(opt(slash(app), /^\/ship/)).toBeVisible(); // .claude/commands of the project
  await expect(opt(slash(app), /^\/tdd-lite/)).toBeVisible(); // .claude/skills of the project
  await ta(app).fill('');
  await app.locator(`button.row.wt2[data-menu-session="${x.id}"]`).click();
  await ta(app).click();
  await ta(app).pressSequentially('/');
  await expect(slash(app)).toBeVisible();
  await expect(opt(slash(app), /^\/btw/)).toHaveCount(0); // Claude's list is not Codex's
  await expect(opt(slash(app), /^\/ship/)).toHaveCount(0);
  await expect(opt(slash(app), /^\/approvals/)).toBeVisible();
  await ta(app).fill('');
  await app.locator(`button.row.wt2[data-menu-session="${s.id}"]`).click();
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await ta(app).click();
  await ta(app).pressSequentially('/');
  await ta(app).pressSequentially('@');
  await expect(app.getByRole('listbox')).toHaveCount(0); // other kinds: plain text
  await expect(box(app).getByRole('button', { name: 'Commands and skills' })).toHaveCount(0);
  await expect(box(app).getByRole('button', { name: 'Mention a file' })).toHaveCount(0);
});

test('esc_closes_arrows_pick', async ({ app, core }) => {
  setup(core);
  const sent = await spy(app);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('/');
  const first = await slash(app).getByRole('option').first().innerText();
  const options = slash(app).getByRole('option');
  // A screen reader hears the selection through the textarea (focus never leaves it): combobox, controls, activedescendant.
  await expect(ta(app)).toHaveAttribute('aria-expanded', 'true');
  await expect(ta(app)).toHaveAttribute('aria-controls', (await slash(app).getAttribute('id'))!);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(ta(app)).toHaveAttribute('aria-activedescendant', (await options.first().getAttribute('id'))!);
  await ta(app).press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(ta(app)).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
  await ta(app).press('ArrowUp');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(ta(app)).toHaveAttribute('aria-activedescendant', (await options.first().getAttribute('id'))!);
  await ta(app).press('Escape');
  await expect(slash(app)).toHaveCount(0);
  await expect(ta(app)).toHaveAttribute('aria-expanded', 'false');
  await expect(ta(app)).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(ta(app)).toHaveValue('/'); // Esc keeps the text
  await ta(app).pressSequentially('c'); // typing opens it again
  await expect(slash(app)).toBeVisible();
  await ta(app).press('ArrowDown');
  const second = (await slash(app).getByRole('option').nth(1).innerText()).split('\n')[0];
  await ta(app).press('Enter'); // Enter picks while the menu is open, it does not send
  await expect(ta(app)).toHaveValue(`${second} `);
  expect(sent.filter(isSend)).toEqual([]);
  expect(first).toContain('/');
  await ta(app).fill('/c');
  await ta(app).press('Tab');
  await expect(ta(app)).toHaveValue(/^\/\S+ $/);
});

test('no_menu_during_ime_composition', async ({ app, core }) => {
  setup(core);
  const sent = await spy(app);
  await openWindow(app);
  await ta(app).click();
  // A composition is running: the textarea holds "/" but the IME owns it.
  await ta(app).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = '/';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '/' }));
  });
  await expect(slash(app)).toHaveCount(0);
  await ta(app).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '/' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '/' }));
  });
  await expect(slash(app)).toBeVisible(); // composition done: the menu may open
  // Menu open, a new composition starts: arrows and Enter are the IME's, the menu leaves them alone.
  await ta(app).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const key of ['ArrowDown', 'Enter', 'Tab'])
      el.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(ta(app)).toHaveValue('/');
  await expect(slash(app).getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  expect(sent.filter(isSend)).toEqual([]);
});

test('menu_reachable_in_2_clicks', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await box(app).getByRole('button', { name: 'Commands and skills' }).click(); // click 1
  await expect(slash(app)).toBeVisible();
  await opt(slash(app), /^\/context/).click(); // click 2
  await expect(ta(app)).toHaveValue('/context ');
  await ta(app).fill('');
  await box(app).getByRole('button', { name: 'Mention a file' }).click(); // click 1
  await expect(files(app)).toBeVisible();
  await opt(files(app), 'README.md').click(); // click 2
  await expect(ta(app)).toHaveValue('@README.md ');
  // NODUP: the + menu no longer carries a second, disabled route to the same menu.
  await box(app).getByRole('button', { name: 'Add' }).click();
  await expect(app.getByRole('menuitem', { name: /Slash commands/ })).toHaveCount(0);
});

test('nothing_sent_without_user_send', async ({ app, core }) => {
  setup(core, 'claude', true);
  const sent = await spy(app);
  await openWindow(app);
  await box(app).getByRole('button', { name: 'Commands and skills' }).click();
  await opt(slash(app), /^\/context/).click();
  await ta(app).pressSequentially('see ');
  await box(app).getByRole('button', { name: 'Mention a file' }).click();
  await opt(files(app), 'README.md').click();
  await app.waitForTimeout(400);
  expect(sent.filter(isSend)).toEqual([]);
  await expect(ta(app)).toHaveValue('/context see @README.md ');
  await box(app).getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => sent.filter(isSend).length).toBeGreaterThan(0);
  expect(sent.find((r) => r.op === 'send_text')?.text).toContain('/context see @README.md');
});

// Round 3: the quiet session's `--model` once carried the project path, and the core refuses a model over 100 characters, so
// the same test went red where the checkout path was long (a merge worktree). The value is a short relative name now.
test('quiet_session_starts_under_a_long_path: a project path over 110 characters still starts a session with no dialog pending', async ({ app, core }) => {
  const s = setup(core, 'claude', true, 'long-'.padEnd(120, 'x'));
  const snap = core.cli('snapshot', '--json').sessions.find((x: { id: string }) => x.id === s.id);
  expect(snap.cwd.length).toBeGreaterThan(110);
  await openWindow(app);
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
  expect(snap.pending).toEqual([]);
});

test('reads_agent_folders_read_only', async ({ app, core }) => {
  const s = setup(core);
  const sent = await spy(app);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('/');
  await expect(opt(slash(app), /^\/ship/)).toBeVisible();
  await expect(opt(slash(app), /^\/tdd-lite/)).toBeVisible();
  const reads = sent.filter((r) => r.op.startsWith('file'));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((r) => ['files_list', 'file_read', 'files_search'].includes(r.op) && r.root === s.id)).toBe(true);
  expect(sent.filter((r) => /write|delete|save|mkdir/.test(r.op))).toEqual([]);
  expect(fs.existsSync(path.join(core.home, 'sentinel-home', '.claude'))).toBe(false); // nothing under ~/.claude
});

// Ticket 98: user-level commands from the user's own ~/.claude, listed read only by the core.
test('menu_shows_user_rows', async ({ app, core }) => {
  setup(core);
  const home = path.join(core.home, 'sentinel-home');
  put(home, '.claude/commands/mine.md', '---\ndescription: My own command\n---\nbody\n');
  put(home, '.claude/commands/ship.md', '# user ship\n'); // the project's ship wins on the same label
  const sent = await spy(app);
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('/mine');
  await expect(opt(slash(app), /^\/mine/)).toContainText('My own command'); // ticket 371: a row's own description, else its kind
  await ta(app).fill('/ship');
  await expect(slash(app).getByRole('option', { name: /^\/ship/ })).toHaveCount(1);
  await expect(opt(slash(app), /^\/ship/)).toContainText('Project command');
  await ta(app).fill('/mine');
  await opt(slash(app), /^\/mine/).click();
  await expect(ta(app)).toHaveValue('/mine ');
  expect(sent.some(isSend)).toBe(false);
  expect(sent.filter((r) => r.op === 'user_commands').length).toBeGreaterThan(0);
});

// Ticket 371 item 16: commands and skills of the user's enabled Claude plugins, read on each open.
function plugin(core: Core, on: boolean) {
  const home = path.join(core.home, 'sentinel-home');
  const root = path.join(home, '.claude/plugins/cache/market/buildFlow/1.0.0');
  put(root, '.claude-plugin/plugin.json', '{"name":"buildFlow"}');
  put(root, 'skills/kf/SKILL.md', '---\nname: kf\ndescription: Runs the zebrafish planning loop, a sentence long enough to overrun the row of a narrow menu by far\n---\nbody text\n');
  put(home, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'buildFlow@market': [{ scope: 'user', installPath: root, version: '1.0.0' }] } }));
  put(home, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'buildFlow@market': on } }));
  return home;
}

test('plugin_rows_in_slash_menu', async ({ app, core }) => {
  setup(core);
  const home = plugin(core, true);
  put(home, '.claude/commands/zebrafish.md', 'Named after the word\n');
  await openWindow(app);
  await ta(app).click();
  await ta(app).pressSequentially('/kf');
  await expect(opt(slash(app), /^\/buildFlow:kf/)).toContainText('Runs the zebrafish planning loop');
  expect(await slash(app).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); // a long description stays in the row
  await ta(app).fill('/zebrafish'); // found only in the description, and ranked below a name match
  const rows = slash(app).getByRole('option');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('/zebrafish');
  await expect(rows.nth(1)).toContainText('/buildFlow:kf');
  await opt(slash(app), /^\/buildFlow:kf/).click();
  await expect(ta(app)).toHaveValue('/buildFlow:kf ');
  plugin(core, false); // turned off in Claude's settings: gone on the next open
  await ta(app).fill('');
  await ta(app).pressSequentially('/kf');
  await expect(slash(app)).toBeVisible();
  await expect(opt(slash(app), /^\/buildFlow:kf/)).toHaveCount(0);
});
