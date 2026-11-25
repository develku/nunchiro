// Ticket 1073 (owner 11-23): History always has a place, and sessions and past conversations are one list. History is a
// placed icon of the right bar (a fresh arrangement has it; a saved one gains it once and keeps it removed), the palette
// opens it, and the tree's "Past conversations" fold moved into History's day list: a conversation on disk that a listed
// session ran is that session's row only; one started in a terminal is a rail row with a terminal glyph, View and Continue.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { bar, drag, endEdit, names, readLayout, startEdit, toast } from './d5b';
import { seed } from './tree-seed';

const rec = (o: object) => JSON.stringify(o) + '\n';
/** Claude transcripts `<stem>.jsonl` recorded in `project` (the stem is the conversation id), one minute apart. */
function transcripts(core: Core, project: string, ...stems: string[]) {
  const dir = path.join(core.home, 'claude-home/projects', `-${path.basename(project)}`);
  fs.mkdirSync(dir, { recursive: true });
  stems.forEach((stem, i) => {
    const f = path.join(dir, `${stem}.jsonl`);
    fs.writeFileSync(f, rec({ type: 'user', cwd: project, message: { role: 'user', content: `talk ${stem}` } }));
    const at = new Date(Date.now() - (i + 1) * 60_000);
    fs.utimesSync(f, at, at);
  });
}
const historyIcon = (app: Page) => bar(app, 'right').getByRole('button', { name: 'History', exact: true });
const hist = (app: Page) => app.locator('[data-history-view]');

test('history_placed_in_a_fresh_arrangement', async ({ app }) => {
  await openWindow(app);
  await expect(historyIcon(app)).toBeVisible();
  // Placed, not drawn into a free slot: Layout edit (which shows only placed icons) has it too, after Artifacts.
  await startEdit(app);
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']);
});

test('history_icon_dragged_over_the_main_area_is_refused (review 1073)', async ({ app, core }) => {
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  await openWindow(app);
  await startEdit(app);
  const main = (await app.locator('.layout').boundingBox())!;
  // Over the middle of the main area (no edge band), held: the drop says why; then released there.
  await drag(app, historyIcon(app), { x: main.x + main.width / 2, y: main.y + main.height / 2 }, { release: false });
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('History stays on a bar');
  await app.mouse.up();
  // The window is alive, History stays in its slot, and no zone took it.
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']);
  await expect(toast(app)).toContainText('History stays on a bar');
  await endEdit(app);
  await expect(historyIcon(app)).toBeVisible();
  // Done may write the default layout.toml; whatever it holds, History is in no zone.
  expect(readLayout(core)).not.toContain('history');
  expect(errors).toEqual([]);
});

test('history_joins_a_saved_arrangement_once_and_stays_removed', async ({ app }) => {
  const right = ['board', 'decisions', 'terminal', 'browser', 'diff', 'artifacts', null, null, null, 'layout'];
  const saved = { left: ['tree', 'files', 'search', null, null, null, null, null, null, 'settings'], right, active: { left: 'tree', right: null }, placed: 2 };
  // Seeded once: the reload below reads what the window saved.
  await app.addInitScript((b) => sessionStorage.getItem('seeded') || (localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bars: b })), sessionStorage.setItem('seeded', '1')), saved);
  await openWindow(app);
  await startEdit(app);
  expect(await names(app, 'right')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Layout']);
  await bar(app, 'right').getByRole('button', { name: 'Remove History from the right bar' }).click();
  await endEdit(app);
  await expect(historyIcon(app)).toHaveCount(0);
  await app.reload();
  await openWindow(app);
  await expect(bar(app, 'right').getByRole('button', { name: 'Board', exact: true })).toBeVisible();
  await expect(historyIcon(app)).toHaveCount(0);
  // The palette still opens it.
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('Open History');
  await palette.getByRole('combobox').press('Enter');
  await expect(hist(app)).toBeVisible();
});

test('history_open_from_the_palette', async ({ app }) => {
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('Open History');
  await expect(palette.locator('[data-command="history.open"]')).toBeVisible();
  await palette.getByRole('combobox').press('Enter');
  await expect(hist(app)).toBeVisible();
});

