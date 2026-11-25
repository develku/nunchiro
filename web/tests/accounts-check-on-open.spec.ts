// Accounts probe 11-10 (real-app check of the RC from main 028dba51): Providers read Codex "Not checked" while Onboarding
// already read it "Signed in". Opening either page now checks every found agent's "Your own" not known yet or older than a
// minute, both pages read the window's one answer, and nothing asks again while a page stays open. "Check again" forces one.
// The agents are fakes in the test's bin: each status run appends a line to `probes.log` in the folder it was pointed at.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core, codexFake } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

const ID = '0123456789abcdef0123456789abcdef';
// D: the account's folder, else the core's own variable ("Your own"). A status run takes a moment, so "Checking…" shows.
// With `slow-version` in the core home, the agent listing's `--version` takes 3 s (round 2: a listing that lands late).
const fake = (home: string, name: string, variable: string, status: string, yes: string, no: string) => `#!/bin/sh
D="\${${variable}}"
case "$1" in --version) [ -e '${home}/slow-version' ] && sleep 3; echo "${name} 1.0.0"; exit 0;; esac
if [ "$1 $2" = "${status}" ]; then
  echo run >> "$D/probes.log"
  sleep 1
  if [ -e "$D/.logged-in" ]; then ${yes}; exit 0; fi
  ${no}; exit 1
fi
exec /bin/cat
`;
function setup(core: Core) {
  const bin = path.join(core.home, 'bin');
  fs.writeFileSync(path.join(bin, 'claude'), fake(core.home, 'claude', 'CLAUDE_CONFIG_DIR', 'auth status', `echo '{"loggedIn": true}'`, `echo '{"loggedIn": false}'`), { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'codex'), codexFake(fake(core.home, 'codex', 'CODEX_HOME', 'login status', `echo 'Logged in using ChatGPT' >&2`, `echo 'Not logged in' >&2`)), { mode: 0o700 });
  // Claude's own login is signed in, Codex's is not; one added Claude account, signed out.
  for (const dir of ['claude-home', 'codex-home', `accounts/claude/${ID}`]) fs.mkdirSync(path.join(core.home, dir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'claude-home', '.logged-in'), '');
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "work"\n`);
}
/** Status runs per folder: "Your own" Claude, "Your own" Codex, the added account. */
const runs = (core: Core) =>
  ['claude-home', 'codex-home', `accounts/claude/${ID}`].map((dir) => {
    const log = path.join(core.home, dir, 'probes.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  });

type Req = { op: string; agent?: string; id?: unknown };
/** Every request the window sends (with its frame id), and the ids of the replies it got. */
function watch(app: Page) {
  const sent: Req[] = [];
  const replied = new Set<unknown>();
  app.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const frame = JSON.parse(f.payload);
      if (frame.request) sent.push({ ...frame.request, id: frame.id });
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') return;
      const id = JSON.parse(f.payload).id;
      if (id !== undefined) replied.add(id);
    });
  });
  return {
    ops: (op: string) => sent.filter((r) => r.op === op),
    replied: (r: Req) => replied.has(r.id),
    checks: (agent: string) => sent.filter((r) => r.op === 'account_check' && r.agent === agent).length,
    lists: () => sent.filter((r) => r.op === 'account_list').length,
  };
}
/** Every word a card head of Providers or Onboarding showed, from the first frame on. */
async function recordHeads(app: Page) {
  await app.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __heads: Set<string> }).__heads = seen;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.acct-agent[data-agent="claude"] .prv-chips, .acct-agent[data-agent="codex"] .prv-chips, .acct-card[data-account="own"] .acct-signed'))
        seen.add(el.textContent ?? '');
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
const heads = (app: Page) => app.evaluate(() => [...(window as unknown as { __heads: Set<string> }).__heads]);
async function page(app: Page, name: string) {
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name }).click();
}
const head = (app: Page, agent: string) => app.locator(`#s-accounts [data-row="${agent}"] .prv-chips`);
const onboarding = (app: Page, agent: string) => app.locator(`.ob-panel[data-panel="providers"] [data-agent="${agent}"] .prv-chips`);

test('check on open: a window opened straight on Providers checks each agent once, says Checking meanwhile, and asks nothing again for 10 s', async ({ app, core }) => {
  setup(core);
  const sent = watch(app);
  await recordHeads(app);
  await openWindow(app);
  // The window reads the account list once per connection for split starts (useSplitGlue): its probe of the added account
  // lands first, and the count below is what opening Providers adds.
  await expect.poll(() => sent.lists()).toBeGreaterThan(0);
  await expect.poll(() => runs(core)[2]).toBe(sent.lists());
  const before = { lists: sent.lists(), account: runs(core)[2] };
  expect(runs(core).slice(0, 2)).toEqual([0, 0]);
  await openSettings(app);
  await page(app, 'Providers');
  await expect(head(app, 'codex')).toHaveText('Checking…');
  await expect(head(app, 'claude')).toHaveText('Signed in');
  await expect(head(app, 'codex')).toHaveText('Signed out');
  // One status run per account: each "Your own" by its check, the added account by the page's one list.
  const opened = () => [...runs(core).slice(0, 2), runs(core)[2] - before.account];
  await expect.poll(opened, { timeout: 15_000 }).toEqual([1, 1, 1]);
  expect([sent.checks('claude'), sent.checks('codex'), sent.lists() - before.lists]).toEqual([1, 1, 1]);
  // Open for 10 s: no check, list or status run repeats.
  await app.waitForTimeout(10_000);
  expect([sent.checks('claude'), sent.checks('codex'), sent.lists() - before.lists]).toEqual([1, 1, 1]);
  expect(opened()).toEqual([1, 1, 1]);
  // While the checks ran the heads said so; they never read "Not checked".
  expect(await heads(app)).toContain('Checking…');
  expect(await heads(app)).not.toContain('Not checked');
  // Ticket 423 round 2: nor "Could not check" for the frame between the answer and its row (merged as the page renders).
  expect(await heads(app)).not.toContain("Could not check");
  // Onboarding in the same window reads the same answers, without asking again within the minute.
  await page(app, 'Onboarding');
  await app.locator('.ob-step[data-step="providers"]').click();
  await expect(onboarding(app, 'claude')).toHaveText('Signed in');
  await expect(onboarding(app, 'codex')).toHaveText('Needs sign-in');
  expect([sent.checks('claude'), sent.checks('codex')]).toEqual([1, 1]);
  // "Check again" still forces one per agent.
  await page(app, 'Providers');
  await expect(head(app, 'codex')).toHaveText('Signed out');
  await app.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => [sent.checks('claude'), sent.checks('codex')]).toEqual([2, 2]);
  await expect.poll(() => runs(core).slice(0, 2)).toEqual([2, 2]);
  await expect(head(app, 'codex')).toHaveText('Signed out');
});

