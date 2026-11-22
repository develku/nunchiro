// v1b-18: needs-decision board cards in the strip and the tree action rows, against a real core with a file
// integration source (no agent). Timing over 30 runs is scripts/scenario/v1b-board-queue.sh.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { boxes, expect, HANGUL, openWindow, stripOnTop, test, unmoved, type Core } from './fixtures';

/** board.toml with a needs-decision column and one file source, `roadmap`, at <home>/cards.json. */
function board(core: Core) {
  const toml = `version = 1
[[columns]]
id = 'working'
title = 'Working'
states = ['working']
[[columns]]
id = 'ask'
title = 'Needs decision'
needs_decision = true
states = ['needs_decision']
[sources]
version = 1
[[sources.entries]]
name = 'roadmap'
kind = 'file'
path = ${JSON.stringify(path.join(core.home, 'cards.json'))}
`;
  fs.writeFileSync(path.join(core.home, 'board.toml'), toml);
  cards(core, []);
}
function cards(core: Core, list: object[]) {
  const tmp = path.join(core.home, 'cards.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ cards: list }));
  fs.renameSync(tmp, path.join(core.home, 'cards.json'));
}
const flag = (id: string, question: string, extra: object = {}) => ({ id, title: `Card ${id}`, updated_at: 1, needs_decision: { question }, ...extra });
/** One owner request over the core's unix socket (what the CLI and the board widget send). */
function owner(core: Core, request: object): Promise<{ Ok?: Record<string, unknown>; Err?: string }> {
  const token = fs.readFileSync(path.join(core.home, 'core.token'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(core.home, 'core.sock'));
    let data = '';
    s.on('data', (b) => (data += b.toString('utf8')));
    s.on('end', () => resolve(JSON.parse(data)));
    s.on('error', reject);
    s.write(JSON.stringify({ token, request }) + '\n');
  });
}
const resolved = (core: Core) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(core.home, 'board.json'), 'utf8')).resolved ?? null;
  } catch {
    return null;
  }
};
const card = (page: Page, id: string) => page.locator(`.qcard[data-kind="board"][data-item="${id}"]`);
const row = (page: Page, id: string) => page.locator(`.tree .q[data-item="${id}"]`);

// needs 107 (ticket 180): the strip is not drawn above the composer; this spec is about the strip, so it sits under it.
test.beforeEach(({ core }) => stripOnTop(core, { below: true }));

test('a flagged card shows in the strip and its project’s tree slot; an unknown project in the strip only', async ({ app, core }) => {
  board(core);
  const p = core.project('alpha');
  core.shell(p, 'alpha shell');
  await openWindow(app);
  cards(core, [flag('known', 'Ship alpha?', { project: p }), flag('lost', 'Whose is this?', { project: '/nowhere' }), flag('none', 'No project?')]);
  // V1A-60b: the oldest holds the strip's one line; the other two are its +2.
  await expect(card(app, 'integration:roadmap:known@1')).toBeVisible();
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+2');
  await expect(row(app, 'integration:roadmap:known@1')).toBeVisible();
  await expect(app.locator('.tree .q[data-item*="lost"], .tree .q[data-item*="none"]')).toHaveCount(0);
  // The global count holds every item, wherever it sits.
  await expect(app.locator('.qstrip .sh')).toContainText('· 3 ·');
  await expect(row(app, 'integration:roadmap:known@1')).toContainText('roadmap');
  await expect(row(app, 'integration:roadmap:known@1')).toHaveAttribute('aria-label', /board decision/);
  await expect(card(app, 'integration:roadmap:known@1').locator('.dim')).toHaveText('alpha');
  // V2-8e (HIDEROWS, needs 95, superseding needs 40 here): folding hides only quiet rows; a project-level decision
  // stays right under the header.
  await app.getByRole('button', { name: 'Collapse alpha' }).click();
  await expect(row(app, 'integration:roadmap:known@1')).toHaveCount(1);
  await expect(card(app, 'integration:roadmap:known@1')).toBeVisible();
});

