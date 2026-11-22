// Ticket 216 (needs 178 B2, needs 172): a plain click on a terminal file path opens a popover (Open in Nunchiro, Open in
// editor (ticket 375), Copy path, Reveal in Finder), hovering it shows a hint, Cmd+click still opens the Files viewer. Nothing here reaches the
// system default app. Helpers are copied from terminal-links.spec.ts (v1a-35); the opener and window.open are stubbed.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { view } from './fixtures/files/harness';

/** Centre of the first character of `text` on the terminal's screen (DOM renderer). */
async function cellOf(app: Page, id: string, text: string) {
  const p = await app.evaluate(
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
      return null;
    },
    [id, text] as const,
  );
  if (!p) throw new Error(`${text} is not on screen`);
  return p;
}

async function hover(app: Page, id: string, text: string) {
  const { x, y } = await cellOf(app, id, text);
  await app.mouse.move(x - 20, y);
  await app.mouse.move(x, y);
  await app.waitForTimeout(100);
  return { x, y };
}

/** Hovers a path until xterm shows its link hint: under load the first move can land before the terminal's last layout
 *  or link pass, and a click then hits plain text. Each try measures the cell again and moves onto it again. */
async function hoverPath(app: Page, id: string, text: string) {
  let p = { x: 0, y: 0 };
  await expect.poll(async () => title(app, (p = await hover(app, id, text)).x, p.y)).toBe(HINT);
  return p;
}

async function click(app: Page, id: string, text: string, meta: boolean) {
  const { x, y } = await hoverPath(app, id, text);
  if (meta) await app.keyboard.down('Meta');
  await app.mouse.click(x, y);
  if (meta) await app.keyboard.up('Meta');
}

async function start(app: Page, core: Core, bytes: string, files?: (dir: string) => void) {
  const dir = core.project('paths');
  files?.(dir);
  const s = core.replay(dir, 'paths', bytes);
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: string[]; __clip: string[]; __revealed: string[] };
    w.__opened = [];
    w.__clip = [];
    w.__revealed = [];
    window.open = (u?: string | URL) => (w.__opened.push(String(u)), null);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
    (window as { __NUNCHIRO_FILES__?: unknown }).__NUNCHIRO_FILES__ = { reveal: (p: string) => w.__revealed.push(p) };
  });
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('end');
  return { dir, s };
}
const rec = (app: Page, key: '__opened' | '__clip' | '__revealed') => app.evaluate((k) => (window as unknown as Record<string, string[]>)[k], key);
const opened = (app: Page) => rec(app, '__opened');
const menu = (app: Page) => app.getByRole('menu');
const item = (app: Page, name: string) => menu(app).getByRole('menuitem', { name, exact: true });
const title = (app: Page, x: number, y: number) => app.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[title]')?.title ?? '', [x, y] as const);

const HINT = 'Click for actions, Cmd+click to open';
const SRC = 'error at src/main.rs:12 here\r\nsee https://example.com/x there\r\nand ../secret.txt:1 too\r\nend\r\n';
const lines40 = (d: string) => {
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/main.rs'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
};

test('terminal_path_hover_shows_hint', async ({ app, core }) => {
  const { s } = await start(app, core, SRC, lines40);
  const p = await hoverPath(app, s.id, 'src/main.rs:12');
  const u = await hover(app, s.id, 'example.com/x');
  expect(await title(app, u.x, u.y)).toBe('');
  const away = await cellOf(app, s.id, 'end');
  await app.mouse.move(away.x, away.y);
  await expect.poll(() => title(app, p.x, p.y)).toBe('');
});

test('terminal_path_click_popover_has_open_copy_reveal', async ({ app, core }) => {
  const abs = '/tmp/nunchiro-paths/notes.txt';
  const { s, dir } = await start(app, core, `${SRC.replace('end\r\n', '')}abs ${abs} x\r\nend\r\n`, lines40);
  await click(app, s.id, 'src/main.rs:12', false);
  await expect(menu(app)).toHaveCount(1);
  await expect(menu(app).getByRole('menuitem')).toHaveText(['Open in Nunchiro', 'Open in editor', 'Copy path', 'Reveal in Finder']);
  await expect(item(app, 'Open in Nunchiro')).toBeFocused();
  // Reveal is drawn disabled for a relative path and does nothing.
  await expect(item(app, 'Reveal in Finder')).toHaveAttribute('aria-disabled', 'true');
  await item(app, 'Reveal in Finder').click({ force: true }); // Playwright waits for "enabled", which it reads from aria-disabled
  await expect(menu(app)).toHaveCount(1);
  expect(await rec(app, '__revealed')).toEqual([]);
  // Copy path: no :line.
  await item(app, 'Copy path').click();
  await expect(menu(app)).toHaveCount(0);
  expect(await rec(app, '__clip')).toEqual(['src/main.rs']);
  // Ticket 375: Open in editor hands the core the file in this session's folder (no editor chosen: the default, no jump).
  await click(app, s.id, 'src/main.rs:12', false);
  await item(app, 'Open in editor').click();
  await expect.poll(() => core.opened()).toBe(`open\n-t\n${fs.realpathSync(dir)}/src/main.rs\n`);
  // With Cursor chosen in Settings the printed line goes along (as the window writes the setting).
  await app.evaluate(
    () =>
      new Promise<void>((ok) => {
        const n = (window as unknown as { __NUNCHIRO__: { port: number; token: string } }).__NUNCHIRO__;
        const ws = new WebSocket(`ws://127.0.0.1:${n.port}/ws`, ['nunchiro.v1', `nunchiro.token.${n.token}`]);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, request: { op: 'quit_settings', patch: { features: { 'editor.app': 'Cursor' } } } }));
        ws.onmessage = (e) => JSON.parse(e.data).id === 1 && (ws.close(), ok());
      }),
  );
  await click(app, s.id, 'src/main.rs:12', false);
  await item(app, 'Open in editor').click();
  await expect.poll(() => core.opened()).toContain(`\nopen\ncursor://file${fs.realpathSync(dir)}/src/main.rs:12\n`);
  // Open in Nunchiro: the Files viewer at line 12.
  await click(app, s.id, 'src/main.rs:12', false);
  await item(app, 'Open in Nunchiro').click();
  await expect(view(app, 'src/main.rs').locator('.cm-target')).toHaveText('line 12');
  // An absolute path: Reveal reaches the hook with that exact path.
  await app.getByRole('tab', { name: /paths/ }).click();
  await click(app, s.id, abs, false);
  await expect(item(app, 'Reveal in Finder')).not.toHaveAttribute('aria-disabled', 'true');
  await item(app, 'Reveal in Finder').click();
  expect(await rec(app, '__revealed')).toEqual([abs]);
});