test('check on open: Onboarding first, then Providers: the same state for the same account, one check each', async ({ app, core }) => {
  setup(core);
  // Codex's own login signed in too: the case the real app showed as "Not checked" on Providers.
  fs.writeFileSync(path.join(core.home, 'codex-home', '.logged-in'), '');
  const sent = watch(app);
  await recordHeads(app);
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Onboarding');
  await app.locator('.ob-step[data-step="providers"]').click();
  await expect(onboarding(app, 'codex')).toHaveText('Signed in');
  await expect(onboarding(app, 'claude')).toHaveText('Signed in');
  await page(app, 'Providers');
  await expect(head(app, 'codex')).toHaveText('Signed in');
  await expect(head(app, 'claude')).toHaveText('Signed in');
  await app.locator('#s-accounts [data-row="codex"] .prv-chv').click();
  await expect(app.locator('#s-accounts .acct-agent[data-agent="codex"] .acct-card[data-account="own"] .acct-signed')).toHaveText('Signed in');
  expect([sent.checks('claude'), sent.checks('codex')]).toEqual([1, 1]);
  expect(runs(core).slice(0, 2)).toEqual([1, 1]);
  expect(await heads(app)).not.toContain('Not checked');
});

// Round 2 (security review of 0e1fd21f): the opening check waits for the agent listing; a listing that lands after the
// page was left starts no probe.
test('check on open: a listing that lands after Providers was left sends no account_check', async ({ app, core }) => {
  setup(core);
  const sent = watch(app);
  await openWindow(app);
  fs.writeFileSync(path.join(core.home, 'slow-version'), '');
  const before = sent.ops('acp_agents').length;
  await openSettings(app);
  await page(app, 'Providers');
  await expect.poll(() => sent.ops('acp_agents').length).toBeGreaterThan(before);
  const listing = sent.ops('acp_agents')[before];
  expect(sent.replied(listing)).toBe(false);
  await closeSettings(app);
  await expect.poll(() => sent.replied(listing), { timeout: 20_000 }).toBe(true);
  await app.waitForTimeout(1_000);
  expect([sent.checks('claude'), sent.checks('codex')]).toEqual([0, 0]);
});

