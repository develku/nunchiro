// v1a-38: macOS system sounds on running -> done and on a new waiting item, through the app's allowlisted
// `play_sound` command (stubbed here: the page runs as if inside the app and records each invoke).
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core, stripOnTop } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

async function recordInvokes(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __calls: { cmd: string; args: unknown }[]; __focus: number };
    w.__calls = [];
    w.__focus = 0;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => void w.__calls.push({ cmd, args }),
    };
    window.focus = () => void w.__focus++;
  });
}
const sounds = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: { cmd: string; args: unknown }[] }).__calls.filter((c) => c.cmd === 'play_sound').map((c) => c.args));
const focusCalls = (page: Page) => page.evaluate(() => (window as unknown as { __focus: number }).__focus);
/** A shell session that exits (state done) once `<project>/<file>` exists. */
const finisher = (core: Core, project: string, label: string, file: string) =>
  core.shell(project, label, '/bin/sh', '-c', 'while [ ! -e "$1" ]; do sleep 0.05; done', 'finisher', path.join(project, file));
const done = (core: Core, id: string) =>
  expect.poll(() => core.cli('snapshot', '--json').sessions.find((s: { id: string }) => s.id === id)?.state, { timeout: 5000 }).not.toBe('running');
const settle = (page: Page) => page.waitForTimeout(400);
// needs 170 (2) (72bccdc1): the session the user is looking at gets no done cue (isViewed needs window focus). The window is
// left unfocused, as notify-turn-end.spec does, so a done cue here is the background-session case these tests pin.
const unviewed = (page: Page) => page.addInitScript(() => (document.hasFocus = () => false));

test('a session going running -> done plays the done sound (Glass) once and never focuses', async ({ app, core }) => {
  await recordInvokes(app);
  await unviewed(app);
  const p = core.project('demo');
  const s = finisher(core, p, 'job', 'go');
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go'), '');
  await done(core, s.id);
  await expect.poll(() => sounds(app)).toEqual([{ name: 'Glass', volume: 1 }]);
  await settle(app);
  expect(await sounds(app)).toHaveLength(1);
  expect(await focusCalls(app)).toBe(0);
  // A reload sees the session already done: a first snapshot is not a transition.
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

test('a session already done before the window opened plays nothing', async ({ app, core }) => {
  await recordInvokes(app);
  const p = core.project('demo');
  const s = finisher(core, p, 'job', 'go');
  fs.writeFileSync(path.join(p, 'go'), '');
  await done(core, s.id);
  await openWindow(app);
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

test('a muted session plays nothing when it finishes or waits', async ({ app, core }) => {
  await recordInvokes(app);
  const p = core.project('demo');
  const s = finisher(core, p, 'job', 'go');
  const a = core.agent(p, 'agent-a', 'go-a');
  await app.addInitScript(([x, y]) => localStorage.setItem('nunchiro.notify.v1', JSON.stringify({ [x]: 'muted', [y]: 'muted' })), [s.id, a.id]);
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go'), '');
  fs.writeFileSync(path.join(p, 'go-a'), '');
  await done(core, s.id);
  await expect(app.locator(`button.row.wt2[data-menu-session="${a.id}"]`)).toHaveClass(/\byou\b/, { timeout: 5000 });
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

test('a new permission item plays the waiting sound (Ping) once; the chosen sound and volume are used', async ({ app, core }) => {
  await recordInvokes(app);
  await unviewed(app);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ soundWaiting: 'Tink', soundVolume: 0.5 })));
  const p = core.project('demo');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go-a'), '');
  await expect(app.locator(`button.row.wt2[data-menu-session="${a.id}"]`)).toHaveClass(/\byou\b/, { timeout: 5000 });
  await expect.poll(() => sounds(app)).toEqual([{ name: 'Tink', volume: 0.5 }]);
  await settle(app);
  expect(await sounds(app)).toHaveLength(1);
  expect(await focusCalls(app)).toBe(0);
});

// Ticket 316 (final.html new.notifyFocused): the session in front of the user stays quiet unless the setting is off.
for (const [notifyFocused, heard] of [[true, []], [false, [{ name: 'Ping', volume: 1 }]]] as const) {
  test(`a waiting item on the session in front: notifyFocused ${notifyFocused} plays ${heard.length} sound`, async ({ app, core }) => {
    await recordInvokes(app);
    await app.addInitScript((on) => {
      document.hasFocus = () => true;
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ notifyFocused: on }));
    }, notifyFocused);
    const p = core.project('demo');
    const a = core.agent(p, 'agent-a', 'go-a');
    await openWindow(app);
    await app.locator(`[data-tab="${a.id}"], button.row.wt2[data-menu-session="${a.id}"]`).first().click();
    await expect(app.getByRole('tab', { name: /agent-a/ }).first()).toHaveAttribute('aria-selected', 'true');
    fs.writeFileSync(path.join(p, 'go-a'), '');
    await expect(app.locator(`button.row.wt2[data-menu-session="${a.id}"]`)).toHaveClass(/\byou\b/, { timeout: 5000 });
    await settle(app);
    expect(await sounds(app)).toEqual(heard);
  });
}

