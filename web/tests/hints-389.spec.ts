// Ticket 389: hint labels at the owner's screen state (two projects, a project with two sessions, tabs, the composer), the
// typed letter (any layout, Korean input on), the "letters not matching?" line, and one-key labels that stay put when a project or session is added.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

const SHOTS = path.join(REPO, '.scratch/shots/389');

const hints = async (page: Page) => {
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('KeyF');
  await expect(page.locator('.hint').first()).toBeVisible();
};

/** Each label with the accessible name (or text) of the control it names (Hints.tsx test seam; ticket 408 moved labels off a control's first letter, so the corner under a label can be its neighbour). */
const labelled = (page: Page) =>
  page.locator('.hint').evaluateAll((hs) =>
    hs.map((h, i) => {
      const target = (window as unknown as { __hintTargets: { el?: Element }[] }).__hintTargets[i]?.el;
      const el = target?.closest('button, textarea, [role=tab], .row, .tab');
      return { label: (h as HTMLElement).dataset.hint!, kind: (h as HTMLElement).dataset.hintKind!, icon: (h as HTMLElement).dataset.hintIcon, name: el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 24) ?? '' };
    }),
  );

const ownerScreen = (core: Core) => {
  const a = core.project('nunchiro');
  const b = core.project('macmini');
  core.agent(a, 'one', 'go1');
  core.agent(a, 'two', 'go2');
  core.agent(b, 'three', 'go3');
  core.shell(b, 'four');
};

test('owner_screen_labels_match_the_table (shots)', async ({ app, core }) => {
  ownerScreen(core);
  await openWindow(app);
  await app.locator('.tab').first().click();
  await hints(app);
  const got = await labelled(app);
  const by = (name: string | RegExp) => got.filter((g) => (typeof name === 'string' ? g.name === name : name.test(g.name))).map((g) => g.label);
  // final.md section 1, the controls this state shows.
  expect(by('Open command palette')).toEqual(['w']);
  expect(got.filter((g) => g.kind === 'left').map((g) => g.label)).toEqual(['a', 'd', 'f', 'g']); // Tree Files Search Settings
  expect(by(/^\+ Project|Add a project/)).toEqual(['q']);
  expect(got.filter((g) => g.kind === 'project').map((g) => g.label)).toEqual(['p1', 'p2']);
  // Ticket 570 (265cd9cde): the strip shows only the selected project's tabs (nunchiro: one, two); the tree still lists all four.
  expect(got.filter((g) => g.kind === 'tab').map((g) => g.label)).toEqual(['s1', 's2']);
  expect(got.filter((g) => g.kind === 'session').map((g) => g.label).sort()).toEqual(['s1', 's2', 's3', 's4']);
  expect(by('Side chat')).toEqual(['e']);
  expect(by(/^Notifications for/)).toEqual(['r']);
  expect(by(/^Transcript view/)).toEqual([]); // ticket 473: an empty session has no view control
  expect(got.filter((g) => g.kind === 'right').map((g) => g.label)).toEqual(['j', 'k', 'l', 'h', 'u', 'i', 'o', 'y', '1']); // 'y': the Schedules widget (ticket 993); '1': History (ticket 1022, 5217b82c7), as every letter is taken
  expect(by(/^Permission mode/)).toEqual(['t']); // ticket 473: the next top letter, as the empty session has no view control
  expect(by(/^Model:/)).toEqual(['n']);
  expect(by(/^Effort:/)).toEqual(['m']);
  // Dropped: the sidebar toggles, the bar edges, the tab strip's + (quiet), panes (quiet).
  for (const gone of ['Hide left sidebar', 'Show right sidebar', 'New session', 'Expand all']) expect(by(gone), gone).toEqual([]);
  expect(got.filter((g) => g.kind === 'pane')).toEqual([]);
  // One-key labels: letters before digits, and none repeats. Ticket 1022's History icon is the one target past the 24 letters.
  const one = got.filter((g) => g.label.length === 1).map((g) => g.label);
  expect(new Set(one).size).toBe(one.length);
  expect(one.filter((l) => !/[a-z]/.test(l))).toEqual(['1']);
  await app.screenshot({ path: path.join(SHOTS, `owner-screen-${test.info().project.name}.png`) });
  // Shift+O shows the quiet controls, lettered from a; p dims everything but p1 p2.
  await app.keyboard.press('Shift+KeyO');
  await expect(app.locator('.hint[data-hint-kind="other"]').first()).toHaveText('a');
  await app.screenshot({ path: path.join(SHOTS, `owner-screen-shift-o-${test.info().project.name}.png`) });
  await app.keyboard.press('Escape');
  await hints(app);
  await app.keyboard.press('KeyP');
  await expect(app.locator('.hint:not([data-dim])')).toHaveText(['p1', 'p2']);
  await app.screenshot({ path: path.join(SHOTS, `owner-screen-p-${test.info().project.name}.png`) });
});

