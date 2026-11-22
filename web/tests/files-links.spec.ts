// Ticket 375 (part A): a Markdown file's relative links, images and #anchors; the viewer's Wrap kept per tab; a Files
// row's menu hands its full path to Copy path, Reveal and Add to chat.
import fs from 'node:fs';
import path from 'node:path';
import { expect as plainExpect, test as plain } from '@playwright/test';
import { docPath, slug } from '../src/files/docLinks';
import { expect, test } from './fixtures';
import { openFile, row, setup, view } from './fixtures/files/harness';

plain('docPath: relative to the file, root-relative with /, never out of the root', () => {
  plainExpect(docPath('', 'docs/a.md')).toBe('docs/a.md');
  plainExpect(docPath('docs', './b.md')).toBe('docs/b.md');
  plainExpect(docPath('docs/x', '../a.md')).toBe('docs/a.md');
  plainExpect(docPath('docs', '/img/p.png')).toBe('img/p.png');
  plainExpect(docPath('docs', '../../etc/passwd')).toBeNull();
  plainExpect(docPath('', '..')).toBeNull();
  plainExpect(docPath('docs', '..')).toBeNull();
  plainExpect(docPath('', '')).toBeNull();
  plainExpect(slug('Set up: the  app!')).toBe('set-up-the--app');
  plainExpect(slug('설치 방법')).toBe('설치-방법');
});

test('files markdown: a relative link opens its file, a relative image shows, #anchor scrolls (ticket 375)', async ({ app, core }) => {
  const md = ['# Top', '', '[Setup link](#setup)', '', '[Other](docs/a.md)', '', '![dot](dot.png)', '', ...Array.from({ length: 80 }, (_, i) => `line ${i}`), '', '## Setup', '', 'here'].join('\n');
  await setup(app, core, {
    extra: (dir) => {
      // An absolute path inside the session folder (agents write these) maps to the same file.
      fs.writeFileSync(path.join(dir, 'GUIDE.md'), `${md}\n\n[Abs](${dir}/docs/a.md)\n`);
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'docs/a.md'), '# Page A\n');
    },
  });
  await openFile(app, 'GUIDE.md');
  const v = view(app, 'GUIDE.md');
  await expect(v.locator('.fv-md h2[data-anchor="setup"]')).toHaveCount(1);
  await v.getByRole('link', { name: 'Setup link' }).click();
  await expect.poll(() => v.locator('.fv-md h2[data-anchor="setup"]').evaluate((h) => { const r = h.getBoundingClientRect(); const b = h.closest('.fv-md')!.getBoundingClientRect(); return r.top >= b.top - 1 && r.top < b.bottom; })).toBe(true);
  await expect(v.locator('.fv-md img[src^="data:image/png"]')).toHaveCount(1);
  await v.getByRole('link', { name: 'Other' }).click();
  await expect(view(app, 'docs/a.md').locator('.fv-md h1')).toHaveText('Page A');
  await openFile(app, 'GUIDE.md');
  await expect(view(app, 'GUIDE.md').getByRole('link', { name: 'Abs' })).toHaveAttribute('data-file', 'docs/a.md');
});

test('files wrap: Wrap wraps long lines and stays on after the tab closes and reopens (ticket 375)', async ({ app, core }) => {
  await setup(app, core, { extra: (dir) => fs.writeFileSync(path.join(dir, 'long.json'), `{"k": "${'x'.repeat(4000)}"}\n`) });
  await openFile(app, 'long.json');
  const v = view(app, 'long.json');
  const wide = () => v.locator('.cm-scroller').evaluate((s) => s.scrollWidth > s.clientWidth + 1);
  await expect.poll(wide).toBe(true);
  await v.getByRole('button', { name: 'Wrap' }).click();
  await expect(v.getByRole('button', { name: 'Wrap' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(wide).toBe(false);
  await app.keyboard.press('Meta+w');
  await expect(view(app, 'long.json')).toHaveCount(0);
  await openFile(app, 'long.json');
  await expect(view(app, 'long.json').getByRole('button', { name: 'Wrap' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(wide).toBe(false);
  // Another file's tab keeps its own (off).
  await openFile(app, 'hello.ts');
  await expect(view(app, 'hello.ts').getByRole('button', { name: 'Wrap' })).toHaveAttribute('aria-pressed', 'false');
});

// Reveal runs only in the app (Tauri's opener); here it is checked as listed.
test('files row menu: Copy path copies the full path, Add to chat inserts @path (ticket 375)', async ({ app, core }) => {
  await app.addInitScript(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
  });
  const { dir } = await setup(app, core);
  await expect(row(app, 'hello.ts')).toHaveAttribute('data-menu-arg', /^\/.+\/hello\.ts$/);
  await row(app, 'hello.ts').click({ button: 'right' });
  const items = app.getByRole('menu').getByRole('menuitem');
  await expect(items.nth(0)).toHaveText(/Copy path/);
  await expect(items.nth(1)).toHaveText(/Reveal in Finder/);
  await expect(items.nth(2)).toHaveText(/Add to chat/);
  await items.nth(0).click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __clip: string[] }).__clip)).toEqual([path.join(dir, 'hello.ts')]);
  await row(app, 'hello.ts').click({ button: 'right' });
  await items.nth(2).click();
  await expect(app.locator('.cbox textarea').first()).toHaveValue(/@hello\.ts $/);
});
