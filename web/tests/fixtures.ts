// Each test gets its own real core (`nunchiro serve`) with a private NUNCHIRO_HOME under .scratch and a
// fake `claude` on PATH, so no test touches ~/.claude, ~/.codex or a real agent.
import { test as base, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '../..');
/** Ticket 1150: a fake `codex` script (sh or python3) for a test, made to answer the core's question too. Before every
 *  Codex start the core runs that Codex as `codex app-server ...` and asks which hooks it would run; only a Codex that
 *  lists Nunchiro's outward hook, on and trusted, is started, and a fake that says nothing is refused like a real one
 *  ("Codex did not say whether it runs Nunchiro's outward-action check"). So every fake `codex` a spec starts as a
 *  session goes through here: its first line after `#!` hands that run to the shared answer script, which says yes.
 *  (The Rust tests' twin is `home::codex_fake`; the copied fixtures `codex`, `codex-picker` and `claude-mode` answer
 *  on their own.) */
export function codexFake(script: string) {
  const yes = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/codex-app-server');
  const cut = script.indexOf('\n');
  if (!script.startsWith('#!') || cut < 0) return script;
  const asked = script.slice(0, cut).includes('python')
    ? `import os, sys\nif sys.argv[1:2] == ['app-server']: os.execv('${yes}', ['${yes}'])\n`
    : `[ "$1" != app-server ] || exec '${yes}'\n`;
  return script.slice(0, cut + 1) + asked + script.slice(cut + 1);
}
const BIN = path.join(REPO, 'target/debug/nunchiro');
const SCRATCH = path.join(REPO, '.scratch') + path.sep;
export const ORIGIN = `http://127.0.0.1:${process.env.NUNCHIRO_WEB_PORT ?? '4173'}`;
export const HANGUL = '눈치로 한글 입력 확인: 가나다 똠방각하 읽었어요';

const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event, payload = '{}'] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: JSON.parse(payload) } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;

// The model flag names the file the fake agent waits for before showing its permission dialog.
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
# Ticket 416: the core's account probe gets an answer at once (read as unknown, as its timeout was), so no probe is still
# running, then orphaned for its sleep, when the test stops the core.
if [ "$1 $2" = "auth status" ]; then exit 2; fi
go=""; prev=""
for a in "$@"; do [ "$prev" = --model ] && go="$a"; prev="$a"; done
printf 'fake agent ready\\r\\n'
if [ -n "$go" ]; then while [ ! -f "$go" ]; do sleep 0.02; done; fi
# Ticket 611: a real Claude redraws its prompt after a resize (SIGWINCH) and the core blanks its screen on each resize, so
# the fake redraws too; a trapped signal ends \`read\` early, so it reads again.
ask() { printf '\\033[2J\\033[HDo you want to proceed?\\r\\n1. Yes\\r\\n2. No\\r\\n'; }
ask
trap ask WINCH
while :; do read x; [ $? -gt 128 ] || break; done
trap - WINCH
printf '\\033[2J\\033[Hanswered %s\\r\\n' "$x" # the prompt leaves the screen, as a real Claude's does
sleep 600
`;

// Ticket 1013 F6: one request on the window's own socket (the window token, the window's Origin), as the tab's Close sends it.
const WINDOW_REQUEST = `const [port, token, origin, request] = process.argv.slice(1);
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { protocols: ['nunchiro.v1', 'nunchiro.token.' + token], headers: { Origin: origin } });
ws.onopen = () => ws.send(JSON.stringify({ id: 1, request: JSON.parse(request) }));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; process.stdout.write(JSON.stringify(m.response)); ws.close(); };
ws.onerror = () => { process.stdout.write('{"Err":"window socket failed"}'); process.exit(); };`;

// v1a-13: the window token is not in window.json; ask the owner socket, as the app does at page load.
const WINDOW_AUTH = `const net = require('net'), fs = require('fs'), path = require('path'); const h = process.argv[1];
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'window_auth' } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
export function windowAuth(home: string) {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', WINDOW_AUTH, home], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`window_auth refused: ${reply.Err}`);
  return { port: reply.Ok.port as number, token: reply.Ok.token as string };
}

