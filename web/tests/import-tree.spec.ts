// Ticket 392 (mock providers-391 scene e): a project in the tree lists that folder's past Claude and Codex conversations,
// read-only; a click imports that one conversation and opens it read-only. Ticket 1073: the tree's fold is gone; the
// conversations are rows of History's one list (history/pastChats.ts keeps the same store), asked once History is open. Each test runs a
// real core on fixture agent homes (CLAUDE_CONFIG_DIR / CODEX_HOME), which must stay byte-identical.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const rec = (o: object) => JSON.stringify(o) + '\n';
const user = (cwd: string, text: string) => rec({ type: 'user', cwd, message: { role: 'user', content: text } });

/** Two conversations recorded in `shop`, one in a sub-folder, one in a sibling folder: only the first two are its own. */
function transcripts(core: Core, shop: string) {
  const claude = path.join(core.home, 'claude-home/projects/-shop');
  fs.mkdirSync(claude, { recursive: true });
  const at = (f: string, secsAgo: number) => fs.utimesSync(f, new Date(Date.now() - secsAgo * 1000), new Date(Date.now() - secsAgo * 1000));
  const write = (name: string, cwd: string, text: string, secsAgo: number) => {
    fs.writeFileSync(path.join(claude, name), user(cwd, text));
    at(path.join(claude, name), secsAgo);
  };
  write('c1.jsonl', shop, 'webhook retry with backoff', 60);
  write('c3.jsonl', path.join(shop, 'sub'), 'a sub-folder conversation', 30);
  const codex = path.join(core.home, 'codex-home/sessions/2026/10/27');
  fs.mkdirSync(codex, { recursive: true });
  const meta = (cwd: string) => rec({ type: 'session_meta', payload: { id: 'x', cwd } });
  const msg = (text: string) => rec({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const x1 = path.join(codex, 'rollout-2026-10-27T10-00-00-x1.jsonl');
  fs.writeFileSync(x1, meta(shop) + msg('order API tests'));
  at(x1, 3 * 86_400);
  const x2 = path.join(codex, 'rollout-2026-10-27T10-00-00-x2.jsonl');
  fs.writeFileSync(x2, meta(`${shop}-other`) + msg('a sibling folder conversation'));
}
/** Hash of every file under the agent homes (name, bytes, mtime). */
function digest(core: Core) {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(p)).update(String(fs.statSync(p).mtimeMs));
    }
  };
  for (const r of ['claude-home', 'codex-home']) if (fs.existsSync(path.join(core.home, r))) walk(path.join(core.home, r));
  return h.digest('hex');
}
/** Every `import_list` the window sends (its `projects`), and every request's op with the core's answer by frame id. */
function lists(p: Page) {
  const asked: (string[] | undefined)[] = [];
  const ops = new Map<number, string>();
  const answers: { op: string; ok: boolean; err?: string }[] = [];
  p.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload));
        // Ticket 1123: the first run's Quick setup lists Claude's folders (folders_only), apart from the tree's listing.
        const folders = m?.request?.op === 'import_list' && m.request.folders_only;
        if (m?.request?.op) ops.set(m.id, folders ? 'import_folders' : m.request.op);
        if (m?.request?.op === 'import_list' && !folders) asked.push(m.request.projects);
      } catch {
        /* not JSON */
      }
    });
    ws.on('framereceived', (f) => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m?.response && ops.has(m.id)) answers.push({ op: ops.get(m.id)!, ok: 'Ok' in m.response, err: m.response.Err });
      } catch {
        /* not JSON */
      }
    });
  });
  return Object.assign(asked, { answers });
}
/** History's rows for the on-disk conversations of project folder `name`. */
const past = (p: Page, name: string) => p.locator(`[data-history-view] .hr[data-outside][data-project$="/${name}"]`);
const openHistory = (p: Page) => p.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();
const C1 = 'claude:c1';

