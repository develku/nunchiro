// Ticket 426: the right sidebar's resize handle reaches 7 px into its sidebar (sidebar-edge-hit.spec: the main zone's
// scrollbar keeps its pixels), and the Diff's 15 px "Note on line N" button lost its first 5 px to it. The sidebar's body
// is now inset by that reach: every pixel of the button answers as the button, its edge pixel opens the note, and the
// handle keeps its 8 px from the border and still drags.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openChat, test } from './fixtures/chat/harness';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

/** What answers a press at each x along one row: 'side' (a sidebar handle), 'note' (the Note button) or 'other'. */
const hits = (page: Page, xs: number[], y: number) =>
  page.evaluate(([xs, y]) => xs.map((x) => { const e = document.elementFromPoint(x, y); return e?.closest('.sdiv') ? 'side' : e?.closest('button.dplus') ? 'note' : 'other'; }), [xs, y] as const);
const span = (from: number, n: number) => Array.from({ length: n }, (_, i) => Math.round(from) + i);

test('note_edge: the Note button answers over its whole width, its edge pixel opens the note, and the sidebar handle still drags', async ({ page, chatCore }) => {
  const dir = chatCore.project('demo');
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/login.ts'), "export function login() {\n  const url = '/old';\n}\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = chatCore.chat('demo');
  fs.writeFileSync(path.join(dir, 'src/login.ts'), "export function login() {\n  const url = '/session';\n}\n");
  await openChat(page, s.id);
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true }).click();
  const side = page.getByRole('complementary', { name: 'Right sidebar' });
  await expect(side).toHaveAttribute('data-widget', 'diff');
  const row = page.getByRole('region', { name: 'Diff of src/login.ts' }).locator('tr.add').first();
  await row.hover();
  const plus = row.getByRole('button', { name: 'Note on line 2' });
  await expect(plus).toBeVisible();
  const b = (await plus.boundingBox())!;
  expect(Math.round(b.width)).toBe(15);
  const y = b.y + b.height / 2;
  // Every pixel of the button answers as the button; the handle's pixels lie wholly left of it.
  expect(await hits(page, span(b.x, 15), y)).toEqual(Array(15).fill('note'));
  const box = (await side.boundingBox())!;
  const left = Math.round(box.x);
  const xs = span(left - 4, Math.round(b.x) - left + 4);
  const got = await hits(page, xs, y);
  expect(got.filter((h) => h === 'side').length).toBeGreaterThanOrEqual(8); // the handle keeps its 8 px
  expect(xs[got.indexOf('side')]).toBe(left); // from the border
  expect(got).not.toContain('note');
  // A click on the button's first pixel opens the note.
  await page.mouse.click(Math.round(b.x), y);
  await expect(page.getByRole('textbox', { name: 'Note on src/login.ts line 2' })).toBeFocused();
  await page.keyboard.press('Escape');
  // The handle still drags: 60 px wider.
  const edge = page.getByRole('separator', { name: 'Resize the right sidebar' });
  const e = (await edge.boundingBox())!;
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2 - 60, e.y + e.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(Math.round((await side.boundingBox())!.width)).toBe(Math.round(box.width) + 60);
});
