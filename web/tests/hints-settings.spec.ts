// ticket 93 (hints2 review SHOULDs, needs 118): the Settings preview string, the pane mark on the side pane, and the
// 2-click way to Keys > Hints. The gear label is pinned in keys.spec.ts.
import { stripOnTop, expect, openWindow, test } from './fixtures';
import { icon } from './d5b';

test.beforeEach(({ core }) => stripOnTop(core));

test('hints_settings_preview_string', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await app.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  const section = app.getByRole('region', { name: 'Hints' });
  const field = section.getByRole('textbox', { name: 'Hint alphabet' });
  const preview = section.getByRole('img', { name: /preview/i });
  const text = (kind: string) => preview.locator(`[data-hint-kind="${kind}"]`);
  // Ticket 389: the new default alphabet; projects and sessions read p1 s1 (a tab shares its session's), the bars and the
  // composer one key from their own keyboard regions.
  await expect(field).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890');
  await expect(text('project')).toHaveText(['p1', 'p2']);
  await expect(text('session')).toHaveText(['s1', 's2', 's3']);
  await expect(text('tab')).toHaveText(['s1', 's2', 's3']);
  await expect(text('left')).toHaveText(['a', 'd', 'f']);
  await expect(text('right')).toHaveText(['j', 'k', 'l']);
  await expect(text('other')).toHaveText(['z']);
  await field.fill('jkmnbvcxzqeya1234567890');
  await expect(field).toHaveValue('jkmnbvcxzqeya1234567890');
  // A custom alphabet: each region takes its own keys in the person's order, the rest spill to unused letters.
  await expect(text('project')).toHaveText(['p1', 'p2']);
  await expect(text('left')).toHaveText(['q', 'a', 'n']);
  await expect(text('right')).toHaveText(['j', 'k', 'b']);
  await expect(text('other')).toHaveText(['m']);
});

test('hints_side_pane_mark', async ({ app, core }) => {
  const a = core.agent(core.project('demo'), 'alpha', 'never-created', false);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  const side = app.locator('[data-side-pane]:not([hidden])');
  await expect(side).toBeVisible();
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  // Ticket 389: the side pane is not a target (a click there does nothing), even under Shift+W.
  await app.keyboard.press('Shift+KeyW');
  const box = (await side.boundingBox())!;
  const inside = await app.locator('.hint[data-hint-kind="pane"]').evaluateAll(
    (hs, b) => hs.filter((h) => { const r = h.getBoundingClientRect(); return r.left >= b.x - 1 && r.top >= b.y - 1 && r.left <= b.x + b.width && r.top <= b.y + b.height; }).length,
    box,
  );
  expect(inside).toBe(0);
});

test('hints_tab_reachable_in_2_clicks', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  let clicks = 0;
  const click = async (l: ReturnType<typeof app.locator>) => (clicks++, await l.click());
  // needs 192 (ticket 250, notes.md): hints have no nav entry; they are 2 clicks from the Settings sidebar, Keyboard then
  // the Options link on the hints row. Opening Settings is the visible control the count starts from.
  await app.locator('.ai.gear').click();
  await click(app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }));
  await click(app.getByRole('button', { name: 'Options ↓' }));
  await expect(app.getByRole('heading', { name: /^Hints/, level: 2 })).toBeFocused();
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeVisible();
  expect(clicks).toBe(2);
});