/** Every CLI call from a spec: refused, loudly, unless NUNCHIRO_HOME and HOME are a test's folders under .scratch
 *  (a call that loses NUNCHIRO_HOME falls back to $HOME/.nunchiro and auto-starts a core there). */
export function nunchiro(env: NodeJS.ProcessEnv, args: string[], timeout = 20_000) {
  // Resolved first: `.scratch/../x` starts with the folder's name but is outside it.
  const inScratch = (p?: string) => !!p && path.resolve(p).startsWith(SCRATCH);
  if (!inScratch(env.NUNCHIRO_HOME) || !inScratch(env.HOME))
    throw new Error(`nunchiro ${args.join(' ')}: NUNCHIRO_HOME and HOME must be this test's folder under .scratch`);
  // Ticket 991: a `--worktree` start makes a git worktree of its project. A fixture folder that is no repository made
  // git find the checkout around .scratch: the session ran in a checkout of this repository, and each run left a
  // worktree entry registered in it. The project becomes a repository of its own first.
  const own = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  if (own[0] === 'session' && own[1] === 'start' && own.includes('--worktree') && own.includes('--project')) ownRepo(own[own.indexOf('--project') + 1]);
  return execFileSync(BIN, args, { env, encoding: 'utf8', timeout });
}

/** Makes `dir` a git repository with one commit, unless it already lies in one under .scratch (a spec's own). */
export function ownRepo(dir: string) {
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let top = '';
  try {
    top = git('rev-parse', '--show-toplevel').trim();
  } catch {
    // under no repository at all
  }
  if (top && (fs.realpathSync(top) + path.sep).startsWith(fs.realpathSync(SCRATCH) + path.sep)) return;
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
}

