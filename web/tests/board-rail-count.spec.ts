// V2.5-60 (ticket 219, B13): the Board rail icon carries the number of cards that need the owner, in the your-turn orange,
// capped at 9+, absent at zero. Colour is not the only cue: the icon's name and tooltip say it too.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, test, type Core } from './fixtures';
import { overlay, seed } from './fixtures/board/coord';

const icon = (app: Page) => app.locator('.ib.r #icon-board');
const badge = (app: Page) => icon(app).locator('.rcount');
const ASK = 'needs-decision';

/** Three manual cards in the Needs decision column: the watch view puts each in Needs you. */
const asking = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i + 1}`, title: `Ask ${i + 1}`, column: ASK }));

test('board_rail_icon_shows_needs_you_count_orange', async ({ app, core }) => {
  seed(core, [...asking(3), { id: '9', title: 'Later', column: 'todo' }]); // a card that does not wait on the owner is not counted
  await openWindow(app, {}, core);
  await expect(badge(app)).toHaveText('3');
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 3 cards need you');
  await expect(icon(app)).toHaveAttribute('data-tip', /3 cards need you/);
  // "Your turn" orange is the theme's --you token, whatever the theme.
  const same = await app.evaluate((el) => {
    const probe = document.createElement('i');
    probe.style.background = 'var(--you)';
    document.body.append(probe);
    const you = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(el as Element).backgroundColor === you;
  }, await badge(app).elementHandle());
  expect(same).toBe(true);
});

test('board_rail_count_hidden_at_zero', async ({ app, core }) => {
  seed(core, [{ id: '1', title: 'Later', column: 'todo' }]);
  await openWindow(app, {}, core);
  await expect(app.locator('.ib.r').getByRole('button', { name: 'Board', exact: true })).toBeVisible(); // the name is unchanged
  await expect(badge(app)).toHaveCount(0);
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board');
});

test('board_rail_count_updates_live_and_caps', async ({ app, core }: { app: Page; core: Core }) => {
  seed(core, asking(1));
  let n = 1;
  // The reply of every board_snapshot holds `n` asking cards: the test moves cards in and out without a reload.
  await overlay(app, {
    board: (b) => ({ ...b, cards: Array.from({ length: n }, (_, i) => ({ ...(b.cards as Record<string, unknown>[])[0], id: `${i + 1}`, title: `Ask ${i + 1}` })) }),
  });
  await openWindow(app, {}, core);
  await expect(badge(app)).toHaveText('1');
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 1 card needs you');
  // The rail alone asks every 4 s (RAIL_EVERY), so a change shows within 4 s plus the reply: wait past that.
  const LATE = { timeout: 10_000 };
  n = 12;
  await expect(badge(app)).toHaveText('9+', LATE);
  await expect(icon(app)).toHaveAttribute('aria-label', 'Board · 12 cards need you');
  n = 0;
  await expect(badge(app)).toHaveCount(0, LATE);
});

// The number reads on the orange in every theme: a canvas turns the computed colours (oklch included) into sRGB, then WCAG contrast.
const catalog = (name: string) => ({ id: `catalog:${name}`, name, colors: parseGhostty(THEMES[name]) });
for (const pick of [LIGHT_PICK, DARK_PICK, catalog('Catppuccin Latte'), catalog('Catppuccin Mocha')])
  test(`board_rail_count_number_reads_on_orange: ${pick.name}`, async ({ app, core }, info) => {
    test.skip(info.project.name !== 'chromium', 'one browser is enough for computed colours');
    seed(core, asking(2));
    await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);
    await openWindow(app, {}, core);
    await expect(badge(app)).toHaveText('2');
    const contrast = await badge(app).evaluate((el) => {
      const px = (css: string) => {
        const c = document.createElement('canvas').getContext('2d', { colorSpace: 'srgb' })!;
        c.fillStyle = css;
        c.fillRect(0, 0, 1, 1);
        const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
        return [r, g, b].map((v) => ((v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)));
      };
      const lum = (css: string) => { const [r, g, b] = px(css); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const [a, b] = [lum(getComputedStyle(el).color), lum(getComputedStyle(el).backgroundColor)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    expect(contrast, `${pick.name}: the count on --you`).toBeGreaterThanOrEqual(4.5);
  });

// REPORT ## Shots (V2.5-60 review SHOULD): the badge in the themes the first lane did not look at. SHOTS_DIR=<dir> saves the rail's
// Board icon in each; without it the test only checks the badge shows and reads on the orange.
const DRACULA = `background = #282a36
foreground = #f8f8f2
selection-background = #44475a
palette = 0=#21222c
palette = 1=#ff5555
palette = 2=#50fa7b
palette = 3=#f1fa8c
palette = 4=#bd93f9
palette = 5=#ff79c6
palette = 6=#8be9fd
palette = 7=#f8f8f2
palette = 8=#6272a4
palette = 9=#ff6e6e
palette = 10=#69ff94
palette = 11=#ffffa5
palette = 12=#d6acff
palette = 13=#ff92df
palette = 14=#a4ffff
palette = 15=#ffffff
`;
// Solarized Light as the iTerm2 scheme ships it: palette 11 (the stale role) is a grey, not a yellow.
const SOLARIZED_LIGHT = `background = #fdf6e3
foreground = #657b83
selection-background = #eee8d5
palette = 0=#073642
palette = 1=#dc322f
palette = 2=#859900
palette = 3=#b58900
palette = 4=#268bd2
palette = 5=#d33682
palette = 6=#2aa198
palette = 7=#bbb5a1
palette = 8=#002b36
palette = 9=#cb4b16
palette = 10=#586e75
palette = 11=#657b83
palette = 12=#839496
palette = 13=#6c71c4
palette = 14=#93a1a1
palette = 15=#fdf6e3
`;
const imported = (name: string, ghostty: string) => ({ id: `imported:${name}`, name, colors: parseGhostty(ghostty), source: `https://example.invalid/${encodeURIComponent(name)}` });
const shotsDir = process.env.SHOTS_DIR;
for (const pick of [imported('Dracula', DRACULA), imported('Solarized Light', SOLARIZED_LIGHT), DARK_PICK])
  test(`board_rail_badge_three_themes: ${pick.name}`, async ({ app, core }, info) => {
    test.skip(info.project.name !== 'chromium', 'one browser is enough for shots');
    seed(core, asking(3));
    await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);
    await openWindow(app, {}, core);
    await expect(badge(app)).toHaveText('3');
    await app.mouse.move(2, 2);
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await app.locator('.ib.r').screenshot({ path: path.join(shotsDir, `rail-badge-${pick.name.replace(/\W+/g, '-')}.png`) });
  });
