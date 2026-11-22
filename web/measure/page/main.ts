// WebGL comparison row (V1A-44): the same stream written into n xterm.js terminals mounted with the window's options,
// DOM renderer (shipped) or @xterm/addon-webgl. Measure only: switching the window's renderer is a separate owner
// decision. Font, size and theme are the window's defaults (settings DEFAULTS, the light Nunchiro theme);
// tests/scenario/test_measure_paint.py checks scrollback, lineHeight and allowProposedApi against web/src/Terminal.tsx.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { DEFAULTS } from '../../src/settings';
import { TERM_DEFAULTS } from '../../src/terminal/options';
import { xtermTheme } from '../../src/themes/derive';

const SCROLLBACK = TERM_DEFAULTS.scrollback;
const OPTIONS = {
  fontFamily: DEFAULTS.termFont,
  fontSize: DEFAULTS.termFontSize,
  lineHeight: 1.2,
  scrollback: SCROLLBACK,
  allowProposedApi: true,
  theme: xtermTheme(DEFAULTS.themeLight.colors),
};
const CHUNK = 1 << 16;
const frame = () => new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())));

/** Writes the stream into each terminal, the next 64 KiB chunk on the previous one's write callback (the window writes
 * per socket frame without one; the DOM control shares this flow, so the comparison holds). */