test('terminal_path_popover_never_uses_default_app', async ({ app, core }) => {
  const abs = '/tmp/nunchiro-paths/notes.txt';
  const { s } = await start(app, core, `${SRC.replace('end\r\n', '')}abs ${abs} x\r\nend\r\n`, lines40);
  for (const [text, name] of [
    ['src/main.rs:12', 'Open in Nunchiro'],
    ['src/main.rs:12', 'Copy path'],
    [abs, 'Reveal in Finder'],
  ] as const) {
    await app.getByRole('tab', { name: /paths/ }).click();
    await click(app, s.id, text, false);
    await item(app, name).click();
  }
  await app.getByRole('tab', { name: /paths/ }).click();
  await click(app, s.id, 'src/main.rs:12', true);
  await app.waitForTimeout(200);
  expect(await opened(app)).toEqual([]);
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/terminal/path-actions.ts'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const word of ['openUrl', 'openPath', 'window.open', 'plugin-opener']) expect(code, word).not.toContain(word);
});

test('terminal_cmd_click_still_opens_in_nunchiro', async ({ app, core }) => {
  const outside = path.join(core.home, 'p', 'secret.txt');
  const { s } = await start(app, core, SRC, (d) => {
    lines40(d);
    fs.writeFileSync(outside, 'TOP SECRET');
  });
  await click(app, s.id, 'src/main.rs:12', true);
  await expect(view(app, 'src/main.rs').locator('.cm-target')).toHaveText('line 12');
  await expect(menu(app)).toHaveCount(0);
  await app.getByRole('tab', { name: /paths/ }).click();
  await click(app, s.id, '../secret.txt:1', true);
  const v = view(app, '../secret.txt');
  await expect(v).toHaveAttribute('data-view', 'error');
  await expect(v.getByRole('alert')).toContainText('path not allowed');
  await expect(menu(app)).toHaveCount(0);
});

test('terminal_path_popover_keyboard_and_dismiss', async ({ app, core }) => {
  const { s } = await start(app, core, SRC, lines40);
  const focused = () => app.evaluate(() => document.activeElement?.textContent ?? '');
  await click(app, s.id, 'src/main.rs:12', false);
  await expect(item(app, 'Open in Nunchiro')).toBeFocused();
  await app.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Open in editor');
  await app.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Copy path');
  await app.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Reveal in Finder');
  await app.keyboard.press('ArrowDown'); // wraps
  expect(await focused()).toBe('Open in Nunchiro');
  await app.keyboard.press('ArrowUp'); // wraps back
  expect(await focused()).toBe('Reveal in Finder');
  await app.keyboard.press('ArrowUp');
  expect(await focused()).toBe('Copy path');
  await app.keyboard.press('Enter');
  await expect(menu(app)).toHaveCount(0);
  expect(await rec(app, '__clip')).toEqual(['src/main.rs']);
  // Esc closes and the terminal has focus again.
  await click(app, s.id, 'src/main.rs:12', false);
  await expect(menu(app)).toHaveCount(1);
  await app.keyboard.press('Escape');
  await expect(menu(app)).toHaveCount(0);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-helper-textarea`)).toBeFocused();
  // Tab leaves the popover and closes it.
  await click(app, s.id, 'src/main.rs:12', false);
  await expect(menu(app)).toHaveCount(1);
  await app.keyboard.press('Tab');
  await expect(menu(app)).toHaveCount(0);
  // A click outside closes.
  await click(app, s.id, 'src/main.rs:12', false);
  await expect(menu(app)).toHaveCount(1);
  await app.mouse.click(5, 5);
  await expect(menu(app)).toHaveCount(0);
  // Only one at a time; it stays inside the window.
  await click(app, s.id, 'src/main.rs:12', false);
  await click(app, s.id, '../secret.txt:1', false);
  await expect(menu(app)).toHaveCount(1);
  const b = await menu(app).boundingBox();
  const vp = app.viewportSize()!;
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.y).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(vp.width);
  expect(b!.y + b!.height).toBeLessThanOrEqual(vp.height);
});
