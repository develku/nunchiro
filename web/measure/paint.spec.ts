// V1A-44 paint figures: one job per run (PAINT_JOB, written by scripts/measure/paint.py, which owns the core, the fake
// agents and every process). The shipped bundle on a real core, keys typed into the page the way the window gets them;
// "painted" = the text is in xterm's rendered DOM rows and the next animation frame has fired (the frame showing it).
// Timing is in-page (performance.now); send/done marks are process.hrtime, the clock of echo_target.py's read log.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { windowAuth } from '../tests/fixtures';

interface Job {
  phase: 'echo' | 'stream' | 'mem' | 'soak' | 'webgl';
  home: string;
  bin: string;
  out: string;
  root_file: string;
  echo: string | null;
  sessions: string[];
  labels: Record<string, string>;
  triggers: string[];
  keys: string[];
  gap_ms: number;
  probe_every_ms: number;
  timeout_s: number;
  soak_s: number;
  sample_every_s: number;
  stream: string;
  sizes: number[];
  repeats: number;
  page_url: string;
  profile?: boolean;
  marks?: boolean; // echo phase: also mark the key's WebSocket send and the echo frame's arrival (paint.py --marks)
  cpuprofile?: string; // echo phase, Chromium: a CDP CPU profile of the key loop is written here (paint.py --echo-profile)
}

const job = JSON.parse(fs.readFileSync(process.env.PAINT_JOB ?? '', 'utf8')) as Job;
const FP = path.resolve(import.meta.dirname, '../../scripts/measure/paint_fp.py');
const hr = () => process.hrtime.bigint().toString();
const cli = (...args: string[]) => execFileSync(job.bin, args, { env: { ...process.env, NUNCHIRO_HOME: job.home }, encoding: 'utf8', timeout: 20_000 });
const term = (sid: string) => `.term[data-session="${sid}"]:not([hidden])`;
const zones = (page: Page) => page.$$eval('[data-zone-id]', (els) => els.map((e) => (e as HTMLElement).dataset.zoneId!));

/** V2.5-18 r2: times, in page clock, of the WebSocket send that carries the current key and of the first output frame that echoes it. */
function marker() {
  const w = window as unknown as Record<string, any>;
  const Native = window.WebSocket;
  const dec = new TextDecoder();
  w.WebSocket = class extends Native {
    constructor(...a: ConstructorParameters<typeof WebSocket>) {
      super(...a);
      this.addEventListener('message', (ev) => {
        const k = w.__key?.k;
        if (!k || w.__key.recv !== undefined || typeof ev.data === 'string') return;
        const b = new Uint8Array(ev.data as ArrayBuffer);
        const n = new DataView(b.buffer, b.byteOffset).getUint32(0);
        if (dec.decode(b.subarray(4 + n)).includes(k)) w.__key.recv = performance.now();
      });
    }
    send(d: Parameters<WebSocket['send']>[0]) {
      const k = w.__key?.k;
      if (k && w.__key.send === undefined && typeof d === 'string' && d.includes('send_text') && d.includes(JSON.stringify(k).slice(1, -1))) w.__key.send = performance.now();
      super.send(d);
    }
  };
}

/** Frame recorder, long tasks (Chromium only), and the first keydown/input time of each key. */
function recorder() {
  const w = window as unknown as Record<string, any>;
  w.__paint = { frames: [] as number[], on: false, long: [] as number[][] };
  const loop = (t: number) => {
    if (w.__paint.on) w.__paint.frames.push(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__paint.long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true });
  } catch {
    // WebKit has no longtask entries.
  }
  w.__key = { t: null };
  const first = () => {
    if (w.__key.t === null) w.__key.t = performance.now();
  };
  addEventListener('keydown', first, true);
  addEventListener('input', first, true);
}

/** V1A-51 profile (paint.py --profile): every timer, animation-frame and WebSocket message task as [start, ms, kind,
 * bytes], so a long frame splits into xterm's parse (its write buffer runs on setTimeout), its render (rAF), message
 * handling, and the rest (style, layout, paint, GC: time no script task covers). */