test('sounds set to Off play nothing', async ({ app, core }) => {
  await recordInvokes(app);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ soundDone: 'off', soundWaiting: 'off' })));
  const p = core.project('demo');
  const s = finisher(core, p, 'job', 'go');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go'), '');
  fs.writeFileSync(path.join(p, 'go-a'), '');
  await done(core, s.id);
  await expect(app.locator(`button.row.wt2[data-menu-session="${a.id}"]`)).toHaveClass(/\byou\b/, { timeout: 5000 });
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

test('the Alerts page picks a system sound per event, previews it, and keeps the choice across a reload', async ({ app, core }) => {
  await recordInvokes(app);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Notifications' }).click();
  const doneSound = app.getByRole('combobox', { name: 'Sound when a session is done' });
  await expect(doneSound).toHaveValue('Glass');
  await expect(app.getByRole('combobox', { name: 'Sound when a session is waiting' })).toHaveValue('Ping');
  await doneSound.selectOption('Hero');
  await app.getByRole('button', { name: 'Preview the done sound' }).click();
  await expect.poll(() => sounds(app)).toEqual([{ name: 'Hero', volume: 1 }]);
  await app.getByRole('combobox', { name: 'Sound when a session is waiting' }).selectOption('off');
  await expect(app.getByRole('button', { name: 'Preview the waiting sound' })).toBeDisabled();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openSettings(app);
  await expect(app.getByRole('combobox', { name: 'Sound when a session is done' })).toHaveValue('Hero');
  await expect(app.getByRole('combobox', { name: 'Sound when a session is waiting' })).toHaveValue('off');
});

