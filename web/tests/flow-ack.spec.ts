// V1A-53: the window acks the output it parsed, and the core never has more than its window of a session's output
// unacked on the way to it (real core). The burst starts only after the window watched and acked the replay: before
// its first ack a window is not paced (older builds send none).
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';

/** Keeps the page's main thread busy in 1.5 s spells until the core has the whole burst: between spells it still
 * reads its socket (the core drops a window that leaves a write blocked for 2 s), but it parses about 30 times slower
 * than the burst arrives, however slowly a loaded host produces it. The burst writes `done` once it wrote everything. */
async function slow(app: Page, done: string) {
  for (let i = 0; i < 40 && !fs.existsSync(done); i++)
    await app.evaluate(() => {
      const t = performance.now();
      while (performance.now() - t < 1500);
    });
}
/** What a window watching one session may have unacked: `NUNCHIRO_WINDOW_UNACKED_MIB` here (the default, 16 MiB,
 * would need bursts the debug core cannot move in time on a loaded host). */
const TOTAL = 2 << 20;
/** The fixture's core again, with that total, and the page booted against it. */
async function paced(app: Page, core: Core) {
  core.run(['serve', 'stop'], 10_000);
  core.env.NUNCHIRO_WINDOW_UNACKED_MIB = String(TOTAL >> 20);
  await core.restart();
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
}
const BURST = `import os, sys, time
while not os.path.exists("go"): time.sleep(0.05)
line = ("y" * 99 + "\\n") * 1000
for _ in range(240): sys.stdout.write(line)
sys.stdout.write("\\nEND-MARK\\n"); sys.stdout.flush(); open("done", "w").close()
while True: time.sleep(60)`;

test('the window acks what it parsed and the core keeps at most its window unacked', async ({ app, core }) => {
  test.setTimeout(60_000);
  await paced(app, core);
  const p = core.project('demo');
  const a = core.shell(p, 'burst', 'python3', '-I', '-B', '-c', BURST);
  let received = 0;
  let acked = -1;
  const acks: number[] = [];
  const over: string[] = [];
  app.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('{"ack"')) return;
      const m = JSON.parse(payload) as { ack: string; bytes: number };
      if (m.ack !== a.id) return;
      acks.push(m.bytes);
      acked = m.bytes;
    });
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') return;
      const n = payload.readUInt32BE(0);
      const head = JSON.parse(payload.subarray(4, 4 + n).toString()) as { session: string };
      if (head.session !== a.id) return;
      received += payload.length - 4 - n;
      if (acked >= 0 && received - acked > TOTAL) over.push(`${received} received, ${acked} acked`);
    });
  });
  await openWindow(app);
  const rows = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  await expect(rows).toBeVisible();
  // The replay frame was parsed and acked: from here this window is paced.
  await expect.poll(() => acks.length).toBeGreaterThan(0);
  fs.writeFileSync(`${p}/go`, '');
  // The window parses almost nothing for 6 s while the burst runs: an unpaced core sends on regardless; a paced one
  // stops at the total, and the burst outruns it.
  await expect.poll(() => received).toBeGreaterThan(0);
  await slow(app, `${p}/done`);
  await expect(rows).toContainText('END-MARK', { timeout: 30_000 });
  expect(over).toEqual([]);
  // Held past its total, the window skipped to the newest output instead of being sent all 24 MiB.
  expect(received).toBeLessThan(240 * 100_000);
  // Cumulative, never lower, and it reached what the window was sent.
  expect(acks).toEqual([...acks].sort((x, y) => x - y));
  await expect.poll(() => acked).toBe(received);
});

// An escape sequence open when the window was held (here an OSC title never terminated) must not swallow what follows
// the jump: the window resets its parser at a skip.
const OPEN_OSC = `import os, sys, time
sys.stdout.write("\\033]0;"); sys.stdout.flush()
while not os.path.exists("go"): time.sleep(0.05)
line = ("y" * 99 + "\\n") * 1000
for _ in range(240): sys.stdout.write(line)
sys.stdout.write("\\nEND-MARK\\n"); sys.stdout.flush(); open("done", "w").close()
while True: time.sleep(60)`;