test('history_one_list_of_sessions_and_conversations', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'c1', 'c2');
  // A finished session that ran conversation c1 (the snapshot says so); c2 was started in a terminal.
  const ran = core.shell(shop, 'ran', '/usr/bin/true').id;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const f = JSON.parse(m);
      for (const s of f.sessions ?? []) if (s.id === ran) s.agent_session_id = 'c1';
      ws.send(JSON.stringify(f));
    });
  });
  await openWindow(app);
  await historyIcon(app).click();
  const out = hist(app).locator('.hr[data-outside]');
  // c1 is the session's row only; c2 is its own row, in the same day's list as the session.
  await expect(out).toHaveCount(1);
  await expect(hist(app).locator('[data-history="claude:c1"]')).toHaveCount(0);
  await expect(hist(app).locator(`[data-history="${ran}"]`)).toHaveCount(1);
  await expect(hist(app).locator('.histv-day')).toHaveCount(1);
  await expect(hist(app).locator('.histv-day .dbar .num')).toHaveText('2');

  // The rail row: the agent icon, the title, its time, no run length, the muted line, the terminal glyph before the project.
  const row = hist(app).locator('[data-history="claude:c2"]');
  await expect(row.locator('.hr-rail')).toHaveCount(1);
  await expect(row.locator('.hr-ag')).toHaveAccessibleName('Claude');
  await expect(row.locator('.hr-go b')).toHaveText('talk c2');
  await expect(row.locator('.hr-st')).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(row.locator('.hr-len')).toHaveCount(0);
  await expect(row.locator('.hr-sum')).toHaveText('Started in a terminal');
  await expect(row.locator('.hr-pj')).toHaveText('shop');
  await expect(row.locator('.hr-pj .hr-tm [data-icon="shell"]')).toBeVisible();
  await expect(row.locator('.hr-pj .hr-tm')).toHaveAccessibleName('Started in a terminal');
  // Hover: View conversation and Continue, no View changes.
  await row.hover();
  await expect(row.locator('.hr-acts button')).toHaveCount(2);
  await expect(row.locator('.hr-acts').getByRole('button', { name: 'View conversation' })).toBeVisible();
  await expect(row.locator('.hr-acts').getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(row.locator('.hr-acts').getByRole('button', { name: 'View changes' })).toHaveCount(0);
  await hist(app).screenshot({ path: path.join(REPO, `.scratch/shots/history-1073-one-list-${test.info().project.name}.png`) });
  await row.locator('.hr-acts').getByRole('button', { name: 'View conversation' }).click();
  await expect(app.locator('.tab[data-tab="imported:claude:c2"]')).toHaveAttribute('aria-selected', 'true');

  // The filter: only conversations started outside Nunchiro, then both again. Search covers both kinds.
  const outside = hist(app).getByRole('button', { name: 'Started outside Nunchiro' });
  await outside.click();
  await expect(outside).toHaveAttribute('aria-pressed', 'true');
  await expect(hist(app).locator('[data-history]')).toHaveCount(1);
  await expect(row).toBeVisible();
  await outside.click();
  await expect(hist(app).locator('[data-history]')).toHaveCount(2);
  await hist(app).getByRole('searchbox').fill('talk c2');
  await expect(hist(app).locator('[data-history]')).toHaveCount(1);
  await hist(app).getByRole('searchbox').fill('ran');
  await expect(hist(app).locator('[data-history]')).toHaveCount(1);
  await expect(hist(app).locator(`[data-history="${ran}"]`)).toHaveCount(1);

  // The tree has no "Past conversations" fold; the project is still a row.
  const block = app.locator('.grp[data-project="shop"]');
  await expect(block).toBeVisible();
  await expect(block.locator('.row.past')).toHaveCount(0);
  await expect(app.locator('nav').getByText('Past conversations')).toHaveCount(0);
});

