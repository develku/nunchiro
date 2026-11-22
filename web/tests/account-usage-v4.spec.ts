// v4 Usage page (docs/design/usage-1106/usage.html v4, coordinator note 2026-11-06 15:36; needs 225 lane): from the
// visible Settings button, then Accounts & Usage (2 clicks). Records are written into the test's own CLAUDE_CONFIG_DIR
// and CODEX_HOME with times relative to now; the core reads them as it reads the user's.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, test } from './fixtures';

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, '.000Z');

function seed(core: Core, inProject: string, weeklyResetsIn = 3 * 3600 + 86_400) {
  const claude = path.join(core.home, 'claude-home/projects/p');
  fs.mkdirSync(claude, { recursive: true });
  const line = (msAgo: number, id: string, cwd: string, sid: string, model: string, u: number[]) =>
    JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), cwd, sessionId: sid, message: { id, model, usage: { input_tokens: u[0], output_tokens: u[1], cache_creation_input_tokens: u[2], cache_read_input_tokens: u[3] } } });
  fs.writeFileSync(
    path.join(claude, 's1.jsonl'),
    [
      line(1 * H, 'm1', inProject, 'sess-1', 'claude-opus-5-5', [1000, 1000, 0, 8000]), // 10k, today
      line(3 * 24 * H, 'm2', '/elsewhere/tool', 'sess-2', 'claude-opus-5-5', [500, 500, 0, 0]), // 1k, 3 days ago
    ].join('\n') + '\n',
  );
  const day = new Date();
  const codex = path.join(core.home, 'codex-home/sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(codex, { recursive: true });
  const resets = Math.floor(Date.now() / 1000) + 3 * 3600;
  fs.writeFileSync(
    path.join(codex, 'r.jsonl'),
      // The same hour as the Claude record: an hour apart, the two fall on different days for one hour after midnight.
    [
      { timestamp: iso(1 * H), type: 'session_meta', payload: { id: 'cx-1', cwd: inProject } },
      { timestamp: iso(1 * H), type: 'turn_context', payload: { model: 'gpt-5' } },
      { timestamp: iso(1 * H), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 2000 }, last_token_usage: { input_tokens: 1500, cached_input_tokens: 500, output_tokens: 500 } }, rate_limits: { primary: { used_percent: 26, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 82, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + weeklyResetsIn } } } },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n',
  );
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
}

async function open(app: Page) {
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click(); // click 1
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click(); // click 2
  return app.locator('#s-usage');
}

