// v25-rc2c-acp. Item 1: the core can refuse `acp_agents` with "too many requests in flight" right after connect (MAX_JOBS);
// the Install page button, the picker's ACP row and the first-run list swallowed that and stayed empty.
// Item 2: a Vite `build()` left NODE_ENV=production in the Playwright worker (tests/vite-build.ts restores it).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { agentsToml, fakeAcp, ownerOk, owner, tomlEntry } from './acp-fakes';
import { agentsZone, expect, openWindow, REPO, test, type Core } from './fixtures';
import { buildQuiet } from './vite-build';

const BUSY = 'too many requests in flight; try again';

/** The core's busy refusal as the reply to the first `n` `acp_agents` the window sends once `armed` (n stays within the
 *  3 tries a retry may make). The first-run step asks twice at connect (measured: 2 sent), so its test refuses both. */
async function busyOnce(app: Page, { armed = false, n = 1 } = {}) {
  const state = { armed, refused: 0, sent: 0 };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'acp_agents') {
        state.sent++;
        if (state.armed && state.refused < n) {
          state.refused++;
          return ws.send(JSON.stringify({ id: msg.id, response: { Err: BUSY } }));
        }
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return state;
}

function approve(core: Core, name: string) {
  const view = ownerOk(core, { op: 'acp_agent_status', name }).view;
  ownerOk(core, { op: 'acp_agent_grant', name, hash: view.hash });
}

test.describe('acp_list_survives_busy_core', () => {
  test.beforeEach(({ core }) => agentsZone(core));

  test('the Install page button of a not-installed agent', async ({ app, core }) => {
    fs.writeFileSync(agentsToml(core), tomlEntry('gemini', '/nonexistent/gemini', ['--experimental-acp']));
    approve(core, 'gemini');
    expect(owner(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: ['gemini'], model: null, effort: null, resume: null } }).Ok?.session.state).toBe('failed');
    const busy = await busyOnce(app);
    await openWindow(app);
    busy.armed = true;
    await app.locator('.ar[data-agent]').first().click();
    const band = app.locator('.problem-band');
    await expect(band).toHaveAttribute('data-problem', 'not_installed');
    await expect(band.getByRole('button', { name: 'Install page ↗' })).toBeVisible();
    expect(busy.refused).toBe(1); // the busy reply was really served first
  });

  test("the picker's ACP agent row", async ({ app, core }) => {
    fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
    const cmd = fakeAcp(core, 'gemini', 'gemini 0.11.2');
    fs.writeFileSync(agentsToml(core), tomlEntry('gemini', cmd, ['--experimental-acp']));
    approve(core, 'gemini');
    const s = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude', '--model', 'opus').session as { id: string };
    const busy = await busyOnce(app);
    await openWindow(app);
    await expect.poll(() => core.read(s.id)).toContain('❯');
    busy.armed = true;
    await app.locator('[data-picker="model"]').click();
    await app.locator('[data-menu="model"] [data-item="more"]').click(); // W35: the hand-off group is under More models ›
    await expect(app.locator('[data-menu="model"] [data-item="handoff-acp:gemini"]')).toBeVisible();
    expect(busy.refused).toBe(1);
  });

  test.describe('the onboarding list', () => {
  test.use({ firstRun: true });
  test('the first-run list', async ({ app, core }) => {
    const cmd = fakeAcp(core, 'gemini', 'gemini 0.11.2');
    fs.writeFileSync(agentsToml(core), tomlEntry('gemini', cmd, ['--experimental-acp']));
    const busy = await busyOnce(app, { armed: true, n: 2 });
    await openWindow(app);
    // Ticket 305: the agent list moved to Settings > Onboarding; ticket 391: step 2, one card per agent.
    await app.locator('.ob-step[data-step="providers"]').click();
    await expect(app.locator('.ob-panel [data-row="gemini"]')).toBeVisible();
    expect(busy.refused).toBe(2);
  });
  });
});

// ---- item 2 --------------------------------------------------------------------------------------------------------
test.describe('vite_build_restores_node_env', () => {
  const dir = path.join(REPO, '.scratch', `rc2c-acp-vite-${process.pid}`);
  const config = () => ({ configFile: false as const, root: dir, logLevel: 'silent' as const, build: { write: false, lib: { entry: path.join(dir, 'entry.js'), formats: ['es' as const] } } });
  test.beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'entry.js'), 'export const x = 1;\n');
  });
  test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const withEnv = async (run: () => Promise<unknown>) => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await run();
      return process.env.NODE_ENV;
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  };

  test('the old direct call leaves NODE_ENV set (why the helper exists)', async () => {
    expect(await withEnv(() => build(config()))).toBe('production');
  });
  test('buildQuiet: NODE_ENV is the same before and after', async () => {
    expect(await withEnv(() => buildQuiet(config()))).toBeUndefined();
    process.env.NODE_ENV = 'development';
    try {
      await buildQuiet(config());
      expect(process.env.NODE_ENV).toBe('development');
    } finally {
      delete process.env.NODE_ENV;
    }
  });
});
