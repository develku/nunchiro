// Ticket 821: ⌘P finds a file of the shown session's folder by part of its name (ignored files left out); Enter opens
// its file tab. The finder is rebindable and the palette lists it by its plain name.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const put = (dir: string, rel: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

function setup(core: Core, extra?: (p: string) => void) {
  const p = core.project('quick');
  execFileSync('git', ['init', '-q'], { cwd: p }); // its own repo: the checkout's .gitignore (.scratch) must not hide every file
  put(p, '.gitignore', 'dist/\n');
  put(p, 'dist/tree-bundle.js');
  put(p, 'src/tree/Tree.tsx', 'export const tree = 1;\n');
  put(p, 'src/tree/index.ts');
  put(p, 'src/subtree.ts');
  put(p, 'docs/treehouse.md');
  put(p, 'README.md');
  extra?.(p);
  return core.shell(p, 'quick');
}

const finder = (app: Page) => app.getByRole('dialog', { name: 'Go to file' });
const rows = (app: Page) => finder(app).getByRole('option');

test('quick_open_finds_by_name_and_opens_the_file_tab', async ({ app, core }) => {
  setup(core);
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyP');
  await expect(finder(app)).toBeVisible();
  await finder(app).getByRole('combobox').fill('tree');
  // The name itself first, then a name that starts with it, then one that holds it, then a match in the folder only.
  await expect.poll(() => rows(app).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['src/tree/Tree.tsx', 'docs/treehouse.md', 'src/subtree.ts', 'src/tree/index.ts']);
  // The ignored file holds the word in its name: only .gitignore keeps it out.
  await expect(finder(app).locator('[data-path="dist/tree-bundle.js"]')).toHaveCount(0);
  const dir = path.join(REPO, '.scratch/quick-open');
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) (await app.emulateMedia({ colorScheme: scheme }), await app.screenshot({ path: path.join(dir, `finder-${scheme}.png`) }));
  await finder(app).getByRole('combobox').press('Enter');
  await expect(finder(app)).toHaveCount(0);
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('Tree.tsx');
});

test('quick_open_no_match_names_the_next_action_and_esc_closes', async ({ app, core }) => {
  setup(core);
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyP');
  await expect(finder(app).getByRole('status')).toHaveText('Type part of a file name');
  await finder(app).getByRole('combobox').fill('zzz-none');
  await expect(finder(app).getByRole('status')).toHaveText('No file name has “zzz-none”. Search file text with ⇧⌘F');
  await app.keyboard.press('Escape');
  await expect(finder(app)).toHaveCount(0);
  // Round 2: ⌘K while the finder is open shows the palette in its place, never both stacked.
  await app.keyboard.press('Meta+KeyP');
  await expect(finder(app)).toBeVisible();
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expect(finder(app)).toHaveCount(0);
  await expect(app.locator('.palette')).toHaveCount(1);
});

test('quick_open_leaves_out_a_folder_whose_gitignore_is_skipped_and_says_so', async ({ app, core }) => {
  setup(core, (p) => (put(p, 'sub/keep-me.txt'), put(p, 'sub/.gitignore', Array.from({ length: 10_000 }, (_, i) => `pattern${i}/`).join('\n'))));
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyP');
  await finder(app).getByRole('combobox').fill('keep-me');
  await expect(finder(app).getByRole('note')).toHaveText('.gitignore over 64 KB not applied: sub/.gitignore');
  await expect(rows(app)).toHaveCount(0);
});

test('quick_open_is_in_the_palette_by_name_and_rebindable', async ({ app, core }) => {
  setup(core);
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: { 'files.quickOpen': ['Alt+Meta+KeyP'] } })));
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyP');
  await expect(finder(app)).toHaveCount(0);
  await app.keyboard.press('Alt+Meta+KeyP');
  await expect(finder(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('go to file');
  const first = app.locator('#palette-list [role="option"]').first();
  await expect(first).toHaveAttribute('data-command', 'files.quickOpen');
  await first.click();
  await expect(finder(app)).toBeVisible();
});