test('usage_v4_rows_follow_the_mockup', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo);
  core.shell(demo, 'alpha');
  const page = await open(app);
  // Toolbar: the range (30 days by default, as the mockup), the time of the last read and Refresh.
  const range = page.getByRole('radiogroup', { name: 'Range' });
  await expect(range.getByRole('radio', { name: '30 days' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Refresh usage' })).toBeVisible();
  await expect(page.getByText(/^Updated /)).toBeVisible();
  // Row 1: summary tiles left, limits right.
  const tiles = page.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('Total tokens');
  await expect(tiles).toContainText('13k'); // 10k + 1k Claude, 2k Codex
  await expect(tiles).toContainText('Claude 11k · Codex 2k');
  await expect(tiles).toContainText('Estimated cost at API prices');
  await expect(tiles).toContainText('Active days');
  await expect(tiles).toContainText('2 / 30');
  await expect(tiles).toContainText('Input from cache');
  const limits = page.getByRole('group', { name: 'Limits' });
  const codex = limits.locator('[data-limit="codex:own"]');
  await expect(codex).toContainText('Session (5 hours)');
  await expect(codex).toContainText('26% used');
  await expect(codex).toContainText('82% used');
  // Row 3: the daily grid (6 weeks), the token mix and busy hours, each drawn as one labelled image.
  await expect(page.getByRole('img', { name: 'Tokens per day over the last 6 weeks' })).toBeVisible();
  await expect(page.getByRole('img', { name: /^New input \d+%, output \d+%, cache write \d+%, cache read \d+%$/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Tokens by weekday and hour' })).toBeVisible();
  // Row 4: one card, four tabs; Project opens first, Agent shows a card per provider.
  const tabs = page.getByRole('tablist', { name: 'Break down by' });
  await expect(tabs.getByRole('tab', { name: 'Project' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Agent' }).click();
  const claudeCard = page.locator('.prov[data-agent-name="Claude"]');
  await expect(claudeCard).toContainText('Has records');
  await expect(claudeCard).toContainText('Accounts: 1');
  await expect(claudeCard).toContainText('mostly claude-opus-5-5 · mostly demo');
  await expect(claudeCard).toContainText('11k');
  await expect(page.locator('.prov.none')).toContainText('Gemini, OpenCode');
  await tabs.getByRole('tab', { name: 'Model' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('claude-opus-5-5');
  await expect(page.getByRole('tabpanel')).toContainText('gpt-5');
  // Project: a record in a Nunchiro project's folder counts for that project; any other folder is "Other".
  await tabs.getByRole('tab', { name: 'Project' }).click();
  const projects = page.getByRole('tabpanel');
  await expect(projects.getByRole('row', { name: /^demo/ })).toContainText('12k');
  await expect(projects.getByRole('row', { name: /^Other \(outside Nunchiro\)/ })).toContainText('1k');
  await tabs.getByRole('tab', { name: 'Session' }).focus();
  await app.keyboard.press('Enter');
  await expect(page.getByRole('tabpanel').getByRole('row')).toHaveCount(4); // header + 3 agent sessions
  // The retention note.
  await expect(page.getByText('Claude Code deletes transcripts older than 30 days by default')).toBeVisible();
});

test('usage_v4_range_changes_the_numbers', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo);
  core.shell(demo, 'alpha');
  const page = await open(app);
  const tiles = page.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('13k');
  await page.getByRole('radiogroup', { name: 'Range' }).getByRole('radio', { name: '24 hours' }).click();
  await expect(tiles).toContainText('12k'); // the 3-day-old record drops out
  await expect(tiles).toContainText('1 / 1');
  // Look 1117 v4f (C S3-2): the chosen range is kept after a relaunch, as the other changed values are.
  await app.reload();
  const again = app.locator('#s-usage'); // Settings opens again on the page it was on
  await expect(again.getByRole('radiogroup', { name: 'Range' }).getByRole('radio', { name: '24 hours' })).toBeChecked();
});

// W10 core 14: the first open stayed on "Reading the records…" while the account list (one sign-in probe per account,
// seconds) was read. The range's sums are asked for with the usage rows; the account names fill in when they come.
test('usage_v4_first_read_does_not_wait_for_the_account_list', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo);
  core.shell(demo, 'alpha');
  // The account list never answers.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const held = new Set<unknown>();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.request?.op === 'account_list') held.add(frame.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (!held.has(frame?.id)) ws.send(m);
    });
  });
  const page = await open(app);
  await expect(page.getByRole('group', { name: 'Summary' })).toContainText('13k');
});

// Review of 324: each pins a page that told the owner something untrue.
test('usage_v4_no_records_says_so', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo);
  core.shell(demo, 'alpha');
  const page = await open(app);
  await page.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'Nunchiro sessions only' }).click();
  const tiles = page.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('No records in this range');
  await expect(tiles).not.toContainText('Every model has a list price');
  await page.getByRole('tab', { name: 'Agent' }).click();
  await expect(page.locator('.prov[data-agent-name="Claude"]')).toContainText('No records in this range');
});

test('usage_v4_best_day_stays_inside_the_range', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo);
  core.shell(demo, 'alpha');
  fs.appendFileSync(
    path.join(core.home, 'claude-home/projects/p/s1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: iso(3 * 24 * H), cwd: demo, sessionId: 'sess-2', message: { id: 'm9', model: 'claude-opus-5-5', usage: { input_tokens: 50_000, output_tokens: 0 } } }) + '\n',
  );
  const page = await open(app);
  const tiles = page.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('· 51k'); // the 3-day-old day: 50k + the seeded 1k
  await page.getByRole('radiogroup', { name: 'Range' }).getByRole('radio', { name: '24 hours' }).click();
  await expect(tiles).toContainText('1 / 1');
  await expect(tiles).not.toContainText('· 51k');
});

