// Ticket 402: the past-conversations row (ticket 392) after a reconnect, and a spec for each branch the first round left
// without one. Ticket 1073: the rows are History's now (asked once History is open); the store and its asks are the same. A real core lists fixture agent homes; a proxy on the window's socket counts each `import_list`, can hold
// its answer, answer it busy, drop the connection, or put a session on a machine.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const rec = (o: object) => JSON.stringify(o) + '\n';
const user = (cwd: string, text: string) => rec({ type: 'user', cwd, message: { role: 'user', content: text } });
const block = (p: Page, name: string) => p.locator(`.grp[data-project="${name}"]`);
/** History's rows for the on-disk conversations of project folder `name`. */
const pastRow = (p: Page, name: string) => p.locator(`[data-history-view] .hr[data-outside][data-project$="/${name}"]`);
const openHistory = (p: Page) => p.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();

/** Claude transcripts recorded in `project`, newest first (one minute apart). */
function transcripts(core: Core, project: string, ...texts: string[]) {
  const dir = path.join(core.home, 'claude-home/projects', `-${path.basename(project)}`);
  fs.mkdirSync(dir, { recursive: true });
  texts.forEach((text, i) => {
    const f = path.join(dir, `${path.basename(project)}-${i}.jsonl`);
    fs.writeFileSync(f, text === '' ? rec({ type: 'summary', cwd: project }) : user(project, text));
    const at = new Date(Date.now() - (i + 1) * 60_000);
    fs.utimesSync(f, at, at);
  });
  return dir;
}

const parse = (m: string | Buffer) => {
  try {
    return typeof m === 'string' ? JSON.parse(m) : null;
  } catch {
    return null;
  }
};

/** The proxy. `busy`: answer that many first listings "too many requests"; `hold`: keep the first listing's answer until
 * `release`, which sends it on the newest connection; `machine`: session labels set on machine "mini" in every snapshot. */
async function wire(app: Page, core: Core, o: { busy?: number; hold?: boolean; machine?: string[] } = {}) {
  const asked: string[][] = [];
  const held: (string | Buffer)[] = [];
  const conns: { ws: WebSocketRoute; server: WebSocketRoute }[] = [];
  let busy = o.busy ?? 0;
  let hold = o.hold ?? false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    conns.push({ ws, server });
    const listings = new Set<number>();
    ws.onMessage((m) => {
      const msg = parse(m);
      if (msg?.request?.op === 'import_list') {
        asked.push(msg.request.projects);
        if (busy > 0) {
          busy--;
          return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'too many requests' } }));
        }
        listings.add(msg.id);
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = parse(m);
      if (o.machine && msg?.event === 'snapshot') {
        for (const s of msg.sessions) if (o.machine.includes(s.label)) s.machine = 'mini';
        return ws.send(JSON.stringify(msg));
      }
      if (hold && typeof msg?.id === 'number' && listings.has(msg.id)) {
        hold = false;
        return void held.push(m);
      }
      ws.send(m);
    });
  });
  return {
    asked,
    /** A later snapshot, drawn: a session started now shows in `project`'s block. Whatever the window did on the snapshots
     * before it (an ask, a row) has happened by then. */
    later: async (project: string, label: string) => {
      core.shell(project, label);
      await expect(block(app, path.basename(project)).getByText(label, { exact: true })).toBeVisible();
    },
    /** Answers held so far: the first listing's answer has reached the proxy once this is 1. */
    held: () => held.length,
    release: () => held.splice(0).forEach((m) => conns.at(-1)!.ws.send(m)),
    /** Closes the window's connection (both sides); the window reconnects on its own. */
    drop: async () => {
      const c = conns.at(-1)!;
      await c.ws.close();
      await c.server.close();
    },
  };
}

test('tree_past_asks_again_after_reconnect', async ({ app, core }) => {
  const shop = core.project('shop');
  const dir = transcripts(core, shop, 'first', 'second');
  seed(core, { op: 'add', project: shop, added: true });
  const w = await wire(app, core);
  await openWindow(app);
  await openHistory(app);
  await expect(pastRow(app, 'shop')).toHaveCount(2);
  expect(w.asked).toEqual([[shop]]);

  // A conversation recorded meanwhile; the same project set. A new connection asks again and the count follows.
  fs.writeFileSync(path.join(dir, 'later.jsonl'), user(shop, 'third'));
  await w.drop();
  await expect.poll(() => w.asked.length, { timeout: 10_000 }).toBe(2);
  expect(w.asked).toEqual([[shop], [shop]]);
  await expect(pastRow(app, 'shop')).toHaveCount(3);
  // The answer drawn and a later snapshot after it: still two asks, so a third one fails here.
  await w.later(shop, 'after');
  expect(w.asked).toEqual([[shop], [shop]]);
});

