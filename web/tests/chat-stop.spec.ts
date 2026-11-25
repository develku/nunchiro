// CHAT-STOP (needs 121): while the agent works the composer's Send turns into Stop, Esc in the composer stops, text typed
// while working waits in the list above the box (ticket 371 item 15), and the hint line gains "Esc stop". Stop is the existing
// `send_keys ["esc"]` and nothing else. A real core and a fake Claude (crates/nunchiro-core/tests/fixtures/claude-mode,
// which logs every stdin read as hex); "working" is the real hook event, sent over the owner socket.
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

function fakeClaude(core: Core) {
  const src = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(src), { mode: 0o700 });
}
const reads = (core: Core, id: string) =>
  fs.existsSync(path.join(core.home, `stdin-${id}.log`))
    ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8').split('\n').filter((l) => l.startsWith('READ ')).map((l) => l.slice(5))
    : [];

// The agent hook bridge needs a session token; the owner socket takes the same event with the owner token.
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: Core, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}

type Req = { op: string; [k: string]: unknown };
/** Every request the window sends. */
function watch(app: Page) {
  const sent: Req[] = [];
  app.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const r = JSON.parse(f.payload).request;
      if (r) sent.push(r);
    }),
  );
  return { sent, ops: (...op: string[]) => sent.filter((r) => op.includes(r.op)) };
}

const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
const stop = (app: Page) => app.locator('.composer .send');
async function working(app: Page, core: Core, id: string, shown = false) {
  hook(core, id, 'UserPromptSubmit');
  // The core's own state, not the button: the base build (no Stop) reaches here too, so a pin test can be green on it.
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working).toBe(true);
  // `shown`: also wait until the window has the snapshot and draws Stop (a press before that is a normal Send).
  if (shown) await expect(stop(app)).toHaveAccessibleName('Stop');
}

test('send_becomes_stop_while_working: Send when idle or waiting, Stop (enabled, empty draft) when working', async ({ app, core }) => {
  fakeClaude(core);
  const project = core.project('p');
  const s = core.agent(project, 'mode', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  await expect(stop(app)).toHaveAccessibleName('Send');
  await expect(stop(app)).toBeDisabled(); // nothing typed
  hook(core, s.id, 'UserPromptSubmit');
  await expect(stop(app)).toHaveAccessibleName('Stop');
  await expect(stop(app)).toBeEnabled(); // empty draft, still enabled
  await expect(stop(app)).toHaveClass(/\bstop\b/);
  await expect(stop(app)).toHaveAttribute('title', 'Stop (Esc)');
  // A decision pending: the agent waits for the owner, so Esc would answer it. Back to the normal Send.
  fs.writeFileSync(path.join(project, 'dialog'), '');
  await expect(stop(app)).toHaveAccessibleName('Send');
  await expect(stop(app)).toBeDisabled();
  expect(reads(core, s.id)).toEqual([]);
});

test('stop_click_sends_one_esc: one click, one send_keys ["esc"], no send_text; the draft and chips stay', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  const w = watch(app);
  await openWindow(app);
  await tab(app, s.id).click(); // click 1: the open session
  await working(app, core, s.id, true);
  await app.locator('.composer textarea').fill('half a thought');
  await app.locator('.composer textarea').blur();
  const before = w.sent.length;
  await stop(app).click(); // click 2: Stop
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  const after = w.sent.slice(before).filter((r) => r.op === 'send_keys' || r.op === 'send_text');
  expect(after.map((r) => [r.op, r.keys])).toEqual([['send_keys', ['esc']]]);
  await expect(app.locator('.composer textarea')).toHaveValue('half a thought');
  await app.waitForTimeout(300);
  expect(reads(core, s.id)).toEqual(['1b']);
});

// ticket 115: the Esc carries the pending item ids this window has drawn for the session, so core can refuse it while
// another request is pending. In steady state Stop is hidden while a request is pending (the session shows waiting),
// so the list is the session's own pending ids, none here; core's side is the sessions.rs tests.
test('stop_sends_seen_ids: send_keys ["esc"] carries seen = the session\'s drawn pending ids (an array, never absent)', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  const w = watch(app);
  await openWindow(app);
  await tab(app, s.id).click();
  await working(app, core, s.id, true);
  const pending = (core.cli('snapshot', '--json').sessions as { id: string; pending: { id: string }[] }[]).find((x) => x.id === s.id)!.pending.map((p) => p.id);
  await stop(app).click();
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  const esc = w.ops('send_keys').filter((r) => (r.keys as string[]).includes('esc'));
  expect(esc).toHaveLength(1);
  expect(esc[0].seen).toEqual(pending);
  expect(Array.isArray(esc[0].seen)).toBe(true);
});