function profiler() {
  const w = window as unknown as Record<string, any>;
  const tasks: (number | string)[][] = (w.__prof = []);
  const timed = (kind: string, f: Function, bytes = 0) =>
    function (this: unknown, ...a: unknown[]) {
      const t = performance.now();
      try {
        return f.apply(this, a);
      } finally {
        tasks.push([t, performance.now() - t, kind, bytes]);
      }
    };
  const st = window.setTimeout;
  w.setTimeout = (f: unknown, ...a: unknown[]) => (st as Function)(typeof f === 'function' ? timed('timeout', f) : f, ...a);
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (f) => raf(timed('raf', f) as FrameRequestCallback);
  const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    ...d,
    set(f) {
      d.set!.call(this, (ev: MessageEvent) => timed('ws', f, typeof ev.data === 'string' ? ev.data.length : ev.data.byteLength).call(this, ev));
    },
  });
}

const idleFps = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((r) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : r(Math.round(((n - 1) * 10000) / (performance.now() - t0)) / 10));
        requestAnimationFrame(f);
      }),
  );
const frames = (page: Page, on: boolean) =>
  page.evaluate((on) => {
    const p = (window as unknown as Record<string, any>).__paint;
    if (on) Object.assign(p, { frames: [], long: [], on: true, t0: performance.now() });
    else p.on = false;
    return { frames: p.frames as number[], long: p.long as number[][], t0: p.t0 as number };
  }, on);

async function openWindow(page: Page) {
  await page.addInitScript((b) => ((window as unknown as Record<string, unknown>).__NUNCHIRO__ = b), windowAuth(job.home));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible({ timeout: 30_000 });
}

/** One command, then the zone it added. */
async function added(page: Page, ...args: string[]) {
  const before = await zones(page);
  cli('layout', ...args);
  await expect.poll(async () => (await zones(page)).length).toBe(before.length + 1);
  return (await zones(page)).find((z) => !before.includes(z))!;
}

/** Every session pinned in its own zone, a grid of ceil(sqrt(n)) columns starting from zone `first`. */
async function grid(page: Page, sids: string[], first = 'terminal') {
  const cols = Math.ceil(Math.sqrt(sids.length));
  cli('layout', 'pin', sids[0], '--zone', first);
  const rows = [first];
  for (let r = 1; r * cols < sids.length; r++) rows.push(await added(page, 'split', 'down', 'terminal', '--pin', sids[r * cols], '--zone', rows[r - 1]));
  for (let r = 0; r < rows.length; r++) {
    let z = rows[r];
    for (let c = 1; c < cols && r * cols + c < sids.length; c++) z = await added(page, 'split', 'right', 'terminal', '--pin', sids[r * cols + c], '--zone', z);
  }
  for (const s of sids) await expect(page.locator(term(s))).toHaveCount(1);
}

const lastRow = (page: Page, sid: string) => page.locator(`${term(sid)} .xterm-rows > div`).last();
async function ready(page: Page, sids: string[]) {
  for (const s of sids) await expect(lastRow(page, s)).toContainText(`READY ${job.labels[s]}`, { timeout: 30_000 });
  if (job.echo) await expect(page.locator(`${term(job.echo)} .xterm-rows`)).toContainText('ECHO_READY', { timeout: 30_000 });
}

/** Watches each session's status row: the painted time of its end marker and of each new heartbeat. */
const watch = (page: Page, sids: string[]) =>
  page.evaluate(
    ([pairs, sel]) => {
      const w = window as unknown as Record<string, any>;
      w.__end = {};
      w.__hb = {};
      for (const [sid, label] of pairs) {
        const rows = document.querySelector(sel.replace('SID', sid) + ' .xterm-rows')!;
        const hb = (w.__hb[label] = [] as number[][]);
        new MutationObserver(() => {
          const t = rows.lastElementChild?.textContent ?? '';
          if (!(label in w.__end) && t.includes(`@@PAINT END ${label}@@`)) {
            w.__end[label] = null;
            requestAnimationFrame(() => (w.__end[label] = performance.now()));
          }
          const m = /HB \S+ (\d+)/.exec(t);
          if (m && (!hb.length || hb[hb.length - 1][0] !== +m[1])) hb.push([+m[1], performance.now()]);
        }).observe(rows, { childList: true, subtree: true, characterData: true });
      }
    },
    [sids.map((s) => [s, job.labels[s]]), term('SID')] as const,
  );

