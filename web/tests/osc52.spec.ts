// Ticket v1a-35: OSC 52 clipboard writes from terminal output (ask by default, allow, deny), never answered
// reads, never on replay; and copy on select (off by default). Clipboard permissions per engine (grantClipboard), real core.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { STORE_VERSION } from '../src/settings';
import { expect, grantClipboard, openWindow, test, type Core } from './fixtures';

// Waits until the window is attached (so the write is live output, not a replay), then writes.
const after = (seq: string) => `until [ -f attached ]; do sleep 0.05; done; printf '${seq}'; exec cat`;
const HI = '\\033]52;c;aGk=\\007';

async function start(app: Page, core: Core, script: string, settings: Record<string, unknown> = {}) {
  const dir = core.project('demo');
  const s = core.shell(dir, 'copier', '/bin/sh', '-c', script);
  await grantClipboard(app);
  if (Object.keys(settings).length) await app.addInitScript((s) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s)), settings);
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toBeVisible();
  await app.evaluate(() => navigator.clipboard.writeText('before'));
  fs.writeFileSync(`${dir}/attached`, '');
  return s;
}
const clip = (app: Page) => app.evaluate(() => navigator.clipboard.readText());
const prompt = (app: Page) => app.getByRole('group', { name: 'Clipboard request' });

