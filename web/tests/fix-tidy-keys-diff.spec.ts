// FIDELITY bar (needs 130), rows 03/15/23 (Tidy), 04/20 (Keys), 11 (Diff) of the owner-check page
// .scratch/review-1028/owner-check-1030/index.html. Each test is one item of the brief and fails on origin/main.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { openQuiet } from './tree-seed';

const out = path.join(REPO, '.scratch/fix-tidy-keys-diff-d/shots');
const MOCKUPS = path.join(REPO, '.scratch');

/** The approved mockup's own frame, shot at the app's viewport, for the side-by-side page. */
async function mockupShot(app: Page, file: string, selector: string, name: string, scheme: 'light' | 'dark', open?: string) {
  if (!fs.existsSync(`${MOCKUPS}/${file}`)) return; // frame absent in this checkout: the app assertions above stay, the comparison shot is dropped
  const context = await app.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  try {
    const page = await context.newPage();
    await page.goto(`file://${MOCKUPS}/${file}`);
    await page.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
    // A frame the page draws only on request (frame-ko-e's temporary split): open it as the mockup's own control does.
    if (open) await page.locator(`[data-mk2="${open}"]`).click();
    await page.locator(selector).first().screenshot({ path: path.join(out, `${name}-mock-${scheme}.png`) });
  } finally {
    await context.close();
  }
}

test('tidy_dirty_rows_keep_a_disabled_checkbox so every name starts at the same x', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const git = (...args: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=[EMAIL]', ...args]);
  git('init', '-qb', 'main');
  git('commit', '-qm', 'init', '--allow-empty');
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'v2-undo', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'v2-undo')!;
  fs.writeFileSync(path.join(w.path, 'one.txt'), 'dirty');
  core.shell(p, 'main');
  openQuiet(core);
  await openWindow(app);
  await app.locator('.grp[data-project="nunchiro"] button.n').click({ button: 'right' });
  await app.getByRole('menuitem', { name: /Tidy worktrees/ }).click();
  const panel = app.getByRole('dialog', { name: /^Tidy/ });
  const boxes = panel.locator('li input[type=checkbox]');
  // One box per row, the dirty row's own box drawn but disabled and unchecked (the mockup's 결정 필요 rows).
  await expect(boxes).toHaveCount(1);
  await expect(boxes.first()).toBeDisabled();
  await expect(boxes.first()).not.toBeChecked();
  // The name starts where a checkable row's name starts: the box keeps its place in the row.
  const [box, name] = await Promise.all([boxes.first().boundingBox(), panel.locator('li .tn').first().boundingBox()]);
  expect(name!.x - (box!.x + box!.width)).toBeGreaterThan(4);
  fs.mkdirSync(out, { recursive: true });
  await panel.screenshot({ path: path.join(out, 'tidy-app-light.png') });
  await mockupShot(app, 'v2-drafts/ko/v2-8a-compare-r3.html', 'section[aria-labelledby="h-d3"] .dlg[aria-label^="정리 ·"]', 'tidy', 'light');
});

test('hints_alphabet_and_kind_keys_are_two_cards with the keyboard on the same screen', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'ux-fix-2');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard', exact: true }).click();
  await app.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  const hints = app.getByRole('region', { name: 'Hints', exact: true });
  // Two cards (the letter list, the kind keys), not one block: the mockup's 설정 › 키 › 힌트 columns.
  await expect(hints.getByRole('region', { name: /^(Hint keys|Kind keys)$/ })).toHaveCount(2); // needs 192 (ticket 250 r3): the draft's cards
  await app.locator('details.hk-adv > summary').click(); // final.html: the drawing is in the closed Advanced fold
  // The large keyboard is drawn inside the fold.
  await expect(hints.getByRole('group', { name: 'Keyboard', exact: true })).toBeVisible();
  fs.mkdirSync(out, { recursive: true });
  await hints.screenshot({ path: path.join(out, 'hints-app-light.png') });
  await mockupShot(app, 'review-1028/hints2-mockup.html', '.cols', 'hints', 'light');
});

test('diff_opens_on_the_first_file_patch, not only the file list', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const git = (...args: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=[EMAIL]', ...args]);
  git('init', '-qb', 'main');
  fs.writeFileSync(path.join(p, 'settings.ts'), 'row: 22,\n');
  git('add', '.'); git('commit', '-qm', 'before');
  core.shell(p, 'ux-fix-2');
  fs.writeFileSync(path.join(p, 'settings.ts'), 'row: 30,\n');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyD');
  await app.getByRole('listbox', { name: 'Open in this split' }).getByRole('option', { name: /^Diff/ }).click();
  // Opened, never clicked: the mockup's Diff pane shows the patch with no pick.
  const view = app.getByRole('region', { name: 'Diff of settings.ts' });
  await expect(view.locator('tr.add')).toContainText('row: 30,');
  await expect(app.getByRole('list', { name: 'Changed files' }).locator('[data-path="settings.ts"]')).toHaveAttribute('aria-pressed', 'true');
  fs.mkdirSync(out, { recursive: true });
  await app.screenshot({ path: path.join(out, 'diff-app-light.png') });
  await mockupShot(app, 'v2-drafts/ko/frame-ko-e.html', '#tmp', 'diff', 'light', 'diff');
});
