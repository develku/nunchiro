// CHAT-MODELIST (ticket 285, needs 207): the composer's mode chip opens the list of every mode; one pick switches. A real
// core and a fake Claude whose Shift+Tab cycle follows its launch args (crates/nunchiro-core/tests/fixtures/claude-modes,
// which logs every stdin read). Every test starts at the visible, labelled chip.
import fs from 'node:fs';
import path from 'node:path';
import * as pc from '../src/chat/perm-chip'; // a namespace: a missing export fails its own test, not the file
import type { Session } from '../src/types';
import { gitRepo } from './decision-rows-seed';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

const PRESS = '1b5b5a';
function fakeClaude(core: Core) {
  const src = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-modes');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(src), { mode: 0o700 });
}
const start = (core: Core, project: string, label: string, ...args: string[]) =>
  core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', label, '--model', 'x', ...(args.length ? ['--', ...args] : [])).session as { id: string };
const startInWorktree = (core: Core, project: string, label: string, ...args: string[]) =>
  core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', label, '--model', 'x', '--worktree', '--', ...args).session as { id: string };
// The chip's data-mode is the observed footer; its text reads "Switching to …" while a walk runs.
const reads = (core: Core, id: string) =>
  fs.existsSync(path.join(core.home, `stdin-${id}.log`))
    ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8').split('\n').filter((l) => l.startsWith('READ ')).map((l) => l.slice(5))
    : [];
const sessionOf = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as (Session & { send_log: { sender: string; keys: string[] }[] })[]).find((x) => x.id === id)!;

test('mode_picker_opens_full_list: a session tab, then the chip (2 clicks) opens every mode with the current one marked', async ({ app, core }) => {
  fakeClaude(core);
  const s = start(core, core.project('p'), 'mode');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click(); // click 1
  const chip = app.locator('.composer .chips').getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  await chip.click(); // click 2
  const menu = app.getByRole('menu', { name: 'Permission modes' });
  await expect(menu.getByRole('menuitemradio')).toHaveText([/Normal/, /Accept edits/, /Plan/, /Auto/, /Bypass permissions/]);
  await expect(menu.getByRole('menuitemradio', { name: /Normal/ })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.locator('[aria-checked="true"]')).toHaveCount(1);
  // A CLI start has no launch flag: this session's cycle has no Skip permissions. Listed last, disabled, with what to do.
  const skip = menu.getByRole('menuitemradio', { name: /Bypass permissions/ });
  await expect(skip).toHaveAttribute('aria-disabled', 'true');
  await expect(menu).toContainText('Start a new session');
  await skip.click({ force: true }); // Playwright reads aria-disabled as not clickable; a real click is what a user makes
  await expect(menu).toBeVisible(); // a disabled row picks nothing and keeps the list open
  expect(reads(core, s.id)).toEqual([]);
  await expect(app.getByRole('button', { name: 'Permission mode' })).toHaveCount(1); // NODUP
});

test('mode_picker_one_pick_switches: one pick of Plan presses the needed Shift+Tabs one logged key at a time and stops at Plan', async ({ app, core }) => {
  fakeClaude(core);
  const s = start(core, core.project('p'), 'mode');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  await chip.click();
  await app.getByRole('menuitemradio', { name: /^Plan/ }).click();
  await expect(chip).toHaveAttribute('data-mode', 'plan');
  await expect(chip).toBeEnabled();
  await app.waitForTimeout(600); // a loop would have pressed on
  expect(reads(core, s.id)).toEqual([PRESS, PRESS]);
  expect(sessionOf(core, s.id).send_log.map((r) => [r.sender, r.keys])).toEqual([
    ['user', ['shift+tab']],
    ['user', ['shift+tab']],
  ]);
  await chip.click();
  await expect(app.getByRole('menuitemradio', { name: /^Plan/ })).toHaveAttribute('aria-checked', 'true');
});

