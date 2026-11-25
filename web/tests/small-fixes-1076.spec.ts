// Ticket 1076: four small faults from real use (the Team tab's close, text selected by a divider drag, the Decisions
// empty state's button, a click on the Settings gear that read as a drag).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { bar, drag, icon, layoutCli, sidebar, startEdit, toast } from './d5b';
import { openBoard, seed as seedBoard } from './fixtures/board/coord';
import { mates, sessions } from './leader-990';
import { seed } from './tree-seed';

const fake = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
const teamTab = (app: Page) => app.locator('[data-room-tab][data-team-tab]');

async function openTeamTab(app: Page) {
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('room');
  await app.locator('#palette-list [data-command="room.open"]').click();
  await expect(teamTab(app)).toHaveAttribute('aria-selected', 'true');
}

test('team_tab_closes_with_x_and_cmd_w_and_ends_no_session', async ({ app, core }) => {
  fake(core);
  const project = core.project('demo');
  core.shell(project, 'alpha');
  mates(core, [{ id: 'lead1', name: 'Main', project, lead: true }]);
  await openWindow(app);
  await openTeamTab(app);
  const x = app.locator('.tabw:has([data-team-tab]) > .x');
  await app.mouse.move(0, 0);
  await expect(x).toBeHidden();
  await teamTab(app).hover();
  await expect(x).toBeVisible();
  await x.click();
  await expect(teamTab(app)).toHaveCount(0);
  await openTeamTab(app);
  await app.mouse.move(0, 0);
  await teamTab(app).focus(); // keyboard focus on the tab shows it too
  await expect(x).toBeVisible();
  await app.keyboard.press('Meta+KeyW');
  await expect(teamTab(app)).toHaveCount(0);
  expect(sessions(core).filter((s) => s.state === 'running').length).toBeGreaterThan(0);
  expect(sessions(core).some((s) => s.state === 'closed' || s.state === 'exited')).toBe(false);
});

/** Drags a divider 60 px across text; the root has data-resizing meanwhile, nothing is selected, and the attribute goes after. */
async function dragDivider(app: Page, handle: Locator) {
  const b = (await handle.boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await app.mouse.move(x, y);
  await app.mouse.down();
  await app.mouse.move(x + 30, y + 40, { steps: 4 });
  await app.mouse.move(x + 60, y + 80, { steps: 4 });
  await expect(app.locator('html')).toHaveAttribute('data-resizing', '');
  expect(await app.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await app.mouse.up();
  await expect(app.locator('html')).not.toHaveAttribute('data-resizing', /.*/);
}

test('divider_drag_sets_and_clears_data_resizing', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await dragDivider(app, app.locator('.bdiv').first()); // the rail edge
  await dragDivider(app, sidebar(app, 'left').locator('.sdiv')); // the sidebar edge
  // A drag the window loses (blur, cancel) clears it too: one helper owns the attribute.
  const b = (await app.locator('.bdiv').first().boundingBox())!;
  await app.mouse.move(b.x + 2, b.y + 20);
  await app.mouse.down();
  await app.mouse.move(b.x + 20, b.y + 20, { steps: 3 });
  await expect(app.locator('html')).toHaveAttribute('data-resizing', '');
  await app.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(app.locator('html')).not.toHaveAttribute('data-resizing', /.*/);
  await app.mouse.up();
});

test('divider_drag_sets_and_clears_data_resizing_in_the_side_pane', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'a', 'never-created');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await dragDivider(app, app.locator('[data-pane-divider]'));
});

test('divider_drag_sets_and_clears_data_resizing_in_a_split', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'a', 'never-created');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const b = (await app.locator('[data-split-host]').boundingBox())!;
  await drag(app, icon(app, 'right', 'Diff'), { x: b.x + 30, y: b.y + b.height / 2 });
  await dragDivider(app, app.locator('[data-split-gutter]'));
});

test('divider_drag_sets_and_clears_data_resizing_in_the_layout', async ({ app, core }) => {
  await openWindow(app);
  await startEdit(app);
  await layoutCli(app, core, 'split right board --zone terminal');
  await dragDivider(app, app.locator('.gutter[data-split="row"]').first());
});

test('divider_drag_sets_and_clears_data_resizing_in_the_card_detail', async ({ app, core }) => {
  await app.addInitScript(() => localStorage.removeItem('nunchiro.test.board-mode'));
  seedBoard(core, [{ id: 'a', title: 'Alpha lane', column: 'todo' }]);
  await openBoard(app, core);
  await app.locator('.board .wcard', { hasText: 'Alpha lane' }).click();
  await expect(app.getByRole('complementary', { name: 'Card detail' })).toBeVisible();
  await expect.poll(() => app.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].filter((e) => e.style.viewTransitionName).length)).toBe(0); // the morph hides the page from a raw mouse
  await dragDivider(app, app.getByRole('separator', { name: 'Resize the card detail' }));
});

test('decisions_empty_state_has_no_button', async ({ app, core }) => {
  seed(core, { op: 'add', project: core.project('beta'), added: true });
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  const empty = sidebar(app, 'right').locator('.dw-empty');
  await expect(empty).toHaveText('Nothing waiting');
  await expect(empty.getByRole('button')).toHaveCount(0);
});

test('settings_gear_press_with_small_movement_is_a_click', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const gear = icon(app, 'left', 'Settings');
  const b = (await gear.boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await app.mouse.move(x, y);
  await app.mouse.down();
  await app.mouse.move(x + 3, y, { steps: 2 });
  await app.mouse.up();
  await expect(app.locator('.settings')).toBeVisible();
  await expect(toast(app)).toHaveCount(0);
  await app.keyboard.press('Escape');
  await expect(app.locator('.settings')).toHaveCount(0);
  // A real drag outside Layout: the hint, and nothing opens.
  const to = (await bar(app, 'right').boundingBox())!;
  await app.mouse.move(x, y);
  await app.mouse.down();
  await app.mouse.move(x + 12, y, { steps: 3 });
  await app.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 5 });
  await app.mouse.up();
  await expect(toast(app)).toContainText('Turn on Layout to move icons');
  await expect(app.locator('.settings')).toHaveCount(0);
});
