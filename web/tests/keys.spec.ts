import type { Page } from '@playwright/test';
import { expect, openWindow, ORIGIN, test, terminalText, showComposer } from './fixtures';

/** A keydown as a Korean input source produces it: the physical code with a Hangul key value. */
type Key = { code: string; key: string; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number };
const physical = (page: Page, init: Key) =>
  page.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);
const activeTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute('data-tab');

test('Cmd+K palette lists named commands and runs one; Cmd+, opens the Settings modal (v25f)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox', { name: 'Command palette search' })).toBeVisible();
  await expect(palette.locator('[data-command="session.next"]')).toBeVisible();
  await expect(palette.locator('[data-command="layout.edit"]')).toHaveAttribute('aria-disabled', 'false');
  await app.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await app.keyboard.press('Meta+Comma');
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(app.getByRole('region', { name: 'Settings' })).toBeVisible();
});

test('prefix bindings use physical keys, so a Korean input source still switches sessions', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(3);
  expect(await activeTab(app)).toBe(ids[0]);
  await app.keyboard.press('Control+Space');
  await expect(app.locator('.prefix-armed')).toBeVisible();
  await app.keyboard.press('KeyN');
  expect(await activeTab(app)).toBe(ids[1]);
  // ㅜ is what KeyN types under the Korean 2-set layout.
  await physical(app, { code: 'Space', key: ' ', ctrlKey: true });
  await physical(app, { code: 'KeyN', key: 'ㅜ' });
  await expect.poll(() => activeTab(app)).toBe(ids[2]);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('Digit1');
  expect(await activeTab(app)).toBe(ids[0]);
});

test('keys pressed during Hangul composition are never taken as a binding', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator('.cbox textarea').focus();
  await physical(app, { code: 'Space', key: ' ', ctrlKey: true, isComposing: true });
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  await physical(app, { code: 'KeyK', key: 'ㅏ', metaKey: true, isComposing: true });
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
});

test('pressing the prefix twice sends it to the agent', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('Control+Space');
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  // The PTY echoes NUL as ^@.
  await expect.poll(() => core.read(a.id)).toContain('^@');
});

test('prefix f shows hints over window elements and terminal URLs and paths; letters activate one', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.type('see https://example.com/docs and web/src/App.tsx:12');
  await app.keyboard.press('Enter');
  await expect.poll(() => terminalText(app, a.id)).toContain('App.tsx:12');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint[data-kind="url"]').first()).toBeVisible();
  await expect(app.locator('.hint[data-kind="path"]').first()).toBeVisible();
  const gear = await app.locator('.hint[data-kind="element"]').evaluateAll((hs) => {
    const g = document.querySelector('.ai.gear')!.getBoundingClientRect();
    return hs.find((h) => Math.abs(h.getBoundingClientRect().left - g.left) < 1 && Math.abs(h.getBoundingClientRect().top - g.top) < 1)?.getAttribute('data-keys');
  });
  // needs 118: an icon reads a label from the alphabet (it is on the right bar), no longer the `,` of its ⌘, shortcut.
  expect(gear).toBe('g'); // ticket 389: the left bar's fourth letter (a d f g) for the gear at its foot, never the `,` of its ⌘, shortcut
  for (const k of gear!.split(' ')) await app.keyboard.press(k);
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // A path hint drops the path into the composer.
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  const path = await app.locator('.hint[data-kind="path"]').last().getAttribute('data-keys');
  for (const k of path!.split(' ')) await app.keyboard.press(k);
  await expect(app.locator('.cbox textarea')).toHaveValue('web/src/App.tsx:12');
});

test('rebinding: conflicts show at capture, Replace moves the key, a direct chord works', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const row = app.locator('tr[data-command="session.next"]');
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click(); // needs 166: press the key, no "prefix or chord" question
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyP');
  await expect(row.getByRole('alert')).toContainText('is used by “Go to the previous tab”');
  await row.getByRole('button', { name: 'Replace' }).click();
  // Go to the previous tab lost the prefix key and keeps its ⌘ chord.
  await expect(app.locator('tr[data-command="session.prev"] td').nth(1)).toHaveText('⌘{');
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click();
  await app.keyboard.press('Alt+KeyJ');
  await app.keyboard.press('Enter');
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator(`.tab[data-tab="${ids[0]}"]`).click();
  await app.keyboard.press('Alt+KeyJ');
  expect(await activeTab(app)).toBe(ids[1]);
  // The prefix itself is rebindable too, and the change survives a reload.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const top = app.locator('[data-command="prefix"]');
  await expect(top.locator('.kcell')).toHaveText(/^⌃\.\s*or\s*⌃␣$/);
  await top.getByRole('button', { name: "Change Prefix (the key before a command's key)" }).click();
  await app.keyboard.press('Control+KeyB');
  await app.keyboard.press('Enter');
  await expect(top.locator('.kcell')).toHaveText(/^⌃B\s*or\s*⌃␣$/);
  await expect(app.locator('tr[data-command="session.jump"] td').nth(1)).toHaveText(/^⌘1-9\s*or\s*◆\s*1-9$/);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.keyboard.press('Escape'); // v25f: the reload keeps the Settings modal open; Esc closes it
  await app.locator(`.tab[data-tab="${ids[1]}"]`).click();
  await app.keyboard.press('Control+KeyB');
  await app.keyboard.press('Digit1');
  expect(await activeTab(app)).toBe(ids[0]);
  // The chord Go to the next tab was given still works beside its other key.
  await app.keyboard.press('Alt+KeyJ');
  expect(await activeTab(app)).toBe(ids[1]);
});

