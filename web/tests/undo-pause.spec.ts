// V2-6c follow-up (WCAG 2.2.1): the 10 s status-line Undo pauses while the pointer is over it or focus is inside it.
// Each test runs a real core with its own NUNCHIRO_HOME under .scratch. Time is a fake clock, never a real wait.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, agentsZone, type Core } from './fixtures';

const line = (p: Page) => p.locator('footer.status .undoline');
const undoButton = (p: Page) => line(p).getByRole('button', { name: 'Undo' });
const agentIds = (p: Page) => p.locator('.ar').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
const barState = (p: Page) => p.locator('footer.status .undobar').evaluate((el) => getComputedStyle(el, '::after').animationPlayState);
const away = (p: Page) => p.mouse.move(2, 2);
const undoKey = process.platform === 'darwin' ? 'Meta+KeyZ' : 'Control+KeyZ';

function doneSessions(core: Core) {
  const p = core.project('demo');
  const a = core.shell(p, 'a').id;
  const b = core.shell(p, 'b').id;
  const c = core.shell(p, 'c').id;
  core.cli('session', 'close', a);
  core.cli('session', 'close', b);
  return { a, b, c };
}

/** Opens the window with a fake clock and pushes one Undo entry ("Cleared 2 done sessions"). */
async function pending(app: Page, core: Core) {
  const { c } = doneSessions(core);
  await app.clock.install();
  await openWindow(app);
  await app.getByRole('button', { name: 'Clear done' }).click();
  await expect.poll(() => agentIds(app)).toEqual([c]);
  await expect(line(app)).toBeVisible();
  return c;
}

test('window_constant_single_source', () => {
  // The core exposes no CLOSE_UNDO_MS, so the page keeps one named copy; this fails when the two drift apart.
  const core = readFileSync('../crates/nunchiro-core/src/sessions.rs', 'utf8').match(/CLOSE_UNDO_MS: u64 = (\d+)_000;/);
  const web = readFileSync('src/Sidebar.tsx', 'utf8');
  const copy = web.match(/const CLOSE_UNDO_MS = (\d+)_000;/);
  expect(core, 'core CLOSE_UNDO_MS').not.toBeNull();
  expect(copy, 'Sidebar CLOSE_UNDO_MS').not.toBeNull();
  expect(copy![1]).toBe(core![1]);
  const deadline = web.split('\n').filter((l) => l.includes('const deadline'));
  expect(deadline).toHaveLength(1);
  expect(deadline[0]).toContain('Date.now() + CLOSE_UNDO_MS');
  expect(web.match(/10_000/g)).toHaveLength(1);
});

