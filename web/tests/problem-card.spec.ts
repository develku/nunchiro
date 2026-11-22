// V2-5b: the problem card. A one-line band above the session's pane (never over chat or terminal), a red state dot in
// the tree and AGENTS, no "Switch account" anywhere, and a fix button the keyboard reaches.
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../src/types';
import { expect, openWindow, test, type Core, agentsZone } from './fixtures';

test.beforeEach(({ core }) => agentsZone(core)); // D5b: these specs read the AGENTS rows, which the default window no longer shows

const snapshot = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];
/** A fake agent: prints `text`, waits for `<project>/go` when `wait` is set, then exits with `code`. */
function fake(core: Core, name: 'claude' | 'codex', text: string, code: number, wait = false) {
  const go = wait ? 'while [ ! -f "$PWD/go" ]; do sleep 0.02; done\n' : '';
  const script = `#!/bin/sh\nif [ "$1" = --version ]; then echo '${name === 'codex' ? 'codex-cli 0.161.0' : '2.1.310 (Claude Code)'}'; exit; fi\nprintf '%s\\r\\n' '${text.replaceAll("'", "'\\''")}'\n${go}sleep 0.2\nexit ${code}\n`;
  fs.writeFileSync(path.join(core.home, 'bin', name), script, { mode: 0o700 });
}
const start = (core: Core, kind: 'claude' | 'codex', project: string, label: string) =>
  core.cli('session', 'start', '--kind', kind, '--project', project, '--label', label).session as Session;
const ended = (core: Core, id: string) => expect.poll(() => snapshot(core).find((s) => s.id === id)?.problem?.case, { timeout: 15_000 });