/** Worktrees of this checkout's repository registered under `home`: there must be none (see `nunchiro`). */
function leakedWorktrees(home: string) {
  if (!fs.existsSync(path.join(home, 'wt'))) return []; // every fixture's worktrees_dir: nothing was made
  const at = `worktree ${fs.realpathSync(home)}${path.sep}`;
  return execFileSync('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith(at));
}

/** The test home for one core. Short on purpose: core.sock under a long checkout path must stay within macOS's 103-byte
 *  sun_path, so the pid is base 36 and the id hashed (6 hex: no collision inside one worker). */
export function homePath(repo: string, pid: number, id: string) {
  return path.join(repo, '.scratch', `p${pid.toString(36)}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}`);
}

/** Throws, naming the path and its length, when the home's core.sock cannot be bound (the core would only time out). */
export function checkSocketPath(home: string) {
  const sock = path.join(home, 'core.sock');
  const len = Buffer.byteLength(sock);
  if (len > 103) throw new Error(`core socket path ${sock} is ${len} bytes, over the 103-byte unix socket limit`);
  return sock;
}

export class Core {
  home: string;
  proc: ChildProcess;
  env: NodeJS.ProcessEnv;
  constructor(public id: string) {
    this.home = homePath(REPO, process.pid, id);
    checkSocketPath(this.home);
    fs.rmSync(this.home, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(this.home, 'bin/claude'), FAKE_CLAUDE, { mode: 0o700 });
    // Ticket 1002: the Home lead's brief presets count as added, so a spec's schedule list holds only its own; a spec
    // of the presets removes the key before the core starts.
    fs.writeFileSync(path.join(this.home, 'settings.json'), JSON.stringify({ worktrees_dir: path.join(this.home, 'wt'), features: { 'home.brief_presets': true } }));
    fs.mkdirSync(path.join(this.home, 'sentinel-home'));
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(HERDR_|CLAUDE|CODEX_|AI_AGENT|ANTHROPIC_|NUNCHIRO_|EDITOR$|VISUAL$|ZDOTDIR$)/.test(k)) env[k] = v;
    this.env = {
      ...env,
      NUNCHIRO_HOME: this.home,
      // The fake agent draws no input box, so the core would hold every first message for its 20 s start valve.
      NUNCHIRO_STARTUP_QUIET_MS: '300',
      // W10 core 7a7458c55: a plain shell started before any window gave a size waits up to 8 s for one; specs read shells no view opened.
      NUNCHIRO_SHELL_SIZE_WAIT_MS: '0',
      NUNCHIRO_LOGIN_PATH: 'off', // ticket 576: the core keeps the PATH below; a machine's /etc/zprofile would add /opt/homebrew/bin
      NUNCHIRO_WINDOW_ORIGINS: ORIGIN,
      // Ticket 800: the core appends what it would hand to macOS `open` to <home>/opened.argv (`Core.opened`), so no
      // test opens TextEdit, an editor or a browser on the desktop. The runner's $EDITOR, $VISUAL and $ZDOTDIR are dropped above.
      NUNCHIRO_TEST_OPENER: 'record',
      CLAUDE_CONFIG_DIR: path.join(this.home, 'claude-home'),
      CODEX_HOME: path.join(this.home, 'codex-home'),
      PATH: `${path.join(this.home, 'bin')}:/usr/bin:/bin`,
      // V1A-50: a call that ever loses NUNCHIRO_HOME falls back to $HOME/.nunchiro: this empty folder, never the
      // owner's ~/.nunchiro (where a stray call would auto-start a core the owner's app then connects to).
      HOME: path.join(this.home, 'sentinel-home'),
      SHELL: '/bin/sh', // ticket 286: the shell an ended agent leaves
      // A python fake's `--version` probe (sendkeys' claude-mode) still running at teardown wrote Apple python's bytecode cache
      // into sentinel-home/Library/Caches while its home was removed: ENOTEMPTY (nightly 11-21b). No fake writes bytecode.
      PYTHONDONTWRITEBYTECODE: '1',
    };
    this.proc = this.spawnCore();
  }
  private spawnCore() {
    return spawn(BIN, ['serve'], { env: this.env, stdio: ['ignore', 'ignore', fs.openSync(path.join(this.home, 'core.log'), 'a')] });
  }
  /** Simulated restart: after `serve stop`, the same home gets a fresh core. */
  async restart() {
    await expect.poll(() => this.proc.exitCode !== null, { timeout: 10_000 }).toBe(true);
    fs.rmSync(path.join(this.home, 'window.json'), { force: true });
    this.proc = this.spawnCore();
    await this.ready();
  }
  async ready() {
    await expect.poll(() => fs.existsSync(path.join(this.home, 'window.json')), { timeout: 10_000 }).toBe(true);
  }
  boot() {
    return windowAuth(this.home);
  }
  /** Every fixture CLI call: refused, loudly, unless the env names this test's isolated home. */
  run(args: string[], timeout = 20_000) {
    return nunchiro(this.env, args, timeout);
  }
  cli(...args: string[]) {
    return JSON.parse(this.run(args));
  }
  /** Ticket 1013 F6: the window's own Close, which keeps a running session's done tab with Continue and Restart.
   *  `cli('session', 'close', id)` is a command's close: its tab goes at once. */
  windowClose(id: string) {
    const { port, token } = this.boot();
    const reply = JSON.parse(execFileSync(process.execPath, ['-e', WINDOW_REQUEST, String(port), token, ORIGIN, JSON.stringify({ op: 'close', id })], { encoding: 'utf8', timeout: 10_000 }));
    if (!reply.Ok) throw new Error(`window close refused: ${JSON.stringify(reply)}`);
  }
  project(name: string) {
    const dir = path.join(this.home, 'p', name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  }
  /** Ticket 800: what this core handed to `open`, one argument a line, each call starting `open`; '' when nothing. */
  opened() {
    const f = path.join(this.home, 'opened.argv');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }
  /** `cat` echoes everything the window sends, through the PTY's own line discipline. */
  shell(project: string, label: string, program = '/bin/cat', ...args: string[]) {
    return this.cli('session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--', program, ...args).session as { id: string };
  }
  /** Prints recorded agent screen bytes into a PTY, then idles as `cat`. */
  replay(project: string, label: string, bytes: string) {
    return this.shell(project, label, '/bin/sh', '-c', 'printf %s "$1"; exec cat', 'replay', bytes);
  }
  transcriptPath(s: { cwd: string; agent_session_id: string }) {
    const enc = s.cwd.replace(/[^A-Za-z0-9]/g, '-');
    return path.join(this.home, 'claude-home/projects', enc, `${s.agent_session_id}.jsonl`);
  }
  /** Ticket 473: one user line and one answer in a Claude session's transcript; the chat shows its view control only then. */
  said(s: { cwd: string; agent_session_id: string }) {
    const file = this.transcriptPath(s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (type: string, content: unknown) => JSON.stringify({ type, uuid: crypto.randomUUID(), message: { role: type, content } }) + '\n';
    fs.appendFileSync(file, line('user', 'hello') + line('assistant', [{ type: 'text', text: 'Hi.' }]));
  }
  /** An agent hook event through the core's socket, as Claude's own hooks send it (`UserPromptSubmit` starts a turn). */
  hook(id: string, event: 'UserPromptSubmit' | 'Stop', payload: object = {}) {
    const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, this.home, id, event, JSON.stringify(payload)], { encoding: 'utf8', timeout: 10_000 }));
    if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
  }
  /** Fake Claude that shows a permission dialog once `<project>/<trigger>` exists. */
  agent(project: string, label: string, trigger: string, worktree = false) {
    const args = ['session', 'start', '--kind', 'claude', '--project', project, '--label', label, '--model', trigger];
    if (worktree) args.push('--worktree');
    return this.cli(...args).session as { id: string; cwd: string; agent_session_id: string };
  }
  read(id: string): string {
    const out = this.cli('session', 'read', id);
    return Buffer.from(out.data as number[]).toString('utf8');
  }
  /** The core's own parsed screen of a session: the state its waiting detection and picker switch read. */
  screen(id: string): string {
    return this.run(['agent', 'read', id]);
  }
  async stop() {
    let refused: unknown;
    try {
      this.run(['serve', 'stop'], 10_000);
    } catch (e) {
      if (/must be this test's folder/.test(String(e))) refused = e; // a broken env still fails the test, after cleanup
      // Otherwise already gone.
    }
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
      this.proc.kill('SIGKILL');
      await exited; // the core must stop writing before its home is removed
    }
    const leaked = leakedWorktrees(this.home); // read before the home goes
    // shortcut: background probes may briefly populate HOME; join their teardown if the bounded retry stops sufficing.
    fs.rmSync(this.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (refused) throw refused;
    // Ticket 991: a test that added a worktree of the real repository fails here (its project was no repository of its own).
    if (leaked.length) throw new Error(`this test registered ${leaked.length} worktree(s) of the repository around .scratch: make its project a repository (fixtures.ts ownRepo): ${leaked[0]}`);
  }
}

