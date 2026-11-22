// Ticket 517: the follow-up default. Queue (the default) keeps today's keys: Enter while the agent works waits in the list,
// the steer chord (Ctrl+Enter) sends now. Steer swaps the two while the agent works; an idle agent's Enter sends at once.
// A real core and a fake Claude (crates/nunchiro-core/tests/fixtures/claude-mode, which logs every stdin read as hex).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, showComposer, test } from './fixtures';

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
async function working(app: Page, core: Core, id: string) {
  hook(core, id, 'UserPromptSubmit');
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
}
const seed = (app: Page, followup: string) =>
  app.addInitScript((f) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'composer.followup': f } })), followup);
const hex = (s: string) => Buffer.from(s).toString('hex');
/** The Esc and each text that went in, in order (a text and its Enter may be one read or two). */
const written = (core: Core, id: string) =>
  reads(core, id).flatMap((r) => (r === '1b' ? ['1b'] : ['now please', 'wait for it'].filter((t) => r.includes(hex(t)))));
/** The key shown before `word` in the hint line. */
const keyFor = (app: Page, word: string) => app.locator('.composer .chint > span').filter({ hasText: new RegExp(`^\\S+ ${word}$`) }).locator('kbd');

async function start(app: Page, core: Core) {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  return { s, ta: app.locator('.composer textarea'), rows: app.locator('.composer .qrow') };
}

test('followup_queue_default: Enter while working waits in the list, the steer chord sends now', async ({ app, core }) => {
  const { s, ta, rows } = await start(app, core);
  await working(app, core, s.id);
  await ta.fill('wait for it');
  await ta.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(keyFor(app, 'send')).toHaveText('⏎');
  await expect(keyFor(app, 'Send now')).not.toHaveText('⏎');
  await expect(keyFor(app, 'queue')).toHaveCount(0);
  expect(reads(core, s.id)).toEqual([]);
  await ta.fill('now please');
  await ta.press('Control+Enter');
  // Look 11-17 N0 (607438fc2): Claude back at its box after the Esc ends the turn, so the steered text goes in at once,
  // then the waiting row: one Esc first, each text once, in that order.
  await expect.poll(() => written(core, s.id), { timeout: 15_000 }).toEqual(['1b', 'now please', 'wait for it']);
  await expect(rows).toHaveCount(0);
});

test('followup_steer: Enter while working sends now, the steer chord queues; an idle Enter sends at once', async ({ app, core }) => {
  await seed(app, 'steer');
  const { s, ta, rows } = await start(app, core);
  await working(app, core, s.id);
  await ta.fill('wait for it');
  await ta.press('Control+Enter');
  await expect(rows).toHaveCount(1);
  await expect(keyFor(app, 'Send now')).toHaveText('⏎');
  await expect(keyFor(app, 'queue')).not.toHaveText('⏎');
  await expect(keyFor(app, 'send')).toHaveCount(0);
  expect(reads(core, s.id)).toEqual([]);
  await ta.fill('now please');
  await ta.press('Enter');
  await expect(ta).toHaveValue('');
  // Look 11-17 N0 (607438fc2): the Esc ends the turn once Claude is back at its box: the steered text, then the queued row.
  await expect.poll(() => written(core, s.id), { timeout: 15_000 }).toEqual(['1b', 'now please', 'wait for it']);
  // Idle again, Enter sends at once with no Stop byte.
  hook(core, s.id, 'Stop');
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Send');
  await ta.fill('idle send');
  await ta.press('Enter');
  await expect.poll(() => reads(core, s.id).filter((r) => r.includes(hex('idle send'))).length, { timeout: 15_000 }).toBe(1);
  expect(reads(core, s.id).filter((r) => r === '1b')).toHaveLength(1);
});

test('followup_row_on_keyboard_page: the row stores Steer, says what the other key does, and resets to Queue', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app, {}, core);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  // The search finds the row and focuses its checked choice.
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('Follow-up');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: 'Follow-up · Keyboard' }).click();
  const group = app.getByRole('radiogroup', { name: 'Follow-up' });
  await expect(group.getByRole('radio', { name: 'Queue' })).toBeFocused();
  await expect(group.getByRole('radio', { name: 'Queue' })).toBeChecked();
  await expect(app.locator('.settings')).toContainText('sends that one message at once');
  await group.getByRole('radio', { name: 'Steer' }).check();
  await expect.poll(() => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features)).toEqual({ 'composer.followup': 'steer' });
  await expect(app.locator('.settings')).toContainText('adds that one message to the list instead');
});

