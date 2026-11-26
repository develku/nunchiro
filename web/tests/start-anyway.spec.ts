// A window start held while the Mac is low on memory says so in a short line with Start anyway (mockup
// docs/design/memory-hold-m8/index.html, panel 2). The core's hold is faked here: its `start` of an agent answers the
// window's hold sentence, and a `start_anyway` goes through as its start (crates/nunchiro/tests/sessions.rs checks the
// core's side, at a faked critical reading).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const HELD = 'Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway';
type Snap = { id: string; project: string; state: string; kind: string };
const agents = (core: Core) => (core.cli('snapshot', '--json').sessions as Snap[]).filter((s) => s.kind === 'claude' && s.state === 'running');

/** Every agent `start` is held; a `start_anyway` reaches the core as its plain start. Returns the ops the window sent. */
async function holdStarts(app: Page) {
  const sent: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      const r = frame?.request;
      if (r?.op === 'start' || r?.op === 'start_anyway') sent.push(r.op);
      if (r?.op === 'start' && r.session?.kind !== 'shell') return ws.send(JSON.stringify({ id: frame.id, response: { Err: HELD } }));
      if (r?.op === 'start_anyway' && r.start?.op === 'start') return server.send(JSON.stringify({ ...frame, request: r.start }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

const setup = async (app: Page, core: Core) => {
  const p = core.project('api-server');
  core.shell(p, 'main-shell');
  openQuiet(core);
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'onboarding.default_agent': 'claude' } })));
  const sent = await holdStarts(app);
  await openWindow(app);
  return { p, sent };
};
const plus = async (app: Page) => {
  const head = app.locator('.row.head', { hasText: 'api-server' });
  await head.hover();
  await head.getByRole('button', { name: 'New Claude session in api-server' }).click();
};

test('held_start_note_starts_anyway: the tree\'s + held for low memory says so with Start anyway, which starts it and opens its tab', async ({ app, core }) => {
  const { p, sent } = await setup(app, core);
  await plus(app);
  const bar = app.locator('.pane-status');
  await expect(bar).toContainText('Your Mac is low on memory, so Claude was not started.');
  await expect(bar).not.toContainText('nunchiro agent start');
  const anyway = bar.getByRole('button', { name: 'Start anyway' });
  await expect(anyway).toHaveAttribute('data-tip', 'Start it now. Your Mac may slow down or close other apps.');
  expect(agents(core)).toHaveLength(0);
  await anyway.click();
  await expect.poll(() => agents(core).map((s) => s.project), { timeout: 15_000 }).toEqual([p]);
  expect(sent).toEqual(['start', 'start_anyway']);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', agents(core)[0].id);
  await expect(bar).not.toContainText('low on memory');
});

test('held_start_note_dismissed_starts_nothing: × closes the note and starts nothing', async ({ app, core }) => {
  const { sent } = await setup(app, core);
  await plus(app);
  const bar = app.locator('.pane-status');
  await expect(bar.getByRole('button', { name: 'Start anyway' })).toBeVisible();
  await bar.getByRole('button', { name: 'Dismiss' }).click();
  await expect(bar).not.toContainText('low on memory');
  await app.waitForTimeout(500);
  expect(sent).toEqual(['start']);
  expect(agents(core)).toHaveLength(0);
});

test('held_start_in_new_tab_menu_starts_anyway: the + menu says the hold in its own line, and Start anyway starts it', async ({ app, core }) => {
  const { p, sent } = await setup(app, core);
  await app.keyboard.press('Meta+KeyT');
  const pop = app.getByRole('dialog', { name: 'New tab' });
  await pop.getByRole('option', { name: /^Claude/ }).click();
  const alert = pop.getByRole('alert');
  await expect(alert).toContainText('Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway.');
  await expect(alert).not.toContainText('Not started:');
  await alert.getByRole('button', { name: 'Start anyway' }).click();
  await expect.poll(() => agents(core).map((s) => s.project), { timeout: 15_000 }).toEqual([p]);
  expect(sent).toEqual(['start', 'start_anyway']);
  await expect(pop).toHaveCount(0);
});

test('held_background_send_starts_anyway: Cmd+Enter held for low memory keeps the text in the box; Start anyway sends it to a new session', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
  const p = core.project('api-server');
  const s = core.agent(p, 'alpha', 'x');
  const sent = await holdStarts(app);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const box = app.locator('.composer textarea');
  await box.fill('write the tests first');
  await box.press('Meta+Enter');
  const bar = app.locator('.pane-status');
  await expect(bar).toContainText('Your Mac is low on memory, so Claude was not started.');
  await expect(box).toHaveValue('write the tests first');
  await bar.getByRole('button', { name: 'Start anyway' }).click();
  await expect.poll(() => agents(core).length, { timeout: 15_000 }).toBe(2);
  expect(sent).toEqual(['start', 'start_anyway']);
  // The new session started past the hold and the view stayed; the box still holds the text, as after the hold.
  await expect(box).toHaveValue('write the tests first');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', s.id);
});

test('held_worktree_dialog_starts_anyway: the New worktree card says the hold in its own words, and Start anyway starts the agent in the kept worktree', async ({ app, core }) => {
  const p = core.project('api-server');
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  core.shell(p, 'main-shell');
  openQuiet(core);
  const sent = await holdStarts(app);
  await openWindow(app);
  await app.keyboard.press('Meta+KeyN');
  const card = app.getByRole('dialog', { name: 'New worktree', exact: true });
  await card.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await card.getByRole('checkbox', { name: 'Start an agent here' }).check();
  await card.getByRole('button', { name: 'Create and start' }).click();
  const alert = card.getByRole('alert');
  await expect(alert).toContainText('Your Mac is low on memory, so the new session was not started. Close something and try again, or start it anyway.');
  await expect(alert).not.toContainText('Could not start the agent');
  await alert.getByRole('button', { name: 'Start anyway' }).click();
  await expect.poll(() => agents(core).map((s) => s.project), { timeout: 15_000 }).toEqual([p]);
  expect(sent).toEqual(['start', 'start_anyway']);
  await expect(card).toHaveCount(0);
});
