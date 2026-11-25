// Ticket 391 follow-up A (real-app check 11-10): the sign-in state has three words, never two. Signed in, Signed out (the
// agent's own status command said so), and Not checked / Couldn't check (never probed, or a probe that did not run or died).
// A live agent on the account that has completed a turn is proof it is signed in (round 2: an agent that quit, or one at
// its login prompt with no turn yet, proves nothing). The agents are fakes in the test's bin, never a real login.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openRow } from './accounts-rows';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { stripOnTop, expect, openWindow, test, type Core, codexFake } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

const ID = '0123456789abcdef0123456789abcdef';
// Claude's status says "not logged in" (as the real app's did for a signed-in owner); any session idles as `cat`.
const CLAUDE = `#!/bin/sh
D="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac
if [ "$1 $2" = "auth status" ]; then echo '{"loggedIn": false}'; exit 1; fi
case " $* " in *" --model quit "*) exit 0;; esac
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
// Codex's status dies by a signal before it answers: the probe did not run to an answer.
const CODEX = `#!/bin/sh
case "$1" in --version) echo 'codex-cli 0.161.0'; exit 0;; esac
if [ "$1 $2" = "login status" ]; then kill -9 $$; fi
exec /bin/cat
`;
function setup(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), CLAUDE, { mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(CODEX), { mode: 0o700 });
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "work"\n`);
}
async function providers(app: Page) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
}
// One turn of a live agent, as its hooks report it over the owner socket: the core then counts it (`completion_seq`).
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
type Listed = { id: string; state: string; agent_ended?: boolean; completion_seq?: number };
const listed = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as Listed[]).find((s) => s.id === id);
async function turn(core: Core, id: string) {
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
    if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
  }
  await expect.poll(() => listed(core, id)?.completion_seq ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
}
const head = (app: Page, agent: string) => app.locator(`#s-accounts [data-row="${agent}"] .prv-chips`);
const row = (app: Page, agent: string, id: string) => app.locator(`#s-accounts .acct-agent[data-agent="${agent}"] .acct-card[data-account="${id}"] .acct-signed`);
/** An added Claude account's state once its list probe answered. Under load a probe can come back with no answer, and the
 *  row then rightly reads "Could not check"; the page probes again when the window gets focus back. */