test('usage_v4_refresh_counts_a_session_started_later', async ({ app, core }) => {
  const demo = core.project('demo');
  const agent = path.join(core.home, 'bin/claude');
  const fake = fs.readFileSync(agent, 'utf8'); // seed() swaps it for a stub the sign-in probes finish on; a session needs the fake
  seed(core, demo);
  core.shell(demo, 'alpha');
  const page = await open(app);
  await page.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'Nunchiro sessions only' }).click();
  const tiles = page.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('No records in this range');
  fs.writeFileSync(agent, fake);
  const later = (core.cli('session', 'start', '--kind', 'claude', '--project', demo, '--label', 'later') as { session: { agent_session_id: string } }).session.agent_session_id;
  fs.appendFileSync(
    path.join(core.home, 'claude-home/projects/p/s1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: iso(H), cwd: demo, sessionId: later, message: { id: 'm8', model: 'claude-opus-5-5', usage: { input_tokens: 500, output_tokens: 0 } } }) + '\n',
  );
  await page.getByRole('button', { name: 'Refresh usage' }).click();
  await expect(tiles).toContainText('Claude 500 · Codex 0');
});

test('usage_v4_floor_estimate_waits_for_5_percent_of_the_window', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo, 7 * 86_400 - 3600); // one hour into the week, 82% used
  core.shell(demo, 'alpha');
  const limit = (await open(app)).locator('[data-limit="codex:own"]');
  await expect(limit).toContainText('Using it faster than time passes');
  await expect(limit).not.toContainText('runs out');
});

test('usage_v4_account_filter_resets_when_the_account_goes', async ({ app, core }) => {
  const demo = core.project('demo');
  seed(core, demo);
  core.shell(demo, 'alpha');
  const id = 'aaaaaaaa-0000-4000-8000-000000000002';
  fs.mkdirSync(path.join(core.home, 'accounts/claude', id, 'projects'), { recursive: true });
  const list = path.join(core.home, 'accounts.toml');
  fs.writeFileSync(list, `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${id}"\nlabel = "Work"\n`);
  const page = await open(app);
  const tiles = page.getByRole('group', { name: 'Summary' });
  const pick = page.getByRole('combobox', { name: 'Account' });
  await pick.selectOption({ label: 'Claude · Work' });
  await expect(tiles).toContainText('No records in this range');
  fs.writeFileSync(list, 'version = 1\n');
  await app.evaluate(() => window.dispatchEvent(new Event('focus'))); // the page re-reads the accounts on focus
  await expect(pick).toHaveValue('');
  await expect(tiles).toContainText('13k');
});

// Ticket 324: the toolbar's scope and the numbers the mockup adds (worktree count, floor estimate, the week axis).
test('usage_v4_scope_counts_nunchiro_sessions_only', async ({ app, core }) => {
  const demo = core.project('demo');
  // A real Nunchiro session of the fake agent, started before seed() replaces the agent stubs: its id names the one record that counts.
  const ours = (core.cli('session', 'start', '--kind', 'claude', '--project', demo, '--label', 'ours') as { session: { agent_session_id: string } }).session.agent_session_id;
  // A week almost unspent in time but 82% used: the line reaches the floor before the reset.
  seed(core, demo, 6 * 86_400);
  fs.appendFileSync(
    path.join(core.home, 'claude-home/projects/p/s1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: iso(H), cwd: `${demo}/.claude/worktrees/one/web`, sessionId: ours, message: { id: 'm3', model: 'claude-opus-5-5', usage: { input_tokens: 500, output_tokens: 0 } } }) + '\n',
  );
  const page = await open(app);
  await expect(page.getByRole('tabpanel').getByRole('row', { name: /^demo/ })).toContainText('incl. 1 worktrees');
  await expect(page.locator('[data-limit="codex:own"]')).toContainText('Estimate: at this pace it runs out');
  const tiles = page.getByRole('group', { name: 'Summary' });
  await expect(tiles).toContainText('14k');
  await expect(page.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'All of this Mac' })).toBeChecked();
  await page.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'Nunchiro sessions only' }).click();
  // Only the started session's record counts; the transcripts from outside Nunchiro drop out.
  await expect(tiles).toContainText('Claude 500 · Codex 0');
  await page.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'All of this Mac' }).click();
  await expect(tiles).toContainText('14k');
  // The calendar: six week columns under Monday-first rows, days after today left open.
  const cal = page.getByRole('img', { name: 'Tokens per day over the last 6 weeks' });
  await expect(cal.locator('.dl')).toHaveCount(7);
  await expect(cal.locator('.wk')).toHaveCount(6);
  await expect(cal.locator('.cell')).toHaveCount(42);
});