test.describe('undo pause', () => {
  test.beforeEach(({ core }) => agentsZone(core));

  test('undo_pauses_on_hover', async ({ app, core }) => {
    await pending(app, core);
    await expect.poll(() => barState(app)).toBe('running');
    await line(app).hover();
    await expect.poll(() => barState(app)).toBe('paused');
    await app.clock.fastForward(11_000);
    await expect(line(app)).toBeVisible();
    await expect(barState(app)).resolves.toBe('paused');
  });

  test('undo_pauses_on_focus', async ({ app, core, browserName }) => {
    await pending(app, core);
    await app.locator('footer.status').getByRole('button').first().focus();
    // Tab until the Undo button holds focus (the status bar buttons before it vary). WebKit's Tab skips buttons, as Safari's
    // does (ticket 531); since ticket 1031 the bar's usage button comes before Undo, so there is a button to pass.
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (let i = 0; i < 12 && !(await undoButton(app).evaluate((e) => e === document.activeElement)); i++) await app.keyboard.press(tab);
    await expect(undoButton(app)).toBeFocused();
    await expect.poll(() => barState(app)).toBe('paused');
    await app.clock.fastForward(11_000);
    await expect(line(app)).toBeVisible();
  });

  test('undo_resumes_on_leave', async ({ app, core }) => {
    await pending(app, core);
    await app.clock.fastForward(4_000);
    await line(app).hover();
    await app.clock.fastForward(30_000);
    await expect(line(app)).toBeVisible();
    await away(app);
    await expect.poll(() => barState(app)).toBe('running');
    await app.clock.fastForward(5_000); // 6 s were left
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(2_000);
    await expect(line(app)).toHaveCount(0);
  });

  test('undo_resumes_on_blur', async ({ app, core }) => {
    await pending(app, core);
    await app.clock.fastForward(4_000);
    await undoButton(app).focus();
    await app.clock.fastForward(30_000);
    await expect(line(app)).toBeVisible();
    await undoButton(app).blur();
    await app.clock.fastForward(5_000);
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(2_000);
    await expect(line(app)).toHaveCount(0);
  });

  test('undo_stays_paused_until_both_leave', async ({ app, core }) => {
    await pending(app, core);
    await line(app).hover();
    await undoButton(app).focus();
    await away(app);
    await app.clock.fastForward(30_000);
    await expect(line(app)).toBeVisible();
    await undoButton(app).blur();
    await app.clock.fastForward(11_000);
    await expect(line(app)).toHaveCount(0);
  });

  for (const mode of ['unpaused', 'hover', 'focus'] as const) {
    test(`undo_cmd_z_still_works_${mode}`, async ({ app, core }) => {
      await pending(app, core);
      if (mode === 'hover') await line(app).hover();
      if (mode === 'focus') await undoButton(app).focus();
      if (mode !== 'unpaused') {
        await app.clock.fastForward(11_000);
        await expect(line(app)).toBeVisible();
      }
      await app.keyboard.press(undoKey);
      await expect.poll(async () => (await agentIds(app)).length).toBe(3);
      await expect(line(app)).toHaveCount(0);
    });
  }

  test('newer_push_replaces_paused_entry', async ({ app, core }) => {
    const c = await pending(app, core);
    await expect(line(app)).toContainText('Cleared 2 done sessions');
    await line(app).hover();
    await app.clock.fastForward(20_000);
    // A second reversible action while paused: close the remaining session, then clear it.
    core.cli('session', 'close', c);
    await away(app);
    await app.getByRole('button', { name: 'Clear done' }).click();
    await expect(line(app)).toContainText('Cleared 1 done session');
    await app.clock.fastForward(9_000);
    await expect(line(app)).toBeVisible();
    await app.clock.fastForward(2_000);
    await expect(line(app)).toHaveCount(0);
  });

  // Round 2.
  test('close_undo_pause_respects_core_window', async ({ app, core }) => {
    const p = core.project('demo');
    const a = core.shell(p, 'lumen-api').id;
    core.cli('session', 'close', a);
    await app.clock.install();
    await openWindow(app);
    const row = app.locator('.arow').filter({ has: app.locator(`[data-agent="${a}"]`) });
    await row.hover();
    await row.getByRole('button', { name: 'Close lumen-api' }).click();
    await expect(line(app)).toContainText('Closed lumen-api');
    await line(app).hover();
    await app.clock.fastForward(9_000);
    await expect(line(app)).toBeVisible();
    // The core keeps the close for 10 s whatever the page does: past it the offer goes, even under the pointer.
    await app.clock.fastForward(2_000);
    await expect(line(app)).toHaveCount(0);
    await expect(app.locator('footer.status')).not.toContainText('Could not undo');
  });

  test('held_resets_after_line_clears', async ({ app, core }) => {
    const c = await pending(app, core);
    await line(app).hover();
    await app.keyboard.press(undoKey); // the line clears under the pointer: no pointerleave ever fires
    await expect(line(app)).toHaveCount(0);
    await away(app);
    core.cli('session', 'close', c);
    await expect.poll(async () => (await agentIds(app)).length).toBe(3);
    await app.getByRole('button', { name: 'Clear done' }).click();
    await expect(line(app)).toBeVisible();
    await undoButton(app).focus();
    await undoButton(app).blur();
    await app.clock.fastForward(11_000);
    await expect(line(app)).toHaveCount(0);
  });

  test('failed_line_stays_paused_while_hovered', async ({ app, core }) => {
    const p = core.project('demo');
    const a = core.shell(p, 'first').id;
    const b = core.shell(p, 'second').id;
    core.cli('session', 'close', a);
    core.cli('session', 'close', b);
    await app.clock.install();
    await openWindow(app);
    await expect.poll(async () => (await agentIds(app)).length).toBe(2);
    const row = app.locator('.arow').filter({ hasText: 'first' });
    await row.hover();
    await row.getByRole('button', { name: 'Close first' }).click();
    await expect(line(app)).toContainText('Closed first');
    core.cli('session', 'close', b); // a later close ends the pending one: the Undo for "first" is now refused
    await undoButton(app).hover();
    await undoButton(app).click();
    await expect(line(app)).toContainText('Could not undo');
    await app.clock.fastForward(30_000);
    await expect(line(app)).toContainText('Could not undo');
    await away(app);
    await app.clock.fastForward(11_000);
    await expect(line(app)).toHaveCount(0);
  });
});
