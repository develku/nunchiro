// Hint labels from a user alphabet and user kind keys (needs 118, ticket 75, ticket 389): the window half. The pure half is hint-alphabet.spec.ts.
import type { Page } from '@playwright/test';
import { agentsZone, expect, openWindow, test } from './fixtures';
import { openQuiet } from './tree-seed';

test.beforeEach(({ core }) => agentsZone(core)); // the session rows sit in an AGENTS zone, which the default window no longer shows

/** A keydown as the system delivers it: the physical code with a key value that is not the glyph (Hangul, Colemak, Dvorak). */
const typeCode = (page: Page, code: string, key = 'ㅁ') =>
  page.evaluate(([c, k]) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: c, key: k, keyCode: 229 })), [code, key]);

const hints = async (page: Page) => {
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('KeyF');
  await expect(page.locator('.hint').first()).toBeVisible();
};
/** A label's keys as QWERTY codes (Playwright presses a code with its US letter, so the typed letter matches). */
const codesOf = async (page: Page, selector: string, n = 0) => (await page.locator(selector).nth(n).getAttribute('data-keys'))!.split(' ').map((k) => (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`));
const openHintsSettings = async (page: Page) => {
  await page.keyboard.press('Meta+Comma');
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await page.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  return page.getByRole('region', { name: 'Hints' });
};

const demo = (core: Parameters<typeof agentsZone>[0]) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  openQuiet(core); // V2-9a: quiet projects start folded; the project row is a target either way
  return ids;
};

test('alphabet_label_picks_any_target', async ({ app, core }) => {
  const ids = demo(core);
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(3);
  // A tab, a session and a project, each by its own label with no kind key typed first.
  await hints(app);
  for (const code of await codesOf(app, '.hint[data-hint-kind="tab"]', 2)) await app.keyboard.press(code);
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${ids[2]}"]`)).toHaveAttribute('aria-selected', 'true');
  await hints(app);
  for (const code of await codesOf(app, '.hint[data-hint-kind="session"]', 0)) await app.keyboard.press(code);
  await expect(app.locator(`.tab[data-tab="${ids[0]}"]`)).toHaveAttribute('aria-selected', 'true');
  await hints(app);
  const head = app.locator('[data-hint-kind="project"]').first();
  for (const code of await codesOf(app, '.hint[data-hint-kind="project"]', 0)) await app.keyboard.press(code);
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(head).toBeFocused();
});

test('kind_key_filters_and_relabels and backspace_undoes_escape_cancels', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  await hints(app);
  const all = await app.locator('.hint').count();
  // Ticket 389: Shift + a kind key filters, relabelling that kind from the first key.
  await app.keyboard.press('Shift+KeyT');
  await expect(app.locator('.hint')).toHaveCount(3);
  await expect(app.locator('.hint[data-hint-kind="tab"]')).toHaveText(['a', 'd', 'f']);
  await app.keyboard.press('Backspace');
  await expect(app.locator('.hint')).toHaveCount(all);
  // The s prefix keeps every label in place (no renumbering), dims the rest; Backspace undoes it.
  await app.keyboard.press('KeyS');
  await expect(app.locator('.hint')).toHaveCount(all);
  // The tabs and their AGENTS rows share labels: every bright one is a session label.
  await expect(app.locator('.hint:not([data-dim])').first()).toHaveText('s1');
  expect(new Set(await app.locator('.hint:not([data-dim])').allTextContents())).toEqual(new Set(['s1', 's2', 's3']));
  await app.keyboard.press('Backspace');
  await expect(app.locator('.hint[data-dim]')).toHaveCount(0);
  await app.keyboard.press('KeyS');
  await app.keyboard.press('Escape');
  await expect(app.locator('.hint')).toHaveCount(0);
  // A kind key with no target (no hash in the window) is ignored; the hints stay.
  await hints(app);
  await app.keyboard.press('Shift+KeyH');
  await expect(app.locator('.hint')).toHaveCount(all);
});