test('a skip resets the parser: an escape sequence cut by the jump does not swallow the newest output', async ({ app, core }) => {
  test.setTimeout(60_000);
  await paced(app, core);
  const p = core.project('demo');
  const a = core.shell(p, 'osc', 'python3', '-I', '-B', '-c', OPEN_OSC);
  let skips = 0;
  let live = 0;
  app.on('websocket', (ws) =>
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') return;
      const head = JSON.parse(payload.subarray(4, 4 + payload.readUInt32BE(0)).toString());
      if (head.session !== a.id || head.replay) return;
      live++;
      if (head.truncated) skips++;
    }),
  );
  await openWindow(app);
  const rows = app.locator(`.term[data-session="${a.id}"] .xterm-rows`);
  await expect(rows).toBeVisible();
  await app.waitForTimeout(500);
  fs.writeFileSync(`${p}/go`, '');
  await expect.poll(() => live).toBeGreaterThan(0); // the burst is arriving
  await slow(app, `${p}/done`);
  // The premise: the window was held long enough to skip.
  await expect.poll(() => skips, { timeout: 30_000 }).toBeGreaterThan(0);
  // Without the reset the whole stream after the jump would stay inside the OSC, unpainted.
  await expect(rows).toContainText('END-MARK', { timeout: 30_000 });
});

// The client half alone (web/src/api.ts), on a fake socket: which frames count toward the acks.
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  binaryType = '';
  sent: Record<string, unknown>[] = [];
  onopen = () => {};
  onclose = () => {};
  onmessage: (ev: { data: unknown }) => void = () => {};
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  output(session: string, start: number, bytes: number, replay: boolean, truncated = false) {
    const head = new TextEncoder().encode(JSON.stringify({ session, start, end: start + bytes, truncated, replay }));
    const b = new Uint8Array(4 + head.length + bytes);
    new DataView(b.buffer).setUint32(0, head.length);
    b.set(head, 4);
    this.onmessage({ data: b.buffer });
  }
  reply(id: number, response: object) {
    this.onmessage({ data: JSON.stringify({ id, response }) });
  }
  acks() {
    return this.sent.filter((m) => 'ack' in m).map((m) => m.bytes);
  }
}

async function client() {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  // F24: connect() reads window.__NUNCHIRO__; this spec runs in plain Node, so the global object stands in for window.
  (globalThis as { window?: unknown }).window = globalThis;
  const { CoreClient } = await import('../src/api');
  const core = new CoreClient({ port: 1, token: 't' });
  core.connect();
  const ws = FakeSocket.last;
  ws.onopen();
  const parsed: (() => void)[] = [];
  const view = (_: unknown, done: () => void) => void parsed.push(done);
  const parse = () => parsed.splice(0).forEach((f) => f());
  return { core, ws, view, parse };
}

test('two watches back to back: the acks count from the second one, as the core does', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view);
  core.watch('s', view); // a pinned duplicate: the core counts afresh from this watch's replay
  ws.output('s', 0, 100, true); // the first watch's replay
  ws.output('s', 0, 150, true); // the second's
  ws.output('s', 150, 50, false);
  parse();
  expect(ws.acks()).toEqual([150, 200]);
});

test('a refused watch is owed no replay, and a stale frame parsed after a rewatch is not counted', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view);
  ws.reply(1, { Err: 'too many watched sessions' });
  await new Promise((r) => setTimeout(r));
  core.watch('s', view);
  ws.output('s', 0, 10, true);
  parse();
  ws.output('s', 10, 20, false);
  core.watch('s', view); // the frame above is parsed only after this rewatch
  parse();
  ws.output('s', 0, 30, true);
  parse();
  expect(ws.acks()).toEqual([10, 30]);
});

test('after a reconnect the acks count from the new connection, even with a replay lost on the old one', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view); // answered, but the socket closes before its replay comes
  ws.reply(1, { Ok: 'Ack' });
  ws.readyState = 3;
  ws.onclose();
  await expect.poll(() => FakeSocket.last, { timeout: 5000 }).not.toBe(ws); // the client reconnects after 1 s
  const again = FakeSocket.last;
  again.onopen();
  again.output('s', 0, 40, true);
  parse();
  expect(again.acks()).toEqual([40]);
});

test('a rewatch right after the last view closed still counts from its own replay', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view)(); // the tab closes before its replay arrives
  core.watch('s', view); // and opens again
  ws.output('s', 0, 100, true); // the first watch's replay, sent before the core read the unwatch
  ws.output('s', 0, 150, true); // this watch's
  ws.output('s', 150, 50, false);
  parse();
  expect(ws.acks()).toEqual([150, 200]);
});