async function probedAs(app: Page, id: string, text: string) {
  await expect(async () => {
    await app.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(row(app, 'claude', id)).toHaveText(text, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

test('signin states: a probe that died reads "Couldn\'t check", a running session reads "Signed in", a probe that said no reads "Signed out"', async ({ app, core }) => {
  setup(core);
  const project = core.project('alpha');
  const mine = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'mine').session as { id: string };
  await turn(core, mine.id);
  // The owner's Check on Claude's own login ran before the page opened: its status said "not logged in".
  expect(ownerOk(core, { op: 'account_check', agent: 'claude' }).account.signed_in).toBe('no');
  await openWindow(app);
  await providers(app);

  // Codex's own check ran as the page opened (accounts probe 11-10) and died: the head says so and offers Check, never
  // "Signed out"; a Check that dies again says the same.
  await expect(head(app, 'codex')).toHaveText("Could not check");
  const check = app.getByRole('button', { name: 'Check Codex sign-in for Default' });
  await check.click();
  await expect(check).toBeEnabled();
  await expect(head(app, 'codex')).toHaveText("Could not check");
  await openRow(app, 'Codex');
  await expect(row(app, 'codex', 'own')).toHaveText("Could not check");
  await expect(row(app, 'codex', 'own')).not.toHaveText(/Signed out|Unknown/);

  // Claude's own login: its status said no, but a Claude agent on it is running and has completed a turn: it is signed in.
  await openRow(app, 'Claude');
  await expect(head(app, 'claude')).toHaveText('Signed in');
  await expect(row(app, 'claude', 'own')).toHaveText('Signed in');
  // The added account has no session and its status said no: that one is signed out.
  await probedAs(app, ID, 'Signed out');
});

test('signin states: the onboarding Providers step says "Couldn\'t check" for a dead probe, and its Done agrees with its text', async ({ app, core }) => {
  setup(core);
  const cmd = fakeAcp(core, 'opencode', '1.4.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('opencode', cmd));
  const view = ownerOk(core, { op: 'acp_agent_status', name: 'opencode' }).view;
  ownerOk(core, { op: 'acp_agent_grant', name: 'opencode', hash: view.hash });
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Onboarding' }).click();
  await app.locator('.ob-step[data-step="providers"]').click();
  const panel = app.locator('.ob-panel[data-panel="providers"]');
  const chip = (id: string) => panel.locator(`[data-agent="${id}"] .prv-chips`);
  await expect(chip('codex')).toHaveText("Could not check");
  // Ticket 470: once a check came back with no answer, the card offers Sign in, not another Check (no dead end).
  await expect(panel.locator('[data-agent="codex"]').getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(panel.locator('[data-agent="codex"]').getByRole('button', { name: 'Check Codex sign-in for Default' })).toHaveCount(0);
  await expect(chip('claude')).toHaveText('Needs sign-in');
  // Done, and the panel says why: the approved ACP agent, not a signed-in Claude or Codex.
  await expect(panel.locator('.ob-pill')).toHaveText('Done');
  await expect(panel.locator('.ob-why')).toHaveText('Done: OpenCode is approved.');
});

test('signin states: with no agent signed in and none approved, the step is not done and says what to press', async ({ app, core }) => {
  setup(core);
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Onboarding' }).click();
  await app.locator('.ob-step[data-step="providers"]').click();
  const panel = app.locator('.ob-panel[data-panel="providers"]');
  await expect(panel.locator('[data-agent="claude"] .prv-chips')).toHaveText('Needs sign-in');
  await expect(panel.locator('.ob-pill')).toHaveText('Not done');
  // Ticket 470: not done, the line names what the look found and what to press, never only the rule.
  await expect(panel.locator('.ob-why')).toHaveText('Found Claude, not signed in. Press Sign in.');
});

// Round 2: what a session proves. Every Claude status here says no.
const signInOn = (app: Page, label: string) => app.locator('#s-accounts .acct-agent[data-agent="claude"]').getByRole('button', { name: `Sign in “${label}”` });
test('signin states: an agent that quit, or one with no turn yet, proves nothing; a live agent with a turn reads Signed in', async ({ app, core }) => {
  setup(core);
  const project = core.project('alpha');
  // On "work": an agent that quit on its own; the shell it left still runs (ticket 286).
  const quit = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'quit', '--account', 'work', '--model', 'quit').session as { id: string };
  await expect.poll(() => listed(core, quit.id)?.agent_ended, { timeout: 15_000 }).toBe(true);
  expect(listed(core, quit.id)?.state).toBe('running');
  // On "Your own": a live agent that has not completed a turn yet, as one at its login prompt.
  const live = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'live').session as { id: string };
  expect(ownerOk(core, { op: 'account_check', agent: 'claude' }).account.signed_in).toBe('no');
  await openWindow(app);
  await providers(app);
  await openRow(app, 'Claude');
  await probedAs(app, ID, 'Signed out');
  await expect(signInOn(app, 'work')).toBeVisible();
  await expect(row(app, 'claude', 'own')).toHaveText('Signed out');
  await expect(head(app, 'claude')).toHaveText('Signed out');
  // The live agent completes a turn: now it proves the sign-in.
  await turn(core, live.id);
  // q67 look (new 1): the page reads the window's live sessions, so the proof shows at once, with no focus and no poll.
  await expect(row(app, 'claude', 'own')).toHaveText('Signed in', { timeout: 15_000 });
  await expect(head(app, 'claude')).toHaveText('Signed in');
  await probedAs(app, ID, 'Signed out');
});

test('signin states: the picked account with a live agent and a turn reads Signed in, and no "fell back" note says otherwise', async ({ app, core }) => {
  setup(core);
  const work = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('alpha'), '--label', 'on work', '--account', 'work').session as { id: string };
  await turn(core, work.id);
  await openWindow(app);
  await providers(app);
  await openRow(app, 'Claude');
  await app.getByRole('combobox', { name: 'Default account · Claude' }).selectOption(ID);
  const card = app.locator(`#s-accounts .acct-agent[data-agent="claude"] .acct-card[data-account="${ID}"]`);
  await expect(card).toContainText('Default');
  await expect(row(app, 'claude', ID)).toHaveText('Signed in');
  await expect(card).not.toContainText('Signed out, so new sessions start');
});

test('signin states: on the onboarding step, a live Claude agent counts as signed in once it has completed a turn', async ({ app, core }) => {
  setup(core);
  const live = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('alpha'), '--label', 'live').session as { id: string };
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Onboarding' }).click();
  await app.locator('.ob-step[data-step="providers"]').click();
  const panel = app.locator('.ob-panel[data-panel="providers"]');
  // No turn yet (as at its login prompt), and its status says no: it needs a sign-in.
  await expect(panel.locator('[data-agent="claude"] .prv-chips')).toHaveText('Needs sign-in');
  await expect(panel.locator('.ob-pill')).toHaveText('Not done');
  await turn(core, live.id);
  // q67 look (new 1): Onboarding read "Could not check" beside Providers' "Signed in" until the window got focus back. Both
  // read the window's live sessions now: no focus, no poll.
  await expect(panel.locator('[data-agent="claude"] .prv-chips')).toHaveText('Signed in');
  await expect(panel.locator('.ob-pill')).toHaveText('Done');
  await expect(panel.locator('.ob-why')).toHaveText('Done: Claude is signed in.');
});