async function run(n: number, renderer: 'dom' | 'webgl') {
  const grid = document.getElementById('grid')!;
  const cols = Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, 1fr)`;
  const data = new Uint8Array(await (await fetch('/stream.bin')).arrayBuffer());
  let lost = 0;
  const terms = Array.from({ length: n }, () => {
    const cell = grid.appendChild(document.createElement('div'));
    const term = new Terminal(OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(cell);
    if (renderer === 'webgl') {
      const gl = new WebglAddon();
      gl.onContextLoss(() => lost++);
      term.loadAddon(gl); // throws without a WebGL2 context: the row then reports the error
    }
    fit.fit();
    return term;
  });
  await frame();
  const t0 = performance.now();
  const ends = await Promise.all(
    terms.map(async (term) => {
      for (let i = 0; i < data.length; i += CHUNK) await new Promise<void>((r) => term.write(data.subarray(i, i + CHUNK), r));
      await frame(); // the refresh the last write scheduled
      return (await frame()) - t0; // the frame that shows it
    }),
  );
  return { wall_ms: Math.max(...ends), ends_ms: ends, context_lost: lost, cols: terms[0].cols, rows: terms[0].rows };
}

(window as unknown as { paintRun: typeof run }).paintRun = run;

// V1A-51 renderer check in the real Tauri window (scripts/measure/window.py builds this page into a debug app). Render-
// bound loads, DOM vs WebGL: a full-screen truecolour TUI redraw, a maximised pane scrolling, 8 panes redrawing. Per
// run: frame intervals, script busy share (xterm's timers and frame callbacks and the writes timed; style, layout and
// paint are not script),
// echo-to-frame for a one-character write mid-load (input path excluded: no real keys), WebGL context losses. Results
// go to the script's WebSocket sink (the window's CSP allows ws://127.0.0.1 only). Screenshots are the script's.
type Load = 'tui' | 'scroll' | 'redraw8';
const REDRAWS = 240;
const SCROLL_BYTES = 8 << 20;

function tuiFrame(cols: number, rows: number, k: number) {
  let s = '\x1b[H';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = (x * 7 + y * 13 + k * 5) & 255;
      s += `\x1b[38;2;${v};${255 - v};${(v * 3) & 255}m\x1b[48;2;${(v * 5) & 255};${v >> 1};${255 - (v >> 2)}m${String.fromCharCode(0x21 + ((x + y + k) % 90))}`;
    }
    if (y < rows - 1) s += '\r\n';
  }
  return s + '\x1b[0m';
}

function scrollText(bytes: number) {
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    const line = `\x1b[3${i % 8}m${String(i).padStart(8, '0')}\x1b[0m ${'lorem ipsum dolor sit amet '.repeat(6)}\r\n`;
    parts.push(line);
    n += line.length;
  }
  return parts.join('');
}

async function check(load: Load, renderer: 'dom' | 'webgl') {
  const grid = document.getElementById('grid')!;
  grid.replaceChildren();
  const n = load === 'redraw8' ? 8 : 1;
  const cols = Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, 1fr)`;
  let lost = 0;
  const errors: string[] = [];
  const terms = Array.from({ length: n }, () => {
    const term = new Terminal(OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(grid.appendChild(document.createElement('div')));
    if (renderer === 'webgl') {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => lost++);
        term.loadAddon(gl);
      } catch (e) {
        errors.push(String(e));
      }
    }
    fit.fit();
    return term;
  });
  await frame();
  const frames: number[] = [];
  let on = true;
  const loop = (t: number) => (frames.push(t), on && requestAnimationFrame(loop));
  requestAnimationFrame(loop);
  let busy = 0;
  const timed = <T>(f: () => T) => {
    const t = performance.now();
    try {
      return f();
    } finally {
      busy += performance.now() - t;
    }
  };
  // xterm parses on its own timers and renders on animation frames: time those too while the load runs.
  const w = window as unknown as Record<string, Function>;
  const [st, raf] = [w.setTimeout, w.requestAnimationFrame];
  const wrap = (f: unknown) => (typeof f === 'function' ? (...a: unknown[]) => timed(() => f(...a)) : f);
  w.setTimeout = (f: unknown, ...a: unknown[]) => st.call(window, wrap(f), ...a);
  w.requestAnimationFrame = (f: unknown) => raf.call(window, wrap(f));
  const echoes: number[] = [];
  let stop = false;
  const probe = (async () => {
    while (!stop) {
      await new Promise((r) => setTimeout(r, 500));
      if (stop) break;
      const t0 = performance.now();
      await new Promise<void>((r) => timed(() => terms[0].write('K', r)));
      echoes.push((await frame()) - t0);
    }
  })();
  const t0 = performance.now();
  const scroll = load === 'scroll' ? scrollText(SCROLL_BYTES) : '';
  await Promise.all(
    terms.map(async (term) => {
      if (load === 'scroll') {
        for (let i = 0; i < scroll.length; i += CHUNK) await new Promise<void>((r) => timed(() => term.write(scroll.slice(i, i + CHUNK), r)));
      } else {
        for (let k = 0; k < REDRAWS; k++) await new Promise<void>((r) => timed(() => term.write(tuiFrame(term.cols, term.rows, k), r)));
      }
    }),
  );
  await frame();
  const wall = performance.now() - t0;
  [w.setTimeout, w.requestAnimationFrame] = [st, raf];
  stop = true;
  on = false;
  await probe;
  const gaps = frames.filter((t) => t >= t0).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1);
  const size = { cols: terms[0].cols, rows: terms[0].rows };
  // Disposed after the screenshot: the last frame of the load stays on screen until then.
  return { load, renderer, wall_ms: wall, gaps, busy_share: busy / wall, echoes, context_lost: lost, errors, ...size, dispose: () => terms.forEach((t) => t.dispose()) };
}

async function auto() {
  const sink = (await (await fetch('/sink.json')).json()) as { port: number; repeats: number };
  const ws = new WebSocket(`ws://127.0.0.1:${sink.port}/`);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  // The script screenshots the window after each run while the last frame of the load is still on screen.
  const ask = (m: object) =>
    new Promise<void>((r) => {
      ws.onmessage = () => r();
      ws.send(JSON.stringify(m));
    });
  for (let rep = 0; rep < sink.repeats; rep++)
    for (const load of ['tui', 'scroll', 'redraw8'] as Load[])
      for (const renderer of ['dom', 'webgl'] as const) {
        const { dispose, ...out } = await check(load, renderer).catch((e: Error) => ({ load, renderer, error: String(e.message ?? e), dispose: () => {} }));
        await ask({ rep, ...out });
        dispose();
      }
  ws.send(JSON.stringify({ done: true }));
}

if ('__TAURI_INTERNALS__' in window) void auto();
