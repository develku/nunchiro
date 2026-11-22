// V2.5-60 follow-up (ticket 219, B13): the Board rail count is over the whole board whatever the Board's chips and search show,
// says so in its name when they show fewer, rides the widget's own poll while the Board is open, and the badge click toggles.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openBoard, overlay, seed } from './fixtures/board/coord';
import { closeModal } from './settings-modal';

const icon = (app: Page) => app.locator('.ib.r #icon-board');
const badge = (app: Page) => icon(app).locator('.rcount');
const ASK = 'needs-decision';
const asking = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i + 1}`, title: `Ask ${i + 1}`, column: ASK }));

test('board_rail_count_scope_with_chips: a chip that hides cards keeps the count and the name says all boards', async ({ app, core }) => {
  seed(core, asking(3));
  const board = await openBoard(app, core);
  await expect(badge(app)).toHaveText('3');
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 3 cards need you'); // nothing narrowed: the plain name
  await board.locator('.bstrip').getByRole('button', { name: /^stale/ }).click(); // no card is stale: the board shows none of the 3
  await app.mouse.move(2, 2);
  await expect(board.locator('.bcard')).toHaveCount(0);
  await expect(badge(app)).toHaveText('3'); // a status badge does not follow a view filter
  await expect(icon(app)).toHaveAttribute('aria-label', /^Board · 3 cards need you \(all boards/);
  await expect(icon(app)).toHaveAttribute('data-tip', /all boards/);
  // The search narrows the same way.
  await board.locator('.bstrip').getByRole('button', { name: /^stale/ }).click();
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 3 cards need you');
  await board.getByRole('textbox', { name: 'Search cards' }).fill('Ask 1');
  await expect(board.locator('.bcard')).toHaveCount(1);
  await expect(badge(app)).toHaveText('3');
  await expect(icon(app)).toHaveAttribute('aria-label', /\(all boards/);
});

// The poll tests count timers, not wall time: the page clock is installed before the load, paused once the Board shows, and run
// one simulated second at a time, so a rail with one timer gives an exact count on any machine, busy or not.
const SECONDS = 10;

/** Every board_snapshot the window sends, and whether the core has answered it (matched by the frame id). */
function watchSnapshots(app: Page) {
  const sent = new Set<number>();
  const answered = new Set<number>();
  app.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const m = JSON.parse(f.payload);
      if (m.request?.op === 'board_snapshot') sent.add(m.id);
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') return;
      const m = JSON.parse(f.payload);
      if (typeof m.id === 'number') answered.add(m.id);
    });
  });
  return { sent, pending: () => [...sent].filter((id) => !answered.has(id)).length, reset: () => (sent.clear(), answered.clear()) };
}

/**
 * Opens the Board on a paused clock, optionally adds a rival 1 s timer that asks for the board (what a second rail timer would
 * do), runs SECONDS simulated seconds and expects exactly the widget's one poll per second.
 */
async function expectOnlyWidgetPolls(app: Page, core: Core, { rival = false } = {}) {
  seed(core, asking(2));
  await app.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (this.url.endsWith('/ws')) (window as unknown as { __core: WebSocket }).__core = this;
      return send.call(this, d);
    };
  });
  await app.clock.install();
  const wire = watchSnapshots(app);
  await openBoard(app, core);
  await expect(badge(app)).toHaveText('2');
  // A message-channel turn after the last frame: the page has run the effects of every reply it got.
  const settle = () =>
    app.evaluate(() => new Promise<void>((done) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => done();
      c.port2.postMessage(0);
    }));
  await app.clock.pauseAt((await app.evaluate(() => Date.now())) + 100);
  await expect.poll(() => wire.pending()).toBe(0);
  await settle();
  if (rival)
    await app.evaluate(() => {
      let id = 9_000_000;
      setInterval(() => (window as unknown as { __core: WebSocket }).__core.send(JSON.stringify({ id: id++, request: { op: 'board_snapshot' } })), 1000);
    });
  wire.reset();
  for (let s = 0; s < SECONDS; s++) {
    await app.clock.runFor(1000);
    await settle();
    await expect.poll(() => wire.pending()).toBe(0);
    await settle();
  }
  expect(wire.sent.size, `board_snapshot requests in ${SECONDS} simulated seconds (the widget's timer alone makes ${SECONDS})`).toBe(SECONDS);
}

