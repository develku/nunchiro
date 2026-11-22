// Review round 2: terminal replies, bracketed paste, disconnected input, replay boundaries.
import { expect, openWindow, showComposer, test } from './fixtures';
import { layoutCli } from './d5b';

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
// Waits until the window is attached, then asks: OSC 11 (background colour, only xterm.js answers) and DA1
// (the core answers it; a second answer from the window would be stray input).
const ASK = "until [ -f attached ]; do sleep 0.05; done; printf '\\033]11;?\\007\\033[c'; exec cat";

test('the window answers queries the core does not, once, and never again on replay', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'asker', '/bin/sh', '-c', ASK);
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-rows`)).toBeVisible();
  (await import('node:fs')).writeFileSync(`${p}/attached`, '');
  // The tty echoes replies written to the PTY: ^[]11;rgb:… from xterm.js, ^[[?62;22c from the core only.
  await expect.poll(() => count(core.read(a.id), ']11;rgb:')).toBe(1);
  await expect.poll(() => count(core.read(a.id), '[?62;22c')).toBe(1);
  expect(core.read(a.id)).not.toContain('[?1;2c');
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.waitForTimeout(600);
  expect(count(core.read(a.id), ']11;rgb:')).toBe(1);
  expect(core.read(a.id)).not.toContain('[?1;2c');
});

test('pasted text cannot end the bracketed paste early', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'paster', '/bin/sh', '-c', "printf '\\033[?2004h'; exec cat");
  await openWindow(app);
  const box = app.locator('.cbox textarea');
  await expect.poll(() => app.evaluate((id) => document.querySelector(`.term[data-session="${id}"]`) !== null, a.id)).toBe(true);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await box.focus();
  await app.keyboard.insertText('before\x1b[201~after');
  await box.press('Enter');
  // The tty echoes ESC as ^[: exactly one end marker, the window's own.
  await expect.poll(() => core.read(a.id)).toContain('after');
  expect(count(core.read(a.id), '^[[201~')).toBe(1);
  expect(core.read(a.id)).toContain('beforeafter');
});

test('without a core connection input is refused visibly, not dropped silently', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'alpha');
  const b = core.shell(p, 'beta');
  await openWindow(app);
  await showComposer(app);
  // A lost core, not `serve stop`: stop ends every session first, and when that snapshot beats the socket close
  // (often under load) the terminals rightly unmount as exited, so there is no badge to see.
  core.proc.kill('SIGKILL');
  await expect(app.getByRole('status').filter({ hasText: 'Disconnected' })).toBeVisible();
  for (const s of [a, b]) await expect(app.locator(`.term[data-session="${s.id}"] .offline`)).toHaveText(/Input paused/);
  await expect(app.locator('.cbox textarea')).toBeDisabled();
  await app.getByRole('tab', { name: /beta/ }).click();
  await expect(app.locator(`.term[data-session="${b.id}"] .offline`)).toBeVisible();
  await showComposer(app);
  await expect(app.locator('.cbox textarea')).toBeDisabled();
});

test('a dropped connection pauses input until the window reconnects', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  let down = false;
  const live: { close: () => Promise<void> }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    if (down) return void ws.close();
    live.push(ws);
    ws.connectToServer();
  });
  await openWindow(app);
  await showComposer(app);
  down = true;
  await Promise.all(live.map((ws) => ws.close()));
  const badge = app.locator(`.term[data-session="${a.id}"] .offline`);
  await expect(badge).toBeVisible();
  await expect(app.locator('.cbox textarea')).toBeDisabled();
  down = false;
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(badge).toHaveCount(0);
  await expect(app.locator('.cbox textarea')).toBeEnabled();
});

test('a pinned composer aimed at a tab that was never shown still sends a bracketed paste', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'alpha');
  const b = core.shell(p, 'beta', '/bin/sh', '-c', "printf '\\033[?2004h'; exec cat");
  await openWindow(app);
  await app.locator('nav[data-bar="right"] .lay').click();
  // needs 153: the window has no ':' command line; `nunchiro layout` takes the same words.
  await layoutCli(app, core, 'pin beta --zone composer');
  await app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
  // beta's tab was never active: it has no xterm in the window.
  await expect(app.locator(`.term[data-session="${b.id}"] .xterm`)).toHaveCount(0);
  const box = app.locator('.composer[data-pinned] textarea');
  await box.fill('one\ntwo');
  await box.press('Enter');
  await expect.poll(() => core.read(b.id)).toContain('two');
  expect(core.read(b.id)).toContain('^[[200~one');
  expect(count(core.read(b.id), '^[[201~')).toBe(1);
});