let nextKey = 0;
/** Types one key into the echo session as the window receives it; ms = first keydown/input to the frame after the echo is in the rows. */
async function key(page: Page) {
  const k = job.keys[nextKey++ % job.keys.length];
  await page.evaluate(
    ([sel, k]) => {
      const w = window as unknown as Record<string, any>;
      const rows = document.querySelector(sel + ' .xterm-rows')!;
      const count = () => rows.textContent!.split(k).length - 1;
      const c0 = count();
      w.__key.t = null;
      w.__key.k = k;
      w.__key.send = w.__key.recv = undefined;
      w.__key.p = new Promise((res) => {
        const mo = new MutationObserver(() => {
          if (count() <= c0) return;
          mo.disconnect();
          clearTimeout(timer);
          const tm = performance.now();
          requestAnimationFrame(() => res({ t0: w.__key.t, tm, tf: performance.now(), send: w.__key.send, recv: w.__key.recv, since_frame: tm - w.__paint.frames[w.__paint.frames.length - 1] }));
        });
        const timer = setTimeout(() => (mo.disconnect(), res(null)), 2000);
        mo.observe(rows, { childList: true, subtree: true, characterData: true });
      });
    },
    [term(job.echo!), k] as const,
  );
  const send_ns = hr();
  if (/^[\x20-\x7e]$/.test(k)) await page.keyboard.press(k);
  else await page.keyboard.insertText(k); // a whole syllable, as an IME commit delivers it
  const r = (await page.evaluate(() => (window as unknown as Record<string, any>).__key.p)) as { t0: number | null; tm: number; tf: number; send?: number; recv?: number; since_frame?: number } | null;
  const done_ns = hr();
  const ok = r !== null && r.t0 !== null;
  return { k, hex: Buffer.from(k).toString('hex'), send_ns: Number(send_ns), done_ns: Number(done_ns), ms: ok ? r.tf - r.t0! : null, dom_ms: ok ? r.tm - r.t0! : null, ...(job.marks && ok ? { send_ms: r.send === undefined ? null : r.send - r.t0!, recv_ms: r.recv === undefined ? null : r.recv - r.t0!, since_frame_ms: r.since_frame ?? null } : {}) };
}

async function footprint(page: Page, engine: string) {
  const root = fs.readFileSync(job.root_file, 'utf8').trim();
  const fp = JSON.parse(execFileSync('python3', ['-I', '-B', FP, String(process.pid), engine, root], { encoding: 'utf8', timeout: 60_000 }));
  let heap: number | null = null;
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    heap = ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
    await cdp.detach();
  }
  return { ...fp, heap };
}

async function settled(page: Page, engine: string) {
  const s = [];
  for (let i = 0; i < 3; i++) {
    if (i) await page.waitForTimeout(2000);
    s.push(await footprint(page, engine));
  }
  return s;
}

const touch = () => job.triggers.forEach((t) => fs.writeFileSync(t, ''));
const ends = (page: Page) => page.evaluate(() => (window as unknown as Record<string, any>).__end as Record<string, number | null>);
const allEnded = (e: Record<string, number | null>) => job.sessions.every((s) => typeof e[job.labels[s]] === 'number');

