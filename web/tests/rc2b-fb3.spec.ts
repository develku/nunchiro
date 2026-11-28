// V2.5-41 rc2b-fb3 (needs 190 (2)) item 5: "브라우저 위젯을 클릭해도 아무것도 안뜨고" on the installed RC2b. The owner's layout.toml
// puts the terminal and the board in one zone with the board shown; the side pane lives in the terminal widget, so the
// Browser icon opened it behind the board tab: nothing visible, no toast. Repro on the real app: .scratch/fb3/probe2.py.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

/** The owner's layout.toml on the mini, 2026-11-03 13:11 (comments cut): Terminal and Board share the top zone, Board shown. */
const OWNER_LAYOUT = `version = 1
locked = false

[root]
id = "split"
split = "column"

[[root.children]]
id = "terminal"
widgets = ["terminal", "board"]
active = 1

[[root.children]]
id = "composer"
widgets = ["composer"]
`;

const rightIcon = (app: Page, name: string) => app.locator('.ib.r').getByRole('button', { name, exact: true });

test('browser_icon_opens_in_app: with the board shown in the terminal zone, the Browser icon shows the session Browser tab', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'layout.toml'), OWNER_LAYOUT);
  const project = core.project('demo');
  core.agent(project, 'alpha', 'never');
  await openWindow(app);
  await expect(app.getByRole('dialog', { name: 'Board' })).toBeVisible(); // the layout's centre Board migrates to the modal (v25f)
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await rightIcon(app, 'Browser').click();
  await expect(app.locator('.spane')).toBeVisible();
  await expect(app.locator('.spane input[placeholder="Search or URL"]')).toBeVisible();
});

test('terminal_icon_opens_behind_board: the Terminal icon on the same layout shows the side pane, not a hidden one', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'layout.toml'), OWNER_LAYOUT);
  const project = core.project('demo');
  core.agent(project, 'alpha', 'never');
  await openWindow(app);
  await expect(app.getByRole('dialog', { name: 'Board' })).toBeVisible();
  await app.keyboard.press('Escape'); // the migrated Board modal (v25f)
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await rightIcon(app, 'Terminal').click();
  await expect(app.locator('.spane')).toBeVisible();
});
