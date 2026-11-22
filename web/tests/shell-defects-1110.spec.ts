// Real-app check of 11-10, second pass (v32-shell-2): defects J (Hide left sidebar; its folded half replaced 11-21), M (a right-bar icon on a
// closed session's tab) and 5 (folder-trust prompt on its decision card).
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon } from './d5b';

const left = (app: Page) => app.getByRole('navigation', { name: 'Left bar' });
const right = (app: Page) => app.getByRole('navigation', { name: 'Right bar' });
const leftSidebar = (app: Page) => app.locator('.body > .sbar.l');
const rightSidebar = (app: Page) => app.locator('.body > .sbar.r');

/** The right sidebar as the user sees it: its widget, whether it is folded, and its drawn width. */
const rightState = (app: Page) =>
  rightSidebar(app).evaluate((e) => ({ widget: e.getAttribute('data-widget'), folded: e.hasAttribute('data-folded'), width: Math.round(e.getBoundingClientRect().width) }));

test('defect J: with the Tree open, one press of Hide left sidebar hides it and leaves the right sidebar alone; Show brings the Tree back open', async ({ app, core }) => {
  core.shell(core.project('demo'), 'sh1');
  await openWindow(app); // 1440 px: room for both sides
  await right(app).getByRole('button', { name: 'Diff' }).click();
  await expect(rightSidebar(app)).toHaveAttribute('data-widget', 'diff');
  const tree = left(app).getByRole('button', { name: 'Tree', exact: true });
  await expect(tree).toBeVisible();
  await expect(leftSidebar(app)).not.toHaveAttribute('data-folded');
  const before = await rightState(app);
  expect(before.folded).toBe(false);

  await left(app).getByRole('button', { name: 'Hide left sidebar' }).click();
  await expect(leftSidebar(app)).toHaveCount(0);
  await expect(left(app).getByRole('button', { name: 'Show left sidebar' })).toBeVisible();
  await expect(left(app).getByRole('button', { name: 'Hide left sidebar' })).toHaveCount(0);
  await expect.poll(() => rightState(app)).toEqual(before);

  await left(app).getByRole('button', { name: 'Show left sidebar' }).click();
  await expect(leftSidebar(app)).toHaveAttribute('data-widget', 'tree');
  await expect(left(app).getByRole('button', { name: 'Hide left sidebar' })).toBeVisible();
  await expect(tree).toBeVisible();
  await expect(leftSidebar(app)).not.toHaveAttribute('data-folded');
  await expect.poll(() => rightState(app)).toEqual(before);
});

// Owner 11-21 (lane w43-tree), replaces defect J's folded half ("Hide hides the folded Tree with no unfold first, Show
// brings it back folded"): a side folded away for a narrow window draws nothing, so at 1000 px the button did nothing one
// could see, twice. Its button reads "Show … sidebar" and every route (button, palette command, key) unfolds it, as its
// icon does; the other side gives its room and its own button then reads "Show" too.
const byButton = (app: Page) => left(app).getByRole('button', { name: 'Show left sidebar' }).click();
const byPalette = async (app: Page) => {
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.locator('.palette [data-command="sidebar.left.toggle"]').click();
};
const byKey = (app: Page) => app.keyboard.press('Meta+KeyB');
for (const [width, route, press] of [
  [900, 'button', byButton],
  [1000, 'button', byButton],
  [1200, 'button', byButton],
  [1000, 'palette command', byPalette],
  [1000, 'key (Cmd+B)', byKey],
] as const) {
  test(`folded_side_button_shows_it: at ${width} px with the Tree folded for the right sidebar, the left button reads Show and the ${route} unfolds the Tree; then the right button does the same`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'sh1');
    await app.setViewportSize({ width, height: 800 });
    await openWindow(app);
    await right(app).getByRole('button', { name: 'Diff' }).click();
    await expect(rightSidebar(app)).toHaveAttribute('data-widget', 'diff');
    await expect(leftSidebar(app)).toHaveAttribute('data-folded', '');
    await expect(left(app).getByRole('button', { name: 'Show left sidebar' })).toHaveAttribute('aria-expanded', 'false');
    await expect(left(app).getByRole('button', { name: 'Hide left sidebar' })).toHaveCount(0);
    await press(app);
    await expect(leftSidebar(app)).toHaveAttribute('data-widget', 'tree');
    await expect(leftSidebar(app)).not.toHaveAttribute('data-folded');
    await expect(leftSidebar(app)).toBeVisible();
    await expect(left(app).getByRole('button', { name: 'Hide left sidebar' })).toHaveAttribute('aria-expanded', 'true');
    // The right sidebar gave its room: the same rule on that side.
    await expect(rightSidebar(app)).toHaveAttribute('data-folded', '');
    const show = right(app).getByRole('button', { name: 'Show right sidebar' });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await show.click();
    await expect(rightSidebar(app)).not.toHaveAttribute('data-folded');
    await expect(rightSidebar(app)).toBeVisible();
    await expect(right(app).getByRole('button', { name: 'Hide right sidebar' })).toBeVisible();
    // A side that shows hides with one press, as before.
    await right(app).getByRole('button', { name: 'Hide right sidebar' }).click();
    await expect(rightSidebar(app)).toHaveCount(0);
  });
}

type Row = { id: string; state: string };
/** Every session the core has, with its state: a start, a replace or a removal changes this list. */
const rows = (core: { cli: (...a: string[]) => { sessions: Row[] } }) =>
  core
    .cli('snapshot', '--json')
    .sessions.map((r) => `${r.id}:${r.state}`)
    .sort();

for (const kind of ['agent', 'shell'] as const) {
  test(`defect M: with a closed ${kind} tab selected, no right-bar icon starts, replaces or removes a session; Terminal opens a new shell and leaves the closed one (ticket 1037)`, async ({ app, core }) => {
    const p = core.project('demo');
    const s = kind === 'agent' ? core.agent(p, 'alpha', 'never-created') : core.shell(p, 'alpha');
    await openWindow(app, {}, core);
    const tab = app.locator(`.tab[data-tab="${s.id}"]`);
    await tab.click();
    await expect(app.locator('.tabw', { hasText: 'alpha' }).locator('.tdot')).not.toHaveAttribute('data-s', 'done'); // running: the wait below is not vacuous
    core.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
    // The window has learned it ended (the state the icons read): its tab's dot reads done.
    await expect(app.locator('.tabw', { hasText: 'alpha' }).locator('.tdot')).toHaveAttribute('data-s', 'done');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const before = rows(core);
    for (const name of ['Board', 'Decisions', 'Browser', 'Diff', 'Artifacts']) {
      await icon(app, 'right', name).click();
      await app.waitForTimeout(400); // a start is a round trip to the core: give one the time to land before checking none did
      expect(rows(core), `after ${name}`).toEqual(before);
      await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      // Close what the icon opened, as the user would, so the next icon starts from the same window.
      if (name === 'Board') await app.keyboard.press('Escape');
      else if ((await icon(app, 'right', name).getAttribute('aria-pressed')) === 'true') await icon(app, 'right', name).click();
    }
    // Ticket 1037: Terminal opens a terminal, a new shell in the project; the closed session and its tab stay as they were.
    await icon(app, 'right', 'Terminal').click();
    await expect.poll(() => rows(core).length).toBe(before.length + 1);
    expect(rows(core).filter((r) => before.includes(r))).toEqual(before);
    await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
    await expect(tab).toHaveCount(1);
  });
}
