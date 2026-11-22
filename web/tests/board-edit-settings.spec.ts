// V2.5-38 (ticket 186, needs 154 item 12): board.toml `[settings]` from the edit panel through `board_settings_put`
// (real core): the stale badge threshold and the turn-end nudge, read back by the core into the snapshot.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { cardOf, openBoard, seed } from './fixtures/board/coord';
import { minutes } from '../src/board/model';

const toml = (core: Core) => path.join(core.home, 'board.toml');
async function panelOf(app: Page, core: Core) {
  const board = await openBoard(app, core);
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  return app.getByRole('dialog', { name: 'Edit board widget' });
}
async function setMinutes(app: Page, value: string) {
  const field = app.getByRole('dialog', { name: 'Edit board widget' }).getByLabel('stale badge threshold (min)');
  await field.fill(value);
  await field.press('Enter');
}

test('board_settings_stale_and_nudge: threshold 5 and nudge off land in board.toml [settings] and come back from the core', async ({ app, core }) => {
  const panel = await panelOf(app, core);
  await expect(panel.getByLabel('stale badge threshold (min)')).toHaveValue('10');
  const nudge = panel.getByRole('switch', { name: 'turn-end agent nudge' });
  await expect(nudge).toBeChecked();
  await setMinutes(app, '5');
  await expect.poll(() => (fs.existsSync(toml(core)) ? fs.readFileSync(toml(core), 'utf8') : '')).toContain('[settings]\nstale_minutes = 5\nturn_end_nudge = true\n');
  await nudge.click();
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('[settings]\nstale_minutes = 5\nturn_end_nudge = false\n');
  await expect(app.locator('.board .bstrip .bhint')).toHaveText('New cards land in To do · stale after 5 min');
  // A reload reads them from the core's snapshot.
  await app.reload();
  await app.locator('.board').getByRole('button', { name: 'Edit board widget' }).click();
  await expect(panel.getByLabel('stale badge threshold (min)')).toHaveValue('5');
  await expect(panel.getByRole('switch', { name: 'turn-end agent nudge' })).not.toBeChecked();
});

test('board_settings_stale_and_nudge edge: 0, 1441 and a non-number are refused with a line and write nothing', async ({ app, core }) => {
  const panel = await panelOf(app, core);
  await setMinutes(app, '12');
  await expect.poll(() => (fs.existsSync(toml(core)) ? fs.readFileSync(toml(core), 'utf8') : '')).toContain('stale_minutes = 12\n');
  const saved = fs.readFileSync(toml(core), 'utf8');
  for (const bad of ['0', '1441', 'ten', '5.5']) {
    await setMinutes(app, bad);
    await expect(panel.getByRole('alert')).toHaveText('1 to 1440 whole minutes');
    await expect(panel.getByLabel('stale badge threshold (min)')).toHaveAttribute('aria-invalid', 'true');
  }
  expect(fs.readFileSync(toml(core), 'utf8')).toBe(saved);
  // A good value clears the line.
  await setMinutes(app, '15');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('stale_minutes = 15\n');
});

test('board_settings_stale_and_nudge edge: a stale revision (another window saved first) is refused and writes nothing', async ({ app, core }) => {
  await panelOf(app, core);
  await setMinutes(app, '20');
  await expect.poll(() => (fs.existsSync(toml(core)) ? fs.readFileSync(toml(core), 'utf8') : '')).toContain('stale_minutes = 20');
  const other = await app.context().newPage();
  await other.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(other, {}, core);
  await other.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // v25f: each window opens its own Board modal
  await other.locator('.board').getByRole('button', { name: 'Edit board widget' }).click();
  const otherPanel = other.getByRole('dialog', { name: 'Edit board widget' });
  await otherPanel.getByLabel('stale badge threshold (min)').focus(); // holds its board (and revision)
  await setMinutes(app, '30');
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('stale_minutes = 30');
  const saved = fs.readFileSync(toml(core), 'utf8');
  await otherPanel.getByLabel('stale badge threshold (min)').fill('40');
  await otherPanel.getByLabel('stale badge threshold (min)').press('Enter');
  await expect(otherPanel.getByRole('alert')).toHaveText('board.toml was changed elsewhere and has been reloaded. Make your change again.');
  expect(fs.readFileSync(toml(core), 'utf8')).toBe(saved);
  await other.close();
});

test('board_stale_threshold_applies: with threshold 5 a card unmoved 6 min shows the stale badge, at 4 min none', async ({ app, core }) => {
  seed(core, [
    { id: 's6', title: 'Six minutes', column: 'working', moved: 6 },
    { id: 's4', title: 'Four minutes', column: 'working', moved: 4 },
  ]);
  fs.writeFileSync(toml(core), 'version = 2\n\n[[columns]]\nid = "todo"\ntitle = "To do"\n\n[[columns]]\nid = "working"\ntitle = "Working"\nstates = ["working"]\n\n[settings]\nstale_minutes = 5\n');
  await openBoard(app, core);
  await expect(cardOf(app, 'Six minutes').locator('.bstale')).toHaveAttribute('aria-label', 'stale 6 min');
  await expect(cardOf(app, 'Four minutes').locator('.bstale')).toHaveCount(0);
  await expect(app.locator('.board .bstrip .bhint')).toHaveText('New cards land in To do · stale after 5 min');
});

test('board_stale_threshold_applies edge: a board.toml without [settings] keeps the default 10 minutes and nudge on', async ({ app, core }) => {
  seed(core, [{ id: 's6', title: 'Six minutes', column: 'working', moved: 6 }]);
  const panel = await panelOf(app, core);
  await expect(cardOf(app, 'Six minutes')).toBeVisible();
  await expect(cardOf(app, 'Six minutes').locator('.bstale')).toHaveCount(0);
  await expect(app.locator('.board .bstrip .bhint')).toHaveText('New cards land in To do · stale after 10 min');
  await expect(panel.getByLabel('stale badge threshold (min)')).toHaveValue('10');
  await expect(panel.getByRole('switch', { name: 'turn-end agent nudge' })).toBeChecked();
});

test('board_settings_stale_and_nudge edge: the threshold takes whole minutes 1 to 1440 only (board/config.rs rule)', () => {
  for (const ok of ['1', '5', '10', '1440', ' 30 ']) expect(minutes(ok), ok).not.toBeNull();
  for (const bad of ['0', '1441', '', 'ten', '5.5', '-1', '1e2']) expect(minutes(bad), bad).toBeNull();
  expect(minutes('5')).toBe(5);
});
