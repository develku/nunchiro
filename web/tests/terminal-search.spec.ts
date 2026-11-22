// Ticket v1a-35: a find bar over the focused terminal (@xterm/addon-search), over the window's 2000-line copy.
import { expect, openWindow, test } from './fixtures';

// 400 lines: the 1440x900 window shows 53 rows, so 300 left line 250 on screen; 400 keeps it in the scrollback (still 11 'line 25' matches).
const LINES = "/usr/bin/seq -f 'line %g' 1 400; exec cat";

test('find bar: Cmd+F, type, next and previous, Esc returns focus; nothing reaches the PTY', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'numbers', '/bin/sh', '-c', LINES);
  await openWindow(app);
  const rows = app.locator(`.term[data-session="${s.id}"] .xterm-rows`);
  await expect(rows).toContainText('line 400');
  // The screen shows the last lines: line 250 is off screen before the search.
  await expect(rows).not.toContainText('line 250');
  const sent = core.read(s.id);

  await app.locator(`.term[data-session="${s.id}"]`).click();
  await app.keyboard.press('Meta+KeyF');
  const bar = app.getByRole('search', { name: 'Find in terminal' });
  const field = bar.getByRole('searchbox', { name: 'Find in terminal' });
  await expect(field).toBeFocused();
  await field.fill('line 250');
  await expect(bar.getByRole('status')).toHaveText('1 of 1');
  await expect(rows).toContainText('line 250');

  // line 25 and line 250-259: eleven matches.
  await field.fill('line 25');
  await expect(bar.getByRole('status')).toHaveText(/^\d+ of 11$/);
  const at = async () => Number((await bar.getByRole('status').textContent())!.split(' ')[0]);
  const first = await at();
  await field.press('Enter');
  await expect.poll(at).toBe((first % 11) + 1);
  await field.press('Shift+Enter');
  await expect.poll(at).toBe(first);

  await field.fill('no such text');
  await expect(bar.getByRole('status')).toHaveText('No matches');

  await field.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-helper-textarea`)).toBeFocused();
  // `cat` echoes every byte the window sends: the log is exactly what the shell printed.
  await app.waitForTimeout(300);
  expect(core.read(s.id)).toBe(sent);
});

test('find bar: the find key is a listed, rebindable command', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  await app.keyboard.insertText('Find in the terminal');
  await expect(app.getByRole('option', { name: /Find in the terminal/ })).toContainText('⌘F');
});