test('esc_in_composer_stops_once: one Esc, one send_keys; not while idle, composing, repeating or after a handoff', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  const w = watch(app);
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  const escs = () => w.ops('send_keys').filter((r) => (r.keys as string[]).join() === 'esc').length;
  await ta.focus();
  await ta.press('Escape'); // idle: nothing
  await app.waitForTimeout(200);
  expect(escs()).toBe(0);
  await working(app, core, s.id, true);
  await ta.focus();
  await ta.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }))); // an IME's own Esc
  await ta.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, repeat: true }))); // a held key
  await app.waitForTimeout(200);
  expect(escs()).toBe(0);
  await ta.press('Escape');
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  expect(escs()).toBe(1);
});

test('esc_with_handoff_drops_the_handoff_and_sends_nothing', async ({ app, core }) => {
  const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude').session as { id: string };
  const w = watch(app);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  // The picker refuses while the agent works, so the handoff is chosen first and the turn starts after.
  await app.locator('[data-picker="model"]').click();
  await app.locator('[data-menu="model"] [data-item="more"]').click(); // W35: the hand-off group is under More models ›
  await app.locator('[data-menu="model"] [data-item="handoff-codex"]').click();
  const chip = app.locator('[data-handoff-chip]');
  await expect(chip).toBeVisible();
  await working(app, core, s.id, true);
  await app.locator('.composer textarea').focus();
  await app.locator('.composer textarea').press('Escape');
  await expect(chip).toHaveCount(0);
  await app.waitForTimeout(300);
  expect(w.ops('send_keys')).toEqual([]);
});

/** A core that answers every request of `ops` with an Err (counted in `seen`), and passes everything else on. */
async function refusing(app: Page, ops: string[]) {
  const seen: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request && ops.includes(msg.request.op)) {
        seen.push(msg.request.op);
        return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'holder busy' } }));
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return seen;
}

test('stop_refusal_is_shown_not_retried: the plain note shows, the core text is its tooltip, one request only', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  const seen = await refusing(app, ['send_keys']);
  await openWindow(app);
  await tab(app, s.id).click();
  await working(app, core, s.id, true);
  await stop(app).click();
  // Ticket 476: the core's words are the note's tooltip, not its text.
  await expect(app.locator('.pane-status .pane-note')).toHaveText('Not stopped: That did not work. Click this note to copy the details.');
  await expect(app.locator('.pane-status .pane-note')).toHaveAttribute('data-tip', 'holder busy');
  await app.waitForTimeout(500);
  expect(seen).toEqual(['send_keys']);
  expect(reads(core, s.id)).toEqual([]);
});

// Ticket 371 item 15: Enter while working no longer writes to the CLI, so the old delivered line became the list.
test('typed_while_working_shows_the_list: only on its session, until its row goes in', async ({ app, core }) => {
  fakeClaude(core);
  const a = core.agent(core.project('a'), 'alpha', 'x');
  const b = core.agent(core.project('a'), 'beta', 'x');
  await openWindow(app);
  const ta = app.locator('.composer textarea');
  const line = app.locator('.composer .qlist');
  await tab(app, a.id).click();
  await working(app, core, a.id, true);
  await expect(ta).toHaveAttribute('placeholder', 'Message alpha… (@ files, / commands)');
  await ta.fill('stop touching the project rows');
  await ta.press('Enter');
  await expect(line).toContainText('stop touching the project rows');
  await expect(line).toHaveAttribute('role', 'group');
  // Another session's tab never shows it, and coming back finds it still there.
  await tab(app, b.id).click();
  await expect(line).toHaveCount(0);
  await tab(app, a.id).click();
  await expect(line).toHaveCount(1);
  // The turn ends: the row goes in and the list goes with it.
  hook(core, a.id, 'Stop');
  await expect(line).toHaveCount(0);
  await expect(ta).toHaveAttribute('placeholder', 'Message alpha… (@ files, / commands)');
});