test('adding_a_project_or_session_keeps_every_one_key_label', async ({ app, core }) => {
  ownerScreen(core);
  await openWindow(app);
  await app.locator('.tab').first().click();
  const oneKey = async () => {
    await hints(app);
    const all = await labelled(app);
    await app.keyboard.press('Escape');
    return all.filter((g) => g.label.length === 1).map((g) => `${g.icon ?? g.name}=${g.label}`);
  };
  const before = await oneKey();
  expect(before.length).toBeGreaterThan(20);
  core.shell(core.project('third'), 'five');
  core.shell(core.project('nunchiro'), 'six');
  await expect(app.locator('.tab')).toHaveCount(3); // ticket 570: the selected project's tabs only (one, two, six)
  await expect(app.locator('.grp[data-project] .row.head')).toHaveCount(3);
  await app.locator('.tab').first().click();
  expect(await oneKey()).toEqual(before);
});


/** A keydown with this character on that physical key, as a remapped layout or an input method sends it. */
const keydown = (page: Page, key: string, code: string) =>
  page.evaluate(([k, c]) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k, code: c, keyCode: k === 'Process' ? 229 : 0 })), [key, code]);

test('typed_letter_picks_whatever_the_key: p on KeyR (Colemak, Karabiner), and Korean input on (Process on KeyP)', async ({ app, core }) => {
  ownerScreen(core);
  await openWindow(app);
  await app.locator('.tab').first().click();
  const head = app.locator('[data-hint-kind="project"]').first();
  // Owner 11-10: the letter typed decides, not the physical key: the key that types p on a remapped board is KeyR.
  await hints(app);
  await expect(app.locator('.hint[data-hint-kind="project"]').first()).toHaveText('p1');
  await keydown(app, 'p', 'KeyR');
  await expect(app.locator('.hint:not([data-dim])')).toHaveText(['p1', 'p2']);
  await keydown(app, '1', 'Digit1');
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(head).toBeFocused();
  // Korean input on: key 'Process', so the QWERTY letter of KeyP stands in.
  await app.locator('.tab').first().click();
  await hints(app);
  await keydown(app, 'Process', 'KeyP');
  await keydown(app, 'Process', 'Digit1');
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(head).toBeFocused();
});

test('unmatched_letters_offer_the_letters_setting: two show one line, a match never does, the link opens the field', async ({ app, core }) => {
  ownerScreen(core);
  await openWindow(app);
  await app.locator('.tab').first().click();
  await hints(app);
  const line = app.locator('.hint-miss');
  // Every letter labels something on this screen; digits are free (letters come first), so 9 and 8 match no label.
  await app.keyboard.press('9');
  await expect(app.locator('.hint').first()).toBeVisible(); // a miss does not close hint mode
  await app.keyboard.press('p'); // a match: no line
  await expect(line).toHaveCount(0);
  await app.keyboard.press('Backspace');
  await app.keyboard.press('8');
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText('Letters not matching? Change hint letters');
  await app.keyboard.press('9');
  await expect(line).toHaveCount(1); // shown once, not stacked
  await app.screenshot({ path: path.join(SHOTS, `mismatch-line-${test.info().project.name}.png`) });
  await line.getByRole('button', { name: 'Change hint letters' }).click();
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toBeFocused();
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890');
});

test('settings_shows_letters_and_no_layout_choice (shots)', async ({ app, core }) => {
  ownerScreen(core);
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await app.getByRole('button', { name: 'Options ↓' }).click();
  await app.locator('details.hk-adv > summary').click();
  // QWERTY is the only drawing; no Display layout choice remains (owner 11-10).
  await expect(app.locator('[data-setting="hintLayout"]')).toHaveCount(0);
  await expect(app.getByRole('group', { name: 'Keyboard' }).locator('[data-code="KeyP"]')).toHaveText('p1');
  await app.screenshot({ path: path.join(SHOTS, `settings-hints-${test.info().project.name}.png`), fullPage: true });
});

test('held_wrong_letter_is_one_slip: key repeats never show the line; a second separate wrong letter does', async ({ app, core }) => {
  ownerScreen(core);
  await openWindow(app);
  await app.locator('.tab').first().click();
  await hints(app);
  const line = app.locator('.hint-miss');
  // One wrong letter held down: the first keydown, then the auto-repeats the system sends while it stays down.
  const press9 = (repeat: boolean) =>
    app.evaluate((r) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '9', code: 'Digit9', repeat: r })), repeat);
  await press9(false);
  for (let i = 0; i < 6; i++) await press9(true);
  await expect(app.locator('.hint').first()).toBeVisible();
  await expect(line).toHaveCount(0);
  // A second, separate wrong letter is the second slip.
  await app.keyboard.press('8');
  await expect(line).toHaveCount(1);
});