let next = 0;
let current: Core | null = null;
export const test = base.extend<{ core: Core; app: Page; _cov: void; firstRun: boolean }>({
  // Ticket 305: a fresh window opens Settings > Onboarding once. Specs start past that; `test.use({ firstRun: true })` keeps it.
  firstRun: [false, { option: true }],
  // NUNCHIRO_COVERAGE_DIR (scripts/affected-specs.py gen): V8 function coverage of every page this test opens, one dump per test.
  // A test that opens a page through its own browser.newContext is not seen; gen then leaves its spec out of the map.
  _cov: [
    async ({ context, browserName }, use, info) => {
      const dir = process.env.NUNCHIRO_COVERAGE_DIR;
      if (!dir || browserName !== 'chromium') return use();
      const pages: Page[] = [];
      const start = (p: Page) => void p.coverage.startJSCoverage({ resetOnNavigation: false }).then(() => pages.push(p), () => {});
      context.pages().forEach(start);
      context.on('page', start);
      await use();
      const fns: Record<string, { s: number; e: number; c: number }[]> = {};
      for (const p of pages) {
        for (const entry of await p.coverage.stopJSCoverage().catch(() => [])) {
          if (!entry.url.includes('/assets/')) continue;
          const name = new URL(entry.url).pathname;
          // Every range of every non-root function; the script root (offset 0, whole file) is module top level, run by all.
          (fns[name] ??= []).push(...(entry.functions ?? []).slice(1).flatMap((f) => f.ranges.map((r) => ({ s: r.startOffset, e: r.endOffset, c: r.count }))));
        }
      }
      const spec = path.relative(import.meta.dirname, info.file);
      const title = info.titlePath.slice(1).join(' > ');
      fs.mkdirSync(dir, { recursive: true });
      const id = createHash('sha1').update(`${spec}\0${title}\0${info.retry}`).digest('hex').slice(0, 16);
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ spec, title, fns }));
    },
    { auto: true },
  ],
  core: async ({}, use, info) => {
    const core = new Core(`${info.workerIndex}-${next++}`);
    await core.ready();
    current = core;
    await use(core);
    // V1A-52 after-test guard: nothing in the test fell back to $HOME/.nunchiro (the sentinel stands in for ~).
    const leaked = fs.existsSync(path.join(core.home, 'sentinel-home', '.nunchiro'));
    // Ticket 504: stop() removes the home; a failed test keeps its core's log (attach copies the file now).
    const log = path.join(core.home, 'core.log');
    if (info.status !== info.expectedStatus && fs.existsSync(log)) await info.attach('core.log', { path: log, contentType: 'text/plain' });
    await core.stop();
    expect(leaked, 'a call fell back to $HOME/.nunchiro (the sentinel HOME)').toBe(false);
  },
  app: async ({ page, core, firstRun }, use) => {
    if (!firstRun) await page.addInitScript(() => localStorage.setItem('nunchiro.firstrun.started', '1'));
    await page.addInitScript((boot) => {
      window.__NUNCHIRO__ = boot;
    }, core.boot());
    // V2.5-54 A22: the once-only step that drops an old strip zone above the composer (layout/store.ts) has run for every
    // spec: a spec that writes such a layout keeps it. answer-strip-default.spec.ts clears this to test the step itself.
    await page.addInitScript(() => localStorage.setItem('nunchiro.layout.strip-left-chat.v1', '1'));
    // V2.5-69 (ticket 289): the Board opens as the watch view now. The specs written against the columns view keep it
    // (the build's test seam, board/views.ts); board-watch.spec.ts clears the flag to test the new default.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nunchiro.test.board-mode', 'columns');
      } catch {
        // Storage blocked: the default view.
      }
    });
    await use(page);
  },
});
export { expect };