test('a frame no view receives is acked at once: a duplicate closed before its replay on a quiet session', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view);
  ws.output('s', 0, 100, true);
  parse();
  core.watch('s', (o, d) => view(o, d))(); // a pinned duplicate (its own view) opens and closes before its replay
  ws.output('s', 0, 100, true); // nothing new for the view that stayed
  ws.output('s', 100, 50, false);
  parse();
  expect(ws.acks()).toEqual([100, 100, 150]);
});

test('a frame whose only receiving view closes before parsing it is acked when that view closes', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view);
  ws.output('s', 0, 100, true);
  parse();
  const pending: (() => void)[] = [];
  const close = core.watch('s', (_, done) => void pending.push(done)); // a duplicate that never parses
  ws.output('s', 0, 100, true); // only the duplicate receives it
  close();
  ws.output('s', 100, 50, false);
  parse();
  expect(ws.acks()).toEqual([100, 100, 150]);
});

test('when the core refuses an ack the window watches afresh from its cursor and counts from that replay', async () => {
  const { core, ws, view, parse } = await client();
  core.watch('s', view);
  ws.output('s', 0, 100, true);
  ws.output('s', 100, 50, false);
  parse();
  ws.onmessage({ data: JSON.stringify({ event: 'ack_refused', session: 's' }) });
  expect(ws.sent.at(-1)).toMatchObject({ watch: 's', after: 150 });
  ws.output('s', 150, 30, true);
  parse();
  expect(ws.acks()).toEqual([100, 150, 30]);
});

test('a rewatch replay overlapping frames already shown gives each view only the new bytes', async () => {
  const { core, ws, parse } = await client();
  const got: [number, number, boolean][] = [];
  core.watch('s', (o, done) => {
    got.push([o.start, o.end, o.replay]);
    done();
  });
  ws.output('s', 0, 100, true);
  ws.onmessage({ data: JSON.stringify({ event: 'ack_refused', session: 's' }) }); // rewatch after 100
  ws.output('s', 100, 50, false); // in flight before the core read the rewatch
  ws.output('s', 100, 80, true); // the rewatch's replay, from 100
  parse();
  expect(got).toEqual([
    [0, 100, true],
    [100, 150, false],
    [150, 180, true],
  ]);
});

test('a truncated replay for a duplicate reaches a view held further back as the jump it is', async () => {
  const { core, ws, view, parse } = await client();
  const got: [number, number, boolean, number][] = [];
  core.watch('s', (o, done) => {
    got.push([o.start, o.end, o.truncated, o.data.length]);
    done();
  });
  ws.output('s', 0, 100, true);
  core.watch('s', (o, d) => view(o, d)); // a duplicate: the core replays the newest bytes, past what the first view has
  ws.output('s', 500, 100, true, true);
  parse();
  // The first view gets the skip whole and marked, so it resets its parser and shows the trim; nothing from before.
  expect(got).toEqual([
    [0, 100, false, 100],
    [500, 600, true, 100],
  ]);
});

test('a duplicate replay starting exactly where a view is reaches it as contiguous output, not a jump', async () => {
  const { core, ws, view } = await client();
  const got: [number, number, boolean][] = [];
  core.watch('s', (o, done) => {
    got.push([o.start, o.end, o.truncated]);
    done();
  });
  ws.output('s', 0, 100, true);
  core.watch('s', (o, d) => view(o, d)); // a duplicate; the core's newest replay happens to start at 100
  ws.output('s', 100, 100, true, true);
  expect(got).toEqual([
    [0, 100, false],
    [100, 200, false],
  ]);
});

test('with a duplicate open, bytes past a view are live output to it: a terminal query in them is answered once', async () => {
  const { core, ws } = await client();
  const old: [number, boolean][] = [];
  const dup: [number, boolean][] = [];
  core.watch('s', (o, done) => (old.push([o.start, o.replay]), done()));
  ws.output('s', 0, 100, true);
  core.watch('s', (o, done) => (dup.push([o.start, o.replay]), done()));
  // The duplicate's replay is the newest replay, past the first view (it fell behind): its bytes, a DA query among
  // them, are new to the first view, old to the duplicate.
  ws.output('s', 300, 100, true, true);
  // Only the first view answers (replay false); the duplicate never does.
  expect(old).toEqual([
    [0, true],
    [300, false],
  ]);
  expect(dup).toEqual([[300, true]]);
});
