// V1A-51 per-frame write queue (web/src/terminal/writer.ts). Pure, no page: a fake xterm that parses a write only when
// the test says so, taking clock time per unit, and a frame clock the test advances.
import { expect, test } from '@playwright/test';
import { BUDGET_MS, ECHO_MS, MAX_BYTES, MIN_BYTES, SMALL, START_BYTES, Writers, nextFrame, type Sink } from '../src/terminal/writer';

/** Parse cost per unit at which START_BYTES is exactly one frame's budget: the budget then holds still. */
const STEADY = BUDGET_MS / START_BYTES;
const FRAME_BYTES = START_BYTES;

class Clock {
  t = 0;
  frames: (() => void)[] = [];
  laters: (() => void)[] = [];
  frame = (f: () => void) => {
    this.frames.push(f);
    return () => (this.frames = this.frames.filter((x) => x !== f));
  };
  later = (f: () => void) => void this.laters.push(f);
  now = () => this.t;
  /** One animation frame, the timers queued in it, then xterm parses everything it was handed. */
  tick(sinks: FakeTerm[] = []) {
    const fs = this.frames;
    this.frames = [];
    fs.forEach((f) => f());
    this.runLaters();
    sinks.forEach((s) => s.parse());
    this.t += 16;
  }
  runLaters() {
    const ls = this.laters;
    this.laters = [];
    ls.forEach((f) => f());
  }
}

class FakeTerm implements Sink {
  got: string[] = [];
  pending: [number, () => void][] = [];
  constructor(
    private clock: Clock,
    public cost = STEADY,
  ) {}
  write(data: string, cb?: () => void) {
    this.got.push(data);
    this.pending.push([data.length, cb ?? (() => {})]);
  }
  parse() {
    const p = this.pending;
    this.pending = [];
    for (const [n, f] of p) {
      this.clock.t += n * this.cost;
      f();
    }
  }
  text = () => this.got.join('');
}

const setup = (n: number, cost = STEADY) => {
  const clock = new Clock();
  const ws = new Writers(clock.frame, clock.now, clock.later);
  const terms = Array.from({ length: n }, () => new FakeTerm(clock, cost));
  return { clock, ws, terms, ins: terms.map((t) => ws.add(t)) };
};
const burst = (tag: string, n: number) => (tag + '.'.repeat(99) + '\n').repeat(Math.ceil(n / 100)).slice(0, n);

test('the budget is about 8 ms of parse per frame, starting at 64 KiB, within named bounds', () => {
  expect([BUDGET_MS, START_BYTES, MIN_BYTES, MAX_BYTES]).toEqual([8, 64 * 1024, 16 * 1024, 4 << 20]);
});

test('the budget follows the measured parse rate: a slow parse gets fewer bytes per frame, a fast one more, within the bounds', () => {
  for (const [cost, want] of [
    [STEADY * 2, START_BYTES / 2], // twice as slow: half the bytes
    [STEADY / 4, START_BYTES * 4], // four times as fast
    [STEADY * 100, MIN_BYTES], // never below the floor
    [STEADY / 1000, MAX_BYTES], // nor above the ceiling
  ]) {
    const { clock, ws, terms, ins } = setup(2, cost);
    ins.forEach((w, i) => w.write(burst(`t${i}`, 64 << 20)));
    for (let f = 0; f < 40; f++) clock.tick(terms);
    expect(Math.abs(ws.budget() - want) / want).toBeLessThan(0.05);
    // What one frame hands over stays within that budget.
    const before = terms.map((t) => t.text().length);
    const b = ws.budget();
    clock.tick(terms);
    expect(terms.reduce((n, t, i) => n + t.text().length - before[i], 0)).toBeLessThanOrEqual(b);
  }
});

test('the parse time is taken from the first timer after the writes, not from the frame (the paint before it is not parse)', () => {
  const { clock, ws, terms, ins } = setup(1);
  ins[0].write(burst('a', 64 << 20));
  for (let f = 0; f < 20; f++) {
    const fs = clock.frames;
    clock.frames = [];
    fs.forEach((x) => x());
    clock.t += 50; // a slow paint between the frame callback and the first timer
    clock.runLaters();
    terms[0].parse();
    clock.t += 16;
  }
  expect(Math.abs(ws.budget() - START_BYTES) / START_BYTES).toBeLessThan(0.05);
});

