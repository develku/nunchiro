// Ticket 492: with the window in Korean, the main window's own words are Korean. Real core, a fake Claude session on a
// git project with one changed file; the scan walks every visible text node (and each visible placeholder) of the
// window and fails on an English word that is not a product name, a command or code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { english } from './fixtures/ui-scan';
import { ChatCore, expect, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';
import { ko as shell } from '../src/i18n/areas/shell';
import { ko as common } from '../src/i18n/areas/common';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

/** A Claude session on a git project whose first commit holds src/login.ts; the file changes once the session started. */
function session(core: ChatCore) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/login.ts'), "export const url = '/old';\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = core.chat('demo');
  fs.writeFileSync(path.join(dir, 'src/login.ts'), "export const url = '/session';\n");
  return s;
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `korean-main-window-${name}-${test.info().project.name}.png`) });

test('korean_main_window_has_no_english_text', async ({ page, chatCore }) => {
  const s = session(chatCore);
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${common['chrome.connected']}$`) })).toBeVisible();
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect(page.locator(`.chat[data-session="${s.id}"] .clist`)).toHaveAttribute('aria-busy', 'false');
  const bad: string[] = [];
  const scan = async (where: string) => bad.push(...(await english(page)).map((w) => `${where}: ${w}`));

  // Tree, tabs, status bar, composer (with its model and effort chips), title bar.
  await scan('window');

  // Diff, unified then split.
  const right = page.locator('nav[data-bar]'); // Diff sits on the right bar, Search on the left
  await right.getByRole('button', { name: shell['shell.widget.diff'], exact: true }).click();
  const dock = page.locator('aside.diff');
  await expect(dock.locator('[data-path="src/login.ts"]').first()).toBeVisible();
  await expect(dock.locator('.dsec, section[aria-label]').first()).toBeVisible();
  await scan('diff');
  await shot(page, 'diff');
  await dock.locator('.seg button').nth(1).click();
  await scan('diff split');
  await right.getByRole('button', { name: shell['shell.widget.diff'], exact: true }).click();

  // Search: Files, then Sessions.
  await right.getByRole('button', { name: shell['shell.widget.search'], exact: true }).click();
  const panel = page.locator('aside.spanel');
  await expect(panel).toBeVisible();
  await scan('search files');
  await panel.locator('.sscopes [role="radio"]').nth(1).click();
  await expect(panel.locator('.sfilt')).toBeVisible();
  await scan('search sessions');
  await shot(page, 'search');
  await right.getByRole('button', { name: shell['shell.widget.search'], exact: true }).click();

  // The palette.
  await page.keyboard.press('Meta+KeyK');
  await expect(page.locator('.palette, [role="dialog"]').first()).toBeVisible();
  await scan('palette');
  await page.keyboard.press('Escape');

  // A closed tab's toast, with its Undo.
  await page.locator(`.tab[data-tab="${s.id}"]`).hover();
  await page.locator('button.x:visible').first().click();
  await expect(page.locator('.undoline button')).toBeVisible();
  await scan('tab closed');

  // Ticket 508: layout edit mode with its widget library, then the Files sidebar.
  const lay = page.locator('nav[data-bar="right"] .lay');
  await lay.click();
  await expect(page.locator('.estrip')).toBeVisible();
  await expect(page.locator('.lib')).not.toHaveAttribute('aria-busy', 'true');
  await scan('layout edit');
  await shot(page, 'layout-edit');
  await lay.click();
  await expect(page.locator('.estrip')).toHaveCount(0);
  await page.locator('nav[data-bar="left"]').getByRole('button', { name: shell['shell.widget.files'], exact: true }).click();
  await expect(page.locator('aside.sbar[data-side="left"]')).toBeVisible();
  await scan('files');
  await shot(page, 'files');

  expect(bad).toEqual([]);
});