/** Opens the window and waits until it has a live core connection. */
export async function openWindow(page: Page, extra: Record<string, unknown> = {}, core?: Core) {
  if (Object.keys(extra).length)
    await page.addInitScript((x) => {
      Object.assign(window.__NUNCHIRO__ ?? {}, x);
    }, extra);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // The first snapshot follows the handshake: wait for it so rows, tabs and the composer are live.
  // D5b: the AGENTS rows are not in the default window; every running session opens as a tab once.
  // Ticket 570: the strip shows one project's tabs: the project of the first tab that appears.
  // An account's login tab has no project of its own (useProjectTabs.ts accountTab): it shows with the shown project.
  const live = ((core ?? current)?.cli('snapshot', '--json').sessions as { id: string; state: string; project: string; kind: string; account_tab?: boolean }[] | undefined)?.filter((s) => s.state === 'running') ?? [];
  const account = (s: (typeof live)[number]) => s.kind === 'shell' && !!s.account_tab;
  let running = 0;
  if (live.length) {
    const first = page.locator('.tab[data-tab]:not([data-tab="settings"])').first();
    await expect(first).toBeVisible();
    const ids = await page.locator('.tab[data-tab]:not([data-tab="settings"])').evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-tab')));
    const shown = ids.map((id) => live.find((s) => s.id === id)).find((s) => s && !account(s))?.project;
    running = live.filter((s) => account(s) || s.project === shown).length;
  }
  await expect(page.locator('.tab[data-tab]:not([data-tab="settings"])')).toHaveCount(running); // a first run also opens Settings (ticket 305)
}

