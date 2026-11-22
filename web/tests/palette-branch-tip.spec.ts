// V2.5-56 follow-up: the palette row cuts a branch at 16ch; the house tooltip gives the full name on hover, only when cut.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK } from '../src/themes/nunchiro';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
const onBranch = (core: Core, p: string, branch: string, label: string) => {
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === branch)!;
  return core.cli('worktree', 'open', '--path', w.path, '--label', label, '--no-focus').session as { id: string };
};

test('palette_branch_tooltip_when_clipped', async ({ app, core }) => {
  const p = core.project('repo');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  const long = 'feature/a-very-long-branch-name-for-the-tip';
  const a = onBranch(core, p, long, 'long-one');
  const b = onBranch(core, p, 'dev', 'short-one');
  await openWindow(app);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  const tip = app.locator('#app-tip');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('long-one');
  await app.locator(`#palette-list [data-command="session.open.${a.id}"] .branch`).hover();
  await expect(tip).toHaveText(long);
  // A fresh palette: the list re-rendering under a still pointer is the Tooltip's own business, not this row's.
  await app.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('short-one');
  await app.locator(`#palette-list [data-command="session.open.${b.id}"] .branch`).hover();
  await app.waitForTimeout(600); // past HOVER_MS: a short branch is not cut, so nothing shows
  await expect(tip).toBeHidden();
});

// REPORT ## Shots: SHOTS_DIR=<dir> saves the palette with the long branch hovered in three themes (ANSI 1-4 and 9-12 set: the state dots read them).
const shotsDir = process.env.SHOTS_DIR;
const pick = (name: string, text: string) => ({ id: `imported:${name}`, name, colors: parseGhostty(text), source: `https://example.invalid/${encodeURIComponent(name)}` });
const SHOT_THEMES = [
  pick('Dracula', 'background = #282a36\nforeground = #f8f8f2\nselection-background = #44475a\npalette = 1=#ff5555\npalette = 2=#50fa7b\npalette = 3=#f1fa8c\npalette = 4=#bd93f9'),
  pick('Solarized Light', 'background = #fdf6e3\nforeground = #657b83\nselection-background = #eee8d5\npalette = 1=#dc322f\npalette = 2=#859900\npalette = 3=#b58900\npalette = 4=#268bd2'),
  DARK_PICK,
];
for (const t of SHOT_THEMES)
  test(`palette_branch_tooltip_shot: ${t.name}`, async ({ app, core }) => {
    const p = core.project('repo');
    git(p, 'init', '-q', '-b', 'main');
    git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
    const long = 'feature/a-very-long-branch-name-for-the-tip';
    const a = onBranch(core, p, long, 'long-one');
    await app.addInitScript((x) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: x })), t);
    await openWindow(app);
    await app.getByRole('button', { name: 'Open command palette' }).click();
    await app.getByRole('combobox', { name: 'Command palette search' }).fill('long-one');
    await app.locator(`#palette-list [data-command="session.open.${a.id}"] .branch`).hover();
    await expect(app.locator('#app-tip')).toHaveText(long);
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await app.screenshot({ path: path.join(shotsDir, `palette-branch-${t.name.replace(/\W+/g, '-')}.png`) });
  });
