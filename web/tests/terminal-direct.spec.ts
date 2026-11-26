// Type in terminal (mockup docs/design/draft-hold/index.html, panel 4): letters typed in a Claude or Codex terminal go to
// the session's composer while the agent's input box shows and nothing asks (the core's `at_box`); keys (arrows, Esc,
// Enter, Shift+Tab) still reach the agent. Type in terminal sends letters to the agent's box until Done, a blur or another
// session in front. A shell terminal sends everything. `at_box` is written into the core's snapshots here.
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';

type Snap = { id: string; at_box?: boolean };
async function wire(app: Page) {
  const sockets = new Map<object, () => void>();
  const w = { box: new Map<string, boolean>(), again: () => sockets.forEach((f) => f()) };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as { event?: string; sessions?: Snap[] };
      if (f.event !== 'snapshot') return ws.send(m);
      const replay = () => {
        const copy = JSON.parse(m) as { sessions?: Snap[] };
        for (const s of copy.sessions ?? []) if (w.box.has(s.id)) s.at_box = w.box.get(s.id);
        ws.send(JSON.stringify(copy));
      };
      sockets.set(ws, replay);
      replay();
    });
  });
  // Every request this window sends (terminal-options.spec.ts).
  await app.addInitScript(() => {
    const g = window as unknown as { __sent: { op: string; id?: string; text?: string; on?: boolean }[] };
    g.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const r = typeof data === 'string' ? JSON.parse(data).request : null;
        if (r) g.__sent.push(r);
      } catch {
        // Not JSON: not ours.
      }
      return send.call(this, data);
    };
  });
  return w;
}
const sent = (app: Page) => app.evaluate(() => (window as unknown as { __sent: { op: string; id?: string; text?: string; on?: boolean }[] }).__sent);
const typedIn = async (app: Page, id: string) => (await sent(app)).filter((r) => r.op === 'send_text' && r.id === id).map((r) => r.text ?? '');
const term = (app: Page, id: string) => app.locator(`.term[data-session="${id}"]`);

async function agent(app: Page, core: Core, box = true) {
  const w = await wire(app);
  const s = core.agent(core.project('p'), 'worker', 'x');
  w.box.set(s.id, box);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  // The agent's chat is in front; its terminal is the side pane's (the Right bar's Terminal, ⌘J).
  await expect(app.locator('.composer textarea')).toBeVisible();
  await app.keyboard.press('Meta+KeyJ');
  await expect(term(app, s.id).locator('.xterm-screen')).toBeVisible();
  w.again();
  return { w, s };
}

test('letters_go_to_the_composer: "re" typed in an agent terminal is in the composer; no send_text carried it', async ({ app, core }) => {
  const { s } = await agent(app, core);
  await term(app, s.id).locator('.xterm-screen').click();
  await app.keyboard.type('re');
  const box = app.locator('.composer textarea');
  await expect(box).toHaveValue('re');
  await expect(box).toBeFocused();
  await expect(term(app, s.id).locator('.tdir-line')).toHaveText('Typing goes to the composer.');
  expect((await typedIn(app, s.id)).filter((t) => /[re]/.test(t))).toEqual([]);
  await app.screenshot({ path: `../.scratch/shots/terminal-direct-note-${test.info().project.name}.png` });
});

test('an_ime_commit_goes_to_the_composer: a Korean commit lands in the composer as one piece', async ({ app, core }) => {
  const { s } = await agent(app, core);
  await term(app, s.id).locator('.xterm-screen').click();
  await term(app, s.id).locator('.xterm-helper-textarea').evaluate((el) => {
    // As WebKit ends a Hangul composition: compositionend with the syllables, then the input event.
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    (el as HTMLTextAreaElement).value = '한글';
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '한글' }));
  });
  await expect(app.locator('.composer textarea')).toHaveValue('한글');
  expect((await typedIn(app, s.id)).filter((t) => t.includes('한'))).toEqual([]);
});

test('keys_reach_the_agent: arrows, Esc, Enter and Shift+Tab are sent; letters with no input box are sent', async ({ app, core }) => {
  const { w, s } = await agent(app, core);
  const pty = term(app, s.id).locator('.xterm-helper-textarea');
  await term(app, s.id).locator('.xterm-screen').click();
  for (const key of ['ArrowUp', 'Escape', 'Enter', 'Shift+Tab']) await pty.press(key);
  await expect.poll(async () => (await typedIn(app, s.id)).join('|')).toMatch(/\x1b(\[|O)A\|\x1b\|\r\|\x1b\[Z/);
  // A dialog or a picker is up: no input box, so letters answer it in the terminal.
  w.box.set(s.id, false);
  w.again();
  await pty.focus();
  await pty.pressSequentially('2');
  await expect.poll(async () => (await typedIn(app, s.id)).includes('2')).toBe(true);
  await expect(app.locator('.composer textarea')).toHaveValue('');
});

test('type_in_terminal: on, letters reach the agent and the line shows; a blur turns it off', async ({ app, core }) => {
  const { s } = await agent(app, core);
  const t = term(app, s.id);
  await t.locator('.xterm-screen').hover();
  await t.getByRole('button', { name: 'Type in terminal' }).click();
  await expect(t).toHaveAttribute('data-direct', 'true');
  await expect(t.locator('.tdir-line')).toHaveText('Typing in terminal. Messages wait until you are done.');
  await app.screenshot({ path: `../.scratch/shots/terminal-direct-on-${test.info().project.name}.png` });
  await app.keyboard.type('xy');
  await expect.poll(async () => (await typedIn(app, s.id)).join('')).toContain('xy');
  expect((await sent(app)).filter((r) => r.op === 'direct' && r.id === s.id).map((r) => r.on)).toEqual([true]);
  await expect(app.locator('.composer textarea')).toHaveValue('');
  // Focus leaves the terminal: it is off, and the core is told.
  await app.locator('.composer textarea').focus();
  await expect(t).not.toHaveAttribute('data-direct', 'true');
  await expect.poll(async () => (await sent(app)).filter((r) => r.op === 'direct' && r.id === s.id).map((r) => r.on)).toEqual([true, false]);
  // Done turns it off too.
  await t.locator('.xterm-screen').click();
  await t.getByRole('button', { name: 'Type in terminal' }).click();
  await t.getByRole('button', { name: 'Done' }).click();
  await expect(t).not.toHaveAttribute('data-direct', 'true');
});

test('a_shell_sends_everything: letters typed in a shell terminal reach the shell', async ({ app, core }) => {
  const w = await wire(app);
  const s = core.shell(core.project('p'), 'sh', '/bin/sh', '-c', 'exec cat');
  w.box.set(s.id, true);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await term(app, s.id).locator('.xterm-screen').click();
  w.again();
  await app.keyboard.type('ls');
  await expect.poll(async () => (await typedIn(app, s.id)).join('')).toContain('ls');
  await expect(term(app, s.id).getByRole('button', { name: 'Type in terminal' })).toHaveCount(0);
});