// Round 3 (code review of round 2): Onboarding has the same guard. Its opening check waits for the first-run listing
// (each agent's `--version`, slow here); a listing that lands after Onboarding was left starts no probe.
test('check on open: a listing that lands after Onboarding was left sends no account_check', async ({ app, core }) => {
  setup(core);
  const sent = watch(app);
  await openWindow(app);
  fs.writeFileSync(path.join(core.home, 'slow-version'), '');
  const before = sent.ops('first_run').length;
  await openSettings(app);
  await page(app, 'Onboarding');
  await expect.poll(() => sent.ops('first_run').length).toBeGreaterThan(before);
  const listing = sent.ops('first_run')[before];
  expect(sent.replied(listing)).toBe(false);
  await closeSettings(app);
  await expect.poll(() => sent.replied(listing), { timeout: 20_000 }).toBe(true);
  await app.waitForTimeout(1_000);
  expect([sent.checks('claude'), sent.checks('codex')]).toEqual([0, 0]);
});

// Ticket 422: the header's "Check again" reads the agent listing first; one that lands after Providers was left starts
// no check. Check again on an open page still checks every account (the first test above).
test('check on open: Check again, then leaving Providers at once, sends no account_check after the page closed', async ({ app, core }) => {
  setup(core);
  const sent = watch(app);
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  await expect(head(app, 'claude')).toHaveText('Signed in');
  await expect(head(app, 'codex')).toHaveText('Signed out');
  const opened = [sent.checks('claude'), sent.checks('codex')];
  expect(opened).toEqual([1, 1]);
  fs.writeFileSync(path.join(core.home, 'slow-version'), '');
  const before = sent.ops('acp_agents').length;
  await app.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => sent.ops('acp_agents').length).toBeGreaterThan(before);
  const listing = sent.ops('acp_agents')[before];
  expect(sent.replied(listing)).toBe(false);
  await closeSettings(app);
  await expect.poll(() => sent.replied(listing), { timeout: 20_000 }).toBe(true);
  await app.waitForTimeout(1_000);
  expect([sent.checks('claude'), sent.checks('codex')]).toEqual(opened);
  expect(runs(core).slice(0, 2)).toEqual([1, 1]);
});

// Ticket 423 round 2: a joined check whose own check still waits for a probe slot answers "still checking" (`checking`)
// at its 15 s bound. The core side is in accounts.rs's lib tests; here the window's link marks the first `still` of
// Codex's account_check replies that way (unknown + checking), and records when Codex's asks went out and replies came.
async function stillChecking(app: Page, still: number) {
  const asks: number[] = [];
  const replies: number[] = [];
  const ids = new Set<unknown>();
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'account_check' && msg.request.agent === 'codex') (ids.add(msg.id), asks.push(Date.now()));
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const account = msg?.response?.Ok?.account;
      if (ids.has(msg?.id)) replies.push(Date.now());
      if (!ids.has(msg?.id) || !account || still-- <= 0) return ws.send(m);
      ws.send(JSON.stringify({ ...msg, response: { Ok: { ...msg.response.Ok, account: { ...account, signed_in: 'unknown', checking: true } } } }));
    });
  });
  return Object.assign(asks, { replies });
}

test('still checking: the page shows Checking and asks again until the real answer', async ({ app, core }) => {
  setup(core);
  const asks = await stillChecking(app, 2);
  await recordHeads(app);
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  await expect(head(app, 'claude')).toHaveText('Signed in');
  // Two "still checking" replies, each asked again after 5 s; the third reply is the real one.
  await expect(head(app, 'codex')).toHaveText('Signed out', { timeout: 30_000 });
  expect(asks).toHaveLength(3);
  expect(asks[2] - asks[1]).toBeGreaterThanOrEqual(5_000);
  expect(await heads(app)).toContain('Checking…');
  expect(await heads(app)).not.toContain("Could not check");
  await app.waitForTimeout(6_000);
  expect(asks).toHaveLength(3);
});

test('still checking: at most 5 asks again, then Couldn\'t check, and none after that', async ({ app, core }) => {
  setup(core);
  const asks = await stillChecking(app, Infinity);
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  await expect(head(app, 'codex')).toHaveText('Checking…');
  await expect(head(app, 'codex')).toHaveText("Could not check", { timeout: 45_000 });
  expect(asks).toHaveLength(6);
  await app.waitForTimeout(6_000);
  expect(asks).toHaveLength(6);
});

test('still checking: leaving the page stops the asking again', async ({ app, core }) => {
  setup(core);
  const asks = await stillChecking(app, Infinity);
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  await expect.poll(() => asks.replies.length).toBe(1);
  await expect(head(app, 'codex')).toHaveText('Checking…');
  await closeSettings(app);
  // Two ask intervals and more: no Codex check is sent once the page is gone.
  await app.waitForTimeout(12_000);
  expect(asks).toHaveLength(1);
});
