// Ticket 604: every problem card cause reads in the window's language, and the core's English sentence stays under Details.
// Part 1 is pure: each case in all 8 languages. Part 2 opens one real card per reachable case in a ko-KR window.
import fs from 'node:fs';
import path from 'node:path';
import type { Problem, ProblemCase, Session } from '../src/types';
import { causeText } from '../src/chat/problemCause';
import { agentsToml, fakeAcp, ownerOk, owner, tomlEntry } from './acp-fakes';
import { makeT } from './i18n-tables';
import { stripOnTop, expect, test, type Core } from './fixtures';

// What the core writes (crates/nunchiro-core/src/problems.rs) and who the session names, one row per sentence.
type Row = { p: Problem; who: Parameters<typeof causeText>[2]; en: string };
const claude = { name: 'Claude', program: 'claude' };
const codex = { name: 'Codex', program: 'codex' };
const acp = { name: 'Gemini CLI', program: null };
const row = (c: ProblemCase, cause: string, who: Row['who'], en: string, more: Partial<Problem> = {}): Row => ({ p: { case: c, cause, ...more }, who, en });
const ROWS: Row[] = [
  row('not_installed', 'Claude is not installed.', claude, 'Claude is not installed (claude is not on PATH).'),
  row('not_installed', 'Gemini CLI is not installed.', acp, 'Gemini CLI is not installed.'),
  row('logged_out', 'Claude is signed out.', claude, 'Claude is signed out.'),
  row('logged_out', 'Gemini CLI is not signed in.', acp, 'Gemini CLI is signed out.'),
  row('usage_limit', 'Codex usage limit reached.', codex, 'Codex usage limit reached.'),
  row('usage_limit', 'Codex usage limit reached. Resets 2:20 PM per Codex.', codex, 'Codex usage limit reached. Resets 2:20 PM per Codex.', { reset: '2:20 PM' }),
  row('hook_trust', "Codex refused Nunchiro's hooks.", codex, "Codex refused Nunchiro's hooks."),
  row('unexpected', 'Session ended unexpectedly (exit code 3).', claude, 'Session ended unexpectedly (exit code 3).'),
  row('unexpected', 'Session ended unexpectedly.', claude, 'Session ended unexpectedly.'),
  row('machine_unreachable', "Can't reach studio.", { ...claude, machine: 'studio' }, "Can't reach studio."),
  row('version_mismatch', 'studio runs another Nunchiro version.', { ...claude, machine: 'studio' }, 'studio runs another Nunchiro version.'),
  row('acp_no_answer', 'Gemini CLI did not answer ACP: check its command.', acp, 'Gemini CLI did not answer ACP: check its command.'),
  row('acp_refused', 'a Claude ACP agent needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK with AWS_PROFILE or AWS_ACCESS_KEY_ID, or CLAUDE_CODE_USE_VERTEX with ANTHROPIC_VERTEX_PROJECT_ID) in its env names; Nunchiro never uses a Claude.ai login over ACP', acp, 'a Claude ACP agent needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK with AWS_PROFILE or AWS_ACCESS_KEY_ID, or CLAUDE_CODE_USE_VERTEX with ANTHROPIC_VERTEX_PROJECT_ID) in its env names; Nunchiro never uses a Claude.ai login over ACP'),
  row('set_aside', 'A sessions.json of another version was set aside. Saved scrollback and exports are not cleaned up until you remove it.', { name: null, program: null }, 'A sessions.json of another version was set aside. Saved scrollback and exports are not cleaned up until you remove it.'),
];
// Words that stay in every language: product, agent and machine names, ids, and the reset time the agent printed.
const KEPT = /Claude(?:\.ai)?|Codex|claude|codex|Nunchiro|ACP|Gemini CLI|studio|gone|signout|mute|sessions\.json|[A-Z][A-Z_]{3,}|\d+:\d+ PM|\bPM\b/g;
const english = (text: string) => text.replace(KEPT, '').match(/[A-Za-z]{3,}/g) ?? [];

