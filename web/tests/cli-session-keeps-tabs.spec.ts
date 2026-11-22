// Look 1117 v4f A S2-3: with 12 tabs open, a session started from the CLI (`nunchiro session start`) seemed to take the strip
// (only its tab and Room showed). The strip holds the shown project's tabs (ticket 570): a session started outside joins the
// strip of its project as a tab, the shown project and its tabs stay, and every tab stays reachable by its project.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const strip = (app: Page) => app.locator('.tabs .tab[data-tab]').evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-tab')));

test('cli_session_joins_its_project_strip (look 1117 v4f A S2-3)', async ({ app, core }) => {
  const demo = core.project('demo');
  const ids = Array.from({ length: 12 }, (_, i) => core.shell(demo, `sh-${i + 1}`).id);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${ids[5]}"]`).click();
  await expect.poll(() => strip(app)).toEqual(ids);
  // The same project: one more tab at the end, the shown tab unchanged.
  const same = core.shell(demo, 'from-cli');
  await expect.poll(() => strip(app)).toEqual([...ids, same.id]);
  await expect(app.locator(`.tab[data-tab="${ids[5]}"]`)).toHaveAttribute('aria-selected', 'true');
  // Another project (a worktree made outside the app is one): the strip and its shown tab stay.
  const other = core.shell(core.project('wt-t1'), 'wt-t1');
  await app.waitForTimeout(500);
  expect(await strip(app)).toEqual([...ids, same.id]);
  await expect(app.locator(`.tab[data-tab="${ids[5]}"]`)).toHaveAttribute('aria-selected', 'true');
  // Opening it shows its project's strip; the first project's row brings the 13 back, with the tab last shown there.
  await app.locator('.tree .row.wt2').filter({ hasText: 'wt-t1' }).first().click();
  await expect.poll(() => strip(app)).toEqual([other.id]);
  await app.locator(`.term[data-session="${other.id}"]`).click();
  await app.keyboard.press('Meta+KeyD');
  await app.getByRole('listbox', { name: 'Open in this split' }).getByRole('option', { name: /^Terminal new shell/ }).click();
  // The look's next step: the palette's "Close the focused split". The new shell has the focus, so the split closes.
  await expect(app.locator('[data-split-id] .term textarea')).toBeFocused();
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox').first().fill('Close the focused split');
  await expect(app.locator('#palette-list [data-command]').first()).toHaveAttribute('data-command', 'split.close');
  await app.keyboard.press('Enter');
  await expect(app.locator('[data-split-id]')).toHaveCount(0);
  expect(await strip(app)).toEqual([other.id]);
  await app.locator(`.row.head[data-project-path="${demo}"] b`).click();
  await expect.poll(() => strip(app)).toEqual([...ids, same.id]);
  await expect(app.locator(`.tab[data-tab="${ids[5]}"]`)).toHaveAttribute('aria-selected', 'true');
});
