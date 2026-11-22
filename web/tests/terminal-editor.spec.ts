// V1A-38: scrollback actions on the focused terminal. 38a: clear (window copy only); 38b adds the editor export.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, terminalText, test } from './fixtures';

test('terminal.clear empties the focused terminal and sends nothing to the PTY', async ({ app, core }) => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n');
  const a = core.replay(core.project('demo'), 'log', `${lines}\r\n`);
  await openWindow(app);
  await expect.poll(() => terminalText(app, a.id)).toContain('line 49');
  const before = core.read(a.id);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="terminal.clear"]').click();
  await expect.poll(async () => (await terminalText(app, a.id)).trim()).toBe('');
  // The scrollback goes too: nothing left to scroll up to.
  const overflow = () =>
    app.evaluate((id) => {
      const v = document.querySelector(`.term[data-session="${id}"] .xterm-scrollable-element, .term[data-session="${id}"] .xterm-viewport`)!;
      return v.scrollHeight - v.clientHeight;
    }, a.id);
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await app.waitForTimeout(300);
  expect(core.read(a.id)).toBe(before);
});

/** Restarts the test core with a fake $EDITOR (it records each run's arguments) and an empty HOME, so neither a real
 *  editor, `open -t` nor the host's dotfiles take part. */
async function fakeEditor(app: Page, core: Core) {
  const editor = path.join(core.home, 'bin/fake-editor');
  fs.writeFileSync(editor, '#!/bin/sh\nprintf \'%s\\n\' "$#:$*" >> "$0.runs"\n', { mode: 0o700 });
  const user = path.join(core.home, 'user');
  fs.mkdirSync(user);
  core.run(['serve', 'stop'], 10_000);
  Object.assign(core.env, { EDITOR: editor, HOME: user, ZDOTDIR: user });
  await core.restart();
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
  return () => (fs.existsSync(`${editor}.runs`) ? fs.readFileSync(`${editor}.runs`, 'utf8').trim().split('\n') : []);
}
// Ticket 800: with no $EDITOR the export falls back to `open -t`; a test core records it instead of opening TextEdit.
test('terminal.edit without $EDITOR records open -t on the export and opens nothing', async ({ app, core }) => {
  const a = core.replay(core.project('demo'), 'log', 'one\r\n');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect.poll(() => terminalText(app, a.id)).toContain('one');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyV');
  const file = path.join(core.home, 'exports', a.id, 'scrollback.txt');
  await expect.poll(() => core.opened()).toBe(`open\n-t\n${file}\n`);
});
const activeTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute('data-tab');

test('terminal.edit opens the whole log in $EDITOR once, focuses the editor session, and is rebindable', async ({ app, core }) => {
  const runs = await fakeEditor(app, core);
  await openWindow(app);
  // Disabled while no session is focused: listed, does nothing.
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  const row = palette.locator('[data-command="terminal.edit"]');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await row.click({ force: true });
  await app.keyboard.press('Escape');

  const lines = Array.from({ length: 3000 }, (_, i) => `\x1b[3${i % 8}mline ${i}\x1b[0m`).join('\r\n');
  const a = core.replay(core.project('demo'), 'log', `${lines}\r\n`);
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveCount(1);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect.poll(() => terminalText(app, a.id)).toContain('line 2999');
  expect(fs.existsSync(path.join(core.home, 'exports'))).toBe(false);
  const before = core.read(a.id);

  // Default binding: prefix + v.
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyV');
  const file = path.join(core.home, 'exports', a.id, 'scrollback.txt');
  await expect.poll(runs).toEqual([`1:${file}`]);
  const text = fs.readFileSync(file, 'utf8');
  expect(text).not.toContain('\x1b');
  expect(text.split('\n').slice(0, 3000)).toEqual(Array.from({ length: 3000 }, (_, i) => `line ${i}`));
  const sessions = () => core.cli('snapshot', '--json').sessions as { id: string; label: string; kind: string }[];
  const editor = sessions().find((s) => s.label === 'scrollback')!;
  expect(editor.kind).toBe('shell');
  await expect.poll(() => activeTab(app)).toBe(editor.id);
  await app.waitForTimeout(300);
  expect(runs()).toHaveLength(1);
  expect(sessions()).toHaveLength(2);
  expect(core.read(a.id)).toBe(before);

  // Rebound to a chord in Settings > Keys, it runs from the new key.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const keys = app.locator('tr[data-command="terminal.edit"]');
  await keys.getByRole('button', { name: 'Change Open the scrollback in $EDITOR' }).click(); // needs 166: press the chord, Enter saves
  await app.keyboard.press('Alt+KeyE');
  await app.keyboard.press('Enter');
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await app.keyboard.press('Alt+KeyE');
  await expect.poll(runs).toEqual([`1:${file}`, `1:${file}`]);
});