test('a manual card moved into the needs-decision column shows under its linked session’s project', async ({ app, core }) => {
  board(core);
  const s = core.shell(core.project('beta'), 'beta shell');
  await openWindow(app);
  const put = await owner(core, { op: 'board_put', id: null, title: 'Pick a name', session_id: s.id, column: 'working' });
  const id = ((put.Ok!.board as { cards: { id: string; source: string }[] }).cards.find((c) => c.source === 'manual')!).id;
  const moved = await owner(core, { op: 'board_move', source: 'manual', id, column: 'ask' });
  const at = ((moved.Ok!.board as { cards: { id: string; updated_at: number }[] }).cards.find((c) => c.id === id)!).updated_at;
  await expect(card(app, `manual:${id}@${at}`)).toContainText('Pick a name');
  await expect(row(app, `manual:${id}@${at}`)).toBeVisible();
});

test('Resolved marks the card resolved by identity and updated_at; a newer updated_at raises it again', async ({ app, core }) => {
  board(core);
  await openWindow(app);
  cards(core, [flag('a', 'Merge it?', { url: 'https://example.com/a' })]);
  const first = card(app, 'integration:roadmap:a@1');
  await first.click();
  await expect(first.getByRole('button', { name: 'Resolved' })).toBeVisible();
  // The link opens in the user's browser (the existing opener; window.open outside the app shell).
  await app.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((u: string) => ((window as unknown as { __opened: string[] }).__opened.push(u), null)) as typeof window.open;
  });
  await first.getByRole('button', { name: 'Open', exact: true }).click();
  expect(await app.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(['https://example.com/a']);
  await first.focus();
  await app.keyboard.press('r');
  await expect(first).toHaveCount(0);
  expect(resolved(core)).toEqual({ 'integration:roadmap:a': 1 });
  // Off the strip, so it is no longer held and a new raise takes a line.
  await app.mouse.move(700, 200);
  cards(core, [flag('a', 'Merge it now?', { updated_at: 2 })]);
  await expect(card(app, 'integration:roadmap:a@2')).toContainText('Merge it now?');
});

test('resolving a card that changed after it was shown is refused and the new question shows', async ({ app, core }) => {
  board(core);
  // Hold back snapshots, so the window still shows the old card when the user answers it (the real race).
  let freeze = false;
  const held: string[] = [];
  let release = () => {};
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    release = () => held.splice(0).forEach((m) => ws.send(m));
    server.onMessage((m) => {
      if (freeze && typeof m === 'string' && JSON.parse(m).event === 'snapshot') held.push(m);
      else ws.send(m);
    });
    ws.onMessage((m) => server.send(m));
  });
  await openWindow(app);
  cards(core, [flag('a', 'First question?')]);
  const old = card(app, 'integration:roadmap:a@1');
  await expect(old).toBeVisible();
  freeze = true;
  cards(core, [flag('a', 'Second question?', { updated_at: 2 })]);
  await expect.poll(() => decisions(core).map((d) => d.updated_at)).toEqual([2]);
  await old.click();
  await old.getByRole('button', { name: 'Resolved' }).click();
  // Ticket 601 round 2: "card changed" takes the changed group's line (src/errors-groups.ts); ticket 553: the core's own
  // words are its tooltip and its accessible description.
  await expect(old.locator('.note.err')).toHaveText('Something changed while you were working. Refresh, then try again.');
  await expect(old.locator('.note.err')).toHaveAttribute('title', 'card changed');
  await expect(old.locator('.note.err')).toHaveAccessibleDescription('card changed');
  expect(resolved(core)).toBeNull();
  // Leave the card while it is still drawn, then let the held snapshots through.
  await app.mouse.move(700, 200);
  await app.keyboard.press('Escape');
  freeze = false;
  release();
  await expect(card(app, 'integration:roadmap:a@2')).toContainText('Second question?');
});
const decisions = (core: Core) => (core.cli('snapshot', '--json').board_decisions ?? []) as { identity: string; updated_at: number }[];