test('macOS Ctrl+Space input-source check offers Ctrl+B once', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app, { ctrlSpaceTaken: true });
  const banner = app.getByRole('alert').filter({ hasText: 'to switch the input source' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Use ⌃B as the prefix' }).click();
  await expect(banner).toHaveCount(0);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.getByRole('alert').filter({ hasText: 'to switch the input source' })).toHaveCount(0);
  // The offer rebinds the prefix to ⌃B alone.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('[data-command="prefix"] .kcell')).toHaveText('⌃B'); // needs 166: the prefix is the first row of the list
});

test('the palette shows prefix + f for hints, and ⌃. arms the prefix; ⌃. twice reaches nobody', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  const a = ids[0];
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="hints.show"]')).toContainText('◆ f');
  await app.keyboard.press('Escape');
  await app.keyboard.press('Control+Period');
  await expect(app.locator('.prefix-armed')).toHaveText('⌃. …');
  await app.keyboard.press('KeyN');
  expect(await activeTab(app)).toBe(ids[1]);
  await app.locator(`.tab[data-tab="${a}"]`).click();
  await app.locator(`.term[data-session="${a}"]`).click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('Control+Period');
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  // A positive signal first: the next typed key's echo arrives, so a stray ^@ would have arrived before it.
  await app.keyboard.type('qz');
  await expect.poll(() => core.read(a)).toContain('qz');
  expect(core.read(a)).not.toContain('^@');
});

// Ticket 1071: ⌘= ⌘- ⌘0 zoom the window now; zoom-1071.spec.ts checks they leave the terminal font and the PTY alone.

test('with a Korean input source (keyCode 229, not composing) the prefix still works and nothing reaches the PTY', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await app.locator(`.term[data-session="${ids[0]}"]`).click();
  // macOS reports every IME-handled key as keyCode 229 / key "Process", composing or not.
  await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await expect(app.locator('.prefix-armed')).toBeVisible();
  // While armed, focus sits on a non-editable sink, so the IME has nowhere to put "ㅜ".
  expect(await app.evaluate(() => document.activeElement?.id)).toBe('key-sink');
  await physical(app, { code: 'KeyN', key: 'Process', keyCode: 229 });
  await expect.poll(() => activeTab(app)).toBe(ids[1]);
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  expect(core.read(ids[0])).not.toContain('ㅜ');
  // Escape disarms and gives focus back to where it was.
  await app.locator(`.term[data-session="${ids[1]}"]`).click();
  // The tab's terminal opens once its replay is in (Q4, d05be7af5); the click's focus lands then.
  await expect(app.locator(`.term[data-session="${ids[1]}"] .xterm-helper-textarea`)).toBeFocused();
  await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await physical(app, { code: 'Escape', key: 'Escape' });
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  expect(await app.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
});

test('capturing a key with no modifier, or Ctrl+C, warns before saving', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const row = app.locator('tr[data-command="session.next"]');
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click();
  await app.keyboard.press('KeyJ');
  await expect(row.locator('.warn')).toContainText('no modifier');
  await row.getByRole('button', { name: 'Cancel' }).click();
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click();
  await app.keyboard.press('Control+KeyC');
  await expect(row.locator('.warn')).toContainText('interrupt');
  await row.getByRole('button', { name: 'Cancel' }).click();
  // After the prefix, a bare key is the point: no warning.
  await row.getByRole('button', { name: 'Change Go to the next tab' }).click();
  await app.keyboard.press('Control+Period');
  await app.keyboard.press('KeyH');
  await expect(row.locator('.warn')).toHaveCount(0);
});

test('a URL hint opens outside the window; the window stays on the app', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.type('see https://example.invalid/x');
  await app.keyboard.press('Enter');
  await expect.poll(() => terminalText(app, a.id)).toContain('example.invalid/x');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  const hint = await app.locator('.hint[data-kind="url"]').first().getAttribute('data-keys');
  // Outside Tauri the link goes to window.open (the app shell routes it to the opener plugin instead).
  await app.evaluate(() => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = (u?: string | URL) => (w.opened.push(String(u)), null);
  });
  for (const k of hint!.split(' ')) await app.keyboard.press(k);
  await expect.poll(() => app.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(['https://example.invalid/x']);
  expect(app.url()).toBe(`${ORIGIN}/`);
});

test('session.last toggles between the two latest sessions and is in the palette and rebindable', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(3);
  const prefix = async (code: string) => (await app.keyboard.press('Control+Space'), await app.keyboard.press(code));
  await prefix('Digit1'); // A
  await prefix('Digit2'); // B
  await prefix('Tab');
  expect(await activeTab(app)).toBe(ids[0]);
  await prefix('Tab');
  expect(await activeTab(app)).toBe(ids[1]);
  // A closed session is skipped: the toggle stays where it is.
  await prefix('Digit3');
  await app.locator(`.tab[data-tab="${ids[1]}"] ~ .x`).click({ force: true }); // CHROME: the ✕ is drawn on hover or focus
  await expect(app.locator(`.tab[data-tab="${ids[1]}"]`)).toHaveCount(0);
  await prefix('Tab');
  expect(await activeTab(app)).toBe(ids[2]);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  await expect(palette.locator('[data-command="session.last"]')).toBeVisible();
  await expect(palette.locator('[data-command="zone.zoom"]')).toBeVisible();
  await expect(palette.locator('[data-command="hints.copy"]')).toBeVisible();
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await expect(app.locator('tr[data-command="session.last"]').getByRole('button', { name: 'Change Go back to the last tab (toggle)' })).toBeVisible();
});
