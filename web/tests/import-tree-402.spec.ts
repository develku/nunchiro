// Ticket 402: the past-conversations row (ticket 392) after a reconnect, and a spec for each branch the first round left
// without one. A real core lists fixture agent homes; a proxy on the window's socket counts each `import_list`, can hold
// its answer, answer it busy, drop the connection, or put a session on a machine.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const rec = (o: object) => JSON.stringify(o) + '\n';
const user = (cwd: string, text: string) => rec({ type: 'user', cwd, message: { role: 'user', content: text } });
const block = (p: Page, name: string) => p.locator(`.grp[data-project="${name}"]`);
const pastRow = (p: Page, name: string) => block(p, name).locator('.row.past');

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
  await expect(block(app, 'shop').getByRole('button', { name: 'Past conversations 2' })).toBeVisible();
  expect(w.asked).toEqual([[shop]]);

  // A conversation recorded meanwhile; the same project set. A new connection asks again and the count follows.
  fs.writeFileSync(path.join(dir, 'later.jsonl'), user(shop, 'third'));
  await w.drop();
  await expect.poll(() => w.asked.length, { timeout: 10_000 }).toBe(2);
  expect(w.asked).toEqual([[shop], [shop]]);
  await expect(block(app, 'shop').getByRole('button', { name: 'Past conversations 3' })).toBeVisible();
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
  await expect(block(app, 'other').getByRole('button', { name: 'Past conversations 2' })).toBeVisible();
  await expect(block(app, 'shop').getByRole('button', { name: 'Past conversations 1' })).toBeVisible();
  expect(w.asked).toEqual([[shop], [other, shop].sort()]);
});

test('tree_past_busy_answer_retries_after_reconnect', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, 'first', 'second');
  seed(core, { op: 'add', project: shop, added: true });
  const w = await wire(app, core, { busy: 1 });
  await openWindow(app);
  await expect.poll(() => w.asked.length).toBe(1);

  // Busy: no row, and not asked again on this connection (the busy answer reached the window before this later snapshot).
  await w.later(shop, 'after');
  await expect(pastRow(app, 'shop')).toHaveCount(0);
  expect(w.asked).toEqual([[shop]]);

  // A new connection asks again; this time the core answers.
  await w.drop();
  await expect(block(app, 'shop').getByRole('button', { name: 'Past conversations 2' })).toBeVisible({ timeout: 10_000 });
  expect(w.asked).toEqual([[shop], [shop]]);
});

test('tree_past_old_connection_answer_is_not_drawn_over_the_new_one', async ({ app, core }) => {
  const shop = core.project('shop');
  const dir = transcripts(core, shop, 'first', 'second');
  seed(core, { op: 'add', project: shop, added: true });
  const w = await wire(app, core, { hold: true });
  await openWindow(app);
  await expect.poll(() => w.asked.length).toBe(1);
  await expect.poll(() => w.held()).toBe(1); // else the drop beats the core's answer and the new connection's is held

  // The first answer (two conversations) is still in flight when the connection drops; a third is recorded meanwhile.
  fs.writeFileSync(path.join(dir, 'later.jsonl'), user(shop, 'third'));
  await w.drop();
  await expect(block(app, 'shop').getByRole('button', { name: 'Past conversations 3' })).toBeVisible({ timeout: 10_000 });
  expect(w.asked).toEqual([[shop], [shop]]);

  // The old answer arrives late, on the new connection: it answers nothing the window asked there.
  w.release();
  await w.later(shop, 'after');
  await expect(pastRow(app, 'shop')).toHaveAccessibleName('Past conversations 3');
  expect(w.asked).toEqual([[shop], [shop]]);
});

test('tree_past_more_row_shows_the_rest', async ({ app, core }) => {
  const shop = core.project('shop');
  const texts = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  transcripts(core, shop, ...texts);
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await block(app, 'shop').getByRole('button', { name: 'Past conversations 7' }).click();
  const items = block(app, 'shop').locator('.row.pitem:not(.more)');
  await expect(items.locator('.n')).toHaveText(texts.slice(0, 5));
  const more = block(app, 'shop').getByRole('button', { name: '2 more' });
  await expect(more).toBeVisible();
  await more.click();
  await expect(items.locator('.n')).toHaveText(texts);
  await expect(block(app, 'shop').locator('.row.more')).toHaveCount(0);
});

test('tree_past_untitled_conversation_has_a_name', async ({ app, core }) => {
  const shop = core.project('shop');
  transcripts(core, shop, '');
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await block(app, 'shop').getByRole('button', { name: 'Past conversations 1' }).click();
  const item = block(app, 'shop').locator('.row.pitem').first();
  await expect(item.locator('.n')).toHaveText('Untitled conversation');
  await expect(item).toHaveAccessibleName(/^Untitled conversation, Claude, .+, read-only$/);
  await expect(item).toHaveAttribute('title', 'Untitled conversation');
});

test('tree_past_failure_line_under_the_item', async ({ app, core }) => {
  const shop = core.project('shop');
  const dir = transcripts(core, shop, 'gone later', 'still here');
  seed(core, { op: 'add', project: shop, added: true });
  await openWindow(app);
  await block(app, 'shop').getByRole('button', { name: 'Past conversations 2' }).click();
  const items = block(app, 'shop').locator('.row.pitem');
  await expect(items.locator('.n')).toHaveText(['gone later', 'still here']);

  // The transcript is gone before the click: the import is refused, the line says so under that item, no tab opens.
  fs.rmSync(path.join(dir, 'shop-0.jsonl'));
  await items.first().click();
  const alert = block(app, 'shop').getByRole('alert');
  await expect(alert).toHaveText(/^Could not open it: .*claude:shop-0/);
  await expect(alert).toHaveClass('pastfail');
  await expect(block(app, 'shop').locator('[data-past="claude:shop-0"] + .pastfail')).toHaveCount(1);
  await expect(app.locator('.tab[data-tab^="imported:"]')).toHaveCount(0);

  // The other one opens, and the line goes.
  await items.nth(1).click();
  await expect(app.locator('.tab[data-tab="imported:claude:shop-1"]')).toHaveAttribute('aria-selected', 'true');
  await expect(block(app, 'shop').getByRole('alert')).toHaveCount(0);
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
  await expect(block(app, 'shop').getByRole('button', { name: 'Past conversations 1' })).toBeVisible();
  await expect(block(app, 'far')).toBeVisible();
  await expect(pastRow(app, 'far')).toHaveCount(0);
  expect(w.asked).toEqual([[shop]]);
});