// WebKit has no clipboard-write permission (grantPermissions throws on it) and lets a page write without one, so
// granting read alone keeps every clipboard check running there.
export const grantClipboard = (page: Page) =>
  page.context().grantPermissions(page.context().browser()?.browserType().name() === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write']);

/** Ticket 570: the strip holds one project's tabs. Shows the project a session is in, then clicks its tab. The project is shown by its
 *  row in the tree when the tree is on screen, else by the palette's session entry; both are clicked in the page, so the pointer stays. */
export async function goTab(page: Page, core: Core, id: string) {
  const tab = page.locator(`.tab[data-tab="${id}"]`);
  if (!(await tab.count())) {
    const s = (core.cli('snapshot', '--json').sessions as { id: string; project: string; label: string }[]).find((x) => x.id === id);
    const head = page.locator(`.row.head[data-project-path="${s?.project}"] b`);
    if (await head.count()) await head.evaluate((e) => (e as HTMLElement).click());
    else {
      await page.keyboard.press('Meta+KeyK');
      await page.getByRole('combobox').first().fill(s?.label ?? '');
      await page.locator(`#palette-list [data-command="session.open.${id}"]`).evaluate((e) => (e as HTMLElement).click());
    }
  }
  await tab.click();
}

export async function terminalText(page: Page, id: string) {
  return page.locator(`.term[data-session="${id}"] .xterm-rows`).innerText();
}

/** Box of every row, tab and the composer, keyed so later arrivals can be told apart from moved rows. */
export const boxes = (page: Page, selector = '.tree .row, .tree .q, .tree .more, .tab, .cbox, #waiting-strip') =>
  page.$$eval(selector, (els) =>
    Object.fromEntries(
      els.map((e, i) => {
        const r = e.getBoundingClientRect();
        const h = e as HTMLElement;
        const key = h.dataset.tab ?? (e.closest('.tree') ? `tree-${i}` : e.className);
        return [key, [r.x, r.y, r.width, r.height].map(Math.round).join(',')];
      }),
    ),
  );
export const unmoved = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).filter((k) => before[k] !== after[k]);

/** Ticket 1070: opens a session, ended ones too, from the command palette (the tree lists only the running ones and its project). */
export async function openSessionFromPalette(page: Page, id: string) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press('Meta+KeyK'); // the window may still be loading after a reload
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass();
  await dialog.locator(`[data-command="session.open.${id}"]`).click();
  await expect(dialog).toHaveCount(0);
}

/** Ticket 1070: closes a session from its tab menu: the core keeps the close for 10 s and the status line offers Undo. */
export async function closeFromTab(page: Page, id: string) {
  await page.locator(`.tab[data-tab="${id}"]`).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Close session' }).click();
}

/** needs 107 (ticket 180): the shipped default layout keeps the strip's zone right above the composer, where it draws
 *  nothing now. A spec about the strip itself places it at the top of the same column instead, or under the composer
 *  (`below`), where an arrival refits the terminal at its bottom edge as the old place did. */
export function stripOnTop(core: { home: string }, { below = false } = {}) {
  const zone = (id: string) => `\n[[root.children]]\nid = "${id}"\nwidgets = ["${id}"]\n`;
  const zones = below ? zone('terminal') + zone('composer') + zone('waiting') : zone('waiting') + zone('terminal') + zone('composer');
  fs.writeFileSync(path.join(core.home, 'layout.toml'), `version = 1\nlocked = false\n\n[root]\nid = "centre"\nsplit = "column"\n${zones}`);
}

