// Prefix help overlay (V1A-57; needs 64): which-key style list of prefix keys after a delay, `?` at once, render-only.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

const activeTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
const sinkFocused = (page: Page) => page.evaluate(() => document.activeElement?.id === 'key-sink');

test('prefix-help-delay: absent at 200 ms, shown after 300 ms; ? opens it at once; delay 0 never shows it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const help = app.locator('.prefix-help');
  await app.keyboard.press('Control+Space');
  await app.waitForTimeout(200);
  await expect(help).toHaveCount(0);
  await expect(help).toBeVisible();
  // Grouped by area, glyphs from label(): the key after the prefix and the command title.
  await expect(help.getByText('Sessions and tabs')).toBeVisible();
  await expect(help.locator('[data-command="session.next"]')).toContainText('n');
  await expect(help.locator('[data-command="session.next"]')).toContainText('Go to the next tab');
  await app.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  // `?` after the prefix opens it at once and keeps the prefix armed.
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('Shift+Slash');
  await expect(help).toBeVisible({ timeout: 100 });
  await expect(app.locator('.prefix-armed')).toBeVisible();
  await app.keyboard.press('Escape');
  // Delay 0 turns the overlay off.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await app.getByRole('spinbutton', { name: 'Prefix help delay (ms, 0 = off)' }).fill('0');
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator('.tab').first().click();
  await app.keyboard.press('Control+Space');
  await app.waitForTimeout(800);
  await expect(help).toHaveCount(0);
  await app.keyboard.press('Escape');
});

test('prefix-help-no-steal: focus stays on the key sink; prefix + n runs before and after the overlay', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await expect(app.locator('.tab')).toHaveCount(3);
  expect(await activeTab(app)).toBe(ids[0]);
  // Within 50 ms: the second key is never delayed or swallowed by the pending overlay.
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyN');
  expect(await activeTab(app)).toBe(ids[1]);
  await expect(app.locator('.prefix-armed')).toHaveCount(0);
  // After the overlay shows: focus is the sink, nothing in the overlay can take it, and n still runs and closes it.
  await app.keyboard.press('Control+Space');
  const help = app.locator('.prefix-help');
  await expect(help).toBeVisible();
  expect(await sinkFocused(app)).toBe(true);
  await expect(help).toHaveAttribute('aria-hidden', 'true');
  expect(await help.evaluate((h) => h.querySelectorAll('button, a, input, [tabindex]').length)).toBe(0);
  await app.keyboard.press('KeyN');
  expect(await activeTab(app)).toBe(ids[2]);
  await expect(help).toHaveCount(0);
  // The `?` path too: the overlay opens with the focus never leaving the sink (from a terminal), and a bound key still runs.
  await app.locator(`.term[data-session="${ids[2]}"]`).click();
  await app.keyboard.press('Control+Space');
  expect(await sinkFocused(app)).toBe(true);
  await app.evaluate(() => {
    const w = window as unknown as { moves: string[] };
    w.moves = [];
    document.addEventListener('focusin', (e) => w.moves.push((e.target as HTMLElement).id || (e.target as HTMLElement).className));
  });
  await app.keyboard.press('Shift+Slash');
  await expect(help).toBeVisible();
  expect(await sinkFocused(app)).toBe(true);
  expect(await app.evaluate(() => (window as unknown as { moves: string[] }).moves)).toEqual([]);
  await app.keyboard.press('Digit1');
  expect(await activeTab(app)).toBe(ids[0]);
  await expect(help).toHaveCount(0);
});
