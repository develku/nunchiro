// V2-9a status picker on prefix j: every project ignoring groups, in status order, each with its group dimmed.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { seed } from './tree-seed';

test('status_picker_orders_and_filters: lists every project in the settled order with its group, filters by group name, and prefix w still jumps', async ({ app, core }) => {
  const [w, quiet, other] = ['waiting', 'quiet', 'other'].map((n) => core.project(n));
  const wa = core.agent(w, 'w1', 'go');
  core.shell(quiet, 's1');
  core.shell(other, 's2');
  seed(core, { op: 'group_create', name: 'Web', project: w }, { op: 'group_create', name: 'Core', project: other });
  await openWindow(app);
  fs.writeFileSync(path.join(w, 'go'), '');
  await expect(app.locator('.pgrp[data-group="Web"]')).toHaveAttribute('data-urgency', 'waiting', { timeout: 5000 });
  await app.mouse.move(900, 400);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyJ');
  const picker = app.getByRole('dialog', { name: 'Projects by status' });
  await expect(picker).toBeVisible();
  const rows = picker.getByRole('option');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('waiting');
  await expect(rows.first().locator('.dim')).toHaveText('Web');
  // The other two are idle: last activity decides; the ungrouped one has no group text.
  const names = await rows.locator('span:not(.dim):not(.sr)').allTextContents();
  expect(names[0]).toBe('waiting');
  expect(await rows.evaluateAll((els) => els.map((e) => e.querySelector('.dim')?.textContent ?? null))).toContain(null);
  // Typing a group name filters to that group.
  await picker.getByRole('combobox').fill('Core');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('other');
  await app.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  // The picker does not take the waiting jump: prefix w still goes to the next waiting item.
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyW');
  await expect(app.locator(`.tab[data-tab="${wa.id}"]`)).toHaveAttribute('aria-selected', 'true');
  // Enter on a row opens that project's session.
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyJ');
  await picker.getByRole('combobox').fill('quiet');
  await app.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(app.locator('.tab[aria-selected="true"]')).not.toHaveAttribute('data-tab', wa.id);
});