test('single_target_kind_by_key_alone', async ({ app, core }) => {
  core.shell(core.project('only'), 'one');
  openQuiet(core);
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(1);
  await hints(app);
  await expect(app.locator('.hint[data-hint-kind="project"]')).toHaveText(['p1']);
  // Ticket 389: one project still reads p1, so p alone never acts; p then 1 does.
  await app.keyboard.press('KeyP');
  await expect(app.locator('.hint:not([data-dim])')).toHaveText(['p1']);
  await app.keyboard.press('Digit1');
  await expect(app.locator('.hint')).toHaveCount(0);
  // Shift + a kind key with one target picks it.
  await hints(app);
  await app.keyboard.press('Shift+KeyT');
  await expect(app.locator('.hint')).toHaveCount(0);
});

test('pane_labels_cover_every_pane', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  // The hook splits will use: any element carrying data-hint-kind="pane".
  await app.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'fixture-split';
    d.setAttribute('data-hint-kind', 'pane');
    d.style.cssText = 'position:fixed;right:80px;bottom:80px;width:120px;height:60px;background:#888;z-index:50';
    document.body.append(d);
  });
  const panes = await app.locator('[data-hint-kind="pane"]:not([hidden])').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 2 && e.getBoundingClientRect().height > 2).length);
  expect(panes).toBeGreaterThan(2);
  await hints(app);
  // Ticket 389: panes are quiet, labelled only under Shift+W.
  await expect(app.locator('.hint[data-hint-kind="pane"]')).toHaveCount(0);
  await app.keyboard.press('Shift+KeyW');
  await expect(app.locator('.hint')).toHaveCount(panes);
  await expect(app.locator('.hint[data-hint-kind="pane"]')).toHaveCount(panes);
  // The fixture's own label opens nothing but is a target of kind w.
  const box = await app.locator('#fixture-split').boundingBox();
  const mine = await app.locator('.hint').evaluateAll((hs, b) => hs.filter((h) => Math.abs(h.getBoundingClientRect().left - b!.x) < 130 && Math.abs(h.getBoundingClientRect().top - b!.y) < 70).length, box);
  expect(mine).toBe(1);
});

test('icons_grouped_by_bar in the window', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  const bar = (side: string) => app.locator(`[data-hint-kind="${side}"][data-hint-icon]`);
  await expect(bar('left')).toHaveCount(await app.locator('nav[aria-label="Left bar"] [data-hint-icon]').count());
  await expect(bar('right')).toHaveCount(await app.locator('nav[aria-label="Right bar"] [data-hint-icon]').count());
  await hints(app);
  // Unfiltered, the right bar labels from the right hand's keys.
  expect((await app.locator('.hint[data-hint-kind="right"]').evaluateAll((hs) => hs.map((h) => (h as HTMLElement).dataset.hint))).slice(0, 3)).toEqual(['j', 'k', 'l']);
  await app.keyboard.press('Shift+KeyR');
  await expect(app.locator('.hint:not([data-hint-kind="right"])')).toHaveCount(0);
  const labels = await app.locator('.hint').evaluateAll((hs) => hs.map((h) => (h as HTMLElement).dataset.hint));
  expect(labels.slice(0, 3)).toEqual(['a', 'd', 'f']); // bar order, from the alphabet start
});

test('icon_shortcuts_unchanged', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyS');
  await expect(app.locator('.sbar .spanel')).toBeVisible();
  await app.keyboard.press('Escape');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyG');
  await expect(app.locator('.hint')).toHaveCount(0); // g opens Diff, never a hint
});

test('settings_field_and_drawing_edit_one_value', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  const section = await openHintsSettings(app);
  const field = section.getByRole('textbox', { name: 'Hint alphabet' });
  const board = app.getByRole('group', { name: 'Keyboard' });
  await section.getByText('Advanced · key names, keyboard drawing').click(); // the drawing sits in the Advanced fold (ticket 250 r3)
  await field.fill('jkmn');
  await expect(board.locator('[data-code="KeyJ"] .dot[data-type="index"]')).toHaveCount(1);
  await expect(board.locator('[data-code="Digit1"] .dot')).toHaveCount(0);
  // A click on a drawn key adds it at the end; a second click removes it.
  await board.locator('[data-code="Digit7"]').click();
  await expect(field).toHaveValue('jkmn7');
  await board.locator('[data-code="KeyK"]').click();
  await expect(field).toHaveValue('jmn7');
  await board.locator('[data-code="Backquote"]').click();
  await expect(field).toHaveValue('jmn7`');
});