test('a Hangul 64 KiB question ellipsises in the strip, shows whole on expand, and nothing shifts', async ({ app, core }) => {
  board(core);
  core.shell(core.project('gamma'), 'gamma shell');
  await openWindow(app);
  const before = await boxes(app);
  const question = (HANGUL + ' ').repeat(2000).slice(0, 26800);
  expect(Buffer.byteLength(question)).toBeGreaterThan(60_000);
  expect(Buffer.byteLength(question)).toBeLessThanOrEqual(65_536);
  cards(core, [flag('long', question)]);
  const c = card(app, 'integration:roadmap:long@1');
  await expect(c).toBeVisible();
  // V1A-60b (needs 77): only the strip's own box changes as it appears.
  expect(unmoved(before, await boxes(app))).toEqual(['strip']);
  const what = c.locator('.what');
  expect(await what.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis')).toBe(true);
  expect((await c.boundingBox())!.height).toBeLessThanOrEqual(24);
  await c.click();
  await c.getByRole('button', { name: 'Full text' }).click();
  const full = app.getByRole('dialog', { name: 'roadmap: full question' });
  await expect(full).toBeVisible();
  expect(await full.locator('p').textContent()).toBe(question);
  expect(unmoved(before, await boxes(app))).toEqual(['strip']);
  await app.keyboard.press('Escape');
  await expect(full).toBeHidden();
});

test('500 flagged cards are all counted; the strip shows 1 and "+499", the tree 2 and its "+N"', async ({ app, core }) => {
  board(core);
  const p = core.project('many');
  core.shell(p, 'many shell');
  await openWindow(app);
  cards(core, Array.from({ length: 500 }, (_, i) => flag(`c${i}`, `Question ${i}?`, { project: p })));
  await expect(app.locator('.qstrip .sh')).toContainText('· 500 ·');
  await expect(app.locator('.qcard[data-kind="board"]')).toHaveCount(1);
  await expect(app.locator('.qmore')).toHaveText('+499');
  await expect(app.locator('.tree .q')).toHaveCount(2);
  await expect(app.locator('.tree .more')).toHaveAttribute('data-more', '498');
});

test('a new board decision notifies with kind, source and project only, never the question', async ({ app, core }) => {
  board(core);
  const p = core.project('delta');
  core.shell(p, 'delta shell');
  await app.addInitScript(() => {
    const w = window as unknown as { __notes: { title: string; body: string }[] };
    w.__notes = [];
    class Fake {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: null | (() => void) = null;
      constructor(title: string, o: { body: string }) {
        w.__notes.push({ title, body: o.body });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Fake;
  });
  await openWindow(app);
  await app.waitForTimeout(1600);
  cards(core, [flag('secret', 'Use token sk-live-123?', { project: p })]);
  await expect(card(app, 'integration:roadmap:secret@1')).toBeVisible();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __notes: unknown[] }).__notes)).toEqual([{ title: 'Board decision · roadmap', body: 'Board decision · roadmap · delta' }]);
});

