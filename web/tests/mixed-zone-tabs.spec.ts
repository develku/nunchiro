// Keyboard use of a mixed zone's tabs (Composer + Diff): Tab moves between them, Enter selects, Tab reaches the composer
// textarea and a draft survives a tab switch. Kept from the deleted board_hides_composer_only (v25f, D-20261108-10).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, showComposer, test } from './fixtures';

test('mixed_zone_tabs_keyboard_and_draft', async ({ app, core, browserName }) => {
  const tab = (back = false) => app.keyboard.press(`${back ? 'Shift+' : ''}${browserName === 'webkit' ? 'Alt+' : ''}Tab`);
  fs.copyFileSync(path.join(REPO, 'web/tests/fixtures/fidelity-board-mixed.toml'), path.join(core.home, 'layout.toml'));
  core.shell(core.project('mixed'), 'Mixed tabs');
  await openWindow(app);
  await showComposer(app, { focus: false }); // V2.5-34: a shell's composer is asked for
  const mixed = app.getByRole('tablist', { name: 'Zone Composer' });
  const composerTab = mixed.getByRole('tab', { name: 'Composer', exact: true });
  const diffTab = mixed.getByRole('tab', { name: 'Diff', exact: true });
  await expect(composerTab).toHaveAttribute('aria-selected', 'true');
  await composerTab.focus();
  await tab();
  await expect(diffTab).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(diffTab).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('[data-zone-id="composer"] [data-widget="diff"]')).toBeVisible();
  await tab(true);
  await expect(composerTab).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(composerTab).toHaveAttribute('aria-selected', 'true');
  await composerTab.focus();
  await tab();
  await tab();
  const input = app.locator('.composer textarea').first();
  await expect(input).toBeFocused();
  await input.fill('mixed tab draft');
  await diffTab.click();
  await composerTab.click();
  await expect(input).toHaveValue('mixed tab draft');
});