test('board_rail_count_single_poll_clocked: 10 simulated seconds with the Board open send the widget\'s polls and no rail poll', async ({ app, core }) => {
  await expectOnlyWidgetPolls(app, core);
});

test('board_rail_count_single_poll_catches_second_timer: a second 1 s timer asking for the board makes the same check red', async ({ app, core }) => {
  await expect(expectOnlyWidgetPolls(app, core, { rival: true })).rejects.toThrow(/requests in 10 simulated seconds[\s\S]*Received[\s\S]*20/); // colour codes sit between the words
});

test('board_rail_badge_click_toggles: the badge opens the Board, a second click closes it, the name stays', async ({ app, core }) => {
  seed(core, asking(2));
  await openWindow(app, {}, core);
  await expect(badge(app)).toHaveText('2');
  const name = 'Board · 2 cards need you';
  await expect(icon(app)).toHaveAttribute('aria-label', name);
  await badge(app).click();
  await expect(app.locator('.board')).toBeVisible();
  await expect(icon(app)).toHaveAttribute('aria-label', name);
  await app.mouse.move(2, 2);
  await closeModal(app); // v25f: the Board modal's panel covers the rail's Board icon, so the second click is the modal's own close button
  await expect(app.locator('.board')).toHaveCount(0);
  await expect(icon(app)).toHaveAttribute('aria-label', name);
  await expect(badge(app)).toHaveText('2');
});

// Round 2 (review of dee19134). With no Board shown the rail asks for the board itself, at most once every RAIL_EVERY seconds
// (each ask reads the board files from disk); the check runs on the page clock like the single-poll test above.
const RAIL_EVERY = 4;
const RAIL_SECONDS = 16; // the last ask before the pause sets the phase: 3 or 4 asks fall in the window, never 16

async function railPollsWithoutBoard(app: Page, core: Core, { rival = false } = {}) {
  seed(core, asking(2));
  await app.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (this.url.endsWith('/ws')) (window as unknown as { __core: WebSocket }).__core = this;
      return send.call(this, d);
    };
  });
  await app.clock.install();
  const wire = watchSnapshots(app);
  await openWindow(app, {}, core);
  await expect(badge(app)).toHaveText('2');
  const settle = () =>
    app.evaluate(() => new Promise<void>((done) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => done();
      c.port2.postMessage(0);
    }));
  await app.clock.pauseAt((await app.evaluate(() => Date.now())) + 100);
  await expect.poll(() => wire.pending()).toBe(0);
  await settle();
  if (rival)
    await app.evaluate(() => {
      let id = 9_000_000;
      setInterval(() => (window as unknown as { __core: WebSocket }).__core.send(JSON.stringify({ id: id++, request: { op: 'board_snapshot' } })), 1000);
    });
  wire.reset();
  for (let s = 0; s < RAIL_SECONDS; s++) {
    await app.clock.runFor(1000);
    await settle();
    await expect.poll(() => wire.pending()).toBe(0);
    await settle();
  }
  const asks = wire.sent.size;
  expect(asks, `board_snapshot requests in ${RAIL_SECONDS} simulated seconds (the rail alone makes ${RAIL_SECONDS / RAIL_EVERY - 1} to ${RAIL_SECONDS / RAIL_EVERY})`).toBeLessThanOrEqual(RAIL_SECONDS / RAIL_EVERY);
  expect(asks).toBeGreaterThanOrEqual(RAIL_SECONDS / RAIL_EVERY - 1);
}