test('board notifications follow their own notification level, which the user can change', async ({ app, core }) => {
  board(core);
  const p = core.project('epsilon');
  core.shell(p, 'epsilon shell');
  await app.addInitScript(() => {
    const w = window as unknown as { __notes: { title: string; body: string }[] };
    w.__notes = [];
    class Fake {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: null | (() => void) = null;
      constructor(title: string, o: { body: string }) {
        w.__notes.push({ title, body: o.body });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Fake;
  });
  await openWindow(app);
  await app.waitForTimeout(1600);
  const count = () => app.evaluate(() => (window as unknown as { __notes: unknown[] }).__notes.length);
  cards(core, [flag('one', 'First?', { project: p })]);
  await expect.poll(count).toBe(1);
  const level = app.getByLabel('Notifications for board decisions');
  // needs 130: the shared control is a button and a menu, not a UA select (its levels and stored keys are unchanged).
  const pick = async (l: string) => {
    await level.click();
    await app.getByRole('menu', { name: 'Notifications for board decisions' }).getByRole('menuitem', { name: `notify: ${l}` }).click();
  };
  await pick('muted');
  cards(core, [flag('one', 'First?', { project: p }), flag('two', 'Muted?', { project: p })]);
  await expect(app.locator('.qstrip .sh')).toContainText('· 2 ·');
  await app.waitForTimeout(500);
  expect(await count()).toBe(1);
  // A board decision waits on the user, so "waiting only" still notifies.
  await pick('waiting only');
  cards(core, [flag('one', 'First?', { project: p }), flag('two', 'Muted?', { project: p }), flag('three', 'Waiting?', { project: p })]);
  await expect.poll(count).toBe(2);
  // The level is a window preference, kept across reloads like the session levels.
  await app.reload();
  await expect(app.getByLabel('Notifications for board decisions')).toHaveAttribute('data-tip', /notify: waiting only/);
});

// Round 3 (strict review): the shared menu is absolute, so each call site must anchor it on its own control. The
// strip's copy lands relative to a positioned ancestor before the fix and covers the window.
test('notify_menu_positioned_everywhere: the menu opens against its button in the header and in the board strip', async ({ app, core }) => {
  board(core);
  const p = core.project('epsilon');
  const s = core.shell(p, 'epsilon shell');
  await openWindow(app);
  cards(core, [flag('one', 'First?', { project: p })]);
  const near = async (label: string) => {
    const btn = app.getByRole('button', { name: label });
    await btn.click();
    const menu = app.getByRole('menu', { name: label });
    await expect(menu).toBeVisible();
    // Right place is not enough: the box must also be the thing under the pointer, not clipped or painted under.
    expect(await menu.evaluate((el) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!at && el.contains(at); })).toBe(true);
    const [b, m] = await Promise.all([btn.boundingBox(), menu.boundingBox()]);
    await app.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    return { b: b!, m: m! };
  };
  // The strip's control: the menu opens upward from the button's own left edge, not from the window's.
  const strip = await near('Notifications for board decisions');
  expect(Math.abs(strip.m.y + strip.m.height - strip.b.y)).toBeLessThanOrEqual(8);
  expect(Math.abs(strip.m.x - strip.b.x)).toBeLessThanOrEqual(8);
  // The header's control, the same shared component: it opens downward, flush with the button's right edge.
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const head = await (async () => {
    const btn = app.locator('.shead .qlevel-btn');
    await btn.click();
    const menu = app.locator('.shead .qlevel-menu');
    await expect(menu).toBeVisible();
    const [b, m] = await Promise.all([btn.boundingBox(), menu.boundingBox()]);
    await app.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    return { b: b!, m: m! };
  })();
  expect(Math.abs(head.m.y - (head.b.y + head.b.height))).toBeLessThanOrEqual(8);
  expect(Math.abs(head.m.x + head.m.width - (head.b.x + head.b.width))).toBeLessThanOrEqual(8);
});

test('screenshot: a board decision in the strip and its tree row (R8 comparison)', async ({ app, core }, info) => {
  board(core);
  const p = core.project('nunchiro');
  core.shell(p, 'main shell');
  await openWindow(app);
  cards(core, [flag('NUN-42', '배포 전에 마이그레이션을 먼저 돌릴까요?', { project: p, url: 'https://example.com/NUN-42' })]);
  const c = card(app, 'integration:roadmap:NUN-42@1');
  await expect(c).toBeVisible();
  await expect(row(app, 'integration:roadmap:NUN-42@1')).toBeVisible();
  const dir = path.join(import.meta.dirname, '../../.scratch/board-queue-shots');
  fs.mkdirSync(dir, { recursive: true });
  await app.screenshot({ path: path.join(dir, `window-${info.project.name}.png`) });
  await c.click();
  await expect(c.getByRole('button', { name: 'Resolved' })).toBeVisible();
  await app.screenshot({ path: path.join(dir, `focused-${info.project.name}.png`) });
});

// V1A-60b round 2: with one strip line, board items (no tree row) are reached with waiting.next, in the strip's order.
test('waiting-next-board: waiting.next walks board items in the strip order, so a second one is reachable', async ({ app, core }) => {
  board(core);
  core.shell(core.project('alpha'), 'alpha shell');
  await openWindow(app);
  cards(core, [flag('one', 'First?'), flag('two', 'Second?')]);
  await expect(card(app, 'integration:roadmap:one@1')).toBeVisible();
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1');
  for (const id of ['one', 'two', 'one']) {
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('KeyW');
    await expect(card(app, `integration:roadmap:${id}@1`)).toBeFocused();
  }
});