for (const lang of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) {
  test(`causes_read_in_${lang}: each case's cause is the window's language, with its arguments filled`, () => {
    const t = makeT(lang, 'en');
    for (const { p, who, en } of ROWS) {
      const text = causeText(t, p, who);
      if (lang === 'en') expect(text, p.cause).toBe(en);
      else {
        expect(text, `${lang} ${p.cause}`).not.toBe(en);
        if (!['es', 'fr', 'pt'].includes(lang)) expect(english(text), `${lang} ${text}`).toEqual([]); // Latin scripts share words with English
      }
      expect(text, `${lang} ${p.case}`).not.toMatch(/\{\w+\}/);
      if (who.name && !['unexpected', 'machine_unreachable', 'version_mismatch', 'acp_refused'].includes(p.case)) expect(text).toContain(who.name);
      if (p.reset) expect(text).toContain(p.reset);
      if (who.machine) expect(text).toContain(who.machine);
      if (/exit code 3/.test(p.cause)) expect(text).toContain('3');
    }
  });
}

test('causes_fall_back: no name for a session keeps the core sentence', () => {
  const t = makeT('ko', 'en');
  for (const c of ['logged_out', 'usage_limit', 'hook_trust', 'machine_unreachable', 'acp_no_answer', 'not_installed'] as const)
    expect(causeText(t, { case: c, cause: 'core text' }, { name: null, program: null }), c).toBe('core text');
});