// Ticket 371 item 15: the list replaces the Claude-only line, so Codex now shows it too (it used to show nothing).
test('list_for_every_queueing_agent: shown for Claude and for Codex', async ({ app, core }) => {
  fakeClaude(core);
  fs.writeFileSync(path.join(core.home, 'bin/codex'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
  const project = core.project('p');
  const claude = core.agent(project, 'alpha', 'x');
  const codex = core.cli('session', 'start', '--kind', 'codex', '--project', project, '--label', 'beta').session as { id: string };
  await openWindow(app);
  const ta = app.locator('.composer textarea');
  const line = app.locator('.composer .qlist');
  await tab(app, claude.id).click();
  await working(app, core, claude.id, true);
  await ta.fill('for claude');
  await ta.press('Enter');
  await expect(line).toContainText('for claude');
  await tab(app, codex.id).click();
  await working(app, core, codex.id, true);
  await ta.fill('for codex');
  await ta.press('Enter');
  await expect(line).toContainText('for codex');
  expect(reads(core, codex.id)).toEqual([]);
});

// Ticket 371 item 15: a send refused while working cannot happen any more (nothing is written), so this keeps the idle case.
test('failed_send_shows_no_list_and_keeps_the_text', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await refusing(app, ['send_text']);
  await openWindow(app);
  await tab(app, s.id).click();
  await expect(app.locator('.composer textarea')).toBeEnabled();
  await app.locator('.composer textarea').fill('this fails');
  await app.locator('.composer textarea').press('Enter');
  await expect(app.locator('.composer textarea')).toHaveValue('this fails'); // restored by the existing failure path
  await app.waitForTimeout(300);
  await expect(app.locator('.composer .qlist')).toHaveCount(0);
});

// Ticket 371 item 15: the write moved from the moment of Enter to the turn's end.
test('enter_while_working_waits: nothing is written during the turn, then send_text and send_keys ["enter"], no esc', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  const w = watch(app);
  await openWindow(app);
  await tab(app, s.id).click();
  await working(app, core, s.id, true);
  const before = w.sent.length;
  await app.locator('.composer textarea').fill('hello');
  await app.locator('.composer textarea').press('Enter');
  await expect(app.locator('.composer .qrow')).toHaveCount(1);
  await app.waitForTimeout(300);
  expect(reads(core, s.id)).toEqual([]);
  hook(core, s.id, 'Stop');
  await expect.poll(() => reads(core, s.id).length).toBeGreaterThan(0);
  await expect.poll(() => w.sent.slice(before).filter((r) => r.op === 'send_keys').length).toBe(1);
  const seq = w.sent.slice(before).filter((r) => r.op === 'send_text' || r.op === 'send_keys').map((r) => [r.op, r.keys ?? r.text]);
  expect(seq).toEqual([
    ['send_text', expect.stringContaining('hello')],
    ['send_keys', ['enter']],
  ]);
});

test('hint_and_a11y: no key hint while Stop shows and nothing waits; axe clean; Tab reaches Stop, Enter and Space each press once', async ({ app, core, browserName }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  const hint = app.locator('.composer .chint');
  await expect(hint).toHaveCount(0);
  const axe = async () => (await new AxeBuilder({ page: app }).include('.composer').analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(await axe()).toEqual([]);
  await working(app, core, s.id, true);
  await expect(hint).toHaveCount(0); // v25-chat-calm (needs 144): the hint is for a waiting message only
  // "Esc stop" in the hint, with a message waiting: chat-calm.spec.ts hint_shown_when_queued.
  expect(await axe()).toEqual([]);
  await app.locator('.composer textarea').focus();
  // WebKit does not Tab to buttons unless the OS asks it to, so there the button is focused directly.
  if (browserName === 'webkit') await stop(app).focus();
  else for (let i = 0; i < 20 && !(await stop(app).evaluate((el) => el === document.activeElement)); i++) await app.keyboard.press('Tab');
  await expect(stop(app)).toBeFocused();
  await app.keyboard.press('Enter');
  await expect.poll(() => reads(core, s.id)).toEqual(['1b']);
  // Look 11-17 N0: the core's Esc ends the turn once Claude is back at its box, so the second press needs a new turn.
  await expect(stop(app)).not.toHaveAccessibleName('Stop');
  await working(app, core, s.id, true);
  await stop(app).focus();
  await app.keyboard.press('Space');
  await expect.poll(() => reads(core, s.id)).toEqual(['1b', '1b']);
});