// Review round 2: a closed session leaves the snapshot; its conversation is still Nunchiro's, never "started in a terminal".
test('history_closed_session_conversation_is_not_from_a_terminal', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'c1', 'c2');
  const ran = core.shell(shop, 'ran', '/usr/bin/true').id;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const f = JSON.parse(m);
      for (const s of f.sessions ?? []) if (s.id === ran) s.agent_session_id = 'c1';
      ws.send(JSON.stringify(f));
    });
  });
  await openWindow(app);
  await historyIcon(app).click();
  await expect(hist(app).locator(`[data-history="${ran}"]`)).toHaveCount(1);
  await expect(hist(app).locator('[data-history="claude:c2"][data-outside]')).toHaveCount(1);
  core.cli('session', 'close', ran);
  await expect(hist(app).locator(`[data-history="${ran}"]`)).toHaveCount(0); // the closed row left the snapshot
  // c1 once, a plain row: no terminal line, no terminal glyph.
  const mine = hist(app).locator('[data-history="claude:c1"]');
  await expect(mine).toHaveCount(1);
  await expect(mine).not.toHaveAttribute('data-outside');
  await expect(mine.locator('.hr-sum')).toHaveText('');
  await expect(mine.locator('.hr-tm')).toHaveCount(0);
  await expect(hist(app)).not.toContainText(/Started in a terminal[\s\S]*Started in a terminal/); // only c2 says it
  // The outside filter lists c2 only.
  await hist(app).getByRole('button', { name: 'Started outside Nunchiro' }).click();
  await expect(hist(app).locator('[data-history]')).toHaveCount(1);
  await expect(hist(app).locator('[data-history="claude:c2"]')).toHaveCount(1);
});

// Review round 2: what the core keeps (ran.json) marks it in a fresh window too, with no session row left anywhere.
test('history_ran_json_marks_a_conversation_in_a_fresh_window', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'c1', 'c2');
  fs.writeFileSync(path.join(core.home, 'ran.json'), JSON.stringify(['c1']));
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await historyIcon(app).click();
  await expect(hist(app).locator('[data-history="claude:c1"][data-own]')).toHaveCount(1);
  await expect(hist(app).locator('[data-history="claude:c1"] .hr-sum')).toHaveText('');
  await expect(hist(app).locator('[data-history="claude:c2"][data-outside]')).toHaveCount(1);
  await hist(app).getByRole('button', { name: 'Started outside Nunchiro' }).click();
  await expect(hist(app).locator('[data-history]')).toHaveCount(1);
});

// Review round 3: a home from before ran.json (the old session's chat record `chat/claude-<id>.json`, no ran.json) is
// seeded at the first start of the new core: that conversation is no terminal one; a true terminal one keeps its label;
// a second start changes nothing.
test('history_old_home_is_seeded_from_chat_records_once', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'c1', 'c2');
  seed(core, { op: 'add', project: shop, added: true });
  const ran = path.join(core.home, 'ran.json');
  fs.mkdirSync(path.join(core.home, 'chat'), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'chat', 'claude-c1.json'), '{}');
  core.run(['serve', 'stop'], 10_000);
  fs.rmSync(ran, { force: true });
  await core.restart();
  const first = fs.readFileSync(ran, 'utf8');
  expect(JSON.parse(first)).toEqual({ seeded: true, conversations: ['c1'] });
  await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot()); // the restarted core's token
  await openWindow(app);
  await historyIcon(app).click();
  const mine = hist(app).locator('[data-history="claude:c1"]');
  await expect(mine).toHaveAttribute('data-own', '');
  await expect(mine).not.toHaveAttribute('data-outside');
  await expect(mine.locator('.hr-sum')).toHaveText('');
  await expect(mine.locator('.hr-tm')).toHaveCount(0);
  const terminal = hist(app).locator('[data-history="claude:c2"]');
  await expect(terminal).toHaveAttribute('data-outside', '');
  await expect(terminal.locator('.hr-sum')).toHaveText('Started in a terminal');
  await hist(app).getByRole('button', { name: 'Started outside Nunchiro' }).click();
  await expect(hist(app).locator('[data-history]')).toHaveCount(1);
  await expect(terminal).toHaveCount(1);
  // A second start: the record is not seeded again (a chat record added now is not read).
  fs.writeFileSync(path.join(core.home, 'chat', 'claude-c2.json'), '{}');
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
  expect(fs.readFileSync(ran, 'utf8')).toBe(first);
});

test('history_project_with_only_terminal_conversations_is_a_tree_row', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'c9');
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await expect(app.locator('.grp[data-project="shop"]')).toBeVisible();
  await historyIcon(app).click();
  await expect(hist(app).locator('[data-history="claude:c9"]')).toBeVisible();
  await expect(app.locator('.grp[data-project="shop"]').getByText('Past conversations')).toHaveCount(0);
});