test('board_rail_count_rail_only_cadence: with no Board shown the rail asks once every 4 simulated seconds', async ({ app, core }) => {
  await railPollsWithoutBoard(app, core);
});

test('board_rail_count_rail_only_catches_second_timer: a second 1 s timer asking for the board makes the same check red', async ({ app, core }) => {
  await expect(railPollsWithoutBoard(app, core, { rival: true })).rejects.toThrow(/requests in 16 simulated seconds[\s\S]*Received[\s\S]*(19|20)/);
});

test('board_rail_count_reply_without_board: a board_snapshot reply with no board throws nothing and keeps the last count', async ({ app, core }) => {
  seed(core, asking(2));
  let bare = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const r = JSON.parse(m);
      if (bare && r.response?.Ok?.type === 'board_snapshot') delete r.response.Ok.board;
      ws.send(JSON.stringify(r));
    });
  });
  await app.addInitScript(() => {
    (window as unknown as { __rej: number }).__rej = 0;
    window.addEventListener('unhandledrejection', () => ((window as unknown as { __rej: number }).__rej += 1));
  });
  await openWindow(app, {}, core);
  await expect(badge(app)).toHaveText('2');
  bare = true;
  await app.waitForTimeout(9000); // two rail asks at 4 s
  expect(await app.evaluate(() => (window as unknown as { __rej: number }).__rej)).toBe(0);
  await expect(badge(app)).toHaveText('2');
});

test('board_rail_name_held_board: a held Board with no chip or search set does not say "all boards"', async ({ app, core }) => {
  seed(core, asking(2));
  let n = 2;
  await overlay(app, {
    board: (b) => ({ ...b, cards: Array.from({ length: n }, (_, i) => ({ ...(b.cards as Record<string, unknown>[])[0], id: `${i + 1}`, title: `Ask ${i + 1}` })) }),
  });
  const board = await openBoard(app, core);
  await expect(badge(app)).toHaveText('2');
  await board.hover(); // held: the board holds still while the pointer is over it, so a card that arrives is not drawn yet
  await expect(board).toHaveAttribute('data-held', 'true');
  n = 3;
  await expect(badge(app)).toHaveText('3');
  await expect(board.locator('.bcard')).toHaveCount(2);
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 3 cards need you');
  await expect(icon(app)).not.toHaveAttribute('data-tip', /all boards/);
});

test('board_rail_name_project_pick: a picked project that hides a needs-you card says "all boards"', async ({ app, core }) => {
  seed(core, asking(2));
  const where: Record<string, string> = { '1': '/fixture/alpha-app', '2': '/fixture/beta-api' };
  await overlay(app, { board: (b) => ({ ...b, cards: (b.cards as { id: string }[]).map((c) => ({ ...c, project: where[c.id] ?? null })) }) });
  const board = await openBoard(app, core);
  await expect(badge(app)).toHaveText('2');
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 2 cards need you');
  await board.locator('button.bproj').click();
  await app.getByRole('option', { name: 'alpha-app' }).click();
  await app.mouse.move(2, 2);
  await expect(board.locator('.bcard')).toHaveCount(1); // beta-api's card is hidden by the project
  await expect(badge(app)).toHaveText('2');
  await expect(icon(app)).toHaveAttribute('aria-label', /^Board · 2 cards need you \(all boards/);
});

test('board_rail_count_one_ask_at_a_time: an ask the core has not answered holds the next one back', async ({ app, core }) => {
  seed(core, asking(1));
  let held = false;
  let asks = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (held && typeof m === 'string' && JSON.parse(m).request?.op === 'board_snapshot') return void asks++; // never answered
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app, {}, core);
  await expect(badge(app)).toHaveText('1');
  held = true;
  await app.waitForTimeout(10_000); // two and a half rail periods
  expect(asks).toBe(1);
});
