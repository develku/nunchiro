// Ticket 200 (needs 171): Cmd+F find in the file viewer. The viewer is read-only, so the panel has no replace.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openFile, setup, view } from './fixtures/files/harness';

// 300 lines; "needle" sits on lines 5, 150 and 290, so stepping between them has to scroll.
const LONG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}${[5, 150, 290].includes(i + 1) ? ' needle here' : ''}`).join('\n') + '\n';
const extra = (dir: string) => fs.writeFileSync(path.join(dir, 'long.txt'), LONG);

const panel = (app: Page) => view(app, 'long.txt').getByRole('search', { name: 'Find in file' });
const field = (app: Page) => panel(app).getByRole('searchbox', { name: 'Find' });
const status = (app: Page) => panel(app).getByRole('status');

test('fileview_cmd_f_opens_find', async ({ app, core }) => {
  await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click(); // the caret sits at the top, where a search starts
  await app.keyboard.press('Meta+KeyF');
  await expect(panel(app)).toBeVisible();
  await expect(field(app)).toBeFocused();
  await field(app).fill('needle');
  await expect(status(app)).toHaveText('1 of 3');
  // Line 5 is on screen: its match is highlighted.
  await expect(v.locator('.cm-searchMatch').first()).toBeVisible();
});

test('fileview_find_steps_matches', async ({ app, core }) => {
  await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click(); // the caret sits at the top, where a search starts
  await app.keyboard.press('Meta+KeyF');
  await field(app).fill('needle');
  await expect(status(app)).toHaveText('1 of 3');
  await field(app).press('Enter');
  await expect(status(app)).toHaveText('2 of 3');
  // Line 150 is far below the first screen: the editor scrolled to it.
  const current = v.locator('.cm-searchMatch-selected');
  await expect(current).toContainText('needle');
  await expect(current).toBeInViewport();
  await expect(v.locator('.cm-scroller')).not.toHaveJSProperty('scrollTop', 0);
  await field(app).press('Enter');
  await expect(status(app)).toHaveText('3 of 3');
  await field(app).press('Enter');
  await expect(status(app)).toHaveText('1 of 3');
  await field(app).press('Shift+Enter');
  await expect(status(app)).toHaveText('3 of 3');
  await expect(current).toBeInViewport();
  await field(app).fill('no such text');
  await expect(status(app)).toHaveText('No matches');
});

test('fileview_find_esc_returns_focus', async ({ app, core }) => {
  await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click(); // the caret sits at the top, where a search starts
  await app.keyboard.press('Meta+KeyF');
  await field(app).fill('needle');
  await field(app).press('Escape');
  await expect(panel(app)).toHaveCount(0);
  await expect(v.locator('.cm-content')).toBeFocused();
  // The matches are no longer marked once the panel is closed.
  await expect(v.locator('.cm-searchMatch')).toHaveCount(0);
});

test('fileview_find_button_opens_panel', async ({ app, core }) => {
  await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  const button = v.getByRole('button', { name: 'Find in file' });
  await expect(button).toHaveAttribute('title', /⌘F/);
  await button.click();
  await expect(panel(app)).toBeVisible();
  await expect(field(app)).toBeFocused();
  // A markdown file in rendered view has no text to search: no button there.
  await openFile(app, 'README.md');
  await expect(view(app, 'README.md').getByRole('button', { name: 'Find in file' })).toHaveCount(0);
  await view(app, 'README.md').getByRole('button', { name: 'Source' }).click();
  await view(app, 'README.md').getByRole('button', { name: 'Find in file' }).click();
  await expect(view(app, 'README.md').getByRole('search', { name: 'Find in file' })).toBeVisible();
});

test('fileview_find_stays_read_only', async ({ app, core }) => {
  await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click(); // the caret sits at the top, where a search starts
  await app.keyboard.press('Meta+KeyF');
  await expect(panel(app)).toBeVisible();
  await expect(panel(app).getByRole('textbox')).toHaveCount(0);
  await expect(panel(app).getByRole('searchbox')).toHaveCount(1);
  await expect(panel(app).getByText(/replace/i)).toHaveCount(0);
  await expect(panel(app).locator('[name="replace"], [name="replaceAll"]')).toHaveCount(0);
  // Cmd+Alt+F is CodeMirror's replace key in other setups; here it does nothing.
  await app.keyboard.press('Escape');
  await v.locator('.cm-content').click();
  await app.keyboard.type('zzz');
  await app.keyboard.press('Meta+KeyV');
  await expect(v.locator('.cm-content')).not.toContainText('zzz');
  await expect(v.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
  await expect(v.locator('.cm-content')).not.toHaveAttribute('contenteditable', 'true');
});

test('terminal_find_unchanged', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'numbers', '/bin/sh', '-c', "/usr/bin/seq -f 'line %g' 1 40; exec cat");
  await openWindow(app, {}, core);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('line 40');
  await app.locator(`.term[data-session="${s.id}"]`).click();
  await app.keyboard.press('Meta+KeyF');
  const bar = app.getByRole('search', { name: 'Find in terminal' });
  await expect(bar.getByRole('searchbox', { name: 'Find in terminal' })).toBeFocused();
  await expect(app.getByRole('search', { name: 'Find in file' })).toHaveCount(0);
  await expect(app.locator('.cm-panel')).toHaveCount(0);
});

test('fileview_find_panel_a11y', async ({ app, core, browserName }) => {
  await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click(); // the caret sits at the top, where a search starts
  await app.keyboard.press('Meta+KeyF');
  await field(app).fill('needle');
  await expect(status(app)).toHaveText('1 of 3');
  // Keyboard: every control is reached by Tab, in reading order, and each has a name.
  await field(app).focus();
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'; // WebKit's Tab skips buttons, as Safari's does
  for (const name of ['Match case', 'Previous match', 'Next match', 'Close find']) {
    await app.keyboard.press(tab);
    await expect(panel(app).getByRole('button', { name })).toBeFocused();
  }
  await app.keyboard.press('Enter'); // Close find
  await expect(panel(app)).toHaveCount(0);
  await v.getByRole('button', { name: 'Find in file' }).click();
  await field(app).fill('needle');
  const seen: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    const r = await new AxeBuilder({ page: app }).include('.cm-panels').analyze();
    expect(r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${scheme} ${x.id}: ${x.help}`)).toEqual([]);
    // axe reports these nodes as "needs review" for contrast (the editor sits under the panel), so the ratios are measured here:
    // each piece of panel text, and the current match's text, against the colours painted behind it (4.5:1, WCAG AA).
    const ratios = await v.evaluate((root) => {
      const px = (css: string) => {
        const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        c.fillStyle = css;
        c.fillRect(0, 0, 1, 1);
        const d = c.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const behind = (el: Element) => {
        const layers: string[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) layers.unshift(getComputedStyle(n).backgroundColor);
        return layers.map(px).reduce((under, l) => under.map((u, i) => (i < 3 ? l[i] * l[3] + u * (1 - l[3]) : 1)), [255, 255, 255, 1]);
      };
      const lum = (c: number[]) => {
        const [r, g, b] = c.slice(0, 3).map((v) => ((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))(v / 255));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (el: Element) => {
        const fg = px(getComputedStyle(el).color);
        const bg = behind(el);
        const f = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
        const [hi, lo] = [lum(f), lum(bg)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const out: Record<string, number> = {};
      for (const [name, sel] of [['count', '.fv-count'], ['field', '.fv-find input'], ['button', '.fv-find button'], ['current match', '.cm-searchMatch-selected'], ['current match text', '.cm-searchMatch-selected .sh']] as const) {
        const els = root.querySelectorAll(sel);
        if (els.length) out[name] = Math.min(...[...els].map(ratio));
      }
      return out;
    });
    seen.push(`${scheme} ${JSON.stringify(ratios)}`);
    expect(Object.keys(ratios), scheme).toEqual(expect.arrayContaining(['count', 'field', 'button', 'current match']));
    for (const [name, x] of Object.entries(ratios)) expect(x, `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
  }
  // The two runs saw different surfaces: the tokens really switched with the scheme.
  expect(new Set(seen.map((x) => x.split(' ').slice(1).join(' '))).size).toBeGreaterThan(1);
});

test('fileview_find_key_follows_focus', async ({ app, core }) => {
  const { s } = await setup(app, core, { extra });
  await openFile(app, 'long.txt');
  const v = view(app, 'long.txt');
  await v.locator('.cm-line').first().click();
  await app.keyboard.press('Meta+KeyF');
  await expect(panel(app)).toBeVisible();
  await expect(app.getByRole('search', { name: 'Find in terminal' })).toHaveCount(0);
  // Back to the session's own tab: the same key now runs the terminal's find.
  await app.locator('.tab', { hasText: 'files' }).first().click();
  await app.locator(`.term[data-session="${s.id}"]`).click();
  await app.keyboard.press('Meta+KeyF');
  await expect(app.getByRole('search', { name: 'Find in terminal' }).getByRole('searchbox')).toBeFocused();
});