test('a 1 MiB chunk is written at most FRAME_BYTES per frame, in order, nothing lost', () => {
  const { clock, terms, ins } = setup(1);
  const data = burst('a', 1 << 20) + '@@END@@';
  ins[0].write(data);
  expect(terms[0].got).toEqual([]); // a burst waits for the frame
  let frames = 0;
  while (terms[0].text().length < data.length) {
    const before = terms[0].text().length;
    clock.tick(terms);
    expect(terms[0].text().length - before).toBeLessThanOrEqual(FRAME_BYTES);
    expect(++frames).toBeLessThan(100);
  }
  expect(frames).toBe(Math.ceil(data.length / FRAME_BYTES));
  expect(terms[0].text()).toBe(data);
});

test('8 bursting terminals: the frame total stays under the cap, every terminal progresses every frame, bytes arrive whole and in order', () => {
  const { clock, terms, ins } = setup(8);
  const want = terms.map((_, i) => {
    let s = '';
    for (let c = 0; c < 6; c++) {
      const chunk = burst(`t${i}c${c}`, 200_000 + i * 1000);
      ins[i].write(chunk);
      s += chunk;
    }
    return s + `@@END ${i}@@`;
  });
  terms.forEach((_, i) => ins[i].write(`@@END ${i}@@`));
  for (let f = 0; terms.some((t, i) => t.text().length < want[i].length); f++) {
    const before = terms.map((t) => t.text().length);
    clock.tick(terms);
    const step = terms.map((t, i) => t.text().length - before[i]);
    expect(step.reduce((a, b) => a + b)).toBeLessThanOrEqual(FRAME_BYTES);
    // Fair: while all are still busy, no terminal gets more than a share plus one slice rounding.
    if (terms.every((t, i) => t.text().length < want[i].length)) for (const s of step) expect(s).toBeGreaterThan(0);
    expect(f).toBeLessThan(1000);
  }
  terms.forEach((t, i) => expect(t.text()).toBe(want[i]));
});

test('many small frames fill one frame budget, and each chunk callback runs once it is parsed, in order', () => {
  const { clock, terms, ins } = setup(1);
  const done: number[] = [];
  const parts = Array.from({ length: 100 }, (_, i) => burst(`p${i}`, 20 * 1024)); // 2000 KiB in 20 KiB socket frames
  parts.forEach((p, i) => ins[0].write(p, () => done.push(i)));
  clock.tick();
  expect(terms[0].text().length).toBe(FRAME_BYTES);
  expect(done).toEqual([]);
  terms[0].parse();
  expect(done).toEqual(Array.from({ length: Math.floor(FRAME_BYTES / (20 * 1024)) }, (_, i) => i));
  for (let f = 0; f < 40; f++) clock.tick(terms);
  expect(terms[0].text()).toBe(parts.join(''));
  expect(done).toEqual(parts.map((_, i) => i));
});

test('an empty chunk behind a queue (an empty replay frame) runs its callback in turn and blocks nothing', () => {
  const { clock, terms, ins } = setup(1);
  let done = 0;
  ins[0].write(burst('a', 2 * FRAME_BYTES));
  ins[0].write('', () => done++);
  ins[0].write(burst('b', 2 * FRAME_BYTES) + '@@END@@');
  for (let f = 0; f < 10; f++) clock.tick(terms);
  expect(done).toBe(1);
  expect(terms[0].text().endsWith('@@END@@')).toBe(true);
});

test('xterm is never handed a new slice before it parsed the last one', () => {
  const { clock, terms, ins } = setup(1);
  ins[0].write(burst('a', 3 * FRAME_BYTES));
  clock.tick(); // frame, no parse
  const n = terms[0].got.length;
  clock.tick();
  clock.tick();
  expect(terms[0].got.length).toBe(n);
  terms[0].parse();
  clock.tick();
  expect(terms[0].got.length).toBe(n + 1);
});

test('key echo bypasses the cap: a small chunk on an idle terminal, or output right after a keystroke, is written at once', () => {
  const { clock, terms, ins } = setup(2);
  ins[1].write(burst('busy', 1 << 20)); // another terminal bursting does not delay the echo
  ins[0].write('x');
  expect(terms[0].got).toEqual(['x']);
  const redraw = burst('r', 8 * 1024); // a TUI redraw after the key: over SMALL, under the cap
  expect(redraw.length).toBeGreaterThan(SMALL);
  ins[0].write(redraw);
  expect(terms[0].got).toEqual(['x']); // no key yet: queued
  clock.tick(terms);
  ins[0].key();
  clock.t += ECHO_MS - 1;
  ins[0].write(redraw);
  expect(terms[0].got.at(-1)).toBe(redraw);
  clock.t += 2;
  const n = terms[0].got.length;
  ins[0].write(redraw);
  expect(terms[0].got.length).toBe(n); // the window closed: back to the frame
});