test('tree_past_row_lists_and_opens_read_only', async ({ app, core }) => {
  const shop = core.project('shop');
  const empty = core.project('empty');
  transcripts(core, shop);
  seed(core, { op: 'add', project: shop, added: true }, { op: 'add', project: empty, added: true });
  const before = digest(core);
  const asked = lists(app);
  await openWindow(app);
  await openHistory(app);

  // Its own two, newest first; the sub-folder and the sibling folder are left out; a project with none has no row.
  const items = past(app, 'shop');
  await expect(items.locator('.hr-go b')).toHaveText(['webhook retry with backoff', 'order API tests']);
  await expect(past(app, 'empty')).toHaveCount(0);
  const hist = app.locator('[data-history-view]');
  await expect(hist).not.toContainText('sub-folder');
  await expect(hist).not.toContainText('sibling');
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/import-tree-${test.info().project.name}.png`) });

  // A click opens the existing read-only view: the note, and no composer.
  await items.first().locator('.hr-go').click();
  const tab = app.locator(`.tab[data-tab="imported:${C1}"]`);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const view = app.locator(`.fview[data-imported="${C1}"]`);
  await expect(view.locator('.msg.user')).toContainText('webhook retry with backoff');
  await expect(view.getByRole('note')).toHaveText('Imported · read-only');
  await expect(app.locator('textarea:visible')).toHaveCount(0);
  // Again: the same tab, not a second one.
  await items.first().locator('.hr-go').click();
  await expect(app.locator('.tab[data-tab^="imported:"]')).toHaveCount(1);
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  // Asked once, for both projects together; the agent homes are unchanged, only Nunchiro's own import.json is new.
  expect([...asked]).toEqual([[empty, shop].sort()]);
  expect(digest(core)).toBe(before);
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'import.json'), 'utf8')).map((s: { id: string }) => s.id)).toEqual([C1]);
});

test('tree_past_row_by_keyboard', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop);
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await openHistory(app);
  const first = past(app, 'shop').first().locator('.hr-go');
  await first.focus();
  await expect(first).toHaveAccessibleName('webhook retry with backoff');
  await app.keyboard.press('Enter');
  await expect(app.locator(`.tab[data-tab="imported:${C1}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('tree_past_titles_are_plain_text', async ({ app, core }) => {
  const shop = core.project('shop');
  const dir = path.join(core.home, 'claude-home/projects/-shop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'h1.jsonl'), user(shop, '<img src=x onerror="window.__pwned=1"><b>bold</b>'));
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await openHistory(app);
  const item = past(app, 'shop').first();
  await expect(item.locator('.hr-go b')).toHaveText('<img src=x onerror="window.__pwned=1"><b>bold</b>');
  await expect(item.locator('.hr-go img, .hr-go b b')).toHaveCount(0);
  expect(await app.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});

test.describe('round 2: one listing for the whole tree', () => {
  // A first run also asks `first_run` at start: it must still be answered next to the listing.
  test.use({ firstRun: true });
  test('tree_past_rows_for_six_projects_from_one_request', async ({ app, core }) => {
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const dir = path.join(core.home, 'claude-home/projects/-many');
    fs.mkdirSync(dir, { recursive: true });
    const projects = names.map((n, i) => {
      const project = core.project(n);
      for (let k = 0; k <= i; k++) fs.writeFileSync(path.join(dir, `${n}-${k}.jsonl`), user(project, `${n} conversation ${k}`));
      return project;
    });
    // Plenty of unrelated transcripts: one scan reads them once, whatever the number of projects.
    for (let k = 0; k < 60; k++) fs.writeFileSync(path.join(dir, `other-${k}.jsonl`), user('/somewhere/else', `other ${k}`));
    seed(core, ...projects.map((project) => ({ op: 'add', project, added: true })));
    const before = digest(core);
    const asked = lists(app);
    await openWindow(app);
    await app.keyboard.press('Escape'); // the first run's Settings page covers the bars
    await openHistory(app);
    for (const [i, n] of names.entries()) await expect(past(app, n)).toHaveCount(i + 1);
    // Exactly one listing went out, naming every project; the start requests still got their answers.
    expect([...asked]).toEqual([[...projects].sort()]);
    expect(asked.answers.filter((a) => a.op === 'import_list').map((a) => a.ok)).toEqual([true]);
    await expect.poll(() => asked.answers.find((a) => a.op === 'first_run')?.ok, { timeout: 15_000 }).toBe(true);
    expect(asked.answers.filter((a) => /too many requests/.test(a.err ?? ''))).toEqual([]);
    expect(digest(core)).toBe(before);
  });
});

// Look 1117 v4 (home N11): a conversation still live in a session of the project was listed under Past conversations.
test('tree_past_row_leaves_out_live_conversations (N11)', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop);
  const live = core.shell(shop, 'live-one');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const f = JSON.parse(m);
      for (const s of f.sessions ?? []) if (s.id === live.id) s.agent_session_id = 'c1';
      ws.send(JSON.stringify(f));
    });
  });
  await openWindow(app);
  await openHistory(app);
  await expect(past(app, 'shop').locator('.hr-go b')).toHaveText(['order API tests']);
});
