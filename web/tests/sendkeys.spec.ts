// v25-sendkeys (FIDELITY BAR): Ctrl+Enter sends the composer's text now (Claude Code's `chat:sendNow`, which breaks the
// running turn first), Cmd+Enter starts a session with the text and keeps the view, and both keys are on the Keys page.
// A real core and a fake Claude (crates/nunchiro-core/tests/fixtures/claude-mode, which logs every stdin read as hex).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { DEFAULT_BINDINGS, resolve } from '../src/keys';
import { type Core, expect, openWindow, REPO, test, showComposer } from './fixtures';

function fakeClaude(core: Core) {
  const src = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(src), { mode: 0o700 });
}
const reads = (core: Core, id: string) =>
  fs.existsSync(path.join(core.home, `stdin-${id}.log`))
    ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8').split('\n').filter((l) => l.startsWith('READ ')).map((l) => l.slice(5))
    : [];
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: Core, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}
const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
async function working(app: Page, core: Core, id: string, shown = false) {
  hook(core, id, 'UserPromptSubmit');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working).toBe(true);
  if (shown) await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
}

test('steer_ctrl_enter_now: Ctrl+Enter breaks the running turn (one Esc) and the text goes in once, now', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  await working(app, core, s.id, true);
  await ta.fill('do it differently');
  await ta.press('Control+Enter');
  // The Stop byte first (Claude Code's send-now interrupts the turn); the text waits behind the broken turn and goes in
  // once, when the agent is back at its prompt (look 11-17 N0, 607438fc2: Claude back at its box ends the turn).
  await expect.poll(() => reads(core, s.id).length).toBeGreaterThan(0);
  expect(reads(core, s.id)[0]).toBe('1b');
  await expect(ta).toHaveValue('');
  const text = Buffer.from('do it differently').toString('hex');
  await expect.poll(() => reads(core, s.id).filter((r) => r.includes(text)).length, { timeout: 15_000 }).toBe(1);
  expect(reads(core, s.id).filter((r) => r === '1b')).toHaveLength(1);
});

// Ticket 371 item 15: Enter now waits in the list; the row's button and Ctrl+Enter on an empty box replace the chip.
test('steer_default_queue: Enter while working waits in the list, and the row can send it now', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  await working(app, core, s.id, true);
  await ta.fill('next step please');
  await ta.press('Enter');
  const queued = app.locator('.composer .qrow');
  await expect(queued).toHaveCount(1);
  await app.waitForTimeout(400);
  expect(reads(core, s.id)).toEqual([]);
  await queued.getByRole('button', { name: '1 Send now', exact: true }).click();
  await expect.poll(() => reads(core, s.id).filter((r) => r === '1b').length).toBe(1);
  await expect(queued).toHaveCount(0);
  hook(core, s.id, 'Stop');
  const text = Buffer.from('next step please').toString('hex');
  await expect.poll(() => reads(core, s.id).filter((r) => r.includes(text)).length, { timeout: 15_000 }).toBe(1);
  // Ctrl+Enter with an empty box does what the row's button does: the top row goes in once, now.
  await working(app, core, s.id, true);
  await ta.fill('and then this');
  await ta.press('Enter');
  await expect(queued).toContainText('and then this');
  await expect(ta).toHaveValue('');
  await ta.press('Control+Enter');
  await expect.poll(() => reads(core, s.id).filter((r) => r === '1b').length).toBe(2);
  hook(core, s.id, 'Stop');
  const then = Buffer.from('and then this').toString('hex');
  await expect.poll(() => reads(core, s.id).filter((r) => r.includes(then)).length, { timeout: 15_000 }).toBe(1);
});

test('steer_refusal_keeps_the_text: a shell cannot be steered, so Ctrl+Enter says so and the text stays in the box', async ({ app, core }) => {
  const s = core.shell(core.project('sh-steer'), 'busy');
  await openWindow(app);
  await tab(app, s.id).click();
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const ta = app.locator('.composer textarea');
  await ta.fill('echo still here');
  await ta.press('Control+Enter');
  // The core's `no_interrupt:` refusal wrote nothing: the text goes back in the box, where Enter queues it.
  await expect(app.locator('.pane-status')).toContainText('This agent cannot take a message while it works');
  await expect(ta).toHaveValue('echo still here');
});

test('uncertain_send_is_not_retyped: a write the core says may have landed stays out of the box, with a note', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  // The core's `uncertain:` is the one refusal that may have typed the text already.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'send_text') return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'uncertain: the send may have gone in; it is not retyped' } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  // Ticket 371 item 15: only an idle send writes at once now; a queued row's `uncertain:` is in composer-queue.spec.ts.
  await expect(ta).toBeEnabled();
  await ta.fill('once only');
  await ta.press('Enter');
  await expect(ta).toHaveValue('');
  await expect(app.locator('.composer')).toContainText('Message may have been sent');
});

test('steer_lost_reply_gives_text_back: a steer whose reply never comes (socket drop) gives the text back, marked maybe sent', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  // Q9 tt-J22-1: the socket drops while steer_now is in flight; nothing says whether it went in.
  let dropped = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'steer_now' && !dropped) return ((dropped = true), ws.close());
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = app.locator('.composer textarea');
  await ta.fill('keep me');
  await ta.press('Control+Enter');
  await expect.poll(() => dropped).toBe(true);
  await expect(ta).toHaveValue('keep me');
  await expect(app.locator('.composer')).toContainText('Message may have been sent');
});

