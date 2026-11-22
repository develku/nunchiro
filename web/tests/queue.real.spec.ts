// Ticket 08 acceptance with real agents (the 01 matrix subset): an item an agent shows reaches the answer
// strip within 1 s, and answering from the strip resolves it in the agent. Opt in: NUNCHIRO_REAL=1
// (RUNS per row, default 5; ROWS, default C1,C2,X1). Cheapest models, trivial prompts, a scratch project per
// run, the ticket-01 config guard around the whole file; persistent or trust options are never chosen.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { nunchiro, ORIGIN, REPO, windowAuth } from './fixtures';

const BIN = path.join(REPO, 'target/debug/nunchiro');
const RUNS = Number(process.env.RUNS ?? 5);
const OUT = path.join(REPO, '.scratch/receipts', `v1a-08-real-${new Date().toISOString().replace(/[:.]/g, '-')}`);
// Same rows, prompts and screen patterns as scripts/scenario/matrix.py (C1, C2, X1).
const ROWS = {
  C1: { agent: 'claude', prompt: 'Use the Bash tool to run exactly: touch {f}', show: /Do you want to proceed\?/i, answer: /Allow once/ },
  C2: { agent: 'claude', prompt: 'Use the AskUserQuestion tool to ask me one question: "red or blue?" with options red and blue. Do nothing else.', show: /Enter to select/i, answer: /^1 / },
  X1: { agent: 'codex', prompt: 'Run the shell command: touch {f}', show: /Would you like to run the following command/i, answer: /Allow once/ },
} as const;
type Row = keyof typeof ROWS;
const READY = { claude: /❯ +Try|manual mode on|for shortcuts/, codex: /Ask Codex to do anything/ };
const ARGS = {
  claude: ['--model', 'haiku', '--', '--permission-mode', 'default'],
  codex: ['--model', 'gpt-5.6-luna', '--', '-a', 'on-request', '-s', 'read-only', '-c', 'approvals_reviewer="user"'],
};
const ESC = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g;
// Same crude view as scripts/scenario/lib.py visible(): escapes become spaces.
const visible = (raw: string) => raw.replace(ESC, ' ').replace(/[ \t\r\x00-\x08\x0b-\x1f]+/g, ' ');
const guard = (script: string) => execFileSync('python3', ['-I', '-B', '-c', `import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'scripts/scenario'))}); from lib import snapshot, guard_check; ${script}`], { encoding: 'utf8' });

// Run with --workers 1: one real agent at a time.
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
  stop() {
    try {
      nunchiro(this.cliEnv(), ['serve', 'stop'], 10_000);
    } catch {
      // Already gone.
    }
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }
}

async function firstCardAt(page: Page) {
  return page.evaluate(() => (window as unknown as { __card?: number }).__card ?? null);
}

for (const row of (process.env.ROWS ?? 'C1,C2,X1').split(',') as Row[])
  for (let n = 0; n < RUNS; n++)
    test(`${row} run ${n}: strip within 1 s, answer resolves it`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'one browser is enough for real agents');
      test.setTimeout(400_000);
      // As in matrix.sh: a run where the model never asked is retried (up to 3), never counted as a miss.
      for (let k = 0; k < 3; k++) if (await trial(page, row, n, k)) return;
      throw new Error('not elicited in 3 attempts');
    });