test('osc52 ask (default): a prompt names the session and byte count, copies only on click', async ({ app, core }) => {
  const s = await start(app, core, after(HI));
  const p = prompt(app);
  await expect(p).toContainText('copier');
  await expect(p).toContainText('2 bytes');
  await expect(p).not.toContainText('hi');
  // The prompt never takes focus: a key typed into the terminal cannot press Copy.
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-helper-textarea`)).not.toBeFocused();
  expect(await clip(app)).toBe('before');
  await p.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => clip(app)).toBe('hi');
  await expect(p).toHaveCount(0);
});

test('osc52 ask: a second write while the prompt shows cannot swap the payload', async ({ app, core }) => {
  await start(app, core, after(`${HI}\\033]52;c;Ynll\\007`));
  const p = prompt(app);
  await expect(p).toContainText('2 bytes');
  await app.waitForTimeout(200);
  await p.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => clip(app)).toBe('hi');
});

test('osc52 ask: Dismiss drops the write', async ({ app, core }) => {
  await start(app, core, after(HI));
  await prompt(app).getByRole('button', { name: 'Dismiss' }).click();
  await expect(prompt(app)).toHaveCount(0);
  expect(await clip(app)).toBe('before');
});

test('osc52 deny never prompts or copies', async ({ app, core }) => {
  const s = await start(app, core, after(`${HI}\\n`), { osc52: 'deny' });
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toBeVisible();
  await app.waitForTimeout(500);
  await expect(prompt(app)).toHaveCount(0);
  expect(await clip(app)).toBe('before');
});

test('osc52 allow copies with no prompt', async ({ app, core }) => {
  await start(app, core, after(HI), { osc52: 'allow' });
  await expect.poll(() => clip(app)).toBe('hi');
  await expect(prompt(app)).toHaveCount(0);
});

// Lane w71: the holder writes each PTY size change into the output (ESC[8;rows;cols t). Inside a program's open OSC 52
// that ESC ended the sequence and the cut-off write ran (a 1.4 MB write over the cap was accepted as 66,816 bytes when a
// loaded window fitted late). The program here sends half its write and waits for the resize.
test('osc52_resize_inside_write: a resize while a write is open neither cuts nor drops it', async ({ app, core }) => {
  const script = `until [ -f attached ]; do sleep 0.05; done; s=$(stty size); printf 'ready\\033]52;c;aGkh'; until [ "$(stty size)" != "$s" ]; do sleep 0.05; done; printf 'Ynll\\007done\\n'; exec cat`;
  const s = await start(app, core, script, { osc52: 'allow' });
  const rows = app.locator(`.term[data-session="${s.id}"] .xterm-rows`);
  await expect(rows).toContainText('ready');
  await app.setViewportSize({ width: 1100, height: 700 });
  await expect(rows).toContainText('done');
  await expect.poll(() => clip(app)).toBe('hi!bye');
});

// The refusals happen in the escape parser, and xterm parses in order, so "the terminal has parsed `done`" (printed after
// them) says every one of them ran. Two things made the old wait fail (V2.5-67):
// 1. One 1.4 MB printf outruns a loaded window. The core keeps 1 MiB of replay per session; a window that falls further
//    behind is moved to the newest bytes, and Terminal.tsx then cuts to the next newline, which is after `done`: the screen
//    read "[earlier output trimmed]" and `done` never came (1 of 60 plain runs at 4 workers, 14 of 20 with the window stalled
//    6.5 s). That is the product working as
//    designed, so the script now sends the payload as 14 pieces of 100 KB, 0.2 s apart (the OSC stays one sequence
//    across them), and the test fails with the trim notice named if a window still falls behind.
// 2. expect's 5 s default is a guess at the drain time (0.8 s idle, 4.9 s with the page's CPU slowed 6x), so the wait is
//    bounded by the test's own 45 s limit.
// `slowPage` slows the page's CPU 6x from the start, the loaded window made on purpose.
async function refuses(app: Page, core: Core, osc52: string, slowPage = false) {
  // 14 x 100 KB of base64 decodes past the 1 MiB cap.
  const script = `until [ -f attached ]; do sleep 0.05; done; printf '\\033]52;c;?\\007\\033]52;c;!!notbase64\\007\\033]52;c;'; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do head -c 100000 /dev/zero | tr '\\0' A; sleep 0.2; done; printf '\\007done\\n'; exec cat`;
  if (slowPage) await (await app.context().newCDPSession(app)).send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const s = await start(app, core, script, { osc52 });
  const rows = app.locator(`.term[data-session="${s.id}"] .xterm-rows`);
  await expect(rows).toContainText(/done|earlier output trimmed/, { timeout: 0 });
  expect(await rows.innerText(), 'the window fell more than 1 MiB behind the burst and the core skipped ahead').not.toContain('earlier output trimmed');
  // React flushes a prompt before the next frame; two frames are the state wait for "nothing more is coming".
  await app.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(prompt(app)).toHaveCount(0);
  expect(await clip(app)).toBe('before');
  // `cat` would echo a reply as ^[]52 (the 1.4 MB log is too big to read back through the CLI).
  await expect(rows).not.toContainText(']52');
}

for (const osc52 of ['ask', 'allow', 'deny'])
  test(`osc52 ${osc52}: reads (?) get no reply; broken base64 and oversize writes are refused`, ({ app, core }) => refuses(app, core, osc52));

test('osc52_refuse_waits_on_state: a window with its CPU slowed 6x still sees every refusal', async ({ app, core, browserName }) => {
  test.skip(browserName !== 'chromium', 'CPU throttling is a Chromium (CDP) tool');
  await refuses(app, core, 'ask', true);
});

test('osc52 in a replay (reattach) never prompts or copies', async ({ app, core }) => {
  const s = await start(app, core, after(`${HI}done\\n`), { osc52: 'allow' });
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('done');
  await expect.poll(() => clip(app)).toBe('hi');
  await app.evaluate(() => navigator.clipboard.writeText('before'));
  await app.reload();
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('done');
  await app.waitForTimeout(500);
  expect(await clip(app)).toBe('before');
  await expect(prompt(app)).toHaveCount(0);
});

/** Centre of the first character of `text` on the terminal's screen (DOM renderer). */
async function cellOf(app: Page, id: string, text: string) {
  return app.evaluate(
    ([id, text]) => {
      const rows = document.querySelector(`.term[data-session="${id}"] .xterm-rows`)!;
      const walk = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.textContent!.indexOf(text);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      throw new Error(`${text} is not on screen`);
    },
    [id, text] as const,
  );
}

async function drag(app: Page, id: string) {
  const a = await cellOf(app, id, 'alpha');
  const b = await cellOf(app, id, 'omega');
  await app.mouse.move(a.x - 3, a.y);
  await app.mouse.down();
  await app.mouse.move(b.x + 30, b.y, { steps: 5 });
  await app.mouse.up();
}

// ticket 162: on by default now (settings-polish.spec clipboard_default_labelled); this starts from off.
test('copy on select: off copies nothing, on puts a drag selection on the clipboard', async ({ app, core }) => {
  // needs 150 (309459ab): a version-1 store's "off" is moved to on once; off picked on the current store stays off.
  const s = await start(app, core, after('alpha beta omega\\n'), { version: STORE_VERSION, copyOnSelect: false });
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('omega');
  await drag(app, s.id);
  await app.waitForTimeout(200);
  expect(await clip(app)).toBe('before');

  await app.keyboard.press('Meta+Comma');
  // needs 149/150 (309459ab): Settings opens on General; needs 192 (ticket 250): Copy on select lives on Terminal.
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  await app.getByRole('switch', { name: 'Copy on select' }).check();
  await app.keyboard.press('Escape'); // Settings is a modal (v25f): close it before the session tab
  await app.getByRole('tab', { name: /copier/ }).click();
  await drag(app, s.id);
  await expect.poll(() => clip(app)).toMatch(/^alpha beta omega/);
});