test('chord_reaches_no_terminal: with the terminal focused, neither key becomes a raw byte to the agent', async ({ app, core }) => {
  // v25-sendkeys preflight: the composer's exemption must not widen to xterm's hidden input, whose Enter xterm turns
  // into a bare CR for every modifier but Alt. The window's own handler may still run its command; nothing may be
  // written to the agent.
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  await app.getByRole('button', { name: 'Terminal' }).click();
  await app.locator(`.term[data-session="${s.id}"] .xterm-helper-textarea`).focus();
  await app.keyboard.press('Control+Enter');
  await app.keyboard.press('Meta+Enter');
  await app.waitForTimeout(500);
  expect(reads(core, s.id)).toEqual([]);
});

// v25-new-tab (ticket 290 item 2, needs 209): New session is the tab "+" popover; its first message is typed in the composer
// once the session is open, so the dialog's message box, its Cmd+Enter background start and its "Start in background" button
// are gone. These three specs followed that box; they now pin what remains (REPORT Dropped names the removed behaviour).
test('shell_takes_no_first_message: New terminal starts a shell and types nothing into it; the popover has no message box', async ({ app, core }) => {
  const project = core.project('sh-bg');
  const warm = core.shell(project, 'warm');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('New session');
  await app.keyboard.press('Enter');
  const dialog = app.getByRole('dialog', { name: 'New tab' });
  await expect(dialog.locator('textarea')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Start in background' })).toHaveCount(0);
  await dialog.getByRole('option', { name: 'New terminal' }).click();
  await expect(dialog).toHaveCount(0);
  const shells = (core.cli('snapshot', '--json').sessions as { id: string; kind: string; project: string }[]).filter((x) => x.kind === 'shell' && x.project === project);
  expect(shells.length, 'the shell started').toBe(2);
  const fresh = shells.find((x) => x.id !== warm.id)!;
  await app.waitForTimeout(600);
  // Only an Enter or typed text would show in its tty beyond the prompt; nothing was typed.
  expect(core.read(fresh.id)).not.toContain('write the tests first');
});

test('keys_listed: both keys on the Keys page under Chat composer, rebindable by pressing the new chord', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  // The model: each default is a real, resolvable chord, and nothing else claims them.
  expect(resolve(DEFAULT_BINDINGS, 'Control+Enter', false)).toEqual({ kind: 'command', id: 'composer.steerNow' });
  expect(resolve(DEFAULT_BINDINGS, 'Meta+Enter', false)).toEqual({ kind: 'command', id: 'composer.backgroundSend' });
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const views = app.locator('[data-keys-list] section[data-area="chat-composer"]'); // needs 166: one list, an area section each
  const steer = views.locator('[data-command="composer.steerNow"]'); // the commands' titles are the window's own
  const background = views.locator('[data-command="composer.backgroundSend"]');
  await expect(steer.locator('td').first().locator('.ktitle')).toHaveText('Send the composer’s text now (stops the running turn)'); // needs 192 (ticket 250 r3)
  await expect(background.locator('td').first()).toHaveText('Send as new session, stay here'); // retitled (needs 166): a different action from New session…
  await expect(steer.locator('td').nth(1)).toHaveText('⌃↵');
  await expect(background.locator('td').nth(1)).toHaveText('⌘↵');
  // Rebindable: Change, press another chord, Enter saves.
  await steer.getByRole('button', { name: 'Change Send the composer’s text now (stops the running turn)' }).click();
  await app.keyboard.press('Alt+Digit6');
  await app.keyboard.press('Enter');
  await expect(steer.locator('td').nth(1)).toHaveText('⌥6');
});

test('same_start_checks: the core refuses a start in a folder that is not there, and the popover says so and stays', async ({ app, core }) => {
  core.shell(core.project('probe'), 'alpha');
  await openWindow(app);
  const before = (core.cli('snapshot', '--json').sessions as unknown[]).length;
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('New session');
  await app.keyboard.press('Enter');
  const dialog = app.getByRole('dialog', { name: 'New tab' });
  // A folder that does not exist: the core's own launch check (`fs::canonicalize`, then `is_dir`) turns it down.
  await dialog.getByRole('combobox').fill(path.join(core.home, 'no-such-folder'));
  // Walk 11: the refusal comes right after the pick (the folder goes back to the one before), not at the agent's start.
  await dialog.getByRole('option', { name: /Start in folder/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('That file or folder is not there');
  expect((core.cli('snapshot', '--json').sessions as unknown[]).length).toBe(before);
});

test('background_send_keeps_view: the composer\'s own background send stays; the popover has no Cmd+Enter start of its own', async ({ app, core }) => {
  fakeClaude(core);
  const project = core.project('bg');
  const shown = core.shell(project, 'keep-me');
  await openWindow(app);
  await tab(app, shown.id).click();
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('New session');
  await app.keyboard.press('Enter');
  const dialog = app.getByRole('dialog', { name: 'New tab' });
  // Cmd+Enter in the popover's search starts nothing: no message, no background start.
  await dialog.getByRole('combobox').press('Meta+Enter');
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', shown.id);
  expect((core.cli('snapshot', '--json').sessions as { kind: string }[]).filter((s) => s.kind === 'claude')).toEqual([]);
});