async function trial(page: Page, row: Row, n: number, k: number) {
      const spec = ROWS[row];
      const tag = Math.random().toString(16).slice(2, 10);
      const core = new RealCore(path.join(REPO, '.scratch', `r-${tag}`));
      const cwd = path.join(core.home, 'cwd');
      const target = `done-${tag}`;
      const r: Record<string, unknown> = { row, run: n, attempt: k + 1, tag };
      results.push(r);
      let raw = '';
      let log = '';
      try {
        await expect.poll(() => fs.existsSync(path.join(core.home, 'window.json')), { timeout: 10_000 }).toBe(true);
        const boot = windowAuth(core.home);
        await page.addInitScript((b) => {
          window.__NUNCHIRO__ = b;
          // The page's own clock records when the first answer card is drawn.
          new MutationObserver(() => {
            const w = window as unknown as { __card?: number };
            if (!w.__card && document.querySelector('#waiting-strip .qcard[data-item]')) w.__card = Date.now();
          }).observe(document, { subtree: true, childList: true });
          (window as unknown as { Notification: unknown }).Notification = class {
            static permission = 'denied';
          };
        }, boot);
        const s = core.cli('session', 'start', '--kind', spec.agent, '--project', cwd, '--label', `${row}-${n}`, ...ARGS[spec.agent]).session as { id: string };
        await page.goto('/');
        await expect(page.locator('.ar')).toHaveCount(1);
        let cursor = 0;
        const read = () => {
          const out = core.cli('session', 'read', s.id, '--after', String(cursor));
          cursor = out.end;
          const chunk = Buffer.from(out.data as number[]).toString('utf8');
          log = (log + chunk).slice(-400_000);
          raw = (raw + chunk).slice(-200_000);
          return visible(raw);
        };
        await expect.poll(read, { timeout: 60_000, intervals: [100] }).toMatch(READY[spec.agent]);
        await page.waitForTimeout(500);
        // Typed through the window's composer, as the user would.
        await page.locator('.cbox textarea').fill(spec.prompt.replace('{f}', target));
        raw = '';
        await page.locator('.cbox textarea').press('Enter');
        const sent = Date.now();
        let shown: number | null = null;
        let card: number | null = null;
        while (Date.now() - sent < 90_000 && (shown === null || card === null)) {
          if (shown === null && spec.show.test(read())) shown = Date.now();
          card ??= await firstCardAt(page);
          if (shown !== null && card === null && Date.now() - shown > 1500) break;
          await page.waitForTimeout(25);
        }
        r.elicited = shown !== null;
        r.latency_ms = shown !== null && card !== null ? card - shown : null;
        r.within_1s = r.latency_ms !== null && (r.latency_ms as number) <= 1000;
        r.sources = core.cli('snapshot', '--json').sessions[0].pending.flatMap((d: { sources: string[] }) => d.sources);
        if (!r.elicited) return false;
        expect(r.within_1s, `card latency ${r.latency_ms} ms`).toBe(true);
        // Answer from the strip; a redraw can replace the item, so a refused answer is retried on the new card.
        for (let attempt = 1; attempt <= 3; attempt++) {
          r.clicks = attempt;
          const first = page.locator('#waiting-strip .qcard[data-item]').first();
          const items = () => core.cli('snapshot', '--json').sessions[0].pending.map((d: { id: string; sources: string[]; actionable: boolean }) => `${d.id.slice(0, 8)}:${d.sources.join('+')}`);
          const clicked = (await first.getAttribute('data-item'))?.slice(0, 8);
          const before = items();
          await first.locator('.what').click({ timeout: 5000 });
          await first.getByRole('button', { name: spec.answer }).click({ timeout: 5000 });
          await page.waitForTimeout(150);
          r.trace = [...((r.trace as string[]) ?? []), `t+${Date.now() - (shown ?? 0)}ms clicked ${clicked} before [${before}] after [${items()}] card "${await first.innerText({ timeout: 300 }).catch(() => '')}"`];
          const ok = await expect
            .poll(() => core.cli('snapshot', '--json').sessions[0].pending.length, { timeout: 4000 })
            .toBe(0)
            .then(() => true)
            .catch(() => false);
          if (ok) {
            raw = '';
            break;
          }
          r.refused = [...((r.refused as string[]) ?? []), ...(await page.locator('#waiting-strip .note.err').allTextContents())];
          await page.mouse.move(900, 100);
        }
        // The question left the agent's screen: the core's screen observer would file it again if it were there.
        if (row === 'C2')
          for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(250);
            expect(core.cli('snapshot', '--json').sessions[0].pending.filter((d: { kind: string }) => d.kind === 'question')).toEqual([]);
          }
        else await expect.poll(() => fs.existsSync(path.join(cwd, target)), { timeout: 30_000 }).toBe(true);
        r.resolved = true;
        return true;
      } finally {
        fs.writeFileSync(path.join(OUT, `${row}-${n}-${k}.pty.txt`), log);
        core.stop();
      }
}
