// Ticket v1a-35: Cmd+click on terminal links. URLs (plain and OSC 8) open through openLink, never in the window;
// paths open the Files viewer for the session's root, confined by the core. The opener is stubbed.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { view } from './fixtures/files/harness';

const ESC = '\x1b';
const osc8 = (uri: string, text: string) => `${ESC}]8;;${uri}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

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

async function click(app: Page, id: string, text: string, meta: boolean) {
  const { x, y } = await cellOf(app, id, text);
  await app.mouse.move(x, y);
  await app.waitForTimeout(100);
  if (meta) await app.keyboard.down('Meta');
  await app.mouse.click(x, y);
  if (meta) await app.keyboard.up('Meta');
}

async function start(app: Page, core: Core, bytes: string, files?: (dir: string) => void) {
  const dir = core.project('links');
  files?.(dir);
  const s = core.replay(dir, 'links', bytes);
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (u?: string | URL) => (w.__opened.push(String(u)), null);
  });
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('end');
  return { dir, s };
}
const opened = (app: Page) => app.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test('links: Cmd+click opens an http(s) URL once; a plain click does nothing', async ({ app, core }) => {
  const { s } = await start(app, core, 'see https://example.com/x here\r\nend\r\n');
  await click(app, s.id, 'example.com/x', false);
  await app.waitForTimeout(200);
  expect(await opened(app)).toEqual([]);
  await click(app, s.id, 'example.com/x', true);
  await expect.poll(() => opened(app)).toEqual(['https://example.com/x']);
});

test('links: OSC 8 opens only http(s) targets, only with Cmd', async ({ app, core }) => {
  const bytes = `${osc8('https://example.com/docs', 'DOCS')}\r\n${osc8('file:///etc/passwd', 'FILE')}\r\n${osc8('javascript:alert(1)', 'SCRIPT')}\r\njavascript:alert(1)\r\nend\r\n`;
  const { s } = await start(app, core, bytes);
  app.on('dialog', (d) => void d.dismiss());
  let dialogs = 0;
  app.on('dialog', () => dialogs++);
  await click(app, s.id, 'DOCS', false);
  for (const t of ['FILE', 'SCRIPT', 'javascript:alert(1)']) await click(app, s.id, t, true);
  await app.waitForTimeout(200);
  expect(await opened(app)).toEqual([]);
  await click(app, s.id, 'DOCS', true);
  await expect.poll(() => opened(app)).toEqual(['https://example.com/docs']);
  // xterm's own handler would ask with a confirm() and then open inside the window.
  expect(dialogs).toBe(0);
});

test('links: Cmd+click on path:line opens the Files viewer at that line; a path out of the folder opens nothing outside', async ({ app, core }) => {
  const outside = path.join(core.home, 'p', 'secret.txt');
  const { s } = await start(app, core, 'error at src/main.rs:12 here\r\nand ../secret.txt:1 there\r\nend\r\n', (d) => {
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'src/main.rs'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
    fs.writeFileSync(outside, 'TOP SECRET');
  });
  await click(app, s.id, 'src/main.rs:12', false);
  await app.waitForTimeout(200);
  await expect(view(app, 'src/main.rs')).toHaveCount(0);
  await click(app, s.id, 'src/main.rs:12', true);
  await expect(view(app, 'src/main.rs').locator('.cm-target')).toHaveText('line 12');

  await app.getByRole('tab', { name: /links/ }).click();
  await click(app, s.id, '../secret.txt:1', true);
  const v = view(app, '../secret.txt');
  await expect(v).toHaveAttribute('data-view', 'error');
  await expect(v.getByRole('alert')).toContainText('path not allowed');
  await expect(app.getByText('TOP SECRET')).toHaveCount(0);
  expect(await opened(app)).toEqual([]);
});

// Ticket 371 item 50: a link that wraps across terminal rows is one link. The window is narrowed so a long link spans rows.
const narrow = (app: Page) => app.setViewportSize({ width: 760, height: 900 });

/** Centre of a cell near the start of the row `down` rows below the row holding `text`. */
async function rowPoint(app: Page, id: string, text: string, down: number) {
  const p = await app.evaluate(
    ([id, text, down]) => {
      const rows = [...document.querySelectorAll(`.term[data-session="${id}"] .xterm-rows > div`)];
      const i = rows.findIndex((r) => r.textContent!.includes(text as string));
      const b = rows[i + (down as number)]?.getBoundingClientRect();
      return i >= 0 && b ? { x: b.left + 40, y: b.top + b.height / 2 } : null;
    },
    [id, text, down] as const,
  );
  if (!p) throw new Error(`row ${down} below ${text} is not on screen`);
  return p;
}

async function metaClickAt(app: Page, { x, y }: { x: number; y: number }) {
  await app.mouse.move(x, y);
  await app.waitForTimeout(100);
  await app.keyboard.down('Meta');
  await app.mouse.click(x, y);
  await app.keyboard.up('Meta');
}

test('links_wrapped_url_opens_whole_from_its_second_row', async ({ app, core }) => {
  await narrow(app);
  const url = `https://example.com/${Array.from({ length: 90 }, (_, i) => `part${i}`).join('/')}`;
  const { s } = await start(app, core, `see ${url} done\r\nend\r\n`);
  await metaClickAt(app, await rowPoint(app, s.id, 'https://example.com', 1));
  await expect.poll(() => opened(app)).toEqual([url]);
});

test('links_wrapped_path_line_opens_the_file_at_that_line', async ({ app, core }) => {
  await narrow(app);
  const rel = `${Array.from({ length: 5 }, (_, i) => `folder${i}`.padEnd(40, 'x')).join('/')}/main.rs`;
  const { s } = await start(app, core, `error at ${rel}:12 here\r\nend\r\n`, (d) => {
    fs.mkdirSync(path.join(d, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
  });
  await metaClickAt(app, await rowPoint(app, s.id, 'error at', 1));
  await expect(view(app, rel).locator('.cm-target')).toHaveText('line 12');
});

test('links_a_line_past_the_caps_gives_no_link', async ({ app, core }) => {
  const { s } = await start(app, core, `https://example.com/${'a'.repeat(21_000)}\r\nend\r\n`);
  await metaClickAt(app, await rowPoint(app, s.id, 'aaaa', 0));
  await app.waitForTimeout(200);
  expect(await opened(app)).toEqual([]);
});

test('links_hover_stays_quick_on_a_long_line_inside_the_caps', async ({ app, core }) => {
  const { s } = await start(app, core, `${'a/'.repeat(9_500)}\r\nend\r\n`); // the path pattern's worst case, under 20,000 characters
  const { x, y } = await rowPoint(app, s.id, 'a/a/', 0);
  const before = Date.now();
  await app.mouse.move(x, y);
  await app.evaluate(() => 0);
  expect(Date.now() - before).toBeLessThan(400);
});
