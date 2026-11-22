// V2.5-54 A22 (needs 107, 178): the answer strip leaves the chat's centre column by default. The default layout has no
// `waiting` zone, an old stored layout loses a strip zone right above
// the composer once, and a strip the user places (`nunchiro layout add waiting`) is drawn and kept.
import fs from 'node:fs';
import { expect, openWindow, test } from './fixtures';
import { defaultLayout } from '../src/layout/model';
import { layoutFile, readLayout, zones } from './d5b';

const OLD = `version = 1
locked = false

[root]
id = "centre"
split = "column"

[[root.children]]
id = "terminal"
widgets = ["terminal"]

[[root.children]]
id = "waiting"
widgets = ["waiting"]

[[root.children]]
id = "composer"
widgets = ["composer"]
`;

test('default_layout_has_no_waiting_zone_in_centre', async ({ app }) => {
  expect(JSON.stringify(defaultLayout().root)).toBe(JSON.stringify({ id: 'centre', split: 'column', children: [{ id: 'terminal', widgets: ['terminal'] }, { id: 'composer', widgets: ['composer'] }] }));
  await openWindow(app);
  expect(await zones(app)).toEqual(['terminal', 'composer']);
});

test('stored_layout_waiting_above_composer_is_dropped_once', async ({ app, core }) => {
  // The fixture marks the step as done for every spec; clear it on the first load of this tab only (a reload keeps its mark).
  await app.addInitScript(() => {
    if (sessionStorage.getItem('first-load')) return;
    sessionStorage.setItem('first-load', '1');
    localStorage.removeItem('nunchiro.layout.strip-left-chat.v1');
  });
  fs.writeFileSync(layoutFile(core), OLD);
  await openWindow(app);
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  await expect.poll(() => readLayout(core)).not.toContain('widgets = ["waiting"]'); // the file itself was rewritten
  // A user who puts it back keeps it, across a reload.
  core.cli('layout', 'add', 'waiting');
  await expect.poll(() => zones(app)).toEqual(['terminal', 'composer', 'waiting']);
  await app.reload();
  await expect(app.locator('[data-zone-id="composer"]')).toBeVisible();
  expect(await zones(app)).toEqual(['terminal', 'composer', 'waiting']);
  expect(readLayout(core)).toContain('widgets = ["waiting"]');
});

test('answer_strip_still_reachable_when_placed_explicitly', async ({ app, core }) => {
  core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await expect(app.locator('#waiting-strip')).toHaveCount(0);
  core.cli('layout', 'add', 'waiting');
  await expect(app.locator('#waiting-strip')).toHaveCount(1);
  await expect(app.getByRole('region', { name: 'Answer strip' })).toHaveCount(1);
});
