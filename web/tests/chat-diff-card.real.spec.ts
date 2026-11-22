// Ticket v1b-12 scenario rows with a real agent (scripts/scenario/v1b-diff-card.sh): a permission-gated Claude edit
// shows the chat diff card with Accept/Reject; Accept lets the edit through, Reject denies it; either way the queue
// item leaves `snapshot --json` and the strip, and the finished card shows no buttons. Opt in: NUNCHIRO_REAL=1
// (RUNS per row, default 5; ROWS, default accept,reject). Cheapest model, trivial prompt, a scratch project per run,
// the ticket-01 config guard around the whole file; no persistent option is ever sent.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { nunchiro, ORIGIN, REPO, windowAuth } from './fixtures';

const BIN = path.join(REPO, 'target/debug/nunchiro');
const RUNS = Number(process.env.RUNS ?? 5);
const OUT = path.join(REPO, '.scratch/receipts', `v1b-12-real-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const READY = /❯ +Try|manual mode on|for shortcuts/;
const ORIGINAL = 'original line\n';
const PROMPT = 'Read a.txt, then use the Edit tool to change its only line to "edited by agent". Use no other tools.';
const ESC = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g;
const visible = (raw: string) => raw.replace(ESC, ' ').replace(/[ \t\r\x00-\x08\x0b-\x1f]+/g, ' ');
const guard = (script: string) => execFileSync('python3', ['-I', '-B', '-c', `import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'scripts/scenario'))}); from lib import snapshot, guard_check; ${script}`], { encoding: 'utf8' });

test.skip(() => !process.env.NUNCHIRO_REAL, 'real agents: run with NUNCHIRO_REAL=1');

const results: Record<string, unknown>[] = [];
test.beforeAll(({ browserName }) => {
  if (browserName !== 'chromium' || !process.env.NUNCHIRO_REAL) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'guard-before.json'), guard('print(json.dumps(snapshot()))'));
});
test.afterAll(({ browserName }) => {
  if (browserName !== 'chromium' || !process.env.NUNCHIRO_REAL) return;
  fs.writeFileSync(path.join(OUT, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const report = JSON.parse(
    guard(`b=json.load(open(${JSON.stringify(path.join(OUT, 'guard-before.json'))})); p,f=guard_check(b, snapshot(), [${JSON.stringify(REPO)}]); print(json.dumps(dict(problems=p, foreign=f)))`),
  );
  fs.writeFileSync(path.join(OUT, 'guard.json'), JSON.stringify(report, null, 2));
  // The snapshot holds the user's config text; keep only the verdict.
  fs.rmSync(path.join(OUT, 'guard-before.json'));
  const passed = (row: string) => results.filter((r) => r.row === row && r.pass).length;
  const runs = (row: string) => new Set(results.filter((r) => r.row === row).map((r) => r.run)).size;
  const finished = results.filter((r) => r.pass && r.finished_no_buttons).length;
  console.log(`ROW accept: ${passed('accept')}/${runs('accept')}`);
  console.log(`ROW reject: ${passed('reject')}/${runs('reject')}`);
  console.log(`ROW finished: ${finished}/${runs('accept') + runs('reject')}`);
  console.log(`GUARD ${report.problems.length ? `problems ${JSON.stringify(report.problems)}` : 'ok'} · receipts ${OUT}`);
  expect(report.problems, 'guarded user config changed').toEqual([]);
});

class RealCore {
  proc: ChildProcess;
  env: NodeJS.ProcessEnv;
  constructor(public home: string) {
    fs.mkdirSync(path.join(home, 'cwd'), { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(HERDR_|CLAUDE|CODEX_|AI_AGENT|AGENT_BACKEND|ANTHROPIC_|NUNCHIRO_|PLAYWRIGHT|PW_)/.test(k)) env[k] = v;
    // Ticket 457: this core keeps the real HOME, so empty (no keychain) keeps its start secrets out of the login keychain.
    this.env = { ...env, TERM: 'xterm-256color', NUNCHIRO_HOME: home, NUNCHIRO_LOGIN_PATH: 'off', NUNCHIRO_WINDOW_ORIGINS: ORIGIN, NUNCHIRO_KEYCHAIN: '' };
    this.proc = spawn(BIN, ['serve'], { env: this.env, stdio: ['ignore', 'ignore', fs.openSync(path.join(home, 'core.log'), 'a')] });
  }
  /** The core keeps the real HOME (real agents sign in from it); CLI calls get a sentinel one. */
  cliEnv() {
    return { ...this.env, HOME: path.join(this.home, 'sentinel-home') };
  }
  cli(...args: string[]) {
    return JSON.parse(nunchiro(this.cliEnv(), args));
  }
  pending(): { id: string; kind: string; text: string; sources: string[]; actionable: boolean }[] {
    return this.cli('snapshot', '--json').sessions[0]?.pending ?? [];
  }
  stop() {
    try {
      nunchiro(this.cliEnv(), ['serve', 'stop'], 10_000);
    } catch {
      // Already gone.
    }
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }
}

for (const row of (process.env.ROWS ?? 'accept,reject').split(',') as ('accept' | 'reject')[])
  for (let n = 0; n < RUNS; n++)
    test(`${row} run ${n}: the card answers the pending edit`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'one browser is enough for real agents');
      test.setTimeout(400_000);
      // As in queue.real: a run where the model never asked is retried (up to 3), never counted as a miss.
      for (let k = 0; k < 3; k++) if (await trial(page, row, n, k)) return;
      throw new Error('not elicited in 3 attempts');
    });

async function trial(page: Page, row: 'accept' | 'reject', n: number, k: number) {
  const tag = Math.random().toString(16).slice(2, 10);
  const core = new RealCore(path.join(REPO, '.scratch', `c-${tag}`));
  const cwd = path.join(core.home, 'cwd');
  const file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, ORIGINAL);
  const r: Record<string, unknown> = { row, run: n, attempt: k + 1, tag, pass: false };
  results.push(r);
  let log = '';
  try {
    await expect.poll(() => fs.existsSync(path.join(core.home, 'window.json')), { timeout: 10_000 }).toBe(true);
    const boot = windowAuth(core.home);
    await page.addInitScript((b) => {
      window.__NUNCHIRO__ = b;
      // Every answer request any socket of this window sends.
      const w = window as unknown as { __answers: unknown[] };
      w.__answers = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const f = typeof data === 'string' ? JSON.parse(data) : null;
          if (f?.request?.op === 'answer') w.__answers.push(f.request);
        } catch {
          // Not JSON.
        }
        return send.call(this, data);
      };
      (window as unknown as { Notification: unknown }).Notification = class {
        static permission = 'denied';
      };
    }, boot);
    const s = core.cli('session', 'start', '--kind', 'claude', '--project', cwd, '--label', `${row}-${n}`, '--model', 'haiku', '--', '--permission-mode', 'default').session as { id: string };
    await page.goto('/');
    await expect(page.locator('.ar')).toHaveCount(1);
    let cursor = 0;
    const read = () => {
      const out = core.cli('session', 'read', s.id, '--after', String(cursor));
      cursor = out.end;
      log = (log + Buffer.from(out.data as number[]).toString('utf8')).slice(-400_000);
      return visible(log);
    };
    await expect.poll(read, { timeout: 60_000, intervals: [100] }).toMatch(READY);
    await page.waitForTimeout(500);
    // Typed through the window's composer, as the user would (as in queue.real.spec.ts).
    await page.locator('.cbox textarea').fill(PROMPT);
    await page.locator('.cbox textarea').press('Enter');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `${row}-${n}-${k}-sent.png`) });
    const view = page.locator(`.chat[data-session="${s.id}"]`);
    const card = view.locator('.dcard', { has: page.getByRole('button', { name: 'Allow once' }) });
    // The agent may finish without asking (it read the file and stopped, or edited elsewhere): retry the run.
    // Every queue item seen meanwhile (kind, sources, text head): evidence of what the core filed and in which order.
    const seen = new Set<string>();
    let shown = false;
    for (const until = Date.now() + 90_000; Date.now() < until && !shown; ) {
      for (const d of core.pending()) seen.add(`${d.kind} ${d.sources.join('+')} ${d.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      shown = (await card.count()) > 0;
      // One CLI call per poll: keep it slow, the host runs other work.
      if (!shown) await page.waitForTimeout(250);
      if (!shown && [...seen].some((x) => x.startsWith('dialog')) && Date.now() > until - 60_000) break;
    }
    r.seen = [...seen];
    read();
    r.pending = core.pending().map((d) => ({ kind: d.kind, sources: d.sources, actionable: d.actionable, text: d.text.slice(0, 600) }));
    r.elicited = shown;
    if (!shown) {
      r.chat = (await view.innerText().catch(() => '')).slice(-1500);
      await page.screenshot({ path: path.join(OUT, `${row}-${n}-${k}-timeout.png`) });
      fs.appendFileSync(path.join(OUT, 'trials.jsonl'), JSON.stringify(r) + '\n');
      return false;
    }
    const strip = page.locator('#waiting-strip .qcard[data-item]');
    await expect(strip).toHaveCount(1);
    const item = await strip.getAttribute('data-item');
    await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible();
    // No "always" choice is ever drawn on the card.
    expect(await card.locator('.dacts button').allTextContents()).toEqual(['View', 'Allow once', 'Deny']);
    await page.screenshot({ path: path.join(OUT, `${row}-${n}-pending.png`) });
    // The stray-click guard ignores clicks in the buttons' first 500 ms.
    await page.waitForTimeout(600);
    await card.getByRole('button', { name: row === 'accept' ? 'Allow once' : 'Deny' }).click();
    await expect.poll(() => core.pending().length, { timeout: 5000 }).toBe(0);
    await expect(strip).toHaveCount(0, { timeout: 2000 });
    const answers = await page.evaluate(() => (window as unknown as { __answers: unknown[] }).__answers);
    r.answers = answers;
    expect(answers).toEqual([{ op: 'answer', item, answer: { type: row === 'accept' ? 'allow_once' : 'deny' }, confirmed: false }]);
    if (row === 'accept') {
      await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 30_000 }).toContain('edited by agent');
      // Finished: the result and its edit event arrived; the card stays, without Accept/Reject.
      await expect(view.locator('.dcard .dacts button', { hasText: /^(Accept|Reject)$/ })).toHaveCount(0, { timeout: 30_000 });
      await expect(view.locator('.dcard .dacts button', { hasText: 'View' })).toHaveCount(1);
    } else {
      // The agent may try again after a deny; nobody answers that, and the file must stay byte-identical.
      await page.waitForTimeout(4000);
      expect(fs.readFileSync(file, 'utf8')).toBe(ORIGINAL);
      await expect(view.locator('.dcard .dacts button', { hasText: /^(Accept|Reject)$/ })).toHaveCount(core.pending().length ? 1 : 0, { timeout: 10_000 });
    }
    r.finished_no_buttons = true;
    await page.screenshot({ path: path.join(OUT, `${row}-${n}-finished.png`) });
    r.content = fs.readFileSync(file, 'utf8');
    r.pass = true;
    fs.appendFileSync(path.join(OUT, 'trials.jsonl'), JSON.stringify(r) + '\n');
    return true;
  } finally {
    fs.writeFileSync(path.join(OUT, `${row}-${n}-${k}.pty.txt`), log);
    core.stop();
  }
}

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});