test('paint', async ({ page, browserName }) => {
  const res: Record<string, unknown> = { phase: job.phase, engine: browserName, browser: page.context().browser()?.version() };
  let crashes = 0;
  page.on('crash', () => crashes++);
  await page.addInitScript(recorder);
  if (job.marks) await page.addInitScript(marker);
  if (job.profile) await page.addInitScript(profiler);
  try {
    if (job.phase === 'webgl') {
      await page.route('**/stream.bin', (r) => r.fulfill({ path: job.stream, contentType: 'application/octet-stream' }));
      const runs = [];
      for (let rep = 0; rep < job.repeats; rep++)
        for (const n of job.sizes)
          for (const renderer of ['dom', 'webgl'] as const) {
            await page.goto(job.page_url);
            const fps = await idleFps(page);
            await frames(page, true);
            const out = await page.evaluate(([n, r]) => (window as unknown as { paintRun: (n: number, r: string) => Promise<unknown> }).paintRun(n, r), [n, renderer] as const).catch((e: Error) => ({ error: String(e.message ?? e) }));
            runs.push({ n, renderer, rep, idle_fps: fps, ...(out as object), ...(await frames(page, false)) });
          }
      res.runs = runs;
      return;
    }
    // Stream rows: each output frame the window received per session, as [start, length]; paint.py counts every byte
    // once (ml.delivery). The core keeps 1 MiB per session, so a window further behind skips ahead (a gap before start).
    const got: Record<string, number[][]> = {};
    if (job.phase === 'stream')
      page.on('websocket', (ws) =>
        ws.on('framereceived', ({ payload }) => {
          if (typeof payload === 'string') return;
          const n = payload.readUInt32BE(0);
          const h = JSON.parse(payload.subarray(4, 4 + n).toString()) as { session: string; start: number };
          (got[h.session] ??= []).push([h.start, payload.length - 4 - n]);
        }),
      );
    await openWindow(page);
    if (job.phase === 'mem') {
      cli('layout', 'pin', 'baseline-no-session', '--zone', 'terminal'); // shows "not running": no xterm at all
      await expect(page.locator('.term')).toHaveCount(0);
      await page.waitForTimeout(5000);
      res.base = await settled(page, browserName);
      await grid(page, job.sessions);
      await ready(page, job.sessions);
      await watch(page, job.sessions);
      touch();
      await expect.poll(async () => allEnded(await ends(page)), { timeout: job.timeout_s * 1000, intervals: [500] }).toBe(true);
      await page.waitForTimeout(5000);
      res.loaded = await settled(page, browserName);
      res.sizes = await Promise.all(job.sessions.map((s) => lastRow(page, s).innerText()));
      res.terminals = job.sessions.length;
      return;
    }
    const shown = job.echo ? [job.echo, ...job.sessions] : job.sessions;
    await grid(page, shown);
    await ready(page, job.sessions);
    res.idle_fps = await idleFps(page);
    await watch(page, job.sessions);
    if (job.echo) await page.locator(`${term(job.echo)} .xterm`).click();
    if (job.phase === 'echo') {
      touch(); // the busy sessions stream while keys are typed
      await page.waitForTimeout(3000);
      await frames(page, true);
      const cdp = job.cpuprofile && browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
      if (cdp) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        await cdp.send('Profiler.start');
      }
      const keys = [];
      for (let i = 0; i < job.keys.length; i++) {
        keys.push(await key(page));
        await page.waitForTimeout(job.gap_ms);
      }
      res.keys = keys;
      if (cdp) {
        const { profile } = (await cdp.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
        fs.writeFileSync(job.cpuprofile!, JSON.stringify(profile));
        const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
        const self = new Map<string, number>();
        profile.samples.forEach((id, i) => {
          const f = byId.get(id)!;
          const k = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
          self.set(k, (self.get(k) ?? 0) + profile.timeDeltas[i] / 1000);
        });
        res.cpu_top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, Math.round(v * 10) / 10]);
        res.cpuprofile = job.cpuprofile;
      }
      res.recorded = await frames(page, false);
    } else if (job.phase === 'stream') {
      await frames(page, true);
      touch();
      const probes = [];
      const until = Date.now() + job.timeout_s * 1000;
      await page.waitForTimeout(300);
      while (Date.now() < until && !allEnded(await ends(page))) {
        if (job.echo) probes.push(await key(page));
        await page.waitForTimeout(job.probe_every_ms);
      }
      res.ends = await ends(page);
      // The stream's last record (a run of '=' padding) shows above the status row: the whole stream arrived, not only the marker.
      res.tails = await page.$$eval(job.sessions.map((s) => `${term(s)} .xterm-rows`).join(','), (els) => els.filter((e) => /={20}/.test(e.textContent ?? '')).length);
      res.probes = probes;
      res.wsframes = Object.fromEntries(job.sessions.map((s) => [job.labels[s], got[s] ?? []]));
      res.recorded = await frames(page, false);
      if (job.profile) res.profile = await page.evaluate(() => (window as unknown as Record<string, any>).__prof);
    } else {
      const t0 = await page.evaluate(() => performance.now());
      touch();
      const samples = [];
      for (let m = 0; m * job.sample_every_s <= job.soak_s; m++) {
        if (m) await page.waitForTimeout(Math.max(0, t0 + m * job.sample_every_s * 1000 - (await page.evaluate(() => performance.now()))));
        samples.push({ minute: (m * job.sample_every_s) / 60, ...(await footprint(page, browserName)) });
      }
      res.t0 = t0;
      res.t_end = await page.evaluate(() => performance.now());
      res.samples = samples;
      res.hb = await page.evaluate(() => (window as unknown as Record<string, any>).__hb);
      res.connected = await page.getByRole('status').filter({ hasText: /^Connected$/ }).isVisible();
    }
  } catch (e) {
    res.error = String(e);
    throw e;
  } finally {
    res.crashes = crashes;
    fs.writeFileSync(job.out, JSON.stringify(res));
  }
});
