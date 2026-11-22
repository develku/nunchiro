// Settings > Keys as area cards (V1A-57; needs 64): prefix once, prefix keys and direct chords apart, search by a
// pressed key, read-only Copy mode and Pane mode groups rendered from the code's own key lists.
import type { Page } from '@playwright/test';
import { AREAS, COPY_KEYS, copyKey } from '../src/keys';

import { expect, openWindow, test } from './fixtures';

async function keysPage(app: Page) {
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  return app.locator('[data-keys-list]');
}

test('keys-cards: one section per area, the prefix once as its own row, prefix keys and direct chords in the row’s one cell', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const keys = await keysPage(app);
  // needs 166 (page A): the old cards are one list; each area keeps its own section and header.
  await expect(keys.locator('> section.karea:not(.kmode)')).toHaveCount(AREAS.filter((a) => a !== 'Other').length);
  // The prefix chord shows once on the page body: in the prefix row (and the lede's chip); rows after it show the chip then the key.
  await expect(app.locator('[data-command="prefix"] .kcell')).toHaveText(/^⌃\.\s*or\s*⌃␣$/);
  await expect(keys.getByText(/^prefix \+/)).toHaveCount(0);
  const tabs = keys.locator('section[data-area="sessions-and-tabs"]');
  await expect(tabs.locator('[data-command="session.next"] td').nth(1)).toHaveText(/◆\s*n$/);
  const window = keys.locator('section[data-area="palette-and-window"]');
  await expect(window.locator('[data-command="palette.open"] td').nth(1)).toHaveText(/^⌘K\s*or\s*⇧⌘P$/);
  // One Change per row stays.
  await expect(tabs.locator('[data-command="session.next"]').getByRole('button', { name: /^Change/ })).toHaveCount(1);
});

test('keys-edit-focus: esc, Cancel and Save give the focus back to the row’s Change button', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const keys = await keysPage(app);
  const row = keys.locator('tr[data-command="session.next"]');
  const edit = row.getByRole('button', { name: 'Change Go to the next tab' });
  await edit.click();
  await app.keyboard.press('Escape');
  await expect(edit).toBeFocused();
  await edit.click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyH'); // V2-9a: j is the status picker's key now
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toBeFocused();
  await edit.click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyH');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeFocused();
  await edit.click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyU');
  await app.keyboard.press('Enter');
  await expect(edit).toBeFocused();
});

test('keys-search-by-key: a pressed , finds tab.rename, ⌘K finds palette.open; title search still works', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const keys = await keysPage(app);
  const rows = keys.locator('tr[data-command]');
  const toggle = app.getByRole('button', { name: 'Record' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('Comma');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(app.getByRole('status').filter({ hasText: 'Bound to ,' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-command', 'tab.rename');
  await toggle.click();
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-command', 'palette.open');
  await app.getByRole('button', { name: 'Clear the key' }).click();
  await app.getByRole('searchbox', { name: 'Search actions or keys' }).fill('rename');
  // V2-9a: "Rename group" is a command too, and so are "Rename worktree" (V2-8a), "Rename session" (V2.5-55, needs 178 B1)
  // and the project's "Rename…" (ticket 370, 3a40bd12).
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveAttribute('data-command', 'tab.rename');
  await expect(rows.nth(1)).toHaveAttribute('data-command', 'worktree.rename');
  await expect(rows.nth(2)).toHaveAttribute('data-command', 'session.rename');
  await expect(rows.nth(3)).toHaveAttribute('data-command', 'project.rename');
  await expect(rows.nth(4)).toHaveAttribute('data-command', 'group.rename');
});

test('keys-copy-resolver: every COPY_KEYS chord, with its Shift and Control, does something in copy mode, and every key copy mode takes is listed', () => {
  const parse = (chord: string) => {
    const parts = chord.split('+');
    return { code: parts.at(-1)!, shift: parts.includes('Shift'), ctrl: parts.includes('Control') };
  };
  const listed = COPY_KEYS.flatMap((k) => k.keys.flatMap((s) => s.split(' '))).map(parse);
  for (const c of listed) expect(copyKey(c.code, c.shift, c.ctrl), JSON.stringify(c)).not.toBeNull();
  // The other way: a key the mode takes is listed with the same code and no modifier it lacks, doing the same thing
  // (Shift+q leaves like q; Shift+4 is listed on its own, as 4 alone does nothing).
  const codes = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `Key${l}`),
    ...'0123456789'.split('').map((d) => `Digit${d}`),
    ...['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'Escape', 'Enter', 'Space', 'Tab', 'Backspace', 'Minus', 'Equal', 'Slash', 'Semicolon', 'Comma', 'Period', 'BracketLeft', 'BracketRight', 'Quote', 'Backquote', 'Backslash', 'Home', 'End', 'PageUp', 'PageDown'],
  ];
  for (const code of codes)
    for (const shift of [false, true])
      for (const ctrl of [false, true]) {
        const does = copyKey(code, shift, ctrl);
        if (!does) continue;
        const covered = listed.some((l) => l.code === code && (!l.shift || shift) && (!l.ctrl || ctrl) && copyKey(l.code, l.shift, l.ctrl) === does);
        expect(covered, `${ctrl ? 'Control+' : ''}${shift ? 'Shift+' : ''}${code} (${does})`).toBe(true);
      }
});
