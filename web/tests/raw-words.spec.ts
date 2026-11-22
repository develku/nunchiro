// Ticket 471 (scorecard D9): no raw path, id or internal word where a name would do. On the seeded window (a git project
// with a shell and an agent session), every right-bar pane, the Board with its edit panel, and every Settings page, the
// visible text (innerText: tooltips, input values and copy actions are not in it) has no absolute path, no UUID-like id
// and no word from the deny list below.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_PAGES } from '../src/features/builtin';
import { expect, openWindow, REPO, test } from './fixtures';
import { closeModal, openSettings } from './settings-modal';
import { BASE, buildSheetHarness, widget } from './sheet-harness-build';
import { layoutButton, lib } from './d5b';

// Internal words a user never needs to read, each matched as a whole word.
const DENY: [RegExp, string][] = [
  [/\bcore\b/i, 'the background process; the window calls it "background service" (settings.err.core)'],
  [/\bholder\b/i, 'the process that keeps a terminal alive; the user sees only the session'],
  [/\bacp\b/, 'the lowercase id of the agent protocol; upper-case ACP is its public name, which agent setup needs'],
  [/\b(needs_decision|waits_on|session_id)\b/, 'stored enum values and key names; the window has a label for each'],
  [/^(claude|codex|acp|shell) [0-9a-f]{6}$/, 'a session kind plus an id prefix, the old name of a session with no label'],
];
// Rows whose whole job is a file's location, beside its Copy and Show buttons (the brief's "copy actions" rule). The
// window has no home folder to shorten them with (the core sends absolute paths).
const PATH_ROWS = '.prv-file, .ext-dir';
// An absolute path into a home or this checkout (the test's own folders live under the checkout).
const ABS = new RegExp(`(/Users/|/home/|/private/|${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

async function scan(app: Page, where: string, ids: string[], root = 'body') {
  const text = await app.evaluate(
    ([sel, allowed]) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return '';
      const hidden = [...el.querySelectorAll<HTMLElement>(allowed)].map((n) => [n, n.style.visibility] as const);
      hidden.forEach(([n]) => (n.style.visibility = 'hidden')); // innerText leaves out visibility:hidden text
      const out = el.innerText;
      hidden.forEach(([n, v]) => (n.style.visibility = v));
      return out;
    },
    [root, PATH_ROWS] as const,
  );
  const out: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const hit = [ABS.test(line) && 'path', UUID.test(line) && 'uuid', ids.some((id) => line.includes(id)) && 'session id', ...DENY.filter(([re]) => re.test(line)).map(([re]) => `word ${re.source}`)].filter(Boolean);
    if (hit.length) out.push(`${where}: ${hit.join(', ')}: "${line.slice(0, 140)}"`);
  }
  return out;
}

test('raw_words_none_on_seeded_pages: no absolute path, UUID-like id or internal word in the visible text', async ({ app, core }) => {
  test.setTimeout(150_000);
  const dir = core.project('rawwords');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const shell = core.shell(dir, 'build');
  const agent = core.agent(dir, 'helper', path.join(dir, 'never'));
  // Ticket 471 r3: a session started with no label (New session sends none) is named after its agent, not "claude 3fa2b1".
  const bare = core.cli('session', 'start', '--kind', 'claude', '--project', dir, '--model', path.join(dir, 'never')).session as { id: string };
  const ids = [shell.id, agent.id, bare.id].flatMap((id) => [id, id.slice(0, 6)]);
  await openWindow(app, {}, core);
  await expect(app.locator('.ib.r')).toBeVisible();
  const found: string[] = [];
  found.push(...(await scan(app, 'window', ids)));
  const right = app.locator('.ib.r');
  for (const name of ['Files', 'Diff', 'Artifacts']) {
    const b = app.getByRole('button', { name, exact: true }).first();
    await b.click();
    await app.waitForTimeout(300);
    found.push(...(await scan(app, name, ids)));
    await b.click();
  }
  await right.getByRole('button', { name: /^Board( · |$)/ }).click();
  const board = app.locator('.board');
  await expect(board).toBeVisible();
  found.push(...(await scan(app, 'board', ids)));
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  await expect(app.getByRole('dialog', { name: 'Edit board widget' })).toBeVisible();
  found.push(...(await scan(app, 'board edit', ids, '[role="dialog"][aria-label="Edit board widget"]')));
  await closeModal(app);
  await openSettings(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  for (const id of [...BUILTIN_PAGES, 'extensions']) {
    await nav.locator(`button[data-page="${id}"]`).click();
    await expect(app.locator('.spage h1').first()).toBeVisible();
    await app.evaluate(() => document.querySelectorAll('.sbody details').forEach((d) => ((d as HTMLDetailsElement).open = true)));
    await app.waitForTimeout(200);
    found.push(...(await scan(app, `settings/${id}`, ids, '[role="dialog"][aria-label="Settings"]')));
  }
  expect([...new Set(found)]).toEqual([]);
});

// Ticket 551 (scorecard D9): the surfaces the first scan did not reach. An agent with a pending permission (its decision line in
// the tree, its chat with the decision card, the answer strip), the tab strip and status line, the Command palette, New
// session, Search with a hit, and a toast from a refused start. The same rules: no absolute path, UUID, session id or deny word.
test('raw_words_none_on_work_surfaces: chat, tabs, tree, palette, new session, search, permission cards and toasts', async ({ app, core }) => {
  test.setTimeout(150_000);
  const dir = core.project('rawwords2');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'needle in a haystack\n');
  const trigger = path.join(dir, 'ask');
  const shell = core.shell(dir, 'build');
  const agent = core.agent(dir, 'helper', trigger);
  const bare = core.cli('session', 'start', '--kind', 'claude', '--project', dir, '--model', path.join(dir, 'never')).session as { id: string };
  const ids = [shell.id, agent.id, bare.id].flatMap((id) => [id, id.slice(0, 6)]);
  // A refused start (the Terminal icon) is a toast in plain words; the other requests pass.
  let refuseStart = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (refuseStart && r?.request?.op === 'start') return ws.send(JSON.stringify({ id: r.id, response: { Err: 'sessions.toml: No space left on device (os error 28)' } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  await openWindow(app, {}, core);
  await expect(app.locator('.ib.r')).toBeVisible();
  fs.writeFileSync(trigger, ''); // the fake agent now asks for a permission
  await expect
    .poll(() => (core.cli('snapshot', '--json').sessions as { id: string; pending: unknown[] }[]).find((s) => s.id === agent.id)?.pending.length ?? 0)
    .toBeGreaterThan(0);
  const found: string[] = [];
  // Tree, tab strip, status line and the decision line, as the window opens.
  await expect(app.locator('.tab').first()).toBeVisible();
  found.push(...(await scan(app, 'window with a pending permission', ids)));
  // Ticket 559 (F2): the quit dialog lists the pending decision by its title, not its raw text.
  await app.evaluate(() => window.dispatchEvent(new Event('nunchiro:quit-request')));
  const quit = app.getByRole('dialog', { name: 'Quit and stop all agents' });
  await expect(quit).toContainText('Pending queue items (1)');
  found.push(...(await scan(app, 'quit dialog', ids, '[role="dialog"][aria-label="Quit and stop all agents"]')));
  await quit.getByRole('button', { name: 'Cancel' }).click();
  // The agent's chat with its decision card.
  await app.locator(`.tab[data-tab="${agent.id}"]`).click();
  await app.waitForTimeout(500);
  found.push(...(await scan(app, 'chat', ids)));
  await app.locator(`.tab[data-tab="${shell.id}"]`).click();
  await app.waitForTimeout(300);
  found.push(...(await scan(app, 'terminal tab', ids)));
  // Command palette, empty and with a query.
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  found.push(...(await scan(app, 'palette', ids, '[role="dialog"][aria-label="Command palette"]')));
  await palette.getByRole('combobox').fill('session');
  await app.waitForTimeout(200);
  found.push(...(await scan(app, 'palette query', ids, '[role="dialog"][aria-label="Command palette"]')));
  await app.keyboard.press('Escape');
  // New session (from the palette's command).
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
  await expect(app.locator('.newtab')).toBeVisible();
  found.push(...(await scan(app, 'new session', ids, '.newtab')));
  await app.keyboard.press('Escape');
  // Search with a hit, then with a query that has none.
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  const sbar = app.locator('.sbar .spanel');
  await expect(sbar).toBeVisible();
  await sbar.getByRole('searchbox').fill('needle');
  await expect(sbar.locator('.hit').first()).toBeVisible();
  found.push(...(await scan(app, 'search hit', ids, '.sbar .spanel')));
  await sbar.getByRole('searchbox').fill('no-such-words-here');
  await app.waitForTimeout(500);
  found.push(...(await scan(app, 'search none', ids, '.sbar .spanel')));
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  // The toast of a refused start, and the status line after it.
  refuseStart = true;
  await app.locator('[data-icon="terminal"] button.ai').click();
  await expect(app.locator('.toast')).toBeVisible();
  found.push(...(await scan(app, 'toast', ids)));
  // Ticket 564: the widget permission sheet, in its harness page (the sheet has no home in the app yet). Last, as it leaves the window.
  await buildSheetHarness();
  widget(core, 'open-prs');
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await app.goto(`${BASE}tests/sheet-harness.html?name=open-prs`);
  const sheet = '.ps[role="dialog"]';
  await expect(app.locator(sheet)).toBeVisible();
  await expect(app.locator('[data-field="command"]')).toBeVisible();
  found.push(...(await scan(app, 'permission sheet', ids, sheet)));
  // The scan must see the sheet: a raw core word planted in it is found (the check of ticket 564; it stays as a guard).
  await app.evaluate((sel) => document.querySelector(sel)!.insertAdjacentHTML('beforeend', '<p>the core refused this</p>'), sheet);
  expect(await scan(app, 'planted', ids, sheet)).toHaveLength(1);
  expect([...new Set(found)]).toEqual([]);
});

// Ticket 872 (scorecard D9, F9): the widget library with script widgets off names a switch, not a settings.json key, and
// its button opens Settings › Layout on that switch; turning it on there clears the note.
test('raw_words_widget_library_script_off: the off note names the Settings switch and opens it', async ({ app, core }) => {
  await openWindow(app, {}, core);
  await layoutButton(app).click();
  const note = lib(app).locator('.lnote');
  await expect(note).toContainText('script widgets off; turn on in Settings › Layout › Script widgets.');
  const found = await scan(app, 'widget library', [], '.lib');
  // The deny word for this ticket: the stored key the note used to name.
  if (/script_widgets|settings\.json/.test(await lib(app).innerText())) found.push('widget library: settings.json key');
  expect(found).toEqual([]);
  await note.getByRole('button', { name: 'Open setting' }).click();
  const box = app.locator('[data-setting="scriptWidgets"]');
  await expect(box).toBeFocused();
  await expect(app.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="layout"]')).toHaveAttribute('aria-current', /page|true/);
  await expect(box).not.toBeChecked();
  await box.click(); // checked once the core answers (a controlled box), so not check()
  await expect(box).toBeChecked();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).script_widgets).toBe(true);
  await closeModal(app);
  await expect(lib(app).locator('.lnote')).toHaveCount(0);
});