// Part 2: the real window in Korean.
test.describe('ko-KR window', () => {
  test.use({ locale: 'ko-KR' });
  test.beforeEach(({ core }) => stripOnTop(core));

  const snapshot = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];
  function fake(core: Core, name: 'claude' | 'codex', text: string, code: number) {
    const script = `#!/bin/sh\nif [ "$1" = --version ]; then echo '${name === 'codex' ? 'codex-cli 0.161.0' : '2.1.310 (Claude Code)'}'; exit; fi\nprintf '%s\\r\\n' '${text.replaceAll("'", "'\\''")}'\nsleep 0.2\nexit ${code}\n`;
    fs.writeFileSync(path.join(core.home, 'bin', name), script, { mode: 0o700 });
  }
  const band = (app: import('@playwright/test').Page) => app.locator('.problem-band');
  // fixtures.openWindow waits for the English "Connected"; this window reads Korean.
  const openWindow = async (app: import('@playwright/test').Page) => {
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: new RegExp(`^${makeT('ko', 'en')('chrome.connected')}$`) })).toBeVisible();
  };
  /** The cause line holds no English once the product names, ids and the agent's own words are taken out. */
  async function koreanCard(app: import('@playwright/test').Page, id: string, kase: string, detail: string) {
    await app.locator(`button.row.wt2[data-menu-session="${id}"]`).click();
    await expect(band(app)).toHaveAttribute('data-problem', kase);
    const cause = (await band(app).locator('.cause').innerText()).trim();
    expect(cause, kase).toMatch(/[가-힣]/);
    expect(english(cause), `${kase}: ${cause}`).toEqual([]);
    await band(app).getByText('자세히').click();
    await expect(band(app).locator('pre')).toContainText(detail);
  }
  const startAgent = (core: Core, kind: 'claude' | 'codex', label: string) =>
    core.cli('session', 'start', '--kind', kind, '--project', core.project(label), '--label', label).session as Session;
  const problemOf = (core: Core, id: string) => expect.poll(() => snapshot(core).find((s) => s.id === id)?.problem?.case, { timeout: 15_000 });

  test('an ended agent: signed out, unexpected exit, usage limit, hook trust, each card in Korean with the English cause under Details', async ({ app, core }) => {
    const cases: [string, 'claude' | 'codex', string, number, string, string][] = [
      ['logged_out', 'claude', 'Please run /login', 1, 'Claude is signed out.', 'logged_out'],
      ['unexpected', 'claude', 'working on it', 3, 'Session ended unexpectedly (exit code 3).', 'unexpected'],
      ['limit', 'codex', "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:20 PM.", 1, 'Codex usage limit reached. Resets 2:20 PM per Codex.', 'usage_limit'],
      ['hooks', 'codex', "error: unexpected argument '--dangerously-bypass-hook-trust' found", 2, "Codex refused Nunchiro's hooks.", 'hook_trust'],
    ];
    const ids: [string, string, string][] = [];
    for (const [label, kind, text, code, detail, kase] of cases) {
      fake(core, kind, text, code);
      const s = startAgent(core, kind, label);
      await problemOf(core, s.id).toBe(kase);
      ids.push([s.id, kase, detail]);
    }
    await openWindow(app);
    for (const [id, kase, detail] of ids) await koreanCard(app, id, kase, detail);
  });

  test('ACP agents: not installed, signed out, no answer, refused each read in Korean', async ({ app, core }) => {
    const approve = (name: string) => ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
    const signout = fakeAcp(core, 'signout', 'signout 1.0', ['auth']);
    const mute = fakeAcp(core, 'mute', 'mute 1.0', ['v2']);
    fs.writeFileSync(agentsToml(core), [tomlEntry('gone', '/nonexistent/gone'), tomlEntry('signout', signout), tomlEntry('mute', mute), tomlEntry('cl', '/opt/claude-acp')].join('\n'));
    for (const n of ['gone', 'signout', 'mute']) approve(n);
    const start = (name: string) => owner(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: [name], model: null, effort: null, resume: null } });
    for (const n of ['gone', 'signout', 'mute', 'cl']) start(n);
    const idOf = (name: string) => snapshot(core).find((s) => s.acp_agent === name)!.id;
    await expect.poll(() => snapshot(core).filter((s) => s.acp_agent && s.problem).length, { timeout: 20_000 }).toBe(4);
    await openWindow(app);
    await koreanCard(app, idOf('gone'), 'not_installed', 'gone is not installed.');
    await koreanCard(app, idOf('signout'), 'logged_out', 'signout is not signed in.');
    await koreanCard(app, idOf('mute'), 'acp_no_answer', 'mute did not answer ACP: check its command.');
    // A refused entry has no Details of its own: the English sentence is the only one, so it moves there.
    await app.locator(`button.row.wt2[data-menu-session="${idOf('cl')}"]`).click();
    await expect(band(app)).toHaveAttribute('data-problem', 'acp_refused');
    expect(english((await band(app).locator('.cause').innerText()).trim())).toEqual([]);
    await band(app).getByText('자세히').click();
    await expect(band(app).locator('pre')).toContainText('a Claude ACP agent needs ANTHROPIC_API_KEY');
  });

  test('a set-aside state file reads in Korean', async ({ app, core }) => {
    core.run(['serve', 'stop', '--yes'], 10_000);
    // After the stop: a stopping core writes its own sessions.json.
    fs.writeFileSync(path.join(core.home, 'sessions.json'), '{"version": 99, "sessions": []}');
    await core.restart();
    await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot());
    await openWindow(app);
    await expect(band(app)).toHaveAttribute('data-problem', 'set_aside');
    expect(english((await band(app).locator('.cause').innerText()).trim())).toEqual([]);
    await band(app).getByText('자세히').click();
    await expect(band(app).locator('pre')).toContainText('A sessions.json of another version was set aside.');
  });
});

// Round 2: the agents list runs each agent's --version, so a healthy ACP tab must not ask for it.
test('a healthy ACP tab adds no agents-list request', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'talker', 'talker 1.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('talker', cmd));
  ownerOk(core, { op: 'acp_agent_grant', name: 'talker', hash: ownerOk(core, { op: 'acp_agent_status', name: 'talker' }).view.hash });
  const id = owner(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: ['talker'], model: null, effort: null, resume: null } }).Ok!.session.id as string;
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as Session[]).find((s) => s.id === id)?.state).toBe('running');
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
  await app.goto('/');
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await app.waitForTimeout(1500);
  expect(sent.length, 'the window is talking to the core').toBeGreaterThan(0);
  // The composer's model picker lists once, shared (ticket 358); the problem card must add none.
  expect(sent.filter((m) => m.includes('"acp_agents"')).length).toBeLessThanOrEqual(1);
});
