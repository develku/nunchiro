// V1A-51: output reaches xterm through one queue per terminal, drained once per animation frame. xterm parses each
// write() whole, and with 8 terminals bursting its parse tasks (12 ms each, per terminal) ran back to back for up to
// 0.7 s without WebKit drawing a frame (docs/v1/figures.md, V1A-51 profile). Here every frame hands xterm about
// BUDGET_MS of parse in total, shared round-robin, and a terminal gets its next slice only after xterm parsed the last
// one. The bytes that take are learnt from the frames before: each frame's batch is timed from the first timer after
// its writes (xterm parses on timers) to its last write callback.
// Strings are decoded before they queue (Terminal.tsx), so sizes count UTF-16 units, about bytes for terminal output.

/** Parse time per frame for all terminals together, ms: about half a 60 Hz frame, the rest left to paint. */
export const BUDGET_MS = 8;
/** The first frame's budget, before any parse was timed (Alacritty's per-lock parse size). */
export const START_BYTES = 64 * 1024;
/** Bounds on a frame's budget, so one odd sample (a GC inside a parse, a tiny batch) cannot stall or flood a frame. */
export const MIN_BYTES = 16 * 1024;
export const MAX_BYTES = 4 << 20;
/** Weight of the newest sample in the parse rate. */
const NEW = 0.3;
/** A chunk this small on a terminal with nothing queued is written at once: key echo, a prompt (kitty's < 1 KB rule). */
export const SMALL = 1024;
/** Output within this long after a keystroke on that terminal is written at once, up to a frame's budget (a TUI redraw). */
export const ECHO_MS = 100;
/** While visible terminals are busy, hidden ones still get this much per frame between them. */
export const HIDDEN_BYTES = 4 * 1024;

export interface Sink {
  write(data: string, callback?: () => void): void;
}

interface Chunk {
  text: string;
  at: number;
  done?: () => void;
}

class Queue {
  chunks: Chunk[] = [];
  busy = false; // a slice is with xterm, not parsed yet
  private onParsed: (() => void)[] = [];
  /** Runs once xterm parsed the slice in flight. */
  parsed(f: () => void) {
    this.onParsed.push(f);
  }
  shown = true;
  keyAt = -Infinity;
  constructor(readonly sink: Sink) {}
  get empty() {
    return this.chunks.length === 0;
  }
  /** Hands xterm up to n units, across as many queued chunks as fit, in one write; each finished chunk's callback
   * runs once xterm parsed it. Returns what it wrote. */
  feed(n: number): number {
    let slice = '';
    const done: (() => void)[] = [];
    while (this.chunks.length && slice.length < n) {
      const c = this.chunks[0];
      let end = Math.min(c.text.length, c.at + n - slice.length);
      if (end < c.text.length && end > c.at && isHigh(c.text.charCodeAt(end - 1))) end--; // never split a surrogate pair
      if (end === c.at && end < c.text.length) {
        if (slice) break;
        end = Math.min(c.text.length, c.at + 2); // a share of 1 unit landing on a pair: take the pair
      }
      slice += c.text.slice(c.at, end);
      c.at = end;
      if (end < c.text.length) break;
      this.chunks.shift();
      if (c.done) done.push(c.done);
    }
    this.busy = true;
    this.sink.write(slice, () => {
      this.busy = false;
      done.forEach((f) => f());
      const ps = this.onParsed;
      this.onParsed = [];
      ps.forEach((f) => f());
    });
    return slice.length;
  }
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;

export interface Writer {
  /** Queues output for this terminal (FIFO); `done` runs once xterm parsed all of it. */
  write(text: string, done?: () => void): void;
  /** A keystroke on this terminal: its echo should not wait for a frame. */
  key(): void;
  /** Hidden terminals drain at the lowest priority. */
  active(shown: boolean): void;
  dispose(): void;
}

/** requestAnimationFrame, with a timer standing in when frames stop (hidden or occluded window), so queues still drain.
 * Whichever comes first cancels the other; the returned function cancels both. */
export function nextFrame(f: () => void): () => void {
  const cancel = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
  const run = () => {
    cancel();
    f();
  };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, 250);
  return cancel;
}

export class Writers {
  private queues: Queue[] = [];
  private turn = 0; // round-robin start, so leftovers do not always land on the same terminal
  private hiddenTurn = 0;
  private cancel: (() => void) | null = null;
  private rate = START_BYTES / BUDGET_MS; // units parsed per ms, learnt

  constructor(
    private frame: (f: () => void) => () => void = nextFrame,
    private now: () => number = () => performance.now(),
    private later: (f: () => void) => void = (f) => void setTimeout(f),
  ) {}

  /** This frame's bytes: BUDGET_MS at the parse rate measured so far. */
  budget() {
    return Math.round(Math.min(MAX_BYTES, Math.max(MIN_BYTES, this.rate * BUDGET_MS)));
  }

  add(sink: Sink): Writer {
    const q = new Queue(sink);
    this.queues.push(q);
    return {
      write: (text, done) => {
        const echo = this.now() - q.keyAt < ECHO_MS ? this.budget() : SMALL;
        // Straight through only when nothing of this terminal is queued, so order holds (xterm keeps its own FIFO).
        if (q.empty && text.length <= echo) return sink.write(text, done);
        q.chunks.push({ text, at: 0, done });
        this.schedule();
      },
      key: () => (q.keyAt = this.now()),
      active: (shown) => {
        q.shown = shown;
      },
      dispose: () => {
        this.queues = this.queues.filter((x) => x !== q);
        if (this.queues.every((x) => x.empty)) {
          this.cancel?.();
          this.cancel = null;
        }
      },
    };
  }

  private schedule() {
    if (this.cancel) return;
    this.cancel = this.frame(() => {
      this.cancel = null;
      this.drain();
    });
  }

  private drain() {
    const ready = (shown: boolean) => this.queues.filter((q) => q.shown === shown && !q.empty && !q.busy);
    const shown = ready(true);
    const hidden = ready(false);
    // A visible terminal with output left (even one xterm is still parsing) keeps the hidden ones to their minimum.
    const visibleBusy = this.queues.some((q) => q.shown && !q.empty);
    const full = this.budget();
    let budget = full;
    const fed: Queue[] = [];
    const feed = (q: Queue, n: number) => {
      fed.push(q);
      return q.feed(n);
    };
    // Queued before the writes, so it runs just ahead of xterm's parse timers: the batch's parse starts here.
    let start = -1;
    this.later(() => (start = this.now()));
    if (visibleBusy && hidden.length) budget -= feed(hidden[this.hiddenTurn++ % hidden.length], HIDDEN_BYTES);
    const pool = visibleBusy ? shown : hidden;
    const first = this.turn++ % Math.max(1, pool.length);
    for (let i = 0; i < pool.length; i++) {
      const share = Math.floor(budget / (pool.length - i));
      if (share <= 0) break;
      budget -= feed(pool[(first + i) % pool.length], share);
    }
    const bytes = full - budget;
    // Only a batch that used most of the budget says how fast xterm parses; a small one is mostly fixed cost.
    if (fed.length && bytes >= full / 2) {
      let left = fed.length;
      for (const q of fed)
        q.parsed(() => {
          if (--left || start < 0) return;
          const ms = Math.max(0.5, this.now() - start);
          this.rate = (1 - NEW) * this.rate + NEW * (bytes / ms);
        });
    }
    // Queues waiting on xterm's parse, or with data left, come back next frame.
    if (this.queues.some((q) => !q.empty)) this.schedule();
  }
}

/** The window's one scheduler: every terminal shares the frame budget. */
export const writers = new Writers();
