// Ticket 485 (리뷰에서 남은 작은 끝 4개): a folded zone that holds several widgets names them with the window language's
// list separator, never an English " and ".
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';

// A side column of a Board zone over an Agents zone (foldable: it holds the Board), beside the session.
const SIDE_PAIR = `version = 1
locked = false

[root]
id = "main"
split = "row"

[[root.children]]
id = "side"
size = 560
split = "column"

[[root.children.children]]
id = "board"
widgets = ["board"]

[[root.children.children]]
id = "context"
widgets = ["context"]

[[root.children]]
id = "centre"
split = "column"

[[root.children.children]]
id = "terminal"
widgets = ["terminal"]

[[root.children.children]]
id = "composer"
widgets = ["composer"]
`;

test('fold_zone_names_in_language: a folded zone of two widgets joins their names with the catalogue separator', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'layout.toml'), SIDE_PAIR);
  core.shell(core.project('fold485'), 'narrow');
  await app.setViewportSize({ width: 1000, height: 700 });
  await openWindow(app, {}, core);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ja' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(app.locator('.term .xterm').first()).toBeVisible();
  // The newest panel never folds (fold.ts): a right sidebar opened now makes the side column the one to fold.
  await app.getByRole('navigation', { name: '右バー' }).getByRole('button', { name: '差分' }).click();
  const note = app.locator('.foldnote');
  await expect(note).toContainText('折りたたみました', { timeout: 5000 });
  await expect(note).toContainText('ボード', { timeout: 5000 });
  await expect(note).not.toContainText(' and ');
  await expect(note).toContainText('、');
  await expect(note).not.toContainText(/ため | を折/); // look 1117 v3: no space around the names inside Japanese text
});