test('tree_past_set_change_while_asking_asks_the_new_set_after', async ({ app, core }) => {
  const shop = core.project('shop');
  const other = core.project('other');
  transcripts(core, shop, 'in shop');
  transcripts(core, other, 'in other', 'in other again');
  seed(core, { op: 'add', project: shop, added: true });
  const w = await wire(app, core, { hold: true });
  await openWindow(app);
  await openHistory(app);
  await expect.poll(() => w.asked.length).toBe(1);

  // A new project while the first listing is unanswered: no second ask in flight.
  core.shell(other, 'cat');
  await expect(block(app, 'other')).toBeVisible();
  await w.later(other, 'after');
  expect(w.asked).toEqual([[shop]]);
  await expect(pastRow(app, 'shop')).toHaveCount(0);

  // The first answer lands, then the newest set is asked once.
  await expect.poll(() => w.held()).toBe(1);
  w.release();
  await expect(pastRow(app, 'other')).toHaveCount(2);
  await expect(pastRow(app, 'shop')).toHaveCount(1);
  expect(w.asked).toEqual([[shop], [other, shop].sort()]);
});

test('tree_past_busy_answer_retries_after_reconnect', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'first', 'second');
  seed(core, { op: 'add', project: shop, added: true });
  const w = await wire(app, core, { busy: 1 });
  await openWindow(app);
  await openHistory(app);
  await expect.poll(() => w.asked.length).toBe(1);

  // Busy: no row, and not asked again on this connection (the busy answer reached the window before this later snapshot).
  await w.later(shop, 'after');
  await expect(pastRow(app, 'shop')).toHaveCount(0);
  expect(w.asked).toEqual([[shop]]);

  // A new connection asks again; this time the core answers.
  await w.drop();
  await expect(pastRow(app, 'shop')).toHaveCount(2, { timeout: 10_000 });
  expect(w.asked).toEqual([[shop], [shop]]);
});

test('tree_past_old_connection_answer_is_not_drawn_over_the_new_one', async ({ app, core }) => {
  const shop = core.project('shop');
  const dir = transcripts(core, shop, 'first', 'second');
  seed(core, { op: 'add', project: shop, added: true });
  const w = await wire(app, core, { hold: true });
  await openWindow(app);
  await openHistory(app);
  await expect.poll(() => w.asked.length).toBe(1);
  await expect.poll(() => w.held()).toBe(1); // else the drop beats the core's answer and the new connection's is held

  // The first answer (two conversations) is still in flight when the connection drops; a third is recorded meanwhile.
  fs.writeFileSync(path.join(dir, 'later.jsonl'), user(shop, 'third'));
  await w.drop();
  await expect(pastRow(app, 'shop')).toHaveCount(3, { timeout: 10_000 });
  expect(w.asked).toEqual([[shop], [shop]]);

  // The old answer arrives late, on the new connection: it answers nothing the window asked there.
  w.release();
  await w.later(shop, 'after');
  await expect(pastRow(app, 'shop')).toHaveCount(3);
  expect(w.asked).toEqual([[shop], [shop]]);
});

test('tree_past_more_row_shows_the_rest', async ({ app, core }) => {
  // Ticket 1073: History lists every one (the tree's fold showed five and a "more" row).
  const shop = core.project('shop');
  const texts = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  transcripts(core, shop, ...texts);
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await openHistory(app);
  await expect(pastRow(app, 'shop').locator('.hr-go b')).toHaveText(texts);
});

test('tree_past_untitled_conversation_has_a_name', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, '');
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await openHistory(app);
  const item = pastRow(app, 'shop').first().locator('.hr-go');
  await expect(item).toHaveText('Untitled conversation');
  await expect(item).toHaveAttribute('title', 'Untitled conversation');
});

test('tree_past_failure_line_under_the_item', async ({ app, core }) => {
  const shop = core.project('shop');
  const dir = transcripts(core, shop, 'gone later', 'still here');
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await openHistory(app);
  const items = pastRow(app, 'shop');
  await expect(items.locator('.hr-go b')).toHaveText(['gone later', 'still here']);

  // The transcript is gone before the click: the import is refused, the line says so in that row, no tab opens.
  fs.rmSync(path.join(dir, 'shop-0.jsonl'));
  await items.first().locator('.hr-go').click();
  const alert = app.locator('[data-history-view]').getByRole('alert');
  await expect(alert).toHaveText(/^Could not open it: .*claude:shop-0/);
  await expect(app.locator('[data-history="claude:shop-0"] .hr-fail')).toHaveCount(1);
  await expect(app.locator('.tab[data-tab^="imported:"]')).toHaveCount(0);

  // The other one opens.
  await items.nth(1).locator('.hr-go').click();
  await expect(app.locator('.tab[data-tab="imported:claude:shop-1"]')).toHaveAttribute('aria-selected', 'true');
});

test('tree_past_machine_project_is_never_asked', async ({ app, core }) => {
  const shop = core.project('shop');
  const far = core.project('far');
  transcripts(core, shop, 'in shop');
  transcripts(core, far, 'in far');
  seed(core, { op: 'add', project: shop, added: true });
  core.shell(far, 'there');
  const w = await wire(app, core, { machine: ['there'] });
  await openWindow(app);
  await openHistory(app);
  await expect(pastRow(app, 'shop')).toHaveCount(1);
  await expect(block(app, 'far')).toBeVisible();
  await expect(pastRow(app, 'far')).toHaveCount(0);
  expect(w.asked).toEqual([[shop]]);
});