test('an unknown exit shows the generic card above the pane, a red dot, and a keyboard-reachable Restart', async ({ app, core, browserName }) => {
  const project = core.project('crash');
  fake(core, 'claude', 'working on it', 3);
  const old = start(core, 'claude', project, 'crash');
  await ended(core, old.id).toBe('unexpected');
  await openWindow(app);
  await app.locator(`.ar[data-agent="${old.id}"]`).click();
  const band = app.locator('.problem-band');
  await expect(band).toHaveAttribute('data-problem', 'unexpected');
  await expect(band).toContainText('Session ended unexpectedly (exit code 3).');
  await band.getByText('Details').click();
  await expect(band.locator('pre')).toContainText('Claude exited with code 3.');
  // Its own row: the pane starts below it, so nothing of the chat or terminal is under the band.
  const b = (await band.boundingBox())!;
  const pane = (await app.locator('.pane').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(pane.y + 0.5);
  // Red in AGENTS and in the tree (a broken row, never the orange of "your turn").
  const red = await app.locator(`.ar[data-agent="${old.id}"] .st`).evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(red).toMatch(/rgb\((207, 34, 46|248, 81, 73)\)/);
  await expect(app.locator('.tree .cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
  // The keyboard reaches the fix from the session header; Enter restarts in the same folder.
  await app.locator('.shead b').click();
  const fix = band.getByRole('button', { name: 'Restart' });
  // WebKit's Tab skips buttons unless Full Keyboard Access is on; Option+Tab walks every control (ticket 478).
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  for (let i = 0; i < 40 && !(await fix.evaluate((e) => e === document.activeElement)); i++) await app.keyboard.press(tab);
  await expect(fix).toBeFocused();
  await app.keyboard.press('Enter');
  await expect.poll(() => snapshot(core).length).toBe(2);
  const next = snapshot(core).find((s) => s.id !== old.id)!;
  expect(next).toMatchObject({ kind: 'claude', project, label: 'crash' });
  expect(snapshot(core).find((s) => s.id === old.id)?.state).toBe('closed');
  await expect(app.locator(`.tab[data-tab="${next.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('a card that arrives while the pointer is over the pane waits until it leaves', async ({ app, core }) => {
  const project = core.project('later');
  fake(core, 'claude', 'working on it', 3, true);
  const s = start(core, 'claude', project, 'later');
  await openWindow(app);
  await app.locator(`.ar[data-agent="${s.id}"]`).click();
  const pane = app.locator('.pane');
  const before = (await pane.boundingBox())!;
  await app.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  fs.writeFileSync(path.join(project, 'go'), '');
  await ended(core, s.id).toBe('unexpected');
  await expect(app.locator(`.ar[data-agent="${s.id}"] .st`)).toHaveAttribute('data-problem', 'unexpected');
  // Under the pointer the band does not come in: the pane stays where the ended session's view put it.
  const ended1 = await pane.boundingBox();
  await app.waitForTimeout(500);
  await expect(app.locator('.problem-band')).toHaveCount(0);
  expect(await pane.boundingBox()).toEqual(ended1);
  await app.mouse.move(5, 5);
  await expect(app.locator('.problem-band')).toHaveAttribute('data-problem', 'unexpected');
});

test('a Codex usage limit shows the reset time and Switch agent, never Switch account', async ({ app, core }) => {
  const project = core.project('limit');
  fake(core, 'codex', "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:20 PM.", 1);
  const s = start(core, 'codex', project, 'limit');
  await ended(core, s.id).toBe('usage_limit');
  await openWindow(app);
  await app.locator(`.ar[data-agent="${s.id}"]`).click();
  const band = app.locator('.problem-band');
  await expect(band).toContainText('Codex usage limit reached. Resets 2:20 PM per Codex.');
  await expect(band.getByRole('button')).toHaveText(['Switch agent']);
  await expect(app.getByText(/switch account/i)).toHaveCount(0);
  expect(await app.locator('body').innerText()).not.toMatch(/switch account|another account/i);
});

test('a hook trust failure offers a hook-less start that says what it loses', async ({ app, core }) => {
  const project = core.project('hooks');
  fake(core, 'codex', "error: unexpected argument '--dangerously-bypass-hook-trust' found", 2);
  const s = start(core, 'codex', project, 'hooks');
  await ended(core, s.id).toBe('hook_trust');
  await openWindow(app);
  await app.locator(`.ar[data-agent="${s.id}"]`).click();
  const band = app.locator('.problem-band');
  await expect(band.locator('.loss')).toContainText('Nunchiro finds waiting sessions only by reading the screen');
  fake(core, 'codex', 'fake agent ready', 0, true);
  await band.getByRole('button', { name: 'Start without Nunchiro hooks' }).click();
  await expect.poll(() => snapshot(core).find((x) => x.id !== s.id)?.without_hooks).toBe(true);
  await expect(app.locator('.problem-band[data-problem="hookless"]')).toContainText('Started without Nunchiro hooks.');
  fs.writeFileSync(path.join(project, 'go'), '');
});

test('a missing agent opens a failed tab with Open install page', async ({ app, core }) => {
  const project = core.project('none');
  fs.rmSync(path.join(core.home, 'bin', 'claude'));
  await openWindow(app);
  const reply = (await app.evaluate(
    (p) => new Promise((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${window.__NUNCHIRO__!.port}/ws`, ['nunchiro.v1', `nunchiro.token.${window.__NUNCHIRO__!.token}`]);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, request: { op: 'start', session: { kind: 'claude', project: p, label: 'none', model: null, effort: null, resume: null } } }));
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) (ws.close(), ok(m.response)); };
    }),
    project,
  )) as { Ok?: { session: Session } };
  const s = reply.Ok!.session;
  expect(s).toMatchObject({ state: 'failed', problem: { case: 'not_installed' } });
  await app.locator(`.ar[data-agent="${s.id}"]`).click();
  await expect(app.locator('.problem-band')).toContainText('Claude is not installed (claude is not on PATH).');
  await expect(app.locator('.problem-band').getByRole('button')).toHaveText(['Open install page']);
});

test('an unreachable core shows Restart background service; the reload reconnects and shows a set-aside state file', async ({ app, core }) => {
  await openWindow(app);
  core.run(['serve', 'stop', '--yes'], 10_000);
  const band = app.locator('.problem-band');
  await expect(band).toHaveAttribute('data-problem', 'core_unreachable', { timeout: 15_000 });
  await expect(band).toContainText("Can't reach Nunchiro's background service.");
  // A state file of another version is set aside by the next core (V1B-40): the notice says sweeps are paused.
  fs.writeFileSync(path.join(core.home, 'sessions.json'), '{"version": 99, "sessions": []}');
  await core.restart();
  // The app hands the reloaded page the new core's port and token (its page load runs ensure_core and window_auth).
  await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot());
  await band.getByRole('button', { name: 'Restart background service' }).click();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(band).toHaveAttribute('data-problem', 'set_aside');
  await expect(band).toContainText('Saved scrollback and exports are not cleaned up until you remove it.');
  await expect(band.getByRole('button')).toHaveCount(0);
});