test('echo never jumps a queued burst on the same terminal (order kept); the keystroke itself is not held', () => {
  const { clock, terms, ins } = setup(1);
  const big = burst('b', 200_000);
  ins[0].write(big);
  ins[0].key();
  ins[0].write('^C');
  expect(terms[0].text()).toBe('');
  for (let f = 0; f < 10; f++) clock.tick(terms);
  expect(terms[0].text()).toBe(big + '^C');
});

test('a big chunk right after a key still waits for the frame', () => {
  const { terms, ins } = setup(1);
  ins[0].key();
  ins[0].write(burst('b', FRAME_BYTES + 1));
  expect(terms[0].got).toEqual([]);
});

test('the write callback runs after the last slice of its chunk is parsed (replay flag)', () => {
  const { clock, terms, ins } = setup(1);
  let done = 0;
  ins[0].write(burst('r', 3 * FRAME_BYTES), () => done++);
  clock.tick(terms);
  clock.tick(terms);
  expect(done).toBe(0);
  clock.tick(); // third slice handed over, not parsed yet
  expect(done).toBe(0);
  terms[0].parse();
  expect(done).toBe(1);
});

test('hidden terminals keep draining at the lowest priority', () => {
  const { clock, terms, ins } = setup(2);
  ins[1].active(false);
  ins[0].write(burst('v', 4 * FRAME_BYTES));
  ins[1].write(burst('h', 64 * FRAME_BYTES));
  clock.tick(terms);
  const [v, h] = terms.map((t) => t.text().length);
  expect(h).toBeGreaterThan(0);
  expect(v).toBeGreaterThan(h * 4);
  for (let f = 0; f < 10; f++) clock.tick(terms);
  expect(terms[0].text().length).toBe(4 * FRAME_BYTES);
  // With the visible one done, the hidden one gets the whole frame.
  const before = terms[1].text().length;
  clock.tick(terms);
  expect(terms[1].text().length - before).toBe(FRAME_BYTES);
});

test('a slice never splits a surrogate pair', () => {
  const { clock, terms, ins } = setup(1);
  const data = 'a' + '😀'.repeat(FRAME_BYTES); // the first cut lands inside a pair
  ins[0].write(data);
  for (let f = 0; f < 10; f++) clock.tick(terms);
  for (const s of terms[0].got) expect(/^[\udc00-\udfff]/.test(s) || /[\ud800-\udbff]$/.test(s)).toBe(false);
  expect(terms[0].text()).toBe(data);
});

test('a removed terminal is dropped from the queue', () => {
  const { clock, terms, ins } = setup(2);
  ins[0].write(burst('a', 1 << 20));
  ins[1].write(burst('b', 1 << 20));
  ins[0].dispose();
  const n = terms[0].got.length;
  clock.tick(terms);
  expect(terms[0].got.length).toBe(n);
  expect(terms[1].text().length).toBe(FRAME_BYTES);
});

test('the frame still comes when animation frames stop (hidden or occluded window): a timer stands in and cancels the frame request', async () => {
  const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const saved = [g.requestAnimationFrame, g.cancelAnimationFrame];
  const cancelled: number[] = [];
  g.requestAnimationFrame = () => 7; // never fires
  g.cancelAnimationFrame = (id: number) => cancelled.push(id);
  try {
    let ran = 0;
    nextFrame(() => ran++);
    await new Promise((r) => setTimeout(r, 400));
    expect(ran).toBe(1);
    expect(cancelled).toEqual([7]); // no frame requests pile up while the window is hidden
  } finally {
    [g.requestAnimationFrame, g.cancelAnimationFrame] = saved;
  }
});

test('cancelling a requested frame clears both the frame request and the timer', async () => {
  const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const saved = [g.requestAnimationFrame, g.cancelAnimationFrame];
  const cancelled: number[] = [];
  g.requestAnimationFrame = () => 9;
  g.cancelAnimationFrame = (id: number) => cancelled.push(id);
  try {
    let ran = 0;
    nextFrame(() => ran++)();
    await new Promise((r) => setTimeout(r, 400));
    expect([ran, cancelled]).toEqual([0, [9]]);
  } finally {
    [g.requestAnimationFrame, g.cancelAnimationFrame] = saved;
  }
});

test('disposing the last busy terminal leaves no frame requested', () => {
  const { clock, ins } = setup(2);
  ins[0].write(burst('a', 4 * FRAME_BYTES));
  expect(clock.frames.length).toBe(1);
  ins[0].dispose();
  expect(clock.frames.length).toBe(0);
  ins[1].write(burst('b', 4 * FRAME_BYTES)); // a later burst still gets its frame
  expect(clock.frames.length).toBe(1);
});