/** needs 107 (ticket 180): the strip in its own zone right of the terminal (a user's placement), for specs that pin "an
 *  arrival moves nothing but the strip": that zone keeps its size, so the terminal never resizes. */
export function stripBeside(core: { home: string }) {
  const leaf = (at: string, id: string, extra = '') => `\n[[${at}]]\nid = "${id}"\n${extra}widgets = ["${id}"]\n`;
  const centre = `split = "column"\n\n[[root.children]]\nid = "upper"\nsplit = "row"\n${leaf(`root.children.children`, 'terminal')}${leaf(`root.children.children`, 'waiting', 'size = 820\n')}${leaf(`root.children`, 'composer')}`;
  fs.writeFileSync(path.join(core.home, 'layout.toml'), `version = 1\nlocked = false\n\n[root]\nid = "centre"\n${centre}`);
}

/** LAYOUT D5b: the shape of the pre-D5b default layout (a left column of two zones, `tree` over a second zone, beside the centre
 *  column), for specs about zones, sizes, folding and pane mode that were written against it. The tree is a sidebar widget
 *  now, so the zone named `tree` holds Files. `retired` makes the second zone name the Agents widget of before ticket 1070, for the
 *  test that an old file still loads. */
export function legacyLayout(core: Core, { strip = 'above' as 'above' | 'top' | 'beside', retired = false } = {}) {
  const second = retired ? 'agents' : 'context'; // Context: a light widget with the old zone's 80 px minimum height
  const term = '\n[[root.children.children]]\nid = "terminal"\nwidgets = ["terminal"]\n';
  const wait = '\n[[root.children.children]]\nid = "waiting"\nwidgets = ["waiting"]\n';
  // needs 107 (ticket 180): a strip right above the composer draws nothing; `top` puts it over the terminal, `beside` in
  // its own zone right of the terminal (that zone keeps its size, so an arrival moves nothing else).
  const upper = `\n[[root.children.children]]\nid = "upper"\nsplit = "row"\n${term.replaceAll('root.children.children', 'root.children.children.children')}${wait.replaceAll('root.children.children', 'root.children.children.children').replace('id = "waiting"\n', 'id = "waiting"\nsize = 360\n')}`;
  const swap = (t: string) => (strip === 'top' ? t.replace(term + wait, wait + term) : strip === 'beside' ? t.replace(term + wait, upper) : t);
  fs.writeFileSync(
    path.join(core.home, 'layout.toml'),
    swap(`version = 1
locked = false

[root]
id = "main"
split = "row"

[[root.children]]
id = "left"
size = 256
split = "column"

[[root.children.children]]
id = "tree"
widgets = ["files"]

[[root.children.children]]
id = "${second}"
size = 190
widgets = ["${second}"]

[[root.children]]
id = "centre"
split = "column"

[[root.children.children]]
id = "terminal"
widgets = ["terminal"]

[[root.children.children]]
id = "waiting"
widgets = ["waiting"]

[[root.children.children]]
id = "composer"
widgets = ["composer"]
`),
  );
}

/** V2.5-34: a session that shows its terminal (a shell) has no composer until asked: the palette's "Focus the composer"
 * (also the prefix I key) brings one back for the open session, and focuses it. `focus: false` uses "Hide or show the
 * composer" instead, which leaves focus where it was (the palette gives it back); it flips, so call it only while hidden. */
export async function showComposer(page: Page, { focus = true } = {}) {
  // The key, not the button: a click on the button would take the focus the palette gives back.
  if (focus) await page.getByRole('button', { name: 'Open command palette' }).click();
  else await page.keyboard.press('Meta+KeyK');
  await page.getByRole('dialog').getByRole('combobox').fill(focus ? 'Focus the composer' : 'Hide or show the composer');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cbox textarea').first()).toBeVisible();
}