test('alphabet_duplicate_message', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  const section = await openHintsSettings(app);
  const field = section.getByRole('textbox', { name: 'Hint alphabet' });
  await field.fill('asdfjklghq1q');
  await expect(section.getByRole('alert')).toContainText('“q”');
  await field.fill('12 3');
  await expect(section.getByRole('alert')).toContainText(/space/i);
  // The saved value did not change: leaving the field shows it again.
  await field.blur();
  await expect(field).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890');
  await expect(section.getByRole('alert')).toHaveCount(0);
});

test('kind_key_greyed_used_as_kind_key', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  const section = await openHintsSettings(app);
  const used = section.getByRole('list', { name: 'Keys used in labels' }).locator('[data-used-as-kind]');
  // Ticket 389: only the s and p prefix keys leave the labels; the Shift filter keys (t l r w f u h o) label too.
  await expect(used).toHaveText(['s', 'p'].map((k) => new RegExp(`${k}\\s*used as kind key`)));
  await expect(section.getByText('used as kind key').first()).toBeVisible();
});

test('kind_key_reassign', async ({ app, core }) => {
  demo(core);
  core.shell(core.project('second'), 'one'); // two projects, so a project kind key filters instead of picking
  await openWindow(app);
  const section = await openHintsSettings(app);
  const projects = section.getByRole('textbox', { name: 'Projects kind key' });
  const sessions = section.getByRole('textbox', { name: 'Sessions kind key' });
  // Taking another kind's key swaps: Sessions gets p.
  await projects.fill('s');
  await expect(projects).toHaveValue('s');
  await expect(sessions).toHaveValue('p');
  // A free key moves w out of the "used" set: j is not in the alphabet, 5 is.
  await projects.fill('5');
  await expect(section.getByRole('list', { name: 'Keys used in labels' }).locator('[data-used-as-kind]')).toContainText(['5']);
  await projects.fill('k');
  await app.keyboard.press('Escape');
  await app.locator('.tab').first().click();
  await hints(app);
  // k now starts the project labels: they read k1 k2, and typing k leaves only them bright.
  await expect(app.locator('.hint[data-hint-kind="project"]')).toHaveText(['k1', 'k2']);
  await app.keyboard.press('KeyK');
  await expect(app.locator('.hint:not([data-dim])')).toHaveText(['k1', 'k2']);
});

test('hangul_input_source_falls_back_to_the_qwerty_letter', async ({ app, core }) => {
  const ids = demo(core);
  await openWindow(app);
  await hints(app);
  const codes = await codesOf(app, '.hint[data-hint-kind="tab"]', 1);
  // The key value is a Hangul jamo (Korean source): no plain letter, so the key's QWERTY letter stands in (owner 11-10).
  expect(codes).toEqual(['KeyS', 'Digit2']);
  await typeCode(app, 'KeyS', 'ㄴ'); // the session prefix, whatever character the source produces
  await typeCode(app, 'Backspace', 'Backspace');
  for (const code of codes) await typeCode(app, code);
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${ids[1]}"]`)).toHaveAttribute('aria-selected', 'true');
  // Ticket 389: with Korean 2-set on, ㄴ then 1 (KeyS, Digit1) picks s1, the first tab; labels show Latin glyphs, never jamo.
  await hints(app);
  await expect(app.locator('.hint[data-hint-kind="tab"]').first()).toHaveText('s1');
  await typeCode(app, 'KeyS', 'ㄴ');
  await typeCode(app, 'Digit1', '1');
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${ids[0]}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('reachable_in_at_most_2_clicks', async ({ app, core }) => {
  demo(core);
  await openWindow(app);
  // Settings icon, then the search result for the field: two clicks to the alphabet field (the Hints tab opens by itself).
  await app.locator('.ai.gear').click();
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('hint label');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button').filter({ hasText: /^Hint alphabet/ }).click(); // ticket 991 C14: the row's own title
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeFocused();
});