// Review round 1: only a session that ends on its own is "done"; closing it or stopping the core is not.
test('closing a running session or restarting the core plays nothing', async ({ app, core }) => {
  await recordInvokes(app);
  const p = core.project('demo');
  const a = core.shell(p, 'closed');
  core.shell(p, 'kept');
  await openWindow(app);
  core.cli('session', 'close', a.id);
  await done(core, a.id);
  await settle(app);
  // The open window watches the core stop (every shell marked exited) and the new core come back.
  core.cli('serve', 'stop');
  await core.restart();
  await app.addInitScript((boot) => Object.assign(window.__NUNCHIRO__ ?? {}, boot), core.boot());
  await settle(app);
  expect(await sounds(app)).toEqual([]);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

// A fake agent that shows a permission prompt once `<go>` exists and exits 0 once `<go>.exit` exists.
const EXITING = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
go=""; prev=""
for a in "$@"; do [ "$prev" = --model ] && go="$a"; prev="$a"; done
printf 'fake agent ready\\r\\n'
while [ ! -f "$go" ]; do sleep 0.02; done
printf '\\033[2J\\033[HDo you want to proceed?\\r\\n1. Yes\\r\\n2. No\\r\\n'
while [ ! -f "$go.exit" ]; do sleep 0.02; done
`;

test('a session that exits while it waits still plays done after the waiting sound', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), EXITING, { mode: 0o700 });
  await recordInvokes(app);
  await unviewed(app);
  const p = core.project('demo');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go-a'), '');
  await expect(app.locator(`button.row.wt2[data-menu-session="${a.id}"]`)).toHaveClass(/\byou\b/, { timeout: 5000 });
  await expect.poll(() => sounds(app)).toEqual([{ name: 'Ping', volume: 1 }]);
  fs.writeFileSync(path.join(p, 'go-a.exit'), '');
  await expect.poll(() => sounds(app), { timeout: 5000 }).toEqual([{ name: 'Ping', volume: 1 }, { name: 'Glass', volume: 1 }]);
});

test('"waiting only" keeps the waiting sound but not the done sound', async ({ app, core }) => {
  await recordInvokes(app);
  const p = core.project('demo');
  const s = finisher(core, p, 'job', 'go');
  await app.addInitScript((id) => localStorage.setItem('nunchiro.notify.v1', JSON.stringify({ [id]: 'waiting' })), s.id);
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go'), '');
  await done(core, s.id);
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

// A crashed core sends no "exited" snapshot: the window keeps its last list (all running) until the new core's first
// snapshot says exited. The socket is proxied so the test can drop it and answer the reconnect itself.
test('a core that crashes and comes back plays no false done sound', async ({ app, core }) => {
  await recordInvokes(app);
  const p = core.project('demo');
  core.shell(p, 'a');
  core.shell(p, 'b');
  let last: { sessions: { state: string }[] } | undefined;
  let first: { close(): Promise<void> } | undefined;
  let connections = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    if (connections++ === 0) {
      const server = ws.connectToServer();
      first = ws;
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (typeof m === 'string' && JSON.parse(m).event === 'snapshot') last = JSON.parse(m);
        ws.send(m);
      });
    } else {
      // The new core answers 500 ms after the socket opens, with every session exited (a crash ends their PTYs).
      setTimeout(() => ws.send(JSON.stringify({ ...last, sessions: last!.sessions.map((s) => ({ ...s, state: 'exited' })) })), 500);
    }
  });
  await openWindow(app);
  await expect.poll(() => last?.sessions.length).toBe(2);
  await first!.close();
  await expect(app.locator('.tab .tdot[data-s="done"]')).toHaveCount(2, { timeout: 10000 });
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await settle(app);
  expect(await sounds(app)).toEqual([]);
});

// V1A-50 (carried V1A-49 review): the guard above waits for the first snapshot after a reconnect; past it, a real
// finish still plays. The socket is proxied to the same core so the test can drop it once.
test('after a normal reconnect a session that finishes still plays the done sound', async ({ app, core }) => {
  await recordInvokes(app);
  await unviewed(app);
  const p = core.project('demo');
  const s = finisher(core, p, 'job', 'go');
  let first: { close(): Promise<void> } | undefined;
  let snapshots = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    first ??= ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).event === 'snapshot') snapshots++;
      ws.send(m);
    });
  });
  await openWindow(app);
  await expect.poll(() => snapshots).toBeGreaterThan(0);
  const before = snapshots;
  await first!.close();
  await expect.poll(() => snapshots).toBeGreaterThan(before); // the new connection's first snapshot
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  fs.writeFileSync(path.join(p, 'go'), '');
  await done(core, s.id);
  await expect.poll(() => sounds(app)).toEqual([{ name: 'Glass', volume: 1 }]);
  await settle(app);
  expect(await sounds(app)).toHaveLength(1);
});