// Review r1: the window's requests are recorded; `acp` relabels the session as an ACP agent in every snapshot frame (the
// core refuses send-now for ACP agents and shells, so on Steer their Enter must queue as on Queue).
async function wire(app: Page, acp = false) {
  const ops: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string') ops.push(JSON.parse(m).request?.op);
      server.send(m);
    });
    server.onMessage((raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (!acp || msg?.event !== 'snapshot') return ws.send(raw);
      for (const s of msg.sessions ?? []) Object.assign(s, { kind: 'acp', acp_agent: 'acme' });
      ws.send(JSON.stringify(msg));
    });
  });
  return ops;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('followup_steer_acp_queues: on Steer, a working ACP agent queues on Enter and the hint says send', async ({ app, core }) => {
  await seed(app, 'steer');
  const ops = await wire(app, true);
  const { s, ta, rows } = await start(app, core);
  await working(app, core, s.id);
  await ta.fill('later please');
  await ta.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(ta).toHaveValue('');
  await expect(keyFor(app, 'send')).toHaveText('⏎');
  expect(ops).not.toContain('steer_now');
});

test('followup_steer_send_path: on Steer, Enter with an image queues it with the image, and an empty box sends nothing', async ({ app, core }) => {
  await seed(app, 'steer');
  const ops = await wire(app);
  const { s, ta, rows } = await start(app, core);
  await working(app, core, s.id);
  await app.locator('.composer input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(app.locator('.composer img')).toHaveCount(1);
  await ta.fill('look at this');
  await ta.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(app.locator('.composer img')).toHaveCount(0);
  // An empty box: Enter neither steers the top row nor sends anything.
  await ta.press('Enter');
  await app.waitForTimeout(400);
  await expect(rows).toHaveCount(1);
  expect(ops).not.toContain('steer_now');
  expect(reads(core, s.id)).toEqual([]);
});

// Ticket 526: Enter steers only plain text, so with an image in the box the hint must say Enter queues.
test('followup_steer_hint_image: on Steer, with an image in the box the hint gives Enter to queue', async ({ app, core }) => {
  await seed(app, 'steer');
  const { s, ta, rows } = await start(app, core);
  await working(app, core, s.id);
  await ta.fill('wait for it');
  await ta.press('Control+Enter');
  await expect(rows).toHaveCount(1);
  await expect(keyFor(app, 'Send now')).toHaveText('⏎');
  await app.locator('.composer input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(app.locator('.composer img')).toHaveCount(1);
  await ta.fill('look at this');
  await expect(keyFor(app, 'Send now')).toHaveCount(0);
  await expect(keyFor(app, 'queue').first()).toHaveText('⏎');
});

// Ticket 533 item 1: a box with only spaces is an empty box, on both settings, under both keys, working or idle.
for (const followup of ['queue', 'steer']) {
  test(`followup_blank_sends_nothing_${followup}: only spaces neither queue nor send, working or idle`, async ({ app, core }) => {
    await seed(app, followup);
    const ops = await wire(app);
    const { s, ta, rows } = await start(app, core);
    await working(app, core, s.id);
    for (const key of ['Enter', 'Control+Enter']) {
      await ta.fill('   ');
      await ta.press(key);
    }
    await app.waitForTimeout(400);
    await expect(rows).toHaveCount(0);
    // Idle, Enter would write the spaces to the agent as a message.
    hook(core, s.id, 'Stop');
    await expect(app.locator('.composer .send')).toHaveAccessibleName('Send');
    await ta.fill('   ');
    await ta.press('Enter');
    await app.waitForTimeout(400);
    expect(ops).not.toContain('steer_now');
    expect(reads(core, s.id)).toEqual([]);
  });
}

// Ticket 533 review r1: a shell is no agent; spaces sent from its composer reach it (a prompt or a TUI may want them).
test('shell_composer_sends_spaces: a shell composer still writes text of only spaces', async ({ app, core }) => {
  const out = path.join(core.home, 'shell-in.txt');
  const sh = core.shell(core.project('p'), 'cat', '/bin/sh', '-c', 'exec cat > "$1"', 'sh', out);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${sh.id}"]`).click();
  await showComposer(app);
  await app.locator('.composer textarea').fill('   ');
  await app.locator('.composer textarea').press('Enter');
  await expect.poll(() => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''), { timeout: 10_000 }).toBe('   \n');
});
