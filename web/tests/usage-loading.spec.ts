// Ticket 211 (A1/D1, A2) on the Usage page against a real core and hand-written transcripts: a loading line until the
// first reply, "cost unknown for <model>" instead of a bare dash, and "via link" / the refusal for a linked folder.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const jsonl = (file: string, ...lines: object[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
};
const claudeLine = (id: string, model: string, input: number) => ({ type: 'assistant', timestamp: iso(1), message: { id, model, usage: { input_tokens: input, output_tokens: 0 } } });
const openUsage = async (app: import('@playwright/test').Page) => {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Usage' }).click();
};

test('usage_page_shows_loading_line_until_first_reply', async ({ app, core }) => {
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  // Hold the account_usage reply until released; every other frame passes.
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const held = new Set<unknown>();
    ws.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"account_usage"')) held.add(JSON.parse(m).id);
      server.send(m);
    });
    server.onMessage((m) => {
      const id = typeof m === 'string' ? JSON.parse(m).id : undefined;
      if (id !== undefined && held.has(id)) void gate.then(() => ws.send(m));
      else ws.send(m);
    });
  });
  await openWindow(app);
  await openUsage(app);
  const loading = app.locator('#s-usage').getByText('Reading usage from this Mac…');
  await expect(loading).toBeVisible();
  release();
  await expect(loading).toHaveCount(0);
  await expect(app.locator('#s-usage [data-limit="claude:own"]')).toHaveCount(1);
});

test('usage_page_names_unpriced_model_and_linked_folders', async ({ app, core }) => {
  // 5.5 Opus is priced ($4/M input); mystery-1 is not: the cell names it instead of showing a dash.
  jsonl(path.join(core.home, 'claude-home/projects/p/a.jsonl'), claudeLine('m1', 'mystery-1', 1_000_000));
  // Codex sessions link outside HOME (refused); Claude's projects link is inside HOME elsewhere in the next case.
  const outside = path.join(core.home, 'elsewhere/sessions');
  jsonl(path.join(outside, '2026/10/24/r.jsonl'), { timestamp: iso(1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5 }, last_token_usage: { input_tokens: 5, output_tokens: 0 } } } });
  fs.mkdirSync(path.join(core.home, 'codex-home'), { recursive: true });
  fs.symlinkSync(outside, path.join(core.home, 'codex-home/sessions'));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openUsage(app);
  const usage = app.locator('#s-usage');
  await usage.getByRole('tab', { name: 'Model' }).click();
  await expect(usage.getByRole('tabpanel').getByRole('row', { name: /Price unknown: mystery-1/ })).toContainText('1M');
  const codex = usage.locator('[data-limit="codex:own"]');
  await expect(codex).toContainText("Not counted: this account’s folder is a link to a folder outside your user folder");
  await expect(codex.locator(`[data-menu="path"][title="${fs.realpathSync(outside)}"]`)).toHaveCount(1); // the path is the tooltip, not the sentence (no longer mono since 9d44ad7ba)
  await usage.getByRole('tab', { name: 'Agent' }).click();
  await expect(usage.locator('.prov[data-agent-name="Codex"]')).toContainText('No records in this range');
});

test('usage_page_labels_a_followed_link_via_link', async ({ app, core }) => {
  const home = path.join(core.home, 'sentinel-home');
  const target = path.join(home, 'moved-sessions');
  jsonl(path.join(target, '2026/10/24/r.jsonl'), { timestamp: iso(1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1500 }, last_token_usage: { input_tokens: 1500, output_tokens: 0 } } } });
  fs.mkdirSync(path.join(core.home, 'codex-home'), { recursive: true });
  fs.symlinkSync(target, path.join(core.home, 'codex-home/sessions'));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openUsage(app);
  const usage = app.locator('#s-usage');
  await expect(usage.locator('[data-limit="codex:own"]')).toContainText(`via link: ${fs.realpathSync(target)}`);
  await usage.getByRole('tab', { name: 'Agent' }).click();
  await expect(usage.locator('.prov[data-agent-name="Codex"]')).toContainText('1.5k');
});

// Look 1117 v5 (C S2-1): the core's first read of the records takes seconds. Once the page has shown numbers, the next
// open (also after a relaunch) shows them at once with their "Updated" time while the new read runs, never an empty page.
test('usage_page_shows_the_last_numbers_while_it_reads', async ({ app, core }) => {
  jsonl(path.join(core.home, 'claude-home/projects/p/a.jsonl'), claudeLine('m1', 'claude-opus-5-5', 1_000_000));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  // From `hold` on, the usage replies wait until the end of the test.
  let hold = false;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const held = new Set<unknown>();
    ws.onMessage((m) => {
      if (hold && typeof m === 'string' && /"(account_usage|usage_detail)"/.test(m)) held.add(JSON.parse(m).id);
      server.send(m);
    });
    server.onMessage((m) => {
      const id = typeof m === 'string' ? JSON.parse(m).id : undefined;
      if (id !== undefined && held.has(id)) void gate.then(() => ws.send(m));
      else ws.send(m);
    });
  });
  await openWindow(app);
  await openUsage(app);
  const usage = app.locator('#s-usage');
  await expect(usage.locator('.tiles')).toContainText('1M');
  await expect(usage.getByText(/^Updated /)).toBeVisible();
  hold = true;
  await app.reload();
  await openWindow(app);
  // The window comes back with Settings open on Usage, as it was left.
  await expect(usage.locator('.tiles')).toContainText('1M');
  await expect(usage.getByText(/^Updated /)).toBeVisible();
  await expect(usage.locator('[data-limit="claude:own"]')).toHaveCount(1);
  await expect(usage.getByText('Reading usage from this Mac…')).toHaveCount(0);
  release();
});

// Sixth look (C, S2): the first open in a new home showed only the loading line for 7 s. A window that has kept no
// numbers reads the rows and the default range once in the background, 10 s after it connected.
test('usage_first_open_has_numbers: a window that kept none reads them in the background before the page opens', async ({ app, core }) => {
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(core.home, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  core.shell(core.project('demo'), 'alpha');
  await app.clock.install();
  await openWindow(app);
  const kept = () =>
    app.evaluate(() => {
      const k = JSON.parse(localStorage.getItem('nunchiro.usage.last.v1') ?? '{}') as { rows?: unknown[]; details?: [string, unknown][] };
      return [Array.isArray(k.rows), k.details?.[0]?.[0] ?? null];
    });
  expect(await kept()).toEqual([false, null]);
  await app.clock.fastForward(11_000);
  await expect.poll(kept).toEqual([true, '{"days":30}']);
  await openUsage(app);
  await expect(app.locator('#s-usage [data-limit="claude:own"]')).toHaveCount(1);
});