test('mode_picker_keyboard: arrows move, Enter picks, Esc closes and returns focus to the chip without stopping the agent', async ({ app, core }) => {
  fakeClaude(core);
  const s = start(core, core.project('p'), 'mode');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  await chip.focus();
  await app.keyboard.press('Enter'); // the keyboard path opens it too
  const items = app.getByRole('menuitemradio');
  await expect(items.nth(0)).toBeFocused(); // the current mode
  await app.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('ArrowUp'); // wraps to the last
  await expect(items.nth(4)).toBeFocused();
  await app.keyboard.press('Home');
  await expect(items.nth(0)).toBeFocused();
  await app.keyboard.press('End');
  await app.keyboard.press('Home');
  await app.keyboard.press('Escape');
  await expect(app.getByRole('menu')).toHaveCount(0);
  await expect(chip).toBeFocused();
  await app.waitForTimeout(300);
  expect(reads(core, s.id)).toEqual([]); // Esc closed the list; it was not the composer's Stop key
  await app.keyboard.press('Enter');
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter'); // pick Accept edits
  await expect(chip).toHaveAttribute('data-mode', 'accept edits');
  expect(reads(core, s.id)).toEqual([PRESS]);
  await expect(chip).toBeFocused();
});

// skip_permissions_needs_confirm removed: owner 11-09 dropped the once-per-session confirm (ticket 362); `perm_chip.rs` pins the pick.

test('skip_permissions_chip_warns: in Skip permissions the chip and the tree row wear the warning token, with a mark that is not colour alone', async ({ app, core }) => {
  fakeClaude(core);
  // A worktree session has a tree row of its own (an idle main-folder session has none).
  const s = startInWorktree(core, gitRepo(core, 'repo'), 'mode', '--dangerously-skip-permissions'); // starts in it: no walk to wait for
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'bypass permissions');
  await expect(chip).toHaveClass(/skip/);
  const warn = await app.evaluate(() => {
    const probe = Object.assign(document.createElement('i'), { style: 'color:var(--warn)' });
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await chip.evaluate((el) => getComputedStyle(el).color)).toBe(warn);
  const mark = app.locator('.row.wt2[data-skip="true"] .skipm').first();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAccessibleName('Bypass permissions on');
  expect(await mark.evaluate((el) => getComputedStyle(el).color)).toBe(warn);
  // Look 1117 (S3): the row's own hover tip says what the "!" means (a child's title never shows over the row's tip).
  await expect(app.locator('.row.wt2[data-skip="true"] .tip').first()).toContainText('Bypass permissions on');
});

// The window's rules as pure functions: Bypass permissions is last and disabled without the launch flag or when Claude's settings turn it off.
const claude = (over: Partial<Session> = {}) => ({ kind: 'claude', state: 'running', pending: [], attention: { working: false }, permission_mode: 'manual', ...over }) as unknown as Session;
test('mode_rows_rules: order, current mark, disabled Bypass permissions and why', () => {
  const names = (s: Session) => pc.modeRows(s).map((r) => r.mode);
  expect(names(claude())).toEqual(['manual', 'accept edits', 'plan', 'auto', 'bypass permissions']);
  expect(pc.modeRows(claude({ permission_mode: 'plan' })).filter((r) => r.current).map((r) => r.mode)).toEqual(['plan']);
  expect(pc.modeRows(claude()).at(-1)?.disabled).toBe('mode.skipUnavailable');
  expect(pc.modeRows(claude({ mode_state: { skip: 'available' } })).at(-1)?.disabled).toBeUndefined();
  expect(pc.modeRows(claude({ mode_state: { skip: 'disabled' } })).at(-1)?.disabled).toBe('mode.skipDisabled');
  expect(pc.modeRows(claude({ mode_state: { skip: 'needs_setting' } })).at(-1)?.disabled).toBe('mode.skipSetting');
  expect(pc.modeRows(claude({ permission_mode: 'bypass permissions', mode_state: { skip: 'unavailable' } })).at(-1)?.disabled).toBeUndefined();
});

// Round 3 (security review MUST 1): the model chip waits while a mode walk runs (the core refuses the switch as well).
test('model_chip_is_disabled_during_a_walk: with the footer not moving the walk runs for seconds; the model chip says why and sends nothing', async ({ app, core }) => {
  fakeClaude(core);
  const project = core.project('p');
  const s = start(core, project, 'mode');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  fs.writeFileSync(path.join(project, 'stuck'), ''); // the fake ignores Shift+Tab: the walk waits for the footer
  await chip.click();
  await app.getByRole('menuitemradio', { name: /^Plan/ }).click();
  const model = app.locator('.composer .pk-chip[data-picker="model"]');
  await expect(model).toHaveAttribute('aria-disabled', 'true');
  await expect(model).toHaveAttribute('title', /mode change/);
  await model.click({ force: true });
  await expect(app.getByRole('menu', { name: /Model/ })).toHaveCount(0);
  // The walk gives up in a few seconds; the chip is usable again.
  await expect(model).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15000 });
  expect(reads(core, s.id)).toEqual([PRESS]);
});
