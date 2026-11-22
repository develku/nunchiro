// V2.5-54 A11: the palette lists an exact or prefix session-name match first, then commands, then settings; every word of the
// query must match, and the toggling commands answer to toggle, show, hide and close.
import { expect, openWindow, test } from './fixtures';

const ids = (app: import('@playwright/test').Page) => app.locator('#palette-list [data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')!));

test('palette_session_name_prefix_ranks_before_settings', async ({ app, core }) => {
  core.shell(core.project('demo'), 'sidekick');
  await openWindow(app);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('side');
  await expect(app.locator('#palette-list [data-command]').first()).toBeVisible();
  const list = await ids(app);
  expect(list[0]).toMatch(/^session\.open\./);
  const firstSetting = list.findIndex((c) => c.startsWith('settings.'));
  const firstCommand = list.findIndex((c) => !c.startsWith('settings.') && !c.startsWith('session.open.'));
  expect(firstCommand).toBeGreaterThan(0);
  if (firstSetting >= 0) expect(firstCommand).toBeLessThan(firstSetting); // commands before settings
});

test('palette_toggle_sidebar_finds_sidebar_command', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  const search = app.getByRole('combobox', { name: 'Command palette search' });
  for (const q of ['toggle sidebar', 'hide sidebar', 'show sidebar']) {
    await search.fill(q);
    await expect(app.locator('#palette-list [data-command="sidebar.left.toggle"]')).toBeVisible();
  }
  await search.fill('close split');
  await expect(app.locator('#palette-list [data-command="split.close"]')).toBeVisible();
});

// Look 1117 v5 (A q10b-2): "Close session" typed whole put Close tab first (it carries "close session" as a synonym), so
// Enter closed the tab. A command whose own name is the query comes first.
test('palette_exact_name_ranks_first', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('Close session');
  await expect(app.locator('#palette-list [data-command="session.close"]')).toBeVisible();
  expect((await ids(app))[0]).toBe('session.close');
});

// Ninth look (A N-S3-2): "remove" put Close session and Close the focused split (keywords "remove session", "remove split")
// above Remove the project…; of rows that fit alike, the one whose own name holds the words comes first.
test('palette_own_name_beats_keyword_at_equal_fit', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('remove');
  await expect(app.locator('#palette-list [data-command="project.remove"]')).toBeVisible();
  const list = await ids(app);
  for (const id of ['session.close', 'split.close']) expect(list.indexOf('project.remove')).toBeLessThan(list.indexOf(id));
});
